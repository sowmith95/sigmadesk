// Team stats: how each seat does on the work it builds. Feeds balanced assignment (src/assign.js), the Team page and
// the seat sheet, so every surface means the same thing by "first-try QA" and "shipped".
// - author: the ticket's recorded builder, else the seat of its first implement run
// - first-try QA: the first QA verdict on the ticket (QA seat's "QA passed/failed KEY"), abandoned tickets included
// - shipped: a merge event; owner tasks and epics are not counted
// - cycle time: first implement start → merge; cost: measured run cost only (estimated runs counted separately)
// Everything is grouped by size (S vs M and larger) so a junior's small tasks are not compared with a senior's medium
// ones, and every number carries its denominator.
import * as store from './db.js';

const BUILD = new Set(['implement', 'respond', 'resolve']);
const DAY = 86400_000;
export const cohortOf = (t) => (t?.complexity === 'S' ? 'S' : 'M+');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const blank = () => ({ built: 0, qa_first: 0, qa_first_pass: 0, shipped: 0, cost: [], estimated_runs: 0, review_rounds: 0, cycle: [] });

/** Pure: facts (store.assignmentFacts) → { seats: { id: { all, S, 'M+', builds_14d, busy_hours_7d } }, team, as_of }. */
export function compute(facts, now = Date.now()) {
  const byTicket = new Map();
  for (const r of facts.runs) if (r.ticket_key) (byTicket.get(r.ticket_key) || byTicket.set(r.ticket_key, []).get(r.ticket_key)).push(r);
  const merged = new Map((facts.merged || []).map((m) => [m.ticket_key, m.ts]));
  const firstQa = new Map((facts.qa || []).map((q) => [q.ticket_key, /^QA passed/.test(q.text)]));
  const seats = {};
  const seat = (id) => (seats[id] ||= { all: blank(), S: blank(), 'M+': blank(), builds_14d: 0, busy_ms_7d: 0 });
  for (const r of facts.runs) {
    if (!r.ended_at && r.status !== 'running') continue; // an orphaned row is not a busy seat
    const start = Date.parse(r.started_at), end = r.ended_at ? Date.parse(r.ended_at) : now;
    if (Number.isFinite(start) && end > now - 7 * DAY) seat(r.agent_id).busy_ms_7d += Math.max(0, end - Math.max(start, now - 7 * DAY));
  }
  for (const t of facts.tickets) {
    if (t.owner_task) continue; // an epic has no implement runs of its own, so it never counts; a built parent does
    const runs = (byTicket.get(t.key) || []).filter((r) => r.kind === 'implement').sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    if (!runs.length) continue;
    const author = t.builder || runs[0].agent_id;
    const s = seat(author);
    if (Date.parse(runs[0].started_at) > now - 14 * DAY) s.builds_14d++;
    for (const c of [s.all, s[cohortOf(t)]]) {
      c.built++;
      if (firstQa.has(t.key)) { c.qa_first++; if (firstQa.get(t.key)) c.qa_first_pass++; }
      const at = merged.get(t.key);
      if (!at) continue;
      c.shipped++;
      const mine = (byTicket.get(t.key) || []).filter((r) => r.agent_id === author && BUILD.has(r.kind));
      if (mine.some((r) => r.cost_estimated)) c.estimated_runs += mine.filter((r) => r.cost_estimated).length;
      else c.cost.push(mine.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0));
      c.review_rounds += mine.filter((r) => r.kind === 'respond').length;
      const minutes = (Date.parse(at) - Date.parse(runs[0].started_at)) / 60000;
      if (minutes > 0) c.cycle.push(minutes);
    }
  }
  const view = (c) => ({ built: c.built, qa_first: c.qa_first, qa_first_pass: c.qa_first_pass, first_pass_rate: c.qa_first ? c.qa_first_pass / c.qa_first : null,
    shipped: c.shipped, cost_per_shipped: c.cost.length ? c.cost.reduce((a, b) => a + b, 0) / c.cost.length : null, cost_n: c.cost.length, estimated_runs: c.estimated_runs,
    review_rounds: c.shipped ? c.review_rounds / c.shipped : null, cycle_min: median(c.cycle), few: c.qa_first < 3 });
  const out = {};
  for (const [id, s] of Object.entries(seats)) out[id] = { all: view(s.all), S: view(s.S), 'M+': view(s['M+']), builds_14d: s.builds_14d, busy_hours_7d: s.busy_ms_7d / 3600_000 };
  const team = {};
  for (const k of ['S', 'M+']) {
    const costs = Object.values(out).filter((s) => s[k].cost_n >= 3).map((s) => s[k].cost_per_shipped);
    const first = Object.values(out).reduce((a, s) => a + s[k].qa_first, 0), pass = Object.values(out).reduce((a, s) => a + s[k].qa_first_pass, 0);
    team[k] = { median_cost_per_shipped: median(costs), first_pass_rate: first ? pass / first : null, qa_first: first };
  }
  return { seats: out, team, as_of: new Date(now).toISOString(), window_days: 90 };
}

let cache = null;
/** Cached for five minutes; a QA verdict or a merge on GitHub invalidates it. */
export function current(now = Date.now()) {
  if (cache && now - cache.ms < 5 * 60_000) return cache.value;
  cache = { ms: now, value: compute(store.assignmentFacts(new Date(now - 90 * DAY).toISOString()), now) };
  return cache.value;
}
export const invalidate = () => { cache = null; };
