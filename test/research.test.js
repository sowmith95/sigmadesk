import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-research-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: true, intervalMinutes: 720, maxOpenProposals: 5 },
  research: { programs: [{ id: 'quant-literature', label: 'Quant literature', seat: 'quant-research', enabled: true, intervalMinutes: 1440, window: 'off-market', focus: 'volatility forecasting papers', sources: ['arxiv.org', 'ssrn.com'], tools: { web: true, connectors: [] }, maxProposals: 2, review: { minReviewers: 1, reviewers: ['pm', 'principal-be'] } },
    { id: 'broken', seat: 'nobody', enabled: true, intervalMinutes: 60, window: 'any', tools: { web: false }, maxProposals: 1, review: { minReviewers: 1, reviewers: ['pm'] } }] } }));
process.env.SIGMADESK_CONFIG = cfg;
let store, research, connectors, config;
const CASE = `## Purpose\nx\n## Benefit to the application\nx\n## How it is used\nx\n## SDLC stage improved\ndiscovery\n## Cost\nx\n## Time\nx\n## Data leaving the machine\nx\n## Risks and fallback\nx\n## Success measure\nx\n`;
const MON_10_ET = new Date('2026-10-05T14:00:00Z'), MON_17_ET = new Date('2026-10-05T21:00:00Z'), SUN = new Date('2026-10-04T14:00:00Z');
before(async () => {
  ({ config } = await import('../src/config.js')); store = await import('../src/db.js'); research = await import('../src/research.js'); connectors = await import('../src/connectors.js');
  store.openDb(':memory:');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const base = () => ({ id: 'p', label: 'P', seat: 'pm', enabled: true, intervalMinutes: 60, window: 'any', focus: '', sources: [], tools: { web: true, connectors: [] }, maxProposals: 3, review: { minReviewers: 1, reviewers: ['trading-advisor'] } });

test('market window: pure, timezone and day aware, launch-time semantics', () => {
  const mh = config.research.marketHours;
  assert.equal(research.inWindow(MON_10_ET, mh), true); assert.equal(research.inWindow(MON_17_ET, mh), false); assert.equal(research.inWindow(SUN, mh), false);
  assert.equal(research.windowSatisfied('any', SUN), true);
  assert.equal(research.windowSatisfied('market', MON_10_ET), true); assert.equal(research.windowSatisfied('market', MON_17_ET), false);
  assert.equal(research.windowSatisfied('off-market', MON_10_ET), false); assert.equal(research.windowSatisfied('off-market', SUN), true);
  assert.equal(research.inWindow(MON_10_ET, { ...mh, timezone: 'Asia/Tokyo' }), false, 'Monday 23:00 Tokyo');
});

test('programs derive from legacy pm settings plus config until the owner saves; invalid config entries are reported, not fatal', () => {
  assert.equal(research.configured(), false);
  const ps = research.programs();
  assert.deepEqual(ps.map((p) => p.id), ['product-discovery', 'quant-literature']);
  const d = ps[0];
  assert.deepEqual([d.seat, d.enabled, d.intervalMinutes, d.window, d.tools.web, d.maxProposals, d.review.minReviewers], ['pm', true, 720, 'any', true, 3, 1]);
  assert.deepEqual(d.review.reviewers, ['trading-advisor', 'quant-research', 'principal-be']);
  assert.deepEqual(research.programs()[1].sources, ['arxiv.org', 'ssrn.com']);
  assert.match(research.problems()[0], /broken skipped: program broken: unknown seat nobody/);
  store.setSetting('pm_enabled', 'false'); store.setSetting('pm_interval_min', '30');
  assert.deepEqual([research.get('product-discovery').enabled, research.get('product-discovery').intervalMinutes], [false, 30]);
  store.setSetting('pm_enabled', 'true'); store.setSetting('pm_interval_min', '720');
});

test('validation: every field is checked, reviewers must differ from the researcher, connectors must be approved, engines must fit', () => {
  const ok = research.normalize(base()); assert.equal(ok.id, 'p');
  const bad = (patch, re) => assert.throws(() => research.normalize({ ...base(), ...patch }), re);
  bad({ id: 'Bad Id' }, /kebab-case/); bad({ seat: 'ghost' }, /unknown seat/); bad({ enabled: 'yes' }, /enabled must be/);
  bad({ intervalMinutes: 5 }, /15 to 525600/); bad({ window: 'weekends' }, /window must be/); bad({ maxProposals: 0 }, /1-10/);
  bad({ review: { minReviewers: 1, reviewers: ['pm'] } }, /cannot review its own/); bad({ review: { minReviewers: 2, reviewers: ['trading-advisor'] } }, /at least 2 reviewer/);
  bad({ review: { minReviewers: 1, reviewers: ['trading-advisor', 'trading-advisor'] } }, /distinct existing seats/);
  bad({ tools: { web: true, connectors: ['paper-search'] } }, /connector paper-search is not approved/);
  bad({ sources: ['x'.repeat(201)] }, /sources/);
  assert.throws(() => research.validatePrograms([base(), base()]), /unique/);
  assert.throws(() => research.validatePrograms([]), /1-12/);
  // Engine fit: a Codex seat cannot do web research; connectors need a Claude seat.
  const team = await_import_team();
  const prevSupport = team.agentById['senior-be'].engine; team.agentById['senior-be'].engine = 'codex';
  try {
    bad({ seat: 'senior-be', review: { minReviewers: 1, reviewers: ['pm'] } }, /web search disabled/);
    assert.equal(research.normalize({ ...base(), seat: 'senior-be', tools: { web: false, connectors: [] }, review: { minReviewers: 1, reviewers: ['pm'] } }).seat, 'senior-be');
  } finally { team.agentById['senior-be'].engine = prevSupport; }
  connectors.propose({ name: 'paper-search', case_md: CASE }); connectors.requestAssessment('paper-search');
  connectors.completeAssessment('paper-search', { report: connectors.parseAssessment('{"verdict":"recommend","benefit_score":3,"sdlc_stage":"discovery","risk":"low","rationale":"r","cost_estimate":"0","time_estimate":"0","data_leaving":"q","conditions":[]}'), run_id: 1, reviewer: 'quant-research' });
  connectors.approve('paper-search', { binding: { type: 'http', url: 'https://x.example/mcp' }, tools: ['search'] });
  assert.deepEqual(research.normalize({ ...base(), tools: { web: true, connectors: ['paper-search'] } }).tools.connectors, ['paper-search']);
  team.agentById.pm.engine = 'perplexity';
  try { bad({ tools: { web: true, connectors: ['paper-search'] } }, /Claude Code seats only/); } finally { team.agentById.pm.engine = 'claude'; }
});
let _team; function await_import_team() { return _team; }
before(async () => { _team = await import('../src/team.js'); });

test('saving programs is all-or-nothing, wins over config, mirrors the legacy rows, and reset returns to config', () => {
  assert.throws(() => research.save([base(), { ...base(), id: 'q', seat: 'ghost' }]), /unknown seat/);
  assert.equal(research.configured(), false);
  const saved = research.save([{ ...base(), id: 'product-discovery', enabled: false, intervalMinutes: 90, window: 'off-market' }]);
  assert.equal(saved.length, 1); assert.equal(research.configured(), true);
  assert.deepEqual(research.programs().map((p) => p.id), ['product-discovery'], 'config programs no longer apply once saved');
  assert.deepEqual([store.getSettings().pm_enabled, store.getSettings().pm_interval_min], ['false', '90']);
  assert.throws(() => store.setSetting('research_programs', '[]'), /Settings → Research/);
  store.writeSetting('research_programs', '{not json');
  assert.deepEqual(research.programs().map((p) => p.id), ['product-discovery', 'quant-literature']); assert.match(research.problems()[0], /saved research programs ignored/);
  research.reset(); assert.equal(research.configured(), false);
});

test('eligibility: off, window, cadence (legacy untagged PM runs count), funnel room; due list rotates by oldest run', () => {
  const settings = store.getSettings();
  const [d, q] = research.programs(settings);
  assert.equal(research.eligibility({ ...d, enabled: false }, { now: SUN, settings }).code, 'disabled');
  assert.equal(research.eligibility(q, { now: MON_10_ET, settings }).code, 'window', 'off-market program during market hours');
  assert.equal(research.eligibility(q, { now: MON_17_ET, settings }).ok, true);
  const legacy = store.createRun({ agent_id: 'pm', kind: 'research', token: 'l', model: 'x' });
  store.updateRun(legacy.id, { started_at: new Date(MON_17_ET.getTime() - 60 * 60_000).toISOString() });
  const e = research.eligibility(d, { now: MON_17_ET, settings });
  assert.equal(e.code, 'cadence'); assert.equal(Date.parse(e.next_eligible_at), MON_17_ET.getTime() - 60 * 60_000 + 720 * 60_000);
  assert.equal(research.eligibility(q, { now: MON_17_ET, settings }).ok, true, 'untagged runs belong to the default program only');
  const later = new Date(MON_17_ET.getTime() + 13 * 3600_000);
  assert.deepEqual(research.due(settings, later).map((p) => p.id), ['quant-literature', 'product-discovery'], 'never-run first, then oldest');
  for (let i = 0; i < 5; i++) store.createTicket({ title: `p${i}`, status: 'proposed' });
  assert.equal(research.eligibility(q, { now: later, settings }).code, 'funnel');
  assert.deepEqual(research.due(settings, later), []);
  for (const t of store.ticketsByStatus('proposed')) store.updateTicket(t.key, { status: 'wontdo' });
});

test('job: server-owned allowances and capabilities; connectors resolve fail-closed to approved records', () => {
  const [d] = research.programs();
  const j = research.job(d, { focus: 'alerts', room: 2 });
  assert.deepEqual([j.program, j.seat, j.maxProposals, j.proposals, j.web, j.connectors, j.review.minReviewers], ['product-discovery', 'pm', 2, 0, true, [], 1]);
  assert.equal(j.focus, 'alerts');
  assert.deepEqual(research.requirements({ ...d, tools: { web: false, connectors: ['paper-search'] } }), { web: false, connectors: ['paper-search'] });
  const withConn = research.job({ ...d, tools: { web: true, connectors: ['paper-search'] } });
  assert.deepEqual(withConn.connectors[0], { name: 'paper-search', binding: { type: 'http', url: 'https://x.example/mcp' }, tools: ['search'] });
  connectors.retire('paper-search');
  assert.throws(() => research.job({ ...d, tools: { web: true, connectors: ['paper-search'] } }), /not approved/);
  const st = research.status();
  assert.ok(st.programs[0].code && st.market_hours.timezone === 'America/New_York' && Array.isArray(st.connectors) && st.case_sections.length === 9);
});
