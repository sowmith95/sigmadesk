// One attention model for the whole UI. Every count, lane and Inbox card derives from attend(); nothing else
// decides "does this need the owner?". Pure (no DOM), so the server and tests share it.
//
// Buckets, in the order the owner cares about them:
//   needs_you — only the owner can move it (answer, publish approval, merge, design decision, page)
//   blocked   — stuck for a reason that is not the owner's queue (provider hold, budget, failed run)
//   working   — a seat is running on it right now
//   queued    — will move on its own (seat busy, waiting on a dependency, not yet picked up)
//   shipped   — done
//   closed    — won't do (hidden by default)
import { nameOf } from './names.js';

export const BUCKETS = ['needs_you', 'blocked', 'working', 'queued', 'shipped', 'closed'];
const OPEN_STAGES = { triage: 'Intake', proposed: 'Proposed', todo: 'To do', in_progress: 'Building', qa: 'QA', review: 'Acceptance' };
// Structured scheduler wait codes (scheduler.health): these move by themselves; provider_hold / budget need someone.
const SELF_CODES = new Set(['paused', 'dependency', 'seat_busy', 'tick', 'setup_retry']);
// Fallback for older servers that send only a human reason.
const SELF_RESOLVING = /desk paused|seat busy|waiting for \S+ to (merge|finish)|capacity|concurrent|busy window|queued behind|next (scheduler )?tick|setup retry/i;
const selfResolving = (w) => (w.code ? SELF_CODES.has(w.code) : SELF_RESOLVING.test(w.reason || ''));

const isGuard = (t) => /publish guard/i.test(t.progress_msg || '');
const firstName = (agents, id) => (agents.find((a) => a.id === id)?.name || '').split(/\s+/)[0] || 'the engineer';

/**
 * Every owner decision on one ticket, each its own item: the ticket's hold (question / guard / merge / publish),
 * each pending design proposal, each finished council. `id` is unique per decision; `key` stays the ticket key.
 */
export function decisionsFor(t, ctx = {}) {
  const { agents = [], proposals = [], councils = [] } = ctx;
  if (['done', 'wontdo'].includes(t.status)) return [];
  const name = nameOf(t);
  const base = { key: t.key, name, stage: OPEN_STAGES[t.status] || null, epic: false, worker: null, bucket: 'needs_you' };
  const out = [];
  if (t.status === 'needs_human') {
    if (isGuard(t)) out.push({ ...base, id: `${t.key}:guard`, kind: 'guard', action: 'Approve publication', verb: `Unblock publish guard on ${name}`, reason: 'The change touches protected paths or is unusually large. Review the diff before it is pushed.' });
    else out.push({ ...base, id: `${t.key}:question`, kind: 'question', action: 'Answer and continue', verb: `Answer ${firstName(agents, t.assignee)}`, reason: t.progress_msg || 'Waiting for your direction.' });
  } else if (t.status === 'ready_for_human') {
    if (t.pr_url) out.push({ ...base, id: `${t.key}:merge`, kind: 'merge', action: 'Review merge', verb: `Merge ${name}`, reason: 'QA passed. The draft PR is waiting for your review and merge.' });
    else out.push({ ...base, id: `${t.key}:publish`, kind: 'publish', action: 'Approve publication', verb: `Publish ${name}`, reason: 'QA passed. Approving pushes the branch and opens a draft PR.' });
  }
  const props = proposals.filter((p) => p.ticket_key === t.key).sort((a, b) => a.id - b.id);
  for (const p of props) out.push({ ...base, id: `${t.key}:design:${p.id}`, kind: 'design', action: 'Review design', proposal_id: p.id,
    verb: `Decide the design for ${name}${props.length > 1 ? ` (#${p.id})` : ''}`, reason: 'The manager finished a design recommendation.' });
  for (const c of councils.filter((x) => x.ticket_key === t.key && x.status === 'complete' && !x.decision).sort((a, b) => a.id - b.id))
    out.push({ ...base, id: `${t.key}:council:${c.id}`, kind: 'council', action: 'Review council', council_id: c.id, verb: `Decide the council on ${name}`, reason: 'The architecture council has a verdict.' });
  return out;
}

/** Classify one ticket (its primary item). ctx = { agents, tickets, events, waiting, proposals, councils } (all optional). */
export function attend(t, ctx = {}) {
  const { agents = [], tickets = [], events = [], waiting = [] } = ctx;
  const name = nameOf(t);
  const kids = tickets.filter((k) => k.parent_key === t.key);
  const worker = agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const stage = OPEN_STAGES[t.status] || null;
  const base = { key: t.key, id: t.key, name, stage, epic: kids.length > 0, worker: worker?.id || null };

  if (t.status === 'done') return { ...base, bucket: 'shipped', verb: `Shipped ${name}`, reason: t.pr_url ? 'Merged' : 'Done' };
  if (t.status === 'wontdo') return { ...base, bucket: 'closed', verb: name, reason: 'Closed without shipping' };

  const decisions = decisionsFor(t, ctx);
  if (decisions.length) return { ...decisions[0], epic: base.epic, worker: base.worker };

  // An epic is a summary of its slices, never an extra working/queued item: the slices carry the counts.
  if (base.epic) {
    const done = kids.filter((k) => k.status === 'done').length;
    const live = kids.some((k) => agents.some((a) => a.current_ticket === k.key && a.status === 'working'));
    return { ...base, bucket: 'epic', live, verb: name, reason: `${done} of ${kids.length} slices shipped` };
  }
  if (worker) return { ...base, bucket: 'working', verb: name, reason: `${firstName(agents, worker.id)} · ${stage || 'working'}` };

  const w = waiting.find((x) => x.key === t.key);
  if (w && !selfResolving(w)) return { ...base, bucket: 'blocked', verb: `Unblock ${name}`, reason: w.reason, code: w.code };
  const last = events.filter((e) => e.ticket_key === t.key && ['error', 'done', 'run', 'pickup'].includes(e.kind)).sort((a, b) => b.id - a.id)[0];
  if (last?.kind === 'error' && (t.stalls || 0) > 0) return { ...base, bucket: 'blocked', verb: `Unblock ${name}`, reason: last.text.slice(0, 160) };

  const dep = t.after_key && tickets.find((x) => x.key === t.after_key);
  const reason = w?.code === 'tick' ? 'Starts on the next scheduler tick' : w?.reason ? humanReason(w.reason, tickets)
    : dep && dep.status !== 'done' ? `Starts after ${nameOf(dep)} merges` : t.status === 'triage' ? 'Waiting for the manager to groom it' : 'Waiting for a seat';
  return { ...base, bucket: 'queued', verb: name, reason, code: w?.code };
}

/** Replace raw ticket keys in scheduler reasons with names. */
export function humanReason(reason, tickets) {
  return String(reason || '').replace(/\b([A-Z][A-Z0-9]{0,5}-\d+)\b/g, (k) => { const t = tickets.find((x) => x.key === k); return t ? nameOf(t) : k; });
}

/** Classify every ticket plus desk-level items (pages) into ordered buckets. Counts come only from here.
 * needs_you holds decisions (a ticket can contribute several); epics are summaries in `epics`, outside the counts. */
export function board(state, extra = {}) {
  const tickets = state.tickets || [];
  const ctx = { agents: state.agents || [], tickets, events: state.events || [], waiting: state.meta?.scheduler?.waiting || [],
    proposals: extra.proposals || state.meta?.decisions?.proposals || [], councils: state.meta?.council?.councils || [] };
  const out = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  out.epics = [];
  for (const t of tickets) {
    const it = { ...attend(t, ctx), ticket: t };
    if (it.bucket === 'needs_you') for (const d of decisionsFor(t, ctx)) out.needs_you.push({ ...d, epic: it.epic, worker: it.worker, ticket: t });
    else if (it.bucket === 'epic') out.epics.push(it);
    else out[it.bucket].push(it);
  }
  // A page whose incident already has a ticket is represented by that ticket; never count it twice.
  for (const inc of state.incidents || []) {
    if (inc.status === 'paged' && !inc.ticket_key) out.needs_you.push({ key: `incident-${inc.id}`, id: `incident-${inc.id}`, incident: inc, bucket: 'needs_you', kind: 'page',
      action: 'Look at errors', verb: `Check ${inc.label || 'service'} errors`, reason: String(inc.normalized || '').slice(0, 160), name: inc.label });
  }
  const rank = { guard: 0, question: 1, page: 2, merge: 3, publish: 4, design: 5, council: 6 };
  out.needs_you.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || age(a) - age(b));
  out.shipped.sort((a, b) => String(b.ticket?.updated_at).localeCompare(String(a.ticket?.updated_at)));
  return { ...out, counts: Object.fromEntries(BUCKETS.map((b) => [b, out[b].length])) };
}

const age = (it) => Date.parse(it.ticket?.updated_at || it.incident?.last_seen || 0) || 0;

/** Desk status for the header instrument. */
export function deskStatus(state) {
  const s = state.settings || {}, m = state.meta || {};
  if (s.paused === 'true') return { label: 'Halted', tone: 'amber', detail: 'Running work finishes; nothing new starts' };
  if ((m.providers || []).length && !(m.providers || []).some((p) => p.available)) return { label: 'Offline', tone: 'red', detail: 'No model provider is available on this machine' };
  if (m.scheduler?.last_error) return { label: 'Error', tone: 'red', detail: m.scheduler.last_error };
  const avail = (m.providers || []).filter((p) => p.available);
  if (avail.length && avail.every((p) => !p.ready)) return { label: 'Held', tone: 'amber', detail: avail.map((p) => `${p.label}: ${p.reason || 'not ready'}`).join(' · ') };
  const tick = m.scheduler?.last_tick ? Date.parse(m.scheduler.last_tick) : 0;
  if (tick && Date.now() - tick > 5 * 60_000) return { label: 'Stalled', tone: 'red', detail: 'Scheduler has not ticked for 5 minutes' };
  return { label: m.running ? 'Running' : 'Ready', tone: 'green', detail: `${m.running || 0} running` };
}
