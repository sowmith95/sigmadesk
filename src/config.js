// Configuration: built-in defaults ← sigmadesk.config.json ← SIGMADESK_* env vars.
// Everything machine- or project-specific lives in the config file (gitignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
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
    runTimeoutMin: { implement: 45, qa: 20, review: 20, pr_review: 25, respond: 45, resolve: 30, triage: 8, groom: 20, research: 30, consult: 10, investigate: 20, design: 20, council_review: 5 },
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
    waitMinutes: 45, // after a deploying merge, wait this long for its deploy run before asking the owner
    graceMinutes: 3, // no deploy run seen this long after the merge = the merge did not trigger one
  },
  // Merge train: serialized merges, a free conflict check after every base move, real conflicts to the builder.
  mergeTrain: {
    enabled: true,
    updateWhenBehind: true,
    unknownGraceMinutes: 5, // a merge call that errored: only rolled back once GitHub shows it OPEN this long after // the queue front is brought up to date with the base (lazy rebase) before merging
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
  },
  // Push to your phone when the desk needs you (Discord/Slack webhook or an ntfy.sh topic URL).
  notify: {
    webhookUrl: '',
    boardUrl: '', // e.g. http://my-mac:8790 — used for deep links
    events: ['needs_human', 'ready_for_human', 'page'],
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
  sandbox: {
    enabled: true,
    allowedDomains: [], // network hosts agent shells may reach (package registries etc.). Empty = none.
    denyRead: ['~/.ssh', '~/.aws', '~/.config/gh', '~/.codex', '~/.docker', '~/.kube', '~/.gnupg', '~/.netrc', '~/Library/Keychains'],
  },
  // Per-agent overrides keyed by agent id, e.g. {"junior": {"model": "haiku"}, "pm": {"enabled": false}}
  team: {},
  // Agents' Bash tool snapshots this shell's aliases; a plain bash avoids personal aliases (grep→rg, find→fd, ...).
  bins: { claude: '', gh: '', git: 'git', agentShell: '/bin/bash' },
  // Optional extra engines. codex.bin is auto-detected from PATH (and common Node version-manager dirs) if empty.
  engines: {
    autoFallback: true,
    fallbackCooldownMinutes: 15,
    codex: { bin: '', models: [], pricing: null, reserveUsd: 2 },
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

export function loadConfig(file = process.env.SIGMADESK_CONFIG || path.join(ROOT, 'sigmadesk.config.json')) {
  let fromFile = {};
  if (fs.existsSync(file)) fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const c = deepMerge(DEFAULTS, fromFile);
  const env = process.env;
  if (env.SIGMADESK_PORT) c.server.port = Number(env.SIGMADESK_PORT);
  if (env.SIGMADESK_HOSTS) c.server.hosts = env.SIGMADESK_HOSTS.split(',').filter(Boolean);
  if (env.SIGMADESK_TOKEN) c.server.ownerToken = env.SIGMADESK_TOKEN;
  if (env.SIGMADESK_REPO_PATH) c.project.repoPath = env.SIGMADESK_REPO_PATH;
  if (env.SIGMADESK_GITHUB_REPO) c.project.githubRepo = env.SIGMADESK_GITHUB_REPO;

  c.project.repoPath = expandHome(c.project.repoPath);
  c.project.playbook = path.isAbsolute(expandHome(c.project.playbook)) ? expandHome(c.project.playbook) : path.join(ROOT, c.project.playbook);
  c.project.readOnlyPaths = c.project.readOnlyPaths.map(expandHome);
  c.advisors.keyFile = expandHome(c.advisors.keyFile);
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
  c.dbPath = env.SIGMADESK_DB || path.join(ROOT, 'data', 'sigmadesk.db');
  // Agents talk to the desk over this unix socket (the sandbox allowlists it; the TCP UI port stays unreachable).
  // Real path matters: the sandbox matches resolved paths. macOS caps socket paths at 104 bytes.
  c.socketPath = env.SIGMADESK_SOCKET || path.join(fs.realpathSync(ROOT), 'run', 'agent.sock');
  if (c.socketPath.length > 100) c.socketPath = path.join(fs.realpathSync(os.tmpdir()), `sigmadesk-${c.server.port}.sock`);
  c.workspaceRoot = env.SIGMADESK_WORKSPACES || path.join(fs.realpathSync(ROOT), 'workspaces');
  c.configFile = file;
  return c;
}

export const config = loadConfig();

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
  if (c.github.sync && !c.project.githubRepo) problems.push('github.sync is on but project.githubRepo is unknown');
  if (!fs.existsSync(c.project.playbook)) problems.push(`playbook not found: ${c.project.playbook}`);
  if (!(c.engines.fallbackCooldownMinutes >= 1 && c.engines.fallbackCooldownMinutes <= 1440)) problems.push('engines.fallbackCooldownMinutes must be between 1 and 1440');
  if (!(c.advisors.reserveUsd > 0 && c.advisors.timeoutSeconds >= 5 && c.advisors.timeoutSeconds <= 300 && c.advisors.maxOutputTokens >= 256 && c.advisors.maxOutputTokens <= 8000)) problems.push('invalid advisor reservation, timeout or output-token limit');
  return problems;
}
