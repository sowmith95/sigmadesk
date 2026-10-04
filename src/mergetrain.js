// Merge train (sowmith95/sigmadesk#3): what happens after two approvals, and after every merge into the base branch.
//
// - Approved PRs merge one at a time, oldest approval first, respecting `after_key` order. High-risk work waits for
//   the owner; everything else merges itself.
// - Deploy-aware timing: if the PR's files trigger a deploying workflow and we are inside the busy window, the merge is
//   SCHEDULED for the window's end (persisted) instead of blocked. One deploying merge at a time: the next one waits
//   until the previous merge's deploy run finished (timeout or failure → owner).
// - Base watcher: once per cycle the desk fetches the base branch and every open desk PR head into its own publisher
//   repo and runs `git merge-tree` (free, no checkout, no model). Clean PRs are updated LAZILY: only the queue front is
//   rebased (desk-side, force-with-lease on the observed head), then QA re-runs and both reviewers re-confirm with a
//   range-diff. Real conflicts become a durable `resolve` job for the engineer who built the PR, with a compact
//   conflict pack and a fresh run; afterwards QA and both reviewers re-confirm the resolution.
// Every step is posted on the PR in plain language through the review outbox.
import { config } from './config.js';
import { agentById, routeSlice, routeTicket, PRINCIPALS, promptFor } from './team.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as prs from './prs.js';
import * as workflows from './workflows.js';
import * as reviews from './reviews.js';
// Circular on purpose: only used at call time.
import { setStatus, inBusyWindow, guardReasons } from './scheduler.js';

export const enabled = () => config.mergeTrain?.enabled !== false && reviews.enabled();
const short = (sha) => String(sha || '').slice(0, 7);
const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
const nameOf = (seat) => agentById[seat]?.name || seat;
const roleOf = (seat) => agentById[seat]?.role || seat;
const TERMINAL = new Set(['done', 'wontdo']);
function need(cond, msg) { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); }
const footer = (t, sha) => `\n\n<sub>SigmaDesk ${t.key}${sha ? ` · commit \`${short(sha)}\`` : ''}</sub>`;
function say(t, marker, text, sha = t.head_sha, author = 'system') {
  store.enqueueOutbox(t.key, `${t.key}:${marker}`, `${text}${footer(t, sha)}`);
  store.addComment(t.key, author, text);
}

// ---------------- busy window → scheduled merges ----------------
/** First minute at or after `now` that is outside the busy window (minute steps: correct across DST changes). */
export function windowEnd(now = new Date(), w = config.limits.busyWindow) {
  let t = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60 && inBusyWindow(t, w); i++) t = new Date(t.getTime() + 60_000);
  return t;
}
export function fmtTime(d, tz = config.limits.busyWindow?.timezone || 'America/New_York') {
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  const zone = tz === 'America/New_York' ? 'ET' : new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || tz;
  return `${time} ${zone}`;
}

// ---------------- deploy classification ----------------
const workflowCache = new Map(); // base sha → [{file, text}] | null (unknown)
export async function workflowsAtBase() {
  return runner.withPublisher(async (pgit) => {
    const head = await pgit(['rev-parse', '--verify', 'refs/sigmadesk/base']);
    if (head.code) return null;
    const sha = head.stdout.trim();
    if (workflowCache.has(sha)) return workflowCache.get(sha);
    const ls = await pgit(['ls-tree', '--name-only', 'refs/sigmadesk/base', '.github/workflows/']);
    let out = null;
    if (!ls.code) {
      out = [];
      for (const file of ls.stdout.split('\n').filter((f) => /\.ya?ml$/.test(f))) {
        const show = await pgit(['show', `refs/sigmadesk/base:${file}`]);
        out.push({ file, text: show.code ? null : show.stdout });
      }
    }
    workflowCache.set(sha, out);
    return out;
  });
}
const diffFiles = (key) => { try { return JSON.parse(store.kvGet(`diff-files:${key}`) || 'null'); } catch { return null; } };
/** {deploys, workflows:[{file,name,reason}], reason}. Unknown files or workflows count as deploying. */
export async function deployInfo(t) {
  const files = diffFiles(t.key);
  if (!Array.isArray(files) || !files.length) return { deploys: true, workflows: [], reason: 'the changed files are unknown' };
  const wfs = await workflowsAtBase().catch(() => null);
  if (!wfs) return { deploys: true, workflows: [], reason: 'the base branch workflows could not be read' };
  const r = workflows.deploysFor({ files, branch: config.project.baseBranch, workflows: wfs, registered: config.deploy?.workflows ?? 'auto' });
  return { ...r, reason: r.deploys ? `it redeploys via ${r.workflows.map((w) => w.name).slice(0, 3).join(', ')}` : null };
}

// ---------------- deploy lock: one deploying merge at a time ----------------
const lockGet = () => { try { return JSON.parse(store.kvGet('train:deploy') || 'null'); } catch { return null; } };
const lockSet = (v) => store.kvSet('train:deploy', v ? JSON.stringify(v) : 'null');
export function clearDeployLock(by = 'owner') {
  const l = lockGet();
  lockSet(null);
  store.logEvent({ kind: 'action', agent_id: by, ticket_key: l?.key || null, text: `deploy lock cleared${l ? ` (was ${l.state} for ${l.key})` : ''}` });
  return l;
}
/** null when no deploy is in flight; otherwise the lock (refreshed from GitHub's workflow runs). */
export async function deployLock(now = new Date()) {
  const l = lockGet();
  if (!l) return null;
  if (l.state !== 'running') return l;
  const age = (now.getTime() - Date.parse(l.at)) / 60_000;
  let runs = [];
  if (l.merge_sha) {
    try { runs = await prs.runsForCommit(l.merge_sha); } catch { return l; } // cannot see: stay locked, retry next cycle
  }
  const names = new Set(l.workflows || []);
  const relevant = runs.filter((r) => !names.size || names.has(r.workflowName));
  const t = store.getTicket(l.key);
  if (!relevant.length) {
    if (age >= (Number(config.deploy?.graceMinutes) || 3) && l.merge_sha) { lockSet(null); return null; }
  } else if (relevant.every((r) => r.status === 'completed')) {
    const bad = relevant.filter((r) => !['success', 'skipped', 'neutral'].includes(String(r.conclusion).toLowerCase()));
    if (!bad.length) { lockSet(null); return null; }
    const next = { ...l, state: 'failed', note: `${bad.map((r) => r.workflowName).join(', ')} ${bad[0].conclusion}` };
    lockSet(next);
    if (t) say(t, `deploy-failed:${l.merge_sha}`, `🚨 **The deploy after this merge failed** (${next.note}). SigmaDesk will not merge anything else that redeploys until you look at it and clear the deploy hold.`, l.merge_sha);
    return next;
  }
  if (age > (Number(config.deploy?.waitMinutes) || 45)) {
    const next = { ...l, state: 'timed_out', note: `no finished deploy after ${Math.round(age)} min` };
    lockSet(next);
    if (t) say(t, `deploy-timeout:${l.merge_sha || l.at}`, `⏳ **The deploy after this merge has not finished in ${Math.round(age)} minutes.** SigmaDesk is holding further deploying merges until you check it and clear the deploy hold.`, l.merge_sha);
    return next;
  }
  return l;
}

// ---------------- merge-tree: free conflict detection ----------------
/** Parse `git merge-tree --write-tree -z` output: tree, per-file stages, and conflict messages (rename/delete, binary…). */
export function parseMergeTree(stdout) {
  const parts = String(stdout).split('\0');
  const tree = parts[0].trim();
  const files = new Map();
  const file = (p) => { if (!files.has(p)) files.set(p, { path: p, stages: [], types: [], messages: [] }); return files.get(p); };
  let i = 1;
  for (; i < parts.length && parts[i] !== ''; i++) {
    const m = parts[i].match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
    if (m) file(m[4]).stages.push({ mode: m[1], oid: m[2], stage: Number(m[3]) });
  }
  i += 1;
  while (i < parts.length && parts[i] !== '') {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 1) break;
    const paths = parts.slice(i + 1, i + 1 + n);
    const type = parts[i + 1 + n] || '';
    const message = String(parts[i + 2 + n] || '').trim();
    if (/^CONFLICT/.test(type)) for (const p of paths) { const f = file(p); f.types.push(type); f.messages.push(message); }
    i += n + 3;
  }
  const conflicts = [...files.values()].map((f) => ({ ...f,
    kind: f.types.some((t) => /binary/i.test(t)) ? 'binary' : f.types.find((t) => !/contents/.test(t))?.replace(/^CONFLICT \(|\)$/g, '') || 'content' }));
  return { tree, conflicts };
}
const mtCache = new Map(); // `${base}:${head}` → result (bounded)
/** {status:'clean'|'conflict'|'error', tree, conflicts, error}. Cached per (base, head); errors are not cached. */
export async function mergeTree(base, head) {
  const k = `${base}:${head}`;
  if (mtCache.has(k)) return mtCache.get(k);
  const r = await runner.withPublisher((pgit) => pgit(['merge-tree', '--write-tree', '-z', base, head]));
  let out;
  if (r.code === 0) out = { status: 'clean', tree: r.stdout.split('\0')[0].trim(), conflicts: [] };
  else if (r.code === 1 && /^[0-9a-f]{40}/.test(r.stdout)) out = { status: 'conflict', ...parseMergeTree(r.stdout) };
  else return { status: 'error', error: String(r.stderr || `exit ${r.code}`).trim().slice(0, 300), conflicts: [] };
  mtCache.set(k, out);
  if (mtCache.size > 500) mtCache.delete(mtCache.keys().next().value);
  return out;
}
const pub = (args) => runner.withPublisher((pgit) => pgit(args));
const isAncestor = async (a, b) => (await pub(['merge-base', '--is-ancestor', a, b])).code === 0;

/** Base commits that touched `files` since `head` forked: "#391 Eastern session helpers" for the PR comment. */
async function incomingFor(base, head, files) {
  const mb = (await pub(['merge-base', base, head])).stdout.trim();
  if (!mb) return [];
  const log = await pub(['log', '--format=%H%x1f%s', `${mb}..${base}`, ...(files.length ? ['--', ...files.slice(0, 50)] : [])]);
  return log.stdout.split('\n').filter(Boolean).slice(0, 10).map((l) => {
    const [sha, subject] = l.split('\x1f');
    return { sha, subject, pr: Number(subject.match(/\(#(\d+)\)\s*$/)?.[1]) || null, title: subject.replace(/^\[[A-Z][A-Z0-9]*-\d+\]\s*/, '').replace(/\s*\(#\d+\)\s*$/, '') };
  });
}
const describeIncoming = (inc) => (inc.length ? inc.slice(0, 3).map((c) => (c.pr ? `#${c.pr} (${c.title})` : `\`${short(c.sha)}\` (${c.title})`)).join(', ') : `\`${config.project.baseBranch}\``);

// ---------------- base watcher ----------------
/** Fetch base + every open desk PR head into the publisher once. {base, heads:[{t, head}]} or null when offline. */
export async function watchBase() {
  const url = await runner.originUrl();
  if (!url) return null;
  const open = store.listTickets().filter((t) => t.pr_url && t.branch && !TERMINAL.has(t.status));
  return runner.withPublisher(async (pgit) => {
    const ls = await pgit(['ls-remote', '--heads', url]);
    if (ls.code) throw new Error(`ls-remote failed: ${ls.stderr.trim().slice(0, 160)}`);
    const heads = new Map(ls.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ref] = l.split('\t'); return [ref, sha]; }));
    const baseSha = heads.get(`refs/heads/${config.project.baseBranch}`);
    if (!baseSha) throw new Error('base branch not found on origin');
    const live = open.filter((t) => heads.has(`refs/heads/${t.branch}`));
    const f = await pgit(['fetch', '-q', '--no-tags', url, `+refs/heads/${config.project.baseBranch}:refs/sigmadesk/base`,
      ...live.map((t) => `+refs/heads/${t.branch}:refs/sigmadesk/remote/${t.key}`)]);
    if (f.code) throw new Error(`fetch failed: ${f.stderr.trim().slice(0, 160)}`);
    const prev = store.kvGet('train:base');
    if (prev !== baseSha) {
      store.kvSet('train:base', baseSha);
      if (prev) store.logEvent({ kind: 'github', agent_id: 'github', text: `${config.project.baseBranch} moved to ${short(baseSha)} — checking ${live.length} open PR(s) for conflicts` });
    }
    return { base: baseSha, heads: live.map((t) => ({ t, head: heads.get(`refs/heads/${t.branch}`) })) };
  });
}

/** Free check of every open PR against the new base; real conflicts become resolve jobs. */
export async function detectConflicts(snap) {
  const out = [];
  for (const { t, head } of snap.heads) {
    const r = await mergeTree(snap.base, head);
    if (r.status === 'error') { store.logEvent({ kind: 'error', ticket_key: t.key, text: `conflict check failed: ${r.error}` }); continue; }
    if (r.status === 'conflict') out.push(await onConflict(store.getTicket(t.key), snap.base, head, r));
  }
  return out.filter(Boolean);
}

// ---------------- conflict jobs ----------------
const seatOn = (id) => !!agentById[id] && agentById[id].enabled !== false;
/** The engineer who built it; if that seat is off, the same area and tier. Never a principal (they do not code). */
export function resolverFor(t) {
  const builder = t.builder || t.assignee;
  if (builder && seatOn(builder) && !PRINCIPALS.includes(builder)) return builder;
  const alt = routeSlice({ area: t.area, complexity: t.complexity || 'M' });
  if (seatOn(alt)) return alt;
  return routeTicket({ area: t.area, complexity: 'M' });
}
const RESOLVABLE = new Set(['review', 'ready_for_human']);
export async function onConflict(t, base, head, mt) {
  if (!t || !RESOLVABLE.has(t.status)) return null; // in progress / QA / owner: checked again next cycle
  const jobs = store.conflictJobsFor(t.key);
  if (jobs.some((j) => j.status === 'running')) return null; // finish the current resolution first
  const files = mt.conflicts.map((c) => ({ path: c.path, kind: c.kind, stages: c.stages, messages: c.messages.slice(0, 3) }));
  const incoming = await incomingFor(base, head, files.map((f) => f.path)).catch(() => []);
  const seat = resolverFor(t);
  const { job, created } = store.createConflictJob({ ticket_key: t.key, pr_number: prNumber(t.pr_url), base_sha: base, head_sha: head, seat, files, incoming });
  if (!created) return job;
  for (const j of jobs) if (['pending', 'needs_owner'].includes(j.status)) store.updateConflictJob(j.id, { status: 'superseded' });
  const names = files.map((f) => `\`${f.path}\``).slice(0, 4).join(', ') + (files.length > 4 ? ` +${files.length - 4} more` : '');
  say(t, `conflict:${job.id}`, `⚠️ **Conflicted with ${describeIncoming(incoming)}** in ${names} — ${nameOf(seat)} (${roleOf(seat)}) is resolving it. After that, QA re-checks and both reviewers re-confirm the resolution before it can merge.`, head);
  setStatus(t.key, 'review', { review_stage: 'resolving', merge_after: null, progress_msg: `Conflicts with ${config.project.baseBranch} after ${describeIncoming(incoming)} — ${nameOf(seat)} is resolving` });
  github.flushOutbox();
  return job;
}

/** Resolve jobs the scheduler may start now (one per seat; the ticket must be waiting on it). */
export function nextResolveJobs() {
  const out = []; const seats = new Set();
  for (const j of store.listTickets().filter((t) => t.status === 'review' && t.review_stage === 'resolving' && !t.active_run).flatMap((t) => store.conflictJobsFor(t.key))) {
    if (!['pending', 'needs_owner'].includes(j.status) || seats.has(j.seat)) continue;
    if (j.status === 'needs_owner') store.updateConflictJob(j.id, { status: 'pending', attempts: 0 }); // the owner replied: try again
    seats.add(j.seat);
    out.push({ kind: 'resolve', seat: j.seat, key: j.ticket_key, job: store.getConflictJob(j.id) });
  }
  return out;
}

/** Desk-side git: a fresh clone at the pinned PR head with the pinned base merged in, conflicts left for the author. */
export async function prepareResolve(job) {
  const base = config.project.baseBranch;
  const dir = await runner.scratchClone(`resolve-${job.ticket_key}`, [`+${job.head_sha}:refs/heads/work`, `+${job.base_sha}:refs/remotes/origin/${base}`]);
  await runner.scratchGit(dir, ['checkout', '-q', 'work']);
  const m = await runner.scratchGit(dir, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${base} into this branch (resolve conflicts)`, `origin/${base}`]);
  return { dir, clean: m.code === 0 };
}

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}\n… (truncated)` : String(s));
/** The compact conflict pack (2–4k tokens): pinned SHAs, stages, intent, incoming changes for the conflicting files only. */
export async function conflictPack(job, t, dir) {
  const files = JSON.parse(job.files_json || '[]');
  const incoming = JSON.parse(job.incoming_json || '[]');
  const paths = files.map((f) => f.path);
  const mb = (await runner.scratchGit(dir, ['merge-base', job.head_sha, job.base_sha])).stdout.trim();
  const diff = mb ? (await runner.scratchGit(dir, ['diff', '--no-ext-diff', mb, job.base_sha, '--', ...paths])).stdout : '';
  const cs = store.listComments(t.key);
  const last = (re, list = cs) => list.filter((c) => re.test(c.body)).pop()?.body || '';
  const design = t.parent_key ? last(/^📐/, store.listComments(t.parent_key)) : '';
  const stages = files.map((f) => `- ${f.path} — ${f.kind}${f.messages?.length ? `: ${f.messages.join(' / ')}` : ''} (stages: ${f.stages.map((s) => `${s.stage === 1 ? 'base' : s.stage === 2 ? 'main' : 'yours'} ${short(s.oid)}`).join(', ') || 'none'})`).join('\n');
  return [
    `Pinned commits: your PR head ${job.head_sha}, ${config.project.baseBranch} ${job.base_sha}${mb ? `, common ancestor ${mb}` : ''}.`,
    `Changes that landed on ${config.project.baseBranch} and touch the same files: ${incoming.map((c) => `${c.pr ? `#${c.pr} ` : ''}${c.title} (${short(c.sha)})`).join('; ') || 'see the diff below'}.`,
    `Conflicting files (merge stages: base = common ancestor, main = ${config.project.baseBranch}, yours = this PR):\n${stages}`,
    `What this ticket must still do (acceptance):\n${trunc(t.description, 2500)}`,
    last(/^🚀/) ? `Your submission note:\n${trunc(last(/^🚀/), 1200)}` : '',
    design ? `Design note:\n${trunc(design, 1200)}` : '',
    `What ${config.project.baseBranch} changed in these files (incoming diff):\n${trunc(diff, 6000) || '(binary or deleted files — inspect with git)'}`,
  ].filter(Boolean).join('\n\n');
}
/** Resume the builder's session only when it is estimated cheaper than a fresh run with the pack (default: never). */
export function shouldResume(prevRun, packText, mode = config.resolve?.resume || 'never', now = Date.now()) {
  if (mode !== 'if-cheaper' || !prevRun?.session_id || !prevRun.usage_json) return false;
  if (now - Date.parse(prevRun.ended_at || prevRun.started_at) > 5 * 60_000) return false; // prompt cache is cold after ~5 min
  let u; try { u = JSON.parse(prevRun.usage_json); } catch { return false; }
  const context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const resumeCost = context * 0.1; // cache-read price ≈ 10% of input
  const freshCost = Math.ceil(String(packText).length / 4) + 12_000; // pack + charter + a little exploration
  return resumeCost < freshCost;
}
export function resolvePrompt(t, job, pack) {
  return promptFor('resolve', { ticket: t, comments: [], extra: { pack, base: config.project.baseBranch } });
}

/** `desk resolve done|stuck "..."` from the resolve run. */
export async function resolveCommand(run, t, body) {
  need(t && t.key === run.ticket_key && run.kind === 'resolve', 'you are not resolving this ticket');
  const job = store.conflictJobsFor(t.key).find((j) => j.run_id === run.id && j.status === 'running');
  need(job && job.seat === run.agent_id, 'no conflict job is bound to this run');
  need(['done', 'stuck'].includes(body.action), 'desk resolve done "<how you resolved it>"  |  desk resolve stuck "<why>"');
  const text = store.redact(String(body.body || '').trim()).slice(0, 3000);
  need(text, 'say how you resolved it (or why you could not)');
  if (body.action === 'stuck') {
    store.updateConflictJob(job.id, { status: 'needs_owner', note: text });
    say(t, `conflict-stuck:${job.id}`, `🧭 **${nameOf(job.seat)} could not resolve the conflict alone**: ${text}\n\nThe owner decides; reply on the desk to let ${nameOf(job.seat)} try again with your guidance.`, job.head_sha);
    setStatus(t.key, 'needs_human', { resume_status: 'review', progress_msg: 'conflict needs your call' });
    github.flushOutbox();
    return 'Parked for the owner. Stop now.';
  }
  const dir = run.cwd;
  const g = (args) => runner.scratchGit(dir, args);
  need(!(await g(['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).stdout.trim(), 'the merge is not committed yet — git add the resolved files, then git commit');
  need(!(await g(['diff', '--name-only', '--diff-filter=U'])).stdout.trim(), 'some files are still unmerged — resolve them, git add, git commit');
  need(!(await g(['status', '--porcelain', '--untracked-files=no'])).stdout.trim(), 'commit every change first (git status is not clean)');
  const head = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  need(head !== job.head_sha, 'nothing was committed');
  need((await g(['merge-base', '--is-ancestor', job.head_sha, head])).code === 0, 'your commit must build on the PR head (do not rebase or reset)');
  need((await g(['merge-base', '--is-ancestor', job.base_sha, head])).code === 0, `your commit must include ${config.project.baseBranch} (finish the merge)`);
  const paths = JSON.parse(job.files_json || '[]').map((f) => f.path);
  const markers = paths.length ? (await g(['grep', '-n', '-I', '-E', '^(<<<<<<<|>>>>>>>)( |$)', head, '--', ...paths])).stdout.trim() : '';
  need(!markers, `conflict markers are still in: ${[...new Set(markers.split('\n').map((l) => l.split(':')[1]))].join(', ')}`);
  await finishResolution(t, job, head, dir, text);
  return 'Resolution recorded; QA re-checks it and the reviewers re-confirm. Stop now.';
}

export async function finishResolution(t, job, head, dir, how) {
  await runner.fetchIntoPublisher(t.key, dir, head);
  await runner.syncWorkspace(store.getTicket(t.key), head);
  store.updateConflictJob(job.id, { status: 'resolved', result_sha: head, note: how });
  store.supersedeReviews(t.key, null);
  const incoming = JSON.parse(job.incoming_json || '[]');
  say(t, `resolved:${job.id}`, `✅ **${nameOf(job.seat)} resolved the conflict** with ${describeIncoming(incoming)} (now \`${short(head)}\`): ${how}\n\nQA re-checks it next, then both reviewers re-confirm the resolution.`, head, job.seat);
  setStatus(t.key, 'qa', { head_sha: head, review_stage: null, reconfirm_from: job.head_sha, reconfirm_kind: 'resolution', reconfirm_base: job.base_sha,
    progress: 90, progress_msg: 'conflict resolved — QA re-checking' });
  runner.removeScratch(`resolve-${t.key}`);
  github.flushOutbox();
}

export function recover() {
  for (const j of store.openConflictJobs()) if (j.status === 'running') store.updateConflictJob(j.id, { status: 'pending', run_id: null });
}

// ---------------- lazy update of the queue front ----------------
/** Bring a clean-but-behind PR up to date (rebase; squash-merged parent → rebase --onto). Head changes ⇒ QA + re-confirm. */
export async function lazyUpdate(t, snap) {
  const head = snap.heads.find((h) => h.t.key === t.key)?.head;
  if (!head) return { action: 'skip', reason: 'the PR branch is not on GitHub' };
  if (head !== t.head_sha) {
    store.updateTicket(t.key, { merge_hold: `the PR branch changed outside the desk (${short(head)})` });
    say(t, `foreign-head:${head}`, `⏸ **The PR branch changed outside SigmaDesk** (now \`${short(head)}\`, approved \`${short(t.head_sha)}\`). Auto-merge is on hold until you look at it.`, head);
    return { action: 'held' };
  }
  if (await isAncestor(snap.base, head)) return { action: 'current' };
  const mt = await mergeTree(snap.base, head);
  if (mt.status === 'conflict') { await onConflict(t, snap.base, head, mt); return { action: 'conflict' }; }
  if (mt.status === 'error') return { action: 'skip', reason: mt.error };
  const parent = t.after_key ? store.getTicket(t.after_key) : null;
  const dir = await runner.scratchClone(`update-${t.key}`, [`+${head}:refs/heads/work`, `+${snap.base}:refs/heads/sigmadesk-base`,
    ...(parent?.head_sha ? [`+${parent.head_sha}:refs/heads/sigmadesk-parent`] : [])]);
  const g = (args) => runner.scratchGit(dir, args);
  try {
    await g(['checkout', '-q', 'work']);
    const onto = parent?.status === 'done' && parent.head_sha && (await g(['merge-base', '--is-ancestor', parent.head_sha, head])).code === 0 ? parent.head_sha : null;
    let r = await g(onto ? ['rebase', '-q', '--onto', 'sigmadesk-base', onto] : ['rebase', '-q', 'sigmadesk-base']);
    let how = onto ? `rebased onto \`${config.project.baseBranch}\`, dropping the commits of ${parent.key} (merged as a squash)` : `rebased onto \`${config.project.baseBranch}\``;
    if (r.code) {
      await g(['rebase', '--abort']);
      r = await g(['merge', '--no-ff', '--no-edit', '-m', `Merge ${config.project.baseBranch} into this branch`, 'sigmadesk-base']);
      how = `merged \`${config.project.baseBranch}\` in (a rebase would have stopped on an intermediate commit)`;
      if (r.code) { await g(['merge', '--abort']); return { action: 'skip', reason: 'git could not apply the update cleanly' }; }
    }
    const newHead = (await g(['rev-parse', 'HEAD'])).stdout.trim();
    const { files, lines } = await runner.stageApproved(t.key, dir, newHead);
    const reasons = guardReasons(files, lines, t.complexity);
    if (reasons.length) {
      store.updateTicket(t.key, { merge_hold: `publish guard: ${reasons.join('; ')}` });
      say(t, `update-guard:${newHead}`, `🛑 **Not updated automatically**: bringing it up to date would push ${reasons.join('; ')}. Update the branch yourself or merge from the PR page.`, head);
      return { action: 'held' };
    }
    try { await runner.pushBranchLease(t.branch, newHead, head); } catch (err) {
      store.logEvent({ kind: 'github', ticket_key: t.key, text: `update push refused (the branch moved?): ${String(err.stderr || err.message).slice(0, 200)}` });
      return { action: 'raced' };
    }
    store.kvSet(`published:${t.key}`, newHead);
    await runner.syncWorkspace(t, newHead);
    store.supersedeReviews(t.key, null);
    const incoming = await incomingFor(snap.base, head, []).catch(() => []);
    say(t, `updated:${newHead}`, `🔄 **Brought up to date with \`${config.project.baseBranch}\`** (${how}; it now includes ${describeIncoming(incoming)}). Git applied it cleanly, but the code under test changed, so QA re-runs and both reviewers quickly re-confirm before it merges.`, newHead);
    setStatus(t.key, 'qa', { head_sha: newHead, review_stage: null, reconfirm_from: head, reconfirm_kind: 'rebase', reconfirm_base: snap.base,
      progress: 92, progress_msg: `updated onto ${config.project.baseBranch} — QA re-checking before merge` });
    github.flushOutbox();
    return { action: 'updated', head: newHead };
  } finally { runner.removeScratch(`update-${t.key}`); }
}

// ---------------- the queue ----------------
/** Approved, published PRs in merge order: oldest approval first; a slice waits for its `after_key` predecessor. */
export function queue() {
  return store.ticketsByStatus('ready_for_human').filter((t) => t.review_stage === 'approved' && t.pr_url)
    .sort((a, b) => String(a.approved_at || a.updated_at).localeCompare(String(b.approved_at || b.updated_at)) || a.id - b.id);
}

function waitMsg(t, names, text) {
  const msg = `Approved by ${names} — ${text}`;
  if (store.getTicket(t.key)?.progress_msg !== msg) store.updateTicket(t.key, { progress_msg: msg });
}

/** Decide one approved ticket. allowMerge=false once this sweep already merged/updated something (serialized train). */
export async function consider(t, { now = new Date(), snap = null, allowMerge = true } = {}) {
  const ap = store.approvalsAt(t.key, t.head_sha);
  if (!ap.ok) return { action: 'skip', reason: 'approvals are not at the current commit' };
  const names = `${nameOf(ap.context.seat)} and ${nameOf(ap.independent.seat)}`;
  const wait = (reason, action = 'wait') => { waitMsg(t, names, reason); return { action, reason }; };
  const policy = reviews.autoMergePolicy(t);
  if (!policy.eligible) return wait(`waiting for your merge (${policy.reason})`, 'owner');
  if (t.merge_hold) return wait(`on hold: ${t.merge_hold}`, 'held');
  const parent = t.after_key ? store.getTicket(t.after_key) : null;
  if (parent && parent.status !== 'done') return wait(`merges after ${parent.key}`);
  const dep = await deployInfo(t);
  if (dep.deploys && inBusyWindow(now)) {
    const at = windowEnd(now);
    if (t.merge_after !== at.toISOString()) {
      store.updateTicket(t.key, { merge_after: at.toISOString() });
      say(t, `scheduled:${t.head_sha}:${at.toISOString()}`, `⏰ **Scheduled to merge automatically after ${fmtTime(at)}** because ${dep.reason || 'it redeploys a service'} and it is inside the busy window (market hours). Every merge check runs again at that time. The owner can merge now or put it on hold.`);
      github.flushOutbox();
    }
    return wait(`merges automatically at ${fmtTime(at)} (${dep.reason || 'redeploys'})`, 'scheduled');
  }
  if (t.merge_after) store.updateTicket(t.key, { merge_after: null });
  if (!allowMerge) return wait('queued behind another merge', 'queued');
  if (store.getSettings().paused === 'true') return wait('auto-merge waiting: the desk is paused', 'queued');
  if (ap.unpublished) return wait('auto-merge waiting: the review comments are not on the PR yet', 'queued');
  if (dep.deploys) {
    const lock = await deployLock(now);
    if (lock) return wait(lock.state === 'running' ? `auto-merge waiting: the deploy of ${lock.key} is still running` : `auto-merge waiting: the last deploy ${lock.state === 'failed' ? 'failed' : 'did not finish'} — clear the deploy hold after checking it`, 'queued');
  }
  if (snap && config.mergeTrain?.updateWhenBehind !== false) {
    const u = await lazyUpdate(t, snap);
    if (u.action !== 'current') return u.action === 'updated' ? { action: 'updated' } : wait(`auto-merge waiting: ${u.reason || u.action}`, u.action);
  }
  store.updateTicket(t.key, { review_stage: 'merging' });
  const am = config.review.autoMerge || {};
  const n = prNumber(t.pr_url);
  try {
    await prs.merge(n, { actor: 'desk', method: am.method || 'squash', expectedSha: t.head_sha, inBusyWindow: false, halted: false });
  } catch (err) {
    store.updateTicket(t.key, { review_stage: 'approved' });
    return wait(`auto-merge waiting: ${String(err.message).replace(/^Not merged: /, '').replace(/\.$/, '')}`, 'queued');
  }
  let mergeSha = null;
  try { mergeSha = await prs.mergeCommitOf(n); } catch { /* unknown: the lock falls back to the timeout */ }
  if (dep.deploys) lockSet({ key: t.key, pr: n, merge_sha: mergeSha, at: now.toISOString(), workflows: dep.workflows.map((w) => w.name), state: 'running' });
  const text = `🔀 **Merged by SigmaDesk** after approvals from ${nameOf(ap.context.seat)} (${roleOf(ap.context.seat)}) and ${nameOf(ap.independent.seat)} (${roleOf(ap.independent.seat)}) at \`${short(t.head_sha)}\`. Low risk, CI green${dep.deploys ? `; ${dep.reason}, so the next deploying merge waits for that deploy to finish` : '; nothing redeploys'}.`;
  say(t, `merged:${t.head_sha}`, text);
  store.updateTicket(t.key, { review_stage: 'merged', progress_msg: `Merged by SigmaDesk after approvals from ${names}` });
  github.flushOutbox();
  return { action: 'merged', merge_sha: mergeSha };
}

let sweeping = null;
/** Every minute: post PR comments, watch the base (free conflict check), then move the train one step. */
export function sweep({ now = new Date() } = {}) {
  if (!enabled()) return Promise.resolve(null);
  if (sweeping) return sweeping;
  sweeping = (async () => {
    await github.flushOutbox();
    let snap = null;
    if (store.getSettings().github_sync === 'true') {
      try { snap = await watchBase(); if (snap) await detectConflicts(snap); }
      catch (err) { store.logEvent({ kind: 'github', agent_id: 'github', text: `base watcher: ${String(err.message).slice(0, 200)}` }); snap = null; }
    }
    const results = [];
    // The train is serialized: while the queue front is being brought up to date (QA + re-confirm), nothing behind it
    // merges — otherwise every merge would push it behind again.
    const updating = store.listTickets().find((t) => t.reconfirm_kind === 'rebase' && ['qa', 'review'].includes(t.status) && t.approved_at);
    let moved = false;
    for (const t of queue()) {
      const blocked = moved || (updating && String(updating.approved_at) <= String(t.approved_at));
      const r = await consider(store.getTicket(t.key), { now, snap, allowMerge: !blocked })
        .catch((err) => ({ action: 'error', reason: err.message }));
      if (r.action === 'error') store.logEvent({ kind: 'error', ticket_key: t.key, text: `merge train: ${r.reason}` });
      if (['merged', 'updated'].includes(r.action)) moved = true;
      results.push({ key: t.key, ...r });
    }
    return results;
  })().finally(() => { sweeping = null; });
  return sweeping;
}

// ---------------- owner actions + API view ----------------
export function setHold(key, hold, reason = '') {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  const why = String(reason || '').trim().slice(0, 300);
  store.updateTicket(key, { merge_hold: hold ? (why || 'held by the owner') : null });
  const text = hold ? `⏸ **On hold by the owner**${why ? `: ${why}` : ''}. SigmaDesk will not merge it until released.` : '▶️ **Released by the owner** — SigmaDesk merges it when every check passes.';
  if (t.pr_url) say(t, `hold:${Date.now()}`, text, t.head_sha, 'owner');
  else store.addComment(key, 'owner', text);
  github.flushOutbox();
  return mergeState(store.getTicket(key));
}

/** {state: queued|scheduled|held|conflict|merging|merged|owner|null, ...} for the v2 UI. */
export function mergeState(t, now = new Date()) {
  if (!t) return null;
  if (t.status === 'done') return { state: 'merged' };
  const job = store.conflictJobsFor(t.key).filter((j) => ['pending', 'running', 'needs_owner'].includes(j.status)).pop();
  if (job || t.review_stage === 'resolving') {
    return { state: 'conflict', files: job ? JSON.parse(job.files_json || '[]').map((f) => f.path) : [],
      resolver: job ? { seat: job.seat, name: nameOf(job.seat) } : null, incoming: job ? JSON.parse(job.incoming_json || '[]') : [],
      job: job ? { id: job.id, status: job.status, attempts: job.attempts, base: job.base_sha, head: job.head_sha } : null };
  }
  if (t.merge_hold) return { state: 'held', reason: t.merge_hold };
  const lock = lockGet();
  if (['merging', 'merged'].includes(t.review_stage)) return { state: 'merging' }; // merged on GitHub; the board catches up on the next sync
  if (t.status !== 'ready_for_human' || t.review_stage !== 'approved') return null;
  const policy = reviews.autoMergePolicy(t);
  if (!policy.eligible) return { state: 'owner', reason: policy.reason };
  if (t.merge_after && Date.parse(t.merge_after) > now.getTime()) return { state: 'scheduled', at: t.merge_after, label: fmtTime(new Date(t.merge_after)) };
  const q = queue().filter((x) => reviews.autoMergePolicy(x).eligible && !x.merge_hold);
  return { state: 'queued', position: q.findIndex((x) => x.key === t.key) + 1, deploy_lock: lock ? { key: lock.key, state: lock.state } : null };
}
export const conflictJobsView = (key) => store.conflictJobsFor(key).map((j) => ({ id: j.id, status: j.status, seat: j.seat, name: nameOf(j.seat), base: j.base_sha, head: j.head_sha,
  files: JSON.parse(j.files_json || '[]').map((f) => ({ path: f.path, kind: f.kind })), incoming: JSON.parse(j.incoming_json || '[]'), attempts: j.attempts, result: j.result_sha, note: j.note, at: j.updated_at }));
export const deployState = () => lockGet();
