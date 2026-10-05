// Where an owner's request stands, as steps a person can read: received → planned → assigned → building → QA →
// code review → ready to merge → done. Pure: the desk's ticket sheet and the Projects home both use it.
// It is a projection of state the desk already has; it never decides on its own what needs the owner:
// - decisions: the board's decisions (public/attention.js) for this ticket and its tasks
// - merge: mergetrain.mergeState(ticket) when it is ready (queued / scheduled / owner / conflict …)
// - plan: the feature plan record; kids: child tasks (an epic's work); deploy: the stored deploy lock
// Work that goes back (QA sent it back, a refresh re-runs QA) moves back; an unknown status says so.

export const STEPS = [
  { id: 'received', label: 'Received' },
  { id: 'planned', label: 'Planned' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'building', label: 'Building' },
  { id: 'qa', label: 'QA' },
  { id: 'review', label: 'Code review' },
  { id: 'ready', label: 'Ready to merge' },
  { id: 'done', label: 'Done' },
];
const ORDER = STEPS.map((s) => s.id);
const AT = { triage: 'received', proposed: 'planned', todo: 'assigned', in_progress: 'building', qa: 'qa', review: 'review', ready_for_human: 'ready', done: 'done' };
const PRINCIPAL = /^principal-/;
const PLANNING = { queued: 'Waiting for the planning session', grooming: 'The manager is writing the plan', ready: 'The plan is ready for you',
  failed: 'Planning failed: retry it on the feature page', discarded: 'You set the plan aside', approved: null };
const AUTO_MERGE = { queued: 'Approved; it merges automatically when the checks allow', scheduled: 'Approved; it merges automatically after the busy hours',
  merging: 'Merging now', conflict: 'Resolving a conflict with the latest code', held: 'On hold: you paused its merge' };

function atOf(t) {
  if (t.status === 'needs_human') return t.resume_status === 'done' ? 'ready' : AT[t.resume_status] || (t.head_sha ? 'qa' : 'building');
  if (t.status === 'todo' && (t.qa_loops > 0 || t.head_sha)) return 'building'; // sent back: rework is building again
  return AT[t.status] || null;
}

export function stageOf(t, ctx = {}) {
  const name = (id) => ctx.names?.[id] || id;
  const all = ctx.kids || [];
  const kids = all.filter((k) => k.status !== 'wontdo');
  const epic = all.length > 0;
  const blank = (line, extra = {}) => ({ steps: STEPS.map((s) => ({ ...s, state: 'todo' })), at: null, closed: false, done: false, who: null, why: null, actions: [], epic, line, ...extra });
  if (t.status === 'wontdo') return blank('Closed without changes', { closed: true });
  let at = atOf(t);
  if (!at) return blank(`Status unavailable (${t.status})`);
  let line = null;
  let who = null;
  // Planning: a feature waits on its plan; ordinary work waits on grooming.
  if (ctx.plan && ctx.plan.status !== 'approved' && t.status !== 'done') { at = 'planned'; line = PLANNING[ctx.plan.status] || 'Being planned'; who = 'manager'; }
  else if (epic && t.status !== 'done') {
    // An epic is built through its tasks: progress, and who is on them now.
    const merged = kids.filter((k) => k.status === 'done').length;
    at = 'building';
    line = `${merged} of ${kids.length} task${kids.length === 1 ? '' : 's'} done`;
  }
  // Who has it now, and what they are doing.
  if (!who) who = t.owner_task ? 'you' : at === 'received' ? 'support' : at === 'planned' ? 'manager' : at === 'qa' ? 'qa' : epic ? null : t.assignee || null;
  if (!line && t.status === 'in_progress' && PRINCIPAL.test(t.assignee || '')) line = `${name(t.assignee)} is designing it and splitting it into tasks`;
  if (!line && t.status === 'todo' && !(t.qa_loops > 0 || t.head_sha)) line = t.assignee ? `Planned for ${name(t.assignee)}; another engineer who fits may take it first` : 'Waiting for an engineer';
  if (!line && t.status === 'todo') line = `Back with ${name(t.assignee) || 'the engineer'} to fix what QA or review found`;
  if (!line && t.review_stage === 'resolving') line = 'Resolving a merge conflict';
  if (!line && t.review_stage === 'responding') line = `${name(t.assignee) || 'The engineer'} is answering the reviewers`;
  // Ready: queued for the automatic merge is not the owner's job; the merge state says which it is.
  const auto = at === 'ready' && ctx.merge && AUTO_MERGE[ctx.merge.state];
  if (!line && auto) line = auto;
  // Done: merged code, a completed owner task, or an epic whose tasks settled.
  const deploying = t.status === 'done' && ctx.deploy?.key === t.key && ['running', 'merging'].includes(ctx.deploy.state);
  if (t.status === 'done') line = deploying ? 'Merged; the deploy is running' : epic ? (all.some((k) => k.status === 'wontdo') ? 'Done (some tasks were dropped)' : 'Every task is done')
    : t.pr_url ? 'Merged' : 'Completed';
  // What the owner must do: the board's decisions, minus a merge the desk will do by itself.
  const actions = (ctx.decisions || []).filter((d) => !(d.kind === 'merge' && auto)).map((d) => ({ id: d.id, key: d.key, kind: d.kind, text: d.verb || d.action || 'Needs you' }));
  if (!line) line = actions[0]?.text || { received: 'Waiting to be triaged', planned: 'Being groomed into a plan', assigned: 'Waiting for an engineer',
    building: `${name(who) || 'An engineer'} is building it`, qa: 'QA is checking it', review: 'Two engineers are reviewing the code', ready: 'Ready to merge' }[at];
  const i = ORDER.indexOf(at);
  const finished = t.status === 'done' && !deploying;
  const steps = STEPS.map((s, j) => ({ ...s, state: j < i || (j === i && finished) ? 'done' : j === i ? 'current' : 'todo' }));
  return { steps, at, closed: false, done: finished, who, why: t.assign_reason || null, actions, epic, line };
}
