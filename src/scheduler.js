import * as productReview from './product-review.js';
import crypto from 'node:crypto';
import { config } from './config.js';
import { agentById, ENGINEERS, PRINCIPALS, BUILDERS, AREAS, COMPLEXITIES, STATUSES, routeTicket, routeSlice, builderCandidates, promptFor } from './team.js';
import * as assign from './assign.js';
import * as teamStats from './team-stats.js';
import * as lessons from './lessons.js';
import * as store from './db.js';
import * as advisors from './advisors.js';
import * as council from './council.js';
import * as runner from './runner.js';
import * as packs from './context.js';
import * as github from './github.js';
import * as watch from './watch.js';
import { notify } from './notify.js';
import * as prsync from './prsync.js';
import * as prs from './prs.js';
import * as reviews from './reviews.js';
import * as mergetrain from './mergetrain.js';
import * as refresh from './refresh.js';
import * as research from './research.js';
import * as researchReview from './research-review.js';
import * as connectors from './connectors.js';
import * as features from './features.js';
import * as epicReview from './epic-review.js';
import * as ops from './ops.js';
import * as access from './access.js';
import * as mentions from './mentions.js';
import * as flow from '../public/flow.js';

const prNumberOf = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
import { selectionFor, pinnedSelection, providerHealth } from './dispatch.js';

// ---------------- publish guard ----------------
import { globToRegExp } from './reviews.js';
export { globToRegExp };
export function guardReasons(files, lines, complexity) {
  const pats = config.project.protectedPaths.map(globToRegExp);
  const hit = files.filter((f) => pats.some((r) => r.test(f)));
  const reasons = [];
  if (hit.length) reasons.push(`touches protected paths: ${hit.slice(0, 8).join(', ')}${hit.length > 8 ? '…' : ''}`);
  const cap = config.project.maxDiffLines[complexity || 'M'];
  if (cap && lines > cap) reasons.push(`diff is ${lines} lines (cap for ${complexity || 'M'} is ${cap})`);
  return reasons;
}

export const isDocPath = (f) => /\.(md|mdx|rst|txt|adoc)$/i.test(f) || /^docs\//.test(f);

// A test command must START a shell segment (so `printf pytest` or `echo npm test` don't count).
export function isTestCommand(cmd) {
  const re = new RegExp(`^(?:[A-Z_]+=\\S*\\s+)*(?:\\S*/)?(?:python3?\\S*\\s+-m\\s+)?(?:${config.project.testCommandPattern.replace(/^\\b|\\b$/g, '')})`);
  return String(cmd).split(/&&|\|\||;|\n/).some((seg) => {
    const s = seg.trim().replace(/^\(+/, '').replace(/^(?:cd\s+\S+\s*)$/, '');
    return re.test(s);
  });
}

// ---------------- limits ----------------
// The pure window test lives in research.js (market windows for research programs share it).
export function inBusyWindow(d = new Date(), w = config.limits.busyWindow) {
  if (!w?.enabled) return false;
  return research.inWindow(d, w);
}
export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
export function capacity(settings = store.getSettings()) {
  const base = Number(settings.max_concurrent);
  return inBusyWindow() ? Math.min(base, config.limits.busyWindow.maxConcurrent) : base;
}
// Who asked for this work and should confirm it matches their intent (null = the owner reviews the PR).
export function requesterOf(t) {
  if (!config.review.acceptance) return null;
  const seats = ['pm', 'manager', 'sre', ...(config.review.principalAcceptance ? PRINCIPALS : [])];
  const seat = seats.includes(t.reporter) ? t.reporter : null;
  return seat && agentById[seat]?.enabled !== false ? seat : null;
}

const agentIdle = (id) => agentById[id]?.enabled !== false && store.getAgentState(id)?.status !== 'working';

// ---------------- assignment ----------------
// An explicit seat (--assign, owner edit) pins the task to it. A principal named for small or medium work that is not
// high risk is routed to a builder instead: principals design and slice, they do not build.
function explicitSeat(body) {
  if (!body.assign || !ENGINEERS.includes(body.assign)) return null;
  if (PRINCIPALS.includes(body.assign) && ['S', 'M'].includes(body.complexity) && body.risk !== 'high') {
    const builder = builderCandidates(body)[0];
    if (builder) return { seat: builder, rerouted: body.assign };
  }
  return { seat: body.assign, pinned: true };
}
/** Who built this task and so keeps its rework (QA fixes, a branch with commits). */
export const authorOf = (t) => t.builder || (t.head_sha || t.branch || t.qa_loops > 0 ? t.assignee : null);
const balancedMode = (s = store.getSettings()) => s.assign_mode !== 'fixed';
/** The seat a design or legacy pickup uses: the planned assignee if it can still work, else the routing rule. */
const plannedSeat = (t) => (t.assignee && ENGINEERS.includes(t.assignee) && agentById[t.assignee].enabled !== false ? t.assignee : routeTicket(t));
/**
 * Design or build, decided from the recorded assignment before any availability fallback: a task assigned (or pinned)
 * to a builder is a build even when that builder is switched off; only principal-assigned or unassigned work that
 * routes to a principal is designed.
 */
const isDesign = (t) => (t.assignee && ENGINEERS.includes(t.assignee) ? PRINCIPALS.includes(t.assignee) : PRINCIPALS.includes(routeTicket(t)));
/**
 * Facts every build decision in one pass needs, computed once (health() and tick() decide for every todo task):
 * per seat whether it can launch a build (idle, enabled, its build engine available, no setup hold) and how full that
 * engine's window is. Budget is checked by admission (go).
 */
export function assignContext(now = Date.now()) {
  const usage = Object.fromEntries(providerHealth(now).map((p) => [p.id, liveUsage(p.quota, now)]));
  const seats = {};
  for (const id of BUILDERS) {
    const off = agentById[id]?.enabled === false;
    const sel = off ? { seat: null } : selectionFor(id, now, null, 'implement');
    const held = !!setupHold(id);
    seats[id] = { off, provider: !!sel.seat, held, busy: !agentIdle(id), launchable: !off && agentIdle(id) && !!sel.seat && !held, quota: usage[sel.seat?.engine] || 0 };
  }
  return { seats, stats: teamStats.current() };
}
/** How full an engine's five-hour window is now: a reading whose window has already reset counts as empty. */
export function liveUsage(q, now = Date.now()) {
  if (!q) return 0;
  const reset = Date.parse(q.five_hour_resets_at ?? q.resets_at), at = Date.parse(q.at);
  if (Number.isFinite(reset) ? reset <= now : Number.isFinite(at) && at + 5 * 3600_000 <= now) return 0;
  return Math.max(Number(q.five_hour) || 0, 0);
}
/**
 * Balanced build decision for a todo task (src/assign.js decides; this gathers the facts). `overlay` carries the
 * picks made earlier in the same tick so one tick does not hand every task to the same "least used" seat.
 */
export function buildDecision(t, { ctx = assignContext(), overlay = {}, taken = new Set() } = {}) {
  const { stats } = ctx;
  const wrote = authorOf(t);
  // Only a builder keeps rework, and a switched-off author hands it back to the team.
  const author = wrote && BUILDERS.includes(wrote) && agentById[wrote]?.enabled !== false ? wrote : null;
  const candidates = builderCandidates(t);
  const pool = [...new Set([...candidates, t.assignee, author].filter(Boolean))];
  const launchable = new Set(pool.filter((id) => !taken.has(id) && ctx.seats[id]?.launchable));
  const off = new Set(pool.filter((id) => !ctx.seats[id] || ctx.seats[id].off || !ctx.seats[id].provider));
  const held = new Set(pool.filter((id) => ctx.seats[id]?.held));
  const quota = Object.fromEntries(candidates.map((id) => [id, ctx.seats[id]?.quota || 0]));
  const siblings = new Set(t.parent_key ? store.childrenOf(t.parent_key).filter((k) => k.key !== t.key && authorOf(k)).map(authorOf) : []);
  const recent = Object.fromEntries(candidates.map((id) => [id, (stats.seats[id]?.builds_14d || 0) + (overlay[id] || 0)]));
  return { candidates, author, ...assign.pick(t, { candidates, launchable, off, held, stats: stats.seats, team: stats.team, quota, siblings, author, recent,
    names: Object.fromEntries(pool.map((id) => [id, agentById[id]?.name || id])) }) };
}

export function setStatus(key, status, extra = {}) {
  const before = store.getTicket(key)?.status;
  const t = store.updateTicket(key, { status, ...extra });
  github.syncIssueState(key);
  if (status !== before && status === 'needs_human') notify('needs_human', t, 'needs you');
  if (status !== before && status === 'ready_for_human') notify('ready_for_human', t, 'ready for your review');
  if (['done', 'wontdo'].includes(status)) runner.removeWorkspace(key); // clones are full copies now; free the disk
  if (['done', 'wontdo'].includes(status)) store.clearReservation(key);
  if (t.parent_key) rollupParent(t.parent_key);
  return t;
}
researchReview.hooks.setStatus = setStatus; // holds, waivers and owner decisions on research proposals go through the same door
features.hooks.setStatus = setStatus; // approving a feature plan starts the feature through the same door
// An epic review changes order, priority and owner tasks through the owner's own doors (same checks, same events).
Object.assign(epicReview.hooks, { ownerTask: (...a) => ownerTask(...a), ownerReply: (k, text, mode) => ownerReply(k, text, mode, { mentions: [] }) /* an epic answer never tags anyone */, ownerPatch: (k, p, o) => ownerPatch(k, p, o) });

// Order may cross sub-epics within one feature (a slice of SD-30 may wait for SD-29, a task of the parent SD-28): two
// tickets can be ordered when they share the same top-level ancestor.
export function rootOf(key) {
  let t = store.getTicket(key);
  for (let i = 0; t?.parent_key && i < 20; i++) t = store.getTicket(t.parent_key);
  return t?.key || null;
}
const sameTree = (a, b) => !!a && !!b && rootOf(a) === rootOf(b);

// The manager split a ticket into tasks: the parent stays open as an epic that tracks them and closes when they settle.
function splitParent(ticket, agentId, summary, ev) {
  const kids = store.childrenOf(ticket.key);
  need(kids.length > 0, 'create the tasks first (desk create-task --parent KEY)');
  store.addComment(ticket.key, agentId, `🧭 **Split** into ${kids.map((k) => `${k.key}${k.after_key ? ` (after ${k.after_key})` : ''}`).join(', ')}\n\n${summary || ''}`.trim());
  setStatus(ticket.key, 'in_progress', { assignee: 'manager', progress: 0, progress_msg: `0/${kids.length} tasks merged` });
  ev(`split ${ticket.key} into ${kids.length} task${kids.length === 1 ? '' : 's'}; it closes when they are done`);
  github.flushComments();
  return `Split recorded. ${ticket.key} stays open and closes when its ${kids.length} task(s) are done. Your run is complete — stop now.`;
}

// An epic (a principal's delegated ticket, or a ticket the manager split) tracks its tasks: progress rolls up; it closes
// when every task is settled. A parent a builder is implementing itself is not an epic.
export function rollupParent(parentKey) {
  const p = store.getTicket(parentKey);
  if (!p || p.status !== 'in_progress' || (p.assignee && p.assignee !== 'manager' && !PRINCIPALS.includes(p.assignee))) return;
  const kids = store.childrenOf(parentKey);
  if (!kids.length) return;
  const merged = kids.filter((k) => k.status === 'done').length;
  const settled = kids.filter((k) => ['done', 'wontdo'].includes(k.status)).length;
  const review = kids.filter((k) => k.status === 'ready_for_human').length;
  const stuck = kids.filter((k) => k.status === 'needs_human').length;
  const progress = Math.round(kids.reduce((a, k) => a + (['done', 'wontdo'].includes(k.status) ? 100 : k.progress || 0), 0) / kids.length);
  const msg = `${merged}/${kids.length} slices merged${review ? ` · ${review} awaiting your review` : ''}${stuck ? ` · ${stuck} need you` : ''}`;
  if (settled === kids.length) {
    store.updateTicket(parentKey, { status: merged ? 'done' : 'wontdo', progress: 100, progress_msg: msg });
    github.syncIssueState(parentKey);
    github.updateIssueBody(parentKey);
    if (p.parent_key) rollupParent(p.parent_key); // a closed sub-epic counts toward its own parent
    store.logEvent({ agent_id: p.assignee || 'system', ticket_key: parentKey, kind: 'done', text: `epic ${parentKey} closed: ${msg}` });
  } else {
    const before = p.progress_msg;
    store.updateTicket(parentKey, { progress: Math.min(99, progress), progress_msg: msg });
    if (before !== msg) github.updateIssueBody(parentKey); // tick the checklist as tasks merge
    if (p.parent_key) rollupParent(p.parent_key);
  }
}

// One-time repair: before `desk split` existed, the manager split a ticket and then closed it as "won't do", so live
// tasks hung under a closed parent. Those parents become epics again (or done, when every task already settled). Only
// parents the manager closed with a split note are touched; an owner's rejection is never reopened.
export function repairSplitEpics() {
  if (store.kvGet('migration:split-epics:v1')) return [];
  const leaves = (key, seen = new Set()) => store.childrenOf(key).flatMap((k) => {
    if (seen.has(k.key)) return []; seen.add(k.key);
    const kids = store.childrenOf(k.key);
    return kids.length ? leaves(k.key, seen) : [k];
  });
  const depth = (t) => { let d = 0; for (let p = t; p?.parent_key && d < 20; p = store.getTicket(p.parent_key)) d++; return d; };
  const candidates = store.listTickets().filter((p) => {
    if (p.status !== 'wontdo' || !store.childrenOf(p.key).length) return false;
    const comments = store.listComments(p.key);
    const closed = comments.filter((c) => c.body.startsWith('Closed:')).at(-1);
    if (closed?.author !== 'manager' || !/\bsplit\b/i.test(closed.body)) return false;
    // Anything the owner did after that closure (a rejection, a status edit, a reply) is their decision: keep it.
    if (comments.some((c) => c.author === 'owner' && c.id > closed.id)) return false;
    return !store.recentEvents({ ticket_key: p.key, limit: 200 }).some((e) => e.agent_id === 'owner' && e.ts >= closed.ts);
  });
  const fixed = [];
  store.transaction(() => {
    // Phase 1: decide every candidate from its real work (leaf tasks), before any rollup can settle an ancestor early.
    for (const p of candidates) {
      const work = leaves(p.key);
      const open = work.some((k) => !['done', 'wontdo'].includes(k.status));
      const next = open ? 'in_progress' : work.some((k) => k.status === 'done') ? 'done' : null;
      if (!next) continue;
      store.updateTicket(p.key, { status: next, ...(open ? {} : { progress: 100 }) });
      store.addComment(p.key, 'system', `Reopened as an epic. It was closed as "won't do" when the manager split it into tasks; a split parent now stays open${open ? ' and closes itself when its tasks are done' : ', and every task has settled, so it is done'}.`);
      fixed.push(p);
    }
    // Phase 2: roll up deepest first, so each ancestor sees its sub-epics' final state.
    for (const p of [...fixed].sort((x, y) => depth(y) - depth(x))) rollupParent(p.key);
    store.kvSet('migration:split-epics:v1', JSON.stringify({ at: store.now(), fixed: fixed.map((p) => p.key) }));
  });
  for (const p of fixed) github.syncIssueState(p.key);
  if (fixed.length) store.logEvent({ kind: 'system', agent_id: 'system', text: `Repaired ${fixed.length} split parent${fixed.length === 1 ? '' : 's'} closed by the old split rule: ${fixed.map((p) => p.key).join(', ')}.` });
  return fixed.map((p) => p.key);
}

// An ancestor epic ordered after an unfinished task holds this task (SD-30 waiting for SD-29 holds SD-32).
export function ancestorWaits(t) {
  const seen = new Set([t.key]);
  for (let p = t.parent_key && store.getTicket(t.parent_key); p && !seen.has(p.key) && seen.size < 12; p = p.parent_key && store.getTicket(p.parent_key)) {
    seen.add(p.key);
    if (p.after_key && store.getTicket(p.after_key)?.status !== 'done') return p;
  }
  return null;
}

function stall(ticket, reason) {
  const stalls = (ticket.stalls || 0) + 1;
  const resume = ticket.status === 'in_progress' ? 'todo' : ticket.status;
  if (stalls >= 2) {
    store.addComment(ticket.key, 'system', `Stalled twice (${reason}). Parked for you: answer on the ticket to resume.`);
    setStatus(ticket.key, 'needs_human', { stalls, active_run: null, resume_status: resume });
  } else {
    store.logEvent({ ticket_key: ticket.key, kind: 'system', text: `no outcome (${reason}); will retry once` });
    store.updateTicket(ticket.key, { stalls, active_run: null, status: resume });
  }
}

// ---------------- job launchers ----------------
async function launch({ agentId, kind, ticket, cwd, prompt, resume = null, fork = false, extraDirs = [], nonce = null, fence = runner.currentEpoch(), onStart = null, outcome = null, job = null, pinEngine = null }) {
  const before = ticket?.status;
  const p = runner.startRun({ agentId, kind, ticketKey: ticket?.key, prompt, cwd, resume, fork, extraDirs, nonce, fence, onStart, job, pinEngine });
  if (ticket) store.updateTicket(ticket.key, { active_run: store.getAgentState(agentId).current_run });
  const { run, aborted, failure } = await p;
  if (aborted) {
    store.updateAgent(agentId, { status: 'idle', current_ticket: null, current_run: null });
    if (ticket) store.updateTicket(ticket.key, { active_run: null, ...(ticket.status === 'in_progress' ? { status: 'todo' } : {}) });
    store.logEvent({ agent_id: agentId, ticket_key: ticket?.key, kind: 'system', text: `${kind} cancelled before start (circuit breaker)` });
    return null;
  }
  if (!ticket) return run;
  const after = store.getTicket(ticket.key);
  if (after.active_run === run.id) store.updateTicket(ticket.key, { active_run: null });
  // Did the seat actually move the ticket forward? (An implement run must end with `desk submit`.)
  // `outcome` lets a job say what "done" means (a first code-review approval leaves the ticket in review).
  const moved = outcome ? outcome(after) : kind === 'implement' ? after.status !== 'in_progress' : after.status !== before;
  if (!moved && failure) {
    store.updateTicket(ticket.key, { active_run: null, status: after.status === 'in_progress' ? 'todo' : after.status,
      progress_msg: 'Provider unavailable — waiting for an available engine' });
    store.addComment(ticket.key, 'system', `Run #${run.id} stopped because its provider was unavailable (${failure}). The next run may use another provider and a fresh session. Inspect git status and the existing diff before continuing; partial work is preserved but has not passed QA.`);
    return run;
  }
  if (!moved && resume && run.status === 'error' && !run.num_turns) return run; // caller falls back to a fresh run
  if (!moved) stall(after, run.status === 'killed' ? 'run stopped' : `${kind} ended without an outcome (${run.status})`);
  else if (after.stalls) store.updateTicket(ticket.key, { stalls: 0 });
  return run;
}

async function readonlyJob(agentId, ticket, kind) {
  store.updateAgent(agentId, { status: 'working', current_ticket: ticket?.key ?? null, last_action: 'preparing workspace', last_action_at: store.now() });
  if (ticket) store.updateTicket(ticket.key, { active_run: -1 });
  let cwd;
  try {
    cwd = await runner.ensureReadonlyWorkspace(agentId);
  } catch (err) {
    store.updateAgent(agentId, { status: 'idle', current_ticket: null });
    if (ticket) store.updateTicket(ticket.key, { active_run: null });
    throw err;
  }
  return { cwd };
}

// ---------------- production verification (SRE + desk ops) ----------------
/** A read-only production check (verify/confirm/check … in production), not a write, restart, credential or decision. */
export function isVerifyAsk(text) {
  const t = String(text || '');
  return /\b(verify|verif\w*|confirm\w*|check\w*|establish\w*|inspect\w*|investigat\w*|diagnos\w*|look (at|into)|measure\w*|query|read)\b/i.test(t)
    && /\b(prod|production|live|timescale\w*|database|db|postgres\w*|container\w*|logs?|ingest\w*|hypertable\w*|jobs?|incident|health|freshness)\b/i.test(t)
    && !/\b(restart\w*|redeploy\w*|deploy\w*|writes?|insert\w*|updat\w*|delet\w*|drop\w*|truncat\w*|alter\w*|migrat\w*|grant\w*|revok\w*|credential\w*|password\w*|secret\w*|tokens?|api key|rotat\w*|vacuum|reindex\w*|kill\w*|terminat\w*|backfill\w*|account\w*|billing|business decision|approv\w*|purchas\w*)\b/i.test(t);
}
export const verifyReady = () => ops.enabled() && (config.ops.kinds || []).includes('verify') && agentById.sre?.enabled !== false;
/** A verify task without a grant: ask once (ticket-scoped, reviewed by the EM within policy). False = keep waiting. */
function verifyAccess(t) {
  const mine = store.accessRequestHistory(200).filter((r) => r.seat === 'sre' && r.ticket_key === t.key);
  if (mine.some((r) => ['pending', 'reviewing', 'owner'].includes(r.status))) return false;
  if (mine[0]?.status === 'denied') { verifyToOwner(t, `${mine[0].decided_by === 'owner' ? 'You' : agentById[mine[0].decided_by]?.name || mine[0].decided_by} declined production read access for it (${mine[0].note || 'no reason'}).`); return false; }
  access.request({ seat: 'sre', probes: ['*'], why: `verify in production: ${t.title}`, ticketScoped: true, ticketKey: t.key, filedBy: 'desk' });
  return false;
}
async function launchAccessReview(r, approver, fence) {
  const { cwd } = await readonlyJob(approver, null);
  try {
    await launch({ fence, agentId: approver, kind: 'access_review', ticket: null, cwd, prompt: access.reviewPrompt(r), onStart: (run) => access.startReview(r, approver, run.id) });
  } finally { access.reviewEnded(r.id); }
}
function verifyToOwner(t, why = 'a read-only production check, and production read access is off (Settings → Production read access).') {
  store.kvSet(`verify:${t.key}`, '');
  store.updateTicket(t.key, { owner_task: 1, assignee: null });
  store.addComment(t.key, 'system', `🙋 **This is your task**: ${why}`);
}
async function launchVerify(t, fence) {
  const { cwd } = await readonlyJob('sre', t);
  store.logEvent({ agent_id: 'sre', ticket_key: t.key, kind: 'pickup', text: `verifying in production: ${t.title.slice(0, 120)}` });
  // in_progress while the check runs: a ticket grant is only usable then (bound to this run at launch).
  setStatus(t.key, 'in_progress', { progress_msg: 'verifying in production' });
  await launch({ fence, agentId: 'sre', kind: 'verify', ticket: store.getTicket(t.key), cwd, prompt: promptFor('verify', { ticket: t, comments: store.listComments(t.key) }),
    outcome: (after) => after.status !== 'in_progress' || !!after.owner_task });
}

async function launchTriage(t, fence) {
  const { cwd } = await readonlyJob('support', t);
  await launch({ fence, agentId: 'support', kind: 'triage', ticket: t, cwd, prompt: promptFor('triage', { ticket: t, comments: store.listComments(t.key) }) });
}

// Grooming runs on Codex unless the owner chose the manager seat's own engine (Settings). Perplexity relays could not
// carry the groom context pack verbatim and left threads pending, so grooming is pinned to an engine that reads the repo.
export const groomEngine = () => (store.getSettings().groom_engine === 'seat' ? null : 'codex');
async function launchGroom(t, fence) {
  const { cwd } = await readonlyJob('manager', t);
  await launch({ fence, agentId: 'manager', kind: 'groom', ticket: t, cwd, pinEngine: groomEngine(), prompt: promptFor('groom', { ticket: t, comments: store.listComments(t.key) }) });
}

// A discussion is retried after interruptions at most this many times, then fails visibly with a Retry for the owner.
export const DISCUSSION_ATTEMPTS = 3;
function requeueDiscussion(id, why) {
  const d = store.getDiscussion(id);
  const failed = (d.attempts || 0) >= DISCUSSION_ATTEMPTS;
  store.updateDiscussion(id, failed ? { status: 'failed', run_id: null, error: why, ended_at: store.now() } : { status: 'queued', run_id: null, error: why });
  store.logEvent({ ticket_key: d.ticket_key, agent_id: 'system', kind: failed ? 'error' : 'system',
    text: failed ? `Design discussion #${id} failed after ${d.attempts} attempts (${why}). Retry it from the ticket.` : `Design discussion #${id} interrupted (${why}); it will run again.` });
}
export async function launchDiscussion(d, fence) {
  store.updateDiscussion(d.id, { status: 'running', error: null, attempts: (store.getDiscussion(d.id)?.attempts || 0) + 1 });
  try {
    const { cwd } = await readonlyJob('manager', null);
    store.updateAgent('manager', { current_ticket: d.ticket_key, last_action: 'interpreting the owner’s design request' });
    const p = runner.startRun({ fence, agentId: 'manager', kind: 'owner_discussion', ticketKey: d.ticket_key, cwd,
      prompt: promptFor('owner_discussion', { ticket: store.getTicket(d.ticket_key), comments: store.listComments(d.ticket_key).slice(-8), extra: d.question }) });
    store.updateDiscussion(d.id, { run_id: store.getAgentState('manager').current_run });
    const { run, aborted, failure } = await p;
    if (store.getDiscussion(d.id).status !== 'running') return;
    if (aborted || failure || run.status === 'killed') { requeueDiscussion(d.id, aborted ? 'stopped' : failure ? 'provider unavailable' : 'run stopped'); return; }
    if (run.status === 'success' && run.result_text?.trim()) completeDiscussion(d.id, run.result_text);
    else {
      store.updateDiscussion(d.id, { status: 'failed', error: 'The manager ended without a design response', ended_at: store.now() });
      store.logEvent({ ticket_key: d.ticket_key, agent_id: 'system', kind: 'error', text: `Design discussion #${d.id} ended without a response. Retry it from the ticket.` });
    }
  } catch (err) { if (store.getDiscussion(d.id)?.status === 'running') requeueDiscussion(d.id, store.redact(err.message).slice(0, 240)); throw err; }
  finally { consultTargets.delete(store.getDiscussion(d.id)?.run_id); }
}
function completeDiscussion(id, response) {
  const d = store.getDiscussion(id);
  need(d?.status === 'running', 'discussion already completed');
  const text = store.redact(String(response).trim()).slice(0, 16000); need(text, 'response required');
  store.transaction(() => {
    store.updateDiscussion(id, { status: 'complete', response: text, ended_at: store.now() });
    store.addComment(d.ticket_key, 'manager', `💬 **Design response #${id}**\n\n${text}`);
  });
  github.flushComments();
}

// ---------------- owner @mentions ----------------
function blockMention(m, why) {
  store.updateMention(m.id, { status: 'blocked', reason: why, ended_at: store.now() });
  // The message itself shows Blocked with the reason; the activity log keeps the record (not the thread: no echo).
  store.logEvent({ agent_id: 'system', kind: 'system', text: `${m.ticket_key}: your tag for ${agentById[m.seat_id]?.name || m.seat_id} was not delivered: ${why}` });
}
function requeueMention(id, why) {
  const m = store.getMention(id);
  const failed = (m.attempts || 0) >= mentions.maxAttempts();
  store.updateMention(id, failed ? { status: 'failed', run_id: null, reason: `${why}; tried ${m.attempts} times`, ended_at: store.now() } : { status: 'queued', run_id: null, reason: why });
  store.logEvent({ agent_id: 'system', kind: failed ? 'error' : 'system',
    text: failed ? `${m.ticket_key}: ${agentById[m.seat_id]?.name}'s answer to your tag failed after ${m.attempts} attempts (${why}). Retry it from the message.` : `${m.ticket_key}: ${agentById[m.seat_id]?.name}'s answer to your tag was interrupted (${why}); it will run again.` });
}
/** A tagged seat answers: one reply per delivery, linked to it (the run's own reply, or its final text). */
function replyToMention(m, seat, text) {
  const body = store.redact(String(text || '').trim()).slice(0, 8000);
  need(body, 'reply text required');
  const c = store.transaction(() => {
    const fresh = store.getMention(m.id);
    need(!fresh.reply_comment_id, 'you already replied to this message (one reply per tag)');
    need(['working', 'replied'].includes(fresh.status), `this tag is ${fresh.status}; it takes no reply now`);
    const comment = store.addComment(m.ticket_key, seat, body);
    store.updateMention(m.id, { status: 'replied', reply_comment_id: comment.id, ended_at: fresh.ended_at || store.now() });
    return comment;
  });
  github.flushComments();
  return c;
}
/**
 * The tagged seat's run: the discussion lifecycle (independent completion). It never owns ticket.active_run and never
 * stalls the ticket; it ends when the seat replied or routed the work, and a run that ends without either is retried a
 * bounded number of times (interruptions) or fails visibly (no answer).
 */
export async function launchMention(m, fence) {
  const seat = m.seat_id;
  store.updateMention(m.id, { status: 'working', reason: null, run_id: null, attempts: (store.getMention(m.id)?.attempts || 0) + 1, started_at: store.now() });
  let runId = null;
  try {
    const { cwd } = await readonlyJob(seat, null);
    if (store.getMention(m.id)?.status !== 'working') { store.updateAgent(seat, { status: 'idle', current_ticket: null }); return; } // cancelled meanwhile
    store.updateAgent(seat, { current_ticket: m.ticket_key, current_kind: 'mention', last_action: 'reading what the owner asked' });
    const message = store.listComments(m.ticket_key).find((c) => c.id === m.comment_id)?.body || '';
    const p = runner.startRun({ fence, agentId: seat, kind: 'mention', ticketKey: m.ticket_key, cwd, job: { mention: m.id, origin: m.origin },
      prompt: mentions.prompt({ ticket: store.getTicket(m.ticket_key), comments: store.listComments(m.ticket_key).filter((c) => c.id <= m.comment_id), message, seat }),
      onStart: (run) => {
        runId = run.id;
        // The engine the run actually got must enforce the hard spend cap (a fallback could pick one that does not).
        const [engine, ...model] = String(run.model || '').split(':');
        if (!runner.capsSpend({ ...agentById[seat], engine, model: model.join(':') }, 'mention')) {
          store.updateMention(m.id, { status: 'blocked', run_id: run.id, reason: `${agentById[seat].name}'s available engine (${engine}) has no hard spend cap, so the desk stopped the run. Retry when a Claude engine is available.`, ended_at: store.now() });
          runner.killRun(run.id, 'tagged work needs an engine with a hard spend cap');
          return;
        }
        store.updateMention(m.id, { run_id: run.id });
      } });
    const { run, aborted, failure } = await p;
    if (aborted) store.updateAgent(seat, { status: 'idle', current_ticket: null, current_run: null, current_kind: null });
    const now = store.getMention(m.id);
    if (!['working', 'replied'].includes(now.status)) return; // cancelled or blocked while it ran
    if (now.reply_comment_id) return; // answered in the thread
    if (aborted || failure || run?.status === 'killed') {
      if (now.routed) { store.updateMention(m.id, { status: 'replied' }); return; } // the work was routed: that is its answer
      requeueMention(m.id, aborted ? 'stopped before it started' : failure ? 'provider unavailable' : 'run stopped');
      return;
    }
    if (run.status === 'success' && run.result_text?.trim()) { try { replyToMention(now, seat, run.result_text); } catch { /* replied meanwhile */ } return; }
    if (now.routed) { store.updateMention(m.id, { status: 'replied' }); return; }
    store.updateMention(m.id, { status: 'failed', reason: `${agentById[seat].name} ended without an answer`, ended_at: store.now() });
    store.logEvent({ agent_id: 'system', kind: 'error', text: `${m.ticket_key}: ${agentById[seat].name} ended without answering your tag. Retry it from the message.` });
  } catch (err) {
    if (store.getMention(m.id)?.status === 'working' && !store.getMention(m.id)?.reply_comment_id) requeueMention(m.id, store.redact(err.message).slice(0, 240));
    if (!runId) store.updateAgent(seat, { status: 'idle', current_ticket: null, current_kind: null });
    throw err;
  }
}

// A slice ordered after a sibling that was closed without merging would otherwise wait forever.
function orphanedSlice(t) {
  store.addComment(t.key, 'system', `⚠️ This slice was waiting for ${t.after_key}, which was closed without merging. Decide: continue without it (reply), rescope, or close.`);
  setStatus(t.key, 'needs_human', { after_key: null, resume_status: 'todo', progress_msg: `predecessor ${t.after_key} closed unmerged` });
}

// Preparing a clone takes seconds; if the owner moved, rejected or reassigned the ticket meanwhile, do not start.
function stillWanted(key, status, agentId) {
  const now = store.getTicket(key);
  const blocked = status === 'in_progress' && now && (now.owner_task || ancestorWaits(now) || (now.after_key && store.getTicket(now.after_key)?.status !== 'done'));
  if (now?.status === status && !blocked && (now.assignee === agentId || status !== 'in_progress')) return true;
  store.updateAgent(agentId, { status: 'idle', current_ticket: null, current_run: null });
  if (blocked && now.status === status) setStatus(key, 'todo', { active_run: null, progress_msg: now.owner_task ? 'your task' : 'waiting for its prerequisite' });
  else if (now?.active_run === -1) store.updateTicket(key, { active_run: null });
  store.logEvent({ agent_id: agentId, ticket_key: key, kind: 'system', text: `start cancelled: the ticket changed (${now?.status || 'gone'}) while its workspace was being prepared` });
  return false;
}

async function launchImplement(ticket, agentId, fence, reason = null) {
  store.updateAgent(agentId, { status: 'working', current_ticket: ticket.key, last_action: 'cloning workspace', last_action_at: store.now() });
  store.logEvent({ agent_id: agentId, ticket_key: ticket.key, kind: 'pickup', text: `${agentById[agentId].role} picked up ${ticket.key}${reason ? ` (${reason})` : ''}` });
  setStatus(ticket.key, 'in_progress', { assignee: agentId, active_run: -1, assign_reason: reason ?? null, progress: Math.max(2, ticket.progress || 0), progress_msg: 'cloning workspace' });
  store.addContributor(ticket.key, agentId); // recorded at pickup: even an interrupted author never reviews this ticket
  let ws;
  try {
    ws = await runner.ensureWorkspace(store.getTicket(ticket.key));
  } catch (err) {
    store.updateAgent(agentId, { status: 'idle', current_ticket: null });
    store.logEvent({ agent_id: agentId, ticket_key: ticket.key, kind: 'error', text: `workspace setup failed: ${err.message}` });
    setStatus(ticket.key, 'needs_human', { active_run: null, resume_status: 'todo', progress_msg: 'workspace setup failed' });
    return;
  }
  if (!stillWanted(ticket.key, 'in_progress', agentId)) return;
  const t = store.updateTicket(ticket.key, { branch: ws.branch });
  const comments = store.listComments(t.key);
  const pendingRefresh = refresh.current(t.key);
  const refreshing = pendingRefresh && ['conflicts', 'rebased'].includes(pendingRefresh.status);
  if (pendingRefresh?.status === 'conflicts') comments.push({ author: 'system', body: refresh.instructions(pendingRefresh) });
  const prev = store.lastRunFor(t.key, agentId, 'implement');
  // A stalled request (idle watchdog) is resumed in place: same session, same clone, nothing redone.
  if (!refreshing && prev && prev.status === 'killed' && /idle timeout|desk restarted|desk shutdown/.test(prev.result_text || '') && runner.canResume(prev, 6) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id,
      prompt: 'Your previous request stalled and was restarted. Continue exactly where you left off: finish the ticket, commit, and run desk submit.' });
    if (!(run && run.status === 'error' && !run.num_turns)) return;
    if (budgetHeadroom() < runner.runBudget(agentId)) { stall(store.getTicket(t.key), 'resume failed and the daily risk limit is reached'); return; }
  }
  // Rework: continue this engineer's own session (same clone, full memory of what it tried) when it is recent.
  const notes = comments.filter((c) => /^(❌|🔁)/.test(c.body)).pop();
  if (!refreshing && config.review.resumeRework && notes && runner.canResume(prev, config.review.resumeReworkMaxAgeHours) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id, prompt: promptFor('rework', { ticket: t, extra: notes.body }) });
    if (run && run.status === 'error' && !run.num_turns) {
      store.logEvent({ agent_id: agentId, ticket_key: t.key, kind: 'system', text: 'session resume failed — starting fresh' });
      if (budgetHeadroom() < runner.runBudget(agentId)) { stall(store.getTicket(t.key), 'daily risk limit reached'); return; }
    } else return;
  }
  await launch({ fence, agentId, kind: 'implement', ticket: store.getTicket(t.key), cwd: ws.dir, prompt: promptFor('implement', { ticket: store.getTicket(t.key), comments }) });
}

const nonce = () => crypto.randomBytes(5).toString('hex');

// Principals design and slice; they never get an implementation run.
async function launchDesign(t, seat, fence) {
  const { cwd } = await readonlyJob(seat, t);
  store.logEvent({ agent_id: seat, ticket_key: t.key, kind: 'pickup', text: `${agentById[seat].role} is designing ${t.key} and will delegate the build` });
  await launch({ fence, agentId: seat, kind: 'design', ticket: t, cwd, prompt: promptFor('design', { ticket: t, comments: store.listComments(t.key) }) });
}

async function launchQa(ticket, fence) {
  store.updateAgent('qa', { status: 'working', current_ticket: ticket.key, last_action: 'checking out the submitted commit', last_action_at: store.now() });
  store.updateTicket(ticket.key, { active_run: -1 });
  let ws;
  try {
    ws = await runner.ensureWorkspace(ticket);
  } catch (err) {
    store.updateAgent('qa', { status: 'idle', current_ticket: null });
    store.updateTicket(ticket.key, { active_run: null });
    throw err;
  }
  if (!stillWanted(ticket.key, 'qa', 'qa')) return;
  store.logEvent({ agent_id: 'qa', ticket_key: ticket.key, kind: 'pickup', text: `QA picked up ${ticket.key}` });
  // The verdict code lives only in the prompt: code under test (which inherits the shell) cannot know it.
  const code = nonce();
  await launch({ fence, agentId: 'qa', kind: 'qa', ticket, cwd: ws.dir, nonce: code, prompt: promptFor('qa', { ticket, comments: store.listComments(ticket.key), extra: code }) });
}

async function launchReview(ticket, seat, fence) {
  store.updateAgent(seat, { status: 'working', current_ticket: ticket.key, last_action: 'opening the QA-passed change', last_action_at: store.now() });
  store.updateTicket(ticket.key, { active_run: -1 });
  let ws;
  try {
    ws = await runner.ensureWorkspace(ticket);
  } catch (err) {
    store.updateAgent(seat, { status: 'idle', current_ticket: null });
    store.updateTicket(ticket.key, { active_run: null });
    throw err;
  }
  if (!stillWanted(ticket.key, 'review', seat)) return;
  store.logEvent({ agent_id: seat, ticket_key: ticket.key, kind: 'pickup', text: `${agentById[seat].role} is reviewing ${ticket.key} against the original intent` });
  const comments = store.listComments(ticket.key);
  // Opt-in: fork the requester's original session (where the idea was born) if it is recent enough.
  const origin = ticket.origin_session ? store.runBySession(ticket.origin_session) : null;
  if (config.review.resumeRequester && runner.engineOf(agentById[seat]).canFork && runner.canResume(origin, config.review.resumeRequesterMaxAgeHours)) {
    const code = nonce();
    const run = await launch({ fence, agentId: seat, kind: 'review', ticket, cwd: origin.cwd, resume: origin.session_id, fork: true, extraDirs: [ws.dir], nonce: code,
      prompt: promptFor('review-resumed', { ticket: { ...ticket, nonce: code }, comments, extra: ws.dir }) });
    if (!(run && run.status === 'error' && !run.num_turns)) return;
    if (budgetHeadroom() < runner.runBudget(seat, 'pr_review')) { stall(store.getTicket(ticket.key), 'daily risk limit reached'); return; }
  }
  const code = nonce();
  await launch({ fence, agentId: seat, kind: 'review', ticket, cwd: ws.dir, nonce: code, prompt: promptFor('review', { ticket, comments, extra: code }) });
}

// Two-reviewer PRs: a reviewer runs read-only on a fresh snapshot of exactly the reviewed commit.
async function launchPrReview(job, fence) {
  const { seat } = job;
  const idle = () => { store.updateAgent(seat, { status: 'idle', current_ticket: null }); store.updateTicket(job.key, { active_run: null }); };
  store.updateAgent(seat, { status: 'working', current_ticket: job.key, last_action: 'checking out the commit under review', last_action_at: store.now() });
  store.updateTicket(job.key, { active_run: -1 });
  let cwd;
  try { cwd = await reviews.prepareSnapshot(store.getTicket(job.key), seat); } catch (err) { idle(); throw err; }
  if (!stillWanted(job.key, 'review', seat)) return;
  const t = store.getTicket(job.key);
  const row = store.getPrReview(job.review.id);
  if (row.verdict !== 'pending' || row.state !== 'active' || row.sha !== t.head_sha || t.review_stage !== 'reviewing') { idle(); return; }
  store.logEvent({ agent_id: seat, ticket_key: t.key, kind: 'pickup', text: `${agentById[seat].role} is reviewing ${t.key} at ${row.sha.slice(0, 7)} (${row.role} reviewer)` });
  const code = nonce();
  const reconfirm = await reviews.reconfirmContext(t); // light re-confirm after a desk update or a conflict resolution
  await launch({ fence, agentId: seat, kind: 'pr_review', ticket: t, cwd, nonce: code, prompt: reviews.reviewPrompt(t, row, code, reconfirm),
    onStart: (run) => store.updatePrReview(row.id, { nonce: code, run_id: run.id, round: t.review_round || 0 }),
    outcome: (after) => after.status !== 'review' || store.getPrReview(row.id).verdict !== 'pending' });
  runner.removeReviewSnapshot(t.key, seat); // every review starts from a fresh snapshot; free the disk
}

// The author answers review findings in their own clone: fix + commit, or push back with reasons.
async function launchRespond(job, fence) {
  const { seat } = job;
  store.updateAgent(seat, { status: 'working', current_ticket: job.key, last_action: 'reading the review', last_action_at: store.now() });
  store.addContributor(job.key, seat);
  store.updateTicket(job.key, { active_run: -1 });
  let ws;
  try { ws = await runner.ensureWorkspace(store.getTicket(job.key)); } catch (err) {
    store.updateAgent(seat, { status: 'idle', current_ticket: null }); store.updateTicket(job.key, { active_run: null }); throw err;
  }
  if (!stillWanted(job.key, 'review', seat)) return;
  const t = store.getTicket(job.key);
  if (t.review_stage !== 'responding') { store.updateAgent(seat, { status: 'idle', current_ticket: null }); store.updateTicket(t.key, { active_run: null }); return; }
  store.logEvent({ agent_id: seat, ticket_key: t.key, kind: 'pickup', text: `${agentById[seat].role} is answering the code review on ${t.key}` });
  await launch({ fence, agentId: seat, kind: 'respond', ticket: t, cwd: ws.dir, prompt: reviews.respondPrompt(t),
    outcome: (after) => after.status !== 'review' || after.review_stage !== 'responding' });
}

// Merge train (#3): the builder resolves a real conflict in a fresh desk-built clone with a compact conflict pack.
async function launchResolve(job, fence) {
  const { seat } = job;
  const idle = () => { store.updateAgent(seat, { status: 'idle', current_ticket: null }); store.updateTicket(job.key, { active_run: null }); };
  store.updateAgent(seat, { status: 'working', current_ticket: job.key, last_action: 'preparing the conflict', last_action_at: store.now() });
  store.updateTicket(job.key, { active_run: -1 });
  let prepared;
  try { prepared = await mergetrain.prepareResolve(job.job); } catch (err) { idle(); throw err; }
  if (!stillWanted(job.key, 'review', seat)) return;
  const t = store.getTicket(job.key);
  const j = store.getConflictJob(job.job.id);
  if (t.review_stage !== 'resolving' || j.status !== 'pending') { idle(); return; }
  if (prepared.clean) { // git merged it without help after all: no model run needed
    idle();
    const head = (await runner.scratchGit(prepared.dir, ['rev-parse', 'HEAD'])).stdout.trim();
    store.updateConflictJob(j.id, { status: 'running' });
    await mergetrain.finishResolution(t, j, head, prepared.dir, 'git merged it cleanly this time; no manual changes were needed.');
    return;
  }
  const attempts = (j.attempts || 0) + 1;
  if (attempts > (Number(config.resolve?.maxAttempts) || 2)) {
    idle();
    store.updateConflictJob(j.id, { status: 'needs_owner', note: 'resolution attempts exhausted' });
    store.addComment(t.key, 'system', `🧭 ${agentById[seat].name} tried to resolve the conflict ${attempts - 1} times without finishing. Reply to let them try again, or resolve it yourself.`);
    setStatus(t.key, 'needs_human', { resume_status: 'review', progress_msg: 'conflict needs your call' });
    return;
  }
  const pack = await mergetrain.conflictPack(j, t, prepared.dir);
  const prev = store.lastRunFor(t.key, seat, 'implement');
  if (mergetrain.shouldResume(prev, pack)) store.logEvent({ agent_id: seat, ticket_key: t.key, kind: 'system', text: 'resume estimated cheaper, but sessions are tied to the builder clone; using a fresh run in the isolated clone' });
  store.logEvent({ agent_id: seat, ticket_key: t.key, kind: 'pickup', text: `${agentById[seat].role} is resolving a merge conflict on ${t.key}` });
  // Synchronous from this check to the run start (launch → startRun selects the provider without awaiting): the seat's
  // engine must enforce the hard spend cap right now; onStart re-verifies the engine the run actually got.
  if (!mergetrain.cappedSeat(seat)) { idle(); return; }
  store.addContributor(t.key, seat);
  await launch({ fence, agentId: seat, kind: 'resolve', ticket: t, cwd: prepared.dir, prompt: mergetrain.resolvePrompt(t, j, pack),
    onStart: (run) => {
      const [engine, ...m] = String(run.model || '').split(':');
      if (!runner.capsSpend({ ...agentById[seat], engine, model: m.join(':') })) { runner.killRun(run.id, 'resolve needs an engine with a hard spend cap'); return; }
      store.updateConflictJob(j.id, { status: 'running', run_id: run.id, attempts });
    },
    outcome: () => store.getConflictJob(j.id).status !== 'running' });
  const after = store.getConflictJob(j.id);
  if (after.status === 'running') store.updateConflictJob(j.id, { status: 'pending', run_id: null }); // no outcome: retried (attempts counted)
}

// ---------------- watch desk ----------------
function incidentEvidence(inc, context = []) {
  const samples = JSON.parse(inc.samples || '[]');
  return [`Signature ${inc.signature} · project ${inc.project} · source ${inc.label}`,
    `Seen ${inc.count}× total, ${watch.windowCount(inc.signature)}× in the last ${config.watch.windowMinutes} min · first ${inc.first_seen} · last ${inc.last_seen}`,
    `Normalized: ${inc.normalized}`,
    '<log-samples untrusted="true">', ...samples.map((x) => `[${x.ts}] ${x.line}`), '</log-samples>',
    context.length ? ['<log-context untrusted="true">', ...context.map((l) => store.redact(l).slice(0, 400)), '</log-context>'].join('\n') : ''].join('\n');
}

async function launchInvestigation(inc, fence) {
  store.updateIncident(inc.id, { status: 'investigating', attempts: (inc.attempts || 0) + 1 });
  try {
  const { cwd } = await readonlyJob('sre', null);
  const samples = JSON.parse(inc.samples || '[]');
  const context = await watch.lokiContext(config.watch.sources[inc.source_index], inc.label, samples.at(-1)?.ts || inc.last_seen);
  store.logEvent({ agent_id: 'sre', kind: 'pickup', text: `investigating incident #${inc.id} (${inc.label}): ${inc.normalized.slice(0, 120)}` });
  const { run, aborted, failure } = await runner.startRun({ fence, agentId: 'sre', kind: 'investigate', cwd, incidentId: inc.id, prompt: promptFor('investigate', { extra: incidentEvidence(inc, context) }) });
  if (aborted) { store.updateAgent('sre', { status: 'idle' }); store.updateIncident(inc.id, { status: 'watching' }); return; }
  const after = store.getIncident(inc.id);
  if (failure && after.status === 'investigating') {
    store.updateIncident(inc.id, { status: 'watching', attempts: inc.attempts || 0, note: 'Provider unavailable — investigation will retry' });
    return;
  }
  if (after.status === 'investigating') {
    const give = (after.attempts || 0) >= 2;
    store.updateIncident(inc.id, { status: give ? 'paged' : 'watching', note: `investigation ended without a verdict (${run.status})` });
    if (give) pageOwner([after], 'SRE could not reach a verdict twice');
  }
  } catch (err) {
    store.updateIncident(inc.id, { status: 'watching', attempts: inc.attempts || 0, note: `Setup failed: ${store.redact(err.message).slice(0, 160)}` });
    throw err;
  }
}

function pageOwner(incidents, why) {
  const top = incidents.slice(0, 12);
  const t = store.createTicket({
    title: incidents.length > 1 ? `Error storm: ${incidents.length} new error signatures` : `Needs you: ${incidents[0].normalized.slice(0, 90)}`,
    description: `${why}\n\n${top.map((i) => `- **${i.label}** (${i.count}×, last ${i.last_seen}): \`${i.normalized.slice(0, 160)}\``).join('\n')}`,
    type: 'bug', status: 'needs_human', priority: incidents.length > 1 ? 'P0' : 'P1', reporter: 'sre', source: 'watch',
  });
  store.updateTicket(t.key, { resume_status: 'proposed' });
  notify('page', t, 'SRE paged you');
  for (const i of incidents) store.updateIncident(i.id, { status: 'paged', ticket_key: t.key });
  store.logEvent({ agent_id: 'sre', ticket_key: t.key, kind: 'system', text: `paged the owner: ${t.title}` });
  github.createIssue(t.key);
  return t;
}

export function watchDecisions() {
  if (!config.watch.enabled) return null;
  const d = watch.triageIncidents();
  if (d.page) pageOwner(d.page, `${d.page.length} new error signatures appeared within ${config.watch.windowMinutes} minutes. This looks like an outage or a bad deploy, not ${d.page.length} separate bugs — check infrastructure first.`);
  for (const inc of d.foreign) {
    const t = store.createTicket({ title: `[${inc.project}] ${inc.normalized.slice(0, 100)}`, type: 'bug', status: 'needs_human', priority: 'P2', reporter: 'sre', source: 'watch',
      description: `Recurring error from **${inc.project}** (${inc.label}), which this desk does not manage.\n\n${incidentEvidence(inc)}` });
    store.updateIncident(inc.id, { status: 'foreign', ticket_key: t.key });
  }
  for (const inc of d.regressions) {
    const prev = inc.ticket_key ? store.getTicket(inc.ticket_key) : null;
    const t = store.createTicket({ title: `Regression: ${prev?.title || inc.normalized.slice(0, 100)}`, type: 'bug', status: 'proposed', priority: 'P1', reporter: 'sre', source: 'watch',
      description: `The error signature that ${inc.ticket_key || 'an earlier fix'} resolved is back after the fix shipped.\n\n${incidentEvidence(inc)}` });
    if (prev) store.addComment(prev.key, 'sre', `⚠️ Signature seen again after this fix shipped — opened ${t.key}.`);
    store.updateIncident(inc.id, { status: 'ticketed', ticket_key: t.key, resolved_at: null });
  }
  return d;
}

// One admission path for scheduled, manual and program-specific research: the program's seat, its engine fit, and a
// proposal allowance reserved against the global room (net of allowances other running research jobs still hold).
export function researchAllowance(settings = store.getSettings()) {
  const held = store.unfinishedRuns().filter((r) => r.kind === 'research' && r.job).reduce((n, r) => { try { const j = JSON.parse(r.job); return n + Math.max(0, (j.maxProposals || 0) - (j.proposals || 0)); } catch { return n; } }, 0);
  return Number(settings.max_open_proposals) - store.ticketsByStatus('proposed').length - held;
}
export async function launchResearch(focus = '', fence = runner.currentEpoch(), programId = research.DEFAULT_PROGRAM) {
  const s = store.getSettings();
  const p = research.get(programId, s);
  if (!p) throw Object.assign(new Error(`Unknown research program ${programId}`), { status: 404 });
  if (!agentIdle(p.seat)) throw new Error(`${agentById[p.seat]?.name || p.seat} is busy`);
  if (s.paused === 'true') throw Object.assign(new Error('Open the desk before starting research'), { status: 409 });
  const sel = selectionFor(p.seat, Date.now(), research.requirements(p));
  if (!sel.seat) throw Object.assign(new Error(`${agentById[p.seat]?.name || p.seat}: ${sel.reason}`), { status: 409 });
  const room = researchAllowance(s);
  if (room <= 0) throw Object.assign(new Error('Enough proposals are waiting for grooming; research resumes when the funnel thins'), { status: 409 });
  const job = research.job(p, { focus, room });
  const extra = `Program "${p.label}" (${p.id}). ${job.focus ? `Focus: ${job.focus}. ` : ''}File at most ${job.maxProposals} proposal${job.maxProposals === 1 ? '' : 's'}; each one is reviewed by another seat before grooming.`;
  const { cwd } = await readonlyJob(p.seat, null);
  return launch({ fence, agentId: p.seat, kind: 'research', ticket: null, cwd, prompt: promptFor('research', { extra }), job });
}
// Independent assessment of a proposed connector: a read-only run whose structured answer lands on the connector record.
async function launchConnectorAssessment(c, seat, fence) {
  store.updateAgent(seat, { status: 'working', current_ticket: null, current_kind: 'connector_assessment', last_action: `Assessing connector ${c.name}`, last_action_at: store.now() });
  try {
    const cwd = await runner.ensureReadonlyWorkspace(seat);
    const outcome = await runner.startRun({ agentId: seat, kind: 'connector_assessment', cwd, fence, prompt: connectors.assessmentPrompt(c), job: { web: true, connector: c.name },
      onStart: (run) => connectors.markAssessmentRun(c.name, run.id) });
    if (outcome.aborted || outcome.run?.status !== 'success') throw new Error(outcome.run?.result_text || 'Assessment interrupted');
    connectors.completeAssessment(c.name, { report: connectors.parseAssessment(outcome.result?.result || outcome.run.result_text), run_id: outcome.run.id, reviewer: seat });
  } catch (e) { connectors.completeAssessment(c.name, { error: e.message }); }
  finally { if (!store.getAgentState(seat)?.current_run) store.updateAgent(seat, { status: 'idle', current_ticket: null, current_kind: null }); }
}

// ---------------- the tick ----------------
let ticking = false;
let budgetWarned = '';
let lastTick = null;
let lastError = null;
function setupHold(id) {
  try { const hold = JSON.parse(store.kvGet(`setup-hold:${id}`) || 'null'); return Date.parse(hold?.until) > Date.now() ? hold : null; }
  catch { return null; }
}
export function health() {
  const settings = store.getSettings();
  let actx = null; // assignment facts, computed once for every todo task below
  const queued = store.listTickets().filter((t) => ['triage', 'proposed', 'todo', 'qa', 'review'].includes(t.status));
  return { last_tick: lastTick, last_error: lastError, paused: settings.paused === 'true', budget_headroom: budgetHeadroom(settings),
    queued: queued.length, discussions: store.pendingDiscussions().length, mention_queue: mentionQueue(settings), waiting: queued.filter((t) => !t.active_run).map((t) => {
      if (researchReview.blocks(t)) return { key: t.key, code: 'research_review', reason: researchReview.reasonFor(t) };
      const review = productReview.current(t.key) || (t.parent_key && productReview.current(t.parent_key));
      if (review && (review.stale || review.status !== 'approved')) return { key: t.key, code: review.status === 'reviewing' && !review.stale ? 'product_review' : 'review_decision', reason: review.stale ? 'Product/design review is stale' : `Product/design review: ${review.status}` };
      // A balanced build waits only when no fitting seat can take it: say for whom. Otherwise it names the seat that will.
      const build = t.status === 'todo' && balancedMode(settings) && !isDesign(t) && !t.owner_task ? buildDecision(t, { ctx: (actx ||= assignContext()) }) : null;
      const seat = t.status === 'triage' ? 'support' : t.status === 'proposed' ? 'manager' : t.status === 'qa' ? 'qa'
        : t.status === 'review' ? (t.review_stage === 'resolving' ? store.conflictJobsFor(t.key).at(-1)?.seat : reviews.enabled() ? reviews.jobFor(t)?.seat : requesterOf(t))
          : (build?.order.find((id) => budgetHeadroom(settings) >= runner.runBudget(id, 'implement')) || build?.order[0]) || t.assignee || routeTicket(t);
      if (build && !build.order.length && !(t.after_key && store.getTicket(t.after_key)?.status !== 'done') && !ancestorWaits(t) && settings.paused !== 'true')
        return { key: t.key, seat: build.author || build.candidates[0] || null, code: build.code || 'seat_busy', reason: build.reason };
      const chosen = selectionFor(seat);
      // `code` is the structured reason the UI classifies on; `reason` stays human-readable.
      const held = ancestorWaits(t);
      const [code, why] = t.owner_task ? ['owner_task', 'Your task: the team cannot do it'] : settings.paused === 'true' ? ['paused', 'Desk paused'] : t.after_key && store.getTicket(t.after_key)?.status !== 'done' ? ['dependency', `Waiting for ${t.after_key} to merge`] : held ? ['dependency', `Waiting for ${held.after_key} (its epic ${held.key} waits for it)`]
        : !chosen.seat ? ['provider_hold', chosen.reason] : setupHold(seat) ? ['setup_retry', `Setup retry after ${setupHold(seat).until}`] : !agentIdle(seat) ? ['seat_busy', 'Seat busy']
          : budgetHeadroom(settings) < runner.runBudget(seat) ? ['budget', 'Daily budget reached'] : ['tick', 'Ready for next scheduler tick'];
      return { key: t.key, seat, code, reason: why, engine: chosen.seat?.engine, fallback: chosen.fallback || false };
    }) };
}

/** Tagged seats waiting to answer (the presence strip's "up next"); the same codes as `waiting`, kept apart from it
 *  so a tag never reads as the ticket's own waiting reason. */
function mentionQueue(settings) {
  return store.openMentions().filter((m) => m.status === 'queued').map((m) => {
    const [code, reason] = settings.paused === 'true' ? ['paused', 'Desk paused'] : !agentIdle(m.seat_id) ? ['seat_busy', 'Seat busy']
      : !mentions.launchable(m.seat_id) ? ['provider_hold', 'Waiting for an engine with a hard spend cap'] : ['tick', 'Ready for next scheduler tick'];
    return { key: m.ticket_key, seat: m.seat_id, code, reason, mention: m.id };
  });
}

export function budgetHeadroom(settings = store.getSettings()) {
  // Reserve each running seat's full per-run cap so concurrent runs can't jointly blow the daily limit.
  const preparing = store.listAgentStates().filter((a) => a.status === 'working' && !a.current_run).reduce((sum, a) => sum + runner.runBudget(a.id, a.current_kind || null), 0);
  return Number(settings.daily_budget_usd) - store.spendSince(startOfToday()) - preparing - runner.runningBudget() - council.reservations();
}
export function workCount() {
  return store.listAgentStates().filter((a) => a.status === 'working').length
    + store.unfinishedRuns().filter((r) => ['architecture_review','council_review'].includes(r.kind)).length + council.preparingCount();
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try { repairGuardHolds(); } catch { /* never let the repair stop a tick */ } // the doctor: a guard hold always shows
  try {
    lastTick = store.now();
    const s = store.getSettings();
    if (s.paused === 'true') return;
    let headroom = budgetHeadroom(s);
    // Seats are flipped to "working" synchronously when a job starts, so this counts jobs still in setup too.
    let slots = capacity(s) - workCount();
    const fence = runner.currentEpoch();
    // `kind` is the job's kind: admission checks the same engine capability the run will (see selectionFor).
    const go = (agentId, fn, pin = null, kind = null) => {
      if (!(pin ? pinnedSelection(agentId, pin, kind || 'groom') : selectionFor(agentId, Date.now(), null, kind)).seat) return false;
      if (setupHold(agentId)) return false;
      const need = pin ? runner.engineOf({ engine: pin }).budgetUsd({}) : runner.runBudget(agentId, kind); // reserve the cap of the engine that will run it
      if (headroom < need) {
        const day = startOfToday();
        if (budgetWarned !== day) {
          budgetWarned = day;
          store.logEvent({ kind: 'system', text: `Risk limit: daily budget $${s.daily_budget_usd} would be exceeded. New runs wait until tomorrow (or raise the limit).` });
        }
        return false;
      }
      headroom -= need;
      slots -= 1;
      fn(fence).then(() => {
        store.kvSet(`setup-hold:${agentId}`, 'null');
        if (lastError?.seat === agentId) lastError = null;
      }).catch((err) => {
        lastError = { at: store.now(), seat: agentId, message: store.redact(err.message).slice(0, 240) };
        let failures = 1;
        try { failures += JSON.parse(store.kvGet(`setup-hold:${agentId}`) || 'null')?.failures || 0; } catch { /* new hold */ }
        const waitMs = Math.min(15 * 60000, 60000 * 2 ** Math.min(4, failures - 1));
        store.kvSet(`setup-hold:${agentId}`, JSON.stringify({ failures, until: new Date(Date.now() + waitMs).toISOString() }));
        const state = store.getAgentState(agentId);
        if (!state?.current_run || !store.getRun(state.current_run)?.token) {
          store.updateAgent(agentId, { status: 'idle', current_ticket: null, current_run: null, current_kind: null });
          if (state?.current_ticket) {
            const t = store.getTicket(state.current_ticket);
            if (t?.active_run) store.updateTicket(t.key, { active_run: null, ...(t.status === 'in_progress' ? { status: 'todo' } : {}) });
          }
        }
        store.logEvent({ kind: 'error', agent_id: agentId, text: `scheduler: ${err.message}` });
      });
      return true;
    };

    // 1. Support triages owner/GitHub tickets (cheap, fast).
    const triage = store.ticketsByStatus('triage').find((t) => !t.active_run && !features.holds(t));
    if (triage && slots > 0 && agentIdle('support')) go('support', (f) => launchTriage(triage, f), null, 'triage');
    // 1a. Production access: end grants whose time/ticket/run is over; the EM/SRE reviews pending requests.
    access.sweep();
    if (verifyReady() || ops.enabled(s)) {
      const rv = slots > 0 ? access.nextReview((id) => agentIdle(id)) : null;
      if (rv) go(rv.approver, (f) => launchAccessReview(rv.request, rv.approver, f), null, 'access_review');
    }
    // 1b. On-call SRE investigates new recurring error signatures (rate-limited).
    if (config.watch.enabled && slots > 0 && agentIdle('sre')) {
      const recentCount = store.investigationsSince(new Date(Date.now() - 3600_000).toISOString());
      const next = recentCount < config.watch.maxInvestigationsPerHour
        ? (watch.triageIncidents().investigate || []).sort((a, b) => watch.windowCount(b.signature) - watch.windowCount(a.signature))[0] : null;
      if (next) go('sre', (f) => launchInvestigation(next, f), null, 'investigate');
    }
    // 2. QA before new implementation: settle work in flight first.
    const qa = store.ticketsByStatus('qa').find((t) => !t.active_run);
    if (qa && slots > 0 && agentIdle('qa')) go('qa', (f) => launchQa(qa, f), null, 'qa');
    // Owner @mentions: each tagged seat answers in its own capped run (never the ticket's run). A busy seat's tag stays
    // queued without holding a slot; a seat that cannot take tags at all is told so on the message.
    for (const m of store.openMentions().filter((x) => x.status === 'queued')) {
      if (slots <= 0) break;
      const mt = store.getTicket(m.ticket_key);
      if (!mt || ['done', 'wontdo'].includes(mt.status)) { store.updateMention(m.id, { status: 'cancelled', reason: 'the ticket closed before they started', ended_at: store.now() }); continue; }
      const why = mentions.blockReason(m.seat_id);
      if (why) { blockMention(m, why); continue; }
      if (agentIdle(m.seat_id) && mentions.launchable(m.seat_id)) go(m.seat_id, (f) => launchMention(m, f), null, 'mention');
    }
    const discussion = store.pendingDiscussions().find((d) => d.status === 'queued');
    if (discussion && slots > 0 && agentIdle('manager')) go('manager', (f) => launchDiscussion(discussion, f), null, 'owner_discussion');
    // Owner-requested feature grooming (Codex) runs before ordinary grooming: the owner is waiting on it.
    const plan = features.next();
    if (plan && slots > 0 && agentIdle('manager')) go('manager', (f) => features.launch(plan, f), features.ENGINE, 'feature_groom');
    // An epic whose tasks are parked on questions gets one manager review (with a principal) instead of N questions.
    if (!epicReview.next()) { const auto = epicReview.autoCandidate(); if (auto && budgetHeadroom() > 0) epicReview.start(auto, { by: 'desk', reason: 'two or more tasks in this epic are parked on questions' }); }
    const review = epicReview.next();
    if (review && slots > 0 && agentIdle('manager')) go('manager', (f) => epicReview.launch(review, f), features.ENGINE, 'epic_review');
    // 2b. Two-reviewer code review (context, then independent) and the author's answers; legacy: requester acceptance.
    if (reviews.enabled()) {
      for (const job of reviews.nextJobs()) {
        if (slots <= 0) break;
        if (!agentIdle(job.seat)) continue;
        go(job.seat, (f) => (job.kind === 'pr_review' ? launchPrReview(job, f) : launchRespond(job, f)), null, job.kind === 'pr_review' ? 'pr_review' : 'respond');
      }
      for (const job of mergetrain.enabled() ? mergetrain.nextResolveJobs() : []) {
        if (slots <= 0) break;
        if (!agentIdle(job.seat)) continue;
        go(job.seat, (f) => launchResolve(job, f), null, 'resolve');
      }
    } else {
      for (const t of store.ticketsByStatus('review')) {
        if (slots <= 0) break;
        const seat = requesterOf(t);
        if (t.active_run || !seat || !agentIdle(seat)) continue;
        go(seat, (f) => launchReview(t, seat, f), null, 'review');
      }
    }
    productReview.refreshChangedPlans();
    // Bounded independent reviews (product/design, second-person research reviews, revisions, connector assessments)
    // share one allowance of two and preserve capacity for QA/SRE. Review debt runs before new discovery.
    const REVIEW_KINDS = ['product_review', 'research_review', 'research_revision', 'connector_assessment'];
    let reviewSlots = 2 - store.listAgentStates().filter(a => a.status === 'working' && REVIEW_KINDS.includes(a.current_kind)).length;
    const reviewRoom = () => slots > (capacity(s) > 1 ? 1 : 0) && reviewSlots > 0;
    for (const { r, m } of productReview.pending()) {
      if (!reviewRoom()) break;
      if (agentIdle(m.agent_id) && go(m.agent_id, f => productReview.launch(r, m, f), null, 'product_review')) reviewSlots--;
    }
    for (const { t, reviewer } of researchReview.nextAssignments()) {
      if (!reviewRoom()) break;
      if (!agentIdle(reviewer)) continue;
      const a = researchReview.assign(t, reviewer);
      if (go(reviewer, (f) => researchReview.launch(a, f), null, 'research_review')) reviewSlots--; else researchReview.cancel(a.id, 'not admitted this tick');
    }
    for (const t of researchReview.nextRevisions()) {
      if (!reviewRoom()) break;
      if (agentIdle(t.reporter) && go(t.reporter, (f) => researchReview.launchRevision(t, f), null, 'research_revision')) reviewSlots--;
    }
    for (const c of connectors.pendingAssessments()) {
      if (!reviewRoom()) break;
      const seat = connectors.assessorFor(c, (id) => agentById[id]?.enabled !== false);
      if (!seat) { connectors.completeAssessment(c.name, { error: 'no eligible assessor seat is enabled' }); continue; }
      if (agentIdle(seat) && go(seat, (f) => launchConnectorAssessment(c, seat, f), null, 'connector_assessment')) reviewSlots--;
    }
    // 3. Engineers pick up groomed work by routing (area × complexity × risk).
    council.pump();
    slots = capacity(s) - workCount(); headroom = budgetHeadroom(s);
    const balanced = balancedMode(s);
    const actx = balanced ? assignContext() : null;
    const overlay = {}, taken = new Set();
    let todo = store.ticketsByStatus('todo');
    // Balanced: within a priority, tasks only a few seats can build go first, so a flexible task does not take the
    // one seat a specialist task needs (ticketsByStatus is already priority-then-age; the sort is stable).
    if (balanced) {
      // A pinned task or rework has exactly one seat.
      const width = new Map(todo.map((t) => [t.key, t.assign_pinned || authorOf(t) ? 1 : builderCandidates(t).filter((id) => actx.seats[id]?.launchable).length || 99]));
      const pr = (t) => ({ P0: 0, P1: 1, P2: 2 }[t.priority] ?? 3);
      todo = todo.map((t, i) => ({ t, i })).sort((a, b) => pr(a.t) - pr(b.t) || width.get(a.t.key) - width.get(b.t.key) || a.i - b.i).map((x) => x.t);
    }
    for (const t of todo) {
      if (slots <= 0) break;
      if (t.active_run) continue;
      if (features.holds(t)) continue; // a feature starts only through its approved plan
      if (t.after_key && store.getTicket(t.after_key)?.status === 'wontdo') { orphanedSlice(t); continue; }
      if (t.after_key && store.getTicket(t.after_key)?.status !== 'done') continue; // waits for its predecessor to merge
      if (t.owner_task) continue; // the owner's own task: never a seat's
      if (ancestorWaits(t)) continue; // an epic that waits holds its tasks too
      if (store.kvGet(`verify:${t.key}`) === '1') { // a read-only production check: the SRE with desk ops, never a builder
        if (!verifyReady()) { verifyToOwner(t); continue; }
        if (!access.seatHasAccess('sre', t.key) && !verifyAccess(t)) continue; // waits for a grant (EM or owner decides)
        if (agentIdle('sre')) go('sre', (f) => launchVerify(t, f), null, 'verify');
        continue;
      }
      const parent = t.parent_key && store.getTicket(t.parent_key);
      if (parent && productReview.required(parent) && ['proposed','todo'].includes(parent.status)) {
        if (parent.active_run || parent.status==='proposed') continue;
        productReview.ensure(parent); // slices cannot race ahead of their parent's first review
      }
      if (productReview.required(t)) productReview.ensure(t);
      if (productReview.blocks(t)) continue;
      if (researchReview.blocks(t) || (parent && researchReview.blocks(parent))) continue; // a research proposal needs its second review first
      const who = plannedSeat(t);
      // Design stays with the planned principal; fixed mode is the legacy rule: one seat, wait for it.
      if (!balanced || isDesign(t)) {
        if (!agentIdle(who)) continue;
        if (PRINCIPALS.includes(who)) go(who, (f) => launchDesign(t, who, f), null, 'design');
        else go(who, (f) => launchImplement(t, who, f), null, 'implement');
        continue;
      }
      // Balanced build: the best launchable seat; if admission refuses it (budget, provider), the next one.
      const d = buildDecision(t, { ctx: actx, overlay, taken });
      for (const [i, seat] of d.order.entries()) {
        const reason = i === 0 ? d.reason : `${agentById[seat].name}: ${d.order.slice(0, i).map((x) => agentById[x].name).join(' and ')} could not start (budget or provider)`;
        if (!go(seat, (f) => launchImplement(t, seat, f, reason), null, 'implement')) continue;
        taken.add(seat); overlay[seat] = (overlay[seat] || 0) + 1;
        break;
      }
    }
    // 4. Manager grooms proposals (consulting principals inside the run); research proposals wait for their second review.
    const proposed = store.ticketsByStatus('proposed').find((t) => !t.active_run && !researchReview.blocks(t) && !features.holds(t));
    if (proposed && slots > 0 && agentIdle('manager')) go('manager', (f) => launchGroom(proposed, f), groomEngine(), 'groom');
    // 5. Research programs on their own cadence and market window while the funnel is thin (oldest last run first).
    for (const p of research.due(s)) {
      if (slots <= 0 || researchAllowance(s) <= 0) break;
      if (!agentIdle(p.seat) || !selectionFor(p.seat, Date.now(), research.requirements(p)).seat) continue;
      go(p.seat, (f) => launchResearch('', f, p.id));
    }
  } finally {
    ticking = false;
  }
}

// ---------------- recovery ----------------
/**
 * A publish-guard hold whose notice a failed refresh overwrote (before refreshes restored it): the reviewed commit is
 * still local, the PR still has an older one, and the latest guard notice is newer than the last publish. Restore the
 * hold so the owner sees "approve publication" again. Runs at start and every tick; never touches a ticket the desk is
 * working on (a branch refresh holds active_run and the ticket reservation).
 */
export function repairGuardHolds() {
  for (const t of store.ticketsByStatus('needs_human')) {
    if (/publish guard/i.test(t.progress_msg || '') || !t.head_sha || !t.pr_url || t.active_run || store.reservationOf(t.key)) continue;
    // The desk's own record (set when the guard parks a commit, cleared on approval or refresh) is the only proof.
    if (store.kvGet(`guard:${t.key}`) !== t.head_sha || store.kvGet(`published:${t.key}`) === t.head_sha) continue;
    store.updateTicket(t.key, { progress_msg: 'publish guard: needs owner approval' });
    store.logEvent({ ticket_key: t.key, agent_id: 'system', kind: 'system', text: 'Restored the publish-guard hold that a branch refresh message had replaced.' });
  }
}

export function recoverOrphans() {
  repairGuardHolds();
  productReview.recover();
  researchReview.recover();
  features.recover();
  epicReview.recover();
  repairSplitEpics();
  connectors.recover();
  for (const d of store.pendingDiscussions()) if (d.status === 'running') store.updateDiscussion(d.id, { status: 'queued', run_id: null });
  // A tagged seat interrupted by the restart answers again (attempts already counted; bounded by mentions.maxAttempts).
  for (const m of store.openMentions()) if (m.status === 'working') {
    if (m.reply_comment_id || m.routed) store.updateMention(m.id, { status: 'replied', run_id: null });
    else if ((m.attempts || 0) >= mentions.maxAttempts()) store.updateMention(m.id, { status: 'failed', run_id: null, reason: 'interrupted by desk restarts', ended_at: store.now() });
    else store.updateMention(m.id, { status: 'queued', run_id: null, reason: 'interrupted by a desk restart' });
  }
  for (const inc of store.listIncidents({ status: 'investigating' })) store.updateIncident(inc.id, { status: 'watching', note: 'investigation interrupted by restart' });
  for (const run of store.unfinishedRuns()) {
    if (run.pid) {
      try { process.kill(-run.pid, 'SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
    }
    // No terminal report survived the restart: charge the cap so interrupted spend is never forgotten.
    store.updateRun(run.id, { status: 'killed', ended_at: store.now(), result_text: 'desk restarted', token: null,
      cost_usd: run.cost_usd || runner.reservationFor(run), cost_estimated: run.cost_usd ? 0 : 1 });
    store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'error', text: 'run interrupted by a desk restart' });
  }
  mergetrain.recover(); // interrupted conflict resolutions go back to pending (durable, keyed by PR/base/head)
  for (const a of store.listAgentStates()) store.updateAgent(a.id, { status: 'idle', current_ticket: null, current_run: null, current_kind: null, meeting: null });
  for (const t of store.listTickets()) {
    if (t.active_run) store.updateTicket(t.key, { active_run: null, ...(t.status === 'in_progress' ? { status: 'todo' } : {}) });
    if (refresh.current(t.key)?.status === 'preparing') store.updateTicket(t.key, { status: 'needs_human', active_run: null, resume_status: 'todo', progress_msg: 'branch refresh interrupted — preserved recovery clone needs inspection' });
  }
}

// ---------------- desk CLI actions (called by seats with their run token) ----------------
// Thinking seats may propose a connector (a case, never a binding); the owner approves. Builders, QA and support cannot.
const THINKERS = Object.keys(agentById).filter((id) => !BUILDERS.includes(id) && !['qa', 'support'].includes(id));
const PERMS = {
  groom: ['manager'], split: ['manager'], 'create-task': ['manager', ...PRINCIPALS], reject: ['manager'], consult: ['manager'], 'connector-propose': THINKERS,
  design: PRINCIPALS, delegate: PRINCIPALS, 'peer-review': ['manager', ...PRINCIPALS], council: ['manager', ...PRINCIPALS],
  route: ['support'], submit: ENGINEERS, lesson: BUILDERS, qa: ['qa'], accept: ['pm', 'manager', 'sre'], incident: ['sre'],
  'discussion-result': ['manager'],
  review: ['manager', ...ENGINEERS], respond: ENGINEERS, resolve: ENGINEERS,
  'continue-rebase': BUILDERS, verify: ['sre'], access: ['manager', 'sre'],
};
const PRIORITY = /^P[0-3]$/;
const consultsByRun = new Map();
const consultTargets = new Map();
const peerReviewsByRun = new Set();

function need(cond, msg) { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); }

function fmtTicket(t, comments) {
  return `${t.key} [${t.status}] ${t.title}\ntype=${t.type} priority=${t.priority} area=${t.area || '-'} complexity=${t.complexity || '-'} assignee=${t.assignee || '-'} branch=${t.branch || '-'} pr=${t.pr_url || '-'} issue=${t.issue_number ? `#${t.issue_number}` : '-'}\n\n${t.description}\n\nComments:\n${comments.map((c) => `--- ${c.author}: ${c.body}`).join('\n') || '(none)'}`;
}

export async function deskAction(run, cmd, body = {}) {
  const agentId = run.agent_id;
  if (run.kind === 'product_review') need(['context-file'].includes(cmd), 'Product reviewers are read-only; return a structured report, not desk mutations');
  if (run.kind === 'council_review') need(false, 'council calls cannot invoke desk commands');
  if (run.kind === 'feature_groom') need(false, 'a grooming session is read-only: return the plan JSON as your final answer');
  if (run.kind === 'epic_review') need(['list', 'show', 'consult', 'context-file'].includes(cmd), 'an epic review reads and consults; return the review JSON as your final answer');
  // Research kinds are authorized by the run, not the seat: proposals come from research runs that carry a program,
  // a revision run may only revise its own proposal, and reviewers/assessors are read-only.
  if (run.kind === 'research') need(['show', 'list', 'comment', 'needs-human', 'progress', 'propose', 'connector-propose', 'context-file'].includes(cmd), 'research runs read and file proposals; they do not groom, design or build');
  if (run.kind === 'research_revision') need(['show', 'list', 'comment', 'progress', 'revise', 'context-file'].includes(cmd), 'a revision run may only revise its own proposal');
  if (['research_review', 'connector_assessment'].includes(run.kind)) need(['show', 'list', 'context-file'].includes(cmd), 'reviewers are read-only; return the structured JSON as your final answer');
  if (run.kind === 'owner_discussion') {
    need(['list', 'show', 'comment', 'consult', 'discussion-result', 'context-file'].includes(cmd), 'design discussions can only read, consult and respond');
    need(!body.key || body.key === run.ticket_key, 'discussion belongs to its original ticket');
  }
  if (run.kind === 'mention') {
    need(['show', 'list', 'reply', 'comment', 'handoff', 'ops', 'context-file'].includes(cmd), 'a tagged run reads, answers with desk reply and routes real work with desk handoff; it cannot do that itself');
    need(!body.key || body.key === run.ticket_key, 'answer on the ticket you were tagged in');
  } else need(!['reply', 'handoff'].includes(cmd), `desk ${cmd} only works in a run where the owner tagged you`);
  if (run.kind === 'access_review') need(['show', 'list', 'access'].includes(cmd), 'an access review decides one request: desk access approve|deny|owner');
  if (run.kind === 'verify') need(['show', 'list', 'comment', 'progress', 'ops', 'verify', 'context-file'].includes(cmd), 'a verify run reads production through desk ops and finishes with desk verify done|owner');
  if (PERMS[cmd]) need(PERMS[cmd].includes(agentId), `${agentById[agentId].role} cannot run "${cmd}"`);
  const key = body.key || run.ticket_key;
  const ticket = key ? store.getTicket(key) : null;
  // A seat may only change its own ticket (the manager may also touch tickets it creates via create-task).
  const ownTicket = () => need(ticket && (ticket.key === run.ticket_key || agentId === 'manager'), 'you can only act on your current ticket');
  const ev = (text, k = key) => store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: k, kind: 'action', text });

  switch (cmd) {
    case 'lesson': {
      need(BUILDERS.includes(agentId), 'builders propose lessons from their own work');
      return lessons.propose({ run, ticket: store.getTicket(run.ticket_key), text: body.body });
    }
    case 'continue-rebase': {
      need(run.kind === 'implement' && ticket?.key === run.ticket_key && ticket.status === 'in_progress', 'only the current implementer can finish a rebase');
      const r = await refresh.continueRebase(ticket.key);
      store.updateTicket(ticket.key, { progress: 50, progress_msg: r.status === 'conflicts' ? 'resolving refreshed base conflicts' : 'rebased — rerun tests' });
      store.addComment(ticket.key, 'system', refresh.instructions(r));
      return refresh.instructions(r);
    }
    case 'council-models': return JSON.stringify({ models: council.models(), lenses: council.LENSES });
    case 'council': {
      ownTicket();
      need(!peerReviewsByRun.has(run.id), 'one peer review or council per run');
      const d = council.defaults();
      const c = council.create(key, { question: body.body, members: [
        { model: body.reviewer || d.members[0].model, lens: body.profile || 'architecture' },
        { model: body.challenger || d.members[1].model, lens: 'reliability' }], synthesizer: body.synthesizer || d.synthesizer });
      peerReviewsByRun.add(run.id);
      try { council.queue(c.id); } catch (e) { return `Council #${c.id} brief saved; ${e.message}. Continue planning without another council request this run.`; }
      return `Council #${c.id} queued. Read-only, up to two independent calls, followed by a principal synthesis. Your saved seat preferences are retained. Continue planning; the owner reviews the council in Architecture review. Do not request another council this run.`;
    }
    case 'peer-review': {
      ownTicket();
      need(!peerReviewsByRun.has(run.id), 'one architecture peer review per run; use the existing findings');
      const r = advisors.createBrief(key, { reviewer: body.reviewer || (agentId === 'principal-fe' ? 'google/gemini-3.1-pro-preview' : 'perplexity/kimi-k3'), challenger: body.challenger || 'xai/grok-4.7', question: body.body || '' });
      peerReviewsByRun.add(run.id);
      if (![r.reviewer, r.challenger].filter(Boolean).every((m) => advisors.routeModel(m)))
        return `Review brief #${r.id} saved. API credentials are unavailable; the owner can use Architecture review on this ticket to copy it into Perplexity. Continue with your own design; do not retry.`;
      try {
        advisors.assertCanRun(r.id);
        const done = await advisors.runReview(r.id);
        return done.result || `Peer review failed: ${done.error}. Continue using the design evidence; do not retry this run.`;
      } catch (err) { return `Review brief #${r.id} saved; ${err.message}. Continue without another attempt this run.`; }
    }
    case 'context-file': {
      // Perplexity seats: a file the model asked for, produced by the desk so the follow-up can be verified.
      need(body.path || body.body, 'desk context-file <path> [--page N]');
      const out = await packs.serveFile(run.id, String(body.path || body.body).trim(), Number(body.page) || 1);
      ev(`fetched ${String(body.path || body.body).slice(0, 120)} for Perplexity`);
      return out;
    }
    case 'show':
      need(ticket, 'no such ticket');
      return fmtTicket(ticket, store.listComments(ticket.key));
    case 'list': {
      const rows = store.listTickets().filter((t) => (body.status ? t.status === body.status : !['done', 'wontdo'].includes(t.status)));
      return rows.map((t) => `${t.key}\t${t.status}\t${t.priority}\t${t.area || '-'}/${t.complexity || '-'}\t${t.assignee || '-'}\t${t.title}`).join('\n') || '(no tickets)';
    }
    case 'progress': {
      ownTicket();
      const pct = Math.max(0, Math.min(99, Number(body.pct) || 0));
      store.updateTicket(ticket.key, { progress: pct, progress_msg: String(body.msg || '').slice(0, 200) });
      ev(`${pct}% · ${body.msg || ''}`);
      return 'ok';
    }
    case 'reply':
    case 'handoff': {
      const m = mentions.forRun(run);
      need(m && m.run_id === run.id, 'this run carries no tagged message');
      if (cmd === 'reply') { replyToMention(m, agentId, body.body); ev(`answered the owner's tag: ${String(body.body || '').slice(0, 140)}`); return 'Reply posted. If real work is needed, route it with desk handoff; otherwise stop now.'; }
      return mentionHandoff(run, m, ticket, body, ev);
    }
    case 'comment':
      if (run.kind === 'mention') { const m = mentions.forRun(run); need(m, 'this run carries no tagged message'); replyToMention(m, agentId, body.body); ev(`answered the owner's tag: ${String(body.body || '').slice(0, 140)}`); return 'Reply posted. Stop now unless real work must be routed with desk handoff.'; }
      need(ticket, 'no ticket');
      need(body.body, 'empty comment');
      store.addComment(ticket.key, agentId, body.body);
      ev(`commented: ${String(body.body).slice(0, 140)}`);
      github.flushComments();
      return 'ok';
    case 'needs-human': {
      ownTicket();
      need(body.body, 'question required');
      store.addComment(ticket.key, agentId, `❓ **Question for the owner:** ${body.body}`);
      setStatus(ticket.key, 'needs_human', { resume_status: ticket.status === 'in_progress' ? 'todo' : ticket.status });
      ev(`asked the owner: ${String(body.body).slice(0, 140)}`);
      github.flushComments();
      return 'Parked for the owner. Stop working on this ticket now and end your run.';
    }
    case 'propose': {
      need(run.kind === 'research', 'proposals are filed from research runs only');
      const live = store.getRun(run.id);
      let job = null; try { job = live?.job ? JSON.parse(live.job) : null; } catch { job = null; }
      need(job && job.program, 'this research run carries no program; the owner starts research from Settings → Research');
      need((job.proposals || 0) < job.maxProposals, `your proposal allowance for this session (${job.maxProposals}) is used up — stop now`);
      need(store.ticketsByStatus('proposed').length < Number(store.getSettings().max_open_proposals), 'enough proposals are waiting for grooming — stop proposing');
      need(body.title && body.body, 'title and body (stdin) required');
      need(String(body.body).length <= 20000, 'proposal body must be at most 20000 characters');
      const t = store.transaction(() => {
        const created = store.createTicket({ title: body.title, description: body.body, type: body.type || 'feature', status: 'proposed',
          area: AREAS.includes(body.area) ? body.area : null, priority: PRIORITY.test(body.priority) ? body.priority : 'P2', reporter: agentId, source: 'research' });
        job.proposals = (job.proposals || 0) + 1;
        store.updateRun(run.id, { job: JSON.stringify(job) });
        store.updateTicket(created.key, { origin_session: live.session_id || null });
        researchReview.open(created, job, live);
        return store.getTicket(created.key);
      });
      ev(`proposed ${t.key}: ${t.title} (program ${job.program})`, t.key);
      return `created ${t.key}; it waits for an independent second review before grooming. ${job.maxProposals - job.proposals} proposal(s) left this session.`;
    }
    case 'revise': {
      need(ticket, 'ticket key required');
      const out = researchReview.revise(ticket, run, { title: body.title, body: body.body });
      ev(`revised ${ticket.key} after review (generation ${out.research_generation})`);
      return 'Proposal revised; a fresh second review follows. Your run is complete — stop now.';
    }
    case 'connector-propose': {
      need(['research', 'research_revision', 'design', 'groom', 'owner_discussion', 'consult', 'product_review'].includes(run.kind) || true, 'connector proposals come from thinking runs');
      const c = connectors.propose({ name: body.name, purpose: body.purpose, case_md: body.body, proposed_by: agentId });
      ev(`proposed connector ${c.name}`);
      return `connector ${c.name} proposed. The owner must assess and approve it before any program can use it; continue your task without it.`;
    }
    case 'groom': {
      need(ticket && ticket.key === run.ticket_key && run.kind === 'groom', 'you can only groom the ticket you were given');
      need(ticket.status === 'proposed', 'ticket must be in proposed');
      need(!researchReview.blocks(ticket), 'this research proposal awaits its independent second review; it cannot be groomed yet');
      need(COMPLEXITIES.includes(body.complexity), 'complexity S|M|L|XL required');
      need(AREAS.includes(body.area), `area one of ${AREAS.join('|')}`);
      // An owner's pin survives grooming unless the manager names a seat explicitly.
      const kept = !body.assign && ticket.assign_pinned && ticket.assignee ? { seat: ticket.assignee, pinned: true } : null;
      const explicit = kept || explicitSeat(body);
      const assignee = explicit?.seat || routeTicket(body);
      const description = body.body ? `${ticket.description}\n\n## Groomed spec (Engineering Manager)\n${body.body}` : ticket.description;
      setStatus(ticket.key, 'todo', { complexity: body.complexity, area: body.area, priority: !ticket.priority_pinned && PRIORITY.test(body.priority) ? body.priority : ticket.priority,
        assignee, assign_pinned: explicit?.pinned ? 1 : 0, description, risk: ['high', 'low'].includes(body.risk) ? body.risk : null, ...(body.title ? { title: body.title } : {}) });
      if (explicit?.rerouted) store.addComment(ticket.key, 'system', `Principals design and slice; this ${body.complexity} task goes to ${agentById[assignee].name} instead of ${agentById[explicit.rerouted].name}.`);
      ev(`groomed ${ticket.key} → ${body.complexity}/${body.area}${body.risk === 'high' ? '/high-risk' : ''}, staffed ${agentById[assignee].role}`);
      github.createIssue(ticket.key);
      return `groomed; assigned to ${assignee}`;
    }
    case 'create-task': {
      need(body.title && body.body, 'title and body required');
      need(COMPLEXITIES.includes(body.complexity) && AREAS.includes(body.area), 'complexity and area required');
      // Order is enforced only through --after. A gate written in the text ("gated on SD-29") becomes the dependency
      // when it names exactly one open task of this feature; several need an explicit --after.
      // --after none: the text names other tasks but this one does not wait for them.
      let gateNote = '';
      const parentOf = PRINCIPALS.includes(agentId) ? run.ticket_key : (body.parent || key);
      if (body.after === 'none') body.after = null;
      else if (!body.after) {
        const pseudo = { key: 'NEW-0', parent_key: parentOf, title: body.title, description: body.body, status: 'todo' };
        const ix = flow.index([...store.listTickets(), pseudo]);
        const gates = flow.textGates(pseudo, ix, { strong: true });
        need(gates.length <= 1, `this task's text says it waits on ${gates.join(', ')}; the desk records one prerequisite per task. Pass --after with the one that merges last, or split the task so each part waits on one (--after none if it does not wait at all)`);
        if (gates.length === 1) { body.after = gates[0]; gateNote = ` (recorded the gate you wrote: after ${gates[0]}; pass --after none if that was not a dependency)`; }
        else {
          const maybe = flow.textGates(pseudo, ix);
          if (maybe.length) gateNote = ` (your text mentions ${maybe.join(', ')}; if it must wait, run desk create-task again with --after, otherwise ignore this)`;
        }
      }
      // A task can never wait for the epic that contains it: that epic only finishes when this task does.
      if (body.after) { const host = store.getTicket(parentOf); const ix = flow.index(store.listTickets()); need(!host || ![host, ...flow.ancestors(host, ix)].some((a) => a.key === body.after), `--after ${body.after} contains this task; it would wait forever`); }
      // --owner "<why>": a step only the owner can do (access no seat has). It goes to the owner, never to a seat.
      const ownerWhy = typeof body.owner === 'string' && body.owner.trim() ? body.owner.trim().slice(0, 500) : body.owner === true ? 'Only the owner can do this step.' : null;
      // --verify (or an --owner step that is really a read-only production check): the SRE answers it with desk ops
      // probes; the owner only gets it when production read access is off or the probes cannot answer.
      const verifyAsk = body.verify === true || (!!ownerWhy && isVerifyAsk(`${body.title}\n${ownerWhy}`));
      const toSre = verifyAsk && verifyReady();
      const ownerReason = ownerWhy || (verifyAsk ? 'Read-only production check, and production read access for the SRE is off (Settings → Production read access).' : null);
      const asOwnerTask = (k) => {
        if (toSre) {
          store.updateTicket(k, { owner_task: 0, assignee: 'sre', assign_pinned: 1 });
          store.kvSet(`verify:${k}`, '1');
          store.addComment(k, 'system', `🔎 Routed to ${agentById.sre.name} (SRE) to verify with read-only production probes${ownerWhy ? ` instead of the owner (asked: ${ownerWhy})` : ''}. It reaches the owner only if no probe can answer it.`);
          return;
        }
        if (!ownerReason) return;
        store.updateTicket(k, { owner_task: 1, assignee: null });
        store.addComment(k, agentId, `🙋 **This is your task**: ${ownerReason}`);
      };
      const whoFor = (seat) => (toSre ? 'sre (read-only production check)' : ownerReason ? 'the owner' : seat);
      if (PRINCIPALS.includes(agentId)) {
        // A principal's slices: small, built by cheaper seats, attached to the ticket being designed.
        need(run.kind === 'design' && run.ticket_key, 'slices are created during a design run');
        need(['S', 'M'].includes(body.complexity), 'slices must be S or M — split further');
        need(store.childrenOf(run.ticket_key).length < 4, 'at most 4 slices per ticket');
        need(!body.assign || BUILDERS.includes(body.assign), `assign to one of ${BUILDERS.join(', ')}`);
        if (body.after) need(store.getTicket(body.after)?.parent_key && sameTree(body.after, run.ticket_key) && body.after !== run.ticket_key, '--after must name another task of the same feature');
        const parent = store.getTicket(run.ticket_key);
        const slice = store.createTicket({ title: body.title, description: body.body, type: parent.type === 'bug' ? 'bug' : 'task', status: 'todo', area: body.area,
          complexity: body.complexity, priority: parent.priority, assignee: body.assign || routeSlice(body), reporter: agentId, source: 'agent', parent_key: run.ticket_key });
        // The slicer is the context reviewer later; slices inherit the parent's risk.
        store.updateTicket(slice.key, { designer: agentId, risk: parent.risk || null, assign_pinned: body.assign ? 1 : 0, ...(body.after ? { after_key: body.after } : {}) });
        asOwnerTask(slice.key);
        ev(`sliced ${slice.key} (${body.complexity}) for ${toSre ? agentById.sre.role : ownerReason ? 'the owner' : agentById[slice.assignee].role}${body.after ? ` after ${body.after}` : ''}`, slice.key);
        github.createIssue(slice.key);
        return `created ${slice.key} → ${whoFor(slice.assignee)}${gateNote}`;
      }
      const parentKey = body.parent || key;
      // The reroute decision uses the risk the task will actually carry (inherited from its parent when not given).
      const effectiveRisk = ['high', 'low'].includes(body.risk) ? body.risk : store.getTicket(parentKey)?.risk || null;
      const explicit = explicitSeat({ ...body, risk: effectiveRisk });
      const assignee = explicit?.seat || routeTicket({ ...body, risk: effectiveRisk });
      // A split's order is enforced, not just described: --after must name another task of the same feature.
      if (body.after) need(store.getTicket(body.after)?.parent_key && sameTree(body.after, parentKey) && body.after !== parentKey, '--after must name another task of the same feature');
      const t = store.createTicket({ title: body.title, description: body.body, type: body.type || 'task', status: 'todo', area: body.area,
        complexity: body.complexity, priority: PRIORITY.test(body.priority) ? body.priority : 'P2', assignee, reporter: agentId, source: 'agent', parent_key: parentKey });
      const parentRisk = store.getTicket(parentKey)?.risk;
      store.updateTicket(t.key, { origin_session: store.getRun(run.id)?.session_id || null, risk: ['high', 'low'].includes(body.risk) ? body.risk : parentRisk || null, assign_pinned: explicit?.pinned ? 1 : 0, ...(body.after ? { after_key: body.after } : {}) });
      if (explicit?.rerouted) store.addComment(t.key, 'system', `Principals design and slice; this ${body.complexity} task goes to ${agentById[assignee].name} instead of ${agentById[explicit.rerouted].name}.`);
      asOwnerTask(t.key);
      ev(`created task ${t.key} for ${toSre ? agentById.sre.role : ownerReason ? 'the owner' : agentById[assignee].role}${body.after ? ` after ${body.after}` : ''}`, t.key);
      github.createIssue(t.key);
      return `created ${t.key} assigned to ${whoFor(assignee)}${gateNote}`;
    }
    case 'design':
      need(ticket && ticket.key === run.ticket_key && run.kind === 'design', 'design only on the ticket you are designing');
      need(body.body, 'design text required (stdin)');
      store.addComment(ticket.key, agentId, `📐 **Design** (${agentById[agentId].name})\n\n${body.body}`);
      ev('recorded the design');
      github.flushComments();
      return 'Design recorded. Now create the slices with desk create-task.';
    case 'delegate': {
      need(ticket && ticket.key === run.ticket_key && run.kind === 'design', 'delegate only the ticket you are designing');
      const kids = store.childrenOf(ticket.key);
      need(kids.length > 0, 'create at least one slice (desk create-task) before delegating');
      need(store.listComments(ticket.key).some((c) => c.body.startsWith('📐')), 'record the design first (desk design)');
      store.addComment(ticket.key, agentId, `🧭 **Delegated** into ${kids.map((k) => `${k.key} (${k.complexity}, ${agentById[k.assignee]?.name})`).join(', ')}\n\n${body.body || ''}`);
      setStatus(ticket.key, 'in_progress', { progress: 5, progress_msg: `delegated: 0/${kids.length} slices merged` });
      ev(`delegated ${ticket.key} into ${kids.length} slices`);
      github.flushComments();
      return 'Delegated. Your run is complete — stop now.';
    }
    case 'split': {
      need(ticket && ticket.key === run.ticket_key && run.kind === 'groom', 'split only the ticket you are grooming');
      need(['proposed', 'todo'].includes(ticket.status), 'only proposed/todo tickets can be split');
      return splitParent(ticket, agentId, body.body, ev);
    }
    case 'reject':
      need(ticket && (ticket.key === run.ticket_key || ticket.parent_key === run.ticket_key) && run.kind === 'groom', 'you can only reject the ticket you are grooming');
      need(['proposed', 'todo'].includes(ticket.status), 'only proposed/todo tickets can be rejected');
      // The old instruction was "split, then reject the parent". A parent with open tasks is an epic, not a rejection.
      if (ticket.key === run.ticket_key && store.childrenOf(ticket.key).some((k) => !['done', 'wontdo'].includes(k.status))) return splitParent(ticket, agentId, body.body, ev);
      store.addComment(ticket.key, agentId, `Closed: ${body.body || 'no reason given'}`);
      setStatus(ticket.key, 'wontdo');
      ev(`rejected ${ticket.key}: ${String(body.body || '').slice(0, 120)}`);
      return 'ok';
    case 'route': {
      need(ticket && ticket.key === run.ticket_key && run.kind === 'triage', 'you can only route the ticket you were given');
      need(ticket.status === 'triage', 'ticket must be in triage');
      need(['pm', 'manager', 'human'].includes(body.to), 'route to pm|manager|human');
      const patch = {};
      if (['feature', 'bug', 'task', 'research'].includes(body.type)) patch.type = body.type;
      if (PRIORITY.test(body.priority)) patch.priority = body.priority;
      store.addComment(ticket.key, agentId, `Routed to ${body.to === 'pm' ? 'product' : body.to}: ${body.body || ''}`);
      if (body.to === 'human') setStatus(ticket.key, 'needs_human', { ...patch, resume_status: 'proposed' });
      else setStatus(ticket.key, 'proposed', patch);
      ev(`routed ${ticket.key} → ${body.to}`);
      return 'ok';
    }
    case 'discussion-result': {
      need(run.kind === 'owner_discussion', 'only during an owner discussion');
      const d = store.pendingDiscussions().find((x) => x.run_id === run.id && x.status === 'running');
      need(d, 'no active discussion for this run'); completeDiscussion(d.id, body.body);
      return 'Response recorded on the ticket. Stop now.';
    }
    case 'consult': {
      need(['principal-be', 'principal-fe', 'dba'].includes(body.agent), 'consult principal-be | principal-fe | dba');
      need(body.body, 'question required');
      need(['groom', 'owner_discussion', 'epic_review'].includes(run.kind), 'consults happen during grooming, epic reviews or owner discussions');
      if (run.kind === 'owner_discussion' || run.kind === 'epic_review') {
        const targets = consultTargets.get(run.id) || new Set();
        need(!targets.has(body.agent), 'each principal can be consulted once per discussion');
        need(targets.size < 2, 'at most two principals per discussion');
        targets.add(body.agent); consultTargets.set(run.id, targets);
      }
      consultsByRun.set(run.id, (consultsByRun.get(run.id) || 0) + 1);
      const maxConsults = ['owner_discussion', 'epic_review'].includes(run.kind) ? 2 : config.limits.maxConsultsPerGroom;
      need(consultsByRun.get(run.id) <= maxConsults, `consult limit (${maxConsults}) reached`);
      need(budgetHeadroom() >= runner.runBudget(body.agent), 'daily risk limit reached — groom without a consult');
      need(store.listAgentStates().filter((a) => a.status === 'working').length < capacity() + 1, 'desk at capacity — groom without a consult');
      ev(`🗣 planning discussion with ${agentById[body.agent].role}: ${String(body.body).slice(0, 160)}`);
      const answer = await runner.consult({ agentId: body.agent, ticketKey: key, question: body.body });
      store.logEvent({ agent_id: body.agent, ticket_key: key, kind: 'say', text: `→ Engineering Manager: ${answer.slice(0, 1500)}` });
      if (key) {
        store.addComment(key, 'manager', `🗣 **Asked ${agentById[body.agent].name} (${agentById[body.agent].role}):** ${body.body}`);
        store.addComment(key, body.agent, `💬 ${answer}`);
      }
      return answer;
    }
    case 'submit': {
      need(ticket && ticket.key === run.ticket_key && ticket.status === 'in_progress' && run.kind === 'implement', 'submit only from your implementation run');
      need(!refresh.current(ticket.key) || ['rebased', 'published'].includes(refresh.current(ticket.key).status), 'finish conflicts with desk continue-rebase before submitting');
      const dir = runner.workspaceDir(ticket.key);
      need(await runner.commitsAhead(dir) > 0, 'no commits on your branch yet — git add + git commit your work first');
      const sha = await runner.headSha(dir);
      store.addComment(ticket.key, agentId, `🚀 **Submitted for QA** at \`${sha.slice(0, 10)}\`\n\n${body.body || ''}`);
      store.addContributor(ticket.key, agentId);
      setStatus(ticket.key, 'qa', { head_sha: sha, progress: 90, progress_msg: 'waiting for QA', builder: ticket.builder || agentId });
      ev(`submitted ${ticket.key} for QA (${sha.slice(0, 7)})`);
      github.flushComments();
      return 'Submitted to QA. Your run is complete — stop now.';
    }
    case 'qa': {
      need(ticket && ticket.key === run.ticket_key && ticket.status === 'qa' && run.kind === 'qa', 'ticket is not in QA');
      need(run.nonce && body.code === run.nonce, 'missing or wrong --code (it is in your instructions)');
      need(['pass', 'fail'].includes(body.verdict), 'verdict pass|fail');
      // The verdict is also a fact for report cards: who built the change, on which model, and why it failed.
      const builder = ticket.builder || ticket.assignee || null;
      const fact = { ticket_key: ticket.key, run_id: run.id, sha: ticket.head_sha, builder, model: builder ? store.lastBuildRun(ticket.key, builder)?.model || null : null, complexity: ticket.complexity, area: ticket.area };
      if (body.verdict === 'fail') {
        need(store.QA_REASONS.includes(body.reason), `--reason ${store.QA_REASONS.join('|')} required: bug (the change is wrong), tests (missing or failing tests), spec (the ticket was unclear), base (the base branch is broken), flaky (a test fails intermittently; say how you know)`);
        const lesson = body.lesson ? store.getLesson(Number(String(body.lesson).replace(/^#/, ''))) : null;
        need(!body.lesson || lesson?.status === 'active', `--lesson must name an active lesson id`);
        need(!lesson || store.exposedLessons(ticket.key).has(lesson.id), `lesson #${lesson?.id} was not in this task's instructions, so it cannot be a repeat; describe the defect without --lesson`);
        const loops = (ticket.qa_loops || 0) + 1;
        // The verdict fact, its comment, the hand-back and the event commit together: a failure leaves none of them.
        store.transaction(() => {
          store.recordQaVerdict({ ...fact, verdict: 'fail', reason: body.reason, lesson_id: lesson?.id ?? null });
          store.addComment(ticket.key, agentId, `❌ **QA failed** (round ${loops}, ${body.reason}${lesson ? `, repeats lesson #${lesson.id}` : ''})\n\n${body.body || ''}`);
          if (loops > config.limits.maxQaLoops) setStatus(ticket.key, 'needs_human', { qa_loops: loops, resume_status: 'todo', progress_msg: 'QA failed repeatedly' });
          else setStatus(ticket.key, 'todo', { qa_loops: loops, progress: 50, progress_msg: 'fixing QA findings' });
          ev(`QA failed ${ticket.key}`);
        });
        teamStats.invalidate();
        github.flushComments();
        return 'Recorded. Stop now.';
      }
      // Evidence gate: QA must have actually run a test/build command successfully in this run.
      const ran = runner.evidenceFor(run.id);
      // Documentation-only changes have nothing to execute: the diff itself (from the desk's publisher) is the evidence.
      const docsOnly = await runner.headSha(runner.workspaceDir(ticket.key))
        .then((sha) => runner.stageApproved(ticket.key, runner.workspaceDir(ticket.key), sha))
        .then(({ files }) => files.length > 0 && files.every(isDocPath), () => false); // any doubt → not docs-only
      need(docsOnly || ran.some((e) => e.ok && isTestCommand(e.cmd)), `no passing test run in your session yet — run the relevant tests (e.g. ${ran.length ? 'the playbook test command' : 'pytest / npm test'}) and pass only if they succeed`);
      // The verdict only counts for the exact commit that was submitted.
      const sha = await runner.headSha(runner.workspaceDir(ticket.key));
      need(!ticket.head_sha || sha === ticket.head_sha, `HEAD moved since submission (${sha.slice(0, 7)} ≠ ${String(ticket.head_sha).slice(0, 7)}); QA must not commit`);
      store.transaction(() => {
        need(store.getTicket(ticket.key)?.status === 'qa', 'the ticket left QA while you were checking it'); // re-checked after the async checks
        refresh.recordQa(ticket.key, sha);
        store.recordQaVerdict({ ...fact, sha, verdict: 'pass' });
        store.addComment(ticket.key, agentId, `✅ **QA passed** at \`${sha.slice(0, 10)}\`\n\n${body.body || ''}`);
        ev(`QA passed ${ticket.key}`);
      });
      teamStats.invalidate();
      const seat = requesterOf(ticket);
      if (reviews.enabled()) {
        // Publish the draft PR now (guard unchanged), then two sequential code reviews on this exact commit.
        await reviews.afterQaPass(ticket, sha);
        publishBranch(ticket.key);
      } else if (seat) {
        setStatus(ticket.key, 'review', { progress: 95, progress_msg: `QA passed — ${agentById[seat].name} confirming intent` });
      } else {
        setStatus(ticket.key, 'ready_for_human', { progress: 100, progress_msg: 'QA passed — awaiting owner review' });
        publishBranch(ticket.key);
      }
      github.flushComments();
      return 'Recorded. Stop now.';
    }
    case 'accept': {
      need(ticket && ticket.key === run.ticket_key && ticket.status === 'review' && run.kind === 'review', 'ticket is not awaiting your acceptance');
      need(run.nonce && body.code === run.nonce, 'missing or wrong --code (it is in your instructions)');
      need(requesterOf(ticket) === agentId, 'only the requester accepts this ticket');
      need(['pass', 'changes'].includes(body.verdict), 'verdict pass|changes');
      if (body.verdict === 'changes') {
        const loops = (ticket.qa_loops || 0) + 1;
        store.addComment(ticket.key, agentId, `🔁 **Changes requested by ${agentById[agentId].name}** (round ${loops})\n\n${body.body || ''}`);
        if (loops > config.limits.maxQaLoops) setStatus(ticket.key, 'needs_human', { qa_loops: loops, resume_status: 'todo', progress_msg: 'review loop limit hit' });
        else setStatus(ticket.key, 'todo', { qa_loops: loops, progress: 50, progress_msg: 'addressing requester feedback' });
        ev(`requested changes on ${ticket.key}`);
        github.flushComments();
        return 'Recorded. Stop now.';
      }
      // A Perplexity review only counts if the model saw the whole change (the desk checked what was sent).
      if (String(run.model || '').startsWith('perplexity:')) {
        const blocked = packs.acceptBlockers(packs.metaFor(run));
        if (blocked) ev(`pass refused: ${blocked.slice(0, 200)}`);
        need(!blocked, blocked);
      }
      const sha = await runner.headSha(runner.workspaceDir(ticket.key));
      need(!ticket.head_sha || sha === ticket.head_sha, 'HEAD moved since QA; reviewers must not commit');
      store.addComment(ticket.key, agentId, `🤝 **Accepted by ${agentById[agentId].name}** (${agentById[agentId].role})\n\n${body.body || ''}`);
      setStatus(ticket.key, 'ready_for_human', { progress: 100, progress_msg: 'accepted — awaiting owner review' });
      ev(`accepted ${ticket.key}`);
      github.flushComments();
      publishBranch(ticket.key);
      return 'Recorded. Stop now.';
    }
    case 'ops':
      // Production read probes: gating (setting, seat, run kind), budgets and redaction live in ops.js, so the socket
      // and the mailbox transport get exactly the same answer.
      return ops.handle(run, body);
    case 'access': {
      // EM and SRE review who has production read access: list, decide requests within the owner's policy, revoke.
      const a = String(body.action || 'list');
      if (a === 'list') return access.listText();
      need(body.id && /^\d+$/.test(String(body.id)), `desk access ${a} <id> "<why>"`);
      if (a === 'revoke') { need(body.body, 'say why'); return access.revoke(body.id, agentId, String(body.body)); }
      need(['approve', 'deny', 'owner'].includes(a), 'desk access list|approve|deny|owner|revoke');
      const ticketScoped = body.ticket === true || body.ticket === 'true' ? true : null;
      return access.decide(agentId, body.id, a, { minutes: ticketScoped ? null : access.parseDuration(body.for), ticketScoped, note: String(body.body || ''), runId: run.id });
    }
    case 'verify': {
      need(run.kind === 'verify' && ticket && ticket.key === run.ticket_key, 'desk verify only works inside a verify run on its own ticket');
      need(['done', 'owner'].includes(body.action), 'desk verify done|owner "<text>"');
      need(body.body, 'say what you found (done) or why no read-only probe can answer it (owner)');
      if (body.action === 'done') {
        // "Verified" must rest on evidence: at least one successful, audited probe in THIS run.
        need(store.opsSucceededInRun(run.id) > 0, 'no successful production probe in this run yet: run the desk ops probe that answers the question first (or desk verify owner "<why>")');
        store.addComment(ticket.key, agentId, `🔎 **Verified in production (read-only probes):** ${body.body}`);
        store.kvSet(`verify:${ticket.key}`, 'done');
        setStatus(ticket.key, 'done', { progress: 100, progress_msg: 'verified in production' });
        ev(`verified in production: ${String(body.body).slice(0, 140)}`);
        github.flushComments();
        return 'Recorded; the tasks waiting on this check can start. Stop now.';
      }
      store.kvSet(`verify:${ticket.key}`, '');
      store.updateTicket(ticket.key, { owner_task: 1, assignee: null, status: 'todo' });
      store.addComment(ticket.key, agentId, `🙋 **This is your task**: ${body.body}\n\n_(The SRE's read-only production probes could not answer it.)_`);
      ev(`handed to the owner: ${String(body.body).slice(0, 140)}`);
      github.flushComments();
      return 'Handed to the owner. Stop now.';
    }
    case 'review':
      return reviews.reviewVerdict(run, ticket, body);
    case 'respond':
      return reviews.respond(run, ticket, body);
    case 'resolve':
      return mergetrain.resolveCommand(run, ticket, body);
    case 'incident': {
      need(run.kind === 'investigate' && run.incident_id, 'incident commands only work inside an investigation');
      const inc = store.getIncident(run.incident_id);
      need(inc && inc.status === 'investigating', 'incident already decided');
      need(['file', 'mute', 'page'].includes(body.action), 'desk incident file|mute|page');
      if (body.action === 'mute') {
        need(body.body, 'say why it is noise');
        if (inc.count >= (config.watch.muteNeedsOwnerAbove ?? 20)) {
          const t = pageOwner([inc], `SRE wants to mute a frequent signature (${inc.count}×): ${body.body}`);
          return `Frequent signatures need the owner's OK to mute; asked them in ${t.key}. Stop now.`;
        }
        store.updateIncident(inc.id, { status: 'muted', note: String(body.body).slice(0, 500) });
        store.logEvent({ run_id: run.id, agent_id: agentId, kind: 'action', text: `muted incident #${inc.id}: ${String(body.body).slice(0, 140)}` });
        return 'Muted. Stop now.';
      }
      if (body.action === 'page') {
        need(body.body, 'say why the owner must act');
        const t = pageOwner([inc], body.body);
        return `Paged the owner (${t.key}). Stop now.`;
      }
      need(body.title && body.body, 'title and body (stdin) required');
      const t = store.createTicket({ title: body.title, type: 'bug', status: 'proposed', reporter: 'sre', source: 'watch',
        priority: PRIORITY.test(body.severity) ? body.severity : 'P2', area: AREAS.includes(body.area) ? body.area : null,
        description: `${body.body}\n\n<details><summary>Evidence (incident #${inc.id})</summary>\n\n${incidentEvidence(inc).replace(/<\/?log-[a-z]+[^>]*>/g, '```')}\n</details>` });
      store.updateTicket(t.key, { origin_session: store.getRun(run.id)?.session_id || null });
      store.updateIncident(inc.id, { status: 'ticketed', ticket_key: t.key });
      store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: t.key, kind: 'action', text: `filed ${t.key} from incident #${inc.id}` });
      return `Filed ${t.key}; the manager will groom it. Stop now.`;
    }
    default:
      throw Object.assign(new Error(`unknown command ${cmd}`), { status: 404 });
  }
}

/**
 * Real work from a tagged run goes into the jobs that already exist, never around them. A gate that stops it is said in
 * the thread in plain language (once per tag and gate) and refused to the seat with the same words.
 */
function mentionHandoff(run, m, t, body, ev) {
  const seat = run.agent_id, name = agentById[seat].name.split(/\s+/)[0];
  const what = String(body.body || '').trim();
  const action = String(body.action || '');
  need(['implement', 'design', 'verify', 'task', 'merge', 'deploy'].includes(action), 'desk handoff implement|design|verify|task|merge|deploy "<what>"');
  const gate = (code, text) => {
    const k = `mention-gate:${m.id}:${code}`;
    if (!store.kvGet(k)) { store.kvSet(k, '1'); store.addComment(t.key, 'system', `🚧 ${text}`); github.flushComments(); }
    need(false, `${text} (Say this in your desk reply.)`);
  };
  if (['merge', 'deploy'].includes(action)) gate(action, mentions.mergeNeeds(t, seat, action));
  need(what, 'say what should be done');
  need(!m.routed, `you already routed this tag (${m.routed}); one handoff per tag`);
  const closed = ['done', 'wontdo'].includes(t.status);
  const routed = (kind, note) => {
    store.transaction(() => {
      store.addComment(t.key, 'system', note);
      store.updateMention(m.id, { routed: kind, status: 'replied', ended_at: store.now() });
    });
    ev(`routed the owner's tag: ${kind}`);
    github.flushComments();
  };
  if (action === 'implement' || action === 'design') {
    if (closed) gate('closed', `${name} can't change ${t.key}: it is closed. Reopen it first.`);
    if (t.owner_task) gate('owner_task', `${t.key} is your own task, so no seat builds it. Hand it back to the team first.`);
    if (t.status === 'needs_human') gate('hold', `${name} can't start on ${t.key} yet: it is waiting for your answer (${t.progress_msg || 'a question'}). Answer it first; the tag does not resume it.`);
    if (['triage', 'proposed'].includes(t.status)) gate('groom', `${t.key} has not been groomed yet, so nobody can build it: the manager sizes and staffs it first.`);
    if (t.active_run || t.status === 'in_progress') gate('busy', `${name} can't start a change on ${t.key} while ${agentById[t.assignee]?.name || 'its builder'} is working on it. Tag them again when the run settles.`);
    if (['qa', 'review', 'ready_for_human'].includes(t.status)) gate('review', `${t.key} is ${t.status === 'qa' ? 'in QA' : t.status === 'review' ? 'in code review' : 'waiting for your review'}: a change now would void QA and both reviews. Request changes on the review instead.`);
    need(t.status === 'todo', `${t.key} is ${t.status}`);
    const author = authorOf(t);
    if (action === 'design') {
      if (!PRINCIPALS.includes(seat)) gate('design', `Designing and slicing is a principal's job (${PRINCIPALS.map((p) => agentById[p].name).join(' or ')}); ${name} can't take it.`);
      if (author || (t.assign_pinned && t.assignee && t.assignee !== seat)) gate('assigned', `${t.key} is ${author ? `already built by ${agentById[author]?.name || author}` : `pinned to ${agentById[t.assignee]?.name || t.assignee}`}; ${name} can't take its design over.`);
      store.updateTicket(t.key, { assignee: seat, assign_pinned: 1 });
      routed('design', `📐 ${name} takes the design of ${t.key}, as the owner asked: ${what}\n\nThey design and slice it in a design run; the slices are built, QA'd and reviewed as usual.`);
      return `Routed: you design ${t.key} in a design run once this run ends. Reply to the owner now, then stop.`;
    }
    // A builder takes the change when the ticket is free (nobody built it, not pinned to someone else). Otherwise the
    // ticket's own builder gets it; principals and other seats pass it on.
    const free = !author && (!t.assign_pinned || t.assignee === seat);
    if (BUILDERS.includes(seat) && (free || author === seat)) {
      store.updateTicket(t.key, { assignee: seat, assign_pinned: 1 });
      routed('implement', `🛠 ${name} takes the change the owner asked for on ${t.key}: ${what}\n\nIt goes through QA, two code reviews and the merge train as usual.`);
      return `Routed: you build it in an implementation run once this run ends (submit → QA → reviews). Reply to the owner now, then stop.`;
    }
    const owner = author || t.assignee;
    routed('implement', `🛠 ${name} passed the owner's change to ${owner ? agentById[owner]?.name || owner : 'the team'}: ${what}\n\nIt is built on ${t.key} and goes through QA, two code reviews and the merge train as usual.`);
    return `Routed to ${owner ? agentById[owner]?.name || owner : 'the team'}; the change is in the thread they read. Reply to the owner now, then stop.`;
  }
  if (action === 'verify') {
    if (!verifyReady()) gate('verify', `Nobody on the team can read production right now (production read access is off, or the SRE is switched off), so this check is yours: ${what}`);
    const v = store.createTicket({ title: String(body.title || `Verify in production: ${what}`).slice(0, 200), description: `${what}\n\nAsked by the owner on ${t.key} (tagged ${agentById[seat].name}).`,
      type: 'task', status: 'todo', area: 'infra', complexity: 'S', priority: t.priority, assignee: 'sre', reporter: seat, source: 'agent' });
    store.updateTicket(v.key, { assign_pinned: 1 });
    store.kvSet(`verify:${v.key}`, '1');
    store.addComment(v.key, 'system', `🔎 Routed to ${agentById.sre.name} (SRE) to verify with read-only production probes. Asked from ${t.key}.`);
    routed(`verify:${v.key}`, `🔎 ${agentById.sre.name} checks it in production with read-only probes: ${v.key}. Its answer lands there.`);
    return `Filed ${v.key} for the SRE. Reply to the owner now, then stop.`;
  }
  // New work: the manager and principals file it as a proposal the manager grooms (normal routing, every gate intact).
  if (!['manager', ...PRINCIPALS].includes(seat)) gate('task', `${name} can't file new work; the manager (${agentById.manager.name}) plans new work. Tag ${agentById.manager.name} to file it.`);
  need(body.title, '--title required');
  const n = store.createTicket({ title: String(body.title).slice(0, 200), description: `${what}\n\nAsked by the owner on ${t.key} (tagged ${agentById[seat].name}).`, type: 'task', status: 'proposed',
    priority: t.priority || 'P2', reporter: seat, source: 'agent' });
  routed(`task:${n.key}`, `🗂 ${name} filed the new work as ${n.key}; the manager grooms and staffs it as usual.`);
  github.createIssue(n.key);
  return `Filed ${n.key}; the manager grooms it. Reply to the owner now, then stop.`;
}

const publishing = new Set();
async function publishBranch(key) {
  const t = store.getTicket(key);
  if (store.getSettings().open_draft_prs !== 'true' || store.getSettings().github_sync !== 'true') return;
  // A PR that exists is updated when the QA-approved commit changed (review fixes, desk updates, branch refresh).
  if (publishing.has(key) || (t.pr_url && store.kvGet(`published:${key}`) === t.head_sha && refresh.current(key)?.status !== 'rebased')) return;
  publishing.add(key);
  try { await publishInner(t, key); } finally { publishing.delete(key); }
}

// Crash or transient GitHub failure after QA: retry publishing tickets that are ready but have no PR.
export async function ownerApprovePublish(key) {
  const t = store.getTicket(key);
  need(t && t.head_sha && store.kvGet(`guard:${key}`) === t.head_sha, 'nothing awaiting publish approval for this commit');
  if (t.active_run || store.reservationOf(key)) throw Object.assign(new Error('The desk is working on this branch (a refresh or merge); approve once it settles.'), { status: 409 });
  store.kvSet(`guard:${key}`, ''); // one approval per parked commit
  store.kvSet(`publish-approved:${key}`, t.head_sha); // a transient push failure must not re-guard the approved commit
  store.addComment(key, 'owner', `✅ Publish approved for \`${t.head_sha.slice(0, 10)}\` despite the guard.`);
  const inReview = reviews.enabled() && t.review_stage === 'reviewing';
  setStatus(key, inReview ? 'review' : 'ready_for_human', { resume_status: null, progress_msg: inReview ? 'owner approved publish — code review continues' : 'owner approved publish' });
  if (publishing.has(key)) return;
  publishing.add(key);
  try { await publishInner(store.getTicket(key), key, { ownerApproved: true }); } finally { publishing.delete(key); }
}

export function retryPublications() {
  // Whenever GitHub may not have the QA-approved commit: no PR yet, the PR holds an older commit (approved PRs too),
  // or an owner-triggered branch refresh passed QA and still has to be pushed.
  for (const t of [...store.ticketsByStatus('ready_for_human'), ...store.ticketsByStatus('review')]) {
    if (t.status === 'review' && !t.review_stage) continue;
    if (t.head_sha && (!t.pr_url || store.kvGet(`published:${t.key}`) !== t.head_sha || refresh.current(t.key)?.status === 'rebased')) publishBranch(t.key);
  }
}

/** One publication attempt, without the settings and retry gates (tests). */
export const publishOnce = (key) => publishInner(store.getTicket(key), key);
/** Visible to the owner's step and the program update: what failed, how often, for which commit. */
function recordPublishError(t, key, message) {
  let prev = null; try { prev = JSON.parse(store.kvGet(`publish-error:${key}`) || 'null'); } catch { prev = null; }
  store.kvSet(`publish-error:${key}`, JSON.stringify({ head: t.head_sha, message: store.redact(String(message)).slice(0, 240), at: store.now(), count: (prev?.head === t.head_sha ? prev.count : 0) + 1 }));
}

async function publishInner(t, key, { ownerApproved = false } = {}) {
  const plan = productReview.current(t.parent_key || key);
  if (plan || productReview.current(key, 'feedback')) {
    if (productReview.blocks(t)) return;
    if (t.active_run || store.unfinishedRuns().some(r => r.ticket_key === key)) return;
    const feedback = productReview.ensure(t, 'feedback');
    if (feedback.stale || feedback.status !== 'approved') return;
  }
  let staged;
  try {
    staged = await runner.stageApproved(key, runner.workspaceDir(key), t.head_sha);
  } catch (err) {
    store.logEvent({ kind: 'error', ticket_key: key, text: `publish staging failed: ${err.message}` });
    recordPublishError(t, key, `preparing the commit failed: ${err.message}`);
    return;
  }
  if (!ownerApproved && store.kvGet(`publish-approved:${key}`) !== t.head_sha) {
    const { files, lines } = staged;
    const reasons = guardReasons(files, lines, t.complexity);
    if (reasons.length) {
      store.kvSet(`guard-reasons:${key}`, JSON.stringify({ head: t.head_sha, reasons, lines, complexity: t.complexity || null }));
      store.addComment(key, 'system', `🛑 **Publish guard** — not pushed: ${reasons.join('; ')}.\nReview the branch locally (${runner.workspaceDir(key)}) and press "Approve publish" if it is safe.`);
      setStatus(key, 'needs_human', { resume_status: reviews.enabled() && t.review_stage === 'reviewing' ? 'review' : 'ready_for_human', progress_msg: 'publish guard: needs owner approval' });
      store.kvSet(`guard:${key}`, t.head_sha);
      return;
    }
  }
  const freshQa = refresh.validationBlockers(key, t.head_sha, staged.baseSha);
  if (freshQa.length) {
    setStatus(key, 'needs_human', { resume_status: 'todo', progress_msg: 'base changed — refresh and rerun QA' });
    store.addComment(key, 'system', `Publication held: ${freshQa.join('; ')}. Use Refresh branch to revalidate against the new base.`);
    return;
  }
  try {
    if (!t.issue_number) await github.createIssue(key);
    await runner.pushBranch(key, t.branch, t.head_sha, { lease: refresh.current(key)?.remote_head });
    if (refresh.current(key)) refresh.published(key, t.head_sha);
    store.kvSet(`published:${key}`, t.head_sha);
    store.logEvent({ kind: 'github', ticket_key: key, agent_id: 'github', text: `pushed ${t.branch} at ${t.head_sha.slice(0, 7)}` });
    if (t.pr_url) { store.kvSet(`publish-error:${key}`, ''); github.flushOutbox(); return; } // existing PR: the push updated it; its discussion and reviews stay
    const cs = store.listComments(key);
    const last = (prefix) => cs.filter((c) => c.body.startsWith(prefix)).pop()?.body.replace(/^[^\n]*\n*/, '') || '';
    const stack = await prsync.stackBaseFor(store.getTicket(key));
    if (stack) store.addComment(key, 'system', `🧱 Contains unmerged commits from ${stack.key}, so the draft PR targets its branch (\`${stack.branch}\`) and shows only this ticket's changes. GitHub retargets it to ${config.project.baseBranch} when ${stack.key} merges.`);
    await github.openDraftPr(key, [stack ? `> Stacked on #${stack.pr} (${stack.key}) — merge that first.` : '', `## Summary\n${last('🚀')}`, `## QA (correctness)\n${last('✅')}`, last('🤝') ? `## Acceptance (requester intent)\n${last('🤝')}` : ''].filter(Boolean).join('\n\n'), stack ? { base: stack.branch } : {});
    // openDraftPr reports failures in the activity log and returns nothing: the PR must exist for this to count.
    if (store.getTicket(key)?.pr_url) store.kvSet(`publish-error:${key}`, '');
    else recordPublishError(t, key, 'GitHub did not open the pull request (see the activity log)');
  } catch (err) {
    if (refresh.current(key) && /stale info|\[rejected\]/i.test(String(err.stderr || err.message)))
      setStatus(key, 'needs_human', { resume_status: 'todo', progress_msg: 'remote branch changed — reconcile before publishing' });
    store.logEvent({ kind: 'error', ticket_key: key, text: `publish failed: ${err.message}` });
    recordPublishError(t, key, err.message);
  }
}

// Red CI on a draft PR: back to the engineer with the failing checks (counts as a review round).
export function prChecksFailed(t, names) {
  const loops = (t.qa_loops || 0) + 1;
  store.addComment(t.key, 'system', `❌ **CI failed on the draft PR**: ${names}. Fix and resubmit.`);
  if (loops > config.limits.maxQaLoops) setStatus(t.key, 'needs_human', { qa_loops: loops, resume_status: 'todo', progress_msg: 'CI keeps failing' });
  else setStatus(t.key, 'todo', { qa_loops: loops, pr_url: null, progress: 50, progress_msg: `CI failed: ${names}`.slice(0, 200) });
}

// ---------------- owner (UI) actions ----------------
/**
 * The owner asks for work (the New ticket dialog, or an instruction sent from the Projects home).
 * `kind`: 'feature' → a feature planned with Codex before anything starts; 'task' (and any instruction) → a task that
 * triage routes. `request_id` makes a retry (double tap, hub timeout, hub restart) return the ticket it already made.
 */
export function ownerCreate(body) {
  need(body.title, 'title required');
  need(typeof body.title === 'string' && body.title.trim().length <= 200, 'a title of at most 200 characters');
  need(body.description === undefined || (typeof body.description === 'string' && body.description.length <= 12_000), 'at most 12000 characters');
  need(body.kind === undefined || ['auto', 'task', 'feature'].includes(body.kind), 'kind must be auto, task or feature');
  const rid = typeof body.request_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.request_id) ? body.request_id : null;
  // The same request id with the same request returns its ticket; with a different request it is refused.
  const hash = crypto.createHash('sha256').update(JSON.stringify([body.title, body.description || '', body.kind || '', body.priority || '', body.type || '', body.area || '', body.source || ''])).digest('hex');
  const seen = rid ? (() => { try { return JSON.parse(store.kvGet(`request:${rid}`) || 'null'); } catch { return null; } })() : null;
  if (seen) {
    if (seen.hash !== hash) throw Object.assign(new Error('That request id was already used for a different request'), { status: 409 });
    if (store.getTicket(seen.key)) return { ...store.getTicket(seen.key), duplicate: true };
  }
  const source = body.source === 'hub' ? 'hub' : 'human';
  // A priority the owner chose (anything but the form's default P2) is theirs: grooming and reviews leave it alone.
  const chosen = PRIORITY.test(body.priority) && body.priority !== 'P2' && source === 'human';
  const remember = (t) => {
    if (rid) store.kvSet(`request:${rid}`, JSON.stringify({ key: t.key, hash, at: store.now() }));
    if (chosen) store.updateTicket(t.key, { priority_pinned: 1 });
    return store.getTicket(t.key);
  };
  // A feature is created (and its planning round announced) by features.create on its own, then remembered.
  if (body.kind === 'feature') return remember(features.create({ title: body.title, goal: body.description || body.title, priority: body.priority, area: body.area, source }).ticket);
  return store.transaction(() => remember(store.createTicket({ title: body.title, description: body.description || '', type: body.type || (body.kind ? 'task' : 'feature'), status: 'triage',
    priority: PRIORITY.test(body.priority) ? body.priority : 'P2', reporter: 'owner', source })));
}

export async function ownerRefreshBase(key, { expected_updated_at } = {}) {
  const t = store.getTicket(key);
  need(t?.head_sha && t.pr_url && ['needs_human', 'ready_for_human', 'todo'].includes(t.status), 'Refresh needs a submitted PR awaiting work or owner review');
  if (expected_updated_at && expected_updated_at !== t.updated_at) throw Object.assign(new Error('The ticket changed. Read it before refreshing.'), { status: 409 });
  if (t.active_run || store.unfinishedRuns().some((r) => r.ticket_key === key)) throw Object.assign(new Error('Wait for this ticket’s workers to finish before refreshing.'), { status: 409 });
  need(!['merging', 'merge_unknown'].includes(t.review_stage) && !mergetrain.activeIntentFor(key), 'A merge of this PR is in progress or being confirmed with GitHub; wait for it to settle');
  need(!store.conflictJobsFor(key).some((j) => ['pending', 'running'].includes(j.status)), 'The builder is resolving a merge conflict on this branch; wait for it to finish');
  // The ticket reservation is taken before anything else (and before any await): no merge can start meanwhile.
  const res = store.reserve(key, 'refresh', 'owner branch refresh');
  if (!res.ok) throw Object.assign(new Error(`This PR is busy (${res.holder.note || res.holder.kind}); wait for it to finish.`), { status: 409 });
  store.updateTicket(key, { active_run: -1, status: 'needs_human', progress_msg: 'desk refreshing remote base' });
  // The parked commit is about to be replaced: no approval may push it meanwhile (restored if the refresh fails).
  const parked = store.kvGet(`guard:${key}`);
  store.kvSet(`guard:${key}`, '');
  try {
    if (store.getSettings().github_sync === 'true') await prs.assertRefreshable(prNumberOf(t.pr_url), t);
    const r = await refresh.prepare(t, { reservation: res.token });
    store.kvSet(`guard:${key}`, '');
    store.addComment(key, 'owner', `Approved desk-owned branch refresh. Original commit \`${r.original_head}\` preserved; remote lease \`${r.remote_head}\`; refreshed base \`${r.base}\`. Previous QA is historical. Final merge still requires owner review.`);
    store.addComment(key, 'system', refresh.instructions(r));
    // Same rule as the merge train: a rewritten branch voids QA and both reviewer approvals; the queue spot is kept.
    store.transaction(() => {
      store.supersedeReviews(key, null);
      setStatus(key, 'todo', { active_run: null, head_sha: null, resume_status: null, stalls: 0, review_stage: null, merge_after: null,
        reconfirm_from: null, reconfirm_kind: null, reconfirm_base: null, qa_sha: null,
        progress: 50, progress_msg: r.status === 'conflicts' ? 'refreshed — engineer resolving conflicts' : 'rebased — waiting for fresh tests and QA' });
    });
    if (t.pr_url) {
      store.enqueueOutbox(key, `${key}:refresh:${r.base}:${r.original_head}`, `🔄 **The owner refreshed this branch onto \`${config.project.baseBranch}\`** (\`${String(r.base).slice(0, 7)}\`). Earlier QA and both reviewer approvals no longer count: the engineer re-runs the tests, QA checks the new commit, and the reviewers look again before it can merge.\n\n<sub>SigmaDesk ${key}</sub>`);
      github.flushOutbox();
    }
    github.flushComments();
    return { ticket: store.getTicket(key), refresh: refresh.publicState(key) };
  } catch (err) {
    if (refresh.current(key)?.reservation !== res.token) store.releaseReservation(key, res.token); // nothing to keep
    // Put the ticket back exactly as it was (a publish-guard hold must stay recognisable); the reason goes in the thread.
    store.updateTicket(key, { active_run: null, status: t.status, progress_msg: t.progress_msg });
    if (parked) store.kvSet(`guard:${key}`, parked);
    store.addComment(key, 'system', `🔄 The branch refresh did not run: ${store.redact(err.message).slice(0, 300)}. Nothing changed on the branch.`);
    throw err;
  }
}

/**
 * The owner writes on a ticket. `mentions` (seat ids from the picker) is authoritative; without it the text is parsed
 * for @Name / @seat-id. Tagging saves the comment, the participants and one delivery per seat in one transaction, and
 * preserves any hold (an answer still goes through the answer path). `request_id` makes a retry return what it made.
 */
export function ownerReply(key, text, mode = 'auto', { expected_updated_at, mentions: explicit, request_id } = {}) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  need(typeof text === 'string' && text.trim(), 'empty reply');
  need(text.length <= 8000, 'message must be at most 8000 characters');
  need(['auto', 'discussion', 'answer', 'comment'].includes(mode), 'invalid message destination');
  need(request_id === undefined || request_id === null || (typeof request_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(request_id)), 'request_id must be 8-64 letters, digits, - or _');
  const tagged = mentions.resolveMentions(text, explicit);
  const hash = crypto.createHash('sha256').update(JSON.stringify([key, text, mode, tagged])).digest('hex');
  if (request_id) {
    let seen = null; try { seen = JSON.parse(store.kvGet(`reply-request:${request_id}`) || 'null'); } catch { seen = null; }
    if (seen) {
      if (seen.hash !== hash) throw Object.assign(new Error('That request id was already used for a different message'), { status: 409 });
      return { ...store.getTicket(key), duplicate: true, comment_id: seen.comment_id, message_route: seen.route, mentions: store.mentionsOfComment(seen.comment_id), discussion: seen.discussion ? store.getDiscussion(seen.discussion) : null };
    }
  }
  if (tagged.length) {
    if (['done', 'wontdo'].includes(t.status)) throw Object.assign(new Error(`${key} is closed. Reopen it first, then tag people.`), { status: 409, code: 'ticket_closed' });
    const recent = mentions.recentCount(key);
    if (recent + tagged.length > mentions.maxPerHour()) throw Object.assign(new Error(`Too many tags on ${key}: ${recent} in the last hour (limit ${mentions.maxPerHour()}). Wait a little, or tag fewer people.`), { status: 429, code: 'mention_rate' });
  }
  // A tag in "auto" is a message to those seats: it never starts a design discussion and never resumes a hold.
  const route = tagged.length && mode === 'auto' ? 'mention' : null;
  const discussion = !route && (mode === 'discussion' || mode === 'auto' && /\b(discuss|debate|design review|architecture review)\b/i.test(text) && /\b(manager|principal|principals|team)\b/i.test(text));
  if (discussion) need(store.pendingDiscussions().length < 20, 'discussion queue is full');
  // An answer resumes whatever hold the ticket is in now: it must be the hold the owner read (same stale guard as decisions).
  if (!route && !discussion && mode !== 'comment' && expected_updated_at && expected_updated_at !== t.updated_at)
    throw Object.assign(new Error('The question changed. Read the latest ticket before answering.'), { status: 409 });
  let request = null, comment = null, deliveries = [];
  store.transaction(() => {
    comment = store.addComment(key, 'owner', text);
    if (tagged.length) {
      store.addParticipants(key, tagged, 'owner');
      deliveries = tagged.map((seat) => {
        const why = mentions.blockReason(seat);
        return store.createMention({ ticket_key: key, comment_id: comment.id, seat_id: seat, origin: 'owner', status: why ? 'blocked' : 'queued', reason: why });
      });
    }
    if (discussion) request = store.createDiscussion(key, String(text).slice(0, 8000));
    if (request_id) store.kvSet(`reply-request:${request_id}`, JSON.stringify({ hash, comment_id: comment.id, route: route || (discussion ? 'discussion' : mode === 'comment' ? 'comment' : 'answer'), discussion: request?.id || null, at: store.now() }));
  });
  store.requeueOutbox(key); // an owner reply retries PR comments that had given up
  if (discussion) store.logEvent({ ticket_key: key, agent_id: 'system', kind: 'system', text: `Sent to the Engineering Manager as design discussion #${request.id}. The ticket keeps its current state.` });
  else if (!route && mode !== 'comment' && t.status === 'needs_human' && researchReview.held(t)) researchReview.ownerDecide(t, 'correction', text); // an answer to a held proposal sends it back with these notes
  else if (!route && mode !== 'comment' && t.status === 'needs_human') setStatus(key, t.resume_status || 'todo', { resume_status: null, stalls: 0 });
  github.flushComments();
  return { ...store.getTicket(key), comment_id: comment.id, message_route: route || (discussion ? 'discussion' : mode === 'comment' ? 'comment' : 'answer'), discussion: request, mentions: deliveries };
}

/** The owner adds (or removes) people on a ticket without writing a message: participants only, no work starts. */
export function ownerParticipants(key, { add = [], remove = [] } = {}) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  need(Array.isArray(add) && Array.isArray(remove), 'add and remove must be lists of seat ids');
  for (const id of [...add, ...remove]) need(typeof id === 'string' && agentById[id], `unknown seat "${String(id).slice(0, 40)}"`);
  store.transaction(() => { store.addParticipants(key, add, 'owner'); for (const id of remove) store.removeParticipant(key, id); });
  return store.participantsOf(key);
}

/** The owner retries a tag that failed or was blocked, or cancels one that has not answered yet. */
export function ownerMention(id, action) {
  const m = store.getMention(Number(id));
  need(m, 'no such tag');
  if (action === 'retry') {
    need(['failed', 'blocked', 'cancelled'].includes(m.status), 'only a failed, blocked or cancelled tag can be retried');
    const t = store.getTicket(m.ticket_key);
    if (['done', 'wontdo'].includes(t?.status)) throw Object.assign(new Error(`${m.ticket_key} is closed. Reopen it first.`), { status: 409, code: 'ticket_closed' });
    const why = mentions.blockReason(m.seat_id);
    need(!why, why);
    store.logEvent({ agent_id: 'owner', kind: 'system', text: `${m.ticket_key}: retried your tag for ${agentById[m.seat_id]?.name}.` });
    return store.updateMention(m.id, { status: 'queued', reason: null, attempts: 0, run_id: null, ended_at: null });
  }
  if (action === 'cancel') {
    need(mentions.OPEN.includes(m.status), 'only a tag that has not been answered can be cancelled');
    const run = m.run_id;
    const out = store.updateMention(m.id, { status: 'cancelled', reason: 'you cancelled it', ended_at: store.now() });
    if (run && store.getRun(run)?.token) runner.killRun(run, 'the owner cancelled the tag');
    store.logEvent({ agent_id: 'owner', kind: 'system', text: `${m.ticket_key}: cancelled your tag for ${agentById[m.seat_id]?.name}.` });
    return out;
  }
  need(false, 'choose retry or cancel');
}

// The owner retries a failed design discussion or cancels one that has not started.
export function ownerDiscussion(id, action) {
  const d = store.getDiscussion(Number(id));
  need(d, 'no such discussion');
  if (action === 'retry') {
    need(d.status === 'failed', 'only a failed discussion can be retried');
    need(store.pendingDiscussions().length < 20, 'discussion queue is full');
    store.logEvent({ ticket_key: d.ticket_key, agent_id: 'owner', kind: 'system', text: `Retried design discussion #${d.id}.` });
    return store.updateDiscussion(d.id, { status: 'queued', error: null, attempts: 0, ended_at: null, run_id: null });
  }
  if (action === 'cancel') {
    need(d.status === 'queued', 'only a discussion that has not started can be cancelled');
    store.logEvent({ ticket_key: d.ticket_key, agent_id: 'owner', kind: 'system', text: `Cancelled design discussion #${d.id}.` });
    return store.updateDiscussion(d.id, { status: 'cancelled', ended_at: store.now() });
  }
  need(false, 'choose retry or cancel');
}

export async function ownerDecision(key, { decision, message = '', expected_updated_at, discussion_id } = {}) {
  const t = store.getTicket(key); need(t, 'no such ticket');
  need(['approve', 'correction', 'reject'].includes(decision), 'invalid decision');
  const note = String(message).trim();
  need(note.length <= 8000, 'decision message must be at most 8000 characters');
  if (decision === 'correction') need(note, 'Describe the correction so the engineer can act on it');
  if (discussion_id) {
    const d = store.getDiscussion(Number(discussion_id));
    need(d?.ticket_key === key, 'discussion does not belong to this ticket');
    if (d.status !== 'complete') throw Object.assign(new Error('This design proposal has already been decided or is still running.'), { status: 409 });
    if (decision === 'correction') need(store.pendingDiscussions().length < 20, 'discussion queue is full');
    store.transaction(() => {
      store.updateDiscussion(d.id, { status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes_requested' });
      store.addComment(key, 'owner', `📐 **Design ${decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'corrections requested'} by owner** · discussion #${d.id}${note ? `\n\n${note}` : ''}\n\nDesign decision recorded for planning; implementation and final merge require their own gates.`);
      if (decision === 'correction') store.createDiscussion(key, `Revise design response #${d.id}.\nOriginal request:\n${d.question.slice(0, 2000)}\nPrevious response:\n${d.response.slice(0, 4000)}\nOwner corrections:\n${note.slice(0, 2000)}`);
    });
    github.flushComments(); return store.getDiscussion(d.id);
  }
  need(['needs_human', 'ready_for_human'].includes(t.status), 'ticket is not awaiting an owner decision');
  if (expected_updated_at && expected_updated_at !== t.updated_at) throw Object.assign(new Error('The request changed. Review the latest ticket before deciding.'), { status: 409 });
  if (t.active_run && store.getRun(t.active_run)?.token) throw Object.assign(new Error('The worker is finishing. Try once its run settles.'), { status: 409 });
  if (t.status === 'needs_human' && researchReview.held(t)) { const out = researchReview.ownerDecide(t, decision, note); github.flushComments(); return out; }
  if (decision === 'approve' && /publish guard/.test(t.progress_msg || '')) {
    if (note) store.addComment(key, 'owner', note);
    await ownerApprovePublish(key); return store.getTicket(key);
  }
  if (decision === 'approve' && t.status === 'ready_for_human') {
    // One approval per commit (repeat taps used to stack duplicate approvals).
    const approvedKey = `owner-approved:${key}:${t.head_sha || 'none'}`;
    if (store.kvGet(approvedKey) === '1') return { ...store.getTicket(key), pr_next: t.pr_url ? prNumberOf(t.pr_url) : null, already: true };
    store.kvSet(approvedKey, '1');
    store.addComment(key, 'owner', `✅ **${t.pr_url ? 'Owner review approved' : 'Approved for draft publication'}**${note ? `\n\n${note}` : ''}. Final merge remains with the owner.`);
    if (!t.pr_url) { publishBranch(key); return store.getTicket(key); }
    // Reflect the approval on GitHub, then let the UI ask: merge, close, add a reviewer, or mark ready.
    const n = prNumberOf(t.pr_url);
    const gh = await prs.approve(n, note).catch((err) => ({ error: err.message }));
    return { ...store.getTicket(key), pr_next: n, github_approval: gh };
  }
  if (decision === 'approve') return ownerReply(key, `✅ **Approved the requested decision.**${note ? `\n\n${note}` : ''}`, 'answer', { mentions: [] });
  store.addComment(key, 'owner', `${decision === 'correction' ? '🔁 **Owner requested changes**' : '⛔ **Rejected by owner**'}${note ? `\n\n${note}` : ''}`);
  const patch = { active_run: null, resume_status: null, stalls: 0, progress_msg: decision === 'reject' ? 'Rejected by owner' : 'Addressing owner corrections' };
  if (decision === 'reject') {
    store.updateTicket(key, { ...patch, status: 'wontdo' }); // Keep the local work for a reversible owner decision.
    github.syncIssueState(key); if (t.parent_key) rollupParent(t.parent_key);
  } else setStatus(key, t.status === 'ready_for_human' ? 'todo' : t.resume_status || 'todo', patch);
  github.flushComments(); return store.getTicket(key);
}

/**
 * Owner tasks: a step only the owner can do. Marking one takes it away from the team (any parked question stays on
 * the record); handing it back routes it to a seat again. Completing it records the owner's notes and unblocks the
 * tasks that wait on it.
 */
export function ownerTask(key, { owner_task, why = '', by = 'owner', verify = false } = {}) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  need(!['done', 'wontdo'].includes(t.status), 'this ticket is closed');
  need(!(t.active_run > 0), 'wait for the current run on this ticket to finish');
  if (owner_task) {
    need(['triage', 'proposed', 'todo', 'needs_human'].includes(t.status), 'only work that has not started can become your task');
    store.updateTicket(key, { owner_task: 1, assignee: null, status: 'todo', resume_status: null, progress_msg: 'your task' });
    if (by === 'manager') store.addComment(key, 'manager', `🙋 **This is your task**: no seat on the team can do it. ${String(why).trim().slice(0, 500)}`);
    else store.addComment(key, 'owner', `🙋 **I will do this one myself**${String(why).trim() ? `: ${String(why).trim().slice(0, 500)}` : '.'}`);
  } else {
    need(t.owner_task, 'this is not an owner task');
    // A read-only production check goes to the SRE (desk ops probes) when production read access is on.
    // verify:true is the owner's explicit call that this is a read-only check (the text classifier is conservative).
    if (by === 'owner' && verify === true) need(verifyReady(), 'production read access is off (Settings → Production read access)');
    if (((by === 'owner' && verify === true) || isVerifyAsk(`${t.title}\n${t.description || ''}`)) && verifyReady()) {
      store.updateTicket(key, { owner_task: 0, assignee: 'sre', assign_pinned: 1, status: 'todo', progress_msg: null });
      store.kvSet(`verify:${key}`, '1');
      store.addComment(key, 'owner', `↩️ **Handed back to the team**${String(why).trim() ? `: ${String(why).trim().slice(0, 500)}` : '.'} Routed to ${agentById.sre.name} (SRE) to verify with read-only production probes.`);
    } else {
      const assignee = routeTicket({ area: t.area, complexity: t.complexity || 'M', risk: t.risk });
      store.updateTicket(key, { owner_task: 0, assignee, status: 'todo', progress_msg: null });
      store.addComment(key, 'owner', `↩️ **Handed back to the team**${String(why).trim() ? `: ${String(why).trim().slice(0, 500)}` : '.'}`);
    }
  }
  github.syncIssueState(key); github.flushComments();
  return store.getTicket(key);
}
export function ownerTaskDone(key, { notes = '' } = {}) {
  const t = store.getTicket(key);
  need(t?.owner_task, 'only an owner task can be completed this way');
  need(!['done', 'wontdo'].includes(t.status), 'this task is already closed');
  // Only work outside the codebase: anything with a run, a commit or a PR ships through QA and merge, never by a click.
  need(!(t.active_run > 0) && !t.head_sha && !t.pr_url, 'this task has code in flight; it finishes when its PR merges');
  const text = String(notes).trim();
  need(text.length >= 3, 'say what you did or found (it is the evidence the next tasks rely on)');
  store.transaction(() => {
    store.addComment(key, 'owner', `✅ **Done by the owner**\n\n${text.slice(0, 8000)}`);
    store.updateTicket(key, { status: 'done', progress: 100, progress_msg: 'done by the owner' });
  });
  store.logEvent({ agent_id: 'owner', ticket_key: key, kind: 'done', text: `owner completed ${key}; tasks waiting on it can start` });
  if (t.parent_key) rollupParent(t.parent_key);
  github.syncIssueState(key); github.flushComments();
  return store.getTicket(key);
}

/** `by`: who changes it (the owner through the API; the manager for epic reviews). Only the owner pins priorities. */
export function ownerPatch(key, patch, { by = 'owner' } = {}) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  const p = {};
  if (patch.status) {
    need(STATUSES.includes(patch.status), 'bad status');
    // Shipping is recorded by the merge (PR sync), never by a generic edit.
    if (patch.status === 'done' && t.status !== 'done') throw Object.assign(new Error('Tickets become done when their PR merges; merge it from the PR console.'), { status: 409 });
    p.status = patch.status;
  }
  if (patch.priority) {
    need(PRIORITY.test(patch.priority), 'bad priority');
    if (by !== 'owner' && t.priority_pinned) need(false, `${key}'s priority was set by the owner`);
    p.priority = patch.priority;
    if (by === 'owner') p.priority_pinned = 1;
  }
  if (patch.unpin_priority === true && by === 'owner') p.priority_pinned = 0; // let the team set it again
  if (patch.assignee !== undefined) {
    need(!patch.assignee || ENGINEERS.includes(patch.assignee), 'bad assignee');
    // Reassigning work that is running would leave two seats on one branch: stop it first (or wait).
    if ((patch.assignee || null) !== t.assignee && t.active_run) throw Object.assign(new Error('This task is being worked on; wait for the run to finish before reassigning it'), { status: 409 });
    p.assignee = patch.assignee || null;
    p.assign_pinned = patch.assignee ? 1 : 0; // the owner chose this seat; clearing it lets the desk choose again
  }
  if (patch.complexity) { need(COMPLEXITIES.includes(patch.complexity), 'bad complexity'); p.complexity = patch.complexity; }
  if (patch.area) { need(AREAS.includes(patch.area), 'bad area'); p.area = patch.area; }
  if (patch.title !== undefined || patch.description !== undefined) {
    // Content edits are conditional: the owner edits what they read, never a version someone changed meanwhile.
    if (patch.expected_updated_at !== t.updated_at) throw Object.assign(new Error('The ticket changed while you were editing. Your text is kept; review the latest and save again.'), { status: 409 });
    if (patch.title !== undefined) { need(typeof patch.title === 'string' && patch.title.trim() && patch.title.length <= 200, 'a title of 1 to 200 characters'); p.title = patch.title.trim(); }
    if (patch.description !== undefined) { need(typeof patch.description === 'string' && patch.description.length <= 12_000, 'at most 12000 characters'); p.description = features.replaceRequest(t.description, patch.description); }
  }
  if (patch.after_key !== undefined) {
    // The owner orders a task after another task of the same feature; no self-reference and no cycles.
    if (patch.after_key) {
      const before = store.getTicket(patch.after_key);
      need(t.parent_key && before?.parent_key && before.key !== key && sameTree(before.key, key), 'a task can only start after another task of the same feature');
      for (let k = before, seen = 0; k && seen < 50; k = k.after_key ? store.getTicket(k.after_key) : null, seen++) need(k.key !== key, 'that order would make a loop');
      need(!flow.wouldCycle(key, before.key, store.listTickets()), 'that order would make a loop (through an epic or a written gate)');
    }
    p.after_key = patch.after_key || null;
  }
  if (p.status && ['todo', 'in_progress', 'qa', 'review'].includes(p.status) && researchReview.blocks(t)) need(false, 'this research proposal is waiting on its second review; waive the review or wait for it before moving the ticket');
  if (p.status && t.active_run > 0 && p.status !== t.status) runner.killRun(t.active_run, 'owner moved the ticket');
  if (p.status === 'qa' && !t.head_sha) need(false, 'only submitted work can go to QA');
  if (!Object.keys(p).length) return t; // nothing this caller may change
  const out = store.updateTicket(key, { ...p, stalls: 0 });
  if (p.description !== undefined && t.issue_number) github.updateIssueBody(key);
  const set = Object.entries(p).filter(([k]) => k !== 'priority_pinned').map(([k, v]) => `${k}=${v}`).join(', ');
  store.logEvent({ agent_id: by, ticket_key: key, kind: 'action', text: `${by} ${p.description !== undefined || p.title !== undefined ? 'edited the request' : set ? `set ${set}` : p.priority_pinned === 0 ? 'let the team set the priority' : 'saved no change'}` });
  github.syncIssueState(key);
  return out;
}

// ---------------- GitHub → desk (driven by prsync.reconcile) ----------------
// Every transition goes through setStatus, so epics roll up, clones are cleaned and the owner is notified.
function sendBack(t, comment, msg) {
  const loops = (t.qa_loops || 0) + 1;
  store.addComment(t.key, 'owner', comment);
  // pr_url is cleared so the reworked commit is published again (the existing PR is found by branch and updated).
  if (loops > config.limits.maxQaLoops) setStatus(t.key, 'needs_human', { qa_loops: loops, resume_status: 'todo', pr_url: null, progress_msg: `${msg} (review loop limit)` });
  else setStatus(t.key, 'todo', { qa_loops: loops, pr_url: null, progress: 50, progress_msg: msg });
}

export const prActions = {
  merged(t, a) {
    store.addComment(t.key, 'system', `🎉 **Merged on GitHub**${a.at ? ` at ${a.at}` : ''}.`);
    store.logEvent({ kind: 'github', agent_id: 'github', ticket_key: t.key, text: `PR merged on GitHub${a.at ? ` at ${a.at}` : ''}` }); // team stats count it as shipped
    setStatus(t.key, 'done', { progress: 100, progress_msg: 'merged' });
    teamStats.invalidate();
  },
  closed(t, a) {
    store.addComment(t.key, 'system', `🚫 PR closed on GitHub without merging${a.at ? ` at ${a.at}` : ''}.`);
    setStatus(t.key, 'wontdo', { progress_msg: 'PR closed without merging' });
  },
  changes(t, a) {
    sendBack(t, `🔁 **Changes requested on GitHub** by @${a.who}\n\n${a.text}`, `changes requested by @${a.who}`);
  },
  approved(t, a) {
    store.addComment(t.key, 'owner', `👍 **Approved on GitHub** by @${a.who}${a.text ? `\n\n${a.text}` : ''}`);
    store.updateTicket(t.key, { progress_msg: `approved on GitHub by @${a.who} — ready to merge` });
  },
  comment(t, a) {
    const text = `💬 **On GitHub** (@${a.who}): ${a.text}`;
    if (t.status === 'needs_human') ownerReply(t.key, text, 'auto', { mentions: [] }); // answering from GitHub resumes the ticket (and never tags a seat)
    else store.addComment(t.key, 'owner', text);
  },
  checks_failed(t, a) { prChecksFailed(t, a.names); },
  conflict(t) {
    store.addComment(t.key, 'system', `⚠️ The draft PR conflicts with ${config.project.baseBranch}. Rebase before merging.`);
    store.updateTicket(t.key, { progress_msg: 'PR has merge conflicts' });
  },
  async landed(t, pr) {
    const msg = `Closing: everything this PR changes is already on \`${config.project.baseBranch}\` (it landed through another PR, e.g. a stacked slice). — SigmaDesk`;
    await prsync.closePr(pr, msg);
    store.addComment(t.key, 'system', `✅ Already landed on ${config.project.baseBranch} via another PR; closed #${pr.number}.`);
    setStatus(t.key, 'done', { progress: 100, progress_msg: 'landed via another PR' });
  },
};
