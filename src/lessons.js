// Team lessons: the desk's mentoring loop. After a setback, the builder fixing it proposes one short lesson
// (`desk lesson "<text>"`); the owner approves, edits, rejects or retires it on the Team page. Active lessons are
// appended to build prompts (never to charters, so they do not change a seat's provenance), with who learned them;
// QA sees them with ids and marks a failure that repeats one (`desk qa fail --lesson ID`). A lesson that keeps being
// repeated is not working; one never repeated is working or was not needed. The owner decides; nothing retires itself.
import * as store from './db.js';
import { agentById } from './team.js';

export const MAX_TEXT = 300;
export const MAX_ACTIVE_IN_PROMPT = 5;
const PER_TICKET = 2;
const BUILD_KINDS = new Set(['implement', 'respond', 'resolve']);
const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
const conflict = (m) => { throw Object.assign(new Error(m), { status: 409 }); };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const announce = () => store.bus.emit('msg', { type: 'lessons', data: null });

/** A builder proposes a lesson from the run that fixes its own work. */
export function propose({ run, ticket, text }) {
  if (!BUILD_KINDS.has(run.kind) || !ticket) bad('propose a lesson from the run that fixes this task');
  // A lesson comes from a setback: QA sent the work back, a reviewer asked for changes, or a conflict had to be resolved.
  if (!(ticket.qa_loops > 0 || ticket.review_round > 0 || run.kind !== 'implement')) bad('lessons come from fixing work that was sent back; this task has not been');
  const body = String(text || '').trim().replace(/\s+/g, ' ');
  if (body.length < 10 || body.length > MAX_TEXT) bad(`a lesson is one sentence of 10 to ${MAX_TEXT} characters`);
  const all = store.listLessons();
  if (all.filter((l) => l.source_ticket === ticket.key).length >= PER_TICKET) bad(`at most ${PER_TICKET} lessons per task`);
  // Same text in a scope this task's builds read (its area, or every area) is a duplicate; another area's is not.
  const twin = all.find((l) => ['proposed', 'active'].includes(l.status) && (!l.area || l.area === (ticket.area || null)) && norm(l.text) === norm(body));
  if (twin) return `Lesson #${twin.id} already says that.`;
  const l = store.insertLesson({ area: ticket.area || null, text: body, source_ticket: ticket.key, proposed_by: run.agent_id });
  store.logEvent({ run_id: run.id, agent_id: run.agent_id, ticket_key: ticket.key, kind: 'action', text: `proposed lesson #${l.id}: ${body.slice(0, 120)}` });
  announce();
  return `Lesson #${l.id} proposed; the owner reviews it on the Team page. Continue your task.`;
}

/** Owner decisions. `expected_updated_at` guards against deciding a lesson someone changed meanwhile. */
export function decide(id, { action, text, area, expected_updated_at } = {}) {
  const l = store.getLesson(Number(id));
  if (!l) throw Object.assign(new Error('No such lesson'), { status: 404 });
  if (!expected_updated_at) bad('expected_updated_at is required (the version you read)');
  if (expected_updated_at !== l.updated_at) conflict('This lesson changed while you were reading. Refresh first.');
  const at = store.now();
  let out;
  if (action === 'approve') { if (l.status !== 'proposed') conflict('Only a proposed lesson can be approved'); out = store.updateLesson(l.id, { status: 'active', decided_by: 'owner', decided_at: at, ...edits(text, area) }); }
  else if (action === 'reject') { if (l.status !== 'proposed') conflict('Only a proposed lesson can be rejected'); out = store.updateLesson(l.id, { status: 'rejected', decided_by: 'owner', decided_at: at }); }
  else if (action === 'retire') { if (l.status !== 'active') conflict('Only an active lesson can be retired'); out = store.updateLesson(l.id, { status: 'retired', decided_by: 'owner', decided_at: at }); }
  else if (action === 'edit') {
    if (!['proposed', 'active'].includes(l.status)) conflict('This lesson is closed');
    const e = edits(text, area);
    if (!Object.keys(e).length) bad('nothing to change');
    if (l.status === 'active' && e.text !== undefined && e.text !== l.text) {
      // New words are a new lesson: the old one's tasks and repeats belong to the old words.
      out = store.transaction(() => {
        store.updateLesson(l.id, { status: 'retired', decided_by: 'owner', decided_at: at, note: 'replaced by an edit' });
        const n = store.insertLesson({ area: e.area !== undefined ? e.area : l.area, text: e.text, source_ticket: l.source_ticket, proposed_by: l.proposed_by });
        return store.updateLesson(n.id, { status: 'active', decided_by: 'owner', decided_at: at, note: `replaces #${l.id}` });
      });
    } else out = store.updateLesson(l.id, e);
  }
  else bad('action must be approve, reject, retire or edit');
  store.logEvent({ agent_id: 'owner', kind: 'action', text: `lesson #${l.id} ${{ approve: 'approved', reject: 'rejected', retire: 'retired', edit: 'edited' }[action]}` });
  announce();
  return out;
}
function edits(text, area) {
  const out = {};
  if (text !== undefined) { const t = String(text).trim().replace(/\s+/g, ' '); if (t.length < 10 || t.length > MAX_TEXT) bad(`a lesson is one sentence of 10 to ${MAX_TEXT} characters`); out.text = t; }
  if (area !== undefined) out.area = area || null;
  return out;
}

/** Active lessons for an area: that area's first, then general ones; the most repeated first (they matter most). */
export function activeFor(area) {
  return store.listLessons().filter((l) => l.status === 'active' && (!l.area || l.area === area))
    .sort((a, b) => Number(!!b.area && b.area === area) - Number(!!a.area && a.area === area) || b.repeats - a.repeats || a.id - b.id)
    .slice(0, MAX_ACTIVE_IN_PROMPT);
}
const who = (id) => agentById[id]?.name || id || 'the team';

/** Append lessons to a build or QA prompt (one place for every build path: fresh, rework, resumed, continuations). */
const pending = new Map(); // run id → lesson ids selected for its prompt, recorded once the process starts
/** The run's process started: its prompt (with these lessons) was delivered. */
export function delivered(runId, ticketKey) {
  const ids = pending.get(runId);
  pending.delete(runId);
  if (ids?.length) store.recordExposures(runId, ticketKey, ids);
}
export function decorate({ kind, ticket, prompt, runId, resumed = false }) {
  if (!ticket || !(BUILD_KINDS.has(kind) || kind === 'qa')) return prompt;
  const seen = resumed && kind !== 'qa' ? store.exposedLessons(ticket.key) : new Set();
  const current = activeFor(ticket.area);
  // A resumed session still holds what it was told before: say which of those lessons were retired since.
  const gone = [...seen].filter((id) => !current.some((l) => l.id === id)).map((id) => store.getLesson(id)).filter((l) => l && l.status !== 'active');
  const ls = current.filter((l) => !seen.has(l.id));
  const revoked = gone.length ? `\n\nTeam lessons retired since you were told them (no longer follow them):\n${gone.map((l) => `- ${l.text}`).join('\n')}` : '';
  if (!ls.length) return `${prompt}${revoked}`;
  if (kind === 'qa') {
    return `${prompt}\n\nActive team lessons for this area. If a defect repeats one, add --lesson <id> to desk qa fail:\n${ls.map((l) => `- #${l.id}: ${l.text}`).join('\n')}`;
  }
  pending.set(runId, ls.map((l) => l.id));
  return `${prompt}${revoked}\n\nTeam lessons (learned on earlier tasks and approved by the owner; follow them):\n${ls.map((l) => `- ${l.text} (from ${who(l.proposed_by)})`).join('\n')}`;
}
