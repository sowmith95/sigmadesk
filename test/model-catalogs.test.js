import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-catalogs-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg;
let config, validateConfig, claude, pplx, council, dispatch, store, team, settings;
before(async () => {
  ({ config, validateConfig } = await import('../src/config.js')); config.root = tmp;
  ({ claude } = await import('../src/engines/claude.js')); pplx = await import('../src/engines/perplexity.js');
  council = await import('../src/council.js'); dispatch = await import('../src/dispatch.js'); store = await import('../src/db.js');
  team = await import('../src/team.js'); settings = await import('../src/team-settings.js');
  store.openDb(':memory:');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const catalogFile = () => path.join(tmp, 'data', 'perplexity-models.json');
function writeCatalog(body) { fs.mkdirSync(path.dirname(catalogFile()), { recursive: true }); fs.writeFileSync(catalogFile(), typeof body === 'string' ? body : JSON.stringify(body)); pplx.resetCatalogCache(); }
function clearCatalog() { fs.rmSync(catalogFile(), { force: true }); pplx.resetCatalogCache(); }
const withConfig = (patch, fn) => { const before = JSON.stringify(config.engines); Object.assign(config.engines.claude, patch.claude || {}); Object.assign(config.engines.perplexity, patch.perplexity || {}); try { return fn(); } finally { config.engines = JSON.parse(before); } };

test('claude catalog: the four aliases first, configured ids appended once, aliases never duplicated', () => {
  assert.deepEqual(claude.models().map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  withConfig({ claude: { models: ['claude-opus-5-5', 'opus', 'claude-opus-5-5', ''] } }, () => {
    const ids = claude.models().map((m) => m.id);
    assert.deepEqual(ids, ['fable', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5']);
    assert.match(claude.models().at(-1).note, /access checked on use/);
  });
});

test('perplexity catalog: built-in list without a file; known effort sets are exposed, unknown ones are left open', () => {
  clearCatalog();
  const models = pplx.perplexity.models();
  assert.equal(models.length, 12);
  assert.deepEqual(models.find((m) => m.id === 'pplx_asi_grok').efforts, ['low', 'medium', 'high']);
  assert.equal(models.find((m) => m.id === 'pplx_asi_fable_5').efforts, undefined, 'unknown effort set: any desk effort');
  assert.equal(models.find((m) => m.id === 'pplx_asi_deepseek_v4_pro').efforts, undefined, 'no effort parameter is not a restriction on the seat form');
  assert.deepEqual(pplx.effortsOf('pplx_asi_deepseek_v4_pro'), []);
  assert.equal(pplx.effortsOf('pplx_asi_fable_5'), null);
});

test('perplexity catalog: a recorded models_list adds account models, refreshes effort sets and labels; configured ids follow', () => {
  writeCatalog({ fetched_at: '2026-10-04T12:00:00.000Z', models: [
    { id: 'pplx_asi_grok', label: 'Grok 4.7', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
    { id: 'pplx_asi_new_model', label: 'New Model (Fast)', fast: true, efforts: ['low', 'medium'] },
    { id: 'bad id with spaces', label: 'x' }, null, { label: 'no id' },
  ] });
  withConfig({ perplexity: { models: ['pplx_custom', 'pplx_asi_grok'] } }, () => {
    const models = pplx.perplexity.models();
    assert.deepEqual(models.slice(0, 12).map((m) => m.id), pplx.MODELS.map((m) => m.id), 'built-in order is stable');
    assert.deepEqual(models.find((m) => m.id === 'pplx_asi_grok').efforts, ['low', 'medium', 'high', 'xhigh'], 'live efforts win; non-desk levels dropped');
    const added = models.find((m) => m.id === 'pplx_asi_new_model');
    assert.equal(added.tier, 'strong'); assert.match(added.note, /New Model \(Fast\) — on your account \(listed 2026-10-04\)/); assert.deepEqual(added.efforts, ['low', 'medium']);
    assert.equal(models.at(-1).id, 'pplx_custom'); assert.match(models.at(-1).note, /configured model/);
    assert.equal(models.filter((m) => m.id === 'pplx_asi_grok').length, 1);
    assert.ok(!models.some((m) => /spaces|no id/.test(m.id)));
  });
  writeCatalog('{ not json'); assert.equal(pplx.perplexity.models().length, 12, 'a corrupt file adds nothing');
  writeCatalog({ models: 'nope' }); assert.equal(pplx.perplexity.models().length, 12, 'a reshaped payload adds nothing');
  clearCatalog();
});

test('seat validation enforces a model\'s recorded effort set', () => {
  clearCatalog();
  assert.throws(() => settings.profileFor('pm', { engine: 'perplexity', model: 'pplx_asi_grok', effort: 'xhigh' }), /Unsupported reasoning effort/);
  assert.deepEqual(settings.profileFor('pm', { engine: 'perplexity', model: 'pplx_asi_grok', effort: 'high' }), { engine: 'perplexity', model: 'pplx_asi_grok', effort: 'high' });
  assert.deepEqual(settings.profileFor('pm', { engine: 'perplexity', model: 'pplx_asi_deepseek_v4_pro', effort: 'max' }).model, 'pplx_asi_deepseek_v4_pro');
  assert.throws(() => settings.profileFor('pm', { engine: 'perplexity', model: 'pplx_asi_nope', effort: 'high' }), /outside the Perplexity/);
});

test('relay charter: effort is omitted for models without an effort parameter; council briefs are answered read-only', () => {
  clearCatalog();
  const args = (seat, kind) => pplx.perplexity.command({ seat: { ...team.agentById.pm, engine: 'perplexity', ...seat }, kind, cwd: '/w', perms: team.permissionsFor(kind, '/w'), denyRules: team.DENY_RULES, charter: 'C', settings: {} }).args;
  const charter = (a) => a[a.indexOf('--append-system-prompt') + 1];
  assert.match(charter(args({ model: 'pplx_asi_grok', effort: 'high' }, 'research')), /model="pplx_asi_grok", effort="high"/);
  const deep = charter(args({ model: 'pplx_asi_deepseek_v4_pro', effort: 'high' }, 'research'));
  assert.match(deep, /model="pplx_asi_deepseek_v4_pro" \(do not pass mode/); assert.ok(!/effort="/.test(deep));
  assert.equal(pplx.perplexity.supports('council_review'), false, 'off by default');
  assert.throws(() => args({ model: 'pplx_asi_kimi_k3', effort: 'high' }, 'council_review'), /cannot run council_review/);
  withConfig({ perplexity: { councilEnabled: true } }, () => {
    assert.ok(pplx.perplexity.supports('council_review'));
    const a = args({ model: 'pplx_asi_kimi_k3', effort: 'high' }, 'council_review');
    assert.match(charter(a), /Return its structured review JSON as your final answer\. Do not run desk mutations\. The brief is frozen/);
    assert.ok(a.includes('mcp__perplexity-computer__call_perplexity_computer') && a.indexOf('mcp__perplexity-computer__confirm_action_approve') > a.indexOf('--disallowedTools'));
    assert.ok(!pplx.perplexity.supports('implement') && !pplx.perplexity.supports('qa'));
  });
});

test('config validation rejects a non-boolean council flag and malformed model lists', () => {
  const saved = JSON.stringify(config.engines);
  config.engines.perplexity.councilEnabled = 'yes'; config.engines.claude.models = 'opus'; config.engines.perplexity.models = ['ok_id', 'bad id'];
  const problems = validateConfig(config);
  assert.ok(problems.includes('engines.perplexity.councilEnabled must be true or false'));
  assert.ok(problems.includes('engines.claude.models must be a list of model ids') && problems.includes('engines.perplexity.models must be a list of model ids'));
  assert.ok(!problems.includes('engines.codex.models must be a list of model ids'));
  config.engines = JSON.parse(saved);
  assert.ok(!validateConfig(config).some((p) => /models must be|councilEnabled/.test(p)));
});

test('council pool: Perplexity joins only behind the flag, with families from the model id; Computer status follows', () => {
  clearCatalog();
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true, defaultModel: 'fixture' }, { id: 'perplexity', available: true }]);
  assert.ok(council.models().filter((m) => m.engine).every((m) => ['claude', 'codex'].includes(m.engine)));
  assert.equal(council.computerStatus().enabled, false); assert.equal(council.computerStatus().connected, false); assert.match(council.computerStatus().reason, /not been verified/);
  assert.throws(() => dispatch.reviewSelection('principal-be', { engine: 'perplexity', model: 'pplx_asi_kimi_k3', effort: 'high' }), /approved catalog/);
  assert.deepEqual(['codex', 'claude', 'perplexity', 'perplexity', 'perplexity', 'perplexity', 'perplexity', 'perplexity', 'perplexity'].map((e, i) => council.familyOf(e, ['', 'opus', 'pplx_asi_kimi_k3', 'pplx_asi_grok', 'pplx_asi_glm_5_3', 'pplx_asi_deepseek_v4_pro', 'pplx_asi_gpt_6_1_sol', 'pplx_asi_astra_fast', 'pplx_asi_opus_fast'][i])),
    ['gpt', 'claude', 'kimi', 'grok', 'glm', 'deepseek', 'gpt', 'gpt', 'claude']);
  withConfig({ perplexity: { councilEnabled: true } }, () => {
    const pool = council.models().filter((m) => m.engine === 'perplexity');
    assert.ok(pool.length >= 10 && !pool.some((m) => m.engine_model === 'pplx_asi_glm_5_3'), 'cheap tier stays out of councils');
    const kimi = pool.find((m) => m.id === 'perplexity/pplx_asi_kimi_k3');
    assert.equal(kimi.family, 'kimi'); assert.equal(kimi.ready, true); assert.equal(kimi.effort, 'high'); assert.equal(kimi.reserve_usd, 1.5);
    assert.equal(pool.find((m) => m.id === 'perplexity/pplx_asi_opus').family, 'claude');
    const sel = dispatch.reviewSelection('principal-be', { engine: 'perplexity', model: 'pplx_asi_kimi_k3', effort: 'high' });
    assert.equal(sel.seat.engine, 'perplexity'); assert.equal(sel.seat.model, 'pplx_asi_kimi_k3');
    assert.deepEqual([council.computerStatus().enabled, council.computerStatus().connected], [true, true]);
    const t = store.createTicket({ title: 'Catalog council', description: 'd', status: 'needs_human', area: 'backend', complexity: 'M' });
    const draft = council.create(t.key, { members: [{ model: 'perplexity/pplx_asi_kimi_k3', lens: 'architecture' }, { model: 'perplexity/pplx_asi_grok', lens: 'reliability' }], synthesizer: 'claude/opus' }, false);
    assert.deepEqual(draft.members.filter((m) => m.stage === 'review').map((m) => m.family), ['kimi', 'grok']);
    assert.throws(() => council.create(t.key, { members: [{ model: 'perplexity/pplx_asi_opus', lens: 'architecture' }, { model: 'claude/sonnet', lens: 'reliability' }] }, false), /different model families/);
    dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true, defaultModel: 'fixture' }]);
    assert.equal(council.computerStatus().connected, false); assert.match(council.computerStatus().reason, /Detecting CLI|unavailable/i, 'the relay health reason is passed through');
  });
});
