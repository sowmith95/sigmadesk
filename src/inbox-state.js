// The owner's Inbox state on the server (so a phone and a laptop agree): when each decision first needed the owner
// (its real waiting time; a ticket edit does not reset it) and what the owner snoozed. Both live in kv. Snoozing is
// attention only: it never changes a ticket, a dependency or the scheduler.
import * as store from './db.js';
import { isProtected, versionOf, SNOOZE_MAX_DAYS } from '../public/inbox.js';

const SINCE = 'inbox:since', SNOOZES = 'inbox:snoozes';
const read = (k) => { try { return JSON.parse(store.kvGet(k) || '{}') || {}; } catch { return {}; } };
const bad = (m, status = 400) => { throw Object.assign(new Error(m), { status }); };

/** Record the first time each current decision was seen; forget decisions that are gone. Returns the map. */
export function trackSince(decisions, now = new Date().toISOString(), { seed = false } = {}) {
  const old = read(SINCE);
  const next = {};
  let changed = false;
  // The first time the desk ever tracks (an upgrade), existing decisions start from their ticket's last change rather
  // than "now", so their age is roughly right from day one. After that a new decision starts when it appears.
  const first = seed || !store.kvGet('inbox:since:seeded');
  for (const d of decisions) {
    const was = d.ticket?.updated_at || d.incident?.last_seen;
    next[d.id] = first && was && (!old[d.id] || was < old[d.id]) ? was : old[d.id] || now;
    if (next[d.id] !== old[d.id]) changed = true;
  }
  if (first) store.kvSet('inbox:since:seeded', now);
  if (changed || Object.keys(old).length !== Object.keys(next).length) store.kvSet(SINCE, JSON.stringify(next));
  return next;
}

export const readSince = () => read(SINCE);
export const readSnoozes = () => read(SNOOZES);
/**
 * Current snoozes, reconciled with the decisions: a snooze ends for good when its time passes, its decision is gone,
 * the decision changed (another version), or it became protected; it never comes back by itself later.
 */
export function snoozes(decisions = null, { incidents = [], protectedKeys = [], now = Date.now() } = {}) {
  const all = read(SNOOZES);
  const byId = decisions ? new Map(decisions.map((d) => [d.id, d])) : null;
  const live = Object.fromEntries(Object.entries(all).filter(([id, s]) => {
    if (!(Date.parse(s.until) > now)) return false;
    if (!byId) return true;
    const d = byId.get(id);
    return !!d && s.version === versionOf(d) && !isProtected(d, incidents, protectedKeys);
  }));
  if (Object.keys(live).length !== Object.keys(all).length) store.kvSet(SNOOZES, JSON.stringify(live));
  return live;
}

/**
 * Snooze one Inbox row until a time, or bring it back (until: null). `decisions` are the board's current decisions;
 * `incidents` decide protection. The stored version makes the row come back if the decision changes meanwhile.
 */
export function setSnooze({ id, until }, { decisions, incidents = [], protectedKeys = [], now = Date.now() }) {
  const d = decisions.find((x) => x.id === id);
  if (!d) bad('That item is no longer in your Inbox', 409);
  const all = read(SNOOZES);
  if (until === undefined) bad('until is required (a time, or null to bring it back)');
  if (until === null) { delete all[id]; store.kvSet(SNOOZES, JSON.stringify(all)); return { id, until: null }; }
  if (isProtected(d, incidents, protectedKeys)) bad('This cannot be snoozed: it protects production (publish guard, alert or open incident)', 409);
  const at = Date.parse(until);
  if (!Number.isFinite(at) || at <= now) bad('Pick a time in the future');
  if (at > now + SNOOZE_MAX_DAYS * 86400_000) bad(`At most ${SNOOZE_MAX_DAYS} days`);
  all[id] = { until: new Date(at).toISOString(), version: versionOf(d), at: new Date(now).toISOString() };
  store.kvSet(SNOOZES, JSON.stringify(all));
  return { id, ...all[id] };
}
