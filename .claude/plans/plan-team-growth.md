# Team growth: report cards, mentoring lessons, model trials, capacity suggestions

Builds on balanced assignment (src/assign.js, src/team-stats.js). The owner asked: grade engineers, replace weak
ones with newer or different models, make ratings transparent, and let the team mentor each other and improve.

## Principles
- A seat = role + charter + model + the work it gets. Grades compare like with like (size group, area) and carry a
  confidence range; nothing acts on a small sample.
- No automatic firing. The desk proposes; the owner approves model changes. History keeps every model a seat ran on.
- Mentoring must change what later runs read: lessons injected into prompts, measured, removed if they do not help.
- Transparency for the owner (Team page). Rankings never go into agents' prompts (avoids gaming); lessons do.
- Discussion happens at events (a setback, a monthly review), not as constant chatter.

## 1. Report card (per seat, per size group)
- Extend team-stats: Wilson 80% intervals for first-try QA; per model/provenance (runs.provenance, runs.model) so a
  model change starts a new record; failure reasons.
- QA failure reasons: `desk qa fail` gains `--reason bug|tests|spec|base|flaky` (required, default bug). Stored on the
  verdict event (`QA failed KEY [reason]`). "spec" and "base" failures do not count against the builder; "spec"
  counts against the groomer (manager) in its own card ("tasks sent back for unclear requirements").
- Team page: card per seat with grade bands (above / in line / below team, only when intervals separate), history
  of models with dates.

## 2. Lessons loop (mentoring)
- New table `lessons` (id, area, scope seat|team, text ≤ 300 chars, source_ticket, author, mentor, status
  proposed|active|retired, created_at, activated_at, retired_at, uses, before_rate, after_rate).
- Trigger: a QA failure (reason bug/tests) or review changes → a short `retro` run (cheap model, read-only) by the
  author with the QA/reviewer comment; it proposes ONE lesson. The area principal (or QA for tests) approves or
  rewrites it in a `mentor` step (desk lesson approve|reject). Cap: one retro per ticket, budget-limited.
- Active lessons for the task's area are appended to implement/respond prompts ("Team lessons"), max 8, newest
  first. Lessons record first-try QA in that area before/after activation; after 10 tasks a lesson that did not help
  is proposed for retirement. Owner can edit/retire on the Team page.

## 3. Review and trial (model changes with owner approval)
- Monthly, or when a newer model is detected for an engine (engines' model catalogs), or when a seat is below the
  team with ≥10 first verdicts in a size group and the intervals do not overlap → a `trial` proposal in the Inbox:
  "Try <model> for Riley on small tasks: 10 tasks, side by side".
- Approved trial: the exploration slot routes a share (≤30%) of that seat's eligible tasks to the candidate model
  (same seat, same charter, runs.model records it) until 10 first verdicts, or 14 days.
- Result card: old vs new (first-try QA, cost per shipped, cycle time, review rounds) with intervals; owner chooses
  keep / switch / extend. Switching updates the seat's model in team settings; history records the change.

## 4. Capacity suggestions
- From the waiting time of build tasks per candidate set over 14 days: if tasks waited > 30 min for a fully busy
  set on > 20% of pickups, suggest adding a seat (e.g., a second junior) in the Inbox; owner approves through the
  existing team settings. Never automatic.

## Files
- src/team-stats.js (intervals, per-model, reasons), src/lessons.js (new), src/trials.js (new), src/db.js (lessons,
  trials tables), src/scheduler.js (qa --reason, retro/mentor jobs, trial routing), src/team.js (prompt section),
  src/runner.js (charters), bin/desk (qa --reason, lesson approve/reject), src/server.js (routes), public/attention.js
  (trial/capacity decisions), ui Team page (report cards, lessons, trials), tests.

## Risks
- Retro/mentor cost: cheap model, one per ticket, daily cap. Lessons bloating prompts: cap 8, 300 chars each.
- Gaming: agents never see grades; QA reasons are given by QA (independent), not the builder.
- Trials split work and lower throughput briefly; capped share and duration.
- Model catalogs may not expose release dates; detection falls back to "model id not seen before".

## Revision after independent Fable and Codex reviews (2026-10-04) — this release
Both reviews: measure outcomes properly first; "inconclusive"/"too early", never a fake "in line"; compare with the
rest of the team; lessons in prompts (not charters/provenance), owner-managed, measured by recurrence; defer trials
(need a durable per-task execution profile), automatic proposals, capacity, newer-model detection, retro runs.

Release A (now):
1. **Structured QA verdicts** — table `qa_verdicts` (ticket, run, sha, verdict, reason, lesson_id, builder, model,
   complexity, area, ts), written in the same step as the verdict. `desk qa fail --reason bug|tests|spec|base|flaky`
   required for new failures; history backfilled from events as `unknown`. `--lesson ID` marks a repeat of an active
   lesson. Attributable failures: bug, tests, unknown. spec/base/flaky are shown but excluded from the seat's rate.
2. **Report cards** — per builder and size group: attributable first-try QA with n and Wilson 80% interval; band vs
   the rest of the team (difference interval, Newcombe): "too early" under 15, "above"/"below" only when the
   difference interval excludes 0, else "inconclusive"; excluded failures by reason; per model the seat ran on.
   Assignment scoring uses the attributable rate. Builders only (other roles need their own measures).
3. **Lessons v1** — table `lessons` (+ `lesson_exposures`). A builder proposes during a fix run:
   `desk lesson "<≤300 chars>"` (max 2 per ticket, deduped). The owner approves/edits/rejects/retires on the Team
   page (no Inbox item per lesson). Active lessons (≤5: same area first, then general; most-repeated first) are
   appended to build prompts in ONE place (runner, for implement/respond/resolve), not the charter, with the author's
   name; QA sees active lessons with ids to cite. Exposures recorded per run; repeats counted from QA `--lesson`.
Release B (queued, needs its own review): owner-started model trials with durable per-task allocation and a
per-job execution profile; monthly manager team note; queue-wait instrumentation before any capacity advice.
