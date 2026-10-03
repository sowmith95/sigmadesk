// Claude Code engine: `claude -p --output-format stream-json`, OS sandbox via --settings.
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';

const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
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
    default: return `${name} ${short(JSON.stringify(input), 120)}`;
  }
}

export const claude = {
  id: 'claude',
  label: 'Claude Code',
  isolation: { reads: 'restricted', writes: 'workspace only', network: 'blocked', note: 'Seatbelt/bubblewrap sandbox; secrets paths unreadable' },
  costNote: 'USD per run reported by Claude Code (notional on a subscription).',
  canFork: true,
  usesSocket: true,
  models: () => [
    { id: 'fable', tier: 'frontier', note: 'most capable' },
    { id: 'opus', tier: 'strong', note: 'strong all-rounder' },
    { id: 'sonnet', tier: 'fast', note: 'fast, cheaper' },
    { id: 'haiku', tier: 'cheap', note: 'cheapest, triage' },
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  suggest(tier) {
    return { frontier: { model: 'fable', effort: 'xhigh' }, strong: { model: 'opus', effort: 'high' }, fast: { model: 'sonnet', effort: 'medium' }, cheap: { model: 'haiku', effort: 'low' } }[tier];
  },
  async detect() {
    try { return { available: true, version: execFileSync(config.bins.claude, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim() }; } catch { return { available: false }; }
  },
  budgetUsd: (seat) => config.limits.runBudgetUsd[seat.model] ?? 3,

  command({ seat, perms, denyRules, charter, settings, resume, fork }) {
    return {
      bin: config.bins.claude,
      args: [
        '-p',
        ...(resume ? ['--resume', resume, ...(fork ? ['--fork-session'] : [])] : []),
        '--model', seat.model,
        ...(seat.effort ? ['--effort', seat.effort] : []),
        '--output-format', 'stream-json', '--verbose',
        '--append-system-prompt', charter,
        '--max-budget-usd', String(config.limits.runBudgetUsd[seat.model] ?? 3),
        '--setting-sources', '', // none of the machine's hooks/plugins
        '--settings', JSON.stringify(settings),
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--permission-mode', 'dontAsk',
        '--tools', perms.tools.join(','),
        '--allowedTools', ...perms.allow,
        '--disallowedTools', ...denyRules,
      ],
      promptViaStdin: true,
      env: {},
    };
  },

  // stream-json line → normalized events
  parse(line, cwd) {
    let ev;
    try { ev = JSON.parse(line); } catch { return []; }
    if (ev.type === 'system' && ev.subtype === 'init') return [{ type: 'session', id: ev.session_id }];
    const out = [];
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type === 'text' && b.text?.trim()) out.push({ type: 'say', text: b.text });
        else if (b.type === 'tool_use') {
          if (b.name === 'TodoWrite') out.push({ type: 'todos', todos: (b.input?.todos || []).map((t) => ({ text: t.content, active: t.activeForm, status: t.status })) });
          else {
            if (b.name === 'Bash') out.push({ type: 'cmd-start', id: b.id, cmd: String(b.input?.command || '') });
            const text = describeToolUse(b.name, b.input, cwd);
            if (text) out.push({ type: 'tool', text });
          }
        }
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type !== 'tool_result') continue;
        out.push({ type: 'cmd-end', id: b.tool_use_id, ok: !b.is_error });
        if (b.is_error) out.push({ type: 'error', text: Array.isArray(b.content) ? b.content.map((c) => c.text || '').join(' ') : b.content });
      }
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
      out.push({ type: 'quota', engine: 'claude', info: ev.rate_limit_info });
    } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
      out.push({ type: 'wait', text: `API retry ${ev.attempt ?? ''}${ev.error_status ? ` (HTTP ${ev.error_status})` : ''} — waiting` });
    } else if (ev.type === 'result') {
      out.push({ type: 'result', ok: !ev.is_error && ev.subtype === 'success', subtype: ev.subtype, costUsd: ev.total_cost_usd || 0, turns: ev.num_turns, text: ev.result });
    }
    return out;
  },
};
