// The Inbox's order, in rules a person can follow (no hidden score). Pure; attention.board() applies it and the server
// validates snoozes with the same helpers.
// - Lanes by what the owner is doing: unblock the team · review to ship · your tasks · proposals.
// - Inside a lane: priority (P0 first), then how many tasks wait on it (each task once), then how long it has waited
//   (since the desk first saw the decision, not since the ticket was last touched), then id.
// - "Do first": the first row overall, except that a publish guard, a production page or a P0 jumps every lane.
// - Snooze is owner attention only: it never changes the ticket. Guards, pages and anything linked to an open
//   incident cannot be snoozed; a snoozed row comes back when its time passes or when the decision changes.
import * as flow from './flow.js';

export const LANES = [
  { id: 'unblock', title: 'Unblock the team', hint: 'Someone is waiting on your answer or approval' },
  { id: 'ship', title: 'Review to ship', hint: 'Finished work waiting for your merge or publish' },
  { id: 'mine', title: 'Your tasks', hint: 'Steps only you can do' },
  { id: 'proposals', title: 'Proposals', hint: 'Ideas waiting for your call; nobody is blocked' },
];
const LANE_OF = { merge: 'ship', publish: 'ship', owner_task: 'mine', research: 'proposals' };
export const laneOf = (d) => LANE_OF[d.kind] || 'unblock';
const PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };
// A rough sense of the effort, so a spare five minutes finds the right item.
export const TIME_HINT = { question: 'quick', guard: 'quick', publish: 'quick', epic_review: 'quick', page: 'now', merge: '5 min', research: '5 min',
  plan: '10 min', design: '10 min', council: '10 min', product: '10 min', owner_task: 'needs time' };
const OPEN_INCIDENT = new Set(['watching', 'investigating', 'paged', 'ticketed']);
export const SNOOZE_MAX_DAYS = 30;

/**
 * Never deferred: a publish guard, a production page, a ticket the on-call engineer filed from the error watch, or
 * any ticket (including folded questions) linked to an open incident. `protectedKeys`: tickets with an open
 * incident, from the server (independent of whether the watch is on or how many incidents are listed).
 */
export function isProtected(d, incidents = [], protectedKeys = []) {
  if (d.kind === 'guard' || d.kind === 'page') return true;
  const keys = [d.ticket?.key, ...(d.waiting || []).map((w) => w.key)].filter(Boolean);
  if (d.ticket && (d.ticket.source === 'watch' || d.ticket.reporter === 'sre')) return true;
  return keys.some((k) => protectedKeys.includes(k) || incidents.some((i) => i.ticket_key === k && OPEN_INCIDENT.has(i.status)));
}
/**
 * What makes a decision "new again": its status, commit, QA and review rounds, what it asks (its action, and for an
 * epic review which question is open), and any newly folded question. A merge's progress note is left out: the merge
 * train rewrites it as it waits, which is not news for the owner.
 */
export function versionOf(d) {
  const t = d.ticket || {};
  const said = d.kind === 'merge' || d.kind === 'publish' ? '' : t.progress_msg || '';
  return [d.id, d.action || '', t.status || '', t.head_sha || '', t.qa_loops || 0, t.review_round || 0, t.review_stage || '', said,
    d.review ? `${d.review.question_state || ''}/${d.review.close_state || ''}` : '', (d.waiting || []).map((w) => w.id).sort().join(',')].join('|');
}

/**
 * rows: the grouped Inbox rows. ctx: { tickets, ix, snoozes: { id: { until, version } }, since: { id: iso }, incidents, now }.
 * → { active (ordered), snoozed (ordered by wake time), doFirst: id | null }. Rows gain lane, priority, waits, since,
 *   protected, snoozed_until, version, time_hint.
 */
export function arrange(rows, ctx = {}) {
  const { tickets = [], snoozes = {}, since = {}, incidents = [], protectedKeys = [], now = Date.now() } = ctx;
  const ix = ctx.ix || flow.index(tickets);
  const rich = rows.map((d) => {
    // Unique tasks waiting on it: the dependency graph and the folded questions name some of the same tickets.
    const keys = new Set([...(d.ticket ? flow.waitingOn(d.ticket.key, tickets, ix).map((w) => w.key) : []), ...(d.waiting || []).map((w) => w.key)]);
    keys.delete(d.ticket?.key);
    const prot = isProtected(d, incidents, protectedKeys);
    const version = versionOf(d);
    const s = snoozes[d.id];
    const until = !prot && s && Date.parse(s.until) > now && s.version === version ? s.until : null;
    return { ...d, lane: laneOf(d), priority: d.ticket?.priority || 'P2', waits: keys.size, since: since[d.id] || d.ticket?.updated_at || d.incident?.last_seen || null,
      protected: prot, snoozed_until: until, version, time_hint: TIME_HINT[d.kind] || null };
  });
  const lane = Object.fromEntries(LANES.map((l, i) => [l.id, i]));
  // Ties: a person waiting (question, guard) before a document to read (plan, design, council), then id.
  const KIND = { guard: 0, page: 0, question: 1, owner_task: 1, epic_review: 1, merge: 2, publish: 3, plan: 4, product: 4, design: 5, council: 6, research: 7 };
  const within = (a, b) => (PRIORITY[a.priority] ?? 2) - (PRIORITY[b.priority] ?? 2) || b.waits - a.waits
    || String(a.since || '9').localeCompare(String(b.since || '9')) || (KIND[a.kind] ?? 8) - (KIND[b.kind] ?? 8) || String(a.id).localeCompare(String(b.id));
  const byLane = (a, b) => lane[a.lane] - lane[b.lane] || within(a, b);
  const active = rich.filter((d) => !d.snoozed_until).sort(byLane);
  const snoozed = rich.filter((d) => d.snoozed_until).sort((a, b) => String(a.snoozed_until).localeCompare(String(b.snoozed_until)));
  const urgent = (d) => d.kind === 'guard' || d.kind === 'page' || d.priority === 'P0';
  const doFirst = [...active].sort((a, b) => Number(urgent(b)) - Number(urgent(a)) || byLane(a, b))[0]?.id || null;
  return { active, snoozed, doFirst };
}

/** Why a row sits where it does, in words: "P1 · 3 tasks wait · waiting 16 h". */
export function reasons(d, now = Date.now()) {
  const out = [];
  if (d.priority && d.priority !== 'P2') out.push(d.priority);
  if (d.waits) out.push(`${d.waits} task${d.waits === 1 ? '' : 's'} wait`);
  const h = d.since ? (now - Date.parse(d.since)) / 3600_000 : null;
  if (h != null && Number.isFinite(h)) out.push(h < 1 ? 'new' : h < 48 ? `waiting ${Math.round(h)} h` : `waiting ${Math.round(h / 24)} d`);
  return out;
}

/** Snooze presets with exact wake times (local clock of the browser). */
export function snoozePresets(now = new Date()) {
  const at = (d) => d.toISOString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(now); week.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); week.setHours(9, 0, 0, 0);
  return [{ id: '4h', label: 'For 4 hours', until: at(new Date(now.getTime() + 4 * 3600_000)) },
    { id: 'tomorrow', label: 'Until tomorrow 9:00', until: at(tomorrow) },
    { id: 'week', label: 'Until Monday 9:00', until: at(week) }];
}
