// Configuration: built-in defaults ← sigmadesk.config.json ← SIGMADESK_* env vars.
// Everything machine- or project-specific lives in the config file (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deskPaths } from './app-paths.js';
import { KINDS as DELEGATION_KINDS, validMode as validDelegationMode } from './delegation-model.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  // Set by the setup wizard for a new project: what the owner already approved there (e.g. the team).
  bootstrap: {},
  server: {
    port: 8790,
    // Loopback only by default. Add your Tailscale/LAN IP to reach it from a phone.
    hosts: ['127.0.0.1'],
    // Optional shared secret for the web UI. Open /?token=<value> once per device.
    ownerToken: '',
    preventIdleSleep: process.platform === 'darwin',
  },
  project: {
    name: 'my-project',
    repoPath: '', // absolute path of the git checkout the team works on (required)
    githubRepo: '', // owner/repo (auto-detected from the checkout's origin if empty)
    baseBranch: 'main',
    branchPrefix: 'sigmadesk/',
    ticketPrefix: 'SD',
    playbook: 'playbooks/default.md', // project rules every agent reads (path relative to ROOT or absolute)
    copyPaths: [], // untracked dirs to APFS-clone into each workspace, e.g. ["web/node_modules"]
    env: {}, // extra env for agent runs, e.g. {"TZ": "America/New_York"}
    extraAllowedBash: [], // extra Bash permission rules for engineers, e.g. ["Bash(make test *)"]
    readOnlyPaths: [], // extra dirs agents may read (e.g. a shared virtualenv)
    // Publish guard: a branch touching any of these is NOT pushed until the owner approves it. CI files are the big one:
    // a workflow edited by an agent would run its code on your CI runners (self-hosted = this machine) with repo secrets.
    protectedPaths: ['.github/**', '.gitlab-ci.yml', '.circleci/**', '.buildkite/**', 'Jenkinsfile', 'azure-pipelines.yml',
      '**/Dockerfile*', '**/docker-compose*', '**/compose*.y*ml', '.husky/**', '.githooks/**', '.pre-commit-config.yaml',
      '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/requirements*.txt', '**/setup.py',
      '**/.npmrc', '**/Makefile', '**/*.sh', '.env*', '**/.env*'],
    maxDiffLines: { S: 400, M: 1200, L: 3000, XL: 6000 }, // larger diffs are parked for the owner
    // QA must have run one of these (successfully) in its own run before it may pass a ticket.
    testCommandPattern: '\\b(pytest|vitest|jest|mocha|go test|cargo test|npm (run )?(test|build)|pnpm (run )?(test|build)|yarn (test|build)|make (test|check)|mvn test|gradle test|rspec|phpunit|tox|nox)\\b',
  },
  limits: {
    maxConcurrent: 3,
    // Optional quieter cap during a busy window (e.g. market hours on a box that also trades).
    busyWindow: { enabled: false, timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:30', end: '16:15', maxConcurrent: 1 },
    dailyBudgetUsd: 150,
    runBudgetUsd: { fable: 8, opus: 5, sonnet: 3, haiku: 0.75 },
    runTimeoutMin: { implement: 45, qa: 20, review: 20, pr_review: 25, respond: 45, resolve: 30, triage: 8, groom: 20, research: 30, consult: 10, investigate: 20, verify: 15, watch: 15, access_review: 5, design: 20, council_review: 5, feature_groom: 25, epic_review: 20, mention: 15, decide: 10 },
    maxQaLoops: 2,
    planHoldAt: 0.8, // hold new runs when the Claude plan's 5-hour window is this full (leave room for you)
    maxConsultsPerGroom: 1,
    idleTimeoutMin: 5, // no stream output at all (even thinking emits events) = stalled request; the run is stopped and resumed
  },
  review: {
    // After QA passes, the seat that asked for the work (PM / manager) confirms it matches their intent.
    acceptance: true,
    principalAcceptance: false, // principals design + delegate; QA checks their slices (saves frontier-model usage)
    // Opt-in: resume the requester's original session (forked) instead of a fresh run with an intent dossier.
    resumeRequester: false,
    resumeRequesterMaxAgeHours: 6,
    // Rework continues the engineer's own implementation session in the same clone.
    resumeRework: true,
    resumeReworkMaxAgeHours: 24,
    // Two independent reviewers on every PR after QA: a context reviewer (the principal who designed/sliced it, else
    // the Engineering Manager) and then an independent senior/principal. 0 = off (legacy requester acceptance).
    required: 2,
    independentSeats: ['principal-be', 'principal-fe', 'senior-be', 'senior-fe', 'dba'],
    maxRounds: 3, // change requests per ticket before the owner is asked to settle the disagreement
    escalateAfterMinutes: 240, // an assigned reviewer seat that stays switched off this long → owner
    // Auto-merge after two approvals: only when the stored ticket risk AND the diff classifier both say low.
    // Deploying merges inside the busy window are scheduled for the window's end, not blocked (see deploy.*).
    autoMerge: { enabled: true, excludeRiskHigh: true, method: 'squash' },
    // "auto": a PR with no checks at all may merge only if the repo has no GitHub Actions workflows.
    // "required": no checks reported = not mergeable. Skipped/neutral-only checks never count as a pass.
    ci: 'auto',
    // "auto": the checks that succeeded on every one of the last 5 merges (owner-editable). Or list the names.
    // With no list and a repo that has workflows, the desk does not auto-merge (the owner is asked to confirm).
    requiredChecks: 'auto',
    optionalChecks: [], // check names allowed to be SKIPPED/NEUTRAL; every other check must be SUCCESS
    // Diff paths that make a change high-risk (trading, broker, risk, schema, deploy). Globs, like protectedPaths.
    riskPaths: ['**/oms/**', '**/*order_execution*', '**/*order_execution*/**', '**/*position_manager*', '**/clients/alpaca*',
      '**/clients/alpaca*/**', '**/risk/**', '**/migrations/**', '**/*migration*.sql', '**/docker-compose*', '**/compose*.y*ml',
      '**/Dockerfile*', '.github/**', '**/.env*', '**/*.sh'],
  },
  // Which merges redeploy something. "auto": every workflow whose on.push trigger matches the base branch and the
  // PR's files deploys; or list the deploying workflow files, e.g. ["deploy-mac-mini.yml"]. Unreadable = deploys.
  deploy: {
    workflows: 'auto',
    // Which service each deploying workflow redeploys, e.g. {"deploy-mac-mini.yml": "alpaca-trader"}. The decision brief
    // names a deploy target ONLY from this mapping; a workflow without an entry says "deployment target unknown".
    // Also part of every deployment's identity for the post-deploy watch (an unmapped workflow = "unknown target").
    targets: {},
    waitMinutes: 45, // after a deploying merge, wait this long for its deploy run before asking the owner
    graceMinutes: 3, // no deploy run seen this long after the merge = the merge did not trigger one
  },
  // Post-deploy watch (#7): after a deploy finishes, the desk itself checks production at T+5 min (smoke), T+30 min
  // and the next exchange session open + 5 min, against a baseline captured at merge. The SRE model is woken only for
  // anomalies or a ticket's own "how to verify in production" criteria (budget: watch.budgetUsd per checkpoint).
  deployWatch: {
    enabled: true,
    checkpoints: { smokeMinutes: 5, settleMinutes: 30, sessionOpenOffsetMinutes: 5 },
    // NYSE calendar override/extension (src/exchange-calendar.js): { holidays: [...], earlyCloses: {date: "13:00"}, replace }
    calendar: {},
    freshnessMaxLagSeconds: 300, // an ingest source lagging more than this (while the session is open) is stale
    newSignatureMinCount: 3, // a NEW error signature seen this often after the deploy = regression suspected
    maxLogContainers: 3, // containers whose logs since the deploy are read per checkpoint
    retryMinutes: [2, 5, 10], // a checkpoint that could not observe (or saw a hard failure once) is retried after these
    overdueMinutes: 20, // a checkpoint run this late says so in its evidence
    missedHours: 6, // a smoke/T+30 checkpoint this late is not run any more: inconclusive (the desk was down)
    baselineMaxAgeMinutes: 60, // a baseline older than this before the merge is not a baseline
    sreMaxAttempts: 2, // SRE interpretation runs per checkpoint (interruptions), then inconclusive
    // Trading-path (high-risk) tickets without "How to verify in production" criteria cannot merge.
    requireCriteriaForTradingPath: true,
  },
  // Merge train: serialized merges, a free conflict check after every base move, real conflicts to the builder.
  mergeTrain: {
    enabled: true,
    updateWhenBehind: true,
    unknownGraceMinutes: 5, // a merge call that errored: only rolled back once GitHub shows it OPEN this long after // the queue front is brought up to date with the base (lazy rebase) before merging
  },
  // Owner @mentions in a ticket conversation: each tagged seat gets one capped, read-only run that answers in the
  // thread and routes real work into the normal jobs (implement, design, verify, a new task). Gates never move.
  mentions: {
    enabled: true,
    budgetUsd: 2, // hard spend cap per tagged run (Claude CLI --max-budget-usd); engines without a hard cap are refused
    maxPerTicketPerHour: 6, // tagged deliveries per ticket per hour (stops loops and runaway cost)
    maxAttempts: 3, // an interrupted tagged run is retried this many times, then fails visibly with a Retry
    // Engines with no per-run dollar cap but billed to the owner's plan (engines.*.billing = 'plan'): the bound is
    // time and steps instead. The desk stops the run at either limit. API-billed engines without a cap are refused.
    maxMinutes: 10,
    maxSteps: 60, // tool calls and commands in one tagged run
    maxActions: 30, // desk commands one tagged run may send (counted by the desk itself)
  },
  resolve: {
    budgetUsd: 1.5, // per conflict-resolution run (Claude CLI hard cap)
    resume: 'never', // 'never' | 'if-cheaper': resume the builder's session only when it is estimated cheaper
    maxAttempts: 2,
  },
  // The watch desk: deterministic log watching; the SRE seat is only woken for new, recurring error signatures.
  watch: {
    enabled: false,
    intervalSeconds: 60,
    sources: [], // {type:"loki", url, query, labelKey?, project?} | {type:"docker", containers:[...], project?} | {type:"file", path, label?, project?}
    // Case-sensitive by default: matches log levels and exception lines, not INFO lines that merely mention "errors".
    errorPattern: '\\b(ERROR|CRITICAL|FATAL)\\b|Traceback \\(most recent call last\\)|^\\s*[A-Za-z_.]*(Error|Exception)\\b:',
    errorPatternCaseInsensitive: false,
    criticalPattern: '', // matching lines skip the min-count threshold (e.g. "order rejected|margin")
    ignorePatterns: [],
    // Extra fingerprint rules, e.g. [{"pattern": "\\b[A-Z]{1,5}: No earnings", "replace": "<SYM>: No earnings"}]
    normalizers: [],
    newSignatureMinCount: 3, // bursty: this many hits inside windowMinutes
    windowMinutes: 15,
    chronicMinCount: 5, // chronic: this many hits in total (low-rate errors that never burst)
    backfillHours: 0, // on first start, also read this many hours of history
    stormSignatures: 8, // this many new signatures at once = outage: one page to the owner, no tickets
    maxInvestigationsPerHour: 4,
    regressionGraceMinutes: 45, // a resolved signature seen again after this long = regression
    // Post-deploy checkpoint interpretation by the SRE (deployWatch): a hard cap per checkpoint across its attempts, or
    // for a plan-billed engine without a cap, these time and step limits.
    budgetUsd: 1,
    maxMinutes: 10,
    maxSteps: 40,
  },
  // Push to your phone when the desk needs you (Discord/Slack webhook or an ntfy.sh topic URL).
  notify: {
    webhookUrl: '',
    boardUrl: '', // e.g. http://my-mac:8790 — used for deep links
    events: ['needs_human', 'ready_for_human', 'page', 'access'],
  },
  github: {
    sync: true,
    openDraftPrs: true, // open a PR at all after QA (name kept for compatibility)
    draftPrs: false, // open it as a draft (false = a normal open PR)
    label: 'sigmadesk',
    pollMinutes: 5,
    // Only issues authored by these logins are imported (prompt-injection guard). Empty = repo owner.
    trustedAuthors: [],
  },
  pm: {
    enabled: true,
    intervalMinutes: 720,
    maxOpenProposals: 5,
    persona: 'a quant trader and 0-5 DTE options scalper who uses this product every day',
    competitors: ['Unusual Whales', 'Cheddar Flow', 'FlowAlgo', 'Market Chameleon', 'SpotGamma', 'OptionStrat', 'Bookmap', 'TradingView', 'thinkorswim'],
  },
  // Research programs: who researches, how often, in which market window, with which sources and connectors, and who
  // must review a proposal before the manager may groom it. The default "product-discovery" program is built from
  // pm.* above; programs here add to or override it by id. Saved UI edits (settings.research_programs) win over this.
  research: {
    marketHours: { timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:30', end: '16:00' },
    // Owner-defined MCP connectors seeded as *proposed*: nothing is usable until it has a written case, an independent
    // assessment and the owner's approval (Settings → Research → Connectors). Shape per name:
    // { purpose, case (markdown, see docs/research-programs.md), binding: { type: 'stdio'|'http', command, args, url }, tools: ['tool', …] }
    connectors: {},
    programs: [],
    // Default second-person review policy for research proposals (a program may override).
    review: { minReviewers: 1, reviewers: ['trading-advisor', 'quant-research', 'principal-be'] },
  },
  sandbox: {
    enabled: true,
    allowedDomains: [], // network hosts agent shells may reach (package registries etc.). Empty = none.
    denyRead: ['~/.ssh', '~/.aws', '~/.config/gh', '~/.codex', '~/.docker', '~/.kube', '~/.gnupg', '~/.netrc', '~/Library/Keychains'],
  },
  // `desk fetch <https-url>` (#8): the DESK fetches one document for a seat (seats have no network) from these hosts
  // only (exact names, owner-editable), HTTPS only, private addresses refused, every redirect re-checked; HTML comes
  // back as plain text marked untrusted, and every fetch is a desk event.
  fetch: {
    enabled: true,
    hosts: ['docs.python.org', 'nodejs.org', 'docs.github.com'],
    maxBytes: 2_000_000,
    maxChars: 60_000,
    timeoutSeconds: 15,
    maxPerRun: 20,
  },
  // Package installs (#8): a seat asks for exact pins (`desk pkg request name==version`); the desk resolves the full
  // wheel set from PyPI only (no existing distribution in the shared venv may change version), stages it under
  // data/pkg/<id>/ and the OWNER approves the manifest; the seat then installs it offline into <workspace>/.venv,
  // layered read-only on the shared venv. The shared venv itself is never written.
  packages: {
    enabled: true,
    python: '', // the shared venv's interpreter; empty = <first project.readOnlyPaths entry with pyvenv.cfg>/bin/python
    maxPackages: 10, // pins per request
    maxFiles: 60, // wheels in one resolved set (transitive included)
    maxTotalMB: 300, // all wheels of one request together
    maxFileMB: 150,
    resolveTimeoutSeconds: 180,
    downloadTimeoutSeconds: 120, // per wheel
    grantHours: 24, // an approved set may be installed for this long (and only while its ticket is open)
    // Budgets for sets nobody approved yet: open requests per seat / per run / in total, all staged wheels together,
    // and how long an unanswered request keeps its stage.
    maxPendingPerSeat: 3,
    maxPendingPerRun: 2,
    maxPendingTotal: 10,
    maxStagedMB: 1500,
    pendingHours: 48,
    resolveProxyMB: 0, // all of one resolution's traffic through the desk proxy; 0 = max(50 MB, maxTotalMB)
    maxUnpackedMB: 1000, // one wheel's contents, unpacked (zip-bomb guard when the desk reads its RECORD)
    // The resolver's interpreter may not live under these (nor under the workspaces): places seats can write.
    untrustedRoots: [os.tmpdir(), '/tmp', '/private/tmp'],
  },
  // Production read access ("desk ops"): named, read-only probes the DESK runs for SRE/DBA seats. Seats never get
  // credentials or a shell on the host. Off unless ops.enabled here AND the owner's Settings toggle (ops_enabled).
  // See README "Production read access" and scripts/provision-role.sql.
  ops: {
    enabled: false,
    // Run kinds in which a seat holding a grant may probe. WHO may probe is decided by grants (access.*), not here.
    kinds: ['investigate', 'consult', 'verify', 'design', 'mention', 'watch'],
    // Host psql binary (a path, or [path, ...fixed args]). Empty = `psql` on PATH. Wrappers that reach into containers
    // (docker/podman/kubectl exec, ssh, a shell) are refused: credentials stay in the owner's pgpass/service file.
    psql: '',
    pgpassFile: '', // e.g. ~/.pgpass-sigmadesk (chmod 600); never readable by seats (added to the sandbox deny list)
    pgServiceFile: '', // optional pg_service.conf; a database may name a service instead of host/port/dbname/user
    // name -> { service } | { host, port, dbname, user }. Passwords only ever come from pgpassFile / the service file.
    databases: {},
    // Ingest freshness: [{ label?, db }]. The tables, time columns and filters live in the database function
    // sigmadesk_ops.ingest_freshness (scripts/provision-role.sql); a label here limits the output to that source.
    freshness: [],
    docker: '', // docker CLI path; empty = `docker` on PATH
    containers: [], // the only containers container_status / container_logs may name
    // app_health GETs only this liveness path (never diagnostics that make the app query its database).
    appHealth: { baseUrl: 'http://127.0.0.1:8001', path: '/health' },
    // Extra files whose values must never appear in probe output (besides pgpassFile / pgServiceFile).
    secretFiles: ['~/.sigmadesk-ro-verifier'],
    maxBytes: 16000, // per probe result handed to a seat
    cacheSeconds: 60,
    queueMax: 4, // DB probes waiting behind the one in flight
    workMem: '4MB',
    tempFileLimit: '64MB',
    normal: { statementMs: 15000, lockMs: 1000, idleMs: 10000, perRun: 12, perHour: 60, maxLogHours: 6, maxFreshnessMinutes: 1440, maxTail: 400 },
    // Busy window (limits.busyWindow when enabled, else research.marketHours): tighter everything.
    busy: { statementMs: 3000, lockMs: 500, idleMs: 5000, perRun: 4, perHour: 20, maxLogHours: 1, maxFreshnessMinutes: 120, maxTail: 200 },
  },
  // Who gets production read access, for how long: time-boxed, revocable grants. The owner grants anything; the EM and
  // the SRE may approve a seat's request within this policy (never for themselves); anything beyond it goes to the
  // owner's Inbox. Saved Access-sheet edits (settings.access_policy) win over this.
  access: {
    policy: {
      approvers: ['manager', 'sre'],
      seats: ['sre', 'dba', 'principal-be', 'principal-fe'],
      probes: ['*'], // probe ids, or ["*"] for every read-only probe
      maxMinutes: 240, // longest timed grant an agent approver may give (ticket-scoped grants end with the ticket)
      maxActive: 3, // active agent-approved grants at once
      ticketMaxHours: 24, // hard cap on a ticket- or run-scoped grant
      // The owner tagged a seat in a ticket conversation: a read-only probe request from that tagged run is granted for
      // that run only (at most 60 min), within this policy. Approver seats and renewals still go to the owner.
      ownerMentionAutoGrant: true,
      // Post-deploy checkpoint runs get a run-bound grant to exactly the probes the checkpoint needs, expiring with the
      // run, re-checked at every probe (switching this off ends them). Off unless the owner opts in.
      postDeployAutoGrant: false,
    },
  },
  // Delegation (#9): the Engineering Manager (Morgan) or the SRE (Devon) decides some owner decisions for the owner. Per
  // kind a mode: owner (you decide; nothing runs), shadow (the delegate decides, it is recorded and shown, and you still
  // decide), em / sre (that seat decides for you; you can override or reopen it). Saved Settings → Autonomy edits win
  // over the kinds here; enabled: false (or SIGMADESK_DELEGATION=off) makes every kind yours whatever is saved.
  // Budget, policies, merges, publish guards, reverts, hold releases, standing or renewal grants, packages and this
  // matrix itself are never delegable.
  delegation: {
    enabled: true,
    kinds: { owner_task: 'shadow', question: 'shadow', research: 'shadow', loop_limit: 'shadow', design: 'shadow' },
    peerAccess: false, // the EM and the SRE may approve each other's ticket-bound production read access (renewals stay yours)
    budgetUsd: 0.75, // hard spend cap per decision attempt on an engine that enforces one (Claude)
    maxMinutes: 6, // plan-billed engines without a dollar cap (Codex): time and step bounds per attempt
    maxSteps: 30,
    maxActions: 12, // desk commands one decision run may send (counted by the desk itself)
    maxWaitMinutes: 30, // a delegated decision not started within this comes to you, explained
    maxPerDay: 40, // decision runs per day across every kind
    research: { maxCorrections: 1, maxSpendUsd: 1.5 }, // per proposal over its whole life (survives revisions)
    loopLimit: { maxRescopes: 1 }, // per ticket
    // The playbook heading under which the OWNER lists the standing rules a delegate may apply alone. Only those rules
    // can be cited; with no such section (or an empty one) every delegated decision stays the owner's.
    rulesSection: 'Standing rules the EM may apply alone',
  },
  // Per-agent overrides keyed by agent id, e.g. {"junior": {"model": "haiku"}, "pm": {"enabled": false}}
  team: {},
  // Agents' Bash tool snapshots this shell's aliases; a plain bash avoids personal aliases (grep→rg, find→fd, ...).
  bins: { claude: '', gh: '', git: 'git', agentShell: '/bin/bash' },
  // Optional extra engines. codex.bin is auto-detected from PATH (and common Node version-manager dirs) if empty.
  engines: {
    autoFallback: true,
    fallbackCooldownMinutes: 15,
    // billing: 'plan' = runs draw on the owner's ChatGPT plan (no per-dollar spend); 'api' = metered per token.
    codex: { bin: '', models: [], pricing: null, reserveUsd: 2, billing: 'plan' },
    // Extra Claude Code model ids offered to seats besides fable/opus/sonnet/haiku (access is checked on use).
    claude: { models: [] },
    // Perplexity thinking seats: the desk builds a context pack the local relay must send verbatim.
    perplexity: {
      contextMaxChars: 60000, // hard cap on the whole outgoing message (pack + task + relay additions)
      relayReserveChars: 8000, // part of that cap left for the task paragraph and relay additions
      remoteWaitMinutes: 8, // how long the relay polls a pending thread; run watchdogs are raised above it
      followupRounds: 1, // follow-ups on the same thread with files the model asked for
      prepareDeadlineSeconds: 45, // total time to build a pack (git work is cancelled after this; the run is refused)
      pageChars: 0, // max size of one `desk context-file` page; 0 = contextMaxChars - relayReserveChars
      pageRounds: 6, // follow-ups that only carry requested file pages
      maxRunMinutes: 90, // cap on a Perplexity run's timeout; fewer page rounds are allowed if the cap is lower
      secretPatterns: [], // extra high-confidence secret formats (regex strings) that stop a run, e.g. a broker's key shape
      models: [], // extra Perplexity model ids besides the built-in catalog and data/perplexity-models.json (npm run models:refresh)
      // Let Perplexity models sit on engineering councils. Off until docs/perplexity-connection.md has been verified:
      // a Computer task cannot be cancelled remotely and bills account credits.
      councilEnabled: false,
    },
  },
  advisors: {
    // Optional JSON file with perplexity/gemini/xai keys. Never expose it to a seat.
    keyFile: '',
    reserveUsd: 1,
    timeoutSeconds: 120,
    maxOutputTokens: 3000,
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}

function which(bin) {
  try { return execFileSync('/usr/bin/env', ['which', bin], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

// Services often start with a minimal PATH; look where nvm / mise / volta / fnm install global CLIs.
function findInNodeManagers(bin) {
  const home = os.homedir();
  const roots = [path.join(home, '.local/share/mise/installs/node'), path.join(home, '.nvm/versions/node'), path.join(home, '.volta/bin'), path.join(home, '.fnm/node-versions')];
  for (const r of roots) {
    try {
      if (fs.existsSync(path.join(r, bin))) return path.join(r, bin);
      for (const v of fs.readdirSync(r).sort().reverse()) {
        for (const cand of [path.join(r, v, 'bin', bin), path.join(r, v, 'installation', 'bin', bin)]) if (fs.existsSync(cand)) return cand;
      }
    } catch { /* not installed */ }
  }
  return '';
}

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// SIGMADESK_HOME selects a project home in the per-user application folder (see app-paths.js); unset = legacy layout.
const homeOf = (env) => (env.SIGMADESK_HOME ? path.resolve(expandHome(env.SIGMADESK_HOME)) : null);
export function loadConfig(file = deskPaths({ home: homeOf(process.env), legacyRoot: ROOT }).configFile) {
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = deepMerge(DEFAULTS, fromFile);
  const env = process.env;
  if (env.SIGMADESK_PORT) c.server.port = Number(env.SIGMADESK_PORT);
  if (env.SIGMADESK_HOSTS) c.server.hosts = env.SIGMADESK_HOSTS.split(',').filter(Boolean);
  if (env.SIGMADESK_TOKEN) c.server.ownerToken = env.SIGMADESK_TOKEN;
  if (env.SIGMADESK_REPO_PATH) c.project.repoPath = env.SIGMADESK_REPO_PATH;
  if (env.SIGMADESK_GITHUB_REPO) c.project.githubRepo = env.SIGMADESK_GITHUB_REPO;
  // Delegation (#9): SIGMADESK_DELEGATION=off|on, SIGMADESK_DELEGATION_<KIND>=owner|shadow|em|sre (e.g.
  // SIGMADESK_DELEGATION_QUESTION=em), SIGMADESK_DELEGATION_PEER_ACCESS=true|false.
  c.delegation = { ...c.delegation, kinds: { ...(c.delegation.kinds || {}) } }; // never mutate the shared defaults
  if (env.SIGMADESK_DELEGATION) c.delegation.enabled = !/^(off|false|0|no)$/i.test(env.SIGMADESK_DELEGATION);
  for (const k of Object.keys(c.delegation.kinds || {})) { const v = env[`SIGMADESK_DELEGATION_${k.toUpperCase()}`]; if (v) c.delegation.kinds[k] = v.trim().toLowerCase(); }
  if (env.SIGMADESK_DELEGATION_PEER_ACCESS) c.delegation.peerAccess = /^(on|true|1|yes)$/i.test(env.SIGMADESK_DELEGATION_PEER_ACCESS);

  c.project.repoPath = expandHome(c.project.repoPath);
  const home = homeOf(env);
  // A relative playbook resolves inside the project home first (new projects keep their playbook there), then the checkout.
  const rel = expandHome(c.project.playbook);
  c.project.playbook = path.isAbsolute(rel) ? rel : home && fs.existsSync(path.join(home, rel)) ? path.join(home, rel) : path.join(ROOT, rel);
  c.project.readOnlyPaths = c.project.readOnlyPaths.map(expandHome);
  c.advisors.keyFile = expandHome(c.advisors.keyFile);
  c.ops.pgpassFile = expandHome(c.ops.pgpassFile);
  c.ops.pgServiceFile = expandHome(c.ops.pgServiceFile);
  c.packages.python = expandHome(c.packages.python || '');
  const pathClaude = which('claude');
  c.bins.claude = c.bins.claude || (pathClaude && !wrapperProblem(pathClaude) ? pathClaude : path.join(os.homedir(), '.local/bin/claude'));
  c.bins.gh = c.bins.gh || which('gh') || 'gh';
  c.engines.codex.bin = c.engines.codex.bin || which('codex') || findInNodeManagers('codex') || '';
  if (!c.project.githubRepo && c.project.repoPath) {
    try {
      const url = execFileSync('git', ['-C', c.project.repoPath, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
      c.project.githubRepo = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] || '';
    } catch { /* not a github checkout */ }
  }
  c.project.githubOwner = c.project.githubRepo.split('/')[0] || '';
  if (!c.github.trustedAuthors.length && c.project.githubOwner) c.github.trustedAuthors = [c.project.githubOwner];

  c.root = ROOT;
  // Agents talk to the desk over a unix socket (the sandbox allowlists it; the TCP UI port stays unreachable). Real
  // paths matter: the sandbox matches resolved paths.
  const p = deskPaths({ home, legacyRoot: fs.realpathSync(ROOT), env, port: c.server.port });
  c.projectId = p.id; c.home = p.home; c.appRoot = p.appRoot;
  c.dataDir = p.dataDir; // desk-owned state: db, publisher repo, context packs, desk Codex home
  c.dbPath = p.dbPath;
  c.runDir = p.runDir;
  c.socketPath = p.socketPath;
  c.workspaceRoot = p.workspaceRoot;
  c.logDir = p.logDir;
  c.configFile = file;
  return c;
}

export const config = loadConfig();

// The desk-owned bare repo (publishing, PR reconciliation, context packs). Always under dataDir.
export const publisherPath = (c = config) => path.join(c.dataDir, 'publisher.git');

// A shell wrapper that injects --dangerously-skip-permissions / --add-dir / would silently void the sandbox.
export function wrapperProblem(bin) {
  try {
    const head = fs.readFileSync(bin, { encoding: 'utf8', flag: 'r' }).slice(0, 4096);
    if (head.startsWith('#!') && /dangerously|bypassPermissions|--add-dir\s+\/(\s|"|$)|--permission-mode/.test(head)) {
      return `${bin} is a wrapper script that changes permissions (${head.split('\n').slice(1, 3).join(' ').slice(0, 120)}). Point bins.claude at the real CLI (e.g. ~/.local/bin/claude).`;
    }
  } catch { /* binary or unreadable: fine */ }
  return null;
}

// project.env reaches every seat: an explicit schema. Names are plain env names that do not look secret; values are short
// plain strings that do not look like credentials (URLs with passwords, DSNs, API keys, private keys, long tokens).
const AGENT_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|_KEY$|^KEY$|_KEY_|DSN|DATABASE_URL|_URI$|_URL$|CREDENTIAL|PRIVATE|COOKIE|SESSION|^PG|^AWS_|^GCP_|^AZURE_|^APCA_|^ALPACA_|^POLYGON_|^MASSIVE_|^IBKR_|^GH_|^GITHUB_|^NPM_|^OPENAI_|^ANTHROPIC_)/;
export function credentialLike(value) {
  const v = String(value ?? '');
  return /:\/\/[^\s/@]*:[^\s/@]*@/.test(v) // scheme://user:password@
    || /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|amqps?|mssql|sqlserver|clickhouse|snowflake|jdbc:[a-z]+):/i.test(v)
    || /\b(sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{16,}|github_pat_\w{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|AIza[\w-]{30,})/.test(v)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)
    || /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=/i.test(v)
    || /^[A-Za-z0-9+/_=-]{32,}$/.test(v); // a long opaque token
}
/** Why a project.env entry may not reach seats, or null. */
export function agentEnvProblem(name, value) {
  if (!AGENT_ENV_NAME.test(name)) return `project.env.${name}: names must be UPPER_SNAKE_CASE`;
  if (SECRET_ENV_NAME.test(name)) return `project.env.${name}: looks like a credential name; seats never get credentials`;
  if (!['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 1000) return `project.env.${name}: must be a short string`;
  if (credentialLike(value)) return `project.env.${name}: the value looks like a credential (URL with a password, DSN, key or token)`;
  return null;
}

export function validateConfig(c = config) {
  const problems = [];
  if (!c.project.repoPath || !fs.existsSync(path.join(c.project.repoPath, '.git'))) problems.push('project.repoPath must point at a git checkout');
  const claudeInstalled = fs.existsSync(c.bins.claude);
  const codexInstalled = !!c.engines.codex.bin && fs.existsSync(c.engines.codex.bin);
  if (!claudeInstalled && !codexInstalled) problems.push('install a Claude Code or Codex CLI');
  if (claudeInstalled) {
    const w = wrapperProblem(c.bins.claude);
    if (w) problems.push(w);
  }
  for (const [k, v] of Object.entries(c.project.env || {})) { const why = agentEnvProblem(k, v); if (why) problems.push(`${why} (it is withheld from seats)`); }
  const dt = c.deploy?.targets;
  if (dt != null && (typeof dt !== 'object' || Array.isArray(dt) || !Object.values(dt).every((v) => (typeof v === 'string' && v.trim()) || (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && x.trim())))))
    problems.push('deploy.targets must map workflow file names to a service name or a list of service names');
  const home = os.homedir();
  for (const p of c.project.readOnlyPaths || []) if (path.resolve(p) === home || home.startsWith(`${path.resolve(p)}/`)) problems.push(`project.readOnlyPaths: ${p} would expose your home folder to every seat`);
  const hostRe = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  if (!Array.isArray(c.fetch?.hosts) || !c.fetch.hosts.every((h) => typeof h === 'string' && hostRe.test(h) && !/^\d+(\.\d+)*$/.test(h)))
    problems.push('fetch.hosts must be a list of exact lowercase host names (no IP addresses, wildcards, schemes or ports)');
  if (c.github.sync && !c.project.githubRepo) problems.push('github.sync is on but project.githubRepo is unknown');
  if (!fs.existsSync(c.project.playbook)) problems.push(`playbook not found: ${c.project.playbook}`);
  if (!(c.engines.fallbackCooldownMinutes >= 1 && c.engines.fallbackCooldownMinutes <= 1440)) problems.push('engines.fallbackCooldownMinutes must be between 1 and 1440');
  const px = c.engines.perplexity || {};
  if (!(px.contextMaxChars >= 10000 && px.contextMaxChars <= 400000)) problems.push('engines.perplexity.contextMaxChars must be between 10000 and 400000');
  if (!(px.remoteWaitMinutes >= 1 && px.remoteWaitMinutes <= 60)) problems.push('engines.perplexity.remoteWaitMinutes must be between 1 and 60');
  if (!(Number.isInteger(px.pageRounds) && px.pageRounds >= 1 && px.pageRounds <= 20)) problems.push('engines.perplexity.pageRounds must be 1-20');
  if (!(px.pageChars === 0 || (px.pageChars >= 2000 && px.pageChars <= px.contextMaxChars))) problems.push('engines.perplexity.pageChars must be 0 or between 2000 and contextMaxChars');
  for (const src of px.secretPatterns || []) { try { new RegExp(src); } catch { problems.push(`engines.perplexity.secretPatterns: invalid regex ${src}`); } }
  if (!(px.maxRunMinutes >= 15 && px.maxRunMinutes <= 240)) problems.push('engines.perplexity.maxRunMinutes must be between 15 and 240');
  if (!(px.prepareDeadlineSeconds >= 5 && px.prepareDeadlineSeconds <= 300)) problems.push('engines.perplexity.prepareDeadlineSeconds must be between 5 and 300');
  if (!(Number.isInteger(px.followupRounds) && px.followupRounds >= 0 && px.followupRounds <= 3)) problems.push('engines.perplexity.followupRounds must be 0-3');
  if (typeof px.councilEnabled !== 'boolean') problems.push('engines.perplexity.councilEnabled must be true or false');
  const rs = c.research || {};
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
  const tzOk = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  const mh = rs.marketHours || {};
  if (!tzOk(mh.timezone) || !Array.isArray(mh.days) || !mh.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) || !hhmm(mh.start) || !hhmm(mh.end) || mh.start >= mh.end)
    problems.push('research.marketHours needs a valid timezone, days 0-6, and HH:MM start before end on the same day');
  if (!Array.isArray(rs.programs) || !rs.programs.every((p) => p && typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id))) problems.push('research.programs must be a list of programs with kebab-case ids');
  if (!rs.connectors || typeof rs.connectors !== 'object' || Array.isArray(rs.connectors) || !Object.keys(rs.connectors).every((k) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(k))) problems.push('research.connectors must map kebab-case names to connector definitions');
  if (!(Number.isInteger(rs.review?.minReviewers) && rs.review.minReviewers >= 1 && rs.review.minReviewers <= 3) || !Array.isArray(rs.review?.reviewers)) problems.push('research.review needs minReviewers 1-3 and a reviewers list');
  // Post-deploy watch calendar (#7): a bad override must fail at load, never inside a deploy-lock release.
  const dwc = c.deployWatch?.calendar || {};
  const day = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
  if (dwc.timezone !== undefined && !tzOk(dwc.timezone)) problems.push(`deployWatch.calendar.timezone "${dwc.timezone}" is not a time zone`);
  if ((dwc.open !== undefined && !hhmm(dwc.open)) || (dwc.close !== undefined && !hhmm(dwc.close)) || (dwc.open && dwc.close && dwc.open >= dwc.close)) problems.push('deployWatch.calendar open/close must be HH:MM with open before close');
  if (dwc.holidays !== undefined && !(Array.isArray(dwc.holidays) && dwc.holidays.every(day))) problems.push('deployWatch.calendar.holidays must be a list of YYYY-MM-DD dates');
  if (dwc.earlyCloses !== undefined && !(dwc.earlyCloses && typeof dwc.earlyCloses === 'object' && Object.entries(dwc.earlyCloses).every(([d, t]) => day(d) && hhmm(t)))) problems.push('deployWatch.calendar.earlyCloses must map YYYY-MM-DD to HH:MM');
  if (dwc.years !== undefined && !(Array.isArray(dwc.years) && dwc.years.every((y) => Number.isInteger(y) && y >= 2000 && y < 2100))) problems.push('deployWatch.calendar.years must be a list of years');
  // Delegation (#9): an unknown kind or a mode the kind cannot take is a mistake, never silently "the owner's".
  const dlg = c.delegation || {};
  for (const [k, m] of Object.entries(dlg.kinds || {})) {
    if (!DELEGATION_KINDS[k]) problems.push(`delegation.kinds.${k}: unknown decision kind (${Object.keys(DELEGATION_KINDS).join(', ')})`);
    else if (!validDelegationMode(k, m)) problems.push(`delegation.kinds.${k} must be owner, shadow or ${DELEGATION_KINDS[k].delegates.join(' or ')}`);
  }
  if (dlg.enabled !== undefined && typeof dlg.enabled !== 'boolean') problems.push('delegation.enabled must be true or false');
  if (dlg.peerAccess !== undefined && typeof dlg.peerAccess !== 'boolean') problems.push('delegation.peerAccess must be true or false');
  if (dlg.rulesSection !== undefined && !(typeof dlg.rulesSection === 'string' && dlg.rulesSection.trim() && dlg.rulesSection.length <= 120 && !/[\n#]/.test(dlg.rulesSection)))
    problems.push('delegation.rulesSection must be a playbook heading (text without #, at most 120 characters)');
  const modelList = (v) => Array.isArray(v) && v.every((id) => typeof id === 'string' && /^[\w.:-]{1,80}$/.test(id));
  for (const id of ['claude', 'codex', 'perplexity']) if (!modelList(c.engines[id]?.models)) problems.push(`engines.${id}.models must be a list of model ids`);
  if (!(c.advisors.reserveUsd > 0 && c.advisors.timeoutSeconds >= 5 && c.advisors.timeoutSeconds <= 300 && c.advisors.maxOutputTokens >= 256 && c.advisors.maxOutputTokens <= 8000)) problems.push('invalid advisor reservation, timeout or output-token limit');
  return problems;
}
