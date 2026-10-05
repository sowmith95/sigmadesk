// Features: one readable plan per root feature, groomed with Codex before any work starts.
// A feature is a root ticket of type 'feature'. Its description stays the source of truth every agent prompt reads:
// the owner's request on top, the approved plan below a marker. A grooming session is a read-only Codex run on the
// manager seat that returns a structured plan. The owner reads it, replies (a new round) or approves; approval
// creates the tasks and work starts. Plans live in kv (same pattern as product reviews): `feature-plan:KEY`, with
// earlier rounds kept at `feature-plan:KEY:revision:N`.
import crypto from 'node:crypto';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import { AREAS, routeTicket } from './team.js';

export const PLAN_START = '<!-- sigmadesk:feature-plan -->';
export const PLAN_END = '<!-- /sigmadesk:feature-plan -->';
export const ENGINE = 'codex';
const MAX_ATTEMPTS = 2; // provider interruptions retried once, then the owner sees Retry
const keyOf = (key) => `feature-plan:${key}`;
const conflict = (message) => { throw Object.assign(new Error(message), { status: 409 }); };
const bad = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
// Status changes go through the scheduler's single door (epics roll up, GitHub labels follow, clones are cleaned).
export const hooks = { setStatus: (key, status, extra = {}) => store.updateTicket(key, { status, ...extra }) };

export const isFeature = (t) => !!t && t.type === 'feature' && !t.parent_key;
/** The owner's text: the description without the generated plan block (paired markers; text after the block is kept). */
export function requestOf(description) {
  const s = String(description || '');
  const a = s.indexOf(PLAN_START);
  if (a < 0) return s.trim();
  const b = s.indexOf(PLAN_END, a);
  return `${s.slice(0, a)}${b < 0 ? '' : s.slice(b + PLAN_END.length)}`.replace(/\n{3,}/g, '\n\n').trim();
}
/** Replace the owner's text and keep the generated plan block. */
export function replaceRequest(description, request) {
  const s = String(description || '');
  const a = s.indexOf(PLAN_START), b = a >= 0 ? s.indexOf(PLAN_END, a) : -1;
  return a >= 0 && b > a ? `${String(request).trim()}\n\n${s.slice(a, b + PLAN_END.length)}` : String(request).trim();
}
const withPlan = (description, block) => `${requestOf(description)}\n\n${PLAN_START}\n${block}\n${PLAN_END}`;
const fingerprint = (t) => crypto.createHash('sha256').update(JSON.stringify([t.title, requestOf(t.description)])).digest('hex');

export function current(key) {
  const raw = store.kvGet(keyOf(key));
  if (!raw) return null;
  const p = JSON.parse(raw);
  const t = store.getTicket(key);
  // A ready plan answers the request it was groomed from; an edited request needs another round.
  return { ...p, stale: p.status === 'ready' && (!t || fingerprint(t) !== p.input_hash) };
}
export function history(key) {
  const p = current(key);
  if (!p) return [];
  const out = [];
  for (let r = 1; r < p.revision; r++) { const raw = store.kvGet(`${keyOf(key)}:revision:${r}`); if (raw) out.push(JSON.parse(raw)); }
  return [...out, p];
}
// Inside a transaction the live update must wait for the commit (the bus is not transactional): pass emit=false, then
// call announce() after the transaction returns.
function save(p, { emit = true } = {}) {
  const value = { ...p, updated_at: store.now() };
  delete value.stale;
  store.kvSet(keyOf(p.ticket_key), JSON.stringify(value));
  if (emit) announce(p.ticket_key);
  return value;
}
const announce = (key) => store.bus.emit('msg', { type: 'feature-plan', data: current(key) });
export function summaries() {
  return store.listTickets().filter(isFeature).map((t) => current(t.key)).filter(Boolean);
}
/** Until the owner approves a plan, the feature is held away from triage, ordinary grooming and implementation. */
export function holds(t) {
  const p = t && current(t.key);
  return !!p && p.status !== 'approved';
}
/** Slices of a feature whose plan the owner approved: that approval is the plan gate. */
export function approvedParent(t) {
  return !!t?.parent_key && current(t.parent_key)?.status === 'approved';
}
const openChildren = (key) => store.childrenOf(key).filter((k) => !['done', 'wontdo'].includes(k.status));

function startable(t) {
  if (!isFeature(t)) bad('Only a top-level feature can be groomed here');
  if (['done', 'wontdo'].includes(t.status)) conflict('This feature is closed');
  if (t.active_run || store.unfinishedRuns().some((r) => r.ticket_key === t.key)) conflict('Wait for the current work on this feature to finish');
  if (openChildren(t.key).length) conflict('This feature already has open tasks; finish or close them before planning again');
}

/** Queue a grooming round. `direction` is the owner's reply to the previous plan (or extra context for the first). */
export function start(key, { direction = '', expected_revision } = {}) {
  const t = store.getTicket(key);
  if (!t) bad('Feature not found');
  startable(t);
  const old = current(key);
  if (old && expected_revision !== undefined && old.revision !== expected_revision) conflict('The plan changed while you were reading. Refresh before replying.');
  if (old && ['queued', 'grooming'].includes(old.status)) conflict('A grooming round is already running');
  if (old?.status === 'approved') conflict('This plan is approved; its tasks are already on the board');
  const note = String(direction || '').trim().slice(0, 6000);
  if (old) store.kvSet(`${keyOf(key)}:revision:${old.revision}`, JSON.stringify({ ...old, stale: undefined }));
  const p = { ticket_key: key, revision: (old?.revision || 0) + 1, status: 'queued', engine: ENGINE, direction: note, attempts: 0,
    plan: null, error: null, run_id: null, model: null, input_hash: fingerprint(t), created_at: store.now() };
  store.transaction(() => {
    if (note) store.addComment(key, 'owner', note);
    store.logEvent({ ticket_key: key, agent_id: 'system', kind: 'system', text: `Grooming round ${p.revision} queued with Codex.` });
  });
  save(p);
  return current(key);
}

export function next() {
  return summaries().filter((p) => p.status === 'queued').sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))[0] || null;
}

export function promptFor(p, t) {
  const prior = p.revision > 1 ? history(t.key).filter((h) => h.revision < p.revision && h.plan).at(-1) : null;
  const comments = store.listComments(t.key).slice(-8).map((c) => `--- ${c.author} @ ${c.ts}\n${String(c.body).slice(0, 2000)}`).join('\n') || '(none)';
  return `Feature ${t.key} (priority ${t.priority}${t.area ? `, area ${t.area}` : ''}): "${t.title}"

<owner-request>
${requestOf(t.description) || '(no description; infer from the title and say what you assumed)'}
</owner-request>

Recent conversation:
${comments}
${prior ? `\n<previous-plan round="${prior.revision}">\n${JSON.stringify(prior.plan)}\n</previous-plan>\n` : ''}${p.direction ? `\nThe owner replied${prior ? ' to the previous plan' : ''}:\n<owner-reply>\n${p.direction}\n</owner-reply>\nAddress every point in the reply; keep what still holds.\n` : ''}
Read the code this feature touches before planning. Then return ONLY one JSON object as your final answer:
{"summary":"two sentences a busy owner can read","goal":"the outcome, for whom","users":["who benefits and how"],
 "scope":["what is in"],"out_of_scope":["what is deliberately not"],"acceptance":["testable criterion"],
 "risks":["risk and its mitigation"],"questions":["a decision only the owner can make"],
 "tasks":[{"ref":"T1","title":"imperative, under 80 characters","area":"${AREAS.join('|')}","complexity":"S|M","risk":"low|high",
   "after":null,"owner":null,"description":"what to change, files likely touched, how to test it","acceptance":["testable criterion"]}]}
Rules: 1 to 8 tasks in build order, each small (S) or medium (M): if something is larger, split it into more tasks.
risk is high for anything touching money, orders, auth, migrations, deploys or data deletion. "after" names an earlier ref only
when that task must be merged first. "owner" is a short reason when only the owner can do the step (production access,
credentials, a business decision); otherwise null. questions is empty when nothing needs the owner. Under 1200 words. No desk commands.`;
}

const str = (v, max, name) => { if (typeof v !== 'string' || !v.trim()) bad(`${name} is required`); return v.trim().slice(0, max); };
const list = (v, name, { min = 0, max = 12, len = 600 } = {}) => {
  if (!Array.isArray(v)) bad(`${name} must be a list`);
  const out = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, len)).slice(0, max);
  if (out.length < min) bad(`${name} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  return out;
};
export function parsePlan(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const from = s.indexOf('{'), to = s.lastIndexOf('}');
  let r;
  try { r = JSON.parse(from >= 0 && to > from ? s.slice(from, to + 1) : s); } catch { bad('The grooming session did not return a JSON plan'); }
  if (JSON.stringify(r).length > 40_000) bad('The plan is too long');
  if (!Array.isArray(r?.tasks) || !r.tasks.length || r.tasks.length > 8) bad('A plan needs 1 to 8 tasks');
  const refs = new Set();
  const tasks = r.tasks.map((x, i) => {
    const ref = typeof x?.ref === 'string' && /^[A-Za-z0-9_-]{1,8}$/.test(x.ref) ? x.ref : `T${i + 1}`;
    if (refs.has(ref)) bad(`Task ref ${ref} is used twice`);
    const after = x.after == null || x.after === '' ? null : String(x.after);
    if (after && !refs.has(after)) bad(`Task ${ref} depends on ${after}, which is not an earlier task`);
    refs.add(ref);
    if (!AREAS.includes(x.area)) bad(`Task ${ref}: area must be one of ${AREAS.join(', ')}`);
    if (!['S', 'M'].includes(x.complexity)) bad(`Task ${ref}: complexity must be S or M (split larger work)`);
    return { ref, owner: typeof x.owner === 'string' && x.owner.trim() ? x.owner.trim().slice(0, 300) : x.owner === true ? 'Only the owner can do this' : null,
      title: str(x.title, 140, `Task ${ref} title`), area: x.area, complexity: x.complexity, risk: x.risk === 'low' ? 'low' : 'high',
      after, description: str(x.description, 4000, `Task ${ref} description`), acceptance: list(x.acceptance ?? [], `Task ${ref} acceptance`, { max: 8 }) };
  });
  return store.redactValue({ summary: str(r.summary, 1200, 'summary'), goal: str(r.goal, 1200, 'goal'), users: list(r.users, 'users', { min: 1 }),
    scope: list(r.scope, 'scope', { min: 1 }), out_of_scope: list(r.out_of_scope ?? [], 'out_of_scope'), acceptance: list(r.acceptance, 'acceptance', { min: 1 }),
    risks: list(r.risks ?? [], 'risks'), questions: list(r.questions ?? [], 'questions', { max: 8 }), tasks });
}

export function complete(key, revision, attempt, { plan, error, run_id = null, model = null, retryable = false }) {
  const p = current(key);
  // Only the attempt that is running may finish it: a late result from an earlier attempt or round is ignored.
  if (!p || p.revision !== revision || p.attempt !== attempt || p.status !== 'grooming') return null;
  if (plan) {
    save({ ...p, status: 'ready', plan, error: null, run_id, model, ended_at: store.now() });
    store.addComment(key, 'manager', `🧭 **Plan ready** (round ${revision}, groomed with Codex)\n\n${plan.summary}\n\n${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} proposed${plan.questions.length ? `, ${plan.questions.length} question${plan.questions.length === 1 ? '' : 's'} for you` : ''}. Review it on the Features page.`);
    github.flushComments();
    return current(key);
  }
  const again = retryable && p.attempts < MAX_ATTEMPTS;
  save({ ...p, status: again ? 'queued' : 'failed', error, run_id, model, ended_at: again ? null : store.now() });
  store.logEvent({ ticket_key: key, agent_id: 'system', kind: again ? 'system' : 'error',
    text: again ? `Grooming round ${revision} interrupted (${error}); it will run again.` : `Grooming round ${revision} failed: ${error}. Retry it from the Features page.` });
  return current(key);
}

export async function launch(p, fence) {
  const live = current(p.ticket_key);
  if (!live || live.revision !== p.revision || live.status !== 'queued') return;
  const attempt = crypto.randomBytes(6).toString('hex');
  save({ ...live, status: 'grooming', attempt, attempts: (live.attempts || 0) + 1, error: null, started_at: store.now() });
  store.updateAgent('manager', { status: 'working', current_ticket: p.ticket_key, current_kind: 'feature_groom', last_action: 'grooming a feature with Codex', last_action_at: store.now() });
  try {
    const t = store.getTicket(p.ticket_key);
    const cwd = await runner.ensureReadonlyWorkspace('manager');
    // Preparing the clone takes seconds: the owner may have discarded or replaced the round meanwhile.
    const still = current(p.ticket_key);
    if (still?.attempt !== attempt || still.status !== 'grooming' || !isFeature(store.getTicket(p.ticket_key))) return;
    const outcome = await runner.startRun({ agentId: 'manager', kind: 'feature_groom', ticketKey: p.ticket_key, cwd, prompt: promptFor(live, t), fence, pinEngine: ENGINE,
      onStart: (run) => { const now = current(p.ticket_key); if (now?.attempt === attempt) save({ ...now, run_id: run.id }); } });
    if (outcome.aborted || outcome.run?.status !== 'success') throw Object.assign(new Error(store.redact(outcome.run?.result_text || 'the session was stopped').slice(0, 300)), { retryable: !!outcome.failure || !!outcome.aborted });
    complete(p.ticket_key, p.revision, attempt, { plan: parsePlan(outcome.result?.result || outcome.run.result_text), run_id: outcome.run.id, model: outcome.run.model });
  } catch (e) {
    complete(p.ticket_key, p.revision, attempt, { error: store.redact(e.message).slice(0, 400), retryable: !!(e.retryable || e.providerUnavailable), run_id: current(p.ticket_key)?.run_id });
  } finally {
    if (!store.getAgentState('manager')?.current_run) store.updateAgent('manager', { status: 'idle', current_ticket: null, current_kind: null });
  }
}

export function retry(key, { expected_revision } = {}) {
  const p = current(key);
  if (!p || p.revision !== expected_revision) conflict('The plan changed while you were reading. Refresh first.');
  if (p.status !== 'failed') conflict('Only a failed round can be retried');
  startable(store.getTicket(key));
  save({ ...p, status: 'queued', attempts: 0, error: null });
  store.logEvent({ ticket_key: key, agent_id: 'owner', kind: 'system', text: `Retried grooming round ${p.revision}.` });
  return current(key);
}

export function discard(key, { expected_revision } = {}) {
  const p = current(key);
  if (!p || p.revision !== expected_revision) conflict('The plan changed while you were reading. Refresh first.');
  if (['approved', 'grooming'].includes(p.status)) conflict(p.status === 'approved' ? 'An approved plan cannot be discarded' : 'Wait for the grooming round to finish');
  save({ ...p, status: 'discarded', ended_at: store.now() });
  store.logEvent({ ticket_key: key, agent_id: 'owner', kind: 'system', text: `Set aside the plan (round ${p.revision}). Nothing starts until a new round is approved.` });
  return current(key);
}

/** Readable plan block appended under the owner's request on approval. */
export function planMarkdown(plan, revision, keys = {}) {
  const sec = (title, items) => (items.length ? `\n### ${title}\n${items.map((x) => `- ${x}`).join('\n')}\n` : '');
  return `## Plan (approved, round ${revision}, groomed with Codex)
${plan.summary}

**Goal:** ${plan.goal}
${sec('Who it is for', plan.users)}${sec('In scope', plan.scope)}${sec('Out of scope', plan.out_of_scope)}${sec('Acceptance criteria', plan.acceptance)}${sec('Risks', plan.risks)}${sec('Open questions', plan.questions)}
### Tasks
${plan.tasks.map((x) => `- ${keys[x.ref] || x.ref}: ${x.title} (${x.complexity}${x.risk === 'high' ? ', high risk' : ''}${x.after ? `, after ${keys[x.after] || x.after}` : ''})`).join('\n')}`;
}

/**
 * Owner approval: tasks are created and the feature starts. `edits` may drop tasks or change a title or size; the
 * plan revision on screen must still be current and ready, and its request unchanged.
 */
export function approve(key, { expected_revision, edits = [], message = '' } = {}) {
  const t = store.getTicket(key);
  const p = current(key);
  if (!t || !p) bad('Feature or plan not found');
  if (p.revision !== expected_revision) conflict('The plan changed while you were reading. Refresh before approving.');
  if (p.status !== 'ready') conflict('Only a ready plan can be approved');
  if (p.stale) conflict('The request changed after this plan was written. Ask Codex for a new round first.');
  startable(t);
  const byRef = new Map((Array.isArray(edits) ? edits : []).filter((e) => e && typeof e.ref === 'string').map((e) => [e.ref, e]));
  const tasks = p.plan.tasks.filter((x) => byRef.get(x.ref)?.include !== false).map((x) => {
    const e = byRef.get(x.ref) || {};
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim().slice(0, 140) : x.title;
    const complexity = ['S', 'M', 'L'].includes(e.complexity) ? e.complexity : x.complexity;
    return { ...x, title, complexity };
  });
  if (!tasks.length) bad('Keep at least one task');
  const kept = new Set(tasks.map((x) => x.ref));
  const orphan = tasks.find((x) => x.after && !kept.has(x.after));
  if (orphan) bad(`“${orphan.title}” needs “${p.plan.tasks.find((x) => x.ref === orphan.after)?.title}” first; keep both or drop both`);
  const note = String(message || '').trim().slice(0, 4000);
  const keys = {};
  store.transaction(() => {
    for (const x of tasks) {
      const after = x.after ? keys[x.after] : null;
      // A task brief carries its feature's goal and criteria: agents read the task's own description, not the parent's.
      const body = `${x.description}${x.acceptance.length ? `\n\n## Acceptance criteria\n${x.acceptance.map((a) => `- ${a}`).join('\n')}` : ''}`
        + `\n\n## Part of feature ${key}: ${t.title}\n${p.plan.goal}\n\nFeature acceptance criteria:\n${p.plan.acceptance.map((a) => `- ${a}`).join('\n')}`;
      const k = store.createTicket({ title: x.title, description: body, type: 'task', status: 'todo', area: x.area, complexity: x.complexity, priority: t.priority,
        assignee: routeTicket({ area: x.area, complexity: x.complexity, risk: x.risk }), reporter: 'manager', source: 'agent', parent_key: key });
      store.updateTicket(k.key, { risk: x.risk, ...(after ? { after_key: after } : {}), ...(x.owner ? { owner_task: 1, assignee: null } : {}) });
      if (x.owner) store.addComment(k.key, 'manager', `🙋 **This is your task**: ${x.owner}`);
      keys[x.ref] = k.key;
    }
    const plan = { ...p.plan, tasks };
    hooks.setStatus(key, 'in_progress', { assignee: 'manager', resume_status: null, stalls: 0, progress: 0, progress_msg: `0/${tasks.length} tasks merged`,
      description: withPlan(t.description, planMarkdown(plan, p.revision, keys)) });
    store.addComment(key, 'owner', `✅ **Plan approved** (round ${p.revision}): ${tasks.length} task${tasks.length === 1 ? '' : 's'} created: ${Object.values(keys).join(', ')}.${note ? `\n\n${note}` : ''}`);
    save({ ...p, status: 'approved', plan, approved_at: store.now(), approved_tasks: Object.values(keys), task_keys: keys }, { emit: false });
  });
  announce(key);
  github.createIssue(key);
  for (const k of Object.values(keys)) github.createIssue(k);
  github.updateIssueBody(key);
  github.flushComments();
  return { plan: current(key), tasks: Object.values(keys) };
}

/** Owner creates a feature from the Features page: it skips triage and goes straight to a Codex grooming round. */
export function create({ title, goal, priority, area, source = 'human' } = {}) {
  const name = String(title || '').trim();
  const request = String(goal || '').trim();
  if (!name) bad('Give the feature a name');
  if (!request) bad('Describe what it should do and for whom');
  if (name.length > 200 || request.length > 12_000) bad('That is too long');
  const t = store.createTicket({ title: name, description: request, type: 'feature', status: 'proposed', priority: /^P[0-3]$/.test(priority) ? priority : 'P2',
    area: AREAS.includes(area) ? area : null, reporter: 'owner', source: source === 'hub' ? 'hub' : 'human' });
  return { ticket: store.getTicket(t.key), plan: start(t.key) };
}

/** A restart interrupts any running round: it goes back to the queue (attempts are kept). */
export function recover() {
  for (const p of summaries()) if (p.status === 'grooming') save({ ...p, status: p.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error: 'interrupted by a desk restart' });
  reconcileGithub();
}
/** The GitHub queue is not durable: on start, make sure approved features and their tasks have issues and a current body. */
export function reconcileGithub() {
  for (const p of summaries()) {
    if (p.status !== 'approved') continue;
    github.createIssue(p.ticket_key);
    for (const k of p.approved_tasks || []) github.createIssue(k);
    github.updateIssueBody(p.ticket_key);
  }
}
