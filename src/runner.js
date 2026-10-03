import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { agentById, charterFor, permissionsFor, promptFor, DENY_RULES } from './team.js';
import * as store from './db.js';

const pexec = promisify(execFile);
const children = new Map(); // runId -> ChildProcess

// ---------------- stream-json → readable activity ----------------
const short = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const rel = (p, cwd) => (p && cwd && String(p).startsWith(cwd) ? String(p).slice(cwd.length + 1) : p);

export function describeToolUse(name, input = {}, cwd) {
  switch (name) {
    case 'Bash': {
      const cmd = String(input.command || '');
      if (/^\s*desk\s/.test(cmd)) return null; // desk calls are logged server-side with better text
      return `$ ${short(cmd, 180)}`;
    }
    case 'Read': return `Reading ${rel(input.file_path, cwd)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${rel(input.file_path, cwd)}`;
    case 'Write': return `Writing ${rel(input.file_path, cwd)}`;
    case 'NotebookEdit': return `Editing notebook ${rel(input.notebook_path, cwd)}`;
    case 'Grep': return `Searching for “${short(input.pattern, 60)}”${input.path ? ` in ${rel(input.path, cwd)}` : ''}`;
    case 'Glob': return `Listing ${short(input.pattern, 80)}`;
    case 'WebSearch': return `Web search: ${short(input.query, 120)}`;
    case 'WebFetch': return `Reading ${short(input.url, 120)}`;
    case 'TodoWrite': return null; // becomes progress
    default: return `${name} ${short(JSON.stringify(input), 120)}`;
  }
}

export function todoProgress(todos) {
  if (!Array.isArray(todos) || !todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const cur = todos.find((t) => t.status === 'in_progress');
  return { pct: Math.round((done / todos.length) * 100), msg: cur ? cur.activeForm || cur.content : `${done}/${todos.length} steps done` };
}

export function handleStreamLine(line, ctx) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; } // tolerate partial/unknown lines
  const { run, cwd } = ctx;
  const base = { run_id: run.id, agent_id: run.agent_id, ticket_key: run.ticket_key };
  if (ev.type === 'system' && ev.subtype === 'init') {
    store.updateRun(run.id, { session_id: ev.session_id });
    return;
  }
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text?.trim()) {
        store.logEvent({ ...base, kind: 'say', text: short(block.text, 1200) });
        store.updateAgent(run.agent_id, { last_action: short(block.text, 140), last_action_at: store.now() });
      } else if (block.type === 'tool_use') {
        if (block.name === 'TodoWrite') {
          const p = todoProgress(block.input?.todos);
          if (!p) continue;
          if (run.ticket_key && run.kind === 'implement') store.updateTicket(run.ticket_key, { progress: Math.max(5, Math.min(95, p.pct)), progress_msg: p.msg });
          store.logEvent({ ...base, kind: 'plan', text: block.input.todos.map((t) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.content}`).join('\n') });
          continue;
        }
        const text = describeToolUse(block.name, block.input, cwd);
        if (!text) continue;
        store.logEvent({ ...base, kind: 'tool', text });
        store.updateAgent(run.agent_id, { last_action: text, last_action_at: store.now() });
      }
    }
    return;
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result' && block.is_error) {
        const txt = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : block.content;
        store.logEvent({ ...base, kind: 'error', text: short(txt, 300) });
      }
    }
    return;
  }
  if (ev.type === 'result') ctx.result = ev;
}

// ---------------- per-ticket workspaces (isolated local clones) ----------------
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
}

let gitLock = Promise.resolve();
function withGitLock(fn) {
  const p = gitLock.then(fn, fn);
  gitLock = p.catch(() => {});
  return p;
}
const git = (args, opts = {}) => pexec(config.bins.git, args, { timeout: 180_000, maxBuffer: 16 << 20, ...opts });

export const workspaceDir = (key) => path.join(config.workspaceRoot, key);

// A clone (not a worktree): its own .git inside the sandbox-writable dir, and none of the main checkout's hooks.
export function ensureWorkspace(ticket) {
  return withGitLock(async () => {
    const dir = workspaceDir(ticket.key);
    const branch = ticket.branch || `${config.project.branchPrefix}${ticket.key.toLowerCase()}-${slugify(ticket.title)}`;
    const base = config.project.baseBranch;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
      await git(['clone', '--quiet', config.project.repoPath, dir]);
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
    return { dir, branch };
  });
}

// Shared scratch clone for read-only seats (PM research, grooming, consults, triage), reset to the base
// branch before each use, so nothing ever runs with the owner's real checkout as a writable cwd.
export function ensureReadonlyWorkspace() {
  return withGitLock(async () => {
    const dir = path.join(config.workspaceRoot, '_desk');
    const base = config.project.baseBranch;
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.mkdirSync(config.workspaceRoot, { recursive: true });
      await git(['clone', '--quiet', config.project.repoPath, dir]);
      const { stdout: origin } = await git(['-C', config.project.repoPath, 'remote', 'get-url', 'origin']).catch(() => ({ stdout: '' }));
      if (origin.trim()) await git(['-C', dir, 'remote', 'set-url', 'origin', origin.trim()]);
    }
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

export function pushBranch(dir, branch) {
  return withGitLock(() => git(['-C', dir, 'push', '-u', 'origin', `HEAD:refs/heads/${branch}`]));
}

// ---------------- sandbox + CLI arguments ----------------
// Claude Code stores sessions per working directory: ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<id>.jsonl
export function sessionFile(cwd, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}
export function canResume(run, maxAgeHours) {
  if (!run?.session_id || !run.cwd) return false;
  const ended = Date.parse(run.ended_at || run.started_at);
  return Date.now() - ended < maxAgeHours * 3600_000 && fs.existsSync(sessionFile(run.cwd, run.session_id)) && fs.existsSync(run.cwd);
}

export function sandboxSettings(cwd, extraDirs = [], kind = 'implement') {
  const deny = [...config.sandbox.denyRead];
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
      network: { allowedDomains: config.sandbox.allowedDomains, allowUnixSockets: [config.socketPath] },
      filesystem: { denyRead: deny, allowWrite: [cwd] },
    },
    permissions: {
      deny: deny.flatMap((p) => [`Read(${asRule(p)})`, `Read(${asRule(p)}/**)`]),
      additionalDirectories: [...config.project.readOnlyPaths, ...extraDirs],
    },
  };
}

function childEnv(token) {
  const env = { ...process.env, ...config.project.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k];
  // Strip obvious secrets from the agent environment (keep Claude's own auth variables).
  for (const k of Object.keys(env)) if (/(_TOKEN|_SECRET|_KEY|PASSWORD|_DSN)$/i.test(k) && !/^(DESK_|ANTHROPIC_|CLAUDE_)/.test(k)) delete env[k];
  env.PATH = [path.join(config.root, 'bin'), ...String(process.env.PATH || '/usr/bin:/bin').split(':')].join(':');
  if (config.bins.agentShell && fs.existsSync(config.bins.agentShell)) env.SHELL = config.bins.agentShell;
  env.DESK_SOCKET = config.socketPath;
  env.DESK_RUN_TOKEN = token;
  return env;
}

export function buildArgs(agent, kind, cwd, { resume = null, fork = false, extraDirs = [] } = {}) {
  const perms = permissionsFor(kind);
  return [
    '-p',
    ...(resume ? ['--resume', resume, ...(fork ? ['--fork-session'] : [])] : []),
    '--model', agent.model,
    '--output-format', 'stream-json', '--verbose',
    '--append-system-prompt', charterFor(agent.id),
    '--max-budget-usd', String(config.limits.runBudgetUsd[agent.model] ?? 3),
    '--setting-sources', '', // no user/project settings: no hooks or plugins inherited from the machine
    '--settings', JSON.stringify(sandboxSettings(cwd, extraDirs, kind)),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', 'dontAsk',
    '--tools', perms.tools.join(','),
    '--allowedTools', ...perms.allow,
    '--disallowedTools', ...DENY_RULES,
  ];
}

export const runBudget = (agentId) => config.limits.runBudgetUsd[agentById[agentId]?.model] ?? 3;

/**
 * Start one agent run. Resolves when the process exits with {run, result}.
 * The prompt goes over stdin so the variadic tool flags cannot swallow it.
 */
export function startRun({ agentId, kind, ticketKey = null, prompt, cwd, track = true, resume = null, fork = false, extraDirs = [], incidentId = null }) {
  const agent = agentById[agentId];
  const token = crypto.randomBytes(18).toString('hex');
  const run = store.createRun({ agent_id: agentId, ticket_key: ticketKey, kind, token, model: agent.model, cwd, resumed_from: resume, incident_id: incidentId });
  const ctx = { run, cwd, result: null };
  if (track) store.updateAgent(agentId, { status: 'working', current_kind: kind, current_ticket: ticketKey, current_run: run.id, last_action: `started ${kind}`, last_action_at: store.now() });
  store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: 'run',
    text: `${agent.role} started ${kind} on ${agent.model}${resume ? ` (${fork ? 'forked from' : 'continuing'} session ${resume.slice(0, 8)})` : ''}` });

  const child = spawn(config.bins.claude, buildArgs(agent, kind, cwd, { resume, fork, extraDirs }), { cwd, env: childEnv(token), detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  children.set(run.id, child);
  store.updateRun(run.id, { pid: child.pid });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);

  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    if (buf.length > 8 << 20) buf = buf.slice(-(1 << 20)); // bound memory on pathological lines
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handleStreamLine(line, ctx);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

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
      children.delete(run.id);
      if (buf.trim()) handleStreamLine(buf, ctx);
      const r = ctx.result;
      const prev = store.getRun(run.id);
      const status = prev.status === 'killed' ? 'killed' : r && !r.is_error && code === 0 ? 'success' : 'error';
      store.updateRun(run.id, {
        status, ended_at: store.now(), cost_usd: r?.total_cost_usd ?? 0, num_turns: r?.num_turns ?? null,
        result_text: String(r?.result ?? (stderr || `exit ${code}`)).slice(0, 8000), token: null,
      });
      const cost = r?.total_cost_usd ? ` · $${r.total_cost_usd.toFixed(2)}` : '';
      store.logEvent({ run_id: run.id, agent_id: agentId, ticket_key: ticketKey, kind: status === 'success' ? 'done' : 'error',
        text: `${kind} ${status}${r?.subtype && r.subtype !== 'success' ? ` (${r.subtype})` : ''}${cost}${status !== 'success' && stderr ? ` — ${short(stderr, 200)}` : ''}` });
      if (track) store.updateAgent(agentId, { status: 'idle', current_kind: null, current_ticket: null, current_run: null, last_action_at: store.now() });
      resolve({ run: store.getRun(run.id), result: r });
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
  for (const id of [...children.keys()]) killRun(id, reason);
}

export const runningCount = () => children.size;
export const runningBudget = () => [...children.keys()].reduce((s, id) => s + runBudget(store.getRun(id)?.agent_id), 0);

// The manager's planning discussion: a short, read-only principal run, answered synchronously.
export async function consult({ agentId, ticketKey, question }) {
  const ticket = ticketKey ? store.getTicket(ticketKey) : null;
  const busy = store.getAgentState(agentId)?.status === 'working';
  const cwd = await ensureReadonlyWorkspace();
  store.updateAgent('manager', { meeting: agentId });
  store.updateAgent(agentId, { meeting: 'manager' });
  try {
    const { result } = await startRun({
      agentId, kind: 'consult', ticketKey, cwd, track: !busy,
      prompt: promptFor('consult', { ticket, extra: question }),
    });
    return result?.result || '(no answer)';
  } finally {
    store.updateAgent('manager', { meeting: null });
    store.updateAgent(agentId, { meeting: null });
  }
}
