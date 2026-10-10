// Delegation (sowmith95/sigmadesk#9): which owner decisions the Engineering Manager (Morgan) or the SRE (Devon) may
// decide FOR the owner, and the deterministic rules that send a decision back to the owner before any model runs. Pure:
// src/delegation.js gathers the facts, owns the records and applies decisions; this file only says what is allowed.
//
// Per decision kind a mode: owner (the owner decides; nothing runs) · shadow (the delegate decides, the decision is
// recorded and shown to the owner, and the owner still decides) · em / sre (that seat decides for the owner; the owner
// can override or reopen). Everything not listed here (merges, publish guards, reverts, hold releases, standing or
// renewal grants, packages, budget, policy and this matrix itself) is the owner's in v1 and has no mode at all.
import crypto from 'node:crypto';

export const MODES = ['owner', 'shadow', 'em', 'sre'];
export const SEAT_OF = { em: 'manager', sre: 'sre' };
export const MODE_LABEL = { owner: 'You decide', shadow: 'Shadow', em: 'Morgan decides', sre: 'Devon decides' };

/**
 * The delegable kinds, in the order v1 enables them. delegates: the modes besides owner/shadow a kind may take.
 * actions: what a delegate may do (escalate is always allowed). deterministic: decided by rule, with no model call.
 */
export const KINDS = {
  owner_task: { label: 'Owner tasks', scope: 'Steps filed as yours: a read-only production check goes to the SRE, a missing package becomes a package request, everything else stays yours',
    delegates: ['em'], actions: ['route'], deterministic: true },
  question: { label: "Engineers' questions", scope: 'Factual engineering questions on low-risk tickets; money, credentials, product preference, trading semantics, schema effects and anything risky stay yours',
    delegates: ['em'], actions: ['answer'] },
  research: { label: 'Research-review holds', scope: 'Coordinating corrections or rescoping of a held proposal; approving past a dissenting reviewer stays yours',
    delegates: ['em'], actions: ['changes'] },
  loop_limit: { label: 'QA and review loop limits', scope: 'Rescoping or reassigning work that failed QA, CI or review repeatedly; clearing a failure stays yours',
    delegates: ['em'], actions: ['changes'] },
  design: { label: 'Design and plan reviews', scope: 'Design recommendations and council verdicts on positively low-risk tickets, never by the seat that wrote them',
    delegates: ['em', 'sre'], actions: ['approve', 'changes', 'reject'] },
};
export const KIND_IDS = Object.keys(KINDS);
/** The seat that decides in shadow mode (the kind's first delegate). */
export const shadowSeat = (kind) => SEAT_OF[KINDS[kind]?.delegates?.[0]] || null;

// Structured hold kinds (tickets.hold_kind) each delegable kind covers. Anything else is never delegated.
export const LOOP_HOLDS = ['qa_loops', 'review_loops', 'ci_loops', 'github_loops', 'review_disagree'];
export const OWNER_ROUTES = { check: 'a read-only production check', package: 'a Python package the work needs' };
const OWNER_KEEP = {
  write: 'a production write is yours', restart: 'a restart is yours', credential: 'credentials are yours', business: 'a business decision is yours',
  other: 'the step is not a production check or a package', probe: "the SRE's read-only probes could not answer it", owner: 'you took this task yourself',
};

const err = (msg) => Object.assign(new Error(msg), { status: 400 });
const bool = (v, name) => { if (typeof v !== 'boolean') throw err(`${name} must be true or false`); return v; };

/** The config block with every value in range (sigmadesk.config.json → delegation, after the env overrides). */
export function settingsFrom(cfg = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const kinds = Object.fromEntries(KIND_IDS.map((k) => [k, validMode(k, cfg.kinds?.[k]) ? cfg.kinds[k] : 'shadow']));
  return {
    enabled: cfg.enabled !== false, kinds, peerAccess: cfg.peerAccess === true,
    budgetUsd: num(cfg.budgetUsd, 0.75, 0.05, 20), maxMinutes: num(cfg.maxMinutes, 6, 0.01, 60), maxSteps: num(cfg.maxSteps, 30, 3, 200),
    maxActions: num(cfg.maxActions, 12, 2, 60), maxWaitMinutes: num(cfg.maxWaitMinutes, 30, 1, 1440), maxPerDay: num(cfg.maxPerDay, 40, 0, 1000),
    research: { maxCorrections: num(cfg.research?.maxCorrections, 1, 0, 5), maxSpendUsd: num(cfg.research?.maxSpendUsd, 1.5, 0, 50) },
    loopLimit: { maxRescopes: num(cfg.loopLimit?.maxRescopes, 1, 0, 5) },
  };
}
export const validMode = (kind, mode) => mode === 'owner' || mode === 'shadow' || (KINDS[kind]?.delegates || []).includes(mode);

/** Validate the owner's matrix as a whole (Settings → Autonomy). → { kinds, peerAccess } or throws. */
export function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw err('policy must be an object');
  const kinds = p.kinds;
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) throw err('kinds must map each decision kind to a mode');
  for (const k of Object.keys(kinds)) if (!KINDS[k]) throw err(`unknown decision kind "${String(k).slice(0, 40)}" (${KIND_IDS.join(', ')})`);
  const out = {};
  for (const k of KIND_IDS) {
    const m = kinds[k] ?? 'shadow';
    if (!validMode(k, m)) throw err(`${KINDS[k].label}: mode must be one of owner, shadow${KINDS[k].delegates.map((d) => `, ${d}`).join('')}`);
    out[k] = m;
  }
  return { kinds: out, peerAccess: bool(p.peerAccess ?? false, 'peerAccess') };
}

/**
 * What applies now: the config (defaults ← file ← env) with the owner's saved matrix on top. The config's
 * enabled:false and the owner's "Escalate everything" both make every kind the owner's, whatever is saved.
 * → { enabled, escalateAll, kinds: {kind: mode}, configured: {kind: mode}, peerAccess, source }
 */
export function effective({ cfg = settingsFrom(), saved = null, escalateAll = false } = {}) {
  const s = saved && typeof saved === 'object' ? saved : null;
  const configured = Object.fromEntries(KIND_IDS.map((k) => [k, s?.kinds && validMode(k, s.kinds[k]) ? s.kinds[k] : cfg.kinds[k]]));
  const locked = !cfg.enabled || escalateAll;
  return { enabled: cfg.enabled, escalateAll: !!escalateAll, configured, kinds: locked ? Object.fromEntries(KIND_IDS.map((k) => [k, 'owner'])) : configured,
    peerAccess: !locked && (s && typeof s.peerAccess === 'boolean' ? s.peerAccess : cfg.peerAccess), source: s ? 'saved' : 'config' };
}
/** The policy from the desk's settings rows and the config block (shared by src/delegation.js and src/access.js). */
export function fromSettings(settings = {}, cfg = {}) {
  let saved = null;
  try { saved = settings.delegation ? JSON.parse(settings.delegation) : null; } catch { saved = null; }
  return effective({ cfg: settingsFrom(cfg), saved, escalateAll: settings.delegation_escalate_all === 'true' });
}
/** A short fingerprint of the matrix in force (stored with every delegated decision; any change invalidates in-flight ones). */
export const versionOf = (pol, epoch = 0) => crypto.createHash('sha256').update(JSON.stringify([pol.kinds, pol.peerAccess, pol.escalateAll, pol.enabled, Number(epoch) || 0])).digest('hex').slice(0, 10);

/** Who decides a kind under a mode: em → the manager, sre → the SRE, shadow → the kind's first delegate, owner → nobody. */
export function delegateFor(kind, mode) {
  if (mode === 'shadow') return shadowSeat(kind);
  return KINDS[kind] && KINDS[kind].delegates.includes(mode) ? SEAT_OF[mode] : null;
}
/** The actions a delegate may take on this decision (escalate is always one of them). */
export const allowedActions = (kind) => [...(KINDS[kind]?.actions || []), 'escalate'];

/** Positively low risk: the stored risk says low and the diff classifier does not say high. Unknown counts as high. */
export const positivelyLow = (t) => !!t && t.risk === 'low' && t.diff_risk !== 'high';

/**
 * The deterministic rules, checked before any model call and again when a decision is applied. facts:
 *   { kind, delegate, ticket, interest: why the delegate is a party (src/delegation.js interestedSeats) or null,
 *     lifetime: { count, spend }, limits: settingsFrom(), designStatus, stale, verifyReady, packagesEnabled, ownerTaskKind }
 * → null (the delegate may decide) or a plain-language reason it is the owner's.
 */
export function ownerReason(f, nameOf = (s) => s) {
  const t = f.ticket || null;
  const who = nameOf(f.delegate);
  if (!f.delegate) return 'no delegate is set for this kind';
  if (f.delegateOff) return `${who}'s seat is switched off`;
  if (t && ['done', 'wontdo'].includes(t.status)) return 'the ticket is closed';
  // Never decide one's own matter: one's own question, request, work, review, proposal or plan.
  if (f.interest) return `${who} ${f.interest}, so ${who} cannot decide it for you`;
  switch (f.kind) {
    case 'owner_task': {
      const k = f.ownerTaskKind;
      if (!k) return 'nobody said what kind of step it is, so it stays yours';
      if (OWNER_KEEP[k]) return OWNER_KEEP[k];
      if (k === 'check' && !f.verifyReady) return 'it is a read-only production check, but nobody on the team can read production right now';
      if (k === 'package' && !f.packagesEnabled) return 'it needs a package, but package requests are switched off';
      if (!OWNER_ROUTES[k]) return 'the step is not one the team can take over';
      return null;
    }
    case 'question':
      if (!positivelyLow(t)) return t?.risk === 'high' || t?.diff_risk === 'high' ? 'the ticket is high risk (trading, money or deploy paths)' : 'the ticket has no low-risk classification, so it counts as high risk';
      return null;
    case 'research':
      if (f.lifetime && f.lifetime.count >= f.limits.research.maxCorrections) return `${who} already sent this proposal back ${f.lifetime.count} time${f.lifetime.count === 1 ? '' : 's'} (limit ${f.limits.research.maxCorrections} for its whole life)`;
      if (f.lifetime && f.lifetime.spend >= f.limits.research.maxSpendUsd) return `delegated decisions on this proposal already cost $${f.lifetime.spend.toFixed(2)} (limit $${f.limits.research.maxSpendUsd.toFixed(2)})`;
      return null;
    case 'loop_limit':
      if (f.lifetime && f.lifetime.count >= f.limits.loopLimit.maxRescopes) return `${who} already rescoped this ticket ${f.lifetime.count} time${f.lifetime.count === 1 ? '' : 's'} (limit ${f.limits.loopLimit.maxRescopes})`;
      return null;
    case 'design':
      if (f.designStatus && f.designStatus !== 'complete') return f.designStatus === 'partial' ? 'the council is incomplete (a reviewer failed)' : `the recommendation is ${f.designStatus}`;
      if (f.stale) return 'the recommendation is stale: the ticket changed after it was written';
      if (!positivelyLow(t)) return 'only positively low-risk work may be approved for you (backend changes can alter trading without any UI change)';
      return null;
    default: return 'this kind of decision is not delegable';
  }
}

/** The plain-language line for a delegated decision ("Morgan answered Riley: …"). */
export function lineFor(rec, nameOf = (s) => s) {
  const who = nameOf(rec.seat), asker = rec.asker ? nameOf(rec.asker) : null;
  const text = String(rec.text || '').replace(/\s+/g, ' ').trim();
  const clip = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (rec.action === 'escalate') return `${who} left this for you: ${rec.why || 'no reason given'}`;
  if (rec.action === 'answer') return `${who} answered ${asker || 'the engineer'}: ${clip}`;
  if (rec.action === 'route') return `${who} ${clip || 'routed it to the team'}`;
  if (rec.kind === 'research') return `${who} sent the proposal back for corrections: ${clip}`;
  if (rec.kind === 'loop_limit') return `${who} gave the team new direction: ${clip}`;
  if (rec.kind === 'design') return `${who} ${rec.action === 'approve' ? 'approved the design' : rec.action === 'reject' ? 'rejected the design' : 'asked for design corrections'}${clip ? `: ${clip}` : ''}`;
  return `${who} decided: ${clip}`;
}

/**
 * "Owner interventions avoided" and spend, per kind, over a window: every decision counts once (records are unique per
 * decision and evidence version). avoided = applied and neither overridden nor reopened; shadow = what the delegate
 * would have decided (the owner still decided). records: [{ kind, status, mode, created_at, spent_usd, estimated }].
 */
export function metrics(records = [], { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86400_000;
  const blank = () => ({ applied: 0, avoided: 0, overridden: 0, reopened: 0, escalated: 0, shadow: 0, spend_usd: 0, runs: 0, estimated_runs: 0 });
  const per = Object.fromEntries(KIND_IDS.map((k) => [k, blank()]));
  for (const r of records) {
    if (!per[r.kind] || !(Date.parse(r.created_at) >= since)) continue;
    const m = per[r.kind];
    if (['applied', 'overridden', 'reopened'].includes(r.status)) m.applied++;
    if (r.status === 'applied') m.avoided++;
    if (r.status === 'overridden') m.overridden++;
    if (r.status === 'reopened') m.reopened++;
    if (r.status === 'escalated') m.escalated++;
    if (r.status === 'shadow') m.shadow++;
    m.spend_usd += Number(r.spent_usd) || 0;
    m.runs += Number(r.runs) || 0;
    m.estimated_runs += Number(r.estimated_runs) || 0;
  }
  const total = Object.values(per).reduce((a, m) => { for (const k of Object.keys(a)) a[k] += m[k]; return a; }, blank());
  for (const m of [...Object.values(per), total]) m.spend_usd = Math.round(m.spend_usd * 100) / 100;
  const money = (n) => `$${n.toFixed(2)}`;
  return { window_days: days, since: new Date(since).toISOString(), kinds: per, total,
    spend_text: `Delegated decisions in the last ${days} days: ${money(total.spend_usd)} across ${total.runs} run${total.runs === 1 ? '' : 's'}${total.estimated_runs ? ` (${total.estimated_runs} without a cost report, charged at their cap)` : ''}.`,
    avoided_text: `${total.avoided} owner intervention${total.avoided === 1 ? '' : 's'} avoided (${total.overridden + total.reopened} overridden or reopened, ${total.escalated} escalated to you, ${total.shadow} in shadow).` };
}
