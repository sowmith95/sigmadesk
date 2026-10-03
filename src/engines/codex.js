// Codex engine: `codex exec --json` (OpenAI GPT models via the Codex CLI), workspace-write sandbox, network off.
// Runs with a desk-owned CODEX_HOME so the owner's personal Codex config (MCP servers, hooks, notify, full-access
// defaults) never applies to agents; only auth.json is linked in. With network off the sandbox also blocks unix
// sockets, so Codex seats talk to the desk through a file mailbox inside their own workspace.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

const short = (s, n = 180) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// codex wraps commands as `/bin/bash -lc '<cmd>'`; show just the command
const unwrap = (cmd) => String(cmd || '').replace(/^\/bin\/(ba|z)?sh -l?c\s+(['"])([\s\S]*)\2$/, '$3');

export function codexHome() {
  const home = path.join(config.root, 'data', 'codex-home');
  fs.mkdirSync(home, { recursive: true });
  const userHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const auth = path.join(home, 'auth.json');
  if (!fs.existsSync(auth) && fs.existsSync(path.join(userHome, 'auth.json'))) fs.symlinkSync(path.join(userHome, 'auth.json'), auth);
  // Everything that runs OUTSIDE the sandbox (apps, plugins, browser/computer use, hooks, sub-agents, web search)
  // is switched off: a coding seat needs a shell and files, nothing else.
  const off = ['apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
    'computer_use', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'image_generation', 'multi_agent', 'hooks', 'goals',
    'skill_mcp_dependency_install', 'skill_search', 'workspace_dependencies', 'system_proxy_fallback', 'daemon_auto_start',
    'shell_snapshot', 'realtime_conversation', 'tool_suggest', 'worktrees'];
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    '',
    '[features]',
    ...off.map((f) => `${f} = false`),
    '',
  ].join('\n'));
  return home;
}

function userModel() {
  try {
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8');
    return toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '';
  } catch { return ''; }
}

const codexBin = () => config.engines.codex.bin || 'codex';

export const codex = {
  id: 'codex',
  label: 'Codex (OpenAI)',
  isolation: { reads: 'NOT restricted', writes: 'workspace only', network: 'blocked', note: 'Codex sandbox confines writes and network, but an agent can read any file your user can (e.g. ~/.ssh). Keep it off seats near secrets.' },
  costNote: 'Token usage reported by Codex; USD only if you set engines.codex.pricing (notional on a ChatGPT plan).',
  canFork: false,
  usesSocket: false,
  models: () => {
    const m = userModel();
    return [{ id: '', tier: 'any', note: m ? `your Codex default (${m})` : 'your Codex default' }, ...(config.engines?.codex?.models || []).map((id) => ({ id, tier: 'any', note: '' }))];
  },
  efforts: ['low', 'medium', 'high', 'xhigh'],
  suggest(tier) {
    return { frontier: { model: '', effort: 'xhigh' }, strong: { model: '', effort: 'high' }, fast: { model: '', effort: 'medium' }, cheap: { model: '', effort: 'low' } }[tier];
  },
  async detect() {
    if (!config.engines.codex.bin) return { available: false };
    // codex is a Node script: run it with this Node so a minimal service PATH still works.
    try { return { available: true, version: execFileSync(process.execPath, [codexBin(), '--version'], { encoding: 'utf8', timeout: 15_000 }).trim(), defaultModel: userModel() }; } catch { return { available: false }; }
  },
  budgetUsd: () => config.engines?.codex?.reserveUsd ?? 2,

  command({ seat, charter, cwd, resume, extraDirs = [] }) {
    const effort = seat.effort === 'max' ? 'xhigh' : seat.effort;
    const common = ['--json', '--skip-git-repo-check', ...(seat.model ? ['-m', seat.model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : [])];
    const args = resume
      ? ['exec', 'resume', ...common, resume, '-']
      : ['exec', ...common, '-s', 'workspace-write', '-C', cwd, ...extraDirs.flatMap((d) => ['--add-dir', d]), '-'];
    return {
      bin: process.execPath,
      args: [codexBin(), ...args],
      promptViaStdin: true,
      // Codex has no system-prompt flag: the charter leads the prompt.
      wrapPrompt: (prompt) => `<seat-charter>\n${charter}\n</seat-charter>\n\n${prompt}`,
      env: { CODEX_HOME: codexHome() },
      mailbox: true,
    };
  },

  parse(line, _cwd, state) {
    let ev;
    try { ev = JSON.parse(line); } catch { return []; }
    const it = ev.item || {};
    switch (ev.type) {
      case 'thread.started': return [{ type: 'session', id: ev.thread_id }];
      case 'item.started':
        if (it.type === 'command_execution') {
          const cmd = unwrap(it.command);
          return /^\s*desk\s/.test(cmd) ? [] : [{ type: 'tool', text: `$ ${short(cmd)}` }];
        }
        return [];
      case 'item.completed':
        if (it.type === 'agent_message' && it.text?.trim()) return [{ type: 'say', text: it.text }];
        if (it.type === 'command_execution') {
          const ev2 = [{ type: 'cmd-start', id: it.id, cmd: unwrap(it.command) }, { type: 'cmd-end', id: it.id, ok: it.exit_code === 0 }];
          if (it.exit_code && it.exit_code !== 0 && !/^\s*desk\s/.test(unwrap(it.command))) ev2.push({ type: 'error', text: `exit ${it.exit_code}: ${short(it.aggregated_output, 300)}` });
          return ev2;
        }
        if (it.type === 'file_change') return (it.changes || []).map((c) => ({ type: 'tool', text: `${c.kind === 'add' ? 'Writing' : 'Editing'} ${c.path?.startsWith(_cwd) ? c.path.slice(_cwd.length + 1) : c.path}` }));
        if (it.type === 'web_search') return [{ type: 'tool', text: `Web search: ${short(it.query, 120)}` }];
        if (it.type === 'todo_list') return [{ type: 'todos', todos: (it.items || []).map((t) => ({ text: t.text, status: t.completed ? 'completed' : 'pending' })) }];
        return [];
      case 'turn.completed': {
        const u = ev.usage || {};
        state.usage = u;
        const p = config.engines?.codex?.pricing;
        const cost = p ? (((u.input_tokens || 0) - (u.cached_input_tokens || 0)) * p.inputPerM + (u.cached_input_tokens || 0) * (p.cachedPerM ?? p.inputPerM) + (u.output_tokens || 0) * p.outputPerM) / 1e6 : 0;
        return [{ type: 'result', ok: true, subtype: 'success', costUsd: cost, turns: null, text: state.lastSay || '', usage: u }];
      }
      case 'turn.failed': case 'error':
        return [{ type: 'result', ok: false, subtype: 'error', costUsd: 0, text: ev.error?.message || ev.message || 'codex error' }];
      default: return [];
    }
  },
};
