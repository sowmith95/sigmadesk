// Perplexity engine: a Perplexity model (via the Computer MCP server, billed to the owner's account credits) does the
// thinking; a small sandboxed local Claude is its hands — it reads the clone, sends the full context to Perplexity,
// and runs the desk commands the model decides. Only "thinking" seats can use it: Perplexity cannot edit local files,
// so implementation and QA always run on a local engine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { claude } from './claude.js';
import * as context from '../context.js';

const SERVER = 'perplexity-computer';
const MCP = JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: 'https://www.perplexity.ai/rest/computer/mcp' } } });
const T = (name) => `mcp__${SERVER}__${name}`;
// For scripts/refresh-perplexity-models.mjs: the same server, reached the same way a seat reaches it.
export const MCP_CONFIG = MCP;
export const MODELS_LIST_TOOL = T('models_list');
const ALLOW = [T('call_perplexity_computer'), T('read_thread'), T('answer_question'), T('confirm_action_deny'), T('models_list')];
// Computer can act in the world (connected apps, files): the desk never lets a seat approve those actions.
const BLOCK = [T('confirm_action_approve'), T('create_attachment_upload'), T('create_asset_download'), T('projects_list'), T('notify_connected')];
// owner_discussion is the manager's design discussion (scheduler.launchDiscussion); without it here, a manager seat on
// Perplexity silently ran those on local Claude.
export const THINK_KINDS = ['research', 'groom', 'design', 'consult', 'review', 'triage', 'investigate', 'owner_discussion', 'product_review'];
// council_review (a frozen, read-only engineering council brief) is opt-in: a Computer task bills account credits and
// cannot be cancelled from here, so docs/perplexity-connection.md must be verified before engines.perplexity.councilEnabled.
const councilEnabled = () => config.engines?.perplexity?.councilEnabled === true;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// From models_list on the owner's account (2026-10-03, effort sets re-checked 2026-10-04). Ids are passed straight to
// call_perplexity_computer. `efforts` lists the desk efforts a model accepts when it differs from EFFORTS; [] means the
// model takes no effort parameter. `npm run models:refresh` records the live list in data/perplexity-models.json.
export const MODELS = [
  { id: 'pplx_asi_kimi_k3', label: 'Kimi K3', tier: 'frontier', note: 'architecture & independent design reasoning', efforts: ['low', 'medium', 'high', 'max'] },
  { id: 'pplx_asi_grok', label: 'Grok 4.7', tier: 'frontier', note: 'reliability, adversarial review', efforts: ['low', 'medium', 'high'] },
  { id: 'pplx_asi_glm_5_3', label: 'GLM 5.3', tier: 'cheap', note: 'fewest credits; delivery & cost review', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'pplx_asi_deepseek_v4_pro', label: 'DeepSeek V4 Pro', tier: 'strong', note: 'strong reasoning, US hosted', efforts: [] },
  { id: 'pplx_asi_gpt_6_1_sol', label: 'GPT-6.1 Sol', tier: 'frontier', note: 'complex tasks' },
  { id: 'pplx_asi_gpt_6_1_sol_fast', label: 'GPT-6.1 Sol fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_astra', label: 'GPT-6 Astra', tier: 'frontier', note: 'complex tasks' },
  { id: 'pplx_asi_astra_fast', label: 'GPT-6 Astra fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_opus', label: 'Claude Opus 5.5', tier: 'strong', note: "Perplexity's default" },
  { id: 'pplx_asi_opus_fast', label: 'Claude Opus 5.5 fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_sonnet', label: 'Claude Sonnet 5.5', tier: 'fast', note: 'fewer credits', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'pplx_asi_fable_5', label: 'Claude Fable 5.1', tier: 'frontier', note: 'most powerful; extra credits' },
];

// data/perplexity-models.json: the raw models_list payload plus fetched_at, written atomically by the refresh script.
// Read defensively: a missing, partial or reshaped file never breaks the engine, it just adds nothing.
export const catalogPath = () => path.join(config.root, 'data', 'perplexity-models.json');
let catalogCache = null; // { at, value }
export function readCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < 30_000) return catalogCache.value;
  let value = null;
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath(), 'utf8'));
    if (raw && Array.isArray(raw.models)) {
      const models = raw.models.filter((m) => m && typeof m.id === 'string' && /^[\w.:-]{1,80}$/.test(m.id)).map((m) => ({
        id: m.id, label: typeof m.label === 'string' && m.label.trim() ? m.label.trim().slice(0, 80) : m.id,
        fast: m.fast === true, efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => EFFORTS.includes(e)) : null }));
      value = { fetched_at: typeof raw.fetched_at === 'string' ? raw.fetched_at : null, models };
    }
  } catch { /* no catalog file yet, or unreadable: the built-in list stands */ }
  catalogCache = { at: Date.now(), value };
  return value;
}
export const resetCatalogCache = () => { catalogCache = null; };
// Built-in entries first (curated tiers and notes), then models the account lists that we do not know, then configured ids.
function catalog() {
  const live = readCatalog();
  const out = MODELS.map((m) => {
    const seen = live?.models.find((x) => x.id === m.id);
    return { ...m, efforts: seen?.efforts ?? m.efforts ?? null };
  });
  for (const m of live?.models || []) if (!out.some((x) => x.id === m.id)) out.push({ id: m.id, label: m.label, tier: m.fast ? 'strong' : 'frontier', efforts: m.efforts, note: `on your account${live.fetched_at ? ` (listed ${live.fetched_at.slice(0, 10)})` : ''}; access checked on use` });
  for (const id of config.engines?.perplexity?.models || []) if (id && !out.some((x) => x.id === id)) out.push({ id, label: id, tier: 'frontier', efforts: null, note: 'configured model; access checked on use' });
  return out;
}
const labelOf = (id) => catalog().find((m) => m.id === id)?.label || id || 'Perplexity default';
// null = unknown (any desk effort), [] = the model takes no effort parameter.
export const effortsOf = (id) => catalog().find((m) => m.id === id)?.efforts ?? null;

let detected = null;
function connected() {
  if (detected && Date.now() - detected.at < 5 * 60_000) return detected.value;
  let value = { available: false, error: 'perplexity-computer MCP not connected (claude mcp add … then /mcp → Authenticate)' };
  try {
    const out = execFileSync(config.bins.claude, ['mcp', 'get', SERVER], { encoding: 'utf8', timeout: 20_000 });
    if (/Connected/.test(out)) value = { available: true, version: 'Computer MCP (OAuth)' };
  } catch { /* not registered */ }
  detected = { at: Date.now(), value };
  return value;
}

function relayCharter(seat, kind) {
  const model = seat.model || 'pplx_asi_kimi_k3';
  const efforts = effortsOf(model);
  const effort = Array.isArray(efforts) && efforts.length === 0 ? '' : `, effort="${seat.effort || 'medium'}"`;
  const review = ['product_review', 'council_review'].includes(kind);
  return `

# You are the hands of ${labelOf(model)} (Perplexity)
Your judgment comes from ${labelOf(model)}, reached with ${T('call_perplexity_computer')}. You do not decide yourself.
1. Read your task. The desk has already gathered the context (the context pack at the end of your instructions); read
   more files only if something specific is missing, and add those excerpts after the pack, never inside it.
2. Call ${T('call_perplexity_computer')} ONCE with model="${model}"${effort} (do not pass mode — Computer rejects mode+model together).
   Tell it to answer read-only: no connected apps, no files, no accounts, nothing outside this conversation.
3. ${review ? 'Return its structured review JSON as your final answer. Do not run desk mutations.' : 'Act on its answer by running the desk commands it decides, quoting its reasoning where useful.'}${kind === 'council_review' ? ' The brief is frozen: answer from the brief and the pack only, request no files, and do not ask for a second opinion.' : ''} For a follow-up, call
   again with the same thread_id.
4. Never approve a Computer action (only ${T('confirm_action_deny')}). If Perplexity fails or times out, say so with
   \`desk comment\` and stop — do not substitute your own judgment.
${context.relayRules()}`;
}

export const perplexity = {
  id: 'perplexity',
  label: 'Perplexity (Computer)',
  autoFallback: false, // never chosen automatically: only for seats the owner explicitly puts on it
  isolation: { reads: 'restricted locally', writes: 'none (thinking seats only)', network: 'Perplexity Computer only',
    note: 'A Perplexity model thinks; a sandboxed local Claude reads code and runs desk commands. Whatever the seat sends to Perplexity (task + code excerpts) leaves this machine, on your Perplexity account.' },
  costNote: 'Perplexity account credits per Computer task, plus a small local Claude relay.',
  canFork: false,
  usesSocket: true,
  supports: (kind) => THINK_KINDS.includes(kind) || (kind === 'council_review' && councilEnabled()),
  // efforts is omitted when unknown (any desk effort) or empty (no effort parameter), so seat validation falls back to EFFORTS.
  models: () => catalog().map((m) => ({ id: m.id, tier: m.tier, note: `${m.label} — ${m.note}`, ...(m.efforts?.length ? { efforts: m.efforts } : {}) })),
  efforts: EFFORTS,
  suggest(tier) {
    return { frontier: { model: 'pplx_asi_kimi_k3', effort: 'high' }, strong: { model: 'pplx_asi_kimi_k3', effort: 'medium' },
      fast: { model: 'pplx_asi_glm_5_3', effort: 'medium' }, cheap: { model: 'pplx_asi_glm_5_3', effort: 'low' } }[tier];
  },
  async detect() {
    const c = await claude.detect();
    if (!c.available) return { available: false, error: 'needs the Claude Code CLI as the local relay' };
    return connected();
  },
  budgetUsd: () => config.engines?.perplexity?.reserveUsd ?? 1.5,

  command(args) {
    const hands = config.engines?.perplexity?.hands || 'sonnet';
    // Build/QA jobs need local file edits: they never go to Perplexity, whatever the seat setting says.
    if (!this.supports(args.kind)) throw new Error(`Perplexity cannot run ${args.kind}; choose a local execution provider`);
    const cmd = claude.command({
      ...args,
      seat: { ...args.seat, engine: 'claude', model: hands, effort: 'low' },
      charter: `${args.charter}${relayCharter(args.seat,args.kind)}`,
      perms: { ...args.perms, allow: [...args.perms.allow, ...ALLOW] },
      denyRules: [...args.denyRules, ...BLOCK],
    });
    const i = cmd.args.indexOf('--mcp-config');
    if (i >= 0) cmd.args[i + 1] = MCP; // the only MCP server a seat ever gets
    cmd.args[cmd.args.indexOf('--max-budget-usd') + 1] = String(config.engines?.perplexity?.relayBudgetUsd ?? 1);
    // A Computer task can take minutes: the MCP call must be allowed to wait as long as the desk does.
    cmd.env = { ...cmd.env, MCP_TOOL_TIMEOUT: String(context.packSettings().remoteWaitMinutes * 60_000) };
    return cmd;
  },

  // Claude's normalized events, plus the desk's checks on what actually went to Perplexity: did the outgoing message
  // carry the context pack verbatim, which requested files followed, and which thread_id to resume on a retry.
  parse(line, cwd, state) {
    const base = claude.parse(line, cwd, state).map((e) => {
      if (e.type !== 'tool' || !e.text.startsWith(T(''))) return e;
      if (e.text.startsWith(T('call_perplexity_computer'))) {
        const model = e.text.match(/"model":"([^"]+)"/)?.[1];
        return { ...e, text: `🔭 Asked ${labelOf(model)} on Perplexity` };
      }
      return { ...e, text: e.text.replace(`mcp__${SERVER}__`, 'Perplexity · ').slice(0, 120) };
    });
    let ev;
    try { ev = JSON.parse(line); } catch { return base; }
    const extra = [];
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type !== 'tool_use') continue;
        if (b.name === T('call_perplexity_computer')) { state.pplxAsked = true; extra.push(...context.recordSend(state.pack, b.id, 'call', b.input || {})); }
        else if (b.name === T('read_thread')) extra.push(...context.recordSend(state.pack, b.id, 'read', b.input || {}));
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b.type !== 'tool_result') continue;
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || '').join('\n') : String(b.content ?? '');
        extra.push(...context.recordResult(state.pack, b.tool_use_id, { isError: !!b.is_error, text }));
      }
    }
    return [...base, ...extra];
  },
};
