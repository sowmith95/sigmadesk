import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Isolated config + throwaway git repo, set up before any module reads the config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-test-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'ignore' });
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  project: { name: 'demo', repoPath: repo, githubRepo: '', ticketPrefix: 'T' },
  github: { sync: false },
  watch: { enabled: true, sources: [], newSignatureMinCount: 2, stormSignatures: 3 },
  limits: { busyWindow: { enabled: true, timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:30', end: '16:15', maxConcurrent: 1 } },
}));
process.env.SIGMADESK_CONFIG = cfgFile;
process.env.SIGMADESK_DB = ':memory:';

let store; let sched; let team; let runner; let watch; let config;
before(async () => {
  ({ config } = await import('../src/config.js'));
  store = await import('../src/db.js');
  team = await import('../src/team.js');
  runner = await import('../src/runner.js');
  watch = await import('../src/watch.js');
  sched = await import('../src/scheduler.js');
  store.openDb(':memory:');
});

const fakeRun = (agent_id, kind, ticket_key = null, extra = {}) => store.createRun({ agent_id, kind, ticket_key, token: `tok-${Math.random()}`, model: 'x', ...extra });

test('config: file + defaults merge, ticket prefix', () => {
  assert.equal(config.project.name, 'demo');
  assert.equal(config.limits.maxConcurrent, 3);
  const t = store.createTicket({ title: 'hello' });
  assert.match(t.key, /^T-\d+$/);
});

test('routing: area × complexity × risk', () => {
  assert.equal(team.routeTicket({ area: 'db', complexity: 'S' }), 'dba');
  assert.equal(team.routeTicket({ area: 'backend', complexity: 'S' }), 'junior');
  assert.equal(team.routeTicket({ area: 'backend', complexity: 'S', risk: 'high' }), 'principal-be');
  assert.equal(team.routeTicket({ area: 'frontend', complexity: 'M' }), 'senior-fe');
  assert.equal(team.routeTicket({ area: 'frontend', complexity: 'XL' }), 'principal-fe');
  assert.equal(team.routeTicket({ area: 'backend', complexity: 'L' }), 'principal-be');
});

test('permissions: support bot only gets the desk CLI; deny list blocks pushes and docker', () => {
  const p = team.permissionsFor('triage');
  assert.deepEqual(p.tools, ['Read', 'Grep', 'Glob', 'Bash']);
  assert.ok(p.allow.includes('Bash(desk *)'));
  assert.ok(!p.allow.some((r) => r.startsWith('Edit')));
  for (const r of ['Bash(git push *)', 'Bash(docker *)', 'Bash(gh *)', 'Bash(curl *)']) assert.ok(team.DENY_RULES.includes(r), r);
  assert.ok(team.permissionsFor('implement').tools.includes('Edit'));
  assert.ok(!team.permissionsFor('qa').tools.includes('Edit'));
});

test('sandbox settings: no unsandboxed escape, only the agent socket, secrets unreadable', () => {
  const s = runner.sandboxSettings('/tmp/ws', [], 'implement');
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(s.sandbox.network.allowUnixSockets, [config.socketPath]);
  assert.ok(s.sandbox.filesystem.denyRead.includes('~/.ssh'));
  assert.ok(s.permissions.deny.includes('Read(~/.ssh/**)'));
  assert.equal(runner.sandboxSettings('/tmp/ws', [], 'triage').sandbox.autoAllowBashIfSandboxed, false);
  const args = runner.buildArgs(team.agentById.junior, 'implement', '/tmp/ws');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(!args.includes('--resume'));
  const resumed = runner.buildArgs(team.agentById.pm, 'review', '/tmp/ws', { resume: 'abc', fork: true });
  assert.deepEqual(resumed.slice(1, 4), ['--resume', 'abc', '--fork-session']);
});

test('redaction strips tokens, DSN passwords and key=value secrets', () => {
  const out = store.redact('token=abcdef123456 ghp_ABCDEFGHIJKLMNOPQRSTUVWX postgresql://u:hunter2@db:5432/x sk-ant-api03-zzzzzzzzzzzz');
  assert.ok(!out.includes('abcdef123456'));
  assert.ok(!out.includes('ghp_ABCD'));
  assert.ok(!out.includes('hunter2'));
  assert.ok(!out.includes('sk-ant-api03'));
});

test('stream parsing: tool use → readable activity, TodoWrite → progress', () => {
  assert.equal(runner.describeToolUse('Read', { file_path: '/w/a/b.py' }, '/w'), 'Reading a/b.py');
  assert.equal(runner.describeToolUse('Bash', { command: 'desk progress 5 x' }), null);
  assert.match(runner.describeToolUse('Bash', { command: 'pytest -q' }), /^\$ pytest -q/);
  assert.deepEqual(runner.todoProgress([{ status: 'completed', content: 'a' }, { status: 'in_progress', content: 'b', activeForm: 'Doing b' }]), { pct: 50, msg: 'Doing b' });
});

test('busy window honours timezone and days', () => {
  assert.equal(sched.inBusyWindow(new Date('2026-10-05T14:00:00Z')), true); // Mon 10:00 ET
  assert.equal(sched.inBusyWindow(new Date('2026-10-05T21:00:00Z')), false); // Mon 17:00 ET
  assert.equal(sched.inBusyWindow(new Date('2026-10-04T14:00:00Z')), false); // Sunday
});

test('desk actions: role permissions are enforced', async () => {
  const pmRun = fakeRun('pm', 'research');
  const out = await sched.deskAction(pmRun, 'propose', { title: 'Faster flow read', body: '## Problem\nslow', area: 'frontend', priority: 'P1' });
  const key = out.match(/T-\d+/)[0];
  assert.equal(store.getTicket(key).status, 'proposed');
  await assert.rejects(sched.deskAction(pmRun, 'groom', { key, complexity: 'S', area: 'frontend' }), /cannot run "groom"/);
  const emRun = fakeRun('manager', 'groom', key);
  await sched.deskAction(emRun, 'groom', { key, complexity: 'M', area: 'frontend', body: 'spec' });
  const t = store.getTicket(key);
  assert.equal(t.status, 'todo');
  assert.equal(t.assignee, 'senior-fe');
  assert.match(t.description, /Groomed spec/);
  const jr = fakeRun('junior', 'implement', key);
  await assert.rejects(sched.deskAction(jr, 'qa', { verdict: 'pass' }), /cannot run "qa"/);
  // a seat cannot report progress on someone else's ticket
  const other = store.createTicket({ title: 'other', status: 'todo' });
  await assert.rejects(sched.deskAction(jr, 'progress', { key: other.key, pct: 10 }), /only act on your current ticket/);
});

test('needs-human parks the ticket and an owner reply resumes it', async () => {
  const t = store.createTicket({ title: 'q', status: 'in_progress' });
  const run = fakeRun('senior-be', 'implement', t.key);
  await sched.deskAction(run, 'needs-human', { body: 'Which account?' });
  assert.equal(store.getTicket(t.key).status, 'needs_human');
  sched.ownerReply(t.key, 'Use paper.');
  assert.equal(store.getTicket(t.key).status, 'todo');
});

test('acceptance: PM-proposed work goes to the PM after QA; owner tickets skip it', () => {
  assert.equal(sched.requesterOf({ reporter: 'pm' }), 'pm');
  assert.equal(sched.requesterOf({ reporter: 'sre' }), 'sre');
  assert.equal(sched.requesterOf({ reporter: 'owner' }), null);
});

test('support routing moves triage tickets and can call the owner', async () => {
  const t = store.createTicket({ title: 'pls', status: 'triage' });
  await sched.deskAction(fakeRun('support', 'triage', t.key), 'route', { to: 'human', body: 'money question' });
  assert.equal(store.getTicket(t.key).status, 'needs_human');
  const t2 = store.createTicket({ title: 'bug', status: 'triage' });
  await sched.deskAction(fakeRun('support', 'triage', t2.key), 'route', { to: 'manager', type: 'bug', priority: 'P1' });
  assert.equal(store.getTicket(t2.key).status, 'proposed');
  assert.equal(store.getTicket(t2.key).priority, 'P1');
});

test('watch: fingerprints ignore volatile parts', () => {
  const a = watch.signatureOf('api', '2026-10-03 12:00:01 ERROR order 12345 failed for O:SPY261003C00580000 id=3f2a9c1e-1111-2222-3333-444455556666');
  const b = watch.signatureOf('api', '2026-10-03 13:22:09 ERROR order 99 failed for O:QQQ261003P00480000 id=aaaaaaaa-1111-2222-3333-444455556666');
  assert.equal(a.sig, b.sig);
  assert.notEqual(a.sig, watch.signatureOf('worker', 'ERROR order 1 failed').sig);
});

test('watch: SRE files an incident ticket that flows to grooming; mute is final', async () => {
  const inc = store.recordIncident({ signature: 'abc123', normalized: 'ERROR boom #', source_index: 0, label: 'api', project: 'demo', line: 'ERROR boom 1', ts: store.now() });
  store.updateIncident(inc.id, { status: 'investigating' });
  const run = fakeRun('sre', 'investigate', null, { incident_id: inc.id });
  const out = await sched.deskAction(run, 'incident', { action: 'file', title: 'boom: null deref', severity: 'P1', area: 'backend', body: '## Root cause\nx' });
  const key = out.match(/T-\d+/)[0];
  const t = store.getTicket(key);
  assert.equal(t.status, 'proposed');
  assert.equal(t.reporter, 'sre');
  assert.equal(store.getIncident(inc.id).status, 'ticketed');
  await assert.rejects(sched.deskAction(run, 'incident', { action: 'mute', body: 'x' }), /already decided/);
  // ticket done → incident resolved
  store.updateTicket(key, { status: 'done' });
  assert.equal(store.getIncident(inc.id).status, 'resolved');
});

test('watch: file source → signatures → a burst of new ones is ONE page, not N tickets', async () => {
  const log = path.join(tmp, 'app.log');
  fs.writeFileSync(log, 'INFO boot\n');
  config.watch.sources = [{ type: 'file', path: log, project: 'demo', label: 'app' }];
  await watch.pollOnce(); // first poll starts at end of file
  const lines = [];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) lines.push(`2026-10-03 12:00:0${k} ERROR subsystem${'abcd'[i]} exploded code=${k}`);
  lines.push('INFO all good', 'DEBUG error-free line? no: contains error but ignored? ');
  fs.appendFileSync(log, `${lines.join('\n')}\n`);
  const touched = await watch.pollOnce();
  assert.ok(touched.size >= 4);
  assert.equal(watch.health()[0].ok, true);
  const d = watch.triageIncidents();
  assert.ok(d.page && d.page.length >= 3, 'storm detected');
  const before = store.listTickets().length;
  sched.watchDecisions();
  const after = store.listTickets();
  assert.equal(after.length, before + 1, 'exactly one page ticket');
  assert.equal(after[0].status, 'needs_human');
  assert.equal(after[0].priority, 'P0');
  config.watch.sources = [];
});

test('UI owner auth: settings reject unknown keys', () => {
  assert.throws(() => store.setSetting('rm_rf', '1'), /unknown setting/);
  store.setSetting('max_concurrent', '2');
  assert.equal(store.getSettings().max_concurrent, '2');
});

test('engines: codex seat builds a sandboxed, network-off command with an isolated CODEX_HOME and the mailbox', async () => {
  const { ENGINES, suggestFor, presets } = await import('../src/engines/index.js');
  const seat = { ...team.agentById.qa, engine: 'codex', model: '', effort: 'max' };
  const cmd = runner.buildCommand(seat, 'qa', '/tmp/ws');
  assert.equal(cmd.args[1], 'exec');
  assert.ok(cmd.args.includes('workspace-write'));
  assert.ok(cmd.args.includes('model_reasoning_effort=xhigh'), 'max maps to xhigh for codex');
  assert.ok(cmd.mailbox);
  const toml = fs.readFileSync(path.join(cmd.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(toml, /network_access = false/);
  assert.match(cmd.wrapPrompt('do it'), /<seat-charter>[\s\S]*Taylor[\s\S]*do it$/);
  const resumed = runner.buildCommand(seat, 'implement', '/tmp/ws', { resume: 'thread-1' });
  assert.deepEqual(resumed.args.slice(1, 3), ['exec', 'resume']);
  assert.equal(ENGINES.codex.canFork, false);
  assert.deepEqual(suggestFor('principal-be', 'claude'), { model: 'fable', effort: 'xhigh' });
  assert.equal(suggestFor('support', 'claude').model, 'haiku');
  const mixed = presets(['claude', 'codex']).find((p) => p.id === 'mixed');
  assert.equal(mixed.engine('qa'), 'codex');
  assert.equal(mixed.engine('junior'), 'claude');
});

test('engines: codex JSONL normalizes to desk events', async () => {
  const { ENGINES } = await import('../src/engines/index.js');
  const st = {};
  const p = (o) => ENGINES.codex.parse(JSON.stringify(o), '/w', st);
  assert.deepEqual(p({ type: 'thread.started', thread_id: 't1' }), [{ type: 'session', id: 't1' }]);
  assert.deepEqual(p({ type: 'item.started', item: { type: 'command_execution', command: "/bin/bash -lc 'pytest -q'" } }), [{ type: 'tool', text: '$ pytest -q' }]);
  assert.deepEqual(p({ type: 'item.started', item: { type: 'command_execution', command: "/bin/bash -lc 'desk progress 5 x'" } }), []);
  assert.equal(p({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/w/a.py', kind: 'update' }] } })[0].text, 'Editing a.py');
  assert.equal(p({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } })[0].type, 'result');
});

test('team overrides switch a seat engine live and can be reverted', () => {
  team.applyTeamOverrides({ junior: { engine: 'codex', model: '', effort: 'medium' } });
  assert.equal(team.agentById.junior.engine, 'codex');
  team.applyTeamOverrides({});
  assert.equal(team.agentById.junior.engine, 'claude');
  assert.equal(team.agentById.junior.model, 'sonnet');
});

test('security: edit tools are scoped to the seat workspace; web tools only for research', () => {
  const impl = team.permissionsFor('implement', '/ws/T-9');
  assert.ok(impl.allow.includes('Edit(//ws/T-9/**)'));
  assert.ok(!impl.allow.includes('Edit'), 'no unscoped Edit');
  assert.ok(!impl.tools.includes('WebFetch'));
  assert.ok(team.permissionsFor('research').tools.includes('WebFetch'));
  assert.ok(!team.permissionsFor('qa').tools.includes('WebSearch'));
});

test('security: sandbox hides desk state + transcripts and write-protects read-only paths', () => {
  const s = runner.sandboxSettings('/ws/x', ['/ws/other'], 'qa', '/run/r1.sock');
  for (const p of [path.join(config.root, 'data'), '~/.claude', '~/.codex', config.configFile]) assert.ok(s.sandbox.filesystem.denyRead.includes(p), p);
  assert.ok(s.sandbox.filesystem.denyWrite.includes('/ws/other'));
  assert.ok(s.sandbox.filesystem.denyWrite.includes(config.project.repoPath));
  assert.deepEqual(s.sandbox.network.allowUnixSockets, ['/run/r1.sock']);
  assert.deepEqual(s.permissions.additionalDirectories, []);
});

test('security: QA verdicts need the per-run code; seats cannot act on tickets they were not given', async () => {
  const t = store.createTicket({ title: 'qa me', status: 'qa' });
  const qaRun = fakeRun('qa', 'qa', t.key, { nonce: 'c0ffee1234' });
  await assert.rejects(sched.deskAction(qaRun, 'qa', { verdict: 'fail', body: 'x' }), /--code/);
  await assert.rejects(sched.deskAction(qaRun, 'qa', { verdict: 'fail', code: 'nope', body: 'x' }), /--code/);
  await sched.deskAction(qaRun, 'qa', { verdict: 'fail', code: 'c0ffee1234', body: '1. broken' });
  assert.equal(store.getTicket(t.key).status, 'todo');
  const a = store.createTicket({ title: 'a', status: 'triage' });
  const b = store.createTicket({ title: 'b', status: 'triage' });
  await assert.rejects(sched.deskAction(fakeRun('support', 'triage', a.key), 'route', { key: b.key, to: 'manager' }), /only route the ticket you were given/);
});

test('security: the publisher only pushes an approved full SHA', async () => {
  await assert.rejects(runner.pushBranch('/tmp/nowhere', 'b', 'HEAD'), /approved commit SHA/);
});

test('budget: a run with no final report is charged at its cap', async () => {
  const r = fakeRun('junior', 'implement');
  sched.recoverOrphans();
  const after = store.getRun(r.id);
  assert.equal(after.status, 'killed');
  assert.equal(after.cost_estimated, 1);
  assert.ok(after.cost_usd > 0);
});

test('publish guard: CI, containers, hooks and lockfiles are protected; big diffs are capped', () => {
  const r = (files, lines = 10, c = 'S') => sched.guardReasons(files, lines, c);
  assert.equal(r(['alpaca_trader/app/x.py']).length, 0);
  assert.match(r(['.github/workflows/deploy.yml'])[0], /protected/);
  assert.match(r(['infra/Dockerfile.whale'])[0], /protected/);
  assert.match(r(['ui/package-lock.json'])[0], /protected/);
  assert.match(r(['scripts/run.sh'])[0], /protected/);
  assert.match(r(['a.py'], 900, 'S')[0], /cap/);
  assert.equal(r(['a.py'], 900, 'M').length, 0);
});

test('evidence gate: QA cannot pass without a successful test command in its own run', async () => {
  const t = store.createTicket({ title: 'needs evidence', status: 'qa' });
  const qaRun = fakeRun('qa', 'qa', t.key, { nonce: 'abc123abc1' });
  await assert.rejects(sched.deskAction(qaRun, 'qa', { verdict: 'pass', code: 'abc123abc1', body: 'lgtm' }), /no passing test run/);
  const ctx = { run: qaRun, cwd: '/w', state: {} };
  runner.applyEvents([{ type: 'cmd-start', id: 'a', cmd: 'python -m pytest tests/x.py -n 0' }, { type: 'cmd-end', id: 'a', ok: false }], ctx);
  await assert.rejects(sched.deskAction(qaRun, 'qa', { verdict: 'pass', code: 'abc123abc1', body: 'lgtm' }), /no passing test run/);
  runner.applyEvents([{ type: 'cmd-start', id: 'b', cmd: 'python -m pytest tests/x.py -n 0' }, { type: 'cmd-end', id: 'b', ok: true }], ctx);
  // gate satisfied → proceeds to the SHA check (no clone in this test, so that is the next failure)
  await assert.rejects(sched.deskAction(qaRun, 'qa', { verdict: 'pass', code: 'abc123abc1', body: 'lgtm' }), (e) => !/no passing test run/.test(e.message));
});
