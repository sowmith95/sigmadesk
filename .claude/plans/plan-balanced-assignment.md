# Balanced assignment: fit first, idle seats take work, scored by track record

## Summary
Today `routeTicket` (src/team.js) writes ONE seat onto a task at creation; the scheduler's todo picker
(src/scheduler.js ~773) launches only that seat and skips the task while it is busy, even when another capable
seat is idle. Live data (41 tickets): senior-be 14, junior 12, principal-be 11, senior-fe 3, principal-fe 1, dba 0.
Junior: 21/21 implement runs ok, 1.3 min, $0.83/run. Principal implement runs (3, explicit --assign on S/M tasks):
$8.25/run and 2/3 ok. Goal: a hybrid that keeps fit, removes idle waiting, learns from each seat's record, keeps
context where it matters, and shows the numbers.

## Design (6 steps the owner approved)
1. **Fit list, not one seat** — `candidatesFor(t)` in team.js returns ordered eligible seats:
   - db → [dba, senior-be]; L/XL or risk high → principal of the area (design flow, unchanged) then the other
     principal only for fullstack; S → [junior, senior-<area>] (+ other senior for fullstack);
     M → [senior-<area>] (+ other senior for fullstack) and junior when risk === 'low'; infra/backend = be side.
   - Disabled seats are removed; empty list falls back to the current routeTicket answer.
   - `routeTicket` stays (first candidate) for the "planned" assignee shown before pickup.
2. **Idle capable seat takes waiting work** — the todo picker asks `assign.pick(t, idleSet)` which scores only idle
   eligible seats; a busy preferred seat no longer blocks the task. Principals stay design-only.
3. **Score** (src/assign.js, pure, testable): `score = fit × quality × costFactor × quotaFactor × continuity`.
   - fit: 1.0 / 0.85 / 0.7 by candidate rank.
   - quality: Beta-smoothed first-pass QA rate for the seat (prior α=4, β=1 → 0.8), from tickets the seat built.
   - costFactor: seat's median cost per shipped task vs the team median, clamped [0.8, 1.2]; neutral with < 3 samples.
   - quotaFactor: engine five-hour use > 70% → 0.85, > 85% → 0.6 (from dispatch.providerHealth quota).
   - continuity: +10% if the seat built a sibling task in the same epic.
   - exploration: ~10% of picks, chosen deterministically by hash(ticket key + attempt), go to the eligible idle seat
     with the fewest builds in the last 14 days, so every fit seat keeps fresh stats. Never for risk high.
   - Stats computed in src/team-stats.js from runs + tickets + events, cached 5 min.
4. **Sticky where context matters** — a task with a builder (`t.builder`), commits (`head_sha`) or `qa_loops > 0`
   goes back to its author; QA fixes, review responses (`respond`) and conflict resolutions already follow the
   author/builder. Handover: if the author is busy and the task has been back in todo > 30 min, another eligible idle
   builder may take it (records a contributor; review independence already excludes contributors).
   Explicit pins win: `--assign`, owner PATCH assignee → `assign_pinned = 1` (only that seat).
5. **Stats + reasons** — `GET /api/team/stats`, also in /api/state meta (`team_stats`): per seat shipped,
   first-pass QA %, review rounds (respond runs per shipped task), median cycle time (first implement start → first
   done event), cost per shipped task, busy % over 7 days, builds in 14 days. Each pick stores `assign_reason`
   ("Junior: idle, fits S backend, 21/21 first-try QA" / "Taken by Sam: Jordan busy"), shown on the ticket and in
   the pickup event. Team page: a stats table (cards on phones), with "few samples" badges below 3.
6. **Rule fixes** — junior eligible for M low-risk; an `--assign principal-*` on an S/M task that is not high risk
   is routed to a builder instead (principals design; a comment says so); principals never implement.

Setting `assign_mode`: `balanced` (default) | `fixed` (today's behaviour), on the Team page.

## Files
- src/team.js: candidatesFor, routeTicket unchanged (first candidate), principal guard helper.
- src/assign.js (new): pick(t, ctx) pure scoring with reasons; exploration; stickiness/handover rules.
- src/team-stats.js (new): stats from the DB, cached.
- src/db.js: tickets columns assign_pinned INTEGER DEFAULT 0, assign_reason TEXT; TICKET_FIELDS.
- src/scheduler.js: todo picker uses assign.pick; create-task --assign pin + principal reroute; ownerPatch assignee
  pins; launchImplement records assign_reason in the pickup event.
- src/server.js: /api/team/stats, meta.team_stats, settings key assign_mode.
- ui/src/pages/Team.tsx: stats section + mode switch; ui/src/ticket (Details) shows assign_reason; types.
- test/assign.test.js (new), extend test/owner.test.js where pickup behaviour changes.

## Risks
- Small samples: priors + neutral factors under 3 samples; exploration capped; risk-high never explored.
- Work stealing could put an M task on a weaker seat: junior only for M with risk low; fit factor dominates.
- Stats queries cost: cached 5 min, computed off the tick path when stale.
- Behaviour change surprise: `fixed` mode restores today's routing instantly.
- Deterministic tests: pick() is pure (inputs: ticket, idle seats, stats, quota, now, random seed by hash).

## Revision after Codex review (2026-10-04)
- **Two phases.** A task whose planned seat is a principal (or that has no assignee and routes to one) keeps the
  design path unchanged. Every other task is a build job choosing among `builderCandidates(t)`: builders only, never
  principals, and risk never escalates (principal slices inherit risk high and must stay buildable). If no candidate
  is enabled the task is blocked; it never falls back to a disabled seat.
- **Precedence:** workflow gates → valid pin → author keeps rework → launchable candidates by score.
  Launchable = idle AND job-specific `selectionFor(seat, now, null, 'implement').seat` AND no setup hold AND budget.
  The picker tries candidates in score order through `go()` until one is admitted; an admitted seat leaves this
  tick's pool. Quota uses the effective engine from selectionFor (including fallback).
- **No automatic handover in this release.** Rework (commits, builder, QA loops) stays with its author, as today.
- **Pins:** set by create-task/groom `--assign`, a principal's `--assign`, and an owner PATCH of the assignee;
  clearing the assignee clears the pin. An owner may not reassign a task that has a run (409).
  `stillWanted` requires `assignee === agentId` for implement starts.
- **Stats from real facts:** first-try QA = the first QA verdict event per ticket ("QA passed/failed KEY" by qa),
  counted for every ticket that reached QA, abandoned ones included; shipped = merge event, excluding owner tasks
  and epics; cycle = first implement start → merge event; cost = measured run cost only (estimated runs excluded,
  counted separately). Grouped by size cohort (S vs M+) so juniors' S work and seniors' M work are not compared
  directly; every metric carries its denominator; `as_of`.
- **Scoring is defined and bounded:** rank prior 1.0 / 0.9 / 0.8; quality = shrunk first-try rate in the task's
  cohort ÷ 0.8, clamped [0.85, 1.15]; cost ratio team ÷ seat in cohort, clamped [0.9, 1.1], neutral under 3 shipped;
  quota 1 / 0.85 / 0.6; continuity 1.05. Ties: rank, then seat id. A lower-ranked seat wins only with a materially
  better record or when the preferred seat's engine is near its limit.
- **Exploration** only for fresh, unpinned tasks that are S or explicitly low risk, never high risk; decided once per
  ticket by hash of its key; build counts get a per-tick overlay.
- **Contention:** within a priority, tasks with fewer launchable candidates go first.
- **Fixed mode** = the legacy path exactly (`assignee || routeTicket`), for future pickups.
- Health/waiting reasons come from the same pick so the UI explains the actual decision.
