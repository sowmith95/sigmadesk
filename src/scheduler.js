import crypto from 'node:crypto';
import { config } from './config.js';
import { agentById, ENGINEERS, PRINCIPALS, BUILDERS, AREAS, COMPLEXITIES, STATUSES, routeTicket, routeSlice, promptFor } from './team.js';
import * as store from './db.js';
import * as advisors from './advisors.js';
import * as council from './council.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as watch from './watch.js';
import { notify } from './notify.js';
import * as prsync from './prsync.js';
import * as prs from './prs.js';
import * as reviews from './reviews.js';
import * as mergetrain from './mergetrain.js';

const prNumberOf = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
import { selectionFor } from './dispatch.js';

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
function localParts(d, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, mins: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

export function inBusyWindow(d = new Date(), w = config.limits.busyWindow) {
  if (!w?.enabled) return false;
  const { day, mins } = localParts(d, w.timezone);
  return w.days.includes(day) && mins >= toMins(w.start) && mins < toMins(w.end);
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

export function setStatus(key, status, extra = {}) {
  const before = store.getTicket(key)?.status;
  const t = store.updateTicket(key, { status, ...extra });
  github.syncIssueState(key);
  if (status !== before && status === 'needs_human') notify('needs_human', t, 'needs you');
  if (status !== before && status === 'ready_for_human') notify('ready_for_human', t, 'ready for your review');
  if (['done', 'wontdo'].includes(status)) runner.removeWorkspace(key); // clones are full copies now; free the disk
  if (t.parent_key) rollupParent(t.parent_key);
  return t;
}

// An epic (a principal's delegated ticket) tracks its slices: progress rolls up; it closes when every slice is settled.
export function rollupParent(parentKey) {
  const p = store.getTicket(parentKey);
  if (!p || p.status !== 'in_progress' || !PRINCIPALS.includes(p.assignee)) return;
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
    store.logEvent({ agent_id: p.assignee, ticket_key: parentKey, kind: 'done', text: `epic ${parentKey} closed: ${msg}` });
  } else {
    store.updateTicket(parentKey, { progress: Math.min(99, progress), progress_msg: msg });
  }
}

function stall(ticket, reason) {
  const stalls = (ticket.stalls || 0) + 1;
  const resume = ticket.status === 'in_progress' ? 'todo' : ticket.status;
  if (stalls >= 2) {
    store.addComment(ticket.key, 'system', `Stalled twice (${reason}). Parked for the owner — reply on the board to resume.`);
    setStatus(ticket.key, 'needs_human', { stalls, active_run: null, resume_status: resume });
  } else {
    store.logEvent({ ticket_key: ticket.key, kind: 'system', text: `no outcome (${reason}); will retry once` });
    store.updateTicket(ticket.key, { stalls, active_run: null, status: resume });
  }
}

// ---------------- job launchers ----------------
async function launch({ agentId, kind, ticket, cwd, prompt, resume = null, fork = false, extraDirs = [], nonce = null, fence = runner.currentEpoch(), onStart = null, outcome = null }) {
  const before = ticket?.status;
  const p = runner.startRun({ agentId, kind, ticketKey: ticket?.key, prompt, cwd, resume, fork, extraDirs, nonce, fence, onStart });
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

async function launchTriage(t, fence) {
  const { cwd } = await readonlyJob('support', t);
  await launch({ fence, agentId: 'support', kind: 'triage', ticket: t, cwd, prompt: promptFor('triage', { ticket: t, comments: store.listComments(t.key) }) });
}

async function launchGroom(t, fence) {
  const { cwd } = await readonlyJob('manager', t);
  await launch({ fence, agentId: 'manager', kind: 'groom', ticket: t, cwd, prompt: promptFor('groom', { ticket: t, comments: store.listComments(t.key) }) });
}

export async function launchDiscussion(d, fence) {
  store.updateDiscussion(d.id, { status: 'running', error: null });
  try {
    const { cwd } = await readonlyJob('manager', null);
    store.updateAgent('manager', { current_ticket: d.ticket_key, last_action: 'interpreting the owner’s design request' });
    const p = runner.startRun({ fence, agentId: 'manager', kind: 'owner_discussion', ticketKey: d.ticket_key, cwd,
      prompt: promptFor('owner_discussion', { ticket: store.getTicket(d.ticket_key), comments: store.listComments(d.ticket_key).slice(-8), extra: d.question }) });
    store.updateDiscussion(d.id, { run_id: store.getAgentState('manager').current_run });
    const { run, aborted, failure } = await p;
    if (store.getDiscussion(d.id).status !== 'running') return;
    if (aborted || failure || run.status === 'killed') { store.updateDiscussion(d.id, { status: 'queued', run_id: null }); return; }
    if (run.status === 'success' && run.result_text?.trim()) completeDiscussion(d.id, run.result_text);
    else store.updateDiscussion(d.id, { status: 'failed', error: 'Manager ended without a design response', ended_at: store.now() });
  } catch (err) { store.updateDiscussion(d.id, { status: 'queued', run_id: null, error: store.redact(err.message).slice(0, 240) }); throw err; }
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

// A slice ordered after a sibling that was closed without merging would otherwise wait forever.
function orphanedSlice(t) {
  store.addComment(t.key, 'system', `⚠️ This slice was waiting for ${t.after_key}, which was closed without merging. Decide: continue without it (reply), rescope, or close.`);
  setStatus(t.key, 'needs_human', { after_key: null, resume_status: 'todo', progress_msg: `predecessor ${t.after_key} closed unmerged` });
}

// Preparing a clone takes seconds; if the owner moved, rejected or reassigned the ticket meanwhile, do not start.
function stillWanted(key, status, agentId) {
  const now = store.getTicket(key);
  if (now?.status === status && (!now.assignee || now.assignee === agentId || status !== 'in_progress')) return true;
  store.updateAgent(agentId, { status: 'idle', current_ticket: null, current_run: null });
  if (now?.active_run === -1) store.updateTicket(key, { active_run: null });
  store.logEvent({ agent_id: agentId, ticket_key: key, kind: 'system', text: `start cancelled: the ticket changed (${now?.status || 'gone'}) while its workspace was being prepared` });
  return false;
}

async function launchImplement(ticket, agentId, fence) {
  store.updateAgent(agentId, { status: 'working', current_ticket: ticket.key, last_action: 'cloning workspace', last_action_at: store.now() });
  store.logEvent({ agent_id: agentId, ticket_key: ticket.key, kind: 'pickup', text: `${agentById[agentId].role} picked up ${ticket.key}` });
  setStatus(ticket.key, 'in_progress', { assignee: agentId, active_run: -1, progress: Math.max(2, ticket.progress || 0), progress_msg: 'cloning workspace' });
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
  const prev = store.lastRunFor(t.key, agentId, 'implement');
  // A stalled request (idle watchdog) is resumed in place: same session, same clone, nothing redone.
  if (prev && prev.status === 'killed' && /idle timeout|desk restarted|desk shutdown/.test(prev.result_text || '') && runner.canResume(prev, 6) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id,
      prompt: 'Your previous request stalled and was restarted. Continue exactly where you left off: finish the ticket, commit, and run desk submit.' });
    if (!(run && run.status === 'error' && !run.num_turns)) return;
    if (budgetHeadroom() < runner.runBudget(agentId)) { stall(store.getTicket(t.key), 'resume failed and the daily risk limit is reached'); return; }
  }
  // Rework: continue this engineer's own session (same clone, full memory of what it tried) when it is recent.
  const notes = comments.filter((c) => /^(❌|🔁)/.test(c.body)).pop();
  if (config.review.resumeRework && notes && runner.canResume(prev, config.review.resumeReworkMaxAgeHours) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id, prompt: promptFor('rework', { ticket: t, extra: notes.body }) });
    if (run && run.status === 'error' && !run.num_turns) {
      store.logEvent({ agent_id: agentId, ticket_key: t.key, kind: 'system', text: 'session resume failed — starting fresh' });
      if (budgetHeadroom() < runner.runBudget(agentId)) { stall(store.getTicket(t.key), 'daily risk limit reached'); return; }
    } else return;
  }
  await launch({ fence, agentId, kind: 'implement', ticket: store.getTicket(t.key), cwd: ws.dir, prompt: promptFor('implement', { ticket: store.getTicket(t.key), comments: store.listComments(t.key) }) });
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
    if (budgetHeadroom() < runner.runBudget(seat)) { stall(store.getTicket(ticket.key), 'daily risk limit reached'); return; }
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

export async function launchResearch(focus = '', fence = runner.currentEpoch()) {
  if (!agentIdle('pm')) throw new Error('PM is busy');
  const s = store.getSettings();
  if (s.paused === 'true') throw Object.assign(new Error('Open the desk before starting research'), { status: 409 });
  if (!selectionFor('pm').seat) throw Object.assign(new Error(`PM: ${selectionFor('pm').reason}`), { status: 409 });
  const room = Math.max(1, Number(s.max_open_proposals) - store.ticketsByStatus('proposed').length);
  const extra = `${focus ? `The owner asked you to focus on: ${focus}. ` : ''}File at most ${Math.min(3, room)} proposals.`;
  const { cwd } = await readonlyJob('pm', null);
  return launch({ fence, agentId: 'pm', kind: 'research', ticket: null, cwd, prompt: promptFor('research', { extra }) });
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
  const queued = store.listTickets().filter((t) => ['triage', 'proposed', 'todo', 'qa', 'review'].includes(t.status));
  return { last_tick: lastTick, last_error: lastError, paused: settings.paused === 'true', budget_headroom: budgetHeadroom(settings),
    queued: queued.length, discussions: store.pendingDiscussions().length, waiting: queued.filter((t) => !t.active_run).map((t) => {
      const seat = t.status === 'triage' ? 'support' : t.status === 'proposed' ? 'manager' : t.status === 'qa' ? 'qa'
        : t.status === 'review' ? (t.review_stage === 'resolving' ? store.conflictJobsFor(t.key).at(-1)?.seat : reviews.enabled() ? reviews.jobFor(t)?.seat : requesterOf(t)) : t.assignee || routeTicket(t);
      const chosen = selectionFor(seat);
      const why = settings.paused === 'true' ? 'Desk paused' : t.after_key && store.getTicket(t.after_key)?.status !== 'done' ? `Waiting for ${t.after_key} to merge`
        : !chosen.seat ? chosen.reason : setupHold(seat) ? `Setup retry after ${setupHold(seat).until}` : !agentIdle(seat) ? 'Seat busy' : budgetHeadroom(settings) < runner.runBudget(seat) ? 'Daily budget reached' : 'Ready for next scheduler tick';
      return { key: t.key, seat, reason: why, engine: chosen.seat?.engine, fallback: chosen.fallback || false };
    }) };
}

export function budgetHeadroom(settings = store.getSettings()) {
  // Reserve each running seat's full per-run cap so concurrent runs can't jointly blow the daily limit.
  const preparing = store.listAgentStates().filter((a) => a.status === 'working' && !a.current_run).reduce((sum, a) => sum + runner.runBudget(a.id), 0);
  return Number(settings.daily_budget_usd) - store.spendSince(startOfToday()) - preparing - runner.runningBudget() - council.reservations();
}
export function workCount() {
  return store.listAgentStates().filter((a) => a.status === 'working').length
    + store.unfinishedRuns().filter((r) => ['architecture_review','council_review'].includes(r.kind)).length + council.preparingCount();
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    lastTick = store.now();
    const s = store.getSettings();
    if (s.paused === 'true') return;
    let headroom = budgetHeadroom(s);
    // Seats are flipped to "working" synchronously when a job starts, so this counts jobs still in setup too.
    let slots = capacity(s) - workCount();
    const fence = runner.currentEpoch();
    const go = (agentId, fn) => {
      if (!selectionFor(agentId).seat) return false;
      if (setupHold(agentId)) return false;
      const need = runner.runBudget(agentId);
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
    const triage = store.ticketsByStatus('triage').find((t) => !t.active_run);
    if (triage && slots > 0 && agentIdle('support')) go('support', (f) => launchTriage(triage, f));
    // 1b. On-call SRE investigates new recurring error signatures (rate-limited).
    if (config.watch.enabled && slots > 0 && agentIdle('sre')) {
      const recentCount = store.investigationsSince(new Date(Date.now() - 3600_000).toISOString());
      const next = recentCount < config.watch.maxInvestigationsPerHour
        ? (watch.triageIncidents().investigate || []).sort((a, b) => watch.windowCount(b.signature) - watch.windowCount(a.signature))[0] : null;
      if (next) go('sre', (f) => launchInvestigation(next, f));
    }
    // 2. QA before new implementation: settle work in flight first.
    const qa = store.ticketsByStatus('qa').find((t) => !t.active_run);
    if (qa && slots > 0 && agentIdle('qa')) go('qa', (f) => launchQa(qa, f));
    const discussion = store.pendingDiscussions().find((d) => d.status === 'queued');
    if (discussion && slots > 0 && agentIdle('manager')) go('manager', (f) => launchDiscussion(discussion, f));
    // 2b. Two-reviewer code review (context, then independent) and the author's answers; legacy: requester acceptance.
    if (reviews.enabled()) {
      for (const job of reviews.nextJobs()) {
        if (slots <= 0) break;
        if (!agentIdle(job.seat)) continue;
        go(job.seat, (f) => (job.kind === 'pr_review' ? launchPrReview(job, f) : launchRespond(job, f)));
      }
      for (const job of mergetrain.enabled() ? mergetrain.nextResolveJobs() : []) {
        if (slots <= 0) break;
        if (!agentIdle(job.seat)) continue;
        go(job.seat, (f) => launchResolve(job, f));
      }
    } else {
      for (const t of store.ticketsByStatus('review')) {
        if (slots <= 0) break;
        const seat = requesterOf(t);
        if (t.active_run || !seat || !agentIdle(seat)) continue;
        go(seat, (f) => launchReview(t, seat, f));
      }
    }
    // 3. Engineers pick up groomed work by routing (area × complexity × risk).
    council.pump();
    slots = capacity(s) - workCount(); headroom = budgetHeadroom(s);
    for (const t of store.ticketsByStatus('todo')) {
      if (slots <= 0) break;
      if (t.active_run) continue;
      if (t.after_key && store.getTicket(t.after_key)?.status === 'wontdo') { orphanedSlice(t); continue; }
      if (t.after_key && store.getTicket(t.after_key)?.status !== 'done') continue; // waits for its predecessor to merge
      const who = t.assignee && ENGINEERS.includes(t.assignee) && agentById[t.assignee].enabled !== false ? t.assignee : routeTicket(t);
      if (!agentIdle(who)) continue;
      if (PRINCIPALS.includes(who)) go(who, (f) => launchDesign(t, who, f));
      else go(who, (f) => launchImplement(t, who, f));
    }
    // 4. Manager grooms proposals (consulting principals inside the run).
    const proposed = store.ticketsByStatus('proposed').find((t) => !t.active_run);
    if (proposed && slots > 0 && agentIdle('manager')) go('manager', (f) => launchGroom(proposed, f));
    // 5. PM researches on a cadence while the funnel is thin.
    if (s.pm_enabled === 'true' && slots > 0 && agentIdle('pm') && store.ticketsByStatus('proposed').length < Number(s.max_open_proposals)) {
      const last = store.lastRunOfKind('research');
      if (!last || Date.now() - Date.parse(last.started_at) > Number(s.pm_interval_min) * 60_000) go('pm', (f) => launchResearch('', f));
    }
  } finally {
    ticking = false;
  }
}

// ---------------- recovery ----------------
export function recoverOrphans() {
  for (const d of store.pendingDiscussions()) if (d.status === 'running') store.updateDiscussion(d.id, { status: 'queued', run_id: null });
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
  }
}

// ---------------- desk CLI actions (called by seats with their run token) ----------------
const PERMS = {
  propose: ['pm'], groom: ['manager'], 'create-task': ['manager', ...PRINCIPALS], reject: ['manager'], consult: ['manager'],
  design: PRINCIPALS, delegate: PRINCIPALS, 'peer-review': ['manager', ...PRINCIPALS], council: ['manager', ...PRINCIPALS],
  route: ['support'], submit: ENGINEERS, qa: ['qa'], accept: ['pm', 'manager', 'sre'], incident: ['sre'],
  'discussion-result': ['manager'],
  review: ['manager', ...ENGINEERS], respond: ENGINEERS, resolve: ENGINEERS,
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
  if (run.kind === 'council_review') need(false, 'council calls cannot invoke desk commands');
  if (run.kind === 'owner_discussion') {
    need(['list', 'show', 'comment', 'consult', 'discussion-result'].includes(cmd), 'design discussions can only read, consult and respond');
    need(!body.key || body.key === run.ticket_key, 'discussion belongs to its original ticket');
  }
  if (PERMS[cmd]) need(PERMS[cmd].includes(agentId), `${agentById[agentId].role} cannot run "${cmd}"`);
  const key = body.key || run.ticket_key;
  const ticket = key ? store.getTicket(key) : null;
  // A seat may only change its own ticket (the manager may also touch tickets it creates via create-task).
  const ownTicket = () => need(ticket && (ticket.key === run.ticket_key || agentId === 'manager'), 'you can only act on your current ticket');
  const ev = (text, k = key) => store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: k, kind: 'action', text });

  switch (cmd) {
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
    case 'comment':
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
      need(body.title && body.body, 'title and body (stdin) required');
      const t = store.createTicket({ title: body.title, description: body.body, type: body.type || 'feature', status: 'proposed',
        area: AREAS.includes(body.area) ? body.area : null, priority: PRIORITY.test(body.priority) ? body.priority : 'P2', reporter: agentId, source: 'pm' });
      store.updateTicket(t.key, { origin_session: store.getRun(run.id)?.session_id || null });
      ev(`proposed ${t.key}: ${t.title}`, t.key);
      return `created ${t.key}`;
    }
    case 'groom': {
      need(ticket && ticket.key === run.ticket_key && run.kind === 'groom', 'you can only groom the ticket you were given');
      need(ticket.status === 'proposed', 'ticket must be in proposed');
      need(COMPLEXITIES.includes(body.complexity), 'complexity S|M|L|XL required');
      need(AREAS.includes(body.area), `area one of ${AREAS.join('|')}`);
      const assignee = body.assign && ENGINEERS.includes(body.assign) ? body.assign : routeTicket(body);
      const description = body.body ? `${ticket.description}\n\n## Groomed spec (Engineering Manager)\n${body.body}` : ticket.description;
      setStatus(ticket.key, 'todo', { complexity: body.complexity, area: body.area, priority: PRIORITY.test(body.priority) ? body.priority : ticket.priority,
        assignee, description, risk: ['high', 'low'].includes(body.risk) ? body.risk : null, ...(body.title ? { title: body.title } : {}) });
      ev(`groomed ${ticket.key} → ${body.complexity}/${body.area}${body.risk === 'high' ? '/high-risk' : ''}, staffed ${agentById[assignee].role}`);
      github.createIssue(ticket.key);
      return `groomed; assigned to ${assignee}`;
    }
    case 'create-task': {
      need(body.title && body.body, 'title and body required');
      need(COMPLEXITIES.includes(body.complexity) && AREAS.includes(body.area), 'complexity and area required');
      if (PRINCIPALS.includes(agentId)) {
        // A principal's slices: small, built by cheaper seats, attached to the ticket being designed.
        need(run.kind === 'design' && run.ticket_key, 'slices are created during a design run');
        need(['S', 'M'].includes(body.complexity), 'slices must be S or M — split further');
        need(store.childrenOf(run.ticket_key).length < 4, 'at most 4 slices per ticket');
        need(!body.assign || BUILDERS.includes(body.assign), `assign to one of ${BUILDERS.join(', ')}`);
        if (body.after) need(store.getTicket(body.after)?.parent_key === run.ticket_key, '--after must name an earlier slice of this ticket');
        const parent = store.getTicket(run.ticket_key);
        const slice = store.createTicket({ title: body.title, description: body.body, type: parent.type === 'bug' ? 'bug' : 'task', status: 'todo', area: body.area,
          complexity: body.complexity, priority: parent.priority, assignee: body.assign || routeSlice(body), reporter: agentId, source: 'agent', parent_key: run.ticket_key });
        // The slicer is the context reviewer later; slices inherit the parent's risk.
        store.updateTicket(slice.key, { designer: agentId, risk: parent.risk || null, ...(body.after ? { after_key: body.after } : {}) });
        ev(`sliced ${slice.key} (${body.complexity}) for ${agentById[slice.assignee].role}${body.after ? ` after ${body.after}` : ''}`, slice.key);
        github.createIssue(slice.key);
        return `created ${slice.key} → ${slice.assignee}`;
      }
      const assignee = body.assign && ENGINEERS.includes(body.assign) ? body.assign : routeTicket(body);
      const t = store.createTicket({ title: body.title, description: body.body, type: body.type || 'task', status: 'todo', area: body.area,
        complexity: body.complexity, priority: PRIORITY.test(body.priority) ? body.priority : 'P2', assignee, reporter: agentId, source: 'agent', parent_key: body.parent || key });
      const parentRisk = store.getTicket(body.parent || key)?.risk;
      store.updateTicket(t.key, { origin_session: store.getRun(run.id)?.session_id || null, risk: ['high', 'low'].includes(body.risk) ? body.risk : parentRisk || null });
      ev(`created task ${t.key} for ${agentById[assignee].role}`, t.key);
      github.createIssue(t.key);
      return `created ${t.key} assigned to ${assignee}`;
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
    case 'reject':
      need(ticket && (ticket.key === run.ticket_key || ticket.parent_key === run.ticket_key) && run.kind === 'groom', 'you can only reject the ticket you are grooming');
      need(['proposed', 'todo'].includes(ticket.status), 'only proposed/todo tickets can be rejected');
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
      need(['groom', 'owner_discussion'].includes(run.kind), 'consults happen during grooming or owner discussions');
      if (run.kind === 'owner_discussion') {
        const targets = consultTargets.get(run.id) || new Set();
        need(!targets.has(body.agent), 'each principal can be consulted once per discussion');
        need(targets.size < 2, 'at most two principals per discussion');
        targets.add(body.agent); consultTargets.set(run.id, targets);
      }
      consultsByRun.set(run.id, (consultsByRun.get(run.id) || 0) + 1);
      const maxConsults = run.kind === 'owner_discussion' ? 2 : config.limits.maxConsultsPerGroom;
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
      if (body.verdict === 'fail') {
        const loops = (ticket.qa_loops || 0) + 1;
        store.addComment(ticket.key, agentId, `❌ **QA failed** (round ${loops})\n\n${body.body || ''}`);
        if (loops > config.limits.maxQaLoops) setStatus(ticket.key, 'needs_human', { qa_loops: loops, resume_status: 'todo', progress_msg: 'QA failed repeatedly' });
        else setStatus(ticket.key, 'todo', { qa_loops: loops, progress: 50, progress_msg: 'fixing QA findings' });
        ev(`QA failed ${ticket.key}`);
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
      store.addComment(ticket.key, agentId, `✅ **QA passed** at \`${sha.slice(0, 10)}\`\n\n${body.body || ''}`);
      ev(`QA passed ${ticket.key}`);
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
      const sha = await runner.headSha(runner.workspaceDir(ticket.key));
      need(!ticket.head_sha || sha === ticket.head_sha, 'HEAD moved since QA; reviewers must not commit');
      store.addComment(ticket.key, agentId, `🤝 **Accepted by ${agentById[agentId].name}** (${agentById[agentId].role})\n\n${body.body || ''}`);
      setStatus(ticket.key, 'ready_for_human', { progress: 100, progress_msg: 'accepted — awaiting owner review' });
      ev(`accepted ${ticket.key}`);
      github.flushComments();
      publishBranch(ticket.key);
      return 'Recorded. Stop now.';
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

const publishing = new Set();
async function publishBranch(key) {
  const t = store.getTicket(key);
  if (store.getSettings().open_draft_prs !== 'true' || store.getSettings().github_sync !== 'true') return;
  // A PR that exists is updated when the QA-approved commit changed (review fixes push to the same PR).
  if (publishing.has(key) || (t.pr_url && store.kvGet(`published:${key}`) === t.head_sha)) return;
  publishing.add(key);
  try { await publishInner(t, key); } finally { publishing.delete(key); }
}

// Crash or transient GitHub failure after QA: retry publishing tickets that are ready but have no PR.
export async function ownerApprovePublish(key) {
  const t = store.getTicket(key);
  need(t && t.head_sha && store.kvGet(`guard:${key}`) === t.head_sha, 'nothing awaiting publish approval for this commit');
  store.kvSet(`guard:${key}`, ''); // one approval per parked commit
  store.addComment(key, 'owner', `✅ Publish approved for \`${t.head_sha.slice(0, 10)}\` despite the guard.`);
  const inReview = reviews.enabled() && t.review_stage === 'reviewing';
  setStatus(key, inReview ? 'review' : 'ready_for_human', { resume_status: null, progress_msg: inReview ? 'owner approved publish — code review continues' : 'owner approved publish' });
  if (publishing.has(key)) return;
  publishing.add(key);
  try { await publishInner(store.getTicket(key), key, { ownerApproved: true }); } finally { publishing.delete(key); }
}

export function retryPublications() {
  // Whenever GitHub may not have the QA-approved commit: no PR yet, or the PR holds an older commit (approved PRs too).
  for (const t of [...store.ticketsByStatus('ready_for_human'), ...store.ticketsByStatus('review')]) {
    if (t.status === 'review' && !t.review_stage) continue;
    if (t.head_sha && (!t.pr_url || store.kvGet(`published:${t.key}`) !== t.head_sha)) publishBranch(t.key);
  }
}

async function publishInner(t, key, { ownerApproved = false } = {}) {
  let staged;
  try {
    staged = await runner.stageApproved(key, runner.workspaceDir(key), t.head_sha);
  } catch (err) {
    store.logEvent({ kind: 'error', ticket_key: key, text: `publish staging failed: ${err.message}` });
    return;
  }
  if (!ownerApproved) {
    const { files, lines } = staged;
    const reasons = guardReasons(files, lines, t.complexity);
    if (reasons.length) {
      store.addComment(key, 'system', `🛑 **Publish guard** — not pushed: ${reasons.join('; ')}.\nReview the branch locally (${runner.workspaceDir(key)}) and press "Approve publish" if it is safe.`);
      setStatus(key, 'needs_human', { resume_status: reviews.enabled() && t.review_stage === 'reviewing' ? 'review' : 'ready_for_human', progress_msg: 'publish guard: needs owner approval' });
      store.kvSet(`guard:${key}`, t.head_sha);
      return;
    }
  }
  try {
    if (!t.issue_number) await github.createIssue(key);
    await runner.pushBranch(key, t.branch, t.head_sha);
    store.kvSet(`published:${key}`, t.head_sha);
    store.logEvent({ kind: 'github', ticket_key: key, agent_id: 'github', text: `pushed ${t.branch} at ${t.head_sha.slice(0, 7)}` });
    if (t.pr_url) { github.flushOutbox(); return; } // existing PR: the push updated it
    const cs = store.listComments(key);
    const last = (prefix) => cs.filter((c) => c.body.startsWith(prefix)).pop()?.body.replace(/^[^\n]*\n*/, '') || '';
    const stack = await prsync.stackBaseFor(store.getTicket(key));
    if (stack) store.addComment(key, 'system', `🧱 Contains unmerged commits from ${stack.key}, so the draft PR targets its branch (\`${stack.branch}\`) and shows only this ticket's changes. GitHub retargets it to ${config.project.baseBranch} when ${stack.key} merges.`);
    await github.openDraftPr(key, [stack ? `> Stacked on #${stack.pr} (${stack.key}) — merge that first.` : '', `## Summary\n${last('🚀')}`, `## QA (correctness)\n${last('✅')}`, last('🤝') ? `## Acceptance (requester intent)\n${last('🤝')}` : ''].filter(Boolean).join('\n\n'), stack ? { base: stack.branch } : {});
  } catch (err) {
    store.logEvent({ kind: 'error', ticket_key: key, text: `publish failed: ${err.message}` });
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
export function ownerCreate(body) {
  need(body.title, 'title required');
  return store.createTicket({ title: body.title, description: body.description || '', type: body.type || 'feature', status: 'triage',
    priority: PRIORITY.test(body.priority) ? body.priority : 'P2', reporter: 'owner', source: 'human' });
}

export function ownerReply(key, text, mode = 'auto') {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  need(typeof text === 'string' && text.trim(), 'empty reply');
  need(text.length <= 8000, 'message must be at most 8000 characters');
  need(['auto', 'discussion', 'answer', 'comment'].includes(mode), 'invalid message destination');
  const discussion = mode === 'discussion' || mode === 'auto' && /\b(discuss|debate|design review|architecture review)\b/i.test(text) && /\b(manager|principal|principals|team)\b/i.test(text);
  if (discussion) need(store.pendingDiscussions().length < 20, 'discussion queue is full');
  store.addComment(key, 'owner', text);
  store.requeueOutbox(key); // an owner reply retries PR comments that had given up
  let request;
  if (discussion) {
    request = store.createDiscussion(key, String(text).slice(0, 8000));
    store.logEvent({ ticket_key: key, agent_id: 'manager', kind: 'system', text: `Owner message routed to Engineering Manager for design discussion #${request.id}. Existing ticket state preserved.` });
  } else if (mode !== 'comment' && t.status === 'needs_human') setStatus(key, t.resume_status || 'todo', { resume_status: null, stalls: 0 });
  github.flushComments();
  return { ...store.getTicket(key), message_route: discussion ? 'discussion' : mode === 'comment' ? 'comment' : 'answer', discussion: request || null };
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
  if (decision === 'approve') return ownerReply(key, `✅ **Approved the requested decision.**${note ? `\n\n${note}` : ''}`, 'answer');
  store.addComment(key, 'owner', `${decision === 'correction' ? '🔁 **Owner requested changes**' : '⛔ **Rejected by owner**'}${note ? `\n\n${note}` : ''}`);
  const patch = { active_run: null, resume_status: null, stalls: 0, progress_msg: decision === 'reject' ? 'Rejected by owner' : 'Addressing owner corrections' };
  if (decision === 'reject') {
    store.updateTicket(key, { ...patch, status: 'wontdo' }); // Keep the local work for a reversible owner decision.
    github.syncIssueState(key); if (t.parent_key) rollupParent(t.parent_key);
  } else setStatus(key, t.status === 'ready_for_human' ? 'todo' : t.resume_status || 'todo', patch);
  github.flushComments(); return store.getTicket(key);
}

export function ownerPatch(key, patch) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  const p = {};
  if (patch.status) { need(STATUSES.includes(patch.status), 'bad status'); p.status = patch.status; }
  if (patch.priority) { need(PRIORITY.test(patch.priority), 'bad priority'); p.priority = patch.priority; }
  if (patch.assignee !== undefined) { need(!patch.assignee || ENGINEERS.includes(patch.assignee), 'bad assignee'); p.assignee = patch.assignee || null; }
  if (patch.complexity) { need(COMPLEXITIES.includes(patch.complexity), 'bad complexity'); p.complexity = patch.complexity; }
  if (patch.area) { need(AREAS.includes(patch.area), 'bad area'); p.area = patch.area; }
  if (p.status && t.active_run > 0 && p.status !== t.status) runner.killRun(t.active_run, 'owner moved the ticket');
  if (p.status === 'qa' && !t.head_sha) need(false, 'only submitted work can go to QA');
  const out = store.updateTicket(key, { ...p, stalls: 0 });
  store.logEvent({ agent_id: 'owner', ticket_key: key, kind: 'action', text: `owner set ${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(', ')}` });
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
    setStatus(t.key, 'done', { progress: 100, progress_msg: 'merged' });
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
    if (t.status === 'needs_human') ownerReply(t.key, text); // answering from GitHub resumes the ticket
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
