// Server side of the decision snapshot (sowmith95/sigmadesk#6): gathers the facts each owner decision depends on and
// hands them to the pure model (src/decision-model.js). One snapshot serves the Inbox (embedded in /api/state as
// meta.decision_briefs, keyed by decision id) and the ticket (GET /api/tickets/KEY/decision-brief).
//
// Facts that need GitHub or git (which workflows a merge starts, CI) are read in the background and kept with the commit
// they describe; the snapshot shows "not checked yet" / "stale" until they match the ticket's current commit. Nothing
// here gates anything: execution-time checks stay authoritative.
import crypto from 'node:crypto';
import { config } from './config.js';
import * as store from './db.js';
import * as mergetrain from './mergetrain.js';
import * as reviews from './reviews.js';
import * as prs from './prs.js';
import * as access from './access.js';
import * as ops from './ops.js';
import * as github from './github.js';
import { agentById } from './team.js';
import * as flow from '../public/flow.js';
import { nameOf as ticketName } from '../public/names.js';
import * as model from './decision-model.js';
// Circular on purpose: only used at call time.
import { inBusyWindow, verifyReady } from './scheduler.js';

const json = (k, d = null) => { try { return JSON.parse(store.kvGet(k) || 'null') ?? d; } catch { return d; } };
const seatName = (id) => agentById[id]?.name || id;
const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
const DEPLOY_KEY = (k) => `decision:deploy:${k}`, CI_KEY = (k) => `decision:ci:${k}`;
const RECHECK_MS = 10 * 60_000;

/** A short fingerprint of everything that decides who may act (shown with every snapshot; changes when policy does). */
export function policyVersion(settings = store.getSettings()) {
  const parts = [config.review?.autoMerge, config.mergeTrain?.enabled, config.limits?.busyWindow, config.deploy?.workflows, config.deploy?.targets || {},
    config.project?.protectedPaths, config.review?.riskPaths, prs.requiredChecks(), access.policy(), settings.ops_enabled, settings.open_draft_prs, settings.github_sync, config.ops?.enabled];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 10);
}

// ---------------- background facts: deploy classification and CI, each pinned to a commit ----------------
const inflight = new Set();
/** Which workflows merging this ticket starts, for its current commit and base (cached; recomputed when either moves). */
export async function refreshDeploy(t, { force = false } = {}) {
  if (!t?.head_sha || inflight.has(t.key)) return json(DEPLOY_KEY(t.key));
  const baseSha = store.kvGet('train:base') || null;
  const prev = json(DEPLOY_KEY(t.key));
  if (!force && prev && prev.head === t.head_sha && (prev.base || null) === baseSha && (prev.state !== 'unknown' || Date.now() - Date.parse(prev.at) < RECHECK_MS)) return prev;
  inflight.add(t.key);
  try {
    const info = await mergetrain.deployInfo(t).catch((err) => ({ deploys: true, workflows: [], reason: `the check failed: ${String(err.message).slice(0, 80)}` }));
    const files = json(`diff-files:${t.key}`);
    const state = !info.deploys ? 'none' : info.workflows?.length ? 'deploys' : 'unknown';
    const rec = { head: t.head_sha, base: baseSha, state, workflows: info.workflows || [], reason: info.reason || null, files: Array.isArray(files) ? files.slice(0, 500) : null, at: store.now() };
    store.kvSet(DEPLOY_KEY(t.key), JSON.stringify(rec));
    store.bus.emit('msg', { type: 'inbox', data: null }); // open Inboxes re-read the snapshot
    return rec;
  } finally { inflight.delete(t.key); }
}
/** Record CI as GitHub reported it (from the PR list the owner's UI already loads). */
export function recordCi(rows = [], at = store.now()) {
  for (const r of rows) {
    if (!r?.key || !r.head_sha) continue;
    const prev = json(CI_KEY(r.key));
    if (prev && prev.sha === r.head_sha && prev.checks === r.checks && prev.mergeable === r.mergeable && Date.now() - Date.parse(prev.at) < 60_000) continue;
    store.kvSet(CI_KEY(r.key), JSON.stringify({ sha: r.head_sha, checks: r.checks, mergeable: r.mergeable || null, at }));
  }
}

// ---------------- facts for one decision ----------------
function qaAt(key, sha) {
  if (!sha) return null;
  const row = store.handle().prepare("SELECT ended_at FROM runs WHERE ticket_key=? AND kind='qa' AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(key);
  return row?.ended_at || null;
}
function releasesOf(d, tickets, ix) {
  if (!d.ticket) return [];
  const seen = new Map();
  for (const w of flow.waitingOn(d.ticket.key, tickets, ix)) seen.set(w.key, { key: w.key, name: ticketName(w), status: w.status });
  for (const w of d.waiting || []) if (!seen.has(w.key)) seen.set(w.key, { key: w.key, name: w.name, status: null });
  // Ordered work in another tree ("starts after X merges") waits on it too.
  for (const w of tickets) if (w.after_key === d.ticket.key && !['done', 'wontdo'].includes(w.status) && !seen.has(w.key)) seen.set(w.key, { key: w.key, name: ticketName(w), status: w.status });
  seen.delete(d.ticket.key);
  return [...seen.values()];
}

/** The brief for one board decision. snap: the /api/state snapshot (tickets, settings, meta). */
export function briefFor(d, snap, { ix = flow.index(snap.tickets), now = Date.now(), policy = policyVersion(snap.settings) } = {}) {
  const t = d.ticket ? store.getTicket(d.ticket.key) || d.ticket : null;
  const facts = { decision: d, ticket: t, base: config.project.baseBranch, now, nameOf: seatName, settings: snap.settings || {}, policyVersion: policy,
    since: snap.meta?.waiting_since?.[d.id] || null, releases: releasesOf(d, snap.tickets, ix), baseSha: store.kvGet('train:base') || null,
    autoMerge: config.review?.autoMerge || {}, deployWaitMinutes: config.deploy?.waitMinutes };
  if (t) { facts.qaAt = qaAt(t.key, t.qa_sha); facts.files = json(`diff-files:${t.key}`); }
  if (d.kind === 'merge' && t) {
    const ap = t.head_sha ? store.approvalsAt(t.key, t.head_sha) : { ok: false };
    facts.reviews = { inFlow: store.inReviewFlow(t.key), context: ap.context || null, independent: ap.independent || null, ok: !!ap.ok, unpublished: ap.unpublished || 0 };
    const dep = json(DEPLOY_KEY(t.key));
    facts.deploy = dep && dep.head === t.head_sha ? dep : null;
    if (!facts.deploy && t.head_sha) refreshDeploy(t).catch(() => {}); // the next snapshot has it
    const ci = json(CI_KEY(t.key));
    facts.ci = ci;
    facts.targets = config.deploy?.targets || {};
    facts.busy = inBusyWindow();
    facts.windowEnd = facts.busy ? mergetrain.fmtTime(mergetrain.windowEnd()) : null;
    facts.lock = mergetrain.deployState();
    facts.policy = reviews.autoMergePolicy(t);
    facts.pr = prNumber(t.pr_url);
  }
  if ((d.kind === 'guard' || d.kind === 'publish') && t) {
    const g = snap.meta?.guard_reasons?.[t.key];
    facts.guardReasons = g?.reasons || [];
  }
  if (d.kind === 'deploy') facts.pending = mergetrain.pendingDeploys().length;
  if (d.kind === 'access' && d.access) {
    const r = d.access;
    let v = [];
    try { v = access.violations({ seat: r.seat, probes: r.probes || ['*'], minutes: r.minutes, ticketScoped: !!r.ticket_scoped }, null); } catch { v = []; }
    facts.access = { violations: r.owner_reason ? [r.owner_reason] : v, opsOn: ops.enabled(snap.settings) };
  }
  return model.brief(facts);
}

/** Every decision on the board → its brief (meta.decision_briefs). */
export function briefs(snap, B) {
  const out = {};
  const ix = flow.index(snap.tickets);
  const policy = policyVersion(snap.settings);
  const now = Date.now();
  for (const d of B.decisions || B.needs_you || []) {
    try { out[d.id] = briefFor(d, snap, { ix, now, policy }); }
    catch (err) { out[d.id] = { id: d.id, key: d.key, kind: d.kind, error: String(err.message).slice(0, 200) }; }
  }
  return out;
}

/** GET /api/tickets/KEY/decision-brief: the decision (first, or `decisionId`), what blocks it, what remains before merge. */
export async function ticketBrief(key, snap, B, { decisionId = null } = {}) {
  const t = store.getTicket(key);
  if (!t) throw Object.assign(new Error('not found'), { status: 404 });
  const decisions = (B.decisions || []).filter((d) => d.key === key);
  const d = decisionId ? decisions.find((x) => x.id === decisionId) : decisions[0];
  if (decisionId && !d) throw Object.assign(new Error('That decision is no longer open'), { status: 409, code: 'decision_gone' });
  // Asked for directly: read the slow facts now (bounded), so this answer is as fresh as the desk can make it.
  if (t.pr_url && t.head_sha && ['ready_for_human', 'review', 'qa'].includes(t.status)) {
    await Promise.race([refreshDeploy(t), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
    if (store.getSettings().github_sync === 'true') await Promise.race([prs.listPrs().then((rows) => recordCi(rows)), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
  }
  const brief = d ? briefFor(d, snap) : null;
  const head = t.head_sha;
  const ap = head ? store.approvalsAt(key, head) : { ok: false };
  const qa = model.qaEvidence({ head, qaSha: t.qa_sha, qaAt: qaAt(key, t.qa_sha) });
  const rv = model.reviewEvidence({ head, inFlow: store.inReviewFlow(key), context: ap.context || null, independent: ap.independent || null, ok: !!ap.ok, unpublished: ap.unpublished || 0, nameOf: seatName });
  const ci = model.ciEvidence({ head, ci: t.pr_url ? json(CI_KEY(key)) : null });
  const remaining = model.beforeMerge({ ticket: t, qa, reviews: rv, ci: t.pr_url ? ci : { state: 'unknown', text: 'No PR yet.' }, policy: reviews.autoMergePolicy(t), mergeState: mergetrain.mergeState(t), nameOf: seatName });
  const item = Object.values(B).filter(Array.isArray).flat().find((x) => x.key === key && !x.kind) || null;
  const blocks = brief ? brief.gate.items.filter((g) => g.state !== 'ok') : item ? [{ id: item.bucket, label: item.bucket === 'blocked' ? 'Blocked' : item.bucket === 'working' ? 'Working' : 'Queued', state: item.bucket === 'blocked' ? 'blocked' : 'waiting', text: item.reason }] : [];
  return { key, generated_at: store.now(), policy_version: policyVersion(), decision: brief, blocks, remaining, closed: ['done', 'wontdo'].includes(t.status) };
}

// ---------------- "Verify in production" on a closed ticket: a LINKED task, never a reopen ----------------
const bad = (m, status = 409, code) => { throw Object.assign(new Error(m), { status, ...(code ? { code } : {}) }); };
/**
 * Files one verify task for the SRE, linked to the closed ticket (which keeps its state). Idempotent: while a linked
 * verify task is open, asking again returns it. Refused, with the reason, when nobody on the team can read production.
 */
export function verifyTask(key, { what = '' } = {}) {
  const t = store.getTicket(key);
  if (!t) bad('not found', 404);
  if (!['done', 'wontdo'].includes(t.status)) bad(`${key} is still open: tag ${seatName('sre')} in its conversation instead.`, 409, 'ticket_open');
  const linked = store.kvGet(`verify-of:${key}`);
  const open = linked ? store.getTicket(linked) : null;
  if (open && !['done', 'wontdo'].includes(open.status)) return { ticket: open, duplicate: true, message: `Already filed: ${open.key} (${seatName('sre')} checks ${key} in production). ${key} stays ${t.status === 'done' ? 'merged' : 'closed'}.` };
  if (!verifyReady()) bad(`Nothing was filed: nobody on the team can read production right now (production read access is off, or ${seatName('sre')} is switched off), so this check is yours. ${key} stays ${t.status === 'done' ? 'merged' : 'closed'}.`, 409, 'verify_unavailable');
  const ask = String(what || '').trim().slice(0, 1000);
  const v = store.transaction(() => {
    const again = store.kvGet(`verify-of:${key}`);
    const fresh = again ? store.getTicket(again) : null;
    if (fresh && !['done', 'wontdo'].includes(fresh.status)) return { ticket: fresh, duplicate: true };
    const n = store.createTicket({ title: `Verify in production: ${ticketName(t)}`.slice(0, 200), type: 'task', status: 'todo', area: 'infra', complexity: 'S', priority: t.priority || 'P2',
      assignee: 'sre', reporter: 'owner', source: 'human',
      description: `Check in production, with the read-only probes, that ${key} (“${t.title}”) behaves as intended now that it is ${t.status === 'done' ? 'merged' : 'closed'}.${ask ? `\n\nThe owner asks: ${ask}` : ''}\n\nReport what you observed (the probe, its result, and what it does not cover). Linked to ${key}; ${key} itself stays ${t.status === 'done' ? 'merged' : 'closed'}.` });
    store.updateTicket(n.key, { assign_pinned: 1 });
    store.kvSet(`verify:${n.key}`, '1');
    store.kvSet(`verify-of:${key}`, n.key);
    store.kvSet(`verifies:${n.key}`, key);
    store.addComment(n.key, 'system', `🔎 Routed to ${seatName('sre')} (SRE) to verify with read-only production probes. Asked by the owner from ${key}.`);
    store.addComment(key, 'system', `🔎 Filed ${n.key}: ${seatName('sre')} checks ${key} in production with read-only probes. ${key} stays ${t.status === 'done' ? 'merged' : 'closed'}; the answer lands on ${n.key}.`);
    return { ticket: store.getTicket(n.key), duplicate: false };
  });
  store.logEvent({ kind: 'system', agent_id: 'owner', ticket_key: key, text: v.duplicate ? `verify in production: ${v.ticket.key} already open` : `filed ${v.ticket.key} to verify ${key} in production` });
  github.flushComments();
  return { ...v, message: v.duplicate ? `Already filed: ${v.ticket.key}.` : `Filed ${v.ticket.key}: ${seatName('sre')} checks it in production. ${key} stays ${t.status === 'done' ? 'merged' : 'closed'}.` };
}
