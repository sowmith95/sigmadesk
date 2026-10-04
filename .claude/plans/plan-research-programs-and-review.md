# Plan: configurable research programs, market-hours windows, connector access, and a second-person review gate (plus a new product name)

Date: 2026-10-04. Repo: sigmadesk (Node 22+, ESM, node:test, no dependencies). Owner request:
"who on the team researches should be configurable, how frequently, whether during market hours, which research papers /
connectors / tools they have access to; independent research must be reviewed by at least one more person; and a better
application name."

## Summary of today

- Only the PM seat has the `research` kind. One global cadence (`pm_interval_min` setting, default from
  `config.pm.intervalMinutes`), gated by "proposals below `max_open_proposals`" and an idle PM. Manual start via
  `POST /api/control/research` with a free-text focus.
- Research tools: `TOOLSET.research` = Read/Grep/Glob/Bash/TodoWrite + WebSearch/WebFetch. Web tools run outside the OS
  sandbox, so the design confines them to the research kind. Every seat gets `--strict-mcp-config --mcp-config {}`:
  no MCP connectors at all (the Perplexity engine swaps in exactly one server, its own).
- Output: `desk propose` creates tickets with status `proposed`; the manager grooms them in the very next tick. Nothing
  reviews a proposal between the researcher and grooming. Product review (plan phase) happens later, before
  implementation, and includes the PM (the author) as a reviewer.
- `limits.busyWindow` already models a market-hours window (timezone, days, start, end) for capacity.
  `scheduler.inBusyWindow(d, w)` returns false unless `w.enabled` is set, so it cannot be reused as-is: extract a pure
  `inWindow(d, w)` and let `inBusyWindow` apply the enable flag.
- `desk propose` is authorized by seat (`PERMS.propose = ['pm']`), not by run: today the PM could propose from a consult
  run. `permissionsFor` adds `Bash(*)` for every kind except triage/product_review when the sandbox is on, and
  `sandboxSettings` allows workspace writes for all kinds except product_review: "read-only tools" alone do not make a
  read-only reviewer. The active UI is `public/v2.js`; `app.js` is the Classic page. `bin/desk` parses each verb.

## Design

### 1. Research programs (`src/research.js`, new)

Config (`config.research`), overridable from the UI through a `research_programs` JSON setting validated atomically
like team overrides:

```js
research: {
  marketHours: { timezone: 'America/New_York', days: [1,2,3,4,5], start: '09:30', end: '16:00' },
  // Owner-defined allowlist. Never imported from ~/.claude.json. stdio or http, passed verbatim to the engine.
  connectors: { 'paper-search': { type: 'stdio', command: '…/.venv/bin/python3', args: ['-c', '…'] , note: 'arXiv/PubMed/Semantic Scholar search' } },
  programs: [{
    id: 'product-discovery', label: 'Product discovery', seat: 'pm', enabled: true,
    intervalMinutes: 720, window: 'any',            // 'any' | 'market' | 'off-market'
    focus: '',                                      // standing focus text appended to the research prompt
    tools: { web: true, connectors: [] },           // connector names from research.connectors
    maxProposals: 3,
    review: { minReviewers: 1, reviewers: ['trading-advisor', 'quant-research', 'principal-be'] },
  }],
}
```

- Backward compatibility: `openDb` seeds every setting, so absence needs a sentinel: `research_programs` is seeded as
  the literal `""` meaning "derive from config.pm + pm_enabled/pm_interval_min/max_open_proposals"; once the owner
  saves programs, the JSON wins and the legacy rows become read-only mirrors of the default program. The default
  program's cadence counts untagged legacy PM research runs. Deleting or editing a program never changes gated tickets:
  the review policy is frozen on the ticket at proposal time. `/api/settings` rejects `research_programs` (the
  dedicated validated endpoint is the only write path) and startup validates the stored JSON, falling back to config
  with a logged problem if it is malformed.
- Eligibility to run (`research.due(program, now)`): program enabled, seat enabled and idle, seat's engine supports
  `research` (Perplexity does; builders never do), `window` satisfied by `inWindow(now, config.research.marketHours)`,
  `intervalMinutes` elapsed since the program's last run (new `runs.program` column), proposals below
  `max_open_proposals`, budget headroom, a free slot. Manual "Run now" bypasses cadence and window but not budget/capacity.
- Per-job capabilities instead of mutating seat kinds: `supportsSeat` checks every kind a seat has, so adding kinds to
  a seat can silently disable its Perplexity engine. A program's seat is validated per job: engine supports `research`,
  and the job's requirements (web, connectors) are satisfiable by that engine. `dispatch.selectionFor` takes the job
  requirements and provider fallback cannot pick an engine that drops them; `startRun` revalidates right before spawn.
- Tools: `permissionsFor('research', cwd, { web, connectors })` includes WebSearch/WebFetch only when `web` is true and
  adds explicit `mcp__<name>__<tool>` allow rules for the approved tools of each approved connector (never the whole
  server). `claude.command` gains an `mcpServers` option; the config passed to Claude holds only transport fields
  (type, command, args, url), no application metadata, and it is written to a 0600 file in the run directory rather
  than inline argv so headers or tokens never appear in process lists or snapshots. Connectors are Claude-engine only in
  v1 (the Perplexity relay keeps exactly one server; the desk-owned Codex home has none). A program that selects
  connectors or web on a seat whose engine cannot carry them is rejected on save, and a live provider fallback that
  would drop them is refused instead of silently degrading.
- Prompt: a research charter independent of the PM persona names the program, its standing focus, approved sources,
  the connectors available and what each is for, and the proposal allowance. Authorization is by run, not seat:
  `desk propose` is accepted only from a `research` run carrying server-owned program metadata, and the run's
  `maxProposals` allowance plus the global room are reserved at launch and enforced server-side on every `propose`.
  The ticket is stamped `source='research'`, `research_program`, the frozen review policy (JSON) and `research_review='pending'`.
- Sources ("which research papers"): a program lists approved sources (domains, journals, repositories such as arXiv,
  SSRN, FRED, or named internal documents). The prompt requires every Evidence bullet to cite a URL or source id from
  that list; the desk extracts citations into `tickets.research_sources` for the reviewer, and connector-only evidence
  must be quoted in the proposal because reviewers have no connectors.

### 1b. Connector governance: propose, assess, approve, measure (`src/connectors.js`, new)

A connector is never just added. Owner requirement: adding one must be justified by how it helps the application, how
it does so, what it costs in money and time, and which part of the SDLC it improves; then it is approved; only then
it is available to programs.

- Registry (`connectors` table, replacing the plain `research.connectors` config map; config may seed entries as
  `proposed`): `name, status (proposed|assessed|approved|rejected|retired), purpose, case (markdown), binding (JSON:
  type stdio|http, command/args or url, env names only), proposed_by, assessed_by, assessment (JSON), approved_by,
  approved_at, review_after, created_at`. Only the owner may write a `binding` (executables and URLs never come from a
  seat), and `env` holds variable names the service resolves at launch; values are never stored or shown.
- The case template (required sections, validated like the knowledge-sync note):
  `## Purpose` · `## Benefit to the application` (which programs or seats, what they could not do before) ·
  `## How it is used` (which tools, in which run kinds, read-only or not) · `## SDLC stage improved`
  (discovery, design, implementation, QA, review, operations; the measurable effect expected) ·
  `## Cost` (pricing or credits per call, expected calls per run, monthly estimate; local compute) ·
  `## Time` (setup effort, per-run latency, maintenance) · `## Data leaving the machine` · `## Risks and fallback`
  · `## Success measure` (how we will know in 30 days it earned its place).
- Proposal paths: a thinking seat (PM, manager, principals, quant-research) runs
  `desk connector-propose --name <slug> <<EOF …case… EOF` from a research or design run; or the owner files the case in
  the UI. Seats cannot propose a binding, only the case.
- Assessment: one `connector_assessment` run by a seat other than the proposer, chosen by domain (principal-be for
  engineering tooling, trading-advisor or quant-research for market/data sources), read-only tools plus WebFetch to
  verify pricing and terms. Verdict `desk connector-assess <name> recommend|decline "<notes>"` with a structured
  JSON (benefit score 1-5, cost estimate, time estimate, SDLC stage, risk, conditions). Stored on the record.
- Approval: owner only, in the UI, after the assessment exists. The owner supplies or confirms the binding and sets
  `review_after` (default 30 days). Approval logs an event; rejection stores the reason. `approved` is the only status
  programs may reference; saving a program with a non-approved connector fails atomically.
- Measurement: `runs.connectors` records which connectors a run had. The connector sheet shows uses, the research
  proposals those runs produced, how many passed the second-person review, and the run cost, so the 30-day review has
  numbers. Past `review_after`, the UI flags "re-evaluate"; the scheduler does not auto-retire.
- Isolation (Codex review, critical): a stdio connector is a trusted host extension. It runs outside the OS sandbox
  with the user's filesystem and inherits the Claude process environment, including `DESK_RUN_TOKEN` and `DESK_SOCKET`.
  v1 policy: `http` bindings are the default recommendation; a `stdio` binding is allowed only when the owner approves
  it with the case stating that it can read local files, the desk wraps its command as
  `/usr/bin/env -u DESK_RUN_TOKEN -u DESK_SOCKET -u <secret-named vars> -- <command>`, and each connector lists the
  tool names it is approved for. Separate process isolation for stdio servers is out of scope and recorded as such.
- Permission wiring: `permissionsFor` and `claude.command` take approved connector records (name, binding, tools),
  never names resolved from config at run time; `runs.connectors` records what the run actually received.

### 2. Second-person review gate (`src/research-review.js`, new; run kind `research_review`)

- A `proposed` ticket with `research_review='pending'` is invisible to grooming (scheduler step 4 skips it) until
  `minReviewers` distinct reviewers, none of them the author seat, have passed it. Reviewer order prefers a seat whose
  engine/model family differs from the author's (independence), then the configured list order.
- Reviewer run (`research_review`): genuinely read-only, handled explicitly in `permissionsFor` (no `Bash(*)`),
  `sandboxSettings` (no workspace writes, no auto-allowed Bash, like product_review) and `deskAction` (allowlist:
  `show`, `list`, `context-file` only). WebFetch/WebSearch only when the program allows web, so citations can be
  checked; no connectors. The verdict is the run's structured final output (JSON: verdict pass|changes|reject,
  evidence checked, findings, conditions), parsed and validated by the desk like product-review reports. This avoids a
  mutating desk command, works for Codex (no mailbox) and Perplexity (add `research_review` to its THINK_KINDS).
- Durable, versioned state: `research_reviews` rows carry `ticket_key, generation, input_hash, assignment_id, reviewer,
  run_id, verdict, report, created_at`. A verdict is accepted only for its own assignment and the ticket's current
  generation (title/description hash), one per assignment, in a transaction. Revisions open a new generation; old
  judgments are kept for history but never count toward the current quorum. `launch()` receives an outcome predicate
  ("this assignment has a verdict") so a first pass under `minReviewers: 2` is not misread as a stall.
- Outcomes: all required passes → `research_review='passed'` (groomable). Any `changes` → remaining assignments are
  cancelled and one bounded revision runs as kind `research_revision` (distinct from `research`, so it neither
  advances the program cadence nor counts against discovery quota); that run may only `desk revise <KEY>` its own
  ticket (title/description), which opens a new generation and new assignments. A provider failure or interruption does
  not consume the revision allowance; a second `changes` → `needs_human` with `resume_status='proposed'` and a
  dedicated owner decision (approve for grooming / send back / reject), not the generic "answer and continue".
  Any `reject` → `needs_human` the same way. Owner waiver is the only bypass and is audited (`reviewer='owner'`).
- The gate is one shared function, `researchReview.blocks(t)`, checked in grooming, `create-task` from a gated parent,
  implementation dispatch, `ownerPatch` status moves and `ownerReply` resumes. Existing `source='pm'` proposals are
  grandfathered (not gated). Human-filed and triage-routed proposals are untouched. Product review still runs later.
- Capacity: research reviews and revisions share the product-review allowance (two concurrent, one slot preserved for
  QA/SRE) and are scheduled ahead of new discovery; due programs rotate by oldest last run so list order cannot starve
  a program. If no eligible reviewer exists (all disabled/unavailable) for longer than the program interval, the ticket
  goes to `needs_human` with that reason instead of waiting forever.

### 3. UI and API

- Both UIs (`public/v2.js` is the active page, `app.js` Classic) plus the shared attention model: Settings → "Research" replaces the three PM rows: a programs table (seat, cadence, window, web/connectors, proposals,
  reviewers, enabled, last run, next eligible, "Run now" with optional focus) and an editor sheet; connector list with
  notes; market-hours display. Board/ticket sheet: "Research review: 0/1 · awaiting <seat>" badge, verdict history,
  "Waive review" (owner).
- API: `GET/PUT /api/research/programs` (validate all-or-nothing), `POST /api/research/programs/:id/run {focus}`,
  `POST /api/tickets/:key/research-review/waive`; connectors: `GET /api/connectors`, `POST /api/connectors` (owner case),
  `POST /api/connectors/:name/assess` (queue assessment), `POST /api/connectors/:name/approve {binding, review_after}`,
  `POST /api/connectors/:name/reject {reason}`, `POST /api/connectors/:name/retire`. `/api/control/research` keeps working.

### 4. Product name

A decision for the owner; the rename is mechanical once chosen. Scope v1: product string in `team.js` DESK_RULES,
UI title/manifest, README heading, `package.json` name/bin alias (keep `sigmadesk` as a bin alias one release), docs.
Keep the `desk` CLI, internal module names, the GitHub repo name, the launchd label, `sigmadesk.config.json`, the `SIGMADESK_*` environment variables and database/socket paths unless separately migrated; test both bin aliases. Candidates:

| Name | Why it fits | Caveat |
|---|---|---|
| **Bookrunner** | the lead bank that coordinates a syndicate: the desk coordinates seats, reviewers and councils | finance jargon |
| **Quorum** | nothing ships without independent checks: two reviewers, councils, this review gate | common word, several dev tools use it |
| **Pit Desk** | the trading pit's supervising desk | "pit boss" casino connotation |
| **Sigma Floor** | keeps the sigma, "floor" = trading floor full of seats | close to current name |
| **Riskdesk** | small risk-limited bets, everything measured | sounds like a compliance product |

Recommendation: Bookrunner (distinctive, matches the coordination role) or Quorum (matches the review culture).

## Files

- `src/config.js` — `research` block + validation (programs, windows, connectors shape, reviewers exist, seat exists).
- `src/research.js` — programs (merge config + setting), `due()`, `inWindow` reuse, next-eligible, launch helper, settings validation.
- `src/research-review.js` — gate state, reviewer selection, verdict handling, revision bound, waive.
- `src/connectors.js` — registry, case validation, assessment run, approval, usage metrics.
- `src/team.js` — kinds union for program seats; `permissionsFor('research', cwd, opts)`; `research_review` permissions; prompts for `research` (program-aware) and `research_review`; desk CLI help lines.
- `src/engines/claude.js` — `mcpServers` option on `command()` (0600 config file, transport fields only); `src/engines/perplexity.js` — `research_review` in THINK_KINDS; `src/dispatch.js` — job requirements in `selectionFor`.
- `bin/desk` — parse `propose --program`, `revise`, `connector-propose`.
- `src/runner.js` — pass program tool options to `permissionsFor` and the engine for `research`; `research_review` nonce.
- `src/scheduler.js` — tick: per-program research launch, research-review launches, grooming skip; `deskAction`: `propose` stamping, `research-review`, `revise`.
- `src/db.js` — `tickets.research_program`, `tickets.research_review`, `tickets.research_revisions`, `runs.program`, `runs.connectors`; `research_reviews` and `connectors` tables.
- `src/server.js` — endpoints above; snapshot includes programs and gate state.
- `public/v2.js`, `public/app.js`, `public/attention.js` — Settings research section, connector sheet, ticket badge/actions, attention items for research holds.
- `test/research.test.js`, `test/connectors.test.js` — new; existing suites stay green. Cases from the review: authorization by run kind (PM cannot propose from consult; non-PM researcher can from its research run; reviewer cannot mutate), admission (two programs sharing a seat, manual vs scheduled, stop-all during preparation, fallback during preparation refused), proposal caps under concurrency, review lifecycle (quorum two, duplicate verdict, author verdict, stale-generation verdict, changes racing a waiver), recovery (restart mid-review/mid-revision; provider failure does not consume the revision), engines (Claude read-only, Codex structured output, Perplexity packs), migration (legacy settings, sentinel, malformed JSON, generic settings bypass rejected, deleted program with gated tickets), windows (boundaries, DST, invalid timezone, overnight rejected), UI badges in both pages.
- `README.md`, `docs/research-programs.md`, `sigmadesk.config.example.json`.

## Steps

1. Schema + config + `research.js` (programs, windows, due) with tests for validation, window and cadence.
2. Connector registry, case validation, assessment run kind, approval/reject/retire, usage metrics; tests.
2b. Permissions/engine: approved connectors into `permissionsFor` and `claude.command`; tests on the generated argv.
3. Scheduler: per-program launches replacing the PM-only step; `propose` stamping.
4. Review gate module, `research_review` run kind, desk verbs, scheduler skip/launch, tests for pass/changes/reject/waive and reviewer independence.
5. API + UI. 6. Docs and config example. 7. Full suite, doctor. 8. Branch + PR-style merge as before. 9. Rename as a separate commit once the owner picks a name.

## Risks and considerations

- Seeded connectors (paper-search, knowledge-hub, …) start as `proposed` with a drafted case; nothing is usable until the owner approves it, so day one behaviour equals today's (web only).
- Connectors run outside the OS sandbox as Claude Code subprocesses with network access. They are the same trust level
  as WebSearch today; hence owner-defined only, research kind only, never for builders, and documented plainly.
- A second review per proposal costs a run; with `minReviewers: 1` and read-only tools the cost is small. Reviews count
  toward capacity like product reviews and leave the QA/SRE slot free.
- `window: 'market'` for a program means it runs during trading hours on the trading box; the default stays `any`,
  and `limits.busyWindow` still caps concurrency.
- Migration: existing `pm_enabled` / `pm_interval_min` keep meaning until a `research_programs` setting is saved.
- Perplexity-backed researchers cannot carry connectors (single-server relay); they keep web via Computer.

## Swarm review (2026-10-04, Codex GPT-5.2 at xhigh, 458 s; GLM skipped: key not loaded; Gemini API failing)

Codex read scheduler, team, runner, product-review, engines, db, dispatch and both UIs and ran 60 existing tests.
Accepted and folded into the design above:
1. stdio MCP connectors are trusted host extensions (outside the OS sandbox, inherit `DESK_RUN_TOKEN`/`DESK_SOCKET`):
   http-first policy, env-scrub wrapper for approved stdio bindings, explicit per-connector tool allowlist, transport-only
   config written to a 0600 file, `runs.connectors` audit.
2. Authorize `propose` by run (research run + server-owned program metadata), not by enlarging the seat allowlist; the PM
   can currently propose from any run kind.
3. A read-only reviewer needs explicit handling in `permissionsFor`, `sandboxSettings` and a `deskAction` allowlist;
   collect the verdict as structured final output instead of a mutating desk command.
4. Enforce the gate in every path (grooming, create-task, implementation dispatch, ownerPatch, ownerReply), with
   waiver as the single audited bypass.
5. Versioned review state (generation, input hash, assignment) and an outcome predicate for `launch()`.
6. Carry job requirements through provider selection and revalidate before spawn; per-job capabilities rather than
   mutating seat kinds (which would disable Perplexity seats).
7. Synchronous admission (seat, capacity, budget, proposal allowance) before clone preparation; server-side proposal
   caps; rotate due programs; share the review allowance; bounded escalation when no reviewer exists.
8. Pure `inWindow`; validate timezone/time; reject overnight windows; launch-time semantics; holidays out of scope.
9. Settings sentinel for "not configured"; validate every write path; freeze policy on tickets; grandfather `source='pm'`.
10. v2.js is the live UI; `bin/desk` must parse new verbs; a `research_revision` kind keeps cadence honest; approved
    sources and citation extraction cover "which research papers".
Deferred (recorded, not built): separate process isolation for stdio connectors; exchange-holiday calendars.
Rejected: extending product review with a discovery phase (its fixed panel + EM synthesis is heavier than the requested
one-peer gate); the gate shares infrastructure patterns but keeps its own policy.

## Decisions needed from the owner before implementation

1. Product name (table in §4), or keep SigmaDesk for now and rename later.
2. Connector isolation policy for v1: (a) http bindings only, stdio connectors wait for process isolation; or
   (b) stdio allowed when approved, with the env-scrub wrapper and tool allowlist (the two connectors on this machine,
   paper-search and knowledge-hub, are stdio). Recommendation: (b), since governance requires owner approval anyway and
   the case must state the local-file access.
3. Default review quorum `minReviewers: 1` and default reviewer pool `trading-advisor, quant-research, principal-be`.
4. GitHub issue for this plan before implementation?

## Status (2026-10-04, implemented)

Branch `research-programs`, merged to main. Owner decisions: keep the SigmaDesk name for now; stdio connectors allowed
when approved (env-scrubbed, tool-allowlisted); default quorum 1 from trading-advisor / quant-research / principal-be;
no GitHub issue. New modules `src/research.js`, `src/research-review.js`, `src/connectors.js`; schema additions in
`src/db.js`; scheduler, runner, dispatch, team, engines, server, desk CLI, both UIs and the attention model updated.
Tests: 250 pass (227 before + 23 new across research, connectors, research-review and http). Not exercised live: a real
reviewer run end to end (structured output parsing is covered by tests; the run path mirrors product review).
