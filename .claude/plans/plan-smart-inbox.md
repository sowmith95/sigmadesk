# Smart Inbox: lanes by impact, a priority score, compact rows, grouping, snooze, inline priority

## Problem (live data, 2026-10-05)
17 items: 6 owner tasks (some 16 h old), 4 merges, 3 research proposals, 1 plan, 1 product review, 1 publish guard,
1 question. Order today = kind rank then age (public/attention.js board()): ticket priority (P0–P3) is ignored and not
shown; items of one epic are scattered (SD-28 has 3 owner tasks); every item is a tall card (~200 px on a phone), so 17
items are a long scroll; nothing can be set aside.

## Product thinking (owner jobs)
1. "What is the team waiting on me for?" — a seat or a pipeline is blocked until I act (question, guard, plan ready,
   design/council/epic review, product review, page). Highest.
2. "What is ready to ship?" — merges / publishes: batchable, quick.
3. "My own to-dos" — owner tasks: they need real time; often planned, not done instantly.
4. "When I have time" — research proposals: optional, the team is not blocked.
A single ranked list mixes these jobs; lanes match how the owner works, and inside each lane a score orders by what
matters (priority, how much waits, age).

## Design
1. **Lanes** (public/inbox.js, pure): `unblock` (question, guard, plan, design, council, epic_review, product, page),
   `ship` (merge, publish), `mine` (owner_task), `later` (research). Each lane has a one-line purpose and a count.
2. **Score inside a lane**: priority weight (P0 100, P1 60, P2 30, P3 10) + 15 × tasks waiting on it (flow.waitingOn
   + grouped `waiting`) + age (2/h, capped 48) + 20 if risk high in `ship` (needs care) … ties by age. Each row shows
   the why in words: "P1 · 3 tasks wait · 16 h".
3. **Compact rows by default**: one row per item: kind icon/tag, title (one line, truncates), epic crumb, chips
   (priority, waits, age), primary action button; tap the row to expand the reason (current card body). "Comfortable"
   density toggle keeps today's cards (localStorage).
4. **Group by**: Lane (default) · Epic (items of one feature together, epic header with progress) · None (one ranked
   list). Chips at the top double as filters: "3 unblock · 4 ship · 6 mine · 4 later".
5. **Snooze ("Later")**: per decision, 4 h / tomorrow 9:00 / next week; stored server-side (kv `snooze:<decision id>`
   → { until }) so phone and laptop agree; snoozed items move into a "Snoozed (n)" fold and are excluded from the
   needs-you count; they return automatically, or earlier if the decision changes (new id). Never snooze guard/page
   (they protect production) — the menu does not offer it.
6. **Priority inline**: a row menu sets P0–P3 on the ticket (existing PATCH priority); the score and order update live.
7. **Side column** keeps Working now / Blocked; on phones it moves below.

## Files
public/inbox.js (new: lanes, score, grouping, snooze filtering) · public/attention.js (counts exclude snoozed, if
snoozes are passed) · src/server.js (GET in state meta.snoozes, POST /api/inbox/snooze { id, until | null }, prune
expired) · ui/src/pages/Inbox.tsx (rewrite: summary chips, lanes/epics/none, compact rows, density, snooze + priority
menus) · ui/src/types.ts · tests: test/inbox.test.js (score/lanes/grouping/snooze), ui-e2e (compact rows fit a phone,
group by epic, snooze hides and returns, priority change reorders), update existing e2e selectors (article[data-kind]).

## Risks
- Hiding things the owner must see: guard/page never snoozable; snoozed count shown; expiry automatic.
- Existing tests/screens rely on `article[data-kind=…] h3 button` — keep data-kind/data-ticket/data-key on rows.
- Score tuning is subjective: weights in one place, explained on every row, easy to change.
- Shell counters (Rail / MobileTabs) use counts.needs_you: must match the visible (unsnoozed) count.

## Revision after independent Fable and Codex reviews (v1 to build)
- Contract (attention.board): `decisions` = every unresolved decision; `needs_you` = active grouped rows; `snoozed` =
  deferred grouped rows; counts.needs_you = active, counts.snoozed. Trackers/sheets keep using `decisions`.
- Order without a weighted score: "Do first" = the first active row by (urgent: guard/page/P0 → first), lane
  (Unblock the team → Review to ship → Your tasks → Proposals), priority, unique tasks waiting (ticket keys unioned
  from flow.waitingOn and folded questions), waiting since (oldest first), id. Rows explain it in words.
- `waiting_since`: first time the desk saw each decision id (kv inbox:since, pruned), so priority edits do not reset age.
- Snooze: kv inbox:snoozes { id: { until, version, at } }, served in meta.snoozes; POST /api/inbox/snooze validates
  the id is a current decision, refuses protected ones (guard, page, anything linked to an incident), until in the
  future and ≤ 30 days. A row wakes when `until` passes or its decision version changes (status, commit, QA loops,
  review round, progress message). A snoozed row keeps its folded questions (stated in the menu). Bus delta → UI.
- Compact rows: kind tag, one-line title, crumb + lane fact (CI/reviews/merge state for ships, seat for questions,
  reviewer reason for proposals), chips (priority when not P2, "3 tasks wait", waiting time, time hint), primary
  action; a separate expand button shows the reason/waiters; ⋯ menu: Snooze (exact wake time shown), Priority P0–P3,
  Hand back (owner tasks). Your tasks / Proposals collapsed by default (remembered). Status strip: "n need you ·
  m snoozed"; empty state "Nothing due now · m snoozed".
- Cut: weighted score, density toggle, Inbox epic/none grouping (Work has it), bulk merge. Deferred: wake reminders
  via notify (needs a scheduler hook), dedicated table.
