import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-reliability-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo }, github: { sync: false }, pm: { enabled: false }, watch: { enabled: true } }));
process.env.SIGMADESK_CONFIG = cfg;
process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let config, store, dispatch, runner, team, watch;
before(async () => {
  ({ config } = await import('../src/config.js'));
  store = await import('../src/db.js');
  dispatch = await import('../src/dispatch.js');
  runner = await import('../src/runner.js');
  team = await import('../src/team.js');
  watch = await import('../src/watch.js');
  config.root = tmp; config.dataDir = path.join(tmp, 'data'); // own publisher: test files run in parallel
  store.openDb(':memory:');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const clearHolds = () => {
  for (const e of ['claude', 'codex']) { store.kvSet(`quota:${e}`, 'null'); store.kvSet(`provider-hold:${e}`, 'null'); }
  store.setSetting('auto_fallback', 'true');
};

test('routing: Claude quota switches to Codex, keeps seat preferences and capability effort', () => {
  clearHolds();
  const preferred = { ...team.agentById['principal-be'] };
  store.kvSet('quota:claude', JSON.stringify({ five_hour: .99, seven_day: .1, status: 'allowed', resets_at: new Date(Date.now() + 3600000).toISOString() }));
  const selected = dispatch.selectionFor('principal-be');
  assert.equal(selected.seat.engine, 'codex');
  assert.equal(selected.seat.effort, 'high');
  assert.equal(selected.fallback, true);
  assert.deepEqual(team.agentById['principal-be'], preferred);
  store.setSetting('auto_fallback', 'false');
  assert.equal(dispatch.selectionFor('principal-be').seat, null);
  clearHolds();
});

test('routing: weekly limits, expired quota, allowed warnings and missing providers', () => {
  clearHolds();
  store.kvSet('quota:claude', JSON.stringify({ status: 'allowed_warning', five_hour: .2, seven_day: .9 }));
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'codex');
  store.kvSet('quota:claude', JSON.stringify({ status: 'rejected', five_hour: 1, resets_at: new Date(Date.now() - 1000).toISOString() }));
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'claude');
  store.kvSet('quota:claude', JSON.stringify({ status: 'allowed_warning', five_hour: .3 }));
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'claude');
  store.kvSet('quota:claude', JSON.stringify({ status: 'allowed', five_hour: 1, seven_day: .99, resets_at: new Date(Date.now() - 1000).toISOString(), seven_day_resets_at: new Date(Date.now() + 3600000).toISOString() }));
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'codex', 'five-hour reset cannot clear a weekly hold');
  store.kvSet('quota:claude', 'null');
  dispatch.setAvailability([{ id: 'claude', available: false }, { id: 'codex', available: true }]);
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'codex');
  dispatch.setAvailability([{ id: 'claude', available: false }, { id: 'codex', available: false }]);
  assert.equal(dispatch.selectionFor('qa').seat, null);
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
  clearHolds();
});

test('routing: failures persist cooldowns, switch both ways and recover after reset', () => {
  clearHolds();
  assert.equal(dispatch.classifyProviderFailure('insufficient_quota'), 'quota');
  assert.equal(dispatch.classifyProviderFailure("You've hit your usage limit"), 'quota');
  assert.equal(dispatch.classifyProviderFailure('Authentication required'), 'auth');
  assert.equal(dispatch.classifyProviderFailure('pytest failed: assertion error'), null);
  const hold = dispatch.holdProvider('claude', 'quota', 'out of credits');
  assert.equal(dispatch.selectionFor('junior').seat.engine, 'codex');
  assert.equal(dispatch.selectionFor('junior', Date.parse(hold.until) + 1).seat.engine, 'claude');
  dispatch.holdProvider('codex', 'quota', 'usage_limit_reached');
  assert.equal(dispatch.selectionFor('junior').seat, null);
  store.kvSet('provider-hold:claude', 'null');
  team.applyTeamOverrides({ qa: { engine: 'codex', model: '', effort: 'medium' } });
  assert.equal(dispatch.selectionFor('qa').seat.engine, 'claude');
  team.applyTeamOverrides({});
  clearHolds();
});

test('scratch clones: concurrent seats keep separate mailboxes, same seat resets only its clone', async () => {
  const [a, b] = await Promise.all([runner.ensureReadonlyWorkspace('support'), runner.ensureReadonlyWorkspace('sre')]);
  assert.notEqual(a, b);
  fs.mkdirSync(path.join(a, '.desk-mailbox'));
  fs.writeFileSync(path.join(a, '.desk-mailbox', 'active'), 'keep');
  await runner.ensureReadonlyWorkspace('sre');
  assert.ok(fs.existsSync(path.join(a, '.desk-mailbox', 'active')));
  await runner.ensureReadonlyWorkspace('support');
  assert.ok(!fs.existsSync(path.join(a, '.desk-mailbox', 'active')));
});

test('settings reject invalid limits and booleans', () => {
  for (const value of ['0', '-1', 'NaN', '1.5', 'Infinity', '']) assert.throws(() => store.setSetting('max_concurrent', value));
  assert.throws(() => store.setSetting('daily_budget_usd', '-10'));
  assert.throws(() => store.setSetting('auto_fallback', 'yes'));
  store.setSetting('daily_budget_usd', '12.50');
  assert.equal(store.getSettings().daily_budget_usd, '12.50');
});

test('Codex launchers support native binaries and Node scripts and preserve the default model', async () => {
  const { codexInvocation, codex } = await import('../src/engines/codex.js');
  const native = path.join(tmp, 'native');
  fs.writeFileSync(native, '#!/bin/sh\necho native');
  const script = path.join(tmp, 'node-script');
  fs.writeFileSync(script, '#!/usr/bin/env node\n');
  assert.deepEqual(codexInvocation(native), { bin: native, prefix: [] });
  assert.deepEqual(codexInvocation(script), { bin: process.execPath, prefix: [script] });
  const isolated = path.join(tmp, 'owner-codex');
  fs.mkdirSync(isolated);
  fs.writeFileSync(path.join(isolated, 'config.toml'), 'model = "configured-model"\n');
  const savedHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = isolated;
  try {
    const c = codex.command({ seat: { model: '', effort: 'medium' }, charter: '', cwd: repo });
    assert.equal(c.args[c.args.indexOf('-m') + 1], 'configured-model');
  } finally { if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome; }
});

test('resume is provider/model compatible and reservations survive team changes', async () => {
  clearHolds();
  const { codex } = await import('../src/engines/codex.js');
  const run = store.createRun({ agent_id: 'qa', kind: 'qa', token: 'test', model: 'codex:default', cwd: repo, profile_hash: codex.profileHash() });
  store.updateRun(run.id, { reserve_usd: 2, session_id: 'thread', ended_at: store.now(), status: 'success' });
  const ended = store.getRun(run.id);
  assert.equal(runner.canResume(ended, 2), false);
  team.applyTeamOverrides({ qa: { engine: 'codex', model: '' } });
  assert.equal(runner.canResume(ended, 2), true);
  team.applyTeamOverrides({ qa: { engine: 'codex', model: 'different-model' } });
  assert.equal(runner.canResume(ended, 2), false);
  assert.equal(runner.reservationFor(ended), 2);
  // A Codex session is pinned to the permission profile it was created under: a stale or missing hash, or a profile
  // change since (here: a new read-only path), means a fresh session instead of a resume.
  team.applyTeamOverrides({ qa: { engine: 'codex', model: '' } });
  assert.equal(runner.canResume({ ...ended, profile_hash: 'stale' }, 2), false);
  assert.equal(runner.canResume({ ...ended, profile_hash: null }, 2), false);
  const savedRo = config.project.readOnlyPaths; config.project.readOnlyPaths = [...savedRo, repo];
  try { assert.equal(runner.canResume(ended, 2), false, 'profile changed since the session was created'); } finally { config.project.readOnlyPaths = savedRo; }
  assert.equal(runner.canResume(ended, 2), true);
  team.applyTeamOverrides({});
});

test('watch batches roll back incidents and cursors on a mid-batch failure', async () => {
  const file = path.join(tmp, 'watch.log');
  fs.writeFileSync(file, '');
  config.watch.sources = [{ type: 'file', path: file, label: 'rollback' }];
  store.kvSet('watch:0:file', 'null');
  await watch.pollOnce();
  const before = store.kvGet('watch:0:file');
  fs.appendFileSync(file, 'ERROR first\nERROR second\n');
  const db = store.openDb(':memory:');
  store.kvSet('watch:0:file', before);
  db.exec("CREATE TRIGGER fail_batch BEFORE INSERT ON incidents WHEN NEW.normalized LIKE '%second%' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  const deltas = []; const listener = (m) => { if (m.type === 'incident') deltas.push(m); }; store.bus.on('msg', listener);
  await watch.pollOnce();
  assert.equal(deltas.length, 0, 'rolled-back incidents never reach SSE clients');
  store.bus.off('msg', listener);
  assert.equal(store.listIncidents().length, 0);
  assert.equal(store.kvGet('watch:0:file'), before);
  db.exec('DROP TRIGGER fail_batch');
  await watch.pollOnce();
  assert.equal(store.listIncidents().length, 2);
  await watch.pollOnce();
  assert.ok(store.listIncidents().every((i) => i.count === 1));
  fs.appendFileSync(file, 'ERROR café🙂\nERROR unfinished');
  await watch.pollOnce();
  const pos = JSON.parse(store.kvGet('watch:0:file')).pos;
  assert.equal(pos, Buffer.byteLength('ERROR first\nERROR second\nERROR café🙂\n'));
  fs.appendFileSync(file, ' complete\n');
  await watch.pollOnce();
  assert.equal(store.listIncidents().length, 4);
});

test('real process failures hold the provider and successful unpriced Codex runs reserve spend', async () => {
  clearHolds();
  const cli = path.join(tmp, 'fake-cli.mjs');
  fs.writeFileSync(cli, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end', () => {
    if (process.argv.includes('-p')) { console.log(JSON.stringify({type:'result',is_error:true,subtype:'error_during_execution',errors:['usage_limit_reached']})); process.exitCode=1; }
    else { console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:8}})); }
  });\n`);
  fs.chmodSync(cli, 0o755);
  const oldClaude = config.bins.claude, oldCodex = config.engines.codex.bin;
  config.bins.claude = cli;
  config.engines.codex.bin = cli;
  try {
    const first = await runner.startRun({ agentId: 'support', kind: 'triage', prompt: 'fixture', cwd: repo });
    assert.equal(first.failure, 'quota');
    const second = await runner.startRun({ agentId: 'support', kind: 'triage', prompt: 'fixture', cwd: repo });
    assert.equal(second.run.status, 'success');
    assert.equal(second.run.model, 'codex:default');
    assert.equal(second.run.cost_usd, config.engines.codex.reserveUsd);
    assert.equal(second.run.cost_estimated, 1);
    assert.equal(JSON.parse(second.run.usage_json).input_tokens, 12);
    assert.equal(store.getAgentState('support').status, 'idle');
  } finally { config.bins.claude = oldClaude; config.engines.codex.bin = oldCodex; clearHolds(); }
});
