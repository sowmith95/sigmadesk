# Plan: SigmaDesk for any project: import, describe, approve a recommended team

## Goal (owner's words)
"Any project can be imported, get a page, and get the types of agents that application needs. First ask what the user's
requirements are, recommend agents, show them, and create them once approved." It should be seamless, modular,
reusable and mobile friendly.

## Facts today (from a code map)
- One process = one project.
  - The `config` singleton (src/config.js) and `db` singleton (src/db.js) serve one port, one scheduler, one GitHub poll
    and one watch loop.
  - A second desk works only through env (`SIGMADESK_CONFIG/DB/DATA/SOCKET/WORKSPACES/PORT`), as the preview script does.
  - The launchd template and install-service.sh pass no env. The log path is fixed, and restart-when-idle reads the
    default config's token.
  - Startup sweeps every `r*.sock` in a shared run dir.
- The team is 14 hard-coded seats (src/team.js SEATS).
  - About 30 places depend on seat ids: routing (ENGINEERS/PRINCIPALS/BUILDERS, routeTicket), PERMS, NEVER_REVIEW,
    AREA_SEATS, `reviewersFor` (with trading regexes), `assessorFor`, council chairs, presets, tiers, avatars and the
    scheduler launchers.
  - `kinds` exists but is not used for dispatch.
  - `config.team[id]` can rename or re-charter existing seats only; nothing adds a seat.
- Trading lives in:
  - prompts ("run like a quant firm", brokers, P&L, alpha);
  - pm.persona and competitors, riskPaths, the research templates and reviewers;
  - "market hours" (busy window, the merge override phrase);
  - the Alpaca/Polygon secret patterns and the OCC symbol normaliser;
  - fixtures and docs.
- Onboarding: none. The project comes from a config file, and the server exits if repoPath is not a git checkout.
  - A first-run "Staff your desk" step (engines per seat, `team_confirmed`) exists only in the classic UI.
  - The React UI redirects to classic.

## Approach
**One desk per project, plus a small Projects hub.** Not one process for many projects.
- Every module reads one config and one db. Making them multi-tenant touches everything and risks the live desk.
- Separate desks are already isolated by design: own DB, workspaces, socket, port and service, so one project's runs,
  budget and outages never touch another's.
- The hub is a thin layer: a registry of projects, health of each desk, and the onboarding wizard.

### A. Project isolation (desk side, small)
- `SIGMADESK_HOME` per project: `projects/<slug>/` holds `config.json`, `data/` (db, publisher, logs), `workspaces/`
  and `run/`. All paths derive from it when set; the current layout stays the default (the live desk is untouched).
- The service template and install-service.sh take a project slug and pass SIGMADESK_HOME and PORT. The log path and
  the restart script are per project.
- The socket sweep only removes the desk's own sockets (its own run dir).

### B. Projects hub (new, small server + React pages, reusing the UI kit)
- `hub/projects.json` registry: slug, name, repo, port, service label, created, desk URL.
- Hub page: one card per project (needs-you count, working, spend today, desk state, open link). It is mobile first.
- Every desk header gets a project switcher: the hub is the home, and each desk links back.

### C. Onboarding wizard (hub; chips and steps; works on a phone)
1. **Project:** a local path or a GitHub repo URL (cloned under the hub's repos/ only after confirmation).
2. **Scan** (read-only, deterministic, no model):
   - languages and frameworks (package.json, pyproject, go.mod, Cargo, Gemfile…);
   - test commands, CI workflows and their pull-request coverage (reusing workflows.js), deploy workflows;
   - lockfiles and protected paths, `.env*` names (names only), the base branch, the GitHub remote.
   - Shown as editable chips.
3. **Requirements:** a few questions with chips plus free text: what it is and for whom; what must never break (money,
   auth, data, uptime); busy hours to avoid deploying (any label, e.g. market hours); how cautious merges should be; the
   budget per day; what to research, if anything.
4. **Recommended team** (role catalog plus rules, then an optional "Refine with Codex" read-only run that returns JSON):
   - Core roles are always present but configurable: manager, principal(s), builders by area, QA, SRE (if deploys or
     logs exist), support (if issues are imported), PM (if research is wanted).
   - Domain advisors come from packs: trading (trading workflow and quant research, today's seats), web product
     (product design, accessibility), security (auth/payments/PII), data/ML (data scientist), mobile, infra/devops,
     and custom.
   - Each card says why it is recommended (evidence from the scan or the answers), what it does, its engine and model,
     and when it reviews (its keywords).
   - The owner toggles, renames and changes engines, or adds a custom advisor (name, focus, charter, when to review).
5. **Review and create:**
   - Writes the project config, the team file and a draft playbook from the answers.
   - Installs and starts the desk paused. The owner confirms the team (the existing `team_confirmed` gate) and opens it.

### D. Data-driven team (desk side; the core of "different agents per application")
- Seats = core role seats (the existing ids, unchanged for compatibility) + **advisors** from the project's team file:
  `{ id, name, role, bio, lens, charter, reviewsWhen: { keywords, areas }, research: bool, engine/model/effort }`.
- Code that names trading advisors reads from advisors instead:
  - `reviewersFor`: core reviewers, plus advisors whose keywords or areas match.
  - `assessorFor`, research reviewer pools, program templates and read-only charters use the advisor lens.
- Backward compatible: with no team file, the advisors are today's three (product-design, trading-advisor,
  quant-research) with today's regexes, so the live desk behaves the same.
- Trading wording moves to the trading pack and the playbook.
  - The busy window gets a label ("Market hours" for ComplexTrading, "Busy hours" by default), and the merge override
    phrase derives from it.
  - The pm persona and competitors come from the answers.
  - Broker secret patterns and OCC normalisers become pack options.
- Core-role refactor (routing by role instead of id) is phase 2. Phase 1 keeps the core ids and makes them renamable,
  disableable and re-chartered from the team file, which `config.team` already partly allows.

### E. UX modular and mobile
- One shared kit across hub and desk: Section, ChoiceChips, Field, Panel, Lineage and EpicTree.
- A Stepper for the wizard, a project card, and a role card.
- Each step is one screen on a phone, with 44 px targets, drafts kept locally, and Back/Next that never lose input.

## Phases
1. Isolation (A), the hub with a project list and a wizard that creates a desk (B, C with deterministic recommendations),
   and advisors from the team file (D minimal). Test end to end on a scratch repo.
2. "Refine with Codex" for the team and playbook; trading wording generalised; the desk-side project switcher.
3. Core-role refactor (routing, PERMS, reviewer pools by role), custom builder roles, removing seats.

## Risks
- The live ComplexTrading desk must not change behaviour: defaults keep today's paths and seats; tests pin that.
- Cloning repos and installing services are outward actions: the wizard shows exactly what it will do and asks first.
- Many desks on one machine compete for CPU and provider quotas: the hub shows totals, and each desk keeps its own budget.
