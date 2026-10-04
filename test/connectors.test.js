import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-connectors-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: false },
  research: { connectors: { 'paper-search': { purpose: 'Academic paper search', binding: { type: 'stdio', command: process.execPath, args: ['-e', '0'] }, tools: ['search_arxiv'] }, 'Bad Name': { purpose: 'x' } } } }));
process.env.SIGMADESK_CONFIG = cfg;
let store, connectors;
const CASE = `## Purpose\nSearch arXiv for options-pricing papers.\n## Benefit to the application\nResearchers cite primary sources instead of blog posts.\n## How it is used\nread-only search during research runs\n## SDLC stage improved\ndiscovery\n## Cost\nfree API, ~20 calls per run\n## Time\n30 min setup, 2s per call\n## Data leaving the machine\nsearch queries only\n## Risks and fallback\nrate limits; fall back to web search\n## Success measure\nproposals cite at least one paper and pass review\n`;
before(async () => { store = await import('../src/db.js'); connectors = await import('../src/connectors.js'); store.openDb(':memory:'); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('case validation requires every governance section and redacts secrets', () => {
  assert.throws(() => connectors.validateCase(''), /case is required/);
  assert.throws(() => connectors.validateCase('## Purpose\nx'), /Missing case sections: Benefit to the application, How it is used/);
  assert.ok(!connectors.validateCase(`${CASE}\ntoken=abcdef123456`).includes('abcdef123456'));
});

test('bindings: https only for http, existing absolute command for stdio, never credentials', () => {
  assert.deepEqual(connectors.validateBinding({ type: 'http', url: 'https://mcp.example.com/sse' }), { type: 'http', url: 'https://mcp.example.com/sse' });
  assert.throws(() => connectors.validateBinding({ type: 'http', url: 'http://plain.example.com' }), /https/);
  assert.throws(() => connectors.validateBinding({ type: 'stdio', command: 'python3' }), /absolute command path/);
  assert.throws(() => connectors.validateBinding({ type: 'stdio', command: '/definitely/not/here' }), /exists on this machine/);
  assert.throws(() => connectors.validateBinding({ type: 'http', url: 'https://x.example', headers: { Authorization: 'Bearer x' } }), /no credentials/);
  assert.throws(() => connectors.validateBinding({ type: 'stdio', command: process.execPath, env: { KEY: 'v' } }), /no credentials/);
  assert.deepEqual(connectors.validateBinding({ type: 'stdio', command: process.execPath }), { type: 'stdio', command: process.execPath, args: [] });
  assert.throws(() => connectors.validateTools([]), /1-40 tool names/);
  assert.throws(() => connectors.validateTools(['a', 'a']), /distinct/);
});

test('seeding from config creates proposed connectors only; invalid names are skipped', () => {
  connectors.seed();
  const ps = connectors.get('paper-search');
  assert.equal(ps.status, 'proposed'); assert.equal(ps.proposed_by, 'config'); assert.deepEqual(ps.tools, ['search_arxiv']); assert.equal(ps.binding.type, 'stdio');
  assert.equal(connectors.get('Bad Name'), null);
  assert.equal(connectors.isApproved('paper-search'), false);
  assert.throws(() => connectors.approvedFor(['paper-search']), /not approved/);
  connectors.seed(); assert.equal(connectors.list().length, 1, 'idempotent');
});

test('lifecycle: propose → assess → approve → retire, with gates at each step', () => {
  assert.throws(() => connectors.propose({ name: 'Knowledge Hub', case_md: CASE }), /kebab-case/);
  assert.throws(() => connectors.propose({ name: 'knowledge-hub', case_md: '## Purpose\nx' }), /Missing case sections/);
  const kh = connectors.propose({ name: 'knowledge-hub', case_md: CASE, proposed_by: 'pm' });
  assert.equal(kh.status, 'proposed'); assert.match(kh.purpose, /Search arXiv/);
  assert.throws(() => connectors.propose({ name: 'knowledge-hub', case_md: CASE }), /already exists/);
  assert.throws(() => connectors.approve('knowledge-hub', { binding: { type: 'http', url: 'https://x.example/mcp' }, tools: ['kb_search'] }), /requires a completed independent assessment/);
  assert.equal(connectors.assessorFor(connectors.get('knowledge-hub')), 'quant-research', 'domain pick');
  assert.equal(connectors.assessorFor({ ...connectors.get('knowledge-hub'), proposed_by: 'quant-research' }), 'trading-advisor', 'never the proposer');
  assert.equal(connectors.assessorFor({ purpose: 'CI log search', case_md: 'build logs', proposed_by: 'pm' }), 'principal-be');
  connectors.requestAssessment('knowledge-hub');
  assert.equal(connectors.get('knowledge-hub').status, 'assessing'); assert.equal(connectors.pendingAssessments().length, 1);
  connectors.markAssessmentRun('knowledge-hub', 42); assert.equal(connectors.pendingAssessments().length, 0);
  assert.throws(() => connectors.parseAssessment('{"verdict":"maybe"}'), /Assessment needs/);
  const report = connectors.parseAssessment('```json\n{"verdict":"recommend","benefit_score":4,"sdlc_stage":"discovery","risk":"low","rationale":"r","cost_estimate":"$0","time_estimate":"1h","data_leaving":"queries","conditions":[]}\n```');
  connectors.completeAssessment('knowledge-hub', { report, run_id: 42, reviewer: 'quant-research' });
  assert.equal(connectors.get('knowledge-hub').status, 'assessed'); assert.equal(connectors.get('knowledge-hub').assessment.benefit_score, 4);
  assert.throws(() => connectors.approve('knowledge-hub', { tools: ['kb_search'] }), /binding must be an object/);
  assert.throws(() => connectors.approve('knowledge-hub', { binding: { type: 'http', url: 'https://x.example/mcp' }, tools: ['kb_search'], review_after_days: 1 }), /7-365/);
  const approved = connectors.approve('knowledge-hub', { binding: { type: 'http', url: 'https://x.example/mcp' }, tools: ['kb_search', 'kb_query'], note: 'useful for discovery' });
  assert.equal(approved.status, 'approved'); assert.equal(approved.approved_by, 'owner'); assert.ok(approved.review_after > approved.approved_at); assert.equal(approved.due_for_review, false);
  assert.ok(connectors.isApproved('knowledge-hub'));
  assert.deepEqual(connectors.approvedFor(['knowledge-hub'])[0].tools, ['kb_search', 'kb_query']);
  assert.throws(() => connectors.updateCase('knowledge-hub', { purpose: 'x' }), /retire an approved connector/);
  assert.throws(() => connectors.reject('knowledge-hub'), /cannot be rejected/);
  connectors.retire('knowledge-hub', 'replaced'); assert.equal(connectors.get('knowledge-hub').status, 'retired');
  assert.throws(() => connectors.approvedFor(['knowledge-hub']), /not approved/);
});

test('failed assessments return to proposed; restart recovery resets in-flight assessments', () => {
  connectors.propose({ name: 'massive', case_md: CASE });
  connectors.requestAssessment('massive'); connectors.completeAssessment('massive', { error: 'provider down', run_id: 7 });
  assert.equal(connectors.get('massive').status, 'proposed'); assert.match(connectors.get('massive').decision_note, /assessment failed/);
  connectors.requestAssessment('massive'); connectors.markAssessmentRun('massive', 8); connectors.recover();
  assert.equal(connectors.get('massive').status, 'proposed'); assert.match(connectors.get('massive').decision_note, /restart/);
  connectors.reject('massive', 'too expensive'); assert.equal(connectors.get('massive').status, 'rejected');
});

test('what Claude receives: transport only, desk credentials scrubbed from stdio, explicit tool rules', () => {
  const rec = { name: 'paper-search', binding: { type: 'stdio', command: '/opt/venv/bin/python3', args: ['-m', 'paper_search'] }, tools: ['search_arxiv', 'read_arxiv_paper'] };
  const srv = connectors.mcpServerFor(rec);
  assert.equal(srv.command, '/usr/bin/env');
  assert.deepEqual(srv.args.slice(0, 6), ['-u', 'DESK_RUN_TOKEN', '-u', 'DESK_SOCKET', '-u', 'DESK_MAILBOX']);
  assert.deepEqual(srv.args.slice(-3), ['/opt/venv/bin/python3', '-m', 'paper_search']);
  assert.deepEqual(connectors.mcpServerFor({ name: 'h', binding: { type: 'http', url: 'https://x.example/mcp' } }), { type: 'http', url: 'https://x.example/mcp' });
  assert.deepEqual(connectors.allowRulesFor([rec]), ['mcp__paper-search__search_arxiv', 'mcp__paper-search__read_arxiv_paper']);
  assert.ok(!JSON.stringify(connectors.mcpServersFor([rec])).includes('purpose'));
});

test('usage metrics follow runs that carried the connector and the proposals they produced', () => {
  const run = store.createRun({ agent_id: 'pm', kind: 'research', token: 't1', model: 'x', program: 'product-discovery', job: { connectors: [{ name: 'paper-search' }] } });
  store.updateRun(run.id, { cost_usd: 1.25 });
  const t = store.createTicket({ title: 'Cite papers', status: 'proposed', source: 'research' });
  store.updateTicket(t.key, { research_run: run.id, research_review: 'passed' });
  const u = connectors.usage('paper-search');
  assert.deepEqual([u.runs, u.cost_usd, u.proposals, u.passed_review], [1, 1.25, 1, 1]);
  assert.equal(connectors.usage('nope').runs, 0);
});
