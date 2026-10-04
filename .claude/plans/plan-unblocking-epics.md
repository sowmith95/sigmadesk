# Plan: unblock epics — next step, owner tasks, enforced gates, grouped questions, plan state, manager+principal review

Owner request (after SD-28: SD-29 needed production access, SD-32/34 started early and asked the same question):
build (1) next-step card, (2) owner tasks, (3) gates become dependencies, (4) one question not three, (5) plan state
for split features, and (6) the manager working on an epic with the principal when requirements are unclear or to
prioritise tasks so they are not blocked.

## Model
- `tickets.owner_task` (0/1): a task only the owner can do (access no seat has). Never dispatched to a seat; shown to
  the owner as "Your task"; the owner completes it with notes (status done, recorded as owner-completed) or hands it
  back to the team.
- Blockers of a ticket (`public/flow.js`, pure, shared by server and UI):
  - recorded: its `after_key` and every ancestor's `after_key` that is not done (an epic waiting means its tasks wait);
  - text gates (unrecorded): keys mentioned in title/description after "gated on|after|blocked by|depends on|requires|
    until" that are in the same feature tree, open, and not the ticket itself or its ancestors.
- Critical path: open leaf tasks in a tree; actionable = no unmet recorded blocker; `waitingOn(key)` = tasks that
  (transitively, recorded or text) wait on it.

## Server
1. Scheduler todo pickup skips owner tasks and tasks whose ancestor waits (`ancestorBlocked`), with a waiting reason.
2. `desk create-task --owner`: an owner task (manager/principal). Text gates in a new task: when the text names exactly one
   open task of the same tree and no --after is given, the desk records it as `after_key` and says so; if it names
   several, it refuses and asks for --after (no silent guess).
3. Feature plans (Codex) accept `owner: true` per task.
4. Owner routes: `POST /api/tickets/KEY/owner-task {owner_task}` (mark/unmark; unmark returns it to todo),
   `POST /api/tickets/KEY/owner-done {notes}` (owner task → done with an owner comment; dependents unblock; rollup).
   `PATCH after_key` already exists (cross-tree allowed).
5. Epic review (6): kind `epic_review` on the manager seat (grooming engine, Codex by default), read-only plus `desk consult`
   (one principal for the epic's area). Prompt: the tree with statuses, recorded and text blockers, open questions;
   return JSON { summary, next: {key, why}, dependencies: [{key, after}], owner_tasks: [{key, ask}], priorities:
   [{key, priority}], owner_question, close: [{key, why}] }.
   - Applied automatically (safe): dependencies (same tree, no cycles), priorities, owner-task marking, one
     consolidated owner question as a comment on the epic.
   - Proposed to the owner (never automatic): closing tasks → an Inbox decision "Close N tasks?" with approve/reject.
   - Triggers: owner button ("Ask Morgan and Rowan to sort this"), and automatically when 2+ tasks of one epic are
     parked on questions (at most once per epic per 24 h, after the questions are newer than the last review).
   - kv `epic-review:KEY` with revision/attempt fencing like feature plans.

## UI
- Feature page and epic Tasks tab: **Next step** card (the first actionable task in order and who acts, how many
  tasks wait on it), **Gates written as text** with one-tap "Make SD-32 wait for SD-29", owner-task actions, epic
  review status/result with its button.
- Tree rows: owner tasks tagged "Your task"; rows show "waits for X" for recorded and (dashed) text gates.
- Inbox: a question whose task waits on a blocker that itself needs the owner is grouped under the blocker card
  ("2 tasks wait on this"); owner tasks appear as "Your task"; epic close proposals appear as decisions.
- Grooming panel for a feature with tasks but no Codex plan: "Split by the manager" with its tasks and the epic-review
  button, not "Plan with Codex".

## Tests
flow.js (blockers, text gates, critical path, waiting-on), scheduler skips owner tasks and ancestor-blocked tasks,
create-task auto-records a single text gate and refuses an ambiguous one, owner-done unblocks dependents, epic review
parse/apply (safe applied, close proposed), Inbox grouping, browser: next-step card and one-tap gate on a fixture.
