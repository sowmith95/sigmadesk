# σ SigmaDesk

**An AI engineering desk run like a quant firm.** Real Claude Code agents sit in real seats — a product manager who
researches competitors, an engineering manager who grooms and staffs work after huddling with principals, principal /
senior / junior engineers, a database engineer, an independent QA, an on-call SRE who reads your production logs, and a
support bot at the front door. You watch all of it live on a Jira-style board from your phone.

Small, risk-limited bets. Everything measured. Nothing ships without an independent risk check — and nothing merges
without you.

| Inbox | Decision panel | Research programs |
|---|---|---|
| ![inbox](docs/screenshots/inbox.png) | ![decision panel](docs/screenshots/ticket.png) | ![research programs](docs/screenshots/research.png) |

<p align="center"><img src="docs/screenshots/phone-inbox.png" width="260" alt="phone inbox"> <img src="docs/screenshots/phone-ticket.png" width="260" alt="phone decision panel"></p>

## What it does

```
 you / GitHub issue ─► Support (triage) ─┐
 PM research (competitors, user pain) ───┼─► Manager grooms ◄─► huddle with principals
 SRE (new recurring error in prod logs) ─┘        │ (size S/M/L/XL, area, risk)
                                                  ▼
             routed seat: junior (S) · senior (M) · DBA (db) · principal (L/XL or high-risk)
                                                  │        └─► principal designs + slices into ≤4 S/M tasks
                                                  ▼            for seniors/juniors (principals never write code)
                                     own sandboxed clone, commits, `desk submit`
                                            QA risk check (pinned to the submitted commit)
                                                  ▼
                              Confirmation: the seat that asked for it checks it matches its intent
                                                  ▼
                                   branch pushed · draft PR · GitHub issue updated
                                                  ▼
                                              you merge
```

- **One real process per seat, any engine.** Each seat runs on an engine you choose — **Claude Code** (`claude -p`) or
  **Codex** (`codex exec`, OpenAI GPT models) — with its own model and reasoning effort. The desk detects what is
  installed, suggests a model per seat by capability tier (frontier for principals and the PM, fast/cheap for triage),
  and asks you to confirm the team before it first opens. A "mixed" preset puts QA and the SRE on a different vendor
  than the builders so reviews don't share the author's blind spots.
- **Live visibility.** Each run's `stream-json` is turned into human-readable activity ("Reading app/feeds.py",
  "$ pytest …", narration, todo-list progress) and pushed to the UI over SSE. The ticket view is a chat thread; the Floor
  shows every seat's desk, monitor and speech bubble; seats have presence (heads-down, in a meeting, reviewing).
- **Principals architect, others build.** Large or risky tickets go to a principal for a short read-only design run:
  the design is recorded on the ticket and the work is sliced into at most four S/M tasks for seniors and juniors
  (optionally ordered with `--after`). The parent becomes an epic whose progress rolls up from its slices. Frontier
  models spend tokens on decisions, cheaper models on typing.
- **Planning meetings are real.** The manager calls `desk consult principal-be "…"`, which runs the principal on the
  spot; the answer lands in the ticket thread for every later seat to read.
- **Two independent reviewers on every PR.** After QA passes, the draft PR is published and reviewed twice, in order, on
  the exact QA-passed commit: first by the principal who designed/sliced the work (else the Engineering Manager), then
  by an independent senior or principal who neither built nor designed it (preferably on another engine). Each
  approval says what was checked; change requests are numbered findings (file:line, why it matters, suggested fix).
  The author fixes (new commit → QA again → both approvals void) or pushes back with reasons (the same reviewer
  re-reviews). Every verdict and reply is posted on the PR in plain language. After two approvals the desk merges
  low-risk work itself (outside the busy window, CI green); anything high-risk or unclassified waits for you. After
  `review.maxRounds` change requests the owner gets a summary of the disagreement. Set `review.required: 0` for the
  older requester acceptance review instead.
- **A merge train, not a merge button.** PRs open as normal (non-draft) PRs (`github.draftPrs: false`). Approved PRs
  merge one at a time, oldest approval first, slices after their predecessor. Only high-risk work waits for you. A PR
  whose files trigger a deploying workflow (`deploy.workflows`: `"auto"` reads every workflow's `on.push`
  branches/paths filters, `!` exclusions included; or list the files that deploy — unreadable counts as deploying) is
  scheduled for the end of the busy window instead of merging during market hours ("Merges automatically at 4:15 PM
  ET"; Hold / Merge now from the PR page), and the next deploying merge waits until that merge's deploy run finished
  (failure or `deploy.waitMinutes` → you). Every minute the desk fetches the base and every open PR head and runs a free
  `git merge-tree`: only the queue front is rebased (desk-side, `--force-with-lease`, then QA plus a light reviewer
  re-confirm with a range-diff); a real conflict becomes a durable resolve job for the engineer who built the PR — a
  fresh, budget-capped run (`resolve.budgetUsd`, session resume off by default) in an isolated clone with a compact
  conflict pack — followed by QA and both reviewers re-confirming the resolution. Each step is posted on the PR.
  Merges fail closed: every merge (desk or owner) takes the deploy lock first when it redeploys, persists its intent
  before calling GitHub, and re-checks halt / stop-all / Hold / risk / window / lock / base freshness immediately before
  the merge call. The desk can only narrow the gap between "CI read" and "merged"; to make it atomic, protect the base
  branch with required status checks and "Require branches to be up to date before merging" (or a merge queue) —
  `npm run doctor` warns when that is missing.
- **On-call SRE.** A deterministic watcher (no LLM) tails Loki / docker / files, fingerprints errors, and wakes the SRE
  only for new or chronic signatures. The SRE files a root-caused bug, mutes noise, or pages you. Error storms become
  one page, not fifty tickets. A fixed signature that comes back reopens as a regression.
- **GitHub is the system of record.** Groomed tickets become issues with status/seat labels; comments mirror; QA-passed
  work becomes a draft PR that closes the issue on merge; merged PRs move tickets to Filled. Issues you label
  `sigmadesk` are imported (from trusted authors only).

## Engines

| | Claude Code | Codex (OpenAI) |
|---|---|---|
| How it runs | `claude -p --output-format stream-json` | `codex exec --json` with a desk-owned `CODEX_HOME` (apps, plugins, browser/computer use, hooks off) |
| Writes | own clone only (OS sandbox) | own clone only (Codex sandbox) |
| Network | blocked | blocked (permission profile) |
| Secret reads | **blocked** (`~/.ssh`, credentials, desk state) | **blocked** — reads denied outside system/toolchain paths and the clone (Codex permission profiles, beta) |
| Desk transport | per-run unix socket | per-run file mailbox inside the clone (symlink-safe) |
| Cost | USD per run, hard per-run cap (`--max-budget-usd`) | tokens; USD if you set `engines.codex.pricing`. **No per-run hard cap** — bounded by the run timeout and a reservation |
| Resume / fork | both | resume only |

The header and Reliability view show remaining provider usage, independent reset times and the effective route for
each engineer. Claude usage comes from CLI reports during runs. Codex account limits refresh every two minutes using
read-only app-server RPC, without a model turn. Unknown windows stay unknown. Perplexity desktop credits are dated
observed snapshots, separate from API billing; API balances are not fabricated. New runs switch to the other healthy
installed provider at `limits.planHoldAt` (80% by default). Settings → Automatic provider fallback controls this.
Saved seat preferences remain intact; credit/auth failures hold the provider instead of consuming ticket stall retries.
Cooldowns persist across restarts, weekly and five-hour resets are independent, and sessions resume only when provider,
model and seat contract match. Partial changes stay in the ticket clone and must be inspected by the next engineer.
Adding another execution engine means
implementing one file in `src/engines/` (`command()` + `parse()` → normalized events).

**Perplexity context packs.** A Perplexity-backed thinking seat (groom, design, consult, owner discussion, review,
research, triage, investigate) no longer relies on its local relay to pick what to send. `src/context.js` builds a
deterministic pack in the desk-owned bare repo (`data/publisher.git`), never from the seat's clone: the base is frozen
from the owner's remote (or the owner's checkout) and the review head is the desk-recorded `head_sha`, imported by object
id. Git runs with no system/global config, hooks, fsmonitor, signature checks, external diff or textconv. The pack
holds the frozen ticket and acceptance criteria, decision history, parent design, prerequisites and siblings, playbook
rules, protected paths, labelled excerpts and "references found by search" (text matches, not proven callers).
Reviews carry the committed diff in whole hunks; anything over budget is listed as omitted, and required content that
cannot fit refuses the run. One scrubber covers the whole pack and every served file (quoted JSON/YAML credentials,
private-key blocks, bearer tokens, URL credentials, known key formats); secret paths and both sides of secret renames
are withheld. Packs are stored in `data/context/` (0600). If a pack cannot be built within `prepareDeadlineSeconds`,
the run is refused.

The relay must send the pack verbatim. The desk inspects every outgoing call. It stops the run immediately and
invalidates it only for this run's exact token or verdict code, a validated private-key block, a recognised provider
secret (Anthropic/OpenAI/GitHub/AWS/Slack/Google/Stripe secret keys…, never public `pk_*` keys), a format listed in
`engines.perplexity.secretPatterns`, the value of a secret-named desk environment variable, or a message over
`contextMaxChars`. Generic credential-looking code (`token = getToken()`) is redacted from packs but never stops a run.
This is observation of the relay's stream, not a proxy: a violating message may already be in flight when the run is
stopped. The pack counts as delivered only when that call's tool result succeeds. Requested files
(`desk context-file <path> [--page N]`) are paginated without truncation; every page fits `pageChars` and pages may go
in several follow-ups, but they count only on the pack's own thread. `desk accept pass` is refused until the pack was
delivered, every omitted changed file was fully sent, no message to the thread is in flight, and `read_thread`'s
structured state shows the latest entry as `WORKFLOW_COMPLETED` after the last message (a later error or follow-up
undoes it). Stop-all also aborts runs that are still building their pack. A retry of the same job (same task, seat
contract and pack) resumes polling the recorded thread; anything else asks afresh. Knobs under `engines.perplexity`:
`contextMaxChars` (60000), `relayReserveChars` (8000), `remoteWaitMinutes` (8; idle watchdog and run timeouts are
raised above it), `followupRounds` (1), `pageRounds` (6), `pageChars` (0 = the pack budget), `secretPatterns` ([]),
`prepareDeadlineSeconds` (45), `maxRunMinutes` (90; the run timeout covers the first answer, follow-ups and page rounds, and
fewer page rounds are allowed when the cap is lower). Remote state is dated by when it was requested, so a `read_thread`
issued before a follow-up never counts as that follow-up's answer; if the pack thread fails, a replacement thread
carrying the pack takes over (coverage and completion start over on it).

## Owner decisions and discussions

Tickets awaiting you show **Approve**, **Needs correction** and **Reject** beside one message box. Approval continues
the pending task (or explicitly approves guarded draft publication); corrections require instructions and return work
to the engineer; rejection closes the ticket while retaining local work. Stale decisions are rejected. Draft approval
does not merge a PR: use **Review draft PR** for the final owner-controlled merge.

**Auto route** recognizes explicit requests to discuss with the manager/principals. These enter a durable read-only
discussion queue and preserve the implementation blocker. The manager restates intent, consults up to two principals
once each, and records a response on the same ticket. The composer also offers explicit discussion, answer and comment
destinations. Discussions cannot alter status, create tickets/issues, change code, merge or publish; they respect the
same provider, budget and concurrency gates. This follows the compact approve/edit/reject pattern in
[LangChain's human review interface](https://reference.langchain.com/javascript/langchain/browser/humanInTheLoopMiddleware).
Completed design proposals have their own decision target: approval/rejection records the design decision; corrections
queue a revised manager response. Those decisions preserve the underlying task state and its implementation/merge gates.

## Architecture Review Board and model selection

Open a ticket → **Architecture review** → **Desktop / API review**. Choose a design reviewer and an independent challenger from a different model
family. Create the brief, then either run it through an API or copy it into Perplexity and attach the returned report.
In the Mac app, the model pill below the composer switches the next message's model; we verified Kimi K3, GLM 5.3
and Grok 4.7 in its Computer picker. Gemini availability differs by surface and requires the native Gemini API or a
compatible Perplexity API route here. A desktop subscription does not provide API credentials.

| Specialist | Starting model | Responsibility |
|---|---|---|
| Principal Architecture Reviewer | Kimi K3 | Alternatives, invariants, migration costs |
| Principal Systems & Frontend Reviewer | Gemini 3.1 Pro | Systems interactions, UX, accessibility |
| Staff Delivery & Efficiency Reviewer | GLM 5.3 | Complexity, implementation slices, cost |
| Principal Reliability Reviewer | Grok 4.7 | Failure modes, races, recovery |
| Product Discovery Researcher | Sonar | Cited public research |

These are task-specific starting choices, not measured claims of universal model superiority. Evaluate useful findings,
QA outcomes and cost on your own tickets. Gemini Flash and GLM Flash are offered for smaller reviews.
The software-company terms are **independent design review**, **Architecture Review Board**, **RFC**, and **ADR**.
The design owner resolves disagreements in an Architecture Decision Record. Advisory reports never grant QA approval.
Principals/managers can call `desk peer-review "<specific design question>"` once per run; missing credentials do not
block their design work. Reviews have no shell, desk token, repo access or merge permissions. Inputs are bounded and
redacted; only Sonar may use public web search. Daily reservations, concurrency, timeout and the circuit breaker apply.
USD charges without a provider cost report are estimates; reservations and token caps are not an upstream billing cap.

Configure `advisors.keyFile` to an owner-only, gitignored JSON file with `perplexity`, `gemini`, and/or `xai` keys.
Alternatively use `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, or `XAI_API_KEY` in the service environment.
Credentials stay with the server and are stripped from engineer environments. Native Gemini/xAI routes are preferred;
Perplexity's Agent API routes the other model families. “Configured” means a key is present; authentication is checked on use.
Provider IDs and request formats were checked against [Perplexity](https://docs.perplexity.ai/docs/agent-api/models),
[Gemini](https://ai.google.dev/gemini-api/docs/models), and [xAI](https://docs.x.ai/developers/grok-4-7).

## Features: grooming with Codex, then your approval

A feature is something you want built, in your words. On the Features page, **New feature** asks for a name and what it
should do for whom. Morgan, the Engineering Manager, then runs a grooming round on **Codex**: a read-only run that reads the
repository and returns a plan with these parts:

- a two-sentence summary;
- the goal and who it is for;
- what is in and out of scope;
- testable acceptance criteria;
- risks;
- questions only you can answer;
- one to eight small or medium tasks in build order.

The feature's page shows that plan as a document, with the grooming session beside it:

- **Reply to Codex** to start another round. The previous plan and your note go into the prompt, and earlier rounds stay
  readable.
- **Edit the tasks** before approving: rename, resize or switch off any of them. A task that depends on another needs both.
- **Approve** to create the tasks with their order enforced. Each task brief carries the feature's goal and criteria. The
  feature moves to building and closes itself when its tasks are settled.

Nothing starts before approval. A feature with a plan in progress is held from triage, ordinary grooming and
implementation. An approved plan is the plan gate, so no separate product review is needed. QA, code review and your
merge approval still apply.

With GitHub sync on, an approved feature and its tasks get issues. The feature's issue carries the plan and a task
checklist that ticks as tasks merge. GitHub mirrors the desk; decisions happen on the desk. An issue you wrote yourself
keeps your text, and the desk adds its section between markers. Approved features are reconciled with GitHub on every
start.

Ordinary grooming also runs on Codex by default (Settings → Grooming can switch back to Morgan's own engine). When Morgan
splits a ticket, `desk split` keeps the parent open as an epic that closes when its tasks are done, and `--after` records
the order between tasks. You can change a task's order in its Details tab, and reopen a parent that was closed while its
tasks were open.

**Epics and tasks are linked both ways.**
- **Every task names its epic.** Inbox cards, Work cards, pull requests and the ticket panel show "Part of: Feature ›
  Sub-epic" crumbs, and each crumb opens that epic.
- **Every epic shows its tasks.** An epic's panel opens on a Tasks tab with the full tree, what each task waits for,
  and progress counted over the real work.
- **Work can be grouped by epic.** Work → By epic shows each top-level epic with its whole tree, then anything not in an
  epic.

## Research programs and the second-person review

Research is configured as **programs** (Settings → Research): which seat researches, how often, whether only during or
only outside market hours (`research.marketHours`, New York regular hours by default), which approved sources it must
cite, whether it may use the web, which approved connectors it may call, how many proposals a session may file, and
which seats must review a proposal. The default `product-discovery` program is the PM's competitor research and is
derived from `pm.*` and the legacy cadence settings until you save programs. Due programs run oldest-first while the
funnel is thin; "Run now" skips cadence and window but never budget, capacity, engine fit or the proposal allowance.

Every proposal filed by a research run waits for an **independent second review** by a different seat (preferring a
different model family) before the manager may groom it: `pass` unblocks it, `changes` gives the author one bounded
revision, `reject` or a second `changes` holds it for you (approve, send back with notes, or reject). Reviewers run
read-only and answer with a structured verdict; you can waive the review, and that is recorded.

**Connectors** (MCP servers for research seats) are governed: a written case (benefit, how it is used, SDLC stage,
cost, time, data leaving the machine, risks, success measure), an independent assessment by a seat other than the
proposer, then your approval with the exact binding and tool list and a re-evaluation date. Usage, cost and the review
outcome of the proposals they helped produce are shown per connector. A `stdio` connector runs outside the OS sandbox
with your user's file access; the desk strips its own credentials from that process and allows only the listed tools,
but cannot confine it, so prefer `https` bindings. See [docs/research-programs.md](docs/research-programs.md).

## On-demand engineering councils

Open **Architecture review** → **Model council**. Choose two or three reviewers from different model families,
their lenses, and a principal synthesis model. The manager may choose approved models with `desk council-models`
and `desk council --profile data --reviewer codex/default --challenger claude/sonnet "<decision>"`, once per run.
The domain principal chairs the decision; the coordinator checks provider readiness, budget and capacity.

Each independent reviewer sees the identical frozen, redacted ticket specification, design notes, constraints and
candidate SHA. Reviewers cannot use tools or inspect a changing checkout. Supply code evidence in the brief when
needed; a design council does not perform implementation QA. Individual JSON findings, evidence and exposing tests
are retained. An optional single blinded challenge runs when verdicts disagree. The chair weighs evidence and keeps
unresolved dissent. **Approve / Needs correction / Reject** records the design decision; corrections queue a fresh
council with the message. Partial or stale reports cannot be approved. These records remain in the local desk.

All planned calls, including challenge and synthesis, reserve their individual caps (maximum $20 per council).
At most two calls run at once and one capacity slot is preserved for QA/SRE. A failed reviewer does not discard the
others. **Retry failed calls** reuses completed first judgments on the same input and runs a fresh synthesis. An
interrupted paid call needs an explicit retry. Never-started queued work survives restart. Changed specification,
dependency, branch or SHA invalidates the brief. Pausing or the circuit breaker cancels councils and retains reports.

CLI councils use existing Claude/Codex authentication headlessly. Gemini, xAI, Kimi and GLM use the separately
configured advisor APIs. The separately installed Perplexity thinking-seat relay has its own provider connectivity status. Computer councils are off by default (`engines.perplexity.councilEnabled: false`): a Computer task bills account credits and cannot be cancelled from the desk. Once the guide has been completed on your account, set the flag and Perplexity models (Kimi, Grok, DeepSeek, GPT and Claude families; the cheap tier stays out) join the reviewer pool as their own model families, with `remoteWaitMinutes` added to the council call timeout. To verify Computer OAuth, follow
[the connection verification guide](docs/perplexity-connection.md). Its native Model Council MCP interface, live
balance and remote cancellation remain unverified; the desktop snapshot does not establish server connectivity.

Automatic council triggers are disabled. Run `node scripts/evaluate-council.mjs --real` for an isolated, opt-in
comparison of single, sequential and parallel review against two defect fixtures and a clean control. The first pilot
matched all three expected judgments for each strategy, with 3/6/9 calls respectively. It did not establish an accuracy
advantage for councils. Codex USD is a conservative estimate when no provider cost is reported, not subscription credits.

## Background reliability and local checks

The launchd user service, CLI engineers and deterministic watcher continue when the screen is locked. On macOS,
`server.preventIdleSleep: true` holds `caffeinate -i -w <desk PID>` while the desk runs. It does not prevent screen lock,
lid-close sleep, explicit sleep, low-battery sleep, shutdown or logout. User LaunchAgents end at logout. Desktop clicks
require an unlocked session; API reviews are independent of it. Interrupted runs are charged conservatively and their
tickets return to the queue on restart. Setup errors back off from one minute to fifteen rather than retrying every tick.

Reliability shows source health, stale polls, provider holds, scheduler liveness, headroom and queue reasons. Watcher
cursors and incidents commit atomically; rolled-back events never reach the UI. Each read-only seat has its own scratch
clone. Mailbox replies create their private staging directory, retain completed responses on I/O failures, and retry
without executing the action twice. Use `scripts/restart-when-idle.sh <service-name>` to drain and restart between runs.

`npm test` runs the regressions and isolated HTTP tests. `npm run preview` starts a disposable UI fixture on port 8791
with every execution seat disabled and no publishing, notifications or credentials. `node scripts/smoke-seat.mjs`
explicitly spends a bounded real Codex run on a disposable repo to verify quota fallback, mailbox, denied reads/writes
outside the clone and blocked network. It retains private diagnostics on failure.

## Safety model (read this)

Agents run on your machine, so SigmaDesk treats them as untrusted:

| Layer | What it does |
|---|---|
| **OS sandbox** | Every agent shell runs inside Claude Code's sandbox (Seatbelt on macOS, bubblewrap on Linux) with `allowUnsandboxedCommands: false`: writes only inside the seat's own clone, **no network** (empty allowlist), `~/.ssh`, `~/.aws`, `gh` credentials and your repo's `.env` unreadable. Python/node subprocesses inherit it. |
| **One narrow door per run** | Each run gets its own unix socket, allowlisted only in that run's sandbox and bound to that run: a token copied from elsewhere is useless. Commands are role- and ticket-checked (an engineer cannot pass its own QA; support can only route the ticket it was given). The owner UI is a separate TCP listener agents cannot reach. |
| **Desk state is invisible** | The desk database, config, private notes and every seat's session transcripts (`~/.claude`, `~/.codex`) are unreadable from agent shells. |
| **Scoped file tools** | Claude's `Edit`/`Write` run outside the Bash sandbox, so they are allowed only under the seat's own clone. Web tools (also outside the sandbox) exist only for the PM's research. |
| **Verdicts can't be forged by code** | QA and acceptance verdicts need a one-time code that lives only in the reviewer's prompt — tests written by the engineer (which QA executes) cannot read it (they can still post comments with the run's token). QA may only pass after its own run executed a test command — one that starts a shell segment — successfully. |
| **No inherited config** | `--setting-sources ''` (none of your hooks/plugins), `--strict-mcp-config` (no MCP servers), `--tools` limits the toolset, deny rules for `git push`, `gh`, `docker`, `curl`, …; agent shells use plain `bash` (no personal aliases). The desk refuses to start if `claude` resolves to a wrapper script that adds permission bypasses. |
| **Isolated clones** | Each ticket gets its own `--no-hardlinks` clone (no shared `.git`, hooks or object files with your checkout). Read-only seats use a scratch clone reset each time. Clones are deleted when the ticket closes. |
| **Publisher, not agents** | Only the desk pushes, and only the exact commit QA approved. It fetches that commit into a desk-owned bare repo and pushes from there to your remote, so no git command ever runs with an agent clone's config or hooks. PRs are always drafts. Nothing is ever merged automatically. |
| **Publish guard** | Computed in the publisher against *your* checkout's base commit (an agent cannot move it). Branches touching CI/workflows, Dockerfiles/compose, git hooks, lockfiles or shell scripts — or bigger than the size cap for their complexity — are parked for your explicit approval. An agent-edited workflow would otherwise run on your CI runners with repo secrets. |
| **Risk limits** | Per-run budget caps (Claude), a daily limit that reserves every working seat's cap (including jobs still preparing), runs without a final cost report charged at their cap, max concurrency, a quieter "busy window" (e.g. market hours), an idle watchdog, a halt switch and a circuit breaker that also cancels jobs still preparing. |
| **Untrusted text** | Ticket bodies, issue bodies, web pages and log lines are fenced and labelled as untrusted data in prompts. Secrets are redacted from the activity log. |

It is still your machine: read the playbook rules, keep `sandbox.enabled: true`, and review every PR. The design has
been through two adversarial reviews (findings and fixes are in the commit history); treat it as defence in depth, not
a guarantee — Codex permission profiles are a beta feature, and anything you add to `readOnlyPaths` is readable by
every seat.

## Quick start

Requirements: Node ≥ 22.13, git, at least one engine — the [Claude Code CLI](https://code.claude.com) and/or the
[Codex CLI](https://github.com/openai/codex) (logged in) — and optionally the GitHub CLI (`gh auth login`). macOS works out of the box; Linux needs `bubblewrap` and `socat` for the sandbox.

```bash
git clone https://github.com/sowmith95/sigmadesk && cd sigmadesk
cp sigmadesk.config.example.json sigmadesk.config.json   # point project.repoPath at your repo
npm run doctor                                           # checks claude, gh, sandbox, config
npm start                                                # http://127.0.0.1:8790
```

No `npm install`: there are zero runtime dependencies (Node's built-in `http`, `node:sqlite`, `child_process`).
The desk starts **halted**; press **Open desk** in the UI when you're ready.

Run it as a service: `scripts/install-service.sh` (launchd on macOS, a systemd user unit on Linux). After pulling an
update, `scripts/restart-when-idle.sh <name>` restarts the service the first moment no seat is working (interrupted
seats resume their own sessions anyway, but an idle restart charges nothing).

### Phone access

Add your Tailscale (or LAN) IP to `server.hosts` and set `server.ownerToken`, then open
`http://<ip>:8790/?token=<ownerToken>` once on the phone (it sets a cookie). Add it to your home screen: it's a PWA.

## Projects: one desk per repository

SigmaDesk can run a desk for any number of projects. The code (this checkout) holds no project data. Each project
lives in the per-user application folder:

| What | macOS | Linux |
|---|---|---|
| Project home: config, team, playbook, database, run files | `~/Library/Application Support/SigmaDesk/projects/<id>/` | `~/.local/share/sigmadesk/projects/<id>/` |
| Agent workspaces (clones), outside every project home | `…/SigmaDesk/workspaces/<id>/` | `…/sigmadesk/workspaces/<id>/` |
| Logs | `~/Library/Logs/SigmaDesk/<id>/` | `~/.local/state/sigmadesk/<id>/` |
| Registry | `…/SigmaDesk/projects.json` | `…/sigmadesk/projects.json` |

```bash
npm run project -- create ~/code/shop --name "Shop"   # creates the project home with a neutral profile
npm run project -- list
npm run project -- install shop                       # background service on its own port
npm run project -- uninstall shop                     # stops it; the data stays
```

Each desk is isolated:
- its own database, sockets, workspaces, port and login cookie;
- a lock refuses a second copy of the same project before it can touch the database;
- agents can read their own clones, but never any project's database or another project's clones.

A desk without `SIGMADESK_HOME` uses the original in-checkout layout, so an existing desk keeps working unchanged.
The setup wizard (describe the project, approve a recommended team) is next.

## Configuration

Everything lives in `sigmadesk.config.json` (gitignored). See `sigmadesk.config.example.json`. Highlights:

| Key | Meaning |
|---|---|
| `project.repoPath`, `githubRepo`, `baseBranch` | The repo the desk works on. |
| `project.playbook` | Markdown every seat reads: how to test, risk rules, product truths. Start from `playbooks/`. |
| `project.copyPaths` | Untracked dirs (e.g. `web/node_modules`) cloned into each workspace (APFS copy-on-write on macOS). |
| `project.extraAllowedBash`, `readOnlyPaths` | E.g. a shared virtualenv the seats may use. |
| `team.<seat>` | Override `name`, `model`, `enabled`, `charter` per seat. |
| `limits.*` | Concurrency, busy window, daily budget, per-run budgets, timeouts. |
| `engines.perplexity.*` | Context-pack cap (`contextMaxChars`), remote wait for pending threads, follow-up rounds. |
| `review.*` | Two-reviewer PRs (`required`, `independentSeats`, `maxRounds`, `autoMerge`, `riskPaths`, `ci`), legacy acceptance reviews, session resume. `ci: "auto"` lets a PR with no checks merge only when the repo has no Actions workflows; skipped/neutral-only checks never count as a pass. Every merge (yours or the desk's) needs the exact head SHA, green CI, known mergeability, the configured base branch, and two approvals at that commit — you can override the approvals with a reason that is posted on the PR. |
| `deploy.*`, `mergeTrain.*`, `resolve.*` | Which workflows deploy, how long to wait for a deploy, the lazy update of the queue front, the conflict-resolution budget and resume policy. |
| `watch.*` | Log sources (`loki` / `docker` / `file`), thresholds, storm and regression handling. |
| `pm.*` | PM persona, competitors to study, cadence. |
| `sandbox.*` | Extra allowed domains (e.g. a package registry) and paths to keep unreadable. |
| `notify.*` | A Discord/Slack webhook or ntfy.sh topic: get pinged when a ticket needs you, a PR is ready, or the SRE pages. |

Live knobs (concurrency, budget, PM cadence, GitHub sync, draft PRs) are also editable in the UI under **Limits**.

## The desk CLI (what agents use)

Agents talk to the desk only through `bin/desk` over the socket: `desk progress 40 "writing tests"`, `desk comment`,
`desk needs-human "<question>"`, `desk propose`, `desk groom`, `desk consult`, `desk submit`, `desk qa pass|fail`,
`desk accept pass|changes`, `desk incident file|mute|page`, `desk context-file <path>` (Perplexity seats). Run `bin/desk --help` for the full list.
Every subcommand also accepts `--help` or `-h`; help never submits a desk action.

## How it compares

| | SigmaDesk | [OneManCompany](https://github.com/1mancompany/OneManCompany) | [Citadel](https://github.com/SethGammon/Citadel) | [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | [CCPM](https://github.com/automazeio/ccpm) |
|---|---|---|---|---|---|
| Target | an existing repo, PR-based | a whole "company", greenfield products | orchestration layer over Claude Code / Codex | kanban for coding agents | PRD → issues → worktrees |
| Roles & routing | 11 seats, area × size × risk routing, principal huddles | hire/fire employees, COO dispatch | — | flat tasks | — |
| OS sandbox by default | ✅ (writes, network, secret reads) | ❌ (runs with permissions skipped) | not a sandbox | git worktrees | git worktrees |
| Independent QA + requester acceptance | ✅ pinned to the commit, evidence-gated | LLM review | judge tiering | — | — |
| On-call SRE from production logs | ✅ deterministic watcher, storms → one page | — | — | — | — |
| Human merge gate | ✅ always | auto-promotes to main | — | — | — |
| Dependencies | zero | Python stack | Node | Rust + Node | markdown |

These projects are good at things SigmaDesk is not (OneManCompany's breadth, Citadel's merge stewardship, Vibe Kanban's
polish). SigmaDesk's bet is narrower: a desk you can leave running against a real codebase on a real machine.

## Roadmap

From a review of the projects above and Microsoft's *AI agents from zero to production* course:
replay evals on your own merged PRs (pick models per seat from data), a red-team seat smoke suite, run provenance
(charter/playbook/model hash per run), desk P&L metrics (merged ÷ shipped, $/merged PR, regressions), owner-approved
lessons memory per seat, ticket dependencies, recurring-defect escalation into playbook fixes, multi-repo desks.

## Why not fully autonomous merges?

Everything up to a draft PR runs without you. Merging stays human on purpose: in a repo where `main` deploys
production, "the error stopped appearing in the logs" is a gameable success test — an autonomous loop will eventually
ship a silent `except: pass`. The SRE's acceptance review explicitly rejects symptom-hiding fixes, but the final call is
yours.

## Costs

Model spend is reported per run (from Claude Code's own accounting) and summed per seat and per day. On a
subscription this is notional usage that counts against your plan limits; with an API key it is real money. The daily
limit reserves each running seat's full per-run cap, so concurrent runs cannot jointly blow through it.

## Development

```bash
npm test          # node:test; browser tests skip when no Chromium is cached
npm run doctor
```

The UI is React 19 and TypeScript, styled with Tailwind 4 and shadcn/ui components (Radix primitives, cmdk for
the command palette, sonner for toasts, lucide icons). Everything is a dev dependency: Vite builds it into
`public/app/`, which is committed, so the desk still runs with no `npm install`. After changing `ui/src/`:

```bash
npm install            # once, for the build tools
npm run build:ui       # rebuild public/app and its stamp (tests fail if the bundle and sources disagree)
npm run typecheck      # tsc --noEmit (also run by npm test)
npm run dev:ui         # Vite dev server with hot reload, proxying the API to a running desk
npm run ui:shots       # phone and desktop screenshots of every page and panel into /tmp/sigmadesk-shots
```

Pages are addressable: `#/inbox`, `#/work`, `#/features` (a feature's document at `#/features/<KEY>`), `#/team`, `#/research`, `#/prs`, `#/desk`, `#/settings`, and a ticket
opens at `#/<page>/<KEY>`. Press ⌘K or `/` for the command palette. Shared building blocks live in
`ui/src/components/desk/` (chips, fields, async buttons, the side panel); `ui/src/components/ui/` holds the generated
shadcn components.

Source map: `src/server.js` (HTTP + SSE + unix socket), `src/scheduler.js` (who picks what up, desk commands),
`src/runner.js` (sandboxed runs, evidence, clones, publisher), `src/engines/` (Claude Code, Codex), `src/team.js`
(seats, routing, permissions, prompts), `src/watch.js` (log watcher), `src/github.js`, `src/db.js` (SQLite),
`ui/src/` (UI sources), `public/app/` (built UI, committed).

## License

MIT
