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
import * as flow from './flow.js';
import * as inbox from './inbox.js';
import { nameOf } from './names.js';

export const BUCKETS = ['needs_you', 'blocked', 'working', 'queued', 'shipped', 'closed'];
const OPEN_STAGES = { triage: 'Intake', proposed: 'Proposed', todo: 'To do', in_progress: 'Building', qa: 'QA', review: 'Acceptance' };
// Structured scheduler wait codes (scheduler.health): these move by themselves; provider_hold / budget need someone.
const SELF_CODES = new Set(['paused', 'dependency', 'seat_busy', 'tick', 'setup_retry', 'product_review', 'research_review']);
// Fallback for older servers that send only a human reason.
const SELF_RESOLVING = /desk paused|seat busy|waiting for \S+ to (merge|finish)|capacity|concurrent|busy window|queued behind|next (scheduler )?tick|setup retry/i;
const selfResolving = (w) => (w.code ? SELF_CODES.has(w.code) : SELF_RESOLVING.test(w.reason || ''));

const isGuard = (t) => /publish guard/i.test(t.progress_msg || '');
// The desk merges these by itself (mergetrain.mergeState): not the owner's step.
const AUTO_MERGE = { queued: 'Approved; the desk merges it when CI and the deploy allow', scheduled: 'Approved; the desk merges it after the busy hours',
  merging: 'Merging now', conflict: 'Resolving a conflict with the latest code' };
/**
 * A held ticket (needs_human) is not always a question: each hold has its own step for the owner. Keyed on the
 * progress messages the desk writes when it holds work (scheduler, reviews, refresh, merge train).
 */
const HOLDS = [
  [/conflict needs your call/i, 'conflict', 'Decide the conflict', (n) => `Decide how to combine ${n} with the latest code`, 'The engineer could not combine both sides safely; the choice is yours.'],
  [/no eligible code reviewer/i, 'setup', 'Choose a reviewer', (n) => `Nobody can review ${n}`, 'Every reviewer seat built it or is switched off. Switch a reviewer seat on in Team, then reply here to resume the review.'],
  [/^\S.* is switched off$/, 'setup', 'Switch the seat on', (n) => `Switch a seat back on for ${n}`, null],
  [/workspace setup failed/i, 'setup', 'Retry', (n) => `Retry preparing ${n}`, 'The desk could not prepare a workspace (disk, git or network). Reply to retry once it is fixed.'],
  [/base changed — refresh/i, 'refresh', 'Refresh the branch', (n) => `Refresh ${n} onto the latest code`, 'The main branch moved under this change; refresh it and QA runs again.'],
  [/remote branch changed|refresh interrupted/i, 'refresh', 'Look at the branch', (n) => `Check the branch of ${n}`, 'Someone changed the PR branch outside the desk, or a refresh was interrupted. Look at it, then reconcile or refresh.'],
  [/closed unmerged/i, 'stuck', 'Decide', (n) => `Decide what happens to ${n}`, 'The task it builds on was closed without merging. Continue without it (reply), rescope or close it.'],
  [/disagree — your call/i, 'conflict', 'Settle the review', (n) => `Settle the review of ${n}`, null],
  [/QA failed repeatedly|review loop limit|CI keeps failing/i, 'stuck', 'Give direction', (n) => `${n} is stuck after several attempts`, 'The team tried several times. Give direction, reassign, split or close it.'],
];
// A branch refresh the owner started: the desk holds the ticket while it rebases (no step for anyone).
const REFRESHING = (t) => t.active_run === -1 && /desk refreshing remote base/i.test(t.progress_msg || '');
const holdOf = (t) => HOLDS.find(([re]) => re.test(t.progress_msg || ''));
function guardWhy(g) {
  if (!g?.reasons?.length) return 'The change touches protected paths or is unusually large. Review the diff before it is pushed.';
  return `Held before pushing: ${g.reasons.join('; ')}. Approving pushes it; the reviewers then check this exact commit.`;
}
// Records about a commit (why the guard held it, a failed publish) only count for the ticket's current commit: a
// stream update can change head_sha before the next snapshot refreshes the records.
const atHead = (rec, t) => (rec && rec.head && rec.head === t.head_sha ? rec : null);
// A merge hold the desk set itself (a foreign push, a guarded automatic update) is not the owner's pause.
const DESK_HOLD = /^(the PR branch changed outside the desk|publish guard:)/i;
const firstName = (agents, id) => (agents.find((a) => a.id === id)?.name || '').split(/\s+/)[0] || 'the engineer';

/**
 * Every owner decision on one ticket, each its own item: the ticket's hold (question / guard / merge / publish),
 * each pending design proposal, each finished council. `id` is unique per decision; `key` stays the ticket key.
 */
export function decisionsFor(t, ctx = {}) {
  const { agents = [], proposals = [], councils = [], productReviews = [], researchReviews = [], featurePlans = [], mergeStates = {}, mergeReasons = {}, guardReasons = {}, publishErrors = {} } = ctx;
  if (['done', 'wontdo'].includes(t.status)) return [];
  // A feature waiting on its plan: the owner reviews a ready plan, or retries a failed grooming round.
  const fp = featurePlans.find((p) => p.ticket_key === t.key);
  if (fp && ['ready', 'failed'].includes(fp.status)) {
    const n = nameOf(t);
    return [{ key: t.key, name: n, stage: 'Planning', epic: false, worker: null, bucket: 'needs_you', id: `${t.key}:plan:${fp.revision}:${fp.status}`, kind: 'plan',
      action: fp.status === 'ready' ? 'Review plan' : 'See what failed', verb: fp.status === 'ready' ? `Review the plan for ${n}` : `Grooming ${n} failed`,
      reason: fp.status === 'ready' ? (fp.stale ? 'You changed the request after this plan was written; ask Codex for a new round.' : fp.plan?.summary || 'Codex finished a plan.') : fp.error || 'The grooming round failed.' }];
  }
  const name = nameOf(t);
  const base = { key: t.key, name, stage: OPEN_STAGES[t.status] || null, epic: false, worker: null, bucket: 'needs_you' };
  const out = [];
  // A research proposal held by its second reviewer: the owner approves (waives), sends it back, or rejects it.
  const rr = researchReviews.find((r) => r.ticket_key === t.key);
  if (t.status === 'needs_human' && (rr?.state === 'held' || t.research_review === 'held')) {
    return [{ ...base, id: `${t.key}:research:${rr?.generation || t.research_generation || 1}`, kind: 'research', action: 'Decide proposal', verb: `Decide the research proposal ${name}`,
      reason: rr?.reason || t.progress_msg || 'The second reviewer did not pass this proposal.' }];
  }
  // A step only the owner can do: it sits with the owner until they complete it or hand it back.
  if (t.owner_task) return [{ ...base, id: `${t.key}:owner-task`, kind: 'owner_task', action: 'Do it', verb: `Your task: ${name}`, reason: t.progress_msg && t.progress_msg !== 'your task' ? t.progress_msg : 'The team cannot do this step; the tasks after it wait for you.' }];
  const review = productReviews.find(r => r.ticket_key === t.key && (r.stale || ['changes','failed','stale','deferred','rejected'].includes(r.status)));
  if (review) return [{ ...base, id: `${t.key}:product:${review.phase}:${review.revision}`, kind: 'product', action: 'Review feedback', verb: `Resolve review for ${name}`, reason: review.stale ? 'The plan changed; its review must be refreshed.' : `Product/design review: ${review.status}` }];
  if (t.status === 'ready_for_human' && productReviews.some(r => r.ticket_key === t.key && r.phase === 'feedback' && r.status === 'reviewing')) return [];
  if (t.status === 'needs_human' && REFRESHING(t)) return [];
  if (t.status === 'needs_human') {
    const hold = !isGuard(t) && holdOf(t);
    if (isGuard(t)) out.push({ ...base, id: `${t.key}:guard`, kind: 'guard', action: 'Approve publication', verb: `Approve publishing ${name}`, reason: guardWhy(atHead(guardReasons[t.key], t)) });
    else if (hold) out.push({ ...base, id: `${t.key}:${hold[1]}`, kind: hold[1], action: hold[2], verb: hold[3](name), reason: hold[4] || t.progress_msg });
    else out.push({ ...base, id: `${t.key}:question`, kind: 'question', action: 'Answer and continue', verb: `Answer ${firstName(agents, t.assignee)}`, reason: t.progress_msg || 'Waiting for your direction.' });
  } else if (t.status === 'ready_for_human') {
    // Only a merge that is the owner's: a queued, scheduled or merging one the desk does by itself.
    const ms = mergeStates[t.key];
    const why = mergeReasons[t.key] || '';
    if (atHead(publishErrors[t.key], t)) { /* the desk is retrying the push of this commit, shown by attend() */ }
    else if (t.pr_url && AUTO_MERGE[ms]) { /* the desk's step, shown by attend() */ }
    else if (t.pr_url && ms === 'held' && DESK_HOLD.test(t.merge_hold || why)) out.push({ ...base, id: `${t.key}:merge`, kind: 'merge', action: 'Review merge',
      verb: /^publish guard/i.test(t.merge_hold || why) ? `Review the protected update to ${name}` : `Check the branch of ${name}`,
      reason: `The desk held this merge: ${t.merge_hold || why}. Look at the PR, then merge it yourself or release the hold once the branch is right.` });
    else if (t.pr_url) out.push({ ...base, id: `${t.key}:merge`, kind: 'merge', action: 'Review merge', verb: ms === 'held' ? `Release or merge ${name} (you paused it)` : `Merge ${name}`,
      reason: ms === 'held' ? 'You put its merge on hold. Release it to let the desk merge, or merge it yourself.'
        : ms === 'owner' ? `QA passed and the reviewers approved. This one needs your merge${why ? `: ${why}` : ' (risk or policy)'}.` : 'QA passed. Review the PR and merge it when you are ready.' });
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

  const fp = (ctx.featurePlans || []).find((p) => p.ticket_key === t.key);
  if (fp && ['queued', 'grooming', 'discarded'].includes(fp.status)) return { ...base, bucket: fp.status === 'grooming' ? 'working' : 'queued', stage: 'Planning',
    worker: fp.status === 'grooming' ? 'manager' : null, verb: name, reason: fp.status === 'grooming' ? 'Morgan is grooming it with Codex' : fp.status === 'queued' ? 'Waiting for Codex to groom it' : 'Plan set aside; nothing starts until you approve one' };
  const review = (ctx.productReviews || []).find(r => r.ticket_key === t.key && r.status === 'reviewing' && !r.stale);
  if (review) return { ...base, bucket: worker ? 'working' : 'queued', stage: review.phase === 'plan' ? 'Product review' : 'User feedback', verb: name, reason: worker ? `${firstName(agents, worker.id)} is reviewing` : 'Review waiting for available reviewers and capacity' };
  const rr = (ctx.researchReviews || []).find((r) => r.ticket_key === t.key && ['pending', 'changes'].includes(r.state));
  if (rr && t.status === 'proposed') return { ...base, bucket: worker ? 'working' : 'queued', stage: rr.state === 'changes' ? 'Revising' : 'Second review', verb: name, reason: worker ? `${firstName(agents, worker.id)} · ${rr.state === 'changes' ? 'revising the proposal' : 'reviewing the proposal'}` : rr.reason || 'Waiting for an independent second review' };

  // An epic is a summary of its slices, never an extra working/queued item: the slices carry the counts.
  if (base.epic) {
    const done = kids.filter((k) => k.status === 'done').length;
    const live = kids.some((k) => agents.some((a) => a.current_ticket === k.key && a.status === 'working'));
    return { ...base, bucket: 'epic', live, verb: name, reason: `${done} of ${kids.length} slices shipped` };
  }
  if (t.status === 'needs_human' && REFRESHING(t)) return { ...base, bucket: 'working', stage: 'Refreshing', verb: name, reason: 'The desk is moving this branch onto the latest code' };
  if (worker) return { ...base, bucket: 'working', verb: name, reason: `${firstName(agents, worker.id)} · ${stage || 'working'}` };
  // The desk's own steps, said plainly: an automatic merge, or a publish that keeps failing.
  const ms = (ctx.mergeStates || {})[t.key];
  const pe = atHead((ctx.publishErrors || {})[t.key], t);
  if (t.status === 'ready_for_human' && !pe && AUTO_MERGE[ms]) return { ...base, bucket: 'queued', stage: 'Merging', verb: name, reason: AUTO_MERGE[ms] };
  if (pe) return { ...base, bucket: pe.count >= 3 ? 'blocked' : 'queued', verb: pe.count >= 3 ? `Publishing ${name} keeps failing` : name,
    reason: `Publishing to GitHub failed${pe.count > 1 ? ` ${pe.count} times` : ''}: ${pe.message}. The desk retries every few minutes.` };

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
    proposals: extra.proposals || state.meta?.decisions?.proposals || [], councils: state.meta?.council?.councils || [], productReviews: state.meta?.product_reviews || [], researchReviews: state.meta?.research_reviews || [], featurePlans: state.meta?.feature_plans || [],
    mergeStates: state.meta?.merge_states || {}, mergeReasons: state.meta?.merge_reasons || {}, guardReasons: state.meta?.guard_reasons || {}, publishErrors: state.meta?.publish_errors || {} };
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
  // A deploy that failed or never confirmed holds every deploying merge: always the owner's (and never snoozable).
  const lock = state.meta?.deploy_lock;
  if (lock && ['failed', 'escalated'].includes(lock.state)) {
    const lt = tickets.find((x) => x.key === lock.key);
    out.needs_you.push({ key: lock.key || 'deploy', id: `deploy:${lock.merge_sha || lock.key || lock.id || 'last'}:${lock.state}`, kind: 'deploy', bucket: 'needs_you', ticket: lt, name: lt ? nameOf(lt) : lock.key || 'the last merge',
      action: 'Check the deploy', verb: `The deploy of ${lt ? nameOf(lt) : lock.key || 'the last merge'} ${lock.state === 'failed' ? 'failed' : 'was never confirmed'}`,
      reason: `${lock.note ? `${lock.note}. ` : ''}Every merge that deploys waits until you check it, then clear the hold (or merge with a reason).`, deploy: lock });
  }
  // An epic review's one question (and its proposed closes) is the owner's single decision for that epic.
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const covered = new Map();
  for (const r of state.meta?.epic_reviews || []) {
    const t = byKey.get(r.key);
    if (!t || ['done', 'wontdo'].includes(t.status)) continue;
    const name = nameOf(t);
    const base = { key: t.key, name, stage: 'Planning', epic: true, worker: null, bucket: 'needs_you', ticket: t, review: r };
    if (r.status === 'failed') out.needs_you.push({ ...base, id: `${t.key}:epic-review:${r.round}:failed`, kind: 'epic_review', action: 'See what failed', verb: `The review of ${name} failed`, reason: r.error || 'The epic review failed.' });
    else if (r.status === 'ready' && (r.question_state === 'open' || r.close_state === 'open')) {
      for (const k of r.question_state === 'open' ? r.result?.question?.covers || [] : []) covered.set(k, t.key);
      out.needs_you.push({ ...base, id: `${t.key}:epic-review:${r.round}`, kind: 'epic_review', action: r.question_state === 'open' ? 'Answer once' : 'Decide closes',
        verb: r.question_state === 'open' ? `One question about ${name}` : `Close tasks in ${name}?`, reason: r.result?.question?.text || r.result?.summary || '' });
    }
  }
  // One question, not three: a seat's question whose task only waits on something that already needs the owner is
  // folded under that item ("2 tasks wait on this"), so the owner sees the one thing to do.
  const ix = flow.index(tickets);
  const needKeys = new Set(out.needs_you.filter((d) => d.ticket).map((d) => d.ticket.key));
  const waiters = new Map();
  const waitersOf = (k) => { if (!waiters.has(k)) waiters.set(k, new Set(flow.waitingOn(k, tickets, ix).map((w) => w.key))); return waiters.get(k); };
  let rootList = null;
  const roots = () => (rootList ||= [...needKeys].filter((k) => ![...needKeys].some((o) => o !== k && waitersOf(o).has(k))));
  const grouped = [];
  for (const d of out.needs_you) {
    if (d.kind !== 'question' || !d.ticket) { grouped.push(d); continue; }
    const t = d.ticket;
    if (covered.has(t.key)) { d.waits_on = covered.get(t.key); d.waits_on_kind = 'epic_review'; continue; }
    // Fold under a root item: one that needs the owner and does not itself wait on another such item.
    const host = roots().find((k) => k !== t.key && waitersOf(k).has(t.key));
    if (!host) { grouped.push(d); continue; }
    if (covered.has(host)) { d.waits_on = covered.get(host); d.waits_on_kind = 'epic_review'; continue; } // its host is answered by the review
    d.waits_on = host;
  }
  for (const d of out.needs_you.filter((x) => x.waits_on)) {
    const host = grouped.find((g) => g.ticket?.key === d.waits_on && (d.waits_on_kind ? g.kind === d.waits_on_kind : g.kind !== 'epic_review'));
    if (host) { (host.waiting ||= []).push({ key: d.ticket.key, name: d.name, id: d.id }); } else grouped.push(d);
  }
  // `decisions` keeps every decision (the ticket sheet, Work page and palette find a ticket's decision there);
  // `needs_you` is the grouped Inbox list the counts describe.
  out.decisions = [...out.needs_you];
  const rank = { guard: 0, deploy: 0, owner_task: 1, conflict: 1, setup: 1, refresh: 1, stuck: 1, epic_review: 1, question: 1, page: 2, merge: 3, publish: 4, plan: 5, design: 6, council: 7, research: 8 };
  out.decisions.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || age(a) - age(b));
  // The Inbox: grouped rows in lanes and order (public/inbox.js); snoozed rows are set aside, not resolved, and are
  // not counted as needing you until they wake. Every decision stays in `decisions` for sheets, trackers and search.
  const arranged = inbox.arrange(grouped, { tickets, ix, snoozes: state.meta?.snoozes || {}, since: state.meta?.waiting_since || {}, incidents: state.incidents || [], protectedKeys: state.meta?.protected_tickets || [], now: extra.now || Date.now() });
  out.needs_you = arranged.active;
  out.snoozed = arranged.snoozed;
  out.do_first = arranged.doFirst;
  out.shipped.sort((a, b) => String(b.ticket?.updated_at).localeCompare(String(a.ticket?.updated_at)));
  return { ...out, counts: { ...Object.fromEntries(BUCKETS.map((b) => [b, out[b].length])), snoozed: out.snoozed.length } };
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
