// Who may use production read probes (desk ops), for how long: time-boxed, revocable GRANTS.
//
// - A grant names a seat, the probes it covers, and an end: a time (expires_at), a ticket (ends when the ticket closes),
//   or a run (ends when the run ends). Only the owner gives standing grants (no end).
// - A seat asks with `desk ops request`. The EM or the SRE (whichever is not asking) decides within the owner's policy
//   (allowed seats and probes, longest duration, active grants); never for themselves, so never self-grant or
//   self-extend. Anything beyond the policy, or with no agent approver available, is the owner's Inbox decision.
// - Validity is checked at EVERY probe call (no cached authorization). Revocation is immediate: probes in flight for
//   a seat that lost access are cancelled.
// - Every grant, denial, revocation and expiry is a desk event and, when a ticket is involved, a plain-language comment.
import { config } from './config.js';
import * as store from './db.js';
import { agentById } from './team.js';
import { notify } from './notify.js';
import * as ops from './ops.js';

const nowIso = () => new Date().toISOString();
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const nameOf = (seat) => agentById[seat]?.name || seat;
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const probeIds = () => Object.keys(ops.PROBES);

// ---------------- policy ----------------
export function policy() {
  const base = config.access?.policy || {};
  const saved = json(store.getSettings().access_policy || '', null);
  return { ...base, ...(saved && typeof saved === 'object' ? saved : {}) };
}
/** Validate a whole policy (owner edits). Returns the normalized policy or throws. */
export function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw err('policy must be an object');
  const seats = Object.keys(agentById);
  const list = (v, allowed, name) => { if (!Array.isArray(v) || !v.every((x) => allowed.includes(x))) throw err(`${name} must be a list of: ${allowed.join(', ')}`); return [...new Set(v)]; };
  const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw err(`${name} must be a whole number from ${lo} to ${hi}`); return n; };
  return {
    approvers: list(p.approvers, ['manager', 'sre'], 'approvers'),
    seats: list(p.seats, seats, 'seats'),
    probes: list(p.probes, ['*', ...probeIds()], 'probes'),
    maxMinutes: int(p.maxMinutes, 5, 1440, 'maxMinutes'),
    maxActive: int(p.maxActive, 0, 20, 'maxActive'),
    ticketMaxHours: int(p.ticketMaxHours ?? 24, 1, 72, 'ticketMaxHours'),
  };
}
export function setPolicy(p) {
  const clean = validatePolicy(p);
  store.writeSetting('access_policy', JSON.stringify(clean));
  store.logEvent({ kind: 'system', agent_id: 'owner', text: `access policy: approvers ${clean.approvers.join('/') || 'none'}, seats ${clean.seats.join(', ')}, up to ${clean.maxMinutes} min, ${clean.maxActive} active` });
  return clean;
}

// ---------------- parsing ----------------
export function parseProbes(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map(String).filter(Boolean);
  if (!arr.length || arr.includes('*') || arr.includes('all')) return ['*'];
  for (const p of arr) if (!ops.PROBES[p]) throw err(`unknown probe "${p}" (${probeIds().join(', ')})`);
  return [...new Set(arr)];
}
export function parseDuration(v) {
  if (v === undefined || v === null || v === true) return null;
  const m = String(v).trim().match(/^(\d{1,4})\s*(m|min|h)?$/);
  if (!m) throw err('--for must look like 30m or 2h');
  const mins = Number(m[1]) * (m[2] === 'h' ? 60 : 1);
  if (mins < 5 || mins > 7 * 24 * 60) throw err('--for must be between 5m and 7 days');
  return mins;
}
const covers = (probes, probe) => probes.includes('*') || probes.includes(probe);
const describeProbes = (probes) => (probes.includes('*') ? 'all read-only probes' : probes.map((p) => ops.PROBES[p]?.title || p).join(', '));
const span = (g) => (g.standing ? 'standing' : g.run_id && !g.ticket_key ? 'for this run' : g.ticket_key ? `for ${g.ticket_key}` : `until ${String(g.expires_at).slice(11, 16)} UTC`);
const forText = (minutes, ticketScoped, ticketKey) => (ticketScoped ? (ticketKey ? `for ${ticketKey}` : 'for this run') : minutes >= 60 && minutes % 60 === 0 ? `for ${minutes / 60}h` : `for ${minutes} min`);

// ---------------- validity (every probe call) ----------------
// A ticket-scoped grant is dormant until a run of that seat starts on that ticket (bindRun), then lives only while that
// run is live AND the ticket is being worked (in_progress / review); it is never usable in todo or needs_human.
export const TICKET_LIVE = ['in_progress', 'review'];
const ENDINGS = ['expired', 'ticket closed', 'ticket left work', 'run ended'];
function endReason(g, at = nowIso()) {
  if (g.revoked_at) return 'revoked';
  if (g.expires_at && g.expires_at <= at) return 'expired';
  const t = g.ticket_key ? store.getTicket(g.ticket_key) : null;
  if (g.ticket_key && (!t || ['done', 'wontdo'].includes(t.status))) return 'ticket closed';
  if (g.run_id && !store.getRun(g.run_id)?.token) return 'run ended';
  if (g.ticket_key && g.run_id && !TICKET_LIVE.includes(t.status)) return 'ticket left work';
  return null;
}
/** Bind this seat's dormant ticket grants to the run that starts work on the ticket (called at launch). */
export function bindRun(seat, ticketKey, runId) {
  if (!ticketKey) return 0;
  let n = 0;
  for (const g of store.openGrants(seat)) if (g.ticket_key === ticketKey && !g.run_id && !endReason(g)) { store.bindGrantRun(g.id, runId); n++; }
  return n;
}
function endGrant(g, by, reason) {
  if (!store.endGrant(g.id, by, reason)) return false;
  try { ops.grantEnded(g.id); } catch { /* ops not loaded yet: nothing can be running */ }
  const text = ENDINGS.includes(by)
    ? `${nameOf(g.seat)}'s production read access ended (${by})`
    : `${by === 'owner' ? 'The owner' : nameOf(by)} revoked ${nameOf(g.seat)}'s production read access${reason ? `: ${reason}` : ''}`;
  store.logEvent({ kind: 'action', agent_id: ['owner', ...ENDINGS].includes(by) ? 'system' : by, ticket_key: g.ticket_key, text });
  if (g.ticket_key && store.getTicket(g.ticket_key) && !ENDINGS.includes(by)) store.addComment(g.ticket_key, 'system', `🔒 ${esc(text)}.`);
  return true;
}
/** End every grant whose time, ticket or run is over; then stop probes that lost their authorization. */
export function sweep() {
  let ended = 0;
  for (const g of store.openGrants()) { const why = endReason(g); if (why && why !== 'revoked' && endGrant(g, why)) ended++; }
  for (const r of store.openAccessRequests()) {
    if (r.run_id && !r.ticket_key && !store.getRun(r.run_id)?.token) store.updateAccessRequest(r.id, { status: 'withdrawn', note: 'the asking run ended', decided_at: nowIso() });
    else if (r.ticket_key && ['done', 'wontdo'].includes(store.getTicket(r.ticket_key)?.status)) store.updateAccessRequest(r.id, { status: 'withdrawn', note: 'the ticket closed', decided_at: nowIso() });
  }
  ops.recheckAll();
  return ended;
}
/** The grant that lets this run use this probe right now, or null. Never cached. */
export function grantFor(run, probe, at = nowIso()) {
  for (const g of store.openGrants(run.agent_id)) {
    const why = endReason(g, at);
    if (why) { if (why !== 'revoked') { endGrant(g, why); } continue; }
    if (!covers(json(g.probes, []), probe)) continue;
    if (g.run_id && g.run_id !== run.id) continue; // run-bound: that run only
    if (g.ticket_key && (!g.run_id || g.ticket_key !== run.ticket_key)) continue; // ticket grants: only once bound, on that ticket
    return g;
  }
  return null;
}
/** Does this seat hold a grant usable for this ticket (any probe)? Used before starting a verify run. */
export function seatHasAccess(seat, ticketKey = null) {
  return store.openGrants(seat).some((g) => !endReason(g) && !g.run_id && (!g.ticket_key || g.ticket_key === ticketKey));
}
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
/** Held access now, or ended within the last hour: asking again is a renewal, and renewals are the owner's. */
function recentAccess(seat) {
  const hour = new Date(Date.now() - 3600_000).toISOString();
  return store.grantHistory(200).some((g) => g.seat === seat && (!g.revoked_at || g.revoked_at > hour));
}

// ---------------- requests ----------------
function activeAgentGrants() { return store.openGrants().filter((g) => !endReason(g) && g.granted_by !== 'owner').length; }
/** Policy violations for an agent approver giving `seat` these probes for this long. */
export function violations({ seat, probes, minutes, ticketScoped }, approver = null, pol = policy()) {
  const v = [];
  if (approver && !pol.approvers.includes(approver)) v.push(`${nameOf(approver)} is not an approver`);
  if (approver && approver === seat) v.push('nobody approves their own access');
  // Approver seats never get access from each other (no EM↔SRE reciprocity), and renewals are the owner's call.
  if (pol.approvers.includes(seat) || ['manager', 'sre'].includes(seat)) v.push(`${nameOf(seat)} approves access, so their own access is the owner's decision`);
  if (recentAccess(seat)) v.push(`${nameOf(seat)} has or just had access: a renewal is the owner's decision`);
  if (!pol.seats.includes(seat)) v.push(`${nameOf(seat)} is not a seat the policy allows`);
  if (!pol.probes.includes('*') && (probes.includes('*') || probes.some((p) => !pol.probes.includes(p)))) v.push(`probes beyond the policy (${pol.probes.join(', ')})`);
  if (!ticketScoped && !(minutes > 0)) v.push('a timed grant needs a duration');
  if (!ticketScoped && minutes > pol.maxMinutes) v.push(`${minutes} min is longer than the policy's ${pol.maxMinutes} min`);
  if (activeAgentGrants() >= pol.maxActive) v.push(`already ${activeAgentGrants()} active agent-approved grants (policy: ${pol.maxActive})`);
  return v;
}
export function approverFor(seat, pol = policy()) {
  return pol.approvers.find((id) => id !== seat && agentById[id] && agentById[id].enabled !== false) || null;
}
/** A seat (or the desk, for a verify task) asks for access. Returns the request and a message for the seat. */
export function request({ seat, probes, why, minutes = null, ticketScoped = false, ticketKey = null, runId = null, filedBy = seat }) {
  if (!agentById[seat]) throw err(`unknown seat ${seat}`);
  probes = parseProbes(probes);
  if (!String(why || '').trim()) throw err('say why: --why "<what you need to check and why>"');
  if (!ticketScoped && !minutes) minutes = 60;
  const dup = store.openAccessRequests().find((r) => r.seat === seat && (r.ticket_key || null) === (ticketKey || null) && (!runId || r.run_id === runId || !r.run_id));
  if (dup) return { request: dup, message: `Request #${dup.id} is already ${dup.status === 'owner' ? "with the owner" : `with ${nameOf(dup.approver)}`}.` };
  const pol = policy();
  const approver = approverFor(seat, pol);
  const v = violations({ seat, probes, minutes, ticketScoped }, null, pol);
  const toOwner = v.length > 0 || !approver;
  const r = store.insertAccessRequest({ seat, probes, why: String(why).slice(0, 500), minutes: ticketScoped ? null : minutes, ticket_scoped: ticketScoped, ticket_key: ticketKey,
    run_id: ticketScoped && !ticketKey ? runId : runId, filed_by: filedBy, status: toOwner ? 'owner' : 'pending', approver: toOwner ? null : approver,
    owner_reason: toOwner ? (v.length ? v.join('; ') : 'no EM/SRE approver is available') : null });
  const what = `${describeProbes(probes)} ${forText(minutes, ticketScoped, ticketKey)}`;
  const text = `${nameOf(seat)} asked for production read access (${what}): ${r.why}`;
  store.logEvent({ kind: 'action', agent_id: filedBy === 'desk' ? 'system' : seat, ticket_key: ticketKey, text: `${text} → ${toOwner ? 'the owner decides' : `${nameOf(approver)} reviews`}` });
  if (ticketKey) store.addComment(ticketKey, filedBy === 'desk' ? 'system' : seat, `🔑 ${esc(text)}\n\n${toOwner ? `This needs the owner: ${r.owner_reason}.` : `${nameOf(approver)} reviews it within the owner's access policy.`}`);
  if (toOwner) notify('needs_human', ticketKey ? store.getTicket(ticketKey) : null, `Grant ${nameOf(seat)} production read access ${forText(minutes, ticketScoped, ticketKey)}?`);
  return { request: r, message: `Request #${r.id} filed; ${toOwner ? `it needs the owner (${r.owner_reason})` : `${nameOf(approver)} reviews it`}. Probes work as soon as it is granted (desk ops list shows your access). Continue meanwhile from code and logs.` };
}

/** Create a grant from a decision. `by` is 'owner' or an approver seat (policy already checked for seats). */
function makeGrant({ seat, probes, minutes, ticketScoped, ticketKey, runId, standing = false, by, reason, requestId = null }) {
  const pol = policy();
  const cap = new Date(Date.now() + (ticketScoped ? pol.ticketMaxHours * 60 : minutes) * 60_000).toISOString();
  // Ticket grants bind to the asking run if it is still live on that ticket, else stay dormant until the next launch.
  const asking = runId ? store.getRun(runId) : null;
  const liveRun = asking?.token ? asking : null;
  const runBinding = !ticketScoped ? null : !ticketKey ? liveRun?.id ?? -1 : liveRun && liveRun.ticket_key === ticketKey ? liveRun.id : null;
  const g = store.insertGrant({ seat, probes, expires_at: standing ? null : cap, ticket_key: ticketScoped ? ticketKey : null, run_id: runBinding,
    standing, granted_by: by, request_id: requestId, reason });
  const what = describeProbes(probes);
  const text = `${by === 'owner' ? 'The owner' : nameOf(by)} gave ${nameOf(seat)} production read access ${standing ? '(standing)' : forText(minutes, ticketScoped, ticketKey)} to ${what === 'all read-only probes' ? 'use the read-only probes' : `check ${what}`}${reason ? ` — ${reason}` : ''}`;
  store.logEvent({ kind: 'action', agent_id: by === 'owner' ? 'owner' : by, ticket_key: g.ticket_key, text });
  const onTicket = g.ticket_key || ticketKey; // a timed grant answering a ticket's request is reported there too
  if (onTicket && store.getTicket(onTicket)) store.addComment(onTicket, by === 'owner' ? 'owner' : by, `🔑 ${esc(text)}.`);
  if (by !== 'owner') notify('access', g.ticket_key ? store.getTicket(g.ticket_key) : null, text); // every agent-made grant reaches the owner
  return g;
}

/** An approver seat decides (desk access approve|deny|owner). Policy and self-approval are enforced here. */
export function decide(approverSeat, id, action, { minutes = null, ticketScoped = null, note = '', runId = null } = {}) {
  const r = store.getAccessRequest(Number(id));
  if (!r || !['pending', 'reviewing', 'owner'].includes(r.status)) throw err(`no open access request #${id}`);
  const pol = policy();
  if (approverSeat !== 'owner') {
    if (!pol.approvers.includes(approverSeat)) throw err(`${nameOf(approverSeat)} is not an access approver`, 403);
    if (r.seat === approverSeat) throw err('nobody approves their own access (that includes extending it); the other approver or the owner decides', 403);
    if (r.status === 'owner') throw err('this request is the owner\'s decision', 403);
    // Bound to the review: only the run the desk assigned to THIS request may decide it.
    if (r.status !== 'reviewing' || r.approver !== approverSeat || !runId || r.review_run !== runId) throw err(`request #${r.id} is not the one assigned to this review run`, 403);
  }
  if (!String(note || '').trim() && action !== 'approve') throw err('say why');
  if (action === 'deny') {
    store.updateAccessRequest(r.id, { status: 'denied', decided_by: approverSeat, decided_at: nowIso(), note: String(note).slice(0, 500) });
    const text = `${approverSeat === 'owner' ? 'The owner' : nameOf(approverSeat)} declined ${nameOf(r.seat)}'s production read access request: ${note}`;
    store.logEvent({ kind: 'action', agent_id: approverSeat, ticket_key: r.ticket_key, text });
    if (r.ticket_key) store.addComment(r.ticket_key, approverSeat, `🔒 ${esc(text)}`);
    return 'Declined.';
  }
  if (action === 'owner') {
    store.updateAccessRequest(r.id, { status: 'owner', approver: null, owner_reason: `${nameOf(approverSeat)} left it to the owner: ${note}` });
    notify('needs_human', r.ticket_key ? store.getTicket(r.ticket_key) : null, `Grant ${nameOf(r.seat)} production read access?`);
    store.logEvent({ kind: 'action', agent_id: approverSeat, ticket_key: r.ticket_key, text: `${nameOf(approverSeat)} left ${nameOf(r.seat)}'s access request to the owner: ${note}` });
    return 'Left to the owner.';
  }
  if (action !== 'approve') throw err('approve | deny | owner');
  const probes = json(r.probes, ['*']);
  const scoped = ticketScoped ?? !!r.ticket_scoped;
  const mins = scoped ? null : minutes || r.minutes || 60;
  if (approverSeat !== 'owner') {
    const v = violations({ seat: r.seat, probes, minutes: mins, ticketScoped: scoped }, approverSeat, pol);
    if (v.length) throw err(`beyond the owner's policy: ${v.join('; ')}. Approve within it (shorter --for), deny, or leave it to the owner (desk access owner ${r.id} "<why>")`, 403);
  }
  const g = makeGrant({ seat: r.seat, probes, minutes: mins, ticketScoped: scoped, ticketKey: r.ticket_key, runId: r.run_id, by: approverSeat, reason: note || r.why, requestId: r.id });
  store.updateAccessRequest(r.id, { status: 'approved', decided_by: approverSeat, decided_at: nowIso(), note: String(note || '').slice(0, 500), grant_id: g.id });
  return `Granted (#${g.id}, ${span(g)}).`;
}

/** Owner: grant anything, any time (standing, timed, or for one ticket). */
export function ownerGrant({ seat, probes = ['*'], minutes = null, ticket_key = null, standing = false, reason = '' }) {
  if (!agentById[seat]) throw err(`unknown seat ${seat}`);
  const p = parseProbes(probes);
  if (!standing && !ticket_key && !(Number(minutes) >= 5)) throw err('choose a duration (minutes ≥ 5), a ticket, or standing');
  if (ticket_key && !store.getTicket(ticket_key)) throw err(`no ticket ${ticket_key}`);
  return makeGrant({ seat, probes: p, minutes: Number(minutes) || null, ticketScoped: !!ticket_key && !standing, ticketKey: ticket_key, standing: !!standing, by: 'owner', reason });
}
/** Revoke one grant now (owner, EM or SRE). Probes in flight that lost their authorization are cancelled. */
export function revoke(id, by, reason = '') {
  const g = store.getGrant(Number(id));
  if (!g || g.revoked_at) throw err(`no active grant #${id}`);
  if (by !== 'owner' && !policy().approvers.includes(by)) throw err(`${nameOf(by)} cannot revoke access`, 403);
  endGrant(g, by, reason);
  ops.recheckInflight();
  return `Revoked #${g.id} (${nameOf(g.seat)}).`;
}
export function revokeAll(by = 'owner', reason = 'emergency: revoke all') {
  let n = 0;
  for (const g of store.openGrants()) if (endGrant(g, by, reason)) n++;
  for (const r of store.openAccessRequests()) store.updateAccessRequest(r.id, { status: 'denied', decided_by: by, decided_at: nowIso(), note: reason });
  ops.cancelAll();
  return n;
}

// ---------------- approver runs ----------------
/** The next request an idle EM/SRE should review: { request, approver }. */
export function nextReview(isIdle) {
  for (const r of store.openAccessRequests()) {
    if (r.status !== 'pending') continue;
    const approver = r.approver && r.approver !== r.seat ? r.approver : approverFor(r.seat);
    if (!approver) { store.updateAccessRequest(r.id, { status: 'owner', owner_reason: 'no EM/SRE approver is available' }); continue; }
    if (isIdle(approver)) return { request: r, approver };
  }
  return null;
}
export function startReview(r, approver, runId) { store.updateAccessRequest(r.id, { status: 'reviewing', approver, review_run: runId, attempts: (r.attempts || 0) + 1 }); }
/** A review run ended: undecided requests go back to pending, or to the owner after two tries. */
export function reviewEnded(id) {
  const r = store.getAccessRequest(id);
  if (r?.status !== 'reviewing') return;
  store.updateAccessRequest(id, r.attempts >= 2 ? { status: 'owner', approver: null, owner_reason: `${nameOf(r.approver)} did not decide` } : { status: 'pending' });
}
export function reviewPrompt(r) {
  const pol = policy();
  const active = store.openGrants().filter((g) => !endReason(g));
  return `Production access review. ${nameOf(r.seat)} (${agentById[r.seat]?.role}) asks for read-only production probes.
Request #${r.id}: ${describeProbes(json(r.probes, []))} ${forText(r.minutes, !!r.ticket_scoped, r.ticket_key)}${r.ticket_key ? ` on ${r.ticket_key}` : ''}.
<request-reason untrusted="true">${esc(r.why)}</request-reason>
Owner policy for agent approvers: seats ${pol.seats.join(', ')}; probes ${pol.probes.join(', ')}; at most ${pol.maxMinutes} min (or ticket-scoped); at most ${pol.maxActive} active agent-approved grants.
Active grants now: ${active.map((g) => `#${g.id} ${nameOf(g.seat)} ${span(g)}`).join('; ') || 'none'}.
${r.ticket_key ? `Read the ticket first (desk show ${r.ticket_key}). ` : ''}Grant the least that answers the need: the fewest probes, the shortest time, ticket-scoped where it fits.
Finish with exactly one:
  desk access approve ${r.id} [--for 30m|1h | --ticket] "<why this is justified>"
  desk access deny ${r.id} "<why>"
  desk access owner ${r.id} "<why only the owner should decide>"`;
}

// ---------------- views ----------------
const view = (g) => ({ ...g, probes: json(g.probes, []), seat_name: nameOf(g.seat), ends: endReason(g) });
export function summary() {
  const grants = store.openGrants().filter((g) => !endReason(g)).map(view);
  const requests = store.openAccessRequests().map((r) => ({ ...r, probes: json(r.probes, []), seat_name: nameOf(r.seat), approver_name: r.approver ? nameOf(r.approver) : null }));
  return { grants, requests, owner_requests: requests.filter((r) => r.status === 'owner') };
}
export function details() {
  return { ...summary(), policy: policy(), probes: probeIds(), seats: Object.keys(agentById).map((id) => ({ id, name: nameOf(id), role: agentById[id].role })),
    history: { grants: store.grantHistory(50).map(view), requests: store.accessRequestHistory(50).map((r) => ({ ...r, probes: json(r.probes, []), seat_name: nameOf(r.seat) })) } };
}
/** `desk access list` / `desk ops list` text. */
export function listText(seat = null) {
  const s = summary();
  const mine = seat ? s.grants.filter((g) => g.seat === seat) : s.grants;
  return [`Active grants${seat ? ' (yours)' : ''}: ${mine.map((g) => `#${g.id} ${g.seat_name}: ${describeProbes(g.probes)}, ${span(g)}, by ${g.granted_by}`).join('; ') || 'none'}`,
    `Open requests: ${s.requests.filter((r) => !seat || r.seat === seat || r.approver === seat).map((r) => `#${r.id} ${r.seat_name} (${r.status}${r.approver_name ? `, ${r.approver_name}` : ''}): ${describeProbes(r.probes)} ${forText(r.minutes, !!r.ticket_scoped, r.ticket_key)}`).join('; ') || 'none'}`].join('\n');
}
