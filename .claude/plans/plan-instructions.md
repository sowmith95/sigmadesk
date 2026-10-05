# Instructions: one front door on the Projects home, a tracker per request on each desk

## Summary
The owner types an instruction on the Projects home (hub, :8780), picks the repository, and lands on that desk's page
for the request, which shows where it is (received → planned → assigned to <engineer> → building → QA → review →
PR → merged → deployed), who is on it, what needs the owner, and the discussion. The hub also lists recent
instructions across all repositories with their current step. Everything reuses the desk's existing lifecycle
(triage, grooming/feature plans, balanced assignment, QA, reviews, merge train).

## Design
1. **Stages (pure, shared)** — `public/stages.js`: `stageOf(ticket, { tickets, plan, deploy })` → { steps: [{ id,
   label, state: done|current|todo|skipped }], current, who, needs_owner: { kind, text } | null, done: bool }.
   Steps: received (triage) · planned (proposed → todo; for a feature, plan approved) · assigned (assignee + reason) ·
   building (in_progress) · QA · code review (review / reviewing) · PR (ready_for_human / pr_url) · merged (done via
   merge) · deployed (merge sha released by the deploy lock; unknown → "deploy not tracked"). Epics: building =
   N of M tasks; the next-step card from flow.js. wontdo → closed (with reason). needs_human → owner item at the
   stage it stopped.
2. **Desk API** — `GET /api/requests?limit=` → owner-created tickets (reporter owner, newest first) with title, key,
   stage summary, updated_at. `POST /api/tickets` gains `kind: auto|task|feature` (auto → triage as today; task → a
   task in triage; feature → features.create, grooming with Codex) and `source: 'hub'`. Same for the classic desk.
3. **Deep link sign-in** — desk `/?token=…&next=%23%2Frequests%2FKEY`: after setting the cookie, redirect to
   `/` + next only if next matches `^#/[a-z]+(/[A-Z][A-Z0-9]*-\d+)?$` (no open redirect).
4. **Hub** — `POST /api/hub/instructions { project, text, kind, priority }`: validates (text 3–8000 chars, project
   known), starts the desk if offline (existing start) and waits ≤15 s for /api/summary, POSTs to the desk server-side
   with its token (title = first line ≤ 120 chars, description = full text), returns { key, url } where url is the
   desk deep link. `GET /api/hub/instructions` → recent requests from every online desk (≤ 20, merged by time) for
   the "Your instructions" list. Idempotency: client sends a `request_id`; the hub remembers the last 50 (id → key)
   so a double tap or retry never creates two tickets.
5. **Hub UI** (`ui/src/hub/HubApp.tsx`) — instruction box at the top: textarea ("What should the team do?"),
   repository chips (projects; default last used in localStorage; suggestion when the text names a project or repo),
   kind chips (Let the team decide / Quick task / Feature with a plan), priority, Send. On success: navigate to the
   desk url. Below: "Your instructions" with step chips and links. Mobile-first.
6. **Desk UI** — new `Requests` page (`#/requests`, `#/requests/KEY`): list of the owner's instructions with a
   compact stepper; the selected request shows the full stepper, who is on it and why (assign_reason), the owner item
   (answer / approve plan / merge) linking to the existing decision UI, next-step card for epics, and the
   conversation with the reply box (reuse TicketSheet's Conversation + Footer by opening the ticket sheet from the
   request, or embed). Nav entry "Requests" (desktop rail + phone More).

## Files
public/stages.js (new) · src/server.js (requests API, kind on create, deep-link next) · src/scheduler.js
(ownerCreate kind/source) · src/features.js (reuse create) · src/hub/server.js (instructions endpoints) ·
ui/src/hub/HubApp.tsx · ui/src/pages/Requests.tsx (new) · ui/src/app routing/nav · ui/src/types.ts · tests:
test/stages.test.js, test/hub.test.js (instructions with a fake desk), test/http.test.js (next redirect),
ui e2e (send from hub → lands on request; stepper shows step).

## Risks
- Open redirect / token leakage in the deep link: strict `next` pattern; token only in the first hop as today.
- Hub creating tickets on a desk: owner-token scoped, server-side only, idempotent by request_id.
- Desk offline: start + bounded wait, clear error if it does not come up.
- Stage mapping drift as the lifecycle evolves: one pure function with tests per status; unknown → "in progress".

## Revision after independent Fable and Codex reviews — first release
- Hub: composer (text, explicit repository chips, last used remembered; Options disclosure: "Let the team decide" or
  "Feature: plan it first", priority). Draft + request_id persisted until the desk confirms. Offline desk: show it and
  a Start button (existing start); never auto-start. Instruction POST refused without hub auth from a non-loopback
  client. Desk readiness = summary OK with the expected project id. No repository inference.
- Desk: `POST /api/tickets` with `request_id` is idempotent (kv request:<id> → { key, hash }); same id + different
  payload → 409. `kind` omitted keeps today's behaviour; 'auto'/'task' → task in triage; 'feature' → features.create.
- Deep link: `/?token=…&next=#/inbox/KEY` (strict full match) → 302 to `/` + next; tokenless desks link directly.
  Referrer-Policy: no-referrer on both servers.
- Tracker = projection in public/stages.js using the board's decisions (ticket and descendants), merge state, plan
  state, child tasks; statuses mapped per review (planned vs current engineer, design vs build, queued auto-merge,
  completed vs merged, epics, unknown status). No "deployed" milestone; "the deploy is running" only while the stored
  lock names this ticket. Shown as a compact current-state card at the top of the ticket sheet with the steps behind a
  disclosure; the decision and conversation stay where they are.
- Hub "Your instructions": from each desk's /api/summary recent_requests (≤5, created_at order), keyed by
  project + key, offline desks named.
- Deferred: Requests page on the desk, deploy ledger, one-time sign-in handoff, durable hub queue.
