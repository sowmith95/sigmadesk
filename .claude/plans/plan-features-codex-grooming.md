# Plan: Features page, Codex grooming sessions, GitHub link, conversation fixes and polish

## Summary
The owner wants one shared, readable place for features. Each feature is a document (goal, users, scope, acceptance,
risks, open questions) with its tasks underneath. Before any work starts, a grooming session with Codex turns the
request into a plan; the owner reads it, replies or edits, and approves; approval creates the tasks and work starts.
GitHub stays the outside shared space (sync is already on): an approved feature gets an issue whose body carries the
plan and a task checklist that stays current. Notion is not added: two sources of truth and data leaving the machine;
GitHub already gives outside read/edit. Also: fix the bugs in the ticket conversation and polish the look and feel.

## Data model (no schema migration; same kv pattern as product-review.js)
- A feature is a root ticket (`type='feature'`, no `parent_key`). The ticket `description` stays the source of truth
  that every agent prompt already reads.
- `kv feature-plan:KEY` = { ticket_key, revision, status: queued|grooming|ready|failed|approved|discarded,
  engine, model, run_id, direction (owner notes for this round), input_hash, plan, error, created_at, updated_at,
  approved_at, approved_tasks: [KEY…] }. Earlier revisions kept at `feature-plan:KEY:revision:N` (session history).
- `plan` (validated JSON from Codex): { summary, goal, users[], scope[], out_of_scope[], acceptance[], risks[],
  questions[], tasks: [{ ref, title, area, complexity S|M|L, risk high|low, after (ref|null), description, acceptance[] }] }
  Bounds: ≤8 tasks, string/array length caps, total ≤ 20 KB, refs unique, `after` must name an earlier ref.
- SSE event `feature-plan` (full value). Snapshot `meta.feature_plans` (all current plans; features are few).

## Server (new src/features.js + small hooks)
1. `features.js`: current/save/start(key,{direction,expected_revision})/next()/launch(p,fence)/complete/parsePlan/
   promptFor/approve(key,{revision, tasks})/discard/recover/holds(t)/approvedParent(t).
2. Grooming run: `runner.startRun({ agentId:'manager', kind:'feature_groom', engineOverride:'codex', … })`.
   - New `engineSelection(agentId, 'codex')` in dispatch.js: Codex seat clone of the manager (name Morgan, role
     Engineering Manager, engine codex, model = Codex default, effort high). If Codex is not ready, the run is refused
     with the reason (no silent fallback: the owner asked for Codex) and the plan goes to `failed` with Retry.
   - Read-only: add `feature_groom` to READ_ONLY_KINDS (team.js), codex `sigmadesk_review` permissions and no mailbox
     (engines/codex.js), deskAction refuses every desk command for this kind, runTimeoutMin.feature_groom = 25.
   - Charter for this kind: a grooming charter (runner.js charter switch) — read the code, then return ONLY one JSON
     object; never groom/split/reject via desk commands.
   - Prompt includes the ticket, last comments, previous plan revision + owner direction for follow-up rounds.
3. Scheduler tick: after discussions, `features.next()` → if manager idle and a slot is free, launch. Triage and
   manager groom pickers skip tickets that `features.holds(t)` (a plan exists and is not approved/discarded).
4. Approve (owner, conditional on revision; plan must be `ready`, ticket not done/wontdo, no unsettled children):
   in one transaction — rewrite the description's plan block (marker `<!-- feature-plan -->`, owner's request kept
   above it), create tasks (`status todo`, `parent_key`, area/complexity/risk, priority from the feature, assignee via
   routeTicket, reporter manager, `after_key` mapped from refs), set feature `in_progress`, assignee manager,
   progress_msg. Then GitHub: createIssue(feature) + createIssue(each task) + `updateIssueBody(feature)`.
   Owner may drop tasks or edit titles/complexity before approving (validated server-side).
5. rollupParent: also rolls up parents with an approved feature plan (not only principal epics), and calls
   github.updateIssueBody so the checklist ticks as tasks ship.
6. Product-review gate: slices of a feature whose plan the owner approved are not blocked by a missing/unapproved
   product review (the owner's approval is the plan gate). Existing product review stays available.
7. GitHub: `updateIssueBody(key)` rewrites the feature issue body (description + `- [x] KEY title` checklist), deduped
   via the existing marker; serial queue as today.
8. Routes: `POST /api/features` {title, goal, priority, area?} → ticket (`type feature`, status `proposed`, reporter
   owner) + plan queued. `POST /api/features/:key/plan` {action: start|revise|retry|approve|discard, message,
   expected_revision, tasks}. `PATCH /api/tickets/:key` gains `title`/`description` (requires expected_updated_at;
   409 on mismatch).

## UI
- Nav: Inbox, Work, Features, Team (primary); phone tabs Inbox, Work, Features, More.
- `#/features`: list of features as cards — title, state chip (Needs a plan / Grooming with Codex / Plan ready /
  Building n of m / Shipped), task progress bar, priority, GitHub issue link. "New feature" dialog: title, goal,
  priority chips; grooming starts on create.
- `#/features/KEY`: a readable document page. Left: request (editable, conditional save) and the plan sections.
  Right/below on phones: Grooming session — Codex status line (queued/running with live activity, model), rounds
  history (owner note → plan revision), reply box ("Ask Codex to change…"), task plan table with include toggles,
  editable titles, complexity chips, dependency hints; primary "Approve plan and start work". After approval: live
  task list (status, assignee avatar, progress); clicking a task opens the ticket panel at `#/features/KEY/TASK`.
- Router: `#/features/KEY[/TICKET]`.
- Command palette: Features entries + "New feature".
- Inbox: a ready plan is a decision card ("Plan ready: review and start").

## Conversation bugs (confirmed by reproduction on the preview desk) and fixes
1. Agent comments show twice (bubble + "Commented: …"): scheduler logs lowercase `commented:`; de-dup in
   public/conversation.js compares capitalised. Fix: case-insensitive match; fix the test that encodes the wrong string.
2. Questions show twice (❓ comment + "asked the owner:" event). De-dup same author within a few seconds.
3. Consults show four times (two events + two comments). Stop logging the events when the comments are written.
4. Design responses show twice (comment + manager's final say). Hide say events of owner_discussion runs that match.
5. No way to comment or message the manager while a decision is pending (footer returns early). Add "Comment" and
   "Ask the manager" to the decision footer (More menu + compose toggle).
6. Discussion status never appears in the thread; failures are silent and cannot be retried. Merge d.discussions
   into the timeline as a status row under the owner's message (Queued → Manager working → Response #N / Failed +
   Retry). Log an event on failure; add `POST /api/discussions/:id/retry`; cap requeues (3 attempts → failed).
7. Details lists the oldest four discussions, not the newest (byId re-sorts ascending). Show newest first.
8. Answered questions keep the amber "asks you" highlight forever. Highlight only the latest open question.
9. Literal `**` in question bubbles. Run the same cleaning/markdown as other text.
10. No markdown anywhere; URLs not linked; `clean()` strips code marks. Add a small safe markdown renderer
    (paragraphs, lists, bold, italics, inline code, code blocks, links with rel=noopener) keeping ticket chips.
11. "Show all" repeats the excerpt. Render excerpt OR full text.
12. Desk system messages ("Owner message routed…") attributed to Morgan. Use the system author.
Also fix: GitHub comments stored as author 'owner' render as "You" (store as github), tie-order by write order (id),
date separators for multi-day threads, a "New messages" pill when scrolled up, toasts not covering the composer,
dead ternary for the starting tab, "reply on the board" wording, GitHub/Desk avatars (icons not a dot).

## Look and feel polish
- Thread with three clear levels: dialogue (owner right, seats left, full bubbles), narration (agent "say" lines as
  compact muted rows grouped per run), system/GitHub events (one-line rows with an icon). Consecutive messages from
  the same author collapse the header; role/model shown once per group.
- Filter "Show" becomes chips (Everyone / You / Seats / Desk) instead of a native select.
- Taller thread area on phones; composer pinned; toasts at top on phones.
- Features document page uses a reading measure (max ~72ch), clear type scale, section anchors.

## Tests
- Unit: parsePlan bounds; approve creates tasks with after_key mapping and is conditional; holds() stops triage/groom;
  rollup for feature parents; engineSelection refuses when Codex is down; deskAction refuses feature_groom commands.
- HTTP: create feature → queued plan; approve conflict 409; PATCH description conditional.
- Browser: features list, new feature dialog, plan review and approve flow on the preview fixture (fixture seeds a
  ready plan), no overflow at 320 px, conversation renders markdown and links.

## Risks
- Codex quota: grooming is read-only and bounded (25 min, one run per round); failure is visible with Retry.
- Manager seat contention: grooming shares the manager seat queue with groom/discussions; it runs before new grooms.
- Description rewrite must not drop the owner's text: plan block is delimited by a marker and replaced only below it.
- GitHub body edits are outward: only for issues the desk created, through the existing serial queue, only when sync on.
