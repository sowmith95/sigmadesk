import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { agentById, charterFor, permissionsFor, promptFor, DENY_RULES } from './team.js';
import { ENGINES } from './engines/index.js';
import { describeToolUse } from './engines/claude.js';
import { selectionFor, reviewSelection, classifyProviderFailure, holdProvider } from './dispatch.js';
import * as store from './db.js';

const pexec = promisify(execFile);
const children = new Map(); // runId -> ChildProcess

// ---------------- engine stream → readable activity ----------------
const short = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export { describeToolUse };

export function todoProgress(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  return { pct: Math.round((done / todos.length) * 100), msg: cur ? cur.activeForm || cur.content || cur.text : `${done}/${todos.length} steps done` };
}

// Commands each run executed and whether they succeeded: the evidence QA must show before it may pass.
const evidence = new Map(); // runId -> { pending: Map(id -> cmd), done: [{cmd, ok}] }
export function evidenceFor(runId) { return evidence.get(runId)?.done || []; }

// Apply an engine's normalized events to the desk (activity log, presence, progress, result).
export function applyEvents(events, ctx) {
  const { run } = ctx;
  const base = { run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key };
  for (const e of events) {
    switch (e.type) {
      case 'session': store.updateRun(run.id, { session_id: e.id }); break;
      case 'say':
        ctx.state.lastSay = e.text;
        store.logEvent({ ...base, kind: 'say', text: short(e.text, 1200) });
        if (ctx.presence !== false) store.updateAgent(run.agent_id, { last_action: short(e.text, 140), last_action_at: store.now() });
        break;
      case 'tool':
        store.logEvent({ ...base, kind: 'tool', text: e.text });
        if (ctx.presence !== false) store.updateAgent(run.agent_id, { last_action: e.text, last_action_at: store.now() });
        break;
      case 'todos': {
        const todos = e.todos.map((t) => ({ ...t, content: t.text, activeForm: t.active }));
        const p = todoProgress(todos);
        if (!p) break;
        if (run.ticket_key && run.kind === 'implement') store.updateTicket(run.ticket_key, { progress: Math.max(5, Math.min(95, p.pct)), progress_msg: p.msg });
        store.logEvent({ ...base, kind: 'plan', text: todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.text}`).join('\n') });
        break;
      }
      case 'error': ctx.state.lastError = e.text; store.logEvent({ ...base, kind: 'error', text: short(e.text, 300) }); break;
      case 'wait': store.logEvent({ ...base, kind: 'system', text: e.text }); break;
      case 'cmd-start': {
        const ev = evidence.get(run.id) || { pending: new Map(), done: [] };
        ev.pending.set(e.id, e.cmd);
        evidence.set(run.id, ev);
        break;
      }
      case 'cmd-end': {
        const ev = evidence.get(run.id);
        const cmd = ev?.pending.get(e.id);
        if (cmd != null) { ev.done.push({ cmd, ok: e.ok }); ev.pending.delete(e.id); }
        break;
      }
      case 'quota': {
        const w = e.info.unifiedWindows || {};
        const q = { engine: e.engine, status: e.info.status, five_hour: w.five_hour?.utilization ?? null, seven_day: w.seven_day?.utilization ?? null,
          resets_at: e.info.resetsAt ? new Date(e.info.resetsAt * 1000).toISOString() : null,
          five_hour_resets_at: w.five_hour?.resetsAt ? new Date(w.five_hour.resetsAt * 1000).toISOString() : null,
          seven_day_resets_at: w.seven_day?.resetsAt ? new Date(w.seven_day.resetsAt * 1000).toISOString() : null, at: store.now() };
        store.kvSet(`quota:${e.engine}`, JSON.stringify(q));
        store.bus.emit('msg', { type: 'quota', data: q });
        if (q.status && q.status !== 'allowed') store.logEvent({ ...base, kind: 'system', text: `plan limit: ${q.status} until ${q.resets_at || '?'}` });
        break;
      }
      case 'result': ctx.result = { is_error: !e.ok, subtype: e.subtype, total_cost_usd: e.costUsd || 0, cost_known: e.costKnown !== false, num_turns: e.turns ?? null, errors: e.errors || [], result: e.text || ctx.state.lastSay || '', usage: e.usage }; break;
      default: break;
    }
  }
}

// Back-compat helper used by tests: parse one Claude stream-json line.
export function handleStreamLine(line, ctx) {
  ctx.state ||= {};
  applyEvents(ENGINES.claude.parse(line, ctx.cwd, ctx.state), ctx);
}

// ---------------- per-ticket workspaces (isolated local clones) ----------------
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}

let gitLock = Promise.resolve();
export function withGitLock(fn) {
  const p = gitLock.then(fn, fn);
  gitLock = p.catch(() => {});
  return p;
}
const git = (args, opts = {}) => pexec(config.bins.git, args, { timeout: 180_000, maxBuffer: 16 << 20, ...opts });

export const workspaceDir = (key) => path.join(config.workspaceRoot, key);

// Clones made before --no-hardlinks share object files with the owner's repo. Give every such file its own inode
// (copy + atomic rename), which leaves the owner's file untouched and is safe while the clone is in use.
export function breakHardlinks(dir) {
  const root = path.join(dir, '.git', 'objects');
  if (!fs.existsSync(root)) return 0;
  let fixed = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.statSync(p).nlink > 1) {
        const tmp = `${p}.unlink-${process.pid}`;
        fs.copyFileSync(p, tmp);
        fs.chmodSync(tmp, fs.statSync(p).mode);
        fs.renameSync(tmp, p);
        fixed += 1;
      }
    }
  };
  walk(root);
  return fixed;
}

// A clone (not a worktree): its own .git inside the sandbox-writable dir, and none of the main checkout's hooks.
export function ensureWorkspace(ticket) {
  return withGitLock(async () => {
    const dir = workspaceDir(ticket.key);
    const branch = ticket.branch || `${config.project.branchPrefix}${ticket.key.toLowerCase()}-${slugify(ticket.title)}`;
    const base = config.project.baseBranch;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
      // --no-hardlinks: a hardlinked object edited in a clone would corrupt the owner's checkout.
      await git(['clone', '--quiet', '--no-hardlinks', config.project.repoPath, dir]);
      const { stdout: origin } = await git(['-C', config.project.repoPath, 'remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }));
      if (origin.trim()) {
        await git(['-C', dir, 'remote', 'set-url', 'origin', origin.trim()]);
        await git(['-C', dir, 'fetch', '--quiet', 'origin', base]);
      }
      const remoteBranch = await git(['-C', dir, 'ls-remote', '--heads', 'origin', branch]).then((r) => r.stdout.trim()).catch(() => '');
      if (remoteBranch) {
        await git(['-C', dir, 'fetch', '--quiet', 'origin', branch]);
        await git(['-C', dir, 'checkout', '-q', '-b', branch, `origin/${branch}`]);
      } else {
        await git(['-C', dir, 'checkout', '-q', '-b', branch, `origin/${base}`]);
      }
      for (const p of config.project.copyPaths) {
        const src = path.join(config.project.repoPath, p);
        const dst = path.join(dir, p);
        if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        // APFS copy-on-write clone when available (instant, no extra disk); plain copy otherwise.
        await pexec('cp', os.platform() === 'darwin' ? ['-cR', src, dst] : ['-R', '--reflink=auto', src, dst], { timeout: 600_000 })
          .catch(() => pexec('cp', ['-R', src, dst], { timeout: 600_000 }));
      }
    }
    breakHardlinks(dir);
    return { dir, branch };
  });
}

// Shared scratch clone for read-only seats (PM research, grooming, consults, triage), reset to the base
// branch before each use, so nothing ever runs with the owner's real checkout as a writable cwd.
export function ensureReadonlyWorkspace(seatId = 'scratch') {
  return withGitLock(async () => {
    if (!/^[a-z0-9-]+$/.test(seatId)) throw new Error('invalid scratch seat');
    const dir = path.join(config.workspaceRoot, `_desk-${seatId}`);
    const base = config.project.baseBranch;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
      await git(['clone', '--quiet', '--no-hardlinks', config.project.repoPath, dir]);
      const { stdout: origin } = await git(['-C', config.project.repoPath, 'remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }));
      if (origin.trim()) await git(['-C', dir, 'remote', 'set-url', 'origin', origin.trim()]);
    }
    breakHardlinks(dir);
    const hasOrigin = await git(['-C', dir, 'remote']).then((r) => r.stdout.includes('origin'));
    const lastFetch = fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD')) ? fs.statSync(path.join(dir, '.git', 'FETCH_HEAD')).mtimeMs : 0;
    if (hasOrigin && Date.now() - lastFetch > 10 * 60_000) await git(['-C', dir, 'fetch', '--quiet', 'origin', base]).catch(() => {});
    await git(['-C', dir, 'checkout', '-q', '--detach', `origin/${base}`]).catch(() => git(['-C', dir, 'checkout', '-q', base]));
    await git(['-C', dir, 'reset', '-q', '--hard']);
    await git(['-C', dir, 'clean', '-qfd']);
    return dir;
  });
}

export const headSha = async (dir) => (await git(['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();

export async function commitsAhead(dir) {
  try {
    const { stdout } = await git(['-C', dir, 'rev-list', '--count', `origin/${config.project.baseBranch}..HEAD`]);
    return Number(stdout.trim());
  } catch { return 0; }
}

// ---------------- publisher: a desk-owned bare repo ----------------
// Agent clones are untrusted (their .git/config can set sshCommand, fsmonitor, filters, hooks…). The publisher only
// FETCHES objects out of a clone into a bare repo the desk owns, computes the guard diff there against the OWNER's
// base commit, and pushes from there. No git command ever runs with a clone's config.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'core.sshCommand=ssh'];
const publisherDir = () => path.join(config.root, 'data', 'publisher.git');
async function publisher() {
  const dir = publisherDir();
  if (!fs.existsSync(path.join(dir, 'HEAD'))) await git(['init', '-q', '--bare', dir]);
  return dir;
}
export async function stageApproved(key, cloneDir, sha) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error('refusing to publish without an approved commit SHA');
  return withGitLock(async () => {
    const pub = await publisher();
    const base = config.project.baseBranch;
    // Trusted base: fetched fresh from the owner's remote (falls back to the owner's local checkout). Never from a clone.
    const { stdout: url } = await git(['-C', config.project.repoPath, 'remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }));
    const fromRemote = url.trim()
      ? await git([...SAFE, '-C', pub, 'fetch', '-q', '--no-tags', url.trim(), `+refs/heads/${base}:refs/sigmadesk/base`], { timeout: 120_000 }).then(() => true, () => false)
      : false;
    if (!fromRemote) {
      const { stdout: baseSha } = await git(['-C', config.project.repoPath, 'rev-parse', `refs/remotes/origin/${base}`]).catch(() => git(['-C', config.project.repoPath, 'rev-parse', base]));
      await git([...SAFE, '-c', 'protocol.file.allow=always', '-C', pub, 'fetch', '-q', '--no-tags', config.project.repoPath, `+${baseSha.trim()}:refs/sigmadesk/base`]);
    }
    await git([...SAFE, '-c', 'protocol.file.allow=always', '-C', pub, 'fetch', '-q', '--no-tags', cloneDir, `+${sha}:refs/sigmadesk/${key}`]);
    const { stdout: got } = await git(['-C', pub, 'rev-parse', `refs/sigmadesk/${key}`]);
    if (got.trim() !== sha) throw new Error('fetched commit does not match the approved SHA');
    const { stdout: names } = await git([...SAFE, '-C', pub, 'diff', '--no-ext-diff', '--name-only', `refs/sigmadesk/base...${sha}`]);
    const { stdout: stat } = await git([...SAFE, '-C', pub, 'diff', '--no-ext-diff', '--shortstat', `refs/sigmadesk/base...${sha}`]);
    const lines = Number(stat.match(/(\d+) insertion/)?.[1] || 0) + Number(stat.match(/(\d+) deletion/)?.[1] || 0);
    const { stdout: baseSha } = await git(['-C', pub, 'rev-parse', 'refs/sigmadesk/base']);
    return { files: names.split('\n').filter(Boolean), lines, baseSha: baseSha.trim() };
  });
}
export function pushBranch(key, branch, sha, { lease } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return Promise.reject(new Error('refusing to push without an approved commit SHA'));
  return withGitLock(async () => {
    const pub = await publisher();
    const { stdout: url } = await git(['-C', config.project.repoPath, 'remote', 'get-url', 'origin']); // owner's remote
    if (lease != null && !/^[0-9a-f]{40}$/.test(lease)) throw new Error('invalid branch lease');
    return git([...SAFE, '-C', pub, 'push', ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []), url.trim(), `${sha}:refs/heads/${branch}`], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  });
}

export function removeWorkspace(key) {
  const dir = workspaceDir(key);
  if (dir.startsWith(config.workspaceRoot) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------- sandbox + CLI arguments ----------------
// Claude Code stores sessions per working directory: ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl
export function sessionFile(cwd, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}
export function canResume(run, maxAgeHours) {
  if (!run?.session_id || !run.cwd) return false;
  const seat = selectionFor(run.agent_id).seat;
  const [provider, ...modelParts] = String(run.model || '').split(':');
  if (!seat || provider !== engineOf(seat).id || modelParts.join(':') !== (seat.model || 'default')) return false;
  if (run.provenance && run.provenance !== provenanceOf(seat, run.kind)) return false;
  const ended = Date.parse(run.ended_at || run.started_at);
  const transcript = provider === 'codex' || fs.existsSync(sessionFile(run.cwd, run.session_id));
  return Date.now() - ended < maxAgeHours * 3600_000 && transcript && fs.existsSync(run.cwd);
}

export function sandboxSettings(cwd, extraDirs = [], kind = 'implement', socketPath = config.socketPath) {
  const deny = [...config.sandbox.denyRead,
    // desk state: run tokens, verdict codes, config, private notes, and every seat's session transcript
    path.join(config.root, 'data'), config.configFile, path.join(config.root, 'local'), '~/.claude', '~/.codex'];
  if (config.advisors.keyFile) deny.push(config.advisors.keyFile);
  if (config.project.repoPath) deny.push(path.join(config.project.repoPath, '.env'));
  const asRule = (p) => (p.startsWith('~') ? p : `/${p}`);
  return {
    sandbox: {
      enabled: config.sandbox.enabled,
      allowUnsandboxedCommands: false,
      failIfUnavailable: config.sandbox.enabled,
      // The OS sandbox is the boundary, so sandboxed shell commands run without per-command allowlisting
      // (deny rules still apply). The support bot keeps the strict allowlist: it only ever needs `desk`.
      autoAllowBashIfSandboxed: config.sandbox.enabled && kind !== 'triage',
      network: { allowedDomains: config.sandbox.allowedDomains, allowUnixSockets: [socketPath] },
      // readOnlyPaths and other seats' clones stay readable but are explicitly write-protected.
      filesystem: { denyRead: deny, allowWrite: [cwd], denyWrite: [...config.project.readOnlyPaths, ...extraDirs, config.project.repoPath].filter(Boolean) },
    },
    permissions: {
      deny: deny.flatMap((p) => [`Read(${asRule(p)})`, `Read(${asRule(p)}/**)`]),
      additionalDirectories: [],
    },
  };
}

function childEnv(token, engine) {
  const env = { ...process.env, ...config.project.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  // Strip obvious secrets from the agent environment (keep Claude's own auth variables).
  for (const k of Object.keys(env)) if (/(_TOKEN|_SECRET|_KEY|PASSWORD|_DSN)$/i.test(k) && !/^(DESK_|ANTHROPIC_|CLAUDE_)/.test(k)) delete env[k];
  if (engine !== 'claude') for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_)/.test(k)) delete env[k];
  env.PATH = [path.join(config.root, 'bin'), ...String(process.env.PATH || '/usr/bin:/bin').split(':')].join(':');
  if (config.bins.agentShell && fs.existsSync(config.bins.agentShell)) env.SHELL = config.bins.agentShell;
  env.DESK_SOCKET = config.socketPath;
  env.DESK_RUN_TOKEN = token;
  return env;
}

export const engineOf = (seat) => ENGINES[seat?.engine || 'claude'] || ENGINES.claude;

export function buildCommand(agent, kind, cwd, { resume = null, fork = false, extraDirs = [], socketPath = config.socketPath } = {}) {
  return engineOf(agent).command({
    seat: agent, kind, cwd, resume, fork, extraDirs,
    perms: permissionsFor(kind, cwd), denyRules: DENY_RULES, charter: kind === 'council_review' ? 'You are a read-only engineering reviewer. Use only the frozen supplied brief. Never call tools, edit files, contact services, or grant QA/merge approval. Return your analysis as text.' : charterFor(agent.id), settings: sandboxSettings(cwd, extraDirs, kind, socketPath),
  });
}

// Provenance: which charter/playbook/engine/model produced this run, so scorecards can be split by version.
const engineVersions = {};
export function provenanceOf(agent, kind) {
  const e = engineOf(agent);
  if (!(e.id in engineVersions)) engineVersions[e.id] = '';
  const parts = ['seat-contract-v2', e.id, engineVersions[e.id], agent.model || 'default', agent.effort || '', charterFor(agent.id), kind];
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10);
}
export function setEngineVersion(id, v) { engineVersions[id] = v || ''; }

// Each run gets its own unix socket, allowlisted only in that run's sandbox: a token read from elsewhere is useless.
let socketFactory = null;
export function setSocketFactory(fn) { socketFactory = fn; }

// Stop-all fencing: jobs that were still preparing when the breaker tripped must not spawn afterwards.
let epoch = 0;
export const currentEpoch = () => epoch;
// Back-compat for tests and callers that want the argv of a Claude seat.
export const buildArgs = (agent, kind, cwd, opts) => buildCommand({ ...agent, engine: 'claude' }, kind, cwd, opts).args;

// ---------------- file mailbox (desk transport for engines whose sandbox blocks unix sockets) ----------------
const mailboxes = new Map(); // runId -> dir
function openMailbox(runId, cwd) {
  // One subfolder per run inside that seat's own clone.
  const dir = path.join(cwd, '.desk-mailbox', `r${runId}`);
  fs.mkdirSync(dir, { recursive: true });
  const exclude = path.join(cwd, '.git', 'info', 'exclude');
  try {
    if (fs.existsSync(path.dirname(exclude)) && !fs.readFileSync(exclude, 'utf8').includes('.desk-mailbox')) fs.appendFileSync(exclude, '\n.desk-mailbox/\n');
  } catch { /* not a clone */ }
  mailboxes.set(runId, dir);
  return dir;
}
export const openMailboxes = () => [...mailboxes.entries()];
export const runCwd = (runId) => store.getRun(runId)?.cwd;

export const runBudget = (agentId) => {
  const seat = selectionFor(agentId).seat || agentById[agentId] || {};
  return engineOf(seat).budgetUsd(seat);
};
export const reservationFor = (run) => run?.reserve_usd || engineOf({ engine: String(run?.model || '').split(':')[0] }).budgetUsd({ model: String(run?.model || '').split(':').slice(1).join(':') });

/**
 * Start one agent run. Resolves when the process exits with {run, result}.
 * The prompt goes over stdin so the variadic tool flags cannot swallow it.
 */
export function startRun({ agentId, kind, ticketKey = null, prompt, cwd, track = true, resume = null, fork = false, extraDirs = [], incidentId = null, nonce = null, fence = null, onStreamLine = null, reviewProfile = null, onStart = null }) {
  if (fence != null && fence !== epoch) return Promise.resolve({ run: null, result: null, aborted: true });
  if (reviewProfile && (kind !== 'council_review' || track || resume)) throw new Error('Per-job review models are restricted to fresh, untracked council calls');
  const selected = reviewProfile ? reviewSelection(agentId, reviewProfile) : selectionFor(agentId);
  if (!selected.seat) throw Object.assign(new Error(`${agentId}: ${selected.reason}`), { status: 409, providerUnavailable: true });
  const agent = selected.seat;
  const token = crypto.randomBytes(18).toString('hex');
  const run = store.createRun({ nonce, provenance: provenanceOf(agent, kind), agent_id: agentId, ticket_key: ticketKey, kind, token, model: `${agent.engine || 'claude'}:${agent.model || 'default'}`, cwd, resumed_from: resume, incident_id: incidentId });
  store.updateRun(run.id, { reserve_usd: engineOf(agent).budgetUsd(agent) });
  onStart?.(run);
  const ctx = { run, cwd, result: null, state: {}, presence: track };
  if (track) store.updateAgent(agentId, { status: 'working', current_kind: kind, current_ticket: ticketKey, current_run: run.id, last_action: `started ${kind}`, last_action_at: store.now() });
  store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: 'run',
    text: `${agent.role} started ${kind} on ${agent.engine && agent.engine !== 'claude' ? `${agent.engine}${agent.model ? `/${agent.model}` : ''}` : agent.model}${agent.effort ? ` (${agent.effort})` : ''}${resume ? ` (${fork ? 'forked from' : 'continuing'} session ${resume.slice(0, 8)})` : ''}` });
  if (selected.fallback) store.logEvent({ ...{ run_id: run.id, agent_id: agentId, ticket_key: ticketKey }, kind: 'system',
    text: `Automatic fallback: ${agentById[agentId].engine || 'claude'} → ${agent.engine} (${selected.reason}). Saved seat preference retained.` });

  const engine = engineOf(agent);
  let sock, cmd, env;
  try {
    sock = kind !== 'council_review' && engine.usesSocket && socketFactory ? socketFactory(run.id) : null;
    cmd = buildCommand(agent, kind, cwd, { resume, fork: fork && engine.canFork, extraDirs, socketPath: sock?.path || config.socketPath });
    env = { ...childEnv(token, engine.id), ...cmd.env };
    if (kind === 'council_review') { delete env.DESK_RUN_TOKEN; delete env.DESK_SOCKET; }
    if (cmd.mailbox) env.DESK_MAILBOX = openMailbox(run.id, cwd);
  } catch (err) {
    sock?.close();
    mailboxes.delete(run.id);
    store.updateRun(run.id, { status: 'error', token: null, ended_at: store.now(), result_text: `Run setup failed: ${store.redact(err.message)}` });
    if (track) store.updateAgent(agentId, { status: 'idle', current_kind: null, current_ticket: null, current_run: null });
    throw err;
  }
  if (sock) env.DESK_SOCKET = sock.path;
  else delete env.DESK_SOCKET;
  const child = spawn(cmd.bin, cmd.args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  children.set(run.id, child);
  store.updateRun(run.id, { pid: child.pid });
  child.stdin.on('error', () => {});
  child.stdin.end(cmd.wrapPrompt ? cmd.wrapPrompt(prompt) : prompt);

  let buf = '';
  let lastOutput = Date.now();
  const idleMin = config.limits.idleTimeoutMin;
  const idleTimer = idleMin ? setInterval(() => {
    if (Date.now() - lastOutput > idleMin * 60_000) {
      store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: 'error', text: `no activity for ${idleMin} min — stopping the seat` });
      killRun(run.id, 'idle timeout');
      clearInterval(idleTimer);
    }
  }, 30_000) : null;
  child.stdout.on('data', (d) => {
    lastOutput = Date.now();
    buf += d;
    if (buf.length > 8 << 20) buf = buf.slice(-(1 << 20)); // bound memory on pathological lines
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) { onStreamLine?.(line); applyEvents(engine.parse(line, cwd, ctx.state), ctx); }
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { lastOutput = Date.now(); stderr = (stderr + d).slice(-4000); });

  const timeoutMin = config.limits.runTimeoutMin[kind] ?? 30;
  const timer = setTimeout(() => {
    store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: 'error', text: `timed out after ${timeoutMin} min — stopping` });
    killRun(run.id, 'timeout');
  }, timeoutMin * 60_000);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      children.delete(run.id);
      mailboxes.delete(run.id);
      setTimeout(() => evidence.delete(run.id), 60_000).unref();
      sock?.close();
      if (buf.trim()) applyEvents(engine.parse(buf, cwd, ctx.state), ctx);
      const r = ctx.result;
      const prev = store.getRun(run.id);
      const status = prev.status === 'killed' ? 'killed' : r && !r.is_error && code === 0 ? 'success' : 'error';
      // Only text the CLI itself produced may put a provider on hold — never the agent's own words (an SRE quoting
      // "rate limit exceeded" from production logs must not stall a whole engine).
      const cliText = /^(API Error|Claude AI usage limit|You've hit your|Credit balance|Invalid API key|Please run \/login|usage limit|rate[ _-]?limit|unexpected status 4(01|29))/i.test(String(r?.result || '').trim()) ? r.result : '';
      const failure = status === 'error' ? classifyProviderFailure(`${(r?.errors || []).join('\n')}\n${cliText}\n${stderr}`) : null;
      if (failure) holdProvider(engine.id, failure, r?.result || stderr || ctx.state.lastError);
      // No terminal result (killed, crashed, timed out): charge the full per-run cap so the risk limit stays honest.
      const knownCost = r?.cost_known !== false && r && (r.total_cost_usd || !r.is_error);
      const cost = knownCost ? (r.total_cost_usd ?? 0) : engine.budgetUsd(agent);
      store.updateRun(run.id, {
        status, ended_at: store.now(), cost_usd: cost, cost_estimated: knownCost ? 0 : 1, usage_json: r?.usage ? JSON.stringify(r.usage) : null, num_turns: r?.num_turns ?? null,
        result_text: String(r?.result ?? (prev.status === 'killed' && prev.result_text ? prev.result_text : stderr || `exit ${code}`)).slice(0, 8000), token: null,
      });
      const estimated = !knownCost;
      const costTxt = cost ? ` · $${cost.toFixed(2)}${estimated ? ' estimated charge (provider cost unreported)' : ''}` : '';
      const blocked = kind === 'implement' && ticketKey && store.getTicket(ticketKey)?.status === 'needs_human';
      const outcome = blocked && status === 'success' ? 'Implementation paused: needs your decision' : `${kind.replaceAll('_', ' ')} run ${status === 'success' ? 'finished' : status}`;
      store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: status !== 'success' ? 'error' : blocked ? 'system' : 'done',
        text: `${outcome}${r?.subtype && r.subtype !== 'success' ? ` (${r.subtype})` : ''}${costTxt}${status !== 'success' && stderr ? ` — ${short(stderr, 200)}` : ''}` });
      if (track) store.updateAgent(agentId, { status: 'idle', current_kind: null, current_ticket: null, current_run: null, last_action_at: store.now() });
      resolve({ run: store.getRun(run.id), result: r, failure });
    };
    child.on('close', finish);
    child.on('error', (err) => {
      store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: 'error', text: `spawn failed: ${err.message}` });
      finish(-1);
    });
  });
}

export function killRun(runId, reason = 'killed') {
  const run = store.getRun(runId);
  if (!run || run.status !== 'running') return false;
  store.updateRun(runId, { status: 'killed', result_text: reason });
  const pid = children.get(runId)?.pid ?? run.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  }
  return true;
}

export function killAll(reason) {
  epoch += 1;
  for (const id of [...children.keys()]) killRun(id, reason);
}

// Terminate every child process group and wait (SIGTERM, then SIGKILL) before the desk exits.
export async function shutdownAll(reason) {
  killAll(reason);
  const deadline = Date.now() + 6000;
  while (children.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  for (const c of children.values()) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
}

export const runningCount = () => children.size;
export const runningBudget = () => store.unfinishedRuns().reduce((s, run) => s + reservationFor(run), 0);

// The manager's planning discussion: a short, read-only principal run, answered synchronously.
const inMeeting = new Set();
export async function consult({ agentId, ticketKey, question }) {
  if (inMeeting.has(agentId)) throw Object.assign(new Error(`${agentById[agentId].name} is in another meeting; ask again in a few minutes`), { status: 409 });
  inMeeting.add(agentId);
  try { return await consultInner({ agentId, ticketKey, question }); } finally { inMeeting.delete(agentId); }
}
async function consultInner({ agentId, ticketKey, question }) {
  const ticket = ticketKey ? store.getTicket(ticketKey) : null;
  const busy = store.getAgentState(agentId)?.status === 'working';
  if (busy) throw Object.assign(new Error(`${agentById[agentId].name} is busy; groom without a consult`), { status: 409 });
  store.updateAgent(agentId, { status: 'working', last_action: 'preparing consultation', last_action_at: store.now() });
  store.updateAgent('manager', { meeting: agentId });
  store.updateAgent(agentId, { meeting: 'manager' });
  try {
    const cwd = await ensureReadonlyWorkspace(agentId);
    const { result } = await startRun({
      agentId, kind: 'consult', ticketKey, cwd, track: !busy,
      prompt: promptFor('consult', { ticket, extra: question }),
    });
    return result?.result || '(no answer)';
  } finally {
    store.updateAgent('manager', { meeting: null });
    store.updateAgent(agentId, { meeting: null });
    if (!store.getAgentState(agentId)?.current_run) store.updateAgent(agentId, { status: 'idle', current_ticket: null });
  }
}
