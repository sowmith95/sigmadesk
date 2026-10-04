// Epic review: when an epic's tasks are blocked or its requirements are unclear, the manager works through the whole tree
// (consulting one principal at most twice) and returns an order of work, priorities, the steps only the owner can do,
// and ONE consolidated question instead of a question per task. Safe changes (order, priority, owner tasks) apply at
// once and are listed in a comment; the question and any proposed closes wait for the owner in the Inbox.
// State lives in kv `epic-review:KEY` (same pattern as feature plans), fenced by attempt.
import crypto from 'node:crypto';
import * as store from './db.js';
import * as runner from './runner.js';
import * as github from './github.js';
import * as flow from '../public/flow.js';
import { ENGINE } from './features.js';

const MAX_ATTEMPTS = 2;
const AUTO_EVERY_MS = 24 * 3600_000;
const OPEN = (t) => !['done', 'wontdo'].includes(t.status);
const NOT_STARTED = new Set(['triage', 'proposed', 'todo', 'needs_human']);
const keyOf = (key) => `epic-review:${key}`;
const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
const conflict = (m) => { throw Object.assign(new Error(m), { status: 409 }); };

/** Set by the scheduler (it owns ticket transitions): ownerTask, ownerReply, ownerPatch. */
export const hooks = { ownerTask: null, ownerReply: null, ownerPatch: null };

export function current(key) { const raw = store.kvGet(keyOf(key)); return raw ? JSON.parse(raw) : null; }
function save(r) {
  const value = { ...r, updated_at: store.now() };
  store.kvSet(keyOf(r.key), JSON.stringify(value));
  store.bus.emit('msg', { type: 'epic-review', data: value });
  return value;
}
const roots = () => { const all = store.listTickets(); const ix = flow.index(all); return { all, ix, roots: all.filter((t) => !t.parent_key && (ix.kids.get(t.key) || []).length) }; };
export function summaries() { return roots().roots.map((t) => current(t.key)).filter(Boolean); }

/** Open questions parked in a tree (tasks the team stopped on), not owner tasks. */
export function parkedQuestions(rootKey, all = store.listTickets(), ix = flow.index(all)) {
  // needs_human also holds publish guards and submitted work waiting on a call; only work that has not shipped code counts.
  return flow.descendants(rootKey, ix).filter((t) => t.status === 'needs_human' && !t.owner_task && !t.head_sha && !t.pr_url);
}

export function start(key, { by = 'owner', reason = '' } = {}) {
  const t = store.getTicket(key);
  if (!t) bad('no such ticket');
  if (t.parent_key) bad('review the epic at the top of the tree, not one of its tasks');
  if (!store.childrenOf(key).length) bad('this ticket has no tasks yet; groom or split it first');
  const old = current(key);
  if (old && ['queued', 'running'].includes(old.status)) conflict('A review of this epic is already under way');
  const r = { key, round: (old?.round || 0) + 1, status: 'queued', by, reason: String(reason).slice(0, 500), attempts: 0,
    questions_seen: parkedQuestions(key).map((q) => q.key), created_at: store.now(), engine: ENGINE };
  store.logEvent({ ticket_key: key, agent_id: 'system', kind: 'system', text: `Epic review ${r.round} queued (${by === 'owner' ? 'you asked' : reason || 'tasks are blocked'}).` });
  return save(r);
}
export function next() {
  return summaries().filter((r) => r.status === 'queued').sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))[0] || null;
}
/** The desk starts a review on its own when two or more tasks in one epic are parked on questions it has not reviewed. */
export function autoCandidate(now = Date.now()) {
  const { all, ix, roots: rs } = roots();
  for (const t of rs) {
    if (!OPEN(t)) continue;
    const parked = parkedQuestions(t.key, all, ix);
    if (parked.length < 2) continue;
    const r = current(t.key);
    if (r && ['queued', 'running'].includes(r.status)) continue;
    if (r && now - Date.parse(r.created_at) < AUTO_EVERY_MS) continue;
    if (r && parked.every((q) => (r.questions_seen || []).includes(q.key))) continue;
    return t.key;
  }
  return null;
}

function outline(rootKey, all, ix) {
  const depth = (t) => flow.ancestors(t, ix).length;
  const tree = [ix.byKey.get(rootKey), ...flow.descendants(rootKey, ix)];
  return tree.map((t) => {
    const blockers = [...flow.recordedBlockers(t, ix).map((b) => `after ${b.key}${b.via !== t.key ? ` (via ${b.via})` : ''}`), ...flow.textGates(t, ix).map((g) => `text says it waits on ${g} (not recorded)`)];
    const tags = [t.status, t.priority, t.area, t.assignee && `assignee ${t.assignee}`, t.owner_task && 'OWNER TASK', ...blockers].filter(Boolean).join('; ');
    return `${'  '.repeat(depth(t))}- ${t.key} "${t.title}" [${tags}]`;
  }).join('\n');
}
export function promptFor(r) {
  const all = store.listTickets(); const ix = flow.index(all);
  const root = ix.byKey.get(r.key);
  const parked = parkedQuestions(r.key, all, ix).map((q) => {
    const last = store.listComments(q.key).slice(-3).map((c) => `    ${c.author}: ${String(c.body).slice(0, 900)}`).join('\n');
    return `- ${q.key} "${q.title}" (${q.progress_msg || 'needs the owner'})\n${last}`;
  }).join('\n') || '(none)';
  const nx = flow.nextStep(r.key, all, ix);
  return `Epic ${root.key}: "${root.title}" (priority ${root.priority})

<request>
${String(root.description || '').slice(0, 4000)}
</request>

Tree (indent = child of the line above):
${outline(r.key, all, ix)}

Questions the team is parked on:
${parked}
${nx ? `\nThe desk's current guess for the next step: ${nx.task.key} (${nx.waiting.length} tasks wait on it).` : ''}
${r.reason ? `\nWhy this review was requested: ${r.reason}\n` : ''}
Work out what blocks this epic and how to unblock it. Read the code where it helps. When a technical question decides the order
or scope, ask the principal for that area once (desk consult principal-be|principal-fe "<question>"); at most two consults.
Then return ONLY one JSON object as your final answer:
{"summary":"two sentences for a busy owner: where this epic stands and what unblocks it",
 "next":{"key":"TASK-KEY","why":"why this goes first"},
 "order":[{"key":"TASK-KEY","after":"TASK-KEY","why":"short"}],
 "priorities":[{"key":"TASK-KEY","priority":"P0|P1|P2|P3"}],
 "owner_tasks":[{"key":"TASK-KEY","ask":"exactly what the owner must do or provide"}],
 "question":{"text":"ONE question that answers every parked question above, numbered if it has parts","covers":["TASK-KEY"]},
 "close":[{"key":"TASK-KEY","why":"duplicate / no longer needed"}]}
Rules: only keys from the tree. "order" records real dependencies (including any "text says it waits on" worth keeping); never
a loop. owner_tasks are steps no engineer seat can do (production access, credentials, accounts, a business decision).
"question" is null when nothing needs the owner; "covers" lists the parked tasks the answer unblocks. Under 600 words.`;
}

const KEY = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
export function parseResult(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const from = s.indexOf('{'), to = s.lastIndexOf('}');
  let r;
  try { r = JSON.parse(from >= 0 && to > from ? s.slice(from, to + 1) : s); } catch { bad('The review did not return JSON'); }
  if (typeof r?.summary !== 'string' || !r.summary.trim()) bad('The review needs a summary');
  const keyed = (v, extra) => (Array.isArray(v) ? v : []).filter((x) => x && KEY.test(String(x.key))).slice(0, 30).map((x) => ({ key: String(x.key), ...extra(x) }));
  const text500 = (v) => (typeof v === 'string' ? v.trim().slice(0, 500) : '');
  const q = r.question && typeof r.question.text === 'string' && r.question.text.trim()
    ? { text: r.question.text.trim().slice(0, 3000), covers: (Array.isArray(r.question.covers) ? r.question.covers : []).map(String).filter((k) => KEY.test(k)).slice(0, 30) } : null;
  return store.redactValue({
    summary: r.summary.trim().slice(0, 1200),
    next: r.next && KEY.test(String(r.next.key)) ? { key: String(r.next.key), why: text500(r.next.why) } : null,
    order: keyed(r.order, (x) => ({ after: KEY.test(String(x.after)) ? String(x.after) : null, why: text500(x.why) })).filter((x) => x.after),
    priorities: keyed(r.priorities, (x) => ({ priority: /^P[0-3]$/.test(x.priority) ? x.priority : null })).filter((x) => x.priority),
    owner_tasks: keyed(r.owner_tasks, (x) => ({ ask: text500(x.ask) })).filter((x) => x.ask),
    question: q,
    close: keyed(r.close, (x) => ({ why: text500(x.why) })),
  });
}

/** Apply the safe parts; everything refused is listed with its reason (the owner sees both). */
export function apply(rootKey, result, snapshot = null) {
  const applied = [], skipped = [];
  const touched = new Set(); // our own edits change updated_at too
  const changed = (t) => snapshot && !touched.has(t.key) && snapshot[t.key] !== undefined && snapshot[t.key] !== t.updated_at;
  const fresh = () => { const all = store.listTickets(); return { all, ix: flow.index(all) }; };
  const inTree = (k, ix) => { const t = ix.byKey.get(k); return t && flow.rootOf(t, ix).key === rootKey ? t : null; };
  for (const o of result.order) {
    const { all, ix } = fresh();
    const t = inTree(o.key, ix), a = inTree(o.after, ix);
    const why = !t || !a ? 'not in this epic' : !OPEN(t) || !OPEN(a) ? 'already closed' : !t.parent_key ? 'the epic itself' : !NOT_STARTED.has(t.status) ? 'work has started'
      : t.after_key === o.after ? null : changed(t) ? 'changed during the review'
        : t.after_key && ix.byKey.get(t.after_key)?.status !== 'done' ? `already waits for ${t.after_key} (change it yourself if ${o.after} matters more)`
          : flow.wouldCycle(o.key, o.after, all, ix) ? 'would make a loop' : '';
    if (why === null) continue;
    if (why) { skipped.push(`${o.key} after ${o.after}: ${why}`); continue; }
    hooks.ownerPatch(o.key, { after_key: o.after }); touched.add(o.key); applied.push(`${o.key} now waits for ${o.after}`);
  }
  for (const p of result.priorities) {
    const { ix } = fresh(); const t = inTree(p.key, ix);
    if (!t || !OPEN(t)) { skipped.push(`${p.key} priority: not an open task in this epic`); continue; }
    if (t.priority === p.priority) continue;
    if (changed(t)) { skipped.push(`${p.key} priority: changed during the review`); continue; }
    hooks.ownerPatch(p.key, { priority: p.priority }); touched.add(p.key); applied.push(`${p.key} priority ${t.priority} → ${p.priority}`);
  }
  for (const o of result.owner_tasks) {
    const { ix } = fresh(); const t = inTree(o.key, ix);
    if (!t || !t.parent_key || !OPEN(t)) { skipped.push(`${o.key} as your task: not an open task in this epic`); continue; }
    if (t.owner_task) continue;
    if (!NOT_STARTED.has(t.status) || t.active_run || t.head_sha || t.pr_url) { skipped.push(`${o.key} as your task: work has started`); continue; }
    if (changed(t)) { skipped.push(`${o.key} as your task: changed during the review`); continue; }
    hooks.ownerTask(o.key, { owner_task: true, why: o.ask, by: 'manager' }); touched.add(o.key); applied.push(`${o.key} is your task: ${o.ask}`);
  }
  return { applied, skipped };
}

export function complete(r, attempt, { result, error, run_id = null, retryable = false }) {
  const live = current(r.key);
  if (!live || live.round !== r.round || live.attempt !== attempt || live.status !== 'running') return null;
  if (result) {
    const outcome = apply(r.key, result, live.snapshot);
    const parked = new Set(parkedQuestions(r.key).map((t) => t.key));
    const covers = (result.question?.covers || []).filter((k) => parked.has(k));
    if (result.question) result.question.covers = covers;
    const lines = [`🧭 **Epic review ${r.round}** — ${result.summary}`];
    if (result.next) lines.push(`**Next:** ${result.next.key}: ${result.next.why}`);
    if (outcome.applied.length) lines.push(`**Changed:**\n${outcome.applied.map((x) => `- ${x}`).join('\n')}`);
    if (outcome.skipped.length) lines.push(`**Not changed:**\n${outcome.skipped.map((x) => `- ${x}`).join('\n')}`);
    if (result.question) lines.push(`**One question for you** (answers ${covers.length ? covers.join(', ') : 'this epic'}):\n${result.question.text}`);
    if (result.close.length) lines.push(`**Proposed to close** (your call):\n${result.close.map((c) => `- ${c.key}: ${c.why}`).join('\n')}`);
    store.addComment(r.key, 'manager', lines.join('\n\n'));
    github.flushComments();
    return save({ ...live, status: 'ready', result, applied: outcome, question_state: result.question ? 'open' : null,
      close_state: result.close.length ? 'open' : null, run_id, error: null, ended_at: store.now() });
  }
  const again = retryable && live.attempts < MAX_ATTEMPTS;
  store.logEvent({ ticket_key: r.key, agent_id: 'system', kind: again ? 'system' : 'error', text: again ? `Epic review interrupted (${error}); it will run again.` : `Epic review failed: ${error}` });
  return save({ ...live, status: again ? 'queued' : 'failed', error, run_id, ended_at: again ? null : store.now() });
}

export async function launch(r, fence) {
  const live = current(r.key);
  if (!live || live.round !== r.round || live.status !== 'queued') return;
  const attempt = crypto.randomBytes(6).toString('hex');
  save({ ...live, status: 'running', attempt, attempts: (live.attempts || 0) + 1, error: null, started_at: store.now() });
  store.updateAgent('manager', { status: 'working', current_ticket: r.key, current_kind: 'epic_review', last_action: 'reviewing an epic that is stuck', last_action_at: store.now() });
  try {
    const cwd = await runner.ensureReadonlyWorkspace('manager');
    const still = current(r.key);
    if (still?.attempt !== attempt || still.status !== 'running') return;
    // What the manager saw: a task edited during the review keeps the owner's edit (its recommendation is skipped).
    const ix = flow.index(store.listTickets());
    const snapshot = Object.fromEntries([ix.byKey.get(r.key), ...flow.descendants(r.key, ix)].map((t) => [t.key, t.updated_at]));
    save({ ...still, snapshot });
    const outcome = await runner.startRun({ agentId: 'manager', kind: 'epic_review', ticketKey: r.key, cwd, prompt: promptFor(still), fence, pinEngine: ENGINE,
      onStart: (run) => { const now = current(r.key); if (now?.attempt === attempt) save({ ...now, run_id: run.id }); } });
    if (outcome.aborted || outcome.run?.status !== 'success') throw Object.assign(new Error(store.redact(outcome.run?.result_text || 'the session was stopped').slice(0, 300)), { retryable: !!outcome.failure || !!outcome.aborted });
    complete(r, attempt, { result: parseResult(outcome.result?.result || outcome.run.result_text), run_id: outcome.run.id });
  } catch (e) {
    complete(r, attempt, { error: store.redact(e.message).slice(0, 400), retryable: !!(e.retryable || e.providerUnavailable), run_id: current(r.key)?.run_id });
  } finally {
    if (!store.getAgentState('manager')?.current_run) store.updateAgent('manager', { status: 'idle', current_ticket: null, current_kind: null });
  }
}

/** The owner answers the one question: it goes on the epic and resumes every parked task it covers. */
export function answer(key, { text, round } = {}) {
  const r = current(key);
  if (!r || r.round !== round) conflict('The review changed while you were reading. Refresh first.');
  if (r.question_state !== 'open') conflict('This question is already answered');
  const body = String(text || '').trim();
  if (body.length < 2) bad('write your answer');
  hooks.ownerReply(key, `**Answer to epic review ${r.round}:** ${body}`, 'comment');
  const resumed = [];
  const parked = new Set(parkedQuestions(key).map((t) => t.key));
  for (const k of r.result.question?.covers || []) {
    if (!parked.has(k)) continue;
    hooks.ownerReply(k, `(answered once for the epic ${key})\n\n${body}`, 'answer'); resumed.push(k);
  }
  return { ...save({ ...r, question_state: 'answered', answered_at: store.now() }), resumed };
}
/** Close the tasks the review proposed (approve) or keep them (dismiss). */
export function decideCloses(key, { approve, round } = {}) {
  const r = current(key);
  if (!r || r.round !== round) conflict('The review changed while you were reading. Refresh first.');
  if (r.close_state !== 'open') conflict('Already decided');
  const closed = [];
  if (approve) for (const c of r.result.close) {
    const t = store.getTicket(c.key);
    if (!t || !OPEN(t) || t.active_run > 0 || flow.rootOf(t, flow.index(store.listTickets())).key !== key) continue;
    hooks.ownerPatch(c.key, { status: 'wontdo' }); store.addComment(c.key, 'owner', `Closed after epic review ${r.round}: ${c.why}`); closed.push(c.key);
  }
  return { ...save({ ...r, close_state: approve ? 'closed' : 'kept' }), closed };
}
export function dismiss(key, { round } = {}) {
  const r = current(key);
  if (!r || r.round !== round) conflict('The review changed while you were reading. Refresh first.');
  return save({ ...r, question_state: r.question_state === 'open' ? 'dismissed' : r.question_state, close_state: r.close_state === 'open' ? 'kept' : r.close_state });
}
export function retry(key) {
  const r = current(key);
  if (r?.status !== 'failed') conflict('Only a failed review can be retried');
  return save({ ...r, status: 'queued', attempts: 0, error: null });
}
export function recover() {
  for (const r of summaries()) if (r.status === 'running') save({ ...r, status: r.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', error: 'interrupted by a desk restart' });
}
