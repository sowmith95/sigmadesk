// Balanced assignment: which builder takes a todo build job. Pure (no store access): the scheduler passes the ticket,
// the launchable seats, team stats (src/team-stats.js) and a few facts, and gets back seats in the order to try plus
// a reason a person can read. Precedence: a pin, then the author keeps rework, then the best-scored launchable seat.
// Fit is the prior (rank 1.0 / 0.9 / 0.8); a lower-ranked seat wins only with a materially better record in the same
// size group, or when the preferred seat's engine is near its limit. Factors are bounded so no single number decides.
import crypto from 'node:crypto';
import { cohortOf } from './team-stats.js';

const RANK = [1, 0.9, 0.8, 0.75];
// First-try QA prior: the team's own rate on this size of work (80% before there is any), with the weight of five
// tasks. A seat without a record counts as average, never better than seats that have one.
export const PRIOR = { rate: 0.8, weight: 5 };
export const EXPLORE_SHARE = 0.1;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Shrunk first-try QA rate in the cohort, as a factor around 1 (0.85–1.15). */
export function qualityFactor(c, teamRate) {
  const base = teamRate > 0 ? teamRate : PRIOR.rate;
  const rate = ((c?.qa_first_pass || 0) + base * PRIOR.weight) / ((c?.qa_first || 0) + PRIOR.weight);
  return clamp(rate / base, 0.85, 1.15);
}
/** Team median cost ÷ seat cost in the cohort (0.9–1.1); neutral until the seat has three measured shipped tasks. */
export function costFactor(c, teamMedian) {
  if (!c || c.cost_n < 3 || !(c.cost_per_shipped > 0) || !(teamMedian > 0)) return 1;
  return clamp(teamMedian / c.cost_per_shipped, 0.9, 1.1);
}
/** An engine close to its limit is used less: above 70% of its window 0.85, above 85% 0.6. */
export const quotaFactor = (used) => (used > 0.85 ? 0.6 : used > 0.7 ? 0.85 : 1);
const unit = (seed) => parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;
/** Exploration is decided once per ticket (its key), only for fresh, unpinned, small or explicitly low-risk work. */
export const explores = (t) => !t.assign_pinned && t.risk !== 'high' && (t.complexity === 'S' || t.risk === 'low') && unit(`explore:${t.key}`) < EXPLORE_SHARE;

/**
 * ctx: { candidates: [fit order], launchable: Set, stats: team-stats seats, team: team-stats team, quota: {seat: 0..1},
 *        siblings: Set (seats that built other tasks of the same epic), author, names: {seat: name}, recent: {seat: builds} }
 * → { order: [seats to try], reason, scores } ; order is empty when the task must wait (reason says for whom).
 */
export function pick(t, ctx) {
  const name = (id) => ctx.names?.[id] || id;
  const { candidates = [], launchable = new Set() } = ctx;
  if (t.assign_pinned && t.assignee) {
    return launchable.has(t.assignee) ? { order: [t.assignee], reason: `${name(t.assignee)}: assigned to this task` } : { order: [], reason: `Waiting for ${name(t.assignee)} (assigned to this task)` };
  }
  if (ctx.author) {
    return launchable.has(ctx.author) ? { order: [ctx.author], reason: `${name(ctx.author)}: their own work coming back` } : { order: [], reason: `Waiting for ${name(ctx.author)}, who built it` };
  }
  if (!candidates.length) return { order: [], reason: 'No enabled seat can build this task' };
  const free = candidates.filter((id) => launchable.has(id));
  if (!free.length) return { order: [], reason: `Waiting for ${candidates.map(name).join(' or ')}` };
  const cohort = cohortOf(t);
  const scores = free.map((id) => {
    const c = ctx.stats?.[id]?.[cohort];
    const parts = { fit: RANK[Math.min(candidates.indexOf(id), RANK.length - 1)], quality: qualityFactor(c, ctx.team?.[cohort]?.first_pass_rate), cost: costFactor(c, ctx.team?.[cohort]?.median_cost_per_shipped),
      quota: quotaFactor(ctx.quota?.[id] || 0), continuity: ctx.siblings?.has(id) ? 1.05 : 1 };
    return { id, score: Object.values(parts).reduce((a, b) => a * b, 1), parts };
  }).sort((a, b) => b.score - a.score || candidates.indexOf(a.id) - candidates.indexOf(b.id) || a.id.localeCompare(b.id));
  let order = scores.map((s) => s.id);
  if (free.length > 1 && explores(t)) {
    const least = [...free].sort((a, b) => (ctx.recent?.[a] || 0) - (ctx.recent?.[b] || 0) || candidates.indexOf(a) - candidates.indexOf(b))[0];
    if (least !== order[0]) return { order: [least, ...order.filter((id) => id !== least)], scores, explored: true, reason: `${name(least)}: rotated in to keep their record current (fits this task, fewer recent tasks)` };
  }
  const best = scores[0], c = ctx.stats?.[best.id]?.[cohort];
  const lead = candidates[0] === best.id ? 'best fit' : !launchable.has(candidates[0]) ? `${name(candidates[0])} busy` : `scored above ${name(candidates[0])}`;
  const why = [lead, c?.qa_first ? `${c.qa_first_pass}/${c.qa_first} first-try QA on ${cohort === 'S' ? 'small' : 'medium'} tasks` : 'no record on this size yet',
    best.parts.quota < 1 && 'its engine is near its limit', best.parts.continuity > 1 && 'built part of this epic'].filter(Boolean);
  return { order, scores, reason: `${name(best.id)}: ${why.join(', ')}` };
}
