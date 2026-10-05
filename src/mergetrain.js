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
import { agentById, routeSlice, routeTicket, PRINCIPALS, BUILDERS, promptFor } from './team.js';
import { selectionFor } from './dispatch.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as prs from './prs.js';
import * as workflows from './workflows.js';
import * as reviews from './reviews.js';
import * as refresh from './refresh.js';
import crypto from 'node:crypto';
import { notify } from './notify.js';
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
    const ls = await pgit(['ls-tree', '--name-only', '-z', 'refs/sigmadesk/base', '.github/workflows/']);
    let out = null;
    if (!ls.code) {
      out = [];
      for (const file of ls.stdout.split('\0').filter((f) => /\.ya?ml$/.test(f))) {
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
// A lock names the merge commit and the deploying workflow FILES expected to run for it. Deploying merges observed
// while a lock is held are queued (never forgotten) and take the lock in order.
// Every lock carries an id; mutations after an await are compare-and-set on that id (inside a DB transaction), and
// refreshes are serialized by an in-process mutex, so a stale poll for deploy A can never release deploy B.
const lockGet = () => { try { return JSON.parse(store.kvGet('train:deploy') || 'null'); } catch { return null; } };
const lockSet = (v) => store.kvSet('train:deploy', v ? JSON.stringify({ ...v, id: v.id || crypto.randomBytes(6).toString('hex') }) : 'null');
/** Replace the lock only if it is still the one identified by `id`. */
export function casLock(id, next) {
  return store.transaction(() => {
    if ((lockGet()?.id ?? null) !== (id ?? null)) return false;
    lockSet(next);
    return true;
  });
}
let lockMutex = Promise.resolve();
function serialized(fn) {
  const p = lockMutex.then(fn, fn);
  lockMutex = p.catch(() => {});
  return p;
}
const kvList = (k) => { try { return JSON.parse(store.kvGet(k) || '[]') || []; } catch { return []; } };
export const pendingDeploys = () => kvList('train:deploy-pending');
/** Take the lock now, or queue behind the current one. */
export function queueDeploy(entry) {
  return store.transaction(() => {
    const l = lockGet();
    if (!l) { lockSet(entry); return 'locked'; }
    const pending = pendingDeploys();
    if (entry.merge_sha && (l.merge_sha === entry.merge_sha || pending.some((p) => p.merge_sha === entry.merge_sha))) return 'known';
    store.kvSet('train:deploy-pending', JSON.stringify([...pending, entry].slice(-50)));
    return 'queued';
  });
}
/** Release the lock identified by `id` (no-op if it changed) and promote the next queued deploy. */
export function releaseLock(id) {
  return store.transaction(() => {
    const l = lockGet();
    if (!l || (l.id ?? null) !== (id ?? null)) return false;
    if (l.merge_sha) store.kvSet('train:deploy-released', JSON.stringify([...kvList('train:deploy-released'), l.merge_sha].slice(-30)));
    const released = new Set(kvList('train:deploy-released'));
    const pending = pendingDeploys().filter((p) => !released.has(p.merge_sha));
    const next = pending.shift() || null;
    store.kvSet('train:deploy-pending', JSON.stringify(pending));
    lockSet(next);
    return true;
  });
}
/** The owner's "Clear the hold": only a failed or unconfirmed deploy, and only the one they were looking at. */
export function ownerClearDeploy({ merge_sha } = {}) {
  const l = lockGet();
  if (!l) return null;
  if (!OVERRIDABLE_HOLDS.includes(l.state)) throw Object.assign(new Error('A deploy is running now; wait for it to finish.'), { status: 409 });
  if (merge_sha && l.merge_sha !== merge_sha) throw Object.assign(new Error('The deploy hold changed since you opened it; look at the current one first.'), { status: 409 });
  return clearDeployLock('owner');
}
export function clearDeployLock(by = 'owner') {
  const l = lockGet();
  if (l) releaseLock(l.id);
  store.logEvent({ kind: 'action', agent_id: by, ticket_key: l?.key || null, text: `deploy lock cleared${l ? ` (was ${l.state} for ${l.key || l.merge_sha})` : ''}` });
  return l;
}
/**
 * null when no deploy is in flight; otherwise the lock (refreshed from GitHub's workflow runs). Released ONLY when
 * every expected deploy workflow file has a run for the merge commit that completed successfully. Unknown expected
 * workflows, a missing run, a failure or an unreadable GitHub keep it locked; after deploy.waitMinutes the owner is
 * asked (state "escalated" / "failed").
 */
export function deployLock(now = new Date()) { return serialized(() => refreshLock(now, 0)); }
async function refreshLock(now, depth) {
  const l = lockGet();
  if (!l) return null;
  if (l.state !== 'running') return l; // merging (intent in flight), failed, escalated: only reconcile / the owner clears
  const age = (now.getTime() - Date.parse(l.at)) / 60_000;
  let runs = null;
  if (l.merge_sha) { try { runs = await prs.runsForCommit(l.merge_sha); } catch { runs = null; } }
  const expected = l.workflows || [];
  const latest = (file) => (runs || []).filter((r) => r.path === file).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  const states = expected.map((file) => ({ file, run: latest(file) }));
  const failed = states.filter((x) => x.run?.status === 'completed' && String(x.run.conclusion).toLowerCase() !== 'success');
  const t = l.key ? store.getTicket(l.key) : null;
  const label = (file) => file.split('/').pop();
  const tell = (marker, text) => {
    if (t) { say(t, marker, text, l.merge_sha); notify('needs_human', t, 'deploy needs you'); }
    else store.logEvent({ kind: 'error', agent_id: 'github', text: text.replace(/\*\*/g, '') });
  };
  if (failed.length) {
    const next = { ...l, state: 'failed', note: failed.map((x) => `${label(x.file)}: ${x.run.conclusion}`).join(', ') };
    if (!casLock(l.id, next)) return lockGet(); // the lock changed while GitHub was polled: this result is stale
    tell(`deploy-failed:${l.merge_sha}`, `🚨 **The deploy after this merge failed** (${next.note}). SigmaDesk will not merge anything else that redeploys until you check it and clear the deploy hold.`);
    return next;
  }
  if (runs && expected.length && states.every((x) => x.run?.status === 'completed')) {
    if (!releaseLock(l.id)) return lockGet(); // stale result for a lock that is no longer current
    return depth < 5 ? refreshLock(now, depth + 1) : lockGet();
  }
  if (age > (Number(config.deploy?.waitMinutes) || 45)) {
    const missing = !l.merge_sha ? ['the merge commit is unknown'] : runs == null ? ['GitHub runs could not be read']
      : !expected.length ? ['which workflows deploy is unknown'] : states.filter((x) => x.run?.status !== 'completed').map((x) => `${label(x.file)} ${x.run ? x.run.status : 'never started'}`);
    const next = { ...l, state: 'escalated', note: missing.join(', ') };
    if (!casLock(l.id, next)) return lockGet();
    tell(`deploy-timeout:${l.merge_sha || l.at}`, `⏳ **The deploy after this merge has not finished in ${Math.round(age)} minutes** (${next.note}). SigmaDesk is holding further deploying merges until you check it and clear the deploy hold.`);
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
/** Resolve runs only go to seats whose engine enforces the resolve.budgetUsd hard cap (today: Claude CLI). */
export const cappedSeat = (id) => seatOn(id) && runner.capsSpend(selectionFor(id).seat);
/**
 * The engineer who built it; if that seat is off (or its engine cannot cap spend), the same area and tier, then any
 * builder. Never a principal (they do not code). null = nobody can run it within the spend cap.
 */
export function resolverFor(t) {
  const builder = t.builder || t.assignee;
  const candidates = [builder, routeSlice({ area: t.area, complexity: t.complexity || 'M' }), routeTicket({ area: t.area, complexity: 'M' }), ...BUILDERS];
  return candidates.find((id) => id && !PRINCIPALS.includes(id) && cappedSeat(id)) || null;
}
const RESOLVABLE = new Set(['review', 'ready_for_human']);
/** An owner-triggered branch refresh that has not been published yet owns the branch (refresh.js). */
const refreshPending = (key) => { const r = refresh.current(key); return !!r && r.status !== 'published'; };
export async function onConflict(t, base, head, mt, { reservation = null } = {}) {
  if (!t || !RESOLVABLE.has(t.status)) return null; // in progress / QA / owner: checked again next cycle
  // The conflict job holds the ticket reservation until it is resolved: taken over from the caller's desk merge, kept
  // from an earlier conflict job, or reserved now — synchronously, before any await.
  const held = store.reservationOf(t.key);
  let token = null;
  if (reservation && held?.token === reservation) { store.transferReservation(t.key, reservation, 'train-resolve', 'merge-train conflict resolution'); token = reservation; }
  else if (held?.kind === 'train-resolve') token = held.token;
  else { const r = store.reserve(t.key, 'train-resolve', 'merge-train conflict resolution'); if (!r.ok) return null; token = r.token; }
  const giveBack = () => { if (!reservation) store.releaseReservation(t.key, token, 'train-resolve'); else store.transferReservation(t.key, token, 'desk-merge', 'merge train'); };
  if (refreshPending(t.key)) { giveBack(); return null; } // the owner's refresh is handling this branch
  const jobs = store.conflictJobsFor(t.key);
  if (jobs.some((j) => j.status === 'running')) return null; // finish the current resolution first (it holds the reservation)
  const files = mt.conflicts.map((c) => ({ path: c.path, kind: c.kind, stages: c.stages, messages: c.messages.slice(0, 3) }));
  const incoming = await incomingFor(base, head, files.map((f) => f.path)).catch(() => []);
  const seat = resolverFor(t) || t.builder || t.assignee; // nobody capped: the job waits (nextResolveJobs re-picks)
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
    if (!['pending', 'needs_owner'].includes(j.status)) continue;
    if (!cappedSeat(j.seat)) { // the seat (or its engine today) cannot enforce the spend cap: pick another capped seat
      const alt = resolverFor(store.getTicket(j.ticket_key));
      if (!alt) continue;
      store.updateConflictJob(j.id, { seat: alt });
      j.seat = alt;
    }
    if (seats.has(j.seat)) continue;
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
  const incoming = JSON.parse(job.incoming_json || '[]');
  // One transaction: the job is never "resolved" without the ticket moving on to QA (no orphaned state after a crash).
  store.transaction(() => {
    store.updateConflictJob(job.id, { status: 'resolved', result_sha: head, note: how });
    store.addContributor(t.key, job.seat); // the resolver wrote code: they can never review this ticket
    store.supersedeReviews(t.key, null);
    const held = store.reservationOf(t.key);
    if (held?.kind === 'train-resolve') store.releaseReservation(t.key, held.token, 'train-resolve');
    say(t, `resolved:${job.id}`, `✅ **${nameOf(job.seat)} resolved the conflict** with ${describeIncoming(incoming)} (now \`${short(head)}\`): ${how}\n\nQA re-checks it next, then both reviewers re-confirm the resolution.`, head, job.seat);
    setStatus(t.key, 'qa', { head_sha: head, review_stage: null, reconfirm_from: job.head_sha, reconfirm_kind: 'resolution', reconfirm_base: job.base_sha,
      progress: 90, progress_msg: 'conflict resolved — QA re-checking' });
  });
  runner.removeScratch(`resolve-${t.key}`);
  github.flushOutbox();
}

export function recover() {
  // After a restart no merge call is in flight: a merge reservation without its persisted intent is released (an
  // intent left behind is reconciled with GitHub, which then releases its reservation). Refresh and conflict
  // reservations are durable on purpose.
  const i = intentGet();
  for (const r of store.listReservations()) {
    if (['desk-merge', 'owner-merge', 'train-update'].includes(r.kind) && r.token !== i?.reservation && !journalGet(r.ticket_key)) store.releaseReservation(r.ticket_key, r.token);
  }
  for (const j of store.openConflictJobs()) if (j.status === 'running') store.updateConflictJob(j.id, { status: 'pending', run_id: null });
}

// ---------------- lazy update of the queue front ----------------
// The force-push is journaled first: if the desk dies after GitHub accepted it, the next look at the branch sees
// exactly the journaled new head and finishes the transition instead of mistaking its own push for a foreign one.
const journalKey = (key) => `train:push:${key}`;
const journalGet = (key) => { try { return JSON.parse(store.kvGet(journalKey(key)) || 'null'); } catch { return null; } };
const journalSet = (key, v) => store.kvSet(journalKey(key), v ? JSON.stringify(v) : 'null');

async function completeUpdate(t, j) {
  await runner.withPublisher((pgit) => pgit(['update-ref', `refs/sigmadesk/${t.key}`, j.new]));
  store.kvSet(`published:${t.key}`, j.new);
  await runner.syncWorkspace(store.getTicket(t.key), j.new);
  store.transaction(() => {
    store.supersedeReviews(t.key, null);
    say(t, `updated:${j.new}`, `🔄 **Brought up to date with \`${config.project.baseBranch}\`** (${j.how}; it now includes ${j.incoming || `\`${config.project.baseBranch}\``}). Git applied it cleanly, but the code under test changed, so QA re-runs and both reviewers quickly re-confirm before it merges.`, j.new);
    setStatus(t.key, 'qa', { head_sha: j.new, review_stage: null, reconfirm_from: j.old, reconfirm_kind: 'rebase', reconfirm_base: j.base,
      progress: 92, progress_msg: `updated onto ${config.project.baseBranch} — QA re-checking before merge` });
    journalSet(t.key, null);
  });
  github.flushOutbox();
  return { action: 'updated', head: j.new };
}

/** Bring a clean-but-behind PR up to date (rebase; squash-merged parent → rebase --onto). Head changes ⇒ QA + re-confirm. */
export async function lazyUpdate(t, snap, { epoch = runner.currentEpoch(), reservation = null } = {}) {
  let own = null;
  if (!reservation) { // standalone: reserve synchronously, before any await, and release when done
    const r = store.reserve(t.key, 'train-update', 'merge-train update onto the base');
    if (!r.ok) return { action: 'skip', reason: `another operation holds this PR (${r.holder.note || r.holder.kind})` };
    own = r.token;
  } else if (store.reservationOf(t.key)?.token !== reservation) return { action: 'skip', reason: 'the reservation for this PR was lost' };
  try { return await lazyUpdateHeld(t, snap, epoch, own || reservation); }
  finally { if (own) store.releaseReservation(t.key, own, 'train-update'); }
}
async function lazyUpdateHeld(t, snap, epoch, reservation) {
  const head = snap.heads.find((h) => h.t.key === t.key)?.head;
  if (!head) return { action: 'skip', reason: 'the PR branch is not on GitHub' };
  const j = journalGet(t.key);
  if (j && head === j.new && t.head_sha === j.old) return completeUpdate(t, j); // our push landed before a crash
  if (j) journalSet(t.key, null); // the push never happened (or someone else moved it): forget the intent
  if (head !== t.head_sha) {
    store.updateTicket(t.key, { merge_hold: `the PR branch changed outside the desk (${short(head)})` });
    say(t, `foreign-head:${head}`, `⏸ **The PR branch changed outside SigmaDesk** (now \`${short(head)}\`, approved \`${short(t.head_sha)}\`). Auto-merge is on hold until you look at it.`, head);
    return { action: 'held' };
  }
  if (await isAncestor(snap.base, head)) return { action: 'current' };
  if (refreshPending(t.key)) return { action: 'skip', reason: 'an owner branch refresh is in progress' };
  if (config.mergeTrain?.updateWhenBehind === false) return { action: 'behind', reason: `the branch is behind ${config.project.baseBranch}; update it (CI must run on the combined code)` };
  const mt = await mergeTree(snap.base, head);
  if (mt.status === 'conflict') { await onConflict(t, snap.base, head, mt, { reservation }); return { action: 'conflict' }; }
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
    if (epoch !== runner.currentEpoch() || store.getSettings().paused === 'true') return { action: 'stopped', reason: 'the desk was stopped' };
    const incoming = describeIncoming(await incomingFor(snap.base, head, []).catch(() => []));
    const journal = { old: head, new: newHead, base: snap.base, how, incoming, at: store.now() };
    journalSet(t.key, journal);
    // The same lease push the owner's branch refresh uses: GitHub refuses it if the branch moved since we looked.
    if (store.reservationOf(t.key)?.token !== reservation) return { action: 'stopped', reason: 'the reservation for this PR was lost' };
    try { await runner.pushBranch(t.key, t.branch, newHead, { lease: head }); } catch (err) {
      journalSet(t.key, null);
      store.logEvent({ kind: 'github', ticket_key: t.key, text: `update push refused (the branch moved?): ${String(err.stderr || err.message).slice(0, 200)}` });
      return { action: 'raced' };
    }
    return await completeUpdate(t, journal);
  } finally { runner.removeScratch(`update-${t.key}`); }
}

// ---------------- the queue ----------------
/** Approved, published PRs in merge order: oldest approval first; a slice waits for its `after_key` predecessor. */
export function queue() {
  return store.ticketsByStatus('ready_for_human').filter((t) => t.review_stage === 'approved' && t.pr_url)
    .sort((a, b) => String(a.approved_at || a.updated_at).localeCompare(String(b.approved_at || b.updated_at)) || a.id - b.id);
}

// How long the train has waited on this commit, and why: a wait that never ends is handed to the owner (mergeState).
const WAIT_KEY = (key) => `train:wait:${key}`;
function noteWait(t, action, reason) {
  let prev = null; try { prev = JSON.parse(store.kvGet(WAIT_KEY(t.key)) || 'null'); } catch { prev = null; }
  const since = prev?.head === t.head_sha && prev?.action === action ? prev.since : new Date().toISOString();
  store.kvSet(WAIT_KEY(t.key), JSON.stringify({ head: t.head_sha, action, reason, since }));
}
export const ownerAfterHours = () => Number(config.mergeTrain?.ownerAfterHours ?? 6);

function waitMsg(t, names, text) {
  const msg = `Approved by ${names} — ${text}`;
  if (store.getTicket(t.key)?.progress_msg !== msg) store.updateTicket(t.key, { progress_msg: msg });
}

// ---------------- merge intents: persisted BEFORE the merge, reconciled after a crash ----------------
const intentGet = () => { try { return JSON.parse(store.kvGet('train:intent') || 'null'); } catch { return null; } };
const intentSet = (v) => store.kvSet('train:intent', v ? JSON.stringify(v) : 'null');
const inFlight = new Map();
/** The dispatch gate reads time through this (tests move it); never a timestamp captured earlier in the sweep. */
export const clock = { now: () => new Date() }; // intent.at → started (this process): reconciliation never touches a merge still running

/**
 * The single live gate, called by prs.merge immediately before it dispatches `gh pr merge`. The only await (the
 * remote base lookup) comes FIRST; every other condition is then re-read synchronously, so nothing can change between
 * the last check and the dispatch: stop-all fence, halt, ticket status, Hold, stored + diff risk, published approvals,
 * the busy window and deploy-lock ownership for deploying changes.
 */
export async function authorizeMerge(key, intent, ctx = {}) {
  const fail = (why) => { throw Object.assign(new Error(`Not merged: ${why}.`), { status: 409 }); };
  const live = intent.base ? await runner.remoteHead(config.project.baseBranch).catch(() => null) : null;
  // ---- synchronous from here to the dispatch ----
  if (intent.base && live !== intent.base) fail(`${config.project.baseBranch} moved since its CI was read (${short(intent.base)} → ${short(live) || '?'}); re-checking next cycle`);
  if (intent.epoch !== runner.currentEpoch()) fail('the desk was stopped (circuit breaker)');
  const t = store.getTicket(key);
  const mine = intentGet();
  if (!mine || mine.at !== intent.at) fail('this merge is no longer the active merge intent');
  if (!intent.reservation || store.reservationOf(key)?.token !== intent.reservation) fail('this merge does not hold the PR\'s reservation (another operation owns it)');
  if (ctx.expectedSha && intent.head && ctx.expectedSha !== intent.head) fail('the requested commit is not the one this merge was started for');
  if (t) {
    // Every merge of a desk ticket (owner too): the branch must not be in the middle of a rewrite, and the commit must
    // still be the ticket's commit. QA and both approvals must hold for it unless the owner gave a review override.
    if (TERMINAL.has(t.status)) fail(`the ticket is ${t.status}`);
    const r = refresh.current(key);
    if (r && r.status !== 'published') fail('an owner branch refresh of this PR is in progress');
    if (!t.head_sha || t.head_sha !== intent.head) fail('the ticket\'s commit changed since this merge started');
    if (store.inReviewFlow(key) && !(ctx.overridden || []).length) {
      if (t.qa_sha !== intent.head) fail('QA has not passed this exact commit');
      const ap0 = store.approvalsAt(key, intent.head);
      if (!ap0.ok || ap0.unpublished) fail('the two approvals are not complete and published at this commit');
    }
  }
  if (intent.by === 'desk') {
    if (store.getSettings().paused === 'true') fail('the desk is paused');
    if (t?.status !== 'ready_for_human' || t.review_stage !== 'merging') fail('the ticket is no longer approved and queued');
    if (t.head_sha !== intent.head) fail('the approved commit changed');
    if (t.merge_hold) fail(`it is on hold: ${t.merge_hold}`);
    const policy = reviews.autoMergePolicy(t);
    if (!policy.eligible) fail(policy.reason);
    const ap = store.approvalsAt(key, intent.head);
    if (!ap.ok || ap.unpublished) fail('the two approvals are not complete and published at this commit');
  }
  if (intent.deploys && intent.by === 'desk' && inBusyWindow(clock.now())) fail('it redeploys and the busy window has started');
  if (intent.deploys) {
    const l = lockGet();
    if (!l || l.key !== key || l.state !== 'merging' || l.intent_at !== intent.at) fail('the deploy lock is not held for this merge');
  }
}

/** The merge intent currently being dispatched or confirmed for this ticket (null if none). */
export const activeIntentFor = (key) => { const i = intentGet(); return i && i.key === key ? i : null; };

/** Persist the intent, the ticket's "merging" stage and (for deploying changes) the deploy lock in ONE transaction. */
// The owner may merge past a deploy hold whose deploy failed or was never confirmed (never one still running: two
// deploys would overlap), with a reason. The desk's own merges never can.
export const OVERRIDABLE_HOLDS = ['failed', 'escalated'];
const MIN_DEPLOY_REASON = 10;
function beginMerge(key, n, head, dep, by, base, epoch = runner.currentEpoch(), reservation = null, deployOverride = '') {
  const at = new Date().toISOString();
  const intent = { key, pr: n, head, base, deploys: !!dep?.deploys, by, at, epoch, token: crypto.randomBytes(6).toString('hex'), reservation,
    workflows: (dep?.workflows || []).map((w) => w.file) };
  store.transaction(() => {
    if (intentGet()) throw Object.assign(new Error('Not merged: another merge is still being confirmed with GitHub.'), { status: 409 });
    if (!reservation || store.reservationOf(key)?.token !== reservation) throw Object.assign(new Error('Not merged: this PR is reserved by another operation.'), { status: 409 });
    if (intent.deploys) {
      const l = lockGet();
      let overrode = null;
      if (l) {
        const reason = String(deployOverride || '').trim();
        const canOverride = by === 'owner' && OVERRIDABLE_HOLDS.includes(l.state);
        if (!canOverride || reason.length < MIN_DEPLOY_REASON) {
          throw Object.assign(new Error(`Not merged: the deploy of ${l.key || short(l.merge_sha)} is ${['running', 'merging'].includes(l.state) ? 'still running; merge after it finishes'
            : `${l.state} — clear the deploy hold after checking it${by === 'owner' ? `, or merge anyway with a reason (at least ${MIN_DEPLOY_REASON} characters)` : ''}`}.`), { status: 409 });
        }
        overrode = { key: l.key || null, state: l.state, note: l.note || null, merge_sha: l.merge_sha || null, reason, by, at, pr: n, for: key };
        store.kvSet('train:deploy-overrides', JSON.stringify([...kvList('train:deploy-overrides'), overrode].slice(-50)));
        intent.overrode = overrode;
      }
      lockSet({ key, pr: n, head, at, intent_at: at, state: 'merging', by, workflows: intent.workflows, merge_sha: null, ...(overrode ? { overrode } : {}) });
    }
    if (by === 'desk') store.updateTicket(key, { review_stage: 'merging' });
    intentSet(intent);
  });
  return intent;
}
function abortMerge(intent) {
  store.transaction(() => {
    if (intent.reservation) store.releaseReservation(intent.key, intent.reservation);
    const l = lockGet();
    if (l && l.key === intent.key && l.state === 'merging' && l.intent_at === intent.at) lockSet(null);
    intentSet(null);
    const t = store.getTicket(intent.key);
    if (t && ['merging', 'merge_unknown'].includes(t.review_stage)) store.updateTicket(t.key, { review_stage: 'approved' });
  });
}
function mergedOk(intent, mergeSha) {
  store.transaction(() => {
    if (intent.deploys) {
      const l = lockGet();
      const entry = { key: intent.key, pr: intent.pr, head: intent.head, at: new Date().toISOString(), state: 'running', merge_sha: mergeSha, workflows: intent.workflows, by: intent.by, ...(intent.overrode ? { overrode: intent.overrode } : {}) };
      // only our own "merging" lock turns into the running deploy; if it was cleared meanwhile, queue the deploy
      if (l && l.state === 'merging' && l.intent_at === intent.at) lockSet({ ...entry, id: l.id });
      else if (!l) lockSet(entry);
      else if (l.merge_sha !== mergeSha) store.kvSet('train:deploy-pending', JSON.stringify([...pendingDeploys(), entry].slice(-50)));
    }
    intentSet(null);
    if (intent.reservation) store.releaseReservation(intent.key, intent.reservation);
  });
}
/** The merge call failed AFTER dispatch: GitHub may have merged. Keep the lock, mark unknown, reconcile later. */
function mergeUnknown(intent, err) {
  store.transaction(() => {
    intentSet({ ...intent, state: 'unknown', failed_at: new Date().toISOString(), error: String(err.message).slice(0, 200) });
    const t = store.getTicket(intent.key);
    if (t?.review_stage === 'merging') store.updateTicket(t.key, { review_stage: 'merge_unknown', progress_msg: 'GitHub did not confirm the merge — checking' });
  });
}
async function dispatch(intent, fn) {
  inFlight.set(intent.at, Date.now());
  try { return await fn(); } finally { inFlight.delete(intent.at); }
}

/** Each cycle (and after a restart): finish an intent GitHub merged, or roll back one GitHub shows open past a grace. */
export async function reconcileIntent(now = new Date()) {
  // A ticket left "merging" without an intent (crash between steps of an older version) goes back to the queue.
  const intent = intentGet();
  for (const t of store.listTickets().filter((x) => ['merging', 'merge_unknown'].includes(x.review_stage) && x.key !== intent?.key)) {
    if (t.status === 'ready_for_human') store.updateTicket(t.key, { review_stage: 'approved' });
  }
  if (!intent) return null;
  if (inFlight.has(intent.at)) return { reconciled: 'in_flight' };
  let pr;
  try { pr = await prs.mergeInfo(intent.pr); } catch { return { reconciled: 'unreachable' }; } // keep everything locked
  if (pr.state === 'MERGED') {
    mergedOk(intent, pr.mergeCommit?.oid || null);
    const t = store.getTicket(intent.key);
    if (t && intent.by === 'desk') {
      say(t, `merged:${intent.head}`, `🔀 **Merged by SigmaDesk** at \`${short(intent.head)}\` after two approvals (confirmed with GitHub after the merge call did not report back).`, intent.head);
      store.updateTicket(t.key, { review_stage: 'merged' });
    }
    return { reconciled: 'merged' };
  }
  const since = Date.parse(intent.failed_at || intent.at);
  const grace = (Number(config.mergeTrain?.unknownGraceMinutes) || 5) * 60_000;
  if (pr.mergeCommit?.oid || now.getTime() - since < grace) return { reconciled: 'waiting' };
  abortMerge(intent);
  return { reconciled: 'rolled_back' };
}

let askedChecks = false;
function askOwnerForChecks() {
  if (askedChecks || store.kvGet('ci:asked') === '1') return;
  askedChecks = true; store.kvSet('ci:asked', '1');
  const hist = kvList('ci:history');
  const t = store.createTicket({ title: 'Confirm which CI checks auto-merge must wait for', type: 'task', status: 'needs_human', priority: 'P1', reporter: 'system', source: 'agent',
    description: `SigmaDesk only auto-merges when every required CI check has reported SUCCESS on the exact commit. It does not know yet which checks are required in this repository, so auto-merge is off.\n\n${hist.length ? `Checks seen on recent merges: ${[...new Set(hist.flat())].join(', ')}.` : 'No merges have been observed yet; merging one PR yourself lets the desk propose the list.'}\n\nSet them with POST /api/ci/required-checks {"names": [...]} or in sigmadesk.config.json → review.requiredChecks.` });
  store.updateTicket(t.key, { resume_status: 'done' });
}

/**
 * Decide one approved ticket. allowMerge=false once this sweep already merged/updated something (serialized train).
 * The ticket reservation is taken synchronously as the very first step and held for the whole decision; an uncertain
 * merge outcome keeps it until reconciliation, a conflict hands it to the resolution job.
 */
export async function consider(t, opts = {}) {
  const r = store.reserve(t.key, 'desk-merge', 'merge train');
  if (!r.ok) return { action: 'busy', reason: `${r.holder.note || r.holder.kind} in progress` };
  try { return await considerHeld(t, { ...opts, reservation: r.token }); }
  finally {
    const i = intentGet();
    if (!(i?.reservation === r.token && i.state === 'unknown')) store.releaseReservation(t.key, r.token, 'desk-merge');
  }
}
async function considerHeld(t, { now = new Date(), snap = null, allowMerge = true, epoch = runner.currentEpoch(), reservation } = {}) {
  const ap = store.approvalsAt(t.key, t.head_sha);
  if (!ap.ok) return { action: 'skip', reason: 'approvals are not at the current commit (or a reviewer contributed code)' };
  const names = `${nameOf(ap.context.seat)} and ${nameOf(ap.independent.seat)}`;
  const wait = (reason, action = 'wait') => { waitMsg(t, names, reason); noteWait(t, action, reason); return { action, reason }; };
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
    if (lock) return wait(lock.state === 'running' || lock.state === 'merging' ? `auto-merge waiting: the deploy of ${lock.key} is still running` : `auto-merge waiting: the last deploy ${lock.state === 'failed' ? 'failed' : 'did not finish'} — clear the deploy hold after checking it`, 'queued');
  }
  // Integration evidence (fail closed): we must have just seen the base, and the head must already contain it, so the
  // CI we read ran on exactly what lands. Base movement after this point is caught by authorizeMerge's live check.
  if (!snap) return wait(`auto-merge waiting: no fresh view of ${config.project.baseBranch}`, 'queued');
  const u = await lazyUpdate(t, snap, { epoch, reservation });
  if (u.action !== 'current') return u.action === 'updated' ? { action: 'updated' } : wait(`auto-merge waiting: ${u.reason || u.action}`, u.action);
  const mt = await mergeTree(snap.base, t.head_sha);
  store.kvSet(`train:evidence:${t.key}`, JSON.stringify({ head: t.head_sha, base: snap.base, tree: mt.tree || null, at: now.toISOString() }));
  const req = prs.requiredChecks();
  if (!req.names.length && !(await prs.repoHasNoWorkflows())) { askOwnerForChecks(); return wait('auto-merge is off until you confirm which CI checks it must wait for', 'owner'); }
  const n = prNumber(t.pr_url);
  let intent;
  try { intent = beginMerge(t.key, n, t.head_sha, dep, 'desk', snap.base, epoch, reservation); }
  catch (err) { return wait(`auto-merge waiting: ${String(err.message).replace(/^Not merged: /, '').replace(/\.$/, '')}`, 'queued'); }
  const am = config.review.autoMerge || {};
  try {
    await dispatch(intent, () => prs.merge(n, { actor: 'desk', method: am.method || 'squash', expectedSha: t.head_sha, inBusyWindow: dep.deploys && inBusyWindow(now),
      halted: store.getSettings().paused === 'true', preflight: (ctx) => authorizeMerge(t.key, intent, ctx) }));
  } catch (err) {
    if (err.dispatched) { mergeUnknown(intent, err); return wait('GitHub did not confirm the merge — checking its state before anything else merges', 'unknown'); }
    abortMerge(intent);
    return wait(`auto-merge waiting: ${String(err.message).replace(/^Not merged: /, '').replace(/\.$/, '')}`, 'queued');
  }
  let mergeSha = null;
  try { mergeSha = (await prs.mergeInfo(n)).mergeCommit?.oid || null; } catch { /* unknown: the lock escalates after deploy.waitMinutes */ }
  mergedOk(intent, mergeSha);
  const text = `🔀 **Merged by SigmaDesk** after approvals from ${nameOf(ap.context.seat)} (${roleOf(ap.context.seat)}) and ${nameOf(ap.independent.seat)} (${roleOf(ap.independent.seat)}) at \`${short(t.head_sha)}\`, on top of \`${config.project.baseBranch}\` \`${short(snap.base)}\`. Low risk, CI green${dep.deploys ? `; ${dep.reason}, so the next deploying merge waits for that deploy to finish` : '; nothing redeploys'}.`;
  say(t, `merged:${t.head_sha}`, text);
  store.updateTicket(t.key, { review_stage: 'merged', progress_msg: `Merged by SigmaDesk after approvals from ${names}` });
  github.flushOutbox();
  return { action: 'merged', merge_sha: mergeSha };
}

/**
 * Owner merges from the UI (desk tickets and PRs the desk did not open) share the deploy lock, the intent journal and
 * reconciliation with desk merges. Non-deploying changes need no market-hours override; deploying ones still do.
 */
export async function ownerMerge(number, opts, now = new Date()) {
  const n = Number(number);
  const t = store.listTickets().find((x) => prNumber(x.pr_url) === n && !TERMINAL.has(x.status));
  // The ticket reservation comes first, synchronously, before any await: no refresh or train update can start
  // between here and the end of this merge (or its reconciliation).
  const key = t?.key || `PR#${n}`;
  const res = store.reserve(key, 'owner-merge', 'owner merge');
  if (!res.ok) throw Object.assign(new Error(`Not merged: this PR is busy (${res.holder.note || res.holder.kind}); wait for it to finish.`), { status: 409 });
  let keep = false;
  try { const out = await ownerMergeHeld(n, t, key, opts, now, res.token); return out; }
  catch (err) { keep = intentGet()?.reservation === res.token && intentGet()?.state === 'unknown'; throw err; }
  finally { if (!keep) store.releaseReservation(key, res.token, 'owner-merge'); }
}
async function ownerMergeHeld(n, t, key, opts, now, reservation) {
  let dep;
  if (t) dep = await deployInfo(t);
  else {
    const files = await prs.prFiles(n).catch(() => null);
    const wfs = await workflowsAtBase().catch(() => null);
    dep = files?.length && wfs ? workflows.deploysFor({ files, branch: config.project.baseBranch, workflows: wfs, registered: config.deploy?.workflows ?? 'auto' })
      : { deploys: true, workflows: [] };
  }
  const busy = !!dep.deploys && inBusyWindow(now);
  if (dep.deploys) await deployLock();
  // The intent is recorded for the whole call even for non-deploying merges: a branch refresh is refused meanwhile.
  const intent = beginMerge(key, n, t?.head_sha || null, dep, 'owner', null, runner.currentEpoch(), reservation, opts.deployOverride);
  try {
    const out = await dispatch(intent, () => prs.merge(n, { ...opts, deployOverride: intent.overrode || null, inBusyWindow: busy, actor: 'owner', preflight: (ctx) => authorizeMerge(key, intent, ctx) }));
    if (intent.overrode) {
      const o = intent.overrode;
      const text = `⚠️ **Deploy hold overridden by the owner** to merge #${n}${key ? ` (${key})` : ''}: the ${o.state} deploy of ${o.key || short(o.merge_sha)} was not verified${o.note ? ` (${o.note})` : ''}.\n**Reason:** ${o.reason}`;
      if (o.key && store.getTicket(o.key)) store.addComment(o.key, 'owner', text);
      store.logEvent({ kind: 'action', agent_id: 'owner', ticket_key: key || o.key, text: `deploy hold overridden: ${o.state} deploy of ${o.key || short(o.merge_sha)} superseded by #${n} — reason: ${o.reason}`.slice(0, 1000) });
    }
    let mergeSha = null;
    try { mergeSha = (await prs.mergeInfo(n)).mergeCommit?.oid || null; } catch { /* the lock escalates later */ }
    mergedOk(intent, mergeSha);
    return out;
  } catch (err) {
    if (err.dispatched) { mergeUnknown(intent, err); throw Object.assign(new Error('GitHub did not confirm the merge; SigmaDesk is checking the PR state before anything else merges.'), { status: 502 }); }
    abortMerge(intent);
    throw err;
  }
}

/** Base moved by something the desk did not merge (owner on GitHub, another tool): if it redeploys, lock or queue it. */
async function observeExternal(prev, next) {
  if (!prev || prev === next) return;
  const r = await pub(['diff', '--name-only', '-z', prev, next]);
  if (r.code) return;
  const files = r.stdout.split('\0').filter(Boolean);
  const wfs = await workflowsAtBase().catch(() => null);
  const d = wfs ? workflows.deploysFor({ files, branch: config.project.baseBranch, workflows: wfs, registered: config.deploy?.workflows ?? 'auto' }) : { deploys: true, workflows: [] };
  if (!d.deploys) return;
  // Our own merge commit is deduplicated (current lock or recently released); everything else is locked or queued.
  if (lockGet()?.merge_sha === next || kvList('train:deploy-released').includes(next)) return;
  const entry = { key: null, by: 'external', merge_sha: next, at: new Date().toISOString(), state: 'running', workflows: d.workflows.map((w) => w.file) };
  const how = queueDeploy(entry);
  if (how !== 'known') store.logEvent({ kind: 'github', agent_id: 'github', text: `${config.project.baseBranch} moved to ${short(next)} outside the desk and it redeploys — ${how === 'locked' ? 'deploying merges wait for that deploy' : 'queued behind the deploy in flight'}` });
}

/**
 * Required checks are learned from PRESENCE on base-branch commits, not success: every check name reported on the
 * last few base commits by a workflow that also runs on pull requests (plus commit-status contexts), whatever its
 * state or conclusion — a suite that failed, was cancelled or is still running is still a suite a PR must pass.
 * Only checks whose workflow is KNOWN to run on pull requests are learned: a check of unknown provenance is skipped
 * for that round, because a wrongly learned name (an issues, schedule or push-only job) can never report on a PR and
 * would block every merge. The set grows; names proven impossible on PRs are pruned (auto mode only); other shrinking
 * is an owner edit. The check → workflow map is kept for per-PR applicability (prs.ciCoverage).
 */
export const LEARN_BASES = 5;
export async function learnFromBase(sha) {
  if (!sha) return null;
  const bases = [...kvList('ci:bases').filter((b) => b !== sha), sha].slice(-LEARN_BASES);
  store.kvSet('ci:bases', JSON.stringify(bases));
  const learned = []; const files = {}; const impossible = new Set(); const possible = new Set(); let unknown = 0;
  for (const b of bases) {
    const seen = await namesOnCommit(b);
    unknown += seen.unknown;
    learned.push(...seen.learn);
    for (const [name, f] of Object.entries(seen.files)) files[name] = [...new Set([...(files[name] || []), ...f])];
    seen.impossible.forEach((n) => impossible.add(n)); seen.learn.forEach((n) => possible.add(n));
  }
  const known = JSON.parse(store.kvGet('ci:check-files') || '{}');
  store.kvSet('ci:check-files', JSON.stringify({ ...known, ...files }));
  prs.learnChecks(learned);
  prs.pruneImpossibleChecks([...impossible].filter((n) => !possible.has(n)));
  store.kvSet('ci:discovery', JSON.stringify({ complete: unknown === 0, unknown, at: new Date().toISOString() }));
  return [...new Set(learned)];
}
async function namesOnCommit(sha) {
  const [{ runs, statuses }, wfRuns, wfs] = await Promise.all([prs.checksForCommit(sha), prs.runsForCommit(sha), workflowsAtBase().catch(() => null)]);
  const out = { learn: [], files: {}, impossible: [], unknown: 0 };
  if (!wfs) return { ...out, unknown: runs.length || 1 }; // the workflow files could not be read: learn nothing, mark incomplete
  const parsed = new Map(wfs.map((w) => [w.file, w.text ? workflows.parseWorkflow(w.text) : null]));
  const suiteFile = new Map(wfRuns.map((r) => [r.suite, r.path]));
  for (const r of runs) {
    const file = suiteFile.get(r.suite);
    const wf = file ? parsed.get(file) : undefined;
    if (!r.name) continue;
    if (!file || !wf) { out.unknown++; continue; } // unknown provenance: never learned, and the round is incomplete
    out.files[r.name] = [...new Set([...(out.files[r.name] || []), file])];
    if (workflows.hasPullRequestTrigger(wf)) out.learn.push(r.name); else out.impossible.push(r.name);
  }
  out.learn.push(...statuses.map((x) => x.context).filter(Boolean)); // external CI reports statuses on PR heads too
  return out;
}

let sweeping = null;
/** Every minute: post PR comments, watch the base (free conflict check), then move the train one step. */
export function sweep({ now = new Date() } = {}) {
  if (!enabled()) return Promise.resolve(null);
  if (sweeping) return sweeping;
  const epoch = runner.currentEpoch();
  sweeping = (async () => {
    await github.flushOutbox();
    let snap = null;
    if (store.getSettings().github_sync === 'true') {
      await reconcileIntent().catch((err) => store.logEvent({ kind: 'error', agent_id: 'github', text: `merge intent check: ${err.message}` }));
      try {
        const prev = store.kvGet('train:base');
        snap = await watchBase();
        if (snap) {
          await observeExternal(prev, snap.base);
          await learnFromBase(snap.base).catch((err) => store.logEvent({ kind: 'github', agent_id: 'github', text: `required-check learning: ${String(err.message).slice(0, 160)}` }));
          await detectConflicts(snap);
        }
      } catch (err) { store.logEvent({ kind: 'github', agent_id: 'github', text: `base watcher: ${String(err.message).slice(0, 200)}` }); snap = null; }
    }
    const results = [];
    // The train is serialized: while the queue front is being brought up to date (QA + re-confirm), nothing behind it
    // merges — otherwise every merge would push it behind again.
    const updating = store.listTickets().find((t) => t.reconfirm_kind === 'rebase' && ['qa', 'review'].includes(t.status) && t.approved_at);
    let moved = !!intentGet();
    for (const t of queue()) {
      if (epoch !== runner.currentEpoch()) break;
      const blocked = moved || (updating && String(updating.approved_at) <= String(t.approved_at));
      const r = await consider(store.getTicket(t.key), { now, snap, allowMerge: !blocked, epoch })
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
  if (!enabled()) return { state: 'owner', reason: 'automatic merging is off' };
  const policy = reviews.autoMergePolicy(t);
  if (!policy.eligible) return { state: 'owner', reason: policy.reason };
  if (t.merge_after && Date.parse(t.merge_after) > now.getTime()) return { state: 'scheduled', at: t.merge_after, label: fmtTime(new Date(t.merge_after)) };
  // A wait that has not moved for hours (a CI gap only the owner can waive, a comment that never posts, a lock nobody
  // clears) is the owner's: the desk says what it is waiting for instead of promising an automatic merge forever.
  let w = null; try { w = JSON.parse(store.kvGet(WAIT_KEY(t.key)) || 'null'); } catch { w = null; }
  if (w?.head === t.head_sha && w.action !== 'scheduled' && now.getTime() - Date.parse(w.since) > ownerAfterHours() * 3600_000)
    return { state: 'owner', reason: `the desk has waited ${Math.round((now.getTime() - Date.parse(w.since)) / 3600_000)} h: ${w.reason}`, stalled: true };
  const q = queue().filter((x) => reviews.autoMergePolicy(x).eligible && !x.merge_hold);
  return { state: 'queued', position: q.findIndex((x) => x.key === t.key) + 1, deploy_lock: lock ? { key: lock.key, state: lock.state } : null };
}
export const conflictJobsView = (key) => store.conflictJobsFor(key).map((j) => ({ id: j.id, status: j.status, seat: j.seat, name: nameOf(j.seat), base: j.base_sha, head: j.head_sha,
  files: JSON.parse(j.files_json || '[]').map((f) => ({ path: f.path, kind: f.kind })), incoming: JSON.parse(j.incoming_json || '[]'), attempts: j.attempts, result: j.result_sha, note: j.note, at: j.updated_at }));
export const deployState = () => lockGet();
