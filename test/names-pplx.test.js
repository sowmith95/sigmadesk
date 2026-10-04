import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-names-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ project: { name: 'demo', repoPath: repo, githubRepo: '', ticketPrefix: 'N' }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = path.join(tmp, 'config.json');
process.env.SIGMADESK_DB = ':memory:';

let names; let pplx; let team;
before(async () => {
  names = await import('../public/names.js');
  pplx = await import('../src/engines/perplexity.js');
  team = await import('../src/team.js');
});

test('human names read like a person would say them', () => {
  const n = names.shortName;
  assert.equal(n('Fix Eastern session helpers using original DST regressions'), 'Eastern session helpers');
  assert.equal(n('Bound whale Timescale reads and publish explicit cache availability'), 'Whale Timescale reads');
  assert.equal(n('Fix DST bug: quote_validation_service market-hours helpers hardcode UTC-5'), 'DST bug');
  assert.equal(n('Can the desk show my Robinhood buying power on the board?'), 'Robinhood buying power');
  assert.equal(n('Bug: whale tape freezes after phone sleeps'), 'Whale tape freezes');
  assert.equal(n('[SD-9] Show live greeks P&L per open position'), 'Live greeks P&L');
  assert.ok(n('').length >= 0);
});

test('an explicit name wins; mentions become named chips', () => {
  assert.equal(names.nameOf({ title: 'Fix Eastern session helpers', name: 'DST fix' }), 'DST fix');
  const parts = names.linkKeys('Delegated into N-5 and N-6, after N-404', (k) => ({ 'N-5': { title: 'Fix Eastern session helpers' }, 'N-6': { title: 'Track the whale writer handoff' } })[k]);
  assert.deepEqual(parts.filter((p) => typeof p !== 'string').map((p) => p.name), ['Eastern session helpers', 'Whale writer handoff']);
  assert.ok(parts.join('').includes('N-404'), 'unknown keys stay as text');
});

test('perplexity engine: thinking seats get only the Computer MCP; approvals are blocked', () => {
  const seat = { ...team.agentById.pm, engine: 'perplexity', model: 'pplx_asi_kimi_k3', effort: 'high' };
  const cmd = pplx.perplexity.command({ seat, kind: 'research', cwd: '/w', perms: team.permissionsFor('research', '/w'), denyRules: team.DENY_RULES, charter: 'C', settings: {} });
  const a = cmd.args;
  assert.match(a[a.indexOf('--mcp-config') + 1], /perplexity-computer/);
  assert.ok(a.includes('mcp__perplexity-computer__call_perplexity_computer'));
  assert.ok(a.includes('mcp__perplexity-computer__confirm_action_approve'), 'approve is in the deny list');
  assert.ok(a.indexOf('mcp__perplexity-computer__confirm_action_approve') > a.indexOf('--disallowedTools'));
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet', 'a cheap local relay');
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /model="pplx_asi_kimi_k3", effort="high"/);
  assert.ok(a.includes('--setting-sources') && a.includes('--strict-mcp-config'));
});

test('perplexity rejects incompatible execution instead of silently running another model', () => {
  const seat = { ...team.agentById.junior, engine: 'perplexity', model: 'pplx_asi_glm_5_3' };
  assert.throws(() => pplx.perplexity.command({ seat, kind: 'implement' }), /cannot run implement/);
  assert.equal(pplx.perplexity.autoFallback, false);
  assert.ok(pplx.perplexity.supports('product_review') && !pplx.perplexity.supports('qa'));
});

test('perplexity tool calls read as human activity', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__perplexity-computer__call_perplexity_computer', input: { model: 'pplx_asi_glm_5_3', message: 'x' } }] } });
  const evs = pplx.perplexity.parse(line, '/w', {});
  assert.ok(evs.some((e) => e.type === 'tool' && e.text === '🔭 Asked GLM 5.3 on Perplexity'), JSON.stringify(evs));
});

test('docs-only paths are recognised for the evidence gate', async () => {
  const sched = await import('../src/scheduler.js');
  assert.ok(sched.isDocPath('docs/operations/handoff.md') && sched.isDocPath('README.md'));
  assert.ok(!sched.isDocPath('alpaca_trader/app/x.py'));
});
