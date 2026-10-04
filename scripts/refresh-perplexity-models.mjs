#!/usr/bin/env node
// `npm run models:refresh` — record the Perplexity models this account may use in data/perplexity-models.json.
// One short Claude Code call reaches the Computer MCP server exactly as a thinking seat does, with a single tool
// allowed (models_list, read-only, no credits) and no other tools. The file is written atomically so a running desk
// never reads a partial catalog; src/engines/perplexity.js merges it with the built-in list and engines.perplexity.models.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { EFFORTS, MCP_CONFIG, MODELS_LIST_TOOL, catalogPath } from '../src/engines/perplexity.js';

const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };
if (!config.bins.claude || !fs.existsSync(config.bins.claude)) fail('Claude Code CLI not found (bins.claude); the relay is needed to reach Perplexity Computer');

const prompt = `Call the ${MODELS_LIST_TOOL} tool once. Reply with ONLY the tool result's raw JSON (the object that contains "models"): no prose, no code fence, no changes. Do nothing else.`;
let raw;
try {
  raw = execFileSync(config.bins.claude, ['-p', '--output-format', 'json', '--model', config.engines?.perplexity?.hands || 'sonnet', '--max-turns', '3', '--max-budget-usd', '0.5',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', MCP_CONFIG, '--permission-mode', 'dontAsk', '--tools', '', '--allowedTools', MODELS_LIST_TOOL],
  { input: prompt, encoding: 'utf8', timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MCP_TOOL_TIMEOUT: '90000' } });
} catch (e) {
  fail(`relay call failed: ${String(e.stderr || e.message).trim().slice(0, 400)}\n  Is perplexity-computer connected? \`claude mcp get perplexity-computer\` (docs/perplexity-connection.md)`);
}

let text;
try { const res = JSON.parse(raw); text = res.is_error ? null : String(res.result ?? ''); } catch { text = raw; }
if (!text) fail(`relay reported an error: ${raw.slice(0, 300)}`);
let payload;
try { payload = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { fail(`relay did not return JSON (first 200 chars): ${text.slice(0, 200)}`); }
const list = Array.isArray(payload?.models) ? payload.models : null;
if (!list || !list.length) fail('models_list payload has no "models" array; the server response shape may have changed — nothing written');
const bad = list.filter((m) => !m || typeof m.id !== 'string' || !/^[\w.:-]{1,80}$/.test(m.id));
if (bad.length) fail(`models_list contains ${bad.length} entries without a usable id — nothing written`);

const models = list.map((m) => ({ id: m.id, label: typeof m.label === 'string' ? m.label : m.id, description: typeof m.description === 'string' ? m.description.slice(0, 200) : '',
  fast: m.fast === true, efforts: Array.isArray(m.efforts) ? m.efforts.filter((e) => typeof e === 'string') : [], default_effort: typeof m.default_effort === 'string' ? m.default_effort : null }));
const out = { fetched_at: new Date().toISOString(), source: 'perplexity-computer models_list', default_mode: payload.default_mode ?? null, modes: Array.isArray(payload.modes) ? payload.modes : [], models };
const file = catalogPath();
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
fs.renameSync(tmp, file);
console.log(`✔ ${models.length} models recorded in ${path.relative(config.root, file)} (${out.fetched_at})`);
for (const m of models) console.log(`  ${m.id.padEnd(30)} ${m.label.padEnd(24)} efforts: ${m.efforts.filter((e) => EFFORTS.includes(e)).join(',') || '(none)'}`);
