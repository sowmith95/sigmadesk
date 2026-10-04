# Plan: clear epic ↔ task links everywhere, repair split parents, and stop code review failing on Perplexity

## Summary
The owner cannot see which epic a task belongs to, or which tasks make up an epic.
- Tasks on Inbox, Work and the ticket panel show no parent.
- Epics are a flat list at the bottom of Work.
- Four parents (SD-28, SD-10, SD-9, SD-1) show "won't do" because the manager's old split rejected them, so their
  sub-epics (SD-30, SD-31, SD-18…) look top-level.
Separately, SD-26's code review never starts: the context reviewer is Morgan, whose seat runs on Perplexity, and Perplexity
cannot run `pr_review` ("manager: Perplexity (Computer) cannot run pr_review", the red "Error" in the status strip).

## Changes
1. Lineage (UI, shared):
   - `components/desk/Epic.tsx`: `lineageOf(key)` returns the root → … → parent chain (cycle-safe, max depth 8).
   - `<Lineage t/>` renders that chain as small clickable crumbs with an epic icon; a feature root opens its feature page.
   - Shown on every task surface: Inbox decision cards, Work cards, working rows, ticket panel header (above the title),
     PR rows when linked.
2. Epic tree (UI, shared): `<EpicTree root/>` is a nested list of tasks. Each row shows:
   - status tag, name, assignee avatar;
   - "waits for X" when ordered after another task, and a needs-you emphasis;
   - an indent guide per level.
   A progress bar counts leaf tasks (shipped, not doing, total).
3. Work page "Group by" chips: **Stage** (today's lanes) | **Epic**.
   - Epic view: one section per open root epic (header: name, state, progress, owner, feature link), its tree, then
     "Not in an epic" for standalone tickets; shipped or closed roots sit under a disclosure. The choice is persisted.
   - Stage view keeps the lanes, but every card shows its lineage. The bottom "Epics" list shows root epics only
     (sub-epics appear inside their root), each with its lineage and tree.
4. Ticket panel: a **Tasks** tab for any ticket with children (the tree), the lineage crumbs in the header, and epic
   progress in the header tags.
5. Feature page: the task list uses the same tree, so nested slices (SD-32 under SD-30) are visible.
6. Data repair (server, one-time, idempotent: kv flag `migration:split-epics:v1`):
   - Applies to `wontdo` parents with children whose last "Closed:" comment is the manager's and mentions "split".
   - If any task is open, the parent becomes `in_progress` (an epic, unowned); if all are settled, `done` when any
     merged, else stays `wontdo`.
   - Adds a system comment explaining why, then rolls up. Owner-rejected tickets are never touched.
7. Engine capability in selection (server):
   - `selectionFor(agentId, now, requirements, kind)` treats an engine that cannot run `kind` as unavailable for that job.
   - It then picks a capable engine (the seat's fallbacks, else the suggested tier on Claude/Codex) even when automatic
     fallback is off, because this is a capability problem, not an outage.
   - `startRun` passes `kind`; the scheduler's `go()` takes the job kind for its admission check (pr_review, respond,
     resolve, implement, qa), so admission and execution agree.
   - The fallback is logged on the run as today.

## Files
ui/src/components/desk/Epic.tsx (new), Bits.tsx, Work.tsx, pages/Work.tsx, pages/Inbox.tsx, pages/Features.tsx,
ticket/TicketSheet.tsx, ticket/parts.tsx, store.js (group-by), src/dispatch.js, src/runner.js, src/scheduler.js,
test/owner.test.js (repair + capability), test/ui-e2e.test.js (lineage + epic view), preview fixture (nested epic).

## Risks
- Fallback for capability could pick an engine the owner did not expect. It is logged on the run, limited to kinds the
  preferred engine cannot run, and still bounded by budget and QA gates.
- The repair touches live tickets once. It is limited to manager split-closures and recorded with a comment.
- Deep trees on phones: indentation capped at three levels; deeper levels show a "part of" crumb instead.
