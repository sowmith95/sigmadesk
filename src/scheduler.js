import crypto from 'node:crypto';
import { config } from './config.js';
import { agentById, ENGINEERS, AREAS, COMPLEXITIES, STATUSES, routeTicket, promptFor } from './team.js';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as watch from './watch.js';
import { notify } from './notify.js';

// ---------------- publish guard ----------------
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
export function guardReasons(files, lines, complexity) {
  const pats = config.project.protectedPaths.map(globToRegExp);
  const hit = files.filter((f) => pats.some((r) => r.test(f)));
  const reasons = [];
  if (hit.length) reasons.push(`touches protected paths: ${hit.slice(0, 8).join(', ')}${hit.length > 8 ? '…' : ''}`);
  const cap = config.project.maxDiffLines[complexity || 'M'];
  if (cap && lines > cap) reasons.push(`diff is ${lines} lines (cap for ${complexity || 'M'} is ${cap})`);
  return reasons;
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
  const seat = ['pm', 'manager', 'sre'].includes(t.reporter) ? t.reporter : null;
  return seat && agentById[seat]?.enabled !== false ? seat : null;
}

const agentIdle = (id) => agentById[id]?.enabled !== false && store.getAgentState(id)?.status !== 'working';

function setStatus(key, status, extra = {}) {
  const before = store.getTicket(key)?.status;
  const t = store.updateTicket(key, { status, ...extra });
  github.syncIssueState(key);
  if (status !== before && status === 'needs_human') notify('needs_human', t, 'needs you');
  if (status !== before && status === 'ready_for_human') notify('ready_for_human', t, 'ready for your review');
  if (['done', 'wontdo'].includes(status)) runner.removeWorkspace(key); // clones are full copies now; free the disk
  return t;
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
async function launch({ agentId, kind, ticket, cwd, prompt, resume = null, fork = false, extraDirs = [], nonce = null, fence = runner.currentEpoch() }) {
  const before = ticket?.status;
  const p = runner.startRun({ agentId, kind, ticketKey: ticket?.key, prompt, cwd, resume, fork, extraDirs, nonce, fence });
  if (ticket) store.updateTicket(ticket.key, { active_run: store.getAgentState(agentId).current_run });
  const { run, aborted } = await p;
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
  const moved = kind === 'implement' ? after.status !== 'in_progress' : after.status !== before;
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
    cwd = await runner.ensureReadonlyWorkspace();
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

async function launchImplement(ticket, agentId, fence) {
  store.updateAgent(agentId, { status: 'working', current_ticket: ticket.key, last_action: 'cloning workspace', last_action_at: store.now() });
  store.logEvent({ agent_id: agentId, ticket_key: ticket.key, kind: 'pickup', text: `${agentById[agentId].role} picked up ${ticket.key}` });
  setStatus(ticket.key, 'in_progress', { assignee: agentId, active_run: -1, progress: Math.max(2, ticket.progress || 0), progress_msg: 'cloning workspace' });
  let ws;
  try {
    ws = await runner.ensureWorkspace(store.getTicket(ticket.key));
  } catch (err) {
    store.updateAgent(agentId, { status: 'idle', current_ticket: null });
    store.logEvent({ agent_id: agentId, ticket_key: ticket.key, kind: 'error', text: `workspace setup failed: ${err.message}` });
    setStatus(ticket.key, 'needs_human', { active_run: null, resume_status: 'todo', progress_msg: 'workspace setup failed' });
    return;
  }
  const t = store.updateTicket(ticket.key, { branch: ws.branch });
  const comments = store.listComments(t.key);
  const prev = store.lastRunFor(t.key, agentId, 'implement');
  // A stalled request (idle watchdog) is resumed in place: same session, same clone, nothing redone.
  if (prev && prev.status === 'killed' && /idle timeout|desk restarted|desk shutdown/.test(prev.result_text || '') && runner.canResume(prev, 6) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id,
      prompt: 'Your previous request stalled and was restarted. Continue exactly where you left off: finish the ticket, commit, and run desk submit.' });
    if (!(run && run.status === 'error' && !run.num_turns)) return;
  }
  // Rework: continue this engineer's own session (same clone, full memory of what it tried) when it is recent.
  const notes = comments.filter((c) => /^(❌|🔁)/.test(c.body)).pop();
  if (config.review.resumeRework && notes && runner.canResume(prev, config.review.resumeReworkMaxAgeHours) && prev.cwd === ws.dir) {
    const run = await launch({ fence, agentId, kind: 'implement', ticket: t, cwd: ws.dir, resume: prev.session_id, prompt: promptFor('rework', { ticket: t, extra: notes.body }) });
    if (run && run.status === 'error' && !run.num_turns) {
      store.logEvent({ agent_id: agentId, ticket_key: t.key, kind: 'system', text: 'session resume failed — starting fresh' });
    } else return;
  }
  await launch({ fence, agentId, kind: 'implement', ticket: store.getTicket(t.key), cwd: ws.dir, prompt: promptFor('implement', { ticket: store.getTicket(t.key), comments: store.listComments(t.key) }) });
}

const nonce = () => crypto.randomBytes(5).toString('hex');

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
  store.logEvent({ agent_id: seat, ticket_key: ticket.key, kind: 'pickup', text: `${agentById[seat].role} is reviewing ${ticket.key} against the original intent` });
  const comments = store.listComments(ticket.key);
  // Opt-in: fork the requester's original session (where the idea was born) if it is recent enough.
  const origin = ticket.origin_session ? store.runBySession(ticket.origin_session) : null;
  if (config.review.resumeRequester && runner.engineOf(agentById[seat]).canFork && runner.canResume(origin, config.review.resumeRequesterMaxAgeHours)) {
    const code = nonce();
    const run = await launch({ fence, agentId: seat, kind: 'review', ticket, cwd: origin.cwd, resume: origin.session_id, fork: true, extraDirs: [ws.dir], nonce: code,
      prompt: promptFor('review-resumed', { ticket: { ...ticket, nonce: code }, comments, extra: ws.dir }) });
    if (!(run && run.status === 'error' && !run.num_turns)) return;
  }
  const code = nonce();
  await launch({ fence, agentId: seat, kind: 'review', ticket, cwd: ws.dir, nonce: code, prompt: promptFor('review', { ticket, comments, extra: code }) });
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
  const { cwd } = await readonlyJob('sre', null);
  const samples = JSON.parse(inc.samples || '[]');
  const context = await watch.lokiContext(config.watch.sources[inc.source_index], inc.label, samples.at(-1)?.ts || inc.last_seen);
  store.logEvent({ agent_id: 'sre', kind: 'pickup', text: `investigating incident #${inc.id} (${inc.label}): ${inc.normalized.slice(0, 120)}` });
  const { run, aborted } = await runner.startRun({ fence, agentId: 'sre', kind: 'investigate', cwd, incidentId: inc.id, prompt: promptFor('investigate', { extra: incidentEvidence(inc, context) }) });
  if (aborted) { store.updateAgent('sre', { status: 'idle' }); store.updateIncident(inc.id, { status: 'watching' }); return; }
  const after = store.getIncident(inc.id);
  if (after.status === 'investigating') {
    const give = (after.attempts || 0) >= 2;
    store.updateIncident(inc.id, { status: give ? 'paged' : 'watching', note: `investigation ended without a verdict (${run.status})` });
    if (give) pageOwner([after], 'SRE could not reach a verdict twice');
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

export async function launchResearch(focus = '') {
  if (!agentIdle('pm')) throw new Error('PM is busy');
  const s = store.getSettings();
  const room = Math.max(1, Number(s.max_open_proposals) - store.ticketsByStatus('proposed').length);
  const extra = `${focus ? `The owner asked you to focus on: ${focus}. ` : ''}File at most ${Math.min(3, room)} proposals.`;
  const { cwd } = await readonlyJob('pm', null);
  return launch({ agentId: 'pm', kind: 'research', ticket: null, cwd, prompt: promptFor('research', { extra }) });
}

// ---------------- the tick ----------------
let ticking = false;
let budgetWarned = '';

export function budgetHeadroom(settings = store.getSettings()) {
  // Reserve each running seat's full per-run cap so concurrent runs can't jointly blow the daily limit.
  const working = store.listAgentStates().filter((a) => a.status === 'working').reduce((sum, a) => sum + runner.runBudget(a.id), 0);
  return Number(settings.daily_budget_usd) - store.spendSince(startOfToday()) - Math.max(working, runner.runningBudget());
}

export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = store.getSettings();
    if (s.paused === 'true') return;
    let headroom = budgetHeadroom(s);
    const quota = JSON.parse(store.kvGet('quota:claude') || 'null');
    const planFull = quota && ((quota.five_hour ?? 0) >= config.limits.planHoldAt || (quota.status && quota.status !== 'allowed'));
    // Seats are flipped to "working" synchronously when a job starts, so this counts jobs still in setup too.
    let slots = capacity(s) - store.listAgentStates().filter((a) => a.status === 'working').length;
    const fence = runner.currentEpoch();
    const go = (agentId, fn) => {
      if (planFull && runner.engineOf(agentById[agentId]).id === 'claude') return false; // leave the plan's headroom to the owner
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
      fn(fence).catch((err) => store.logEvent({ kind: 'error', agent_id: agentId, text: `scheduler: ${err.message}` }));
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
    // 2b. Requesters confirm QA-passed work matches what they asked for.
    for (const t of store.ticketsByStatus('review')) {
      if (slots <= 0) break;
      const seat = requesterOf(t);
      if (t.active_run || !seat || !agentIdle(seat)) continue;
      go(seat, (f) => launchReview(t, seat, f));
    }
    // 3. Engineers pick up groomed work by routing (area × complexity × risk).
    for (const t of store.ticketsByStatus('todo')) {
      if (slots <= 0) break;
      if (t.active_run) continue;
      const who = t.assignee && ENGINEERS.includes(t.assignee) && agentById[t.assignee].enabled !== false ? t.assignee : routeTicket(t);
      if (!agentIdle(who)) continue;
      go(who, (f) => launchImplement(t, who, f));
    }
    // 4. Manager grooms proposals (consulting principals inside the run).
    const proposed = store.ticketsByStatus('proposed').find((t) => !t.active_run);
    if (proposed && slots > 0 && agentIdle('manager')) go('manager', (f) => launchGroom(proposed, f));
    // 5. PM researches on a cadence while the funnel is thin.
    if (s.pm_enabled === 'true' && slots > 0 && agentIdle('pm') && store.ticketsByStatus('proposed').length < Number(s.max_open_proposals)) {
      const last = store.lastRunOfKind('research');
      if (!last || Date.now() - Date.parse(last.started_at) > Number(s.pm_interval_min) * 60_000) go('pm', () => launchResearch());
    }
  } finally {
    ticking = false;
  }
}

// ---------------- recovery ----------------
export function recoverOrphans() {
  for (const inc of store.listIncidents({ status: 'investigating' })) store.updateIncident(inc.id, { status: 'watching', note: 'investigation interrupted by restart' });
  for (const run of store.unfinishedRuns()) {
    if (run.pid) { try { process.kill(-run.pid, 'SIGTERM'); } catch { /* gone */ } }
    // No terminal report survived the restart: charge the cap so interrupted spend is never forgotten.
    store.updateRun(run.id, { status: 'killed', ended_at: store.now(), result_text: 'desk restarted', token: null,
      cost_usd: run.cost_usd || runner.runBudget(run.agent_id), cost_estimated: run.cost_usd ? 0 : 1 });
    store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key, kind: 'error', text: 'run interrupted by a desk restart' });
  }
  for (const a of store.listAgentStates()) store.updateAgent(a.id, { status: 'idle', current_ticket: null, current_run: null });
  for (const t of store.listTickets()) {
    if (t.active_run) store.updateTicket(t.key, { active_run: null, ...(t.status === 'in_progress' ? { status: 'todo' } : {}) });
  }
}

// ---------------- desk CLI actions (called by seats with their run token) ----------------
const PERMS = {
  propose: ['pm'], groom: ['manager'], 'create-task': ['manager'], reject: ['manager'], consult: ['manager'],
  route: ['support'], submit: ENGINEERS, qa: ['qa'], accept: ['pm', 'manager', 'sre'], incident: ['sre'],
};
const PRIORITY = /^P[0-3]$/;

function need(cond, msg) { if (!cond) throw Object.assign(new Error(msg), { status: 400 }); }

function fmtTicket(t, comments) {
  return `${t.key} [${t.status}] ${t.title}\ntype=${t.type} priority=${t.priority} area=${t.area || '-'} complexity=${t.complexity || '-'} assignee=${t.assignee || '-'} branch=${t.branch || '-'} pr=${t.pr_url || '-'} issue=${t.issue_number ? `#${t.issue_number}` : '-'}\n\n${t.description}\n\nComments:\n${comments.map((c) => `--- ${c.author}: ${c.body}`).join('\n') || '(none)'}`;
}

export async function deskAction(run, cmd, body = {}) {
  const agentId = run.agent_id;
  if (PERMS[cmd]) need(PERMS[cmd].includes(agentId), `${agentById[agentId].role} cannot run "${cmd}"`);
  const key = body.key || run.ticket_key;
  const ticket = key ? store.getTicket(key) : null;
  // A seat may only change its own ticket (the manager may also touch tickets it creates via create-task).
  const ownTicket = () => need(ticket && (ticket.key === run.ticket_key || agentId === 'manager'), 'you can only act on your current ticket');
  const ev = (text, k = key) => store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: k, kind: 'action', text });

  switch (cmd) {
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
        assignee, description, ...(body.title ? { title: body.title } : {}) });
      ev(`groomed ${ticket.key} → ${body.complexity}/${body.area}${body.risk === 'high' ? '/high-risk' : ''}, staffed ${agentById[assignee].role}`);
      github.createIssue(ticket.key);
      return `groomed; assigned to ${assignee}`;
    }
    case 'create-task': {
      need(body.title && body.body, 'title and body required');
      need(COMPLEXITIES.includes(body.complexity) && AREAS.includes(body.area), 'complexity and area required');
      const assignee = body.assign && ENGINEERS.includes(body.assign) ? body.assign : routeTicket(body);
      const t = store.createTicket({ title: body.title, description: body.body, type: body.type || 'task', status: 'todo', area: body.area,
        complexity: body.complexity, priority: PRIORITY.test(body.priority) ? body.priority : 'P2', assignee, reporter: agentId, source: 'agent', parent_key: body.parent || key });
      store.updateTicket(t.key, { origin_session: store.getRun(run.id)?.session_id || null });
      ev(`created task ${t.key} for ${agentById[assignee].role}`, t.key);
      github.createIssue(t.key);
      return `created ${t.key} assigned to ${assignee}`;
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
    case 'consult': {
      need(['principal-be', 'principal-fe', 'dba'].includes(body.agent), 'consult principal-be | principal-fe | dba');
      need(body.body, 'question required');
      need(run.kind === 'groom', 'consults happen during grooming');
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
      setStatus(ticket.key, 'qa', { head_sha: sha, progress: 90, progress_msg: 'waiting for QA' });
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
      const testRe = new RegExp(config.project.testCommandPattern);
      need(ran.some((e) => e.ok && testRe.test(e.cmd)), `no passing test run in your session yet — run the relevant tests (e.g. ${ran.length ? 'the playbook test command' : 'pytest / npm test'}) and pass only if they succeed`);
      // The verdict only counts for the exact commit that was submitted.
      const sha = await runner.headSha(runner.workspaceDir(ticket.key));
      need(!ticket.head_sha || sha === ticket.head_sha, `HEAD moved since submission (${sha.slice(0, 7)} ≠ ${String(ticket.head_sha).slice(0, 7)}); QA must not commit`);
      store.addComment(ticket.key, agentId, `✅ **QA passed** at \`${sha.slice(0, 10)}\`\n\n${body.body || ''}`);
      ev(`QA passed ${ticket.key}`);
      const seat = requesterOf(ticket);
      if (seat) {
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
  if (publishing.has(key) || t.pr_url) return;
  publishing.add(key);
  try { await publishInner(t, key); } finally { publishing.delete(key); }
}

// Crash or transient GitHub failure after QA: retry publishing tickets that are ready but have no PR.
export async function ownerApprovePublish(key) {
  const t = store.getTicket(key);
  need(t && t.head_sha && store.kvGet(`guard:${key}`) === t.head_sha, 'nothing awaiting publish approval for this commit');
  store.addComment(key, 'owner', `✅ Publish approved for \`${t.head_sha.slice(0, 10)}\` despite the guard.`);
  setStatus(key, 'ready_for_human', { resume_status: null, progress_msg: 'owner approved publish' });
  if (publishing.has(key)) return;
  publishing.add(key);
  try { await publishInner(store.getTicket(key), key, { ownerApproved: true }); } finally { publishing.delete(key); }
}

export function retryPublications() {
  for (const t of store.ticketsByStatus('ready_for_human')) if (!t.pr_url && t.head_sha) publishBranch(t.key);
}

async function publishInner(t, key, { ownerApproved = false } = {}) {
  if (!ownerApproved) {
    const { files, lines } = await runner.diffSummary(runner.workspaceDir(key), t.head_sha);
    const reasons = guardReasons(files, lines, t.complexity);
    if (reasons.length) {
      store.addComment(key, 'system', `🛑 **Publish guard** — not pushed: ${reasons.join('; ')}.\nReview the branch locally (${runner.workspaceDir(key)}) and press "Approve publish" if it is safe.`);
      setStatus(key, 'needs_human', { resume_status: 'ready_for_human', progress_msg: 'publish guard: needs owner approval' });
      store.kvSet(`guard:${key}`, t.head_sha);
      return;
    }
  }
  try {
    if (!t.issue_number) await github.createIssue(key);
    await runner.pushBranch(runner.workspaceDir(key), t.branch, t.head_sha);
    store.logEvent({ kind: 'github', ticket_key: key, agent_id: 'github', text: `pushed ${t.branch}` });
    const cs = store.listComments(key);
    const last = (prefix) => cs.filter((c) => c.body.startsWith(prefix)).pop()?.body.replace(/^[^\n]*\n*/, '') || '';
    await github.openDraftPr(key, [`## Summary\n${last('🚀')}`, `## QA (correctness)\n${last('✅')}`, last('🤝') ? `## Acceptance (requester intent)\n${last('🤝')}` : ''].filter(Boolean).join('\n\n'));
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

export function ownerReply(key, text) {
  const t = store.getTicket(key);
  need(t, 'no such ticket');
  need(text, 'empty reply');
  store.addComment(key, 'owner', text);
  if (t.status === 'needs_human') setStatus(key, t.resume_status || 'todo', { resume_status: null, stalls: 0 });
  github.flushComments();
  return store.getTicket(key);
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
