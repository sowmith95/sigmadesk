import * as productReview from './product-review.js';
// PR console: every PR the desk opened, with live GitHub state, and the owner's actions on them
// (approve, ready, merge, close, reviewers, tags). Agents never reach this module: it is called only from owner
// routes on the TCP listener. Merging the base branch may deploy production, so merges are guarded.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import * as store from './db.js';
import { agentById } from './team.js';
import * as refresh from './refresh.js';
import * as workflowsLib from './workflows.js';

const pexec = promisify(execFile);
const repo = () => config.project.githubRepo;
const SYSTEM_LABEL = (name) => name === config.github.label || /^(status|agent):/.test(name) || name === 'owner-approved';
export const TAG_PREFIX = 'tag:';

async function gh(args) {
  const { stdout } = await pexec(config.bins.gh, args, { cwd: config.project.repoPath, timeout: 90_000, maxBuffer: 32 << 20 });
  return stdout.trim();
}
function fail(msg, status = 409) { throw Object.assign(new Error(msg), { status }); }

const FIELDS = ['number', 'title', 'state', 'isDraft', 'url', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
  'headRefName', 'labels', 'reviewDecision', 'reviewRequests', 'latestReviews', 'mergeable', 'statusCheckRollup',
  'additions', 'deletions', 'changedFiles', 'headRefOid', 'baseRefName', 'baseRefOid'].join(',');

export function checksState(rollup = []) {
  if (!rollup.length) return 'none';
  const v = rollup.map((c) => c.conclusion || c.state || c.status);
  if (v.some((x) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(x))) return 'failing';
  if (v.some((x) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', ''].includes(x) || x == null)) return 'pending';
  return 'passing';
}

// Desk PRs carry "[KEY] title" and a SigmaDesk footer; that is how we find them, including ones later detached
// from a ticket (rework clears pr_url).
let cache = { at: 0, rows: [] };
export async function listPrs({ refresh = false } = {}) {
  if (!refresh && Date.now() - cache.at < 30_000) return cache.rows;
  const raw = JSON.parse(await gh(['pr', 'list', '-R', repo(), '--state', 'all', '--limit', '200', '--search', 'SigmaDesk in:body', '--json', FIELDS]));
  const readAt = new Date().toISOString(); // when THIS response was read: cached rows keep it, with the base it reported
  const tickets = Object.fromEntries(store.listTickets().map((t) => [t.key, t]));
  const rows = raw.map((p) => {
    const key = p.title.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1] || null;
    const t = key ? tickets[key] : null;
    const labels = (p.labels || []).map((l) => l.name);
    const ownerApproved = labels.includes('owner-approved') || (p.latestReviews || []).some((r) => r.state === 'APPROVED');
    return {
      number: p.number, url: p.url, title: p.title.replace(/^\[[^\]]+\]\s*/, ''), key, ticket_status: t?.status || null,
      seat: t?.assignee || null, requester: t?.reporter || null, epic: t?.parent_key || null, area: t?.area || null, complexity: t?.complexity || null,
      state: p.state, draft: p.isDraft, merged_at: p.mergedAt, closed_at: p.closedAt, created_at: p.createdAt, updated_at: p.updatedAt,
      author: p.author?.login, branch: p.headRefName, mergeable: p.mergeable, review: p.reviewDecision || null, owner_approved: ownerApproved,
      reviewers: (p.reviewRequests || []).map((r) => r.login || r.name || r.slug).filter(Boolean),
      reviews: (p.latestReviews || []).map((r) => ({ who: r.author?.login, state: r.state })),
      checks: checksState(p.statusCheckRollup || []), rollup: (p.statusCheckRollup || []).map((c) => ({ name: checkName(c), conclusion: c.conclusion || c.state || c.status || '' })), additions: p.additions, deletions: p.deletions, files: p.changedFiles,
      tags: labels.filter((l) => l.startsWith(TAG_PREFIX)).map((l) => l.slice(TAG_PREFIX.length)),
      labels: labels.filter((l) => !SYSTEM_LABEL(l) && !l.startsWith(TAG_PREFIX)),
      head_sha: p.headRefOid || null, base: p.baseRefName || null, base_sha: p.baseRefOid || null, read_at: readAt, desk_review: t ? deskReview(t, p.headRefOid) : null,
    };
  });
  cache = { at: Date.now(), rows };
  return rows;
}

async function pr(number) {
  const n = Number(number);
  if (!Number.isInteger(n) || n <= 0) fail('bad PR number', 400);
  const p = JSON.parse(await gh(['pr', 'view', String(n), '-R', repo(), '--json', `${FIELDS},body`]));
  if (!/SigmaDesk/.test(p.body || '')) fail('not a SigmaDesk PR', 403); // the console only acts on the desk's own PRs
  return p;
}
const bust = () => { cache.at = 0; };
/** When the PR list was last read from GitHub (ms; 0 = never). */
export const listedAt = () => cache.at;
export async function assertRefreshable(number, ticket) {
  const p = await pr(number);
  if (p.state !== 'OPEN' || p.headRefName !== ticket.branch) fail('Refresh requires this ticket’s open PR branch');
  if (p.baseRefName !== config.project.baseBranch) fail('Merge the predecessor first: this stacked PR targets a different base');
}
const note = (p, text) => {
  const key = p.title.match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1];
  if (key && store.getTicket(key)) store.addComment(key, 'owner', text);
  store.logEvent({ kind: 'github', agent_id: 'owner', ticket_key: key || null, text: text.replace(/\*\*/g, '').slice(0, 200) });
};

/** Approve on GitHub. GitHub refuses self-approval (desk PRs are opened with the owner's account), so fall back to
 * an approval comment + the `owner-approved` label, and say which one happened. */
export async function approve(number, message = '') {
  const p = await pr(number);
  if (p.state !== 'OPEN') fail(`PR #${p.number} is ${p.state.toLowerCase()}`);
  let mode = 'review';
  try {
    await gh(['pr', 'review', String(p.number), '-R', repo(), '--approve', '--body', store.sanitizeForGithub(message || 'Approved by the owner via SigmaDesk.')]);
  } catch (err) {
    if (!/own pull request|Can not approve/i.test(String(err.stderr || err.message))) throw err;
    mode = 'label';
    await gh(['label', 'create', 'owner-approved', '--color', '0e8a16', '--description', 'Approved by the owner in SigmaDesk', '--force', '-R', repo()]);
    await gh(['pr', 'edit', String(p.number), '-R', repo(), '--add-label', 'owner-approved']);
    await gh(['pr', 'comment', String(p.number), '-R', repo(), '--body', store.sanitizeForGithub(`✅ **Approved by the owner** (via SigmaDesk).${message ? `\n\n${message}` : ''}\n\n_GitHub does not allow approving your own PR, so this approval is recorded as a comment and the \`owner-approved\` label._`)]);
  }
  note(p, `👍 **Approved on GitHub** (#${p.number}, ${mode === 'review' ? 'review approval' : 'comment + owner-approved label — GitHub blocks self-approval'})`);
  bust();
  return { number: p.number, mode };
}

export async function ready(number) {
  const p = await pr(number);
  if (!p.isDraft) return { number: p.number, already: true };
  await gh(['pr', 'ready', String(p.number), '-R', repo()]);
  note(p, `📤 Marked #${p.number} ready for review.`);
  bust();
  return { number: p.number };
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'];
export const OVERRIDE_PHRASE = 'merge during market hours';

/** Preconditions for merging, pure so they are testable. */
export function mergeBlockers(p, { inBusyWindow = false, override = '' } = {}) {
  const out = [];
  if (p.state !== 'OPEN') out.push(`PR is ${String(p.state).toLowerCase()}`);
  if (p.mergeable === 'CONFLICTING') out.push('it conflicts with the base branch — rebase first');
  const checks = checksState(p.statusCheckRollup || []);
  if (checks === 'failing') out.push('CI is failing');
  if (checks === 'pending') out.push('CI is still running');
  if (inBusyWindow && String(override).trim().toLowerCase() !== OVERRIDE_PHRASE) {
    out.push(`merging ${config.project.baseBranch} deploys production and the desk is inside its busy window (market hours) — type "${OVERRIDE_PHRASE}" to override`);
  }
  return out;
}

// ---------------- merge authorization (owner UI merges and desk auto-merges share it) ----------------
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const PENDING = ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING', 'REQUESTED', 'COMPLETED', ''];
/**
 * Strict CI verdict: EVERY check must report SUCCESS. Only checks named in review.optionalChecks may be SKIPPED or
 * NEUTRAL instead. Nothing reported = none.
 */
export function ciVerdict(rollup = [], optional = config.review?.optionalChecks || []) {
  if (!rollup.length) return 'none';
  const opt = new Set(optional);
  const rows = rollup.map((c) => ({ name: c.name || c.context || c.workflowName || '', v: c.conclusion || c.state || c.status || '' }));
  if (rows.some((r) => FAILED.includes(r.v))) return 'failing';
  if (rows.some((r) => PENDING.includes(r.v))) return 'pending';
  if (rows.every((r) => r.v === 'SUCCESS' || (opt.has(r.name) && ['SKIPPED', 'NEUTRAL'].includes(r.v)))) return 'passing';
  return 'inconclusive';
}
export const MIN_OVERRIDE_REASON = 10;
const checkName = (c) => c.name || c.context || c.workflowName || '';

// ---------------- required checks: names that MUST be present and SUCCESS ----------------
// review.requiredChecks: an explicit list, or "auto": learned from the BASE branch's own commits — the union of
// pull-request checks that passed on recent main commits (persisted, owner-editable). The learned set only grows;
// shrinking it needs the owner. Owner merges never teach it (a lint-only merge must not define "required").
// Reported-only CI is not enough: a suite that never reports would otherwise let lint alone authorize a merge.
const kvJson = (k, d) => { try { return JSON.parse(store.kvGet(k) || 'null') ?? d; } catch { return d; } };
export function requiredChecks() {
  const c = config.review?.requiredChecks;
  if (Array.isArray(c)) return { names: c.map(String), source: 'config' };
  return kvJson('ci:required', { names: [], source: 'auto' });
}
export function setRequiredChecks(names, source = 'owner') {
  const clean = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 50);
  store.kvSet('ci:required', JSON.stringify({ names: clean, source, at: store.now() }));
  store.logEvent({ kind: 'action', agent_id: source === 'owner' ? 'owner' : 'github', text: `required CI checks set (${source}): ${clean.join(', ') || '(none)'}` });
  return requiredChecks();
}
/** Auto mode: add check names that passed on a base-branch commit. Growth only — never removes a name. */
export function learnChecks(names = []) {
  const ok = [...new Set(names.map(String).filter(Boolean))];
  if (!ok.length) return requiredChecks();
  store.kvSet('ci:history', JSON.stringify([...kvJson('ci:history', []), ok].slice(-20)));
  const cur = requiredChecks();
  if (cur.source !== 'auto') return cur; // explicit (config/owner) lists are never changed automatically
  const grown = [...new Set([...cur.names, ...ok])];
  if (grown.length !== cur.names.length) setRequiredChecks(grown, 'auto');
  return requiredChecks();
}
/** Auto mode: drop names that only ever came from workflows with no pull-request trigger (they can never report on a PR). */
export function pruneImpossibleChecks(names = []) {
  const cur = requiredChecks();
  if (cur.source !== 'auto' || !names.length) return cur;
  const gone = cur.names.filter((n) => names.includes(n));
  if (!gone.length) return cur;
  setRequiredChecks(cur.names.filter((n) => !gone.includes(n)), 'auto');
  store.logEvent({ kind: 'github', agent_id: 'github', text: `removed required check${gone.length > 1 ? 's' : ''} ${gone.join(', ')}: ${gone.length > 1 ? 'their workflows never run' : 'its workflow never runs'} on pull requests` });
  return requiredChecks();
}

/**
 * Which required checks apply to this PR, and where each stands on its head commit.
 * checkFiles: { check name → workflow files } (learned); workflows: [{ file, text }] at the base; files: the PR's paths.
 * A check whose every known workflow would not start for these files (pull_request paths/branches) is not required for
 * this PR. Unknown provenance stays required. `uncovered` = nothing applies and nothing reported: no CI looked at it.
 */
export function ciCoverage({ required = [], rollup = [], files = [], workflows: wfs = null, checkFiles = {}, base = config.project.baseBranch } = {}) {
  const parsed = new Map((wfs || []).map((w) => [w.file, w.text ? workflowsLib.parseWorkflow(w.text) : null]));
  const reported = new Map(rollup.map((c) => [checkName(c), c.conclusion || c.state || c.status || '']));
  const rows = required.map((name) => {
    const fs = checkFiles[name] || [];
    const known = fs.length && fs.every((f) => parsed.get(f));
    const applies = !known || !files.length || fs.some((f) => workflowsLib.pullRequestTriggers(parsed.get(f), base, files));
    const v = reported.get(name);
    const state = v === 'SUCCESS' ? 'passed' : FAILED.includes(v) ? 'failed' : v && v !== 'SKIPPED' && v !== 'NEUTRAL' ? 'running' : !applies ? 'not_run_for_files' : v ? 'skipped' : 'waiting';
    const wf = fs.map((f) => { const w = parsed.get(f); return { file: f, name: w?.name || f.split('/').pop(), paths: pathsOf(w) }; });
    return { name, state, applies, workflows: wf };
  });
  const applicable = rows.filter((r) => r.applies).map((r) => r.name);
  // Uncovered only when we can see every workflow and none of them starts for these files, no required check applies,
  // and nothing reported. "Nothing reported yet" on its own may just mean CI has not started.
  const fires = (wfs || []).filter((w) => workflowsLib.pullRequestTriggers(parsed.get(w.file), base, files)).map((w) => parsed.get(w.file)?.name || w.file);
  const readable = !!wfs && wfs.every((w) => parsed.get(w.file));
  const uncovered = readable && files.length > 0 && !fires.length && !applicable.length && !rollup.length;
  // A validation gap: every required check is known NOT to run for these files (or nothing is required and no workflow
  // starts). Unrelated green checks (a labeler, an external status) never close it: they did not test these files.
  const gap = (rows.length > 0 && rows.every((r) => r.state === 'not_run_for_files')) || (uncovered && !required.length);
  return { rows, applicable, firing: fires, uncovered, gap, areas: [...new Set(files.map((f) => f.split('/')[0]))] };
}
const pathsOf = (wf) => {
  const pr = wf?.on?.pull_request ?? wf?.on?.pull_request_target;
  return pr && typeof pr === 'object' && Array.isArray(pr.paths) ? pr.paths.filter((p) => !String(p).startsWith('!')) : null;
};

/** Check runs (with their check suite) and commit statuses GitHub recorded for a commit. */
export async function checksForCommit(sha) {
  const runs = JSON.parse(await gh(['api', `repos/${repo()}/commits/${encodeURIComponent(String(sha))}/check-runs?per_page=100`,
    '--jq', '[.check_runs[] | {name, status, conclusion, suite: .check_suite.id}]']) || '[]');
  const statuses = JSON.parse(await gh(['api', `repos/${repo()}/commits/${encodeURIComponent(String(sha))}/status`,
    '--jq', '[.statuses[] | {context, state}]']) || '[]');
  return { runs, statuses };
}
export const keyOfTitle = (title) => String(title || '').match(/^\[([A-Z][A-Z0-9]*-\d+)\]/)?.[1] || null;
const seatName = (seat) => (seat ? `${agentById[seat]?.name || seat}` : '?');

/**
 * Every precondition for merging, pure so it is testable. Returns { blockers, overridden }.
 * gate (only for tickets that went through two-reviewer review): { approvals: store.approvalsAt(key, expectedSha), qaSha }.
 * An owner may bypass the review-chain blockers (approvals, their publication, QA commit) with an audited reason;
 * nothing bypasses state, head commit, base branch, conflicts or CI.
 */
export function authorizeMerge(p, { expectedSha = '', inBusyWindow = false, override = '', actor = 'owner', halted = false, gate = null,
  overrideReason = '', noChecksConfigured = false, baseBranch = config.project.baseBranch, required = [], ciGap = null, ciAckReason = '' } = {}) {
  // codes: the same predicates as stable ids, in order (the decision brief reads them; the strings stay for people).
  const blockers = []; const chain = []; const codes = [];
  const block = (code, msg) => { blockers.push(msg); codes.push(code); };
  if (p.state !== 'OPEN') block('pr_state', `PR is ${String(p.state).toLowerCase()}`);
  if (!/^[0-9a-f]{7,40}$/.test(String(expectedSha))) block('no_sha', 'the request did not say which commit it approves (expected head SHA)');
  else if (p.headRefOid !== expectedSha) block('head_moved', `the PR head moved (${String(p.headRefOid).slice(0, 7)} ≠ approved ${String(expectedSha).slice(0, 7)}) — reload and re-check`);
  if (p.baseRefName !== baseBranch) block('base', `the PR targets \`${p.baseRefName || 'unknown'}\`, not \`${baseBranch}\` — merge its base first`);
  if (p.mergeable === 'CONFLICTING') block('conflict', 'it conflicts with the base branch — rebase first');
  else if (p.mergeable !== 'MERGEABLE') block('mergeable_unknown', 'GitHub has not finished checking mergeability — try again in a minute');
  const ci = ciVerdict(p.statusCheckRollup || []);
  if (ci === 'failing') block('ci_failing', 'CI is failing');
  else if (ci === 'pending') block('ci_pending', 'CI is still running');
  else if (ci === 'inconclusive') block('ci_inconclusive', 'a CI check was skipped or neutral instead of passing (only review.optionalChecks may skip)');
  else if (ci === 'none' && !noChecksConfigured && !ciGap) block('ci_none', 'no CI result has been reported for this commit yet');
  // No required check runs for the files this PR changes: waiting would block forever. The owner may acknowledge the gap
  // with its own reason (posted on the PR). It is separate from the review override: it never skips QA or approvals,
  // and the desk's auto-merge can never acknowledge it.
  const acknowledged = [];
  if (ciGap) {
    const gapMsg = `no required CI check runs for the files this PR changes (${ciGap.areas.join(', ') || 'these paths'}), so nothing tested it automatically`;
    if (actor === 'owner' && String(ciAckReason || '').trim().length >= MIN_OVERRIDE_REASON) acknowledged.push(gapMsg);
    else block('ci_gap', actor === 'owner' ? `${gapMsg} — acknowledge the CI gap with a reason (at least ${MIN_OVERRIDE_REASON} characters)` : gapMsg);
  }
  const reported = new Map((p.statusCheckRollup || []).map((c) => [checkName(c), c.conclusion || c.state || c.status || '']));
  const missing = required.filter((n) => reported.get(n) !== 'SUCCESS');
  if (missing.length) block('required_missing', `required check${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} not passed on this commit${missing.some((n) => !reported.has(n)) ? ' (never reported)' : ''}`);
  if (inBusyWindow && (actor !== 'owner' || String(override).trim().toLowerCase() !== OVERRIDE_PHRASE)) {
    block('busy_window', actor === 'owner' ? `merging ${baseBranch} deploys production and the desk is inside its busy window (market hours) — type "${OVERRIDE_PHRASE}" to override` : 'inside the busy window (market hours)');
  }
  if (actor !== 'owner' && halted) block('halted', 'the desk is paused');
  if (gate) {
    const a = gate.approvals || {};
    if (!a.ok) {
      const have = [a.context && `${seatName(a.context.seat)}: ${a.context.verdict}`, a.independent && `${seatName(a.independent.seat)}: ${a.independent.verdict}`].filter(Boolean).join(', ');
      codes.push('approvals'); chain.push(`it needs two reviewer approvals at this commit (have: ${have || 'none'})`);
    } else if (a.unpublished) { codes.push('unpublished'); chain.push('the review comments are not on the PR yet'); }
    if (!gate.qaSha || gate.qaSha !== expectedSha) { codes.push('qa'); chain.push(gate.qaSha ? `QA passed a different commit (${String(gate.qaSha).slice(0, 7)})` : 'QA has not passed this commit'); }
  }
  const reason = String(overrideReason || '').trim();
  if (chain.length && actor === 'owner' && reason.length >= MIN_OVERRIDE_REASON) return { blockers, overridden: chain, acknowledged, codes };
  if (chain.length && actor === 'owner') chain[chain.length - 1] += ` — or give an owner override reason (at least ${MIN_OVERRIDE_REASON} characters)`;
  return { blockers: [...blockers, ...chain], overridden: [], acknowledged, codes };
}

// "No checks at all" is a pass only when the repository has no Actions workflows (review.ci = "auto").
let workflowCache = { at: 0, none: false };
export async function repoHasNoWorkflows() {
  if (config.review?.ci === 'required') return false;
  if (Date.now() - workflowCache.at < 10 * 60_000) return workflowCache.none;
  try {
    const n = Number(await gh(['api', `repos/${repo()}/actions/workflows`, '--jq', '.total_count']));
    workflowCache = { at: Date.now(), none: n === 0 };
  } catch { workflowCache = { at: Date.now(), none: false }; }
  return workflowCache.none;
}

/** Review state for a desk PR row (the DB is authoritative; GitHub only mirrors it). */
export function deskReview(t, headSha) {
  if (!store.inReviewFlow(t.key)) return { required: false };
  const a = store.approvalsAt(t.key, headSha || t.head_sha);
  const r = (row) => (row ? { seat: row.seat, name: seatName(row.seat), role: row.role, verdict: row.verdict, sha: row.sha, round: row.round } : null);
  return { required: true, approvals_ok: a.ok, unpublished: a.unpublished, context: r(a.context), independent: r(a.independent),
    stage: t.review_stage || null, round: t.review_round || 0, risk: t.risk || null, diff_risk: t.diff_risk || null };
}

/** Coverage for a live PR: its changed files against the base's workflows and the learned check → workflow map. */
export async function coverageFor(p) {
  const [rawFiles, rawWfs] = await Promise.all([prFiles(p.number).catch(() => []), import('./mergetrain.js').then((m) => m.workflowsAtBase()).catch(() => null)]);
  const files = Array.isArray(rawFiles) ? rawFiles.map(String) : [];
  const wfs = Array.isArray(rawWfs) ? rawWfs : null;
  let checkFiles = {};
  try { checkFiles = JSON.parse(store.kvGet('ci:check-files') || '{}'); } catch { checkFiles = {}; }
  return { ...ciCoverage({ required: requiredChecks().names, rollup: p.statusCheckRollup || [], files, workflows: wfs, checkFiles }), files };
}
/**
 * Dry run of the merge gate for the PR panel: what blocks (hard), what the owner may override with a reason, and every
 * required check's state on the head commit. Nothing is merged. The real merge re-checks everything.
 */
export async function mergeCheck(number, { inBusyWindow = false, halted = false } = {}) {
  const p = await pr(number);
  const key = keyOfTitle(p.title);
  const t = key ? store.getTicket(key) : null;
  const gate = t && store.inReviewFlow(t.key) ? { approvals: store.approvalsAt(t.key, p.headRefOid), qaSha: t.qa_sha } : null;
  const noWorkflows = await repoHasNoWorkflows();
  const cov = await coverageFor(p);
  const common = { expectedSha: p.headRefOid, inBusyWindow, actor: 'owner', halted, gate, required: cov.applicable, ciGap: cov.gap ? cov : null,
    noChecksConfigured: (p.statusCheckRollup || []).length === 0 && noWorkflows };
  // With a reason and the market-hours phrase supplied, what remains is what nothing can override.
  const probe = authorizeMerge(p, { ...common, overrideReason: 'x'.repeat(MIN_OVERRIDE_REASON), ciAckReason: 'x'.repeat(MIN_OVERRIDE_REASON), override: OVERRIDE_PHRASE });
  // The deploy hold (merge train): a deploying merge waits for the previous deploy; a failed or unconfirmed one can be
  // passed with the owner's reason, a running one cannot.
  const train = await import('./mergetrain.js');
  // Ask GitHub, not the stored lock: a deploy that finished since the last check releases here (Recheck shows it).
  // GitHub slow (or a DB hiccup): after 10 s use the stored lock; the PR sync loop finishes the refresh meanwhile.
  let timer;
  const lock = await Promise.race([train.deployLock(), new Promise((r) => { timer = setTimeout(() => r(train.deployState()), 10_000); })])
    .catch(() => train.deployState()).finally(() => clearTimeout(timer));
  let deploy_hold = null;
  if (lock && !(lock.key && lock.key === key && lock.state === 'merging')) {
    let deploys = true;
    try { const wfs = await train.workflowsAtBase(); if (wfs && cov.files.length) deploys = workflowsLib.deploysFor({ files: cov.files, branch: config.project.baseBranch, workflows: wfs, registered: config.deploy?.workflows ?? 'auto' }).deploys; } catch { deploys = true; }
    if (deploys) deploy_hold = { key: lock.key || null, state: lock.state, note: lock.note || null, merge_sha: lock.merge_sha || null, overridable: train.OVERRIDABLE_HOLDS.includes(lock.state),
      runs_url: lock.merge_sha && config.project.githubRepo ? `https://github.com/${config.project.githubRepo}/commit/${lock.merge_sha}/checks` : null };
  }
  if (deploy_hold && !deploy_hold.overridable) probe.blockers.push(`the deploy of ${deploy_hold.key || String(deploy_hold.merge_sha || '').slice(0, 7)} is still running; merge after it finishes`);
  // The desk holds a newer commit than the PR has (for example a review fix QA passed, kept back by the publish guard):
  // merging now would ship the older code. Not overridable: publish it first, then the reviewers re-check it.
  let unpublished = null;
  // Only while a publish of the desk's newer commit to THIS PR is actually pending: parked by the guard, or QA passed
  // and on its way. A failed QA, a closed ticket or another PR fall through to the ordinary checks.
  const guarded = !!t?.head_sha && store.kvGet(`guard:${t.key}`) === t.head_sha;
  const onItsWay = !!t?.head_sha && t.qa_sha === t.head_sha && ['ready_for_human', 'review', 'needs_human'].includes(t.status);
  if (t?.head_sha && t.pr_url && Number(String(t.pr_url).match(/\/pull\/(\d+)/)?.[1]) === p.number && t.head_sha !== p.headRefOid
    && store.kvGet(`published:${t.key}`) !== t.head_sha && (guarded || onItsWay)) {
    unpublished = { key: t.key, head: t.head_sha, pr_head: p.headRefOid, qa_passed: t.qa_sha === t.head_sha, guard: guarded, updated_at: t.updated_at };
    probe.blockers.unshift(`a newer commit (${t.head_sha.slice(0, 7)})${unpublished.qa_passed ? ' that QA passed' : ''} is not on this PR yet; ${unpublished.guard ? 'approve publishing it' : 'it is published automatically'}, then the reviewers re-check it`);
  }
  return { number: p.number, head: p.headRefOid, blockers: probe.blockers, overridable: unpublished ? [] : probe.overridden, ci_gap: unpublished ? [] : probe.acknowledged, busy_window: inBusyWindow, deploy_hold, unpublished,
    ready: !probe.blockers.length && !probe.overridden.length && !probe.acknowledged.length && !deploy_hold,
    coverage: { rows: cov.rows, uncovered: cov.uncovered, gap: cov.gap, firing: cov.firing, areas: cov.areas, files: cov.files.length } };
}
export async function merge(number, { method = 'squash', override = '', inBusyWindow = false, expectedSha = '', overrideReason = '', ciAckReason = '', deployOverride = null, actor = 'owner', halted = false, preflight = null } = {}) {
  if (!MERGE_METHODS.includes(method)) fail(`method must be ${MERGE_METHODS.join('|')}`, 400);
  const p = await pr(number);
  const key = keyOfTitle(p.title);
  const t = key ? store.getTicket(key) : null;
  const gate = t && store.inReviewFlow(t.key) ? { approvals: store.approvalsAt(t.key, expectedSha), qaSha: t.qa_sha } : null;
  if (actor !== 'owner' && !gate) fail('Not merged: the desk only merges PRs that passed two-reviewer review.');
  const noWorkflows = await repoHasNoWorkflows();
  const noChecksConfigured = (p.statusCheckRollup || []).length === 0 && noWorkflows;
  const req = requiredChecks();
  if (actor !== 'owner' && !req.names.length && !noWorkflows) fail('Not merged: nobody has confirmed which CI checks a merge must wait for (review.requiredChecks) — the owner merges until then.');
  // A partial learning round (a check whose workflow could not be identified) must not let the desk merge on a list that
  // may be missing a suite: until a complete round, only the owner merges.
  if (actor !== 'owner') { let disc = {}; try { disc = JSON.parse(store.kvGet('ci:discovery') || '{}'); } catch { disc = {}; } if (disc.complete === false) fail('Not merged: the desk could not identify every CI check on the base branch in its last look; the owner merges until it can.'); }
  const cov = await coverageFor(p);
  const auth = authorizeMerge(p, { expectedSha, inBusyWindow, override, actor, halted, gate, overrideReason, ciAckReason, noChecksConfigured, required: cov.applicable, ciGap: cov.gap ? cov : null });
  const { overridden, acknowledged = [] } = auth;
  const blockers = [...auth.blockers];
  // Product/design feedback and owner-triggered branch refresh gates (main): they add blockers, never remove any.
  if (key) {
    const ticket = t;
    const plan = ticket && productReview.current(ticket.parent_key || key);
    if (plan || productReview.current(key, 'feedback')) {
      const feedback = productReview.current(key, 'feedback');
      if (productReview.blocks(ticket) || !feedback || feedback.stale || feedback.status !== 'approved' || ticket.head_sha !== p.headRefOid) blockers.push('product/design or user feedback approval is missing or stale for this commit');
    }
  }
  if (key && refresh.current(key)) {
    if (p.baseRefName !== config.project.baseBranch) blockers.push('PR base changed since refreshed QA');
    // GraphQL baseRefOid may describe the PR's original base. Read the live branch ref.
    const base = JSON.parse(await gh(['api', `repos/${repo()}/git/ref/heads/${config.project.baseBranch}`])).object.sha;
    blockers.push(...refresh.validationBlockers(key, p.headRefOid, base));
    if (refresh.current(key).status !== 'published') blockers.push('the rebased branch has not been published after QA');
  }
  if (blockers.length) fail(`Not merged: ${blockers.join('; ')}.`);
  if (p.isDraft) await gh(['pr', 'ready', String(p.number), '-R', repo()]);
  if (overridden.length) {
    // Audit first: the reason is on the PR even if the merge call then fails.
    await gh(['pr', 'comment', String(p.number), '-R', repo(), '--body', store.sanitizeForGithub(`⚠️ **The owner is merging without the full SigmaDesk review**\n\nSkipped: ${overridden.join('; ')}.\n**Owner's reason:** ${String(overrideReason).trim()}`)]);
    store.logEvent({ kind: 'action', agent_id: 'owner', ticket_key: key, text: `merge override on #${p.number}: ${overridden.join('; ')} — reason: ${String(overrideReason).trim()}`.slice(0, 1000) });
  }
  // The live gate (halt/stop-all fence, Hold, risk, window, deploy lock, base freshness) runs last, right before dispatch.
  if (acknowledged.length) {
    await gh(['pr', 'comment', String(p.number), '-R', repo(), '--body', store.sanitizeForGithub(`⚠️ **The owner is merging without CI on these files**\n\n${acknowledged.join('; ')}.\n**Owner's reason:** ${String(ciAckReason).trim()}`)]);
    store.logEvent({ kind: 'action', agent_id: 'owner', ticket_key: key, text: `merged #${p.number} without CI coverage: ${acknowledged.join('; ')} — reason: ${String(ciAckReason).trim()}`.slice(0, 1000) });
  }
  if (deployOverride) {
    await gh(['pr', 'comment', String(p.number), '-R', repo(), '--body', store.sanitizeForGithub(`⚠️ **The owner is merging while the previous deploy is unverified**\n\nThe ${deployOverride.state} deploy of ${deployOverride.key || String(deployOverride.merge_sha || '').slice(0, 7)} was not confirmed${deployOverride.note ? ` (${deployOverride.note})` : ''}.\n**Owner's reason:** ${deployOverride.reason}`)]);
  }
  if (preflight) await preflight({ overridden, expectedSha }); // only review overrides relax the final QA/approval recheck
  // --match-head-commit: GitHub merges exactly the approved commit, or refuses if it moved. From here on a failure is
  // "unknown" (GitHub may have merged before the error/timeout reached us): callers must reconcile, never roll back.
  try { await gh(['pr', 'merge', String(p.number), '-R', repo(), `--${method}`, '--delete-branch', '--match-head-commit', expectedSha]); }
  catch (err) { throw Object.assign(err, { dispatched: true }); }
  if (actor === 'owner') note(p, `🔀 **Merged #${p.number}** (${method}) from SigmaDesk${inBusyWindow ? ' — market-hours override' : ''}${overridden.length ? ` — review override: ${String(overrideReason).trim()}` : ''}.`);
  else store.logEvent({ kind: 'github', agent_id: 'github', ticket_key: key, text: `auto-merged #${p.number} (${method}) at ${expectedSha.slice(0, 7)}` });
  bust();
  return { number: p.number, method, overridden, acknowledged };
}

/** {state, mergeCommit:{oid}} of a PR (the merge commit a merged PR produced on the base branch). */
export async function mergeInfo(number) {
  return JSON.parse(await gh(['pr', 'view', String(Number(number)), '-R', repo(), '--json', 'mergeCommit,state']) || '{}');
}
/** Workflow runs GitHub started for a commit, identified by workflow FILE path (display names can collide). */
export async function runsForCommit(sha) {
  const out = JSON.parse(await gh(['api', `repos/${repo()}/actions/runs?head_sha=${encodeURIComponent(String(sha))}&per_page=100`,
    '--jq', '[.workflow_runs[] | {path, name, status, conclusion, id, suite: .check_suite_id}]']) || '[]');
  return out.map((r) => ({ ...r, path: String(r.path || '').replace(/@.*$/, '') }));
}
/** Paths a PR changes (for owner merges of PRs the desk did not open). */
export async function prFiles(number) {
  return JSON.parse(await gh(['pr', 'view', String(Number(number)), '-R', repo(), '--json', 'files', '--jq', '[.files[].path]']) || '[]');
}

export async function close(number, comment = '') {
  const p = await pr(number);
  if (p.state !== 'OPEN') fail(`PR #${p.number} is already ${p.state.toLowerCase()}`);
  await gh(['pr', 'close', String(p.number), '-R', repo(), ...(comment ? ['--comment', store.sanitizeForGithub(comment)] : [])]);
  note(p, `🚫 Closed #${p.number} from SigmaDesk${comment ? `: ${comment}` : ''}.`);
  bust();
  return { number: p.number };
}

export async function addReviewer(number, login) {
  if (!/^[A-Za-z0-9-]{1,39}(\/[A-Za-z0-9._-]+)?$/.test(String(login))) fail('reviewer must be a GitHub login or org/team', 400);
  const p = await pr(number);
  await gh(['pr', 'edit', String(p.number), '-R', repo(), '--add-reviewer', login]);
  note(p, `👥 Requested a review from @${login} on #${p.number}.`);
  bust();
  return { number: p.number, reviewer: login };
}

export async function setTags(number, { add = [], remove = [] } = {}) {
  const clean = (xs) => [...new Set(xs.map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9][a-z0-9 ._-]{0,40}$/.test(x)))];
  const a = clean(add); const r = clean(remove);
  if (!a.length && !r.length) fail('no valid tags', 400);
  const p = await pr(number);
  for (const t of a) await gh(['label', 'create', `${TAG_PREFIX}${t}`, '--color', 'bfdadc', '--description', 'SigmaDesk tag', '--force', '-R', repo()]);
  await gh(['pr', 'edit', String(p.number), '-R', repo(), ...a.flatMap((t) => ['--add-label', `${TAG_PREFIX}${t}`]), ...r.flatMap((t) => ['--remove-label', `${TAG_PREFIX}${t}`])]);
  bust();
  return { number: p.number, added: a, removed: r };
}
