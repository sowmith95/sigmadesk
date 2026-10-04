// The project team: core seats + advisors from team.json; the legacy desk unchanged; coverage and advisory reviews.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileTeam, teamCoverage, advisorMatches, CORE_IDS, ADVISORS, PACKS } from '../src/team-catalog.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-team-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Load team.js (and product-review.js) in a fresh process for a given project home.
function teamIn(home, script) {
  const code = `const team = await import(${JSON.stringify(path.join(ROOT, 'src/team.js'))}); const pr = await import(${JSON.stringify(path.join(ROOT, 'src/product-review.js'))});\n${script}`;
  return JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], {
    env: { ...process.env, SIGMADESK_HOME: home || '', SIGMADESK_CONFIG: home ? '' : path.join(tmp, 'none.json'), SIGMADESK_DB: ':memory:' }, encoding: 'utf8' }));
}
const home = (name, team) => {
  const h = path.join(tmp, 'projects', name); fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ project: { name } }));
  if (team !== undefined) fs.writeFileSync(path.join(h, 'team.json'), typeof team === 'string' ? team : JSON.stringify(team));
  return h;
};
const TICKETS = [
  { title: 'Show liquidation P&L on positions', area: 'frontend', description: '' },
  { title: 'Backtest the momentum signal', area: 'backend', description: '' },
  { title: 'Add OAuth login and session expiry', area: 'backend', description: '' },
];

test('the legacy desk keeps its 14 seats and exactly today\'s reviewers', () => {
  const out = teamIn(null, `console.log(JSON.stringify({ ids: team.AGENTS.map((a) => a.id), legacy: team.LEGACY_TEAM, problems: team.TEAM_PROBLEMS,
    reviewers: ${JSON.stringify(TICKETS)}.map((t) => pr.reviewersFor(t)), lens: team.lensFor('trading-advisor') }))`);
  assert.deepEqual(out.ids, ['product-design', 'trading-advisor', 'quant-research', 'pm', 'manager', 'principal-be', 'senior-be', 'principal-fe', 'senior-fe', 'dba', 'junior', 'qa', 'sre', 'support']);
  assert.equal(out.legacy, true); assert.deepEqual(out.problems, []);
  assert.deepEqual(out.reviewers, [['pm', 'principal-fe', 'product-design', 'trading-advisor'], ['pm', 'principal-be', 'quant-research'], ['pm', 'principal-be']]);
  assert.match(out.lens, /Trading Workflow Advisor/);
});

test('a project gets core seats plus the advisors its team.json names, including a custom one', () => {
  const h = home('shop', { version: 1, advisors: ['security', 'product-design', { id: 'payments-expert', name: 'Pat', role: 'Payments Advisor', lens: 'You are Pat. Check refunds, idempotency and reconciliation.', triggers: { pattern: 'refund|checkout|payment' } }],
    core: { sre: { enabled: false }, manager: { name: 'Mo' } } });
  const out = teamIn(h, `console.log(JSON.stringify({ ids: team.AGENTS.map((a) => a.id), problems: team.TEAM_PROBLEMS, legacy: team.LEGACY_TEAM,
    sre: team.agentById.sre.enabled, mgr: team.agentById.manager.name, reviewers: ${JSON.stringify([...TICKETS, { title: 'Refund flow for checkout', area: 'backend', description: '' }])}.map((t) => pr.reviewersFor(t)),
    custom: team.lensFor('payments-expert') }))`);
  assert.deepEqual(out.problems, []); assert.equal(out.legacy, false);
  assert.ok(!out.ids.includes('trading-advisor') && !out.ids.includes('quant-research'), 'no trading seats in a non-trading project');
  assert.deepEqual(out.ids.slice(0, 3), ['security', 'product-design', 'payments-expert']);
  assert.equal(out.sre, false); assert.equal(out.mgr, 'Mo');
  assert.deepEqual(out.reviewers[0], ['pm', 'principal-fe', 'product-design']);
  assert.deepEqual(out.reviewers[2], ['pm', 'principal-be', 'security']);
  assert.ok(out.reviewers[3].includes('payments-expert'));
  assert.match(out.custom, /refunds, idempotency/);
});

test('a missing or invalid team.json is a startup problem, never a silent fallback', () => {
  assert.match(teamIn(home('nofile'), 'console.log(JSON.stringify(team.TEAM_PROBLEMS))').join(' '), /team.json is missing/);
  assert.match(teamIn(home('badjson', '{nope'), 'console.log(JSON.stringify(team.TEAM_PROBLEMS))').join(' '), /not valid JSON/);
  const p = compileTeam({ version: 1, advisors: ['NOPE!', { id: 'x-y' }, 'security', 'security'], core: { qa: { enabled: false }, wizard: {} } }).problems.join(' ');
  for (const re of [/advisor id "NOPE!"/, /custom advisor "x-y" needs/, /listed twice/, /QA Engineer cannot be switched off/, /core seat "wizard" does not exist/]) assert.match(p, re);
  assert.match(compileTeam({ advisors: [] }).problems[0], /version/);
});

test('coverage: a team needs a manager, QA, triage, a builder, a principal and two independent reviewers', () => {
  const all = CORE_IDS.map((id) => ({ id }));
  assert.deepEqual(teamCoverage(all), []);
  const off = (...ids) => all.map((s) => ({ ...s, enabled: !ids.includes(s.id) }));
  assert.match(teamCoverage(off('senior-be', 'senior-fe', 'dba', 'junior')).join(' '), /builder/);
  assert.match(teamCoverage(off('principal-be', 'principal-fe')).join(' '), /principal/);
  assert.match(teamCoverage(off('principal-fe', 'senior-fe', 'dba', 'senior-be')).join(' '), /two engineers/);
  assert.deepEqual(teamCoverage(off('sre', 'pm', 'principal-fe', 'senior-fe')), [], 'a backend-only team without SRE or PM is fine');
});

test('the catalog is consistent: every pack advisor exists and trigger patterns compile', () => {
  for (const [name, pack] of Object.entries(PACKS)) for (const id of pack.advisors) assert.ok(ADVISORS[id], `${name} → ${id}`);
  for (const a of Object.values(ADVISORS)) assert.doesNotThrow(() => new RegExp(a.triggers.pattern, 'i'));
  assert.equal(advisorMatches(ADVISORS.security, { title: 'Rotate session tokens', area: 'backend' }), true);
  assert.equal(advisorMatches(ADVISORS.mobile, { title: 'Fix CSV export', area: 'backend' }), false);
});
