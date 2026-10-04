// Perplexity engine: a Perplexity model (via the Computer MCP server, billed to the owner's account credits) does the
// thinking; a small sandboxed local Claude is its hands — it reads the clone, sends the full context to Perplexity,
// and runs the desk commands the model decides. Only "thinking" seats can use it: Perplexity cannot edit local files,
// so implementation and QA always run on a local engine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { claude } from './claude.js';
import * as context from '../context.js';

const SERVER = 'perplexity-computer';
const MCP = JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: 'https://www.perplexity.ai/rest/computer/mcp' } } });
const T = (name) => `mcp__${SERVER}__${name}`;
const ALLOW = [T('call_perplexity_computer'), T('read_thread'), T('answer_question'), T('confirm_action_deny'), T('models_list')];
// Computer can act in the world (connected apps, files): the desk never lets a seat approve those actions.
const BLOCK = [T('confirm_action_approve'), T('create_attachment_upload'), T('create_asset_download'), T('projects_list'), T('notify_connected')];
// owner_discussion is the manager's design discussion (scheduler.launchDiscussion); council_review and product_review are read-only review passes.
export const THINK_KINDS = ['research', 'groom', 'design', 'consult', 'review', 'triage', 'investigate', 'owner_discussion', 'product_review', 'council_review'];

// From models.list on the owner's account. Ids are passed straight to call_perplexity_computer.
export const MODELS = [
  { id: 'pplx_asi_kimi_k3', label: 'Kimi K3', tier: 'frontier', note: 'architecture & independent design reasoning' },
  { id: 'pplx_asi_grok', label: 'Grok 4.7', tier: 'frontier', note: 'reliability, adversarial review' },
  { id: 'pplx_asi_glm_5_3', label: 'GLM 5.3', tier: 'cheap', note: 'fewest credits; delivery & cost review' },
  { id: 'pplx_asi_deepseek_v4_pro', label: 'DeepSeek V4 Pro', tier: 'strong', note: 'strong reasoning, US hosted' },
  { id: 'pplx_asi_gpt_6_1_sol', label: 'GPT-6.1 Sol', tier: 'frontier', note: 'complex tasks' },
  { id: 'pplx_asi_gpt_6_1_sol_fast', label: 'GPT-6.1 Sol fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_astra', label: 'GPT-6 Astra', tier: 'frontier', note: 'complex tasks' },
  { id: 'pplx_asi_astra_fast', label: 'GPT-6 Astra fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_opus', label: 'Claude Opus 5.5', tier: 'strong', note: "Perplexity's default" },
  { id: 'pplx_asi_opus_fast', label: 'Claude Opus 5.5 fast', tier: 'strong', note: 'faster' },
  { id: 'pplx_asi_sonnet', label: 'Claude Sonnet 5.5', tier: 'fast', note: 'fewer credits' },
  { id: 'pplx_asi_fable_5', label: 'Claude Fable 5.1', tier: 'frontier', note: 'most powerful; extra credits' },
  { id: 'pplx_model_council', label: 'Model Council', tier: 'frontier', note: 'multi-model consensus and synthesis in Computer' },
];
const labelOf = (id) => MODELS.find((m) => m.id === id)?.label || id || 'Perplexity default';

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
  return `

# You are the hands of ${labelOf(model)} (Perplexity)
Your judgment comes from ${labelOf(model)}, reached with ${T('call_perplexity_computer')}. You do not decide yourself.
1. Read your task. The desk has already gathered the context (the context pack at the end of your instructions); read
   more files only if something specific is missing, and add those excerpts after the pack, never inside it.
2. Call ${T('call_perplexity_computer')} ONCE with model="${model === 'pplx_model_council' ? 'pplx_asi_kimi_k3' : model}", effort="${seat.effort || 'medium'}"${model === 'pplx_model_council' ? ', mode="council"' : ''} (do not pass mode when passing model unless invoking Model Council).
   Tell it to answer read-only: no connected apps, no files, no accounts, nothing outside this conversation.
3. ${['product_review', 'council_review'].includes(kind) ? 'Return its structured review as your final answer. Do not run desk mutations.' : 'Act on its answer by running the desk commands it decides, quoting its reasoning where useful.'} For a follow-up, call
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
  supports: (kind) => THINK_KINDS.includes(kind),
  models: () => {
    let cache = {};
    try {
      const cacheFile = path.join(process.env.PERPLEXITY_HOME || path.join(os.homedir(), '.perplexity'), 'models_cache.json');
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch { /* use base catalog */ }
    const choices = (cache.models || []).map((x) => ({
      id: x.slug || x.id,
      label: x.display_name || x.label || x.name || x.id,
      tier: x.tier || 'frontier',
      efforts: x.supported_reasoning_levels || x.efforts,
      note: `Perplexity catalog${cache.fetched_at ? ` · ${cache.fetched_at}` : ''}; access checked on use`,
    }));
    const combined = [...MODELS];
    for (const m of choices) {
      if (!combined.some((x) => x.id === m.id)) combined.push(m);
    }
    for (const id of config.engines?.perplexity?.models || []) {
      if (!combined.some((x) => x.id === id)) combined.push({ id, label: id, tier: 'frontier', note: 'Configured model; access checked on use' });
    }
    return combined.map((m) => ({ id: m.id, tier: m.tier, note: `${m.label || m.id} — ${m.note || ''}` }));
  },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
      charter: `${args.charter}${relayCharter(args.seat, args.kind)}`,
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
        const model = e.text.match(/\"model\":\"([^\"]+)\"/)?.[1];
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
