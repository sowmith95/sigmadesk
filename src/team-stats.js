// Team stats: how each seat does on the work it builds. Feeds balanced assignment (src/assign.js), the Team page and
// the seat sheet, so every surface means the same thing by "first-try QA" and "shipped".
// - author: the ticket's recorded builder, else the seat of its first implement run
// - first-try QA: the first QA verdict on the ticket (qa_verdicts), abandoned tickets included. A failure QA put down
//   to unclear requirements, a broken base branch or a flaky test (spec/base/flaky) is shown but does not count
//   against the builder; bug, tests and unknown (history) do.
// - report card: Wilson 80% interval per seat and size group, and a band against the REST of the team (an interval
//   for the difference): "too early" under MIN_N verdicts, "above"/"below" only when the difference interval
//   excludes zero, otherwise "inconclusive". Never "in line": overlapping intervals prove nothing.
// - shipped: a merge event; owner tasks and epics are not counted
// - cycle time: first implement start → merge; cost: measured run cost only (estimated runs counted separately)
// Everything is grouped by size (S vs M and larger) so a junior's small tasks are not compared with a senior's medium
// ones, and every number carries its denominator.
import * as store from './db.js';

const BUILD = new Set(['implement', 'respond', 'resolve']);
const DAY = 86400_000;
export const cohortOf = (t) => (t?.complexity === 'S' ? 'S' : 'M+');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const blank = () => ({ built: 0, qa_first: 0, qa_first_pass: 0, excluded: {}, shipped: 0, cost: [], estimated_runs: 0, review_rounds: 0, cycle: [], models: {} });
export const EXCLUDED_REASONS = new Set(['spec', 'base', 'flaky']);
export const MIN_N = 15;
const Z80 = 1.2816;
/** Wilson score interval for k successes in n (80% by default). */
export function wilson(k, n, z = Z80) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
/** Newcombe's interval for p1 - p2 from the two Wilson intervals. */
export function diffInterval(k1, n1, k2, n2, z = Z80) {
  const a = wilson(k1, n1, z), b = wilson(k2, n2, z);
  if (!a || !b) return null;
  const p1 = k1 / n1, p2 = k2 / n2;
  return [p1 - p2 - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2), p1 - p2 + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2)];
}
export function band(k, n, restK, restN) {
  if (n < MIN_N) return 'too_early';
  if (!restN) return 'no_comparison'; // nobody else did this size of work
  const d = diffInterval(k, n, restK, restN);
  if (!d) return 'inconclusive';
  return d[0] > 0 ? 'above' : d[1] < 0 ? 'below' : 'inconclusive';
}

/** Pure: facts (store.assignmentFacts) → { seats: { id: { all, S, 'M+', builds_14d, busy_hours_7d } }, team, as_of }. */
export function compute(facts, now = Date.now()) {
  const byTicket = new Map();
  for (const r of facts.runs) if (r.ticket_key) (byTicket.get(r.ticket_key) || byTicket.set(r.ticket_key, []).get(r.ticket_key)).push(r);
  const merged = new Map((facts.merged || []).map((m) => [m.ticket_key, m.ts]));
  // First verdict per ticket: { pass: true|false|null (excluded), reason, builder, model }. Old fact shape: { text }.
  const firstQa = new Map((facts.qa || []).map((q) => {
    const verdict = q.verdict || (/^QA passed/.test(q.text || '') ? 'pass' : 'fail');
    const pass = verdict === 'pass' ? true : EXCLUDED_REASONS.has(q.reason) ? null : false;
    return [q.ticket_key, { pass, reason: q.reason || null, builder: q.builder || null, model: q.model || null, complexity: q.complexity ?? null }];
  }));
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
    const author = t.builder || firstQa.get(t.key)?.builder || runs[0].agent_id;
    const s = seat(author);
    if (Date.parse(runs[0].started_at) > now - 14 * DAY) s.builds_14d++;
    const q = firstQa.get(t.key);
    // The verdict counts in the size the task had when it was judged (a later re-size does not move history).
    const qaCohort = q?.complexity ? cohortOf({ complexity: q.complexity }) : cohortOf(t);
    for (const c of [s.all, s[qaCohort]]) {
      if (q && q.pass === null) c.excluded[q.reason] = (c.excluded[q.reason] || 0) + 1;
      else if (q) {
        c.qa_first++; if (q.pass) c.qa_first_pass++;
        const m = (c.models[q.model || runs[0].model || 'unknown'] ||= { qa_first: 0, qa_first_pass: 0 });
        m.qa_first++; if (q.pass) m.qa_first_pass++;
      }
    }
    for (const c of [s.all, s[cohortOf(t)]]) {
      c.built++;
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
    interval: wilson(c.qa_first_pass, c.qa_first), excluded: c.excluded, models: c.models,
    shipped: c.shipped, cost_per_shipped: c.cost.length ? c.cost.reduce((a, b) => a + b, 0) / c.cost.length : null, cost_n: c.cost.length, estimated_runs: c.estimated_runs,
    review_rounds: c.shipped ? c.review_rounds / c.shipped : null, cycle_min: median(c.cycle), few: c.qa_first < 3 });
  const out = {};
  for (const [id, s] of Object.entries(seats)) out[id] = { all: view(s.all), S: view(s.S), 'M+': view(s['M+']), builds_14d: s.builds_14d, busy_hours_7d: s.busy_ms_7d / 3600_000 };
  // Each seat against the rest of the team in the same size group.
  for (const k of ['S', 'M+', 'all']) {
    const totK = Object.values(out).reduce((a, s) => a + s[k].qa_first_pass, 0), totN = Object.values(out).reduce((a, s) => a + s[k].qa_first, 0);
    for (const s of Object.values(out)) {
      const restK = totK - s[k].qa_first_pass, restN = totN - s[k].qa_first;
      s[k].rest_rate = restN ? restK / restN : null;
      s[k].band = s[k].qa_first ? band(s[k].qa_first_pass, s[k].qa_first, restK, restN) : null;
    }
  }
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
