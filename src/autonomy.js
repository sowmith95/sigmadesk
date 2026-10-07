// Server side of the autonomy matrix (sowmith95/sigmadesk#6): reads the SAME config and settings the gates read at
// execution time and hands them to the pure model (src/autonomy-model.js). Read-only: the only writes the UI offers go
// through owner write paths that already exist (POST /api/settings for ops_enabled and open_draft_prs, POST
// /api/access/policy for tagged-reply access), each re-read by its gate when it acts and logged as a desk event.
import { config } from './config.js';
import * as store from './db.js';
import * as access from './access.js';
import * as mergetrain from './mergetrain.js';
import * as reviews from './reviews.js';
import * as prs from './prs.js';
import * as ops from './ops.js';
import { agentById, BUILDERS } from './team.js';
import * as model from './autonomy-model.js';
import { policyVersion } from './decision.js';
// Circular on purpose: only used at call time.
import { inBusyWindow, budgetHeadroom } from './scheduler.js';

const on = (id) => !!agentById[id] && agentById[id].enabled !== false;
const name = (id) => String(agentById[id]?.name || id).split(/\s+/)[0];

/** How many databases and containers the read-only probes can reach (null = could not tell). */
function probeTargets(settings) { try { const d = ops.describe(settings); return (d.databases || []).length + (d.containers || []).length; } catch { return null; } }

export function matrix(settings = store.getSettings()) {
  const busy = inBusyWindow();
  const grants = access.summary().grants;
  let budgetLeft = null; try { budgetLeft = budgetHeadroom(settings); } catch { budgetLeft = null; }
  return model.matrix({
    settings, seats: { manager: on('manager'), sre: on('sre'), builders: BUILDERS.filter(on).length },
    autoMerge: config.review?.autoMerge || {}, mergeTrain: config.mergeTrain?.enabled !== false, reviewsRequired: Number(config.review?.required ?? 2),
    requiredChecks: { names: prs.requiredChecks().names, unknownBlocks: !prs.requiredChecks().names.length && store.kvGet('ci:asked') === '1' },
    busyWindow: config.limits?.busyWindow || {}, busyNow: busy, windowEnd: busy ? mergetrain.fmtTime(mergetrain.windowEnd()) : null, deployLock: mergetrain.deployState(),
    ops: { configured: config.ops?.enabled === true, on: settings.ops_enabled === 'true', verify: (config.ops?.kinds || []).includes('verify'), targets: probeTargets(settings) },
    policy: access.policy(), grants: grants.filter((g) => g.granted_by !== 'owner'), ownerGrants: grants.filter((g) => g.granted_by === 'owner'), budgetLeft,
    names: { manager: name('manager'), sre: name('sre') }, policyVersion: policyVersion(settings),
  });
}

/** One ticket's summary (build · merge by risk class · production read) for its header and Details. */
export function forTicket(t, m = matrix()) {
  const seats = new Set([t.assignee, ...store.participantsOf(t.key).map((p) => p.seat_id)].filter(Boolean));
  const runs = new Set(store.handle().prepare('SELECT id FROM runs WHERE ticket_key=?').all(t.key).map((r) => r.id));
  const grants = access.summary().grants.filter((g) => g.ticket_key === t.key || (g.run_id && runs.has(g.run_id)) || (!g.ticket_key && !g.run_id && seats.has(g.seat)));
  return { ...model.forTicket({ ticket: t, matrix: m, policy: reviews.autoMergePolicy(t), grants, nameOf: name }), policy_version: m.policy_version };
}
