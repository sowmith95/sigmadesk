// Balanced assignment: builders who fit a task (team.builderCandidates), the bounded scorer (assign.pick), team stats
// from real facts (team-stats.compute), and the scheduler: an idle seat that fits takes waiting work, rework stays with
// its author, pins hold, design stays with principals, and fixed mode keeps the old one-seat rule.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-assign-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const fakeClaude = path.join(tmp, 'claude');
fs.writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'A' }, github: { sync: false }, pm: { enabled: false }, bins: { claude: fakeClaude }, sandbox: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'ws');
let store, sched, dispatch, config, team, assign, stats;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  config.limits.busyWindow = { ...config.limits.busyWindow, maxConcurrent: 8 }; // the busy-hours cap would make these tests depend on the clock
  store = await import('../src/db.js'); store.openDb(':memory:');
  dispatch = await import('../src/dispatch.js'); dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: false }]);
  sched = await import('../src/scheduler.js'); team = await import('../src/team.js'); assign = await import('../src/assign.js'); stats = await import('../src/team-stats.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('builders who fit: never principals, risk never escalates, junior takes medium work only when it is low risk', () => {
  const c = (t) => team.builderCandidates(t);
  assert.deepEqual(c({ area: 'backend', complexity: 'S' }), ['junior', 'senior-be']);
  assert.deepEqual(c({ area: 'backend', complexity: 'M' }), ['senior-be']);
  assert.deepEqual(c({ area: 'backend', complexity: 'M', risk: 'low' }), ['senior-be', 'junior']);
  assert.deepEqual(c({ area: 'backend', complexity: 'M', risk: 'high' }), ['senior-be'], 'a principal\'s high-risk slice stays buildable');
  assert.deepEqual(c({ area: 'frontend', complexity: 'S' }), ['junior', 'senior-fe']);
  assert.deepEqual(c({ area: 'db', complexity: 'M' }), ['dba', 'senior-be']);
  assert.deepEqual(c({ area: 'fullstack', complexity: 'M' }), ['senior-be', 'senior-fe']);
  assert.ok(Object.values({ a: c({ area: 'backend', complexity: 'XL', risk: 'high' }) }).flat().every((id) => !team.PRINCIPALS.includes(id)));
  team.agentById.dba.enabled = false;
  assert.deepEqual(c({ area: 'db', complexity: 'S' }), ['senior-be'], 'a switched-off seat is never a candidate');
  team.agentById.dba.enabled = true;
});

test('the scorer: pins and authors come first, fit is the prior, a record moves it only within bounds, ties are stable', () => {
  const names = { junior: 'Riley', 'senior-be': 'Jordan' };
  const base = { candidates: ['junior', 'senior-be'], names, team: { S: { first_pass_rate: 0.7 }, 'M+': {} }, stats: {} };
  const t = { key: 'A-1', complexity: 'S', risk: null };
  assert.deepEqual(assign.pick(t, { ...base, launchable: new Set(['junior', 'senior-be']) }).order, ['junior', 'senior-be'], 'no record: the best fit');
  assert.deepEqual(assign.pick(t, { ...base, launchable: new Set(['senior-be']) }).order, ['senior-be'], 'the preferred seat is busy: the next one takes it');
  assert.match(assign.pick(t, { ...base, launchable: new Set(['senior-be']) }).reason, /Riley busy/);
  assert.deepEqual(assign.pick({ ...t, assign_pinned: 1, assignee: 'junior' }, { ...base, launchable: new Set(['senior-be']) }).order, [], 'a pin waits for its seat');
  const rework = assign.pick(t, { ...base, author: 'junior', launchable: new Set(['senior-be']) });
  assert.deepEqual(rework.order, []); assert.match(rework.reason, /Riley, who built it/);
  // A clearly weaker record in the same size group, or an engine near its limit, lets the second seat win.
  const weak = { junior: { S: { qa_first: 10, qa_first_pass: 3 } }, 'senior-be': { S: { qa_first: 6, qa_first_pass: 6 } } };
  assert.equal(assign.pick(t, { ...base, stats: weak, launchable: new Set(['junior', 'senior-be']) }).order[0], 'senior-be');
  assert.equal(assign.pick(t, { ...base, quota: { junior: 0.9 }, launchable: new Set(['junior', 'senior-be']) }).order[0], 'senior-be');
  // One slightly worse task does not flip the order: factors are shrunk and bounded.
  const close = { junior: { S: { qa_first: 4, qa_first_pass: 3 } } };
  assert.equal(assign.pick(t, { ...base, stats: close, launchable: new Set(['junior', 'senior-be']) }).order[0], 'junior');
  assert.equal(assign.qualityFactor({ qa_first: 100, qa_first_pass: 0 }, 0.8), 0.85, 'bounded below');
  assert.equal(assign.costFactor({ cost_n: 2, cost_per_shipped: 99 }, 1), 1, 'neutral under three measured tasks');
  // Exploration: decided by the ticket key alone, never for high-risk work.
  const keys = Array.from({ length: 400 }, (_, i) => `A-${i}`);
  const share = keys.filter((k) => assign.explores({ key: k, complexity: 'S' })).length / keys.length;
  assert.ok(share > 0.05 && share < 0.15, `about 10% explore (${share})`);
  assert.ok(keys.every((k) => !assign.explores({ key: k, complexity: 'S', risk: 'high' })));
  assert.ok(keys.every((k) => !assign.explores({ key: k, complexity: 'M' })), 'medium work of unknown risk is never explored');
});

test('team stats count the first QA verdict, merges, measured cost, and keep sizes apart', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const run = (agent_id, ticket_key, kind, extra = {}) => ({ agent_id, ticket_key, kind, status: 'success', cost_usd: 1, cost_estimated: 0, started_at: '2026-10-03T10:00:00Z', ended_at: '2026-10-03T10:10:00Z', ...extra });
  const s = stats.compute({
    runs: [run('junior', 'T-1', 'implement'), run('junior', 'T-2', 'implement'), run('junior', 'T-3', 'implement', { cost_estimated: 1, cost_usd: 5 }),
      run('senior-be', 'T-4', 'implement'), run('senior-be', 'T-4', 'respond'), run('junior', 'T-9', 'implement'), run('manager', 'E-1', 'groom')],
    tickets: [{ key: 'T-1', status: 'done', complexity: 'S' }, { key: 'T-2', status: 'wontdo', complexity: 'S' }, { key: 'T-3', status: 'done', complexity: 'S' },
      { key: 'T-4', status: 'done', complexity: 'M', builder: 'senior-be' }, { key: 'T-9', status: 'done', complexity: 'S', owner_task: 1 },
      { key: 'E-1', status: 'in_progress', complexity: 'S' }, { key: 'E-2', status: 'todo', complexity: 'S', parent_key: 'E-1' }],
    qa: [{ ticket_key: 'T-1', text: 'QA passed T-1' }, { ticket_key: 'T-2', text: 'QA failed T-2' }, { ticket_key: 'T-3', text: 'QA passed T-3' }, { ticket_key: 'T-4', text: 'QA failed T-4' }],
    merged: [{ ticket_key: 'T-1', ts: '2026-10-03T11:00:00Z' }, { ticket_key: 'T-3', ts: '2026-10-03T12:00:00Z' }, { ticket_key: 'T-4', ts: '2026-10-03T12:00:00Z' }],
  }, now);
  const j = s.seats.junior;
  assert.equal(j.S.qa_first, 3, 'an abandoned task\'s failed first QA still counts'); assert.equal(j.S.qa_first_pass, 2);
  assert.equal(j.all.built, 3, 'owner tasks and epics (no implement run of their own) are not counted');
  assert.equal(j.S.shipped, 2); assert.equal(j.S.cost_n, 1, 'a run with an estimated cost is left out of cost'); assert.equal(j.S.cost_per_shipped, 1);
  assert.equal(j['M+'].built, 0);
  assert.equal(s.seats['senior-be']['M+'].review_rounds, 1); assert.equal(s.seats['senior-be']['M+'].cost_per_shipped, 2);
  assert.equal(s.team.S.first_pass_rate, 2 / 3);
});

const idle = () => { for (const a of store.listAgentStates()) store.updateAgent(a.agent_id || a.id, { status: 'idle', current_ticket: null, current_run: null }); };
const settle = async () => { for (let i = 0; i < 150 && store.listAgentStates().some((a) => a.status === 'working' && a.current_ticket); i++) await new Promise((r) => setTimeout(r, 30)); };
const tickOnce = async () => { store.setSetting('paused', 'false'); store.setSetting('max_concurrent', '8'); await sched.tick(); }; // ticks run only when a test calls one
const pickedBy = (key) => store.recentEvents({ ticket_key: key, limit: 50 }).find((e) => e.kind === 'pickup')?.agent_id;

test('an idle seat that fits takes a task whose planned seat is busy; fixed mode waits for the planned seat', async () => {
  idle();
  store.updateAgent('junior', { status: 'working', current_ticket: 'X-1' }); // the planned seat is busy
  const t = store.createTicket({ title: 'Small backend fix', type: 'bug', status: 'todo', area: 'backend', complexity: 'S', assignee: 'junior' });
  store.setSetting('assign_mode', 'fixed');
  await tickOnce();
  assert.equal(store.getTicket(t.key).status, 'todo', 'fixed: waits for the junior');
  assert.equal(sched.health().waiting.find((w) => w.key === t.key)?.code, 'seat_busy');
  store.setSetting('assign_mode', 'balanced');
  const w = sched.health().waiting.find((x) => x.key === t.key);
  assert.equal(w.seat, 'senior-be', 'balanced: the panel names the seat that will take it'); assert.equal(w.code, 'tick');
  await tickOnce();
  assert.equal(pickedBy(t.key), 'senior-be', 'balanced: the idle senior takes it');
  assert.match(store.getTicket(t.key).assign_reason, /Jordan: Riley busy/);
  store.updateAgent('junior', { status: 'idle', current_ticket: null });
  await settle();
  store.updateTicket(t.key, { status: 'wontdo', active_run: null }); // its fake run fails and would be retried by its author
});

test('rework stays with its author, a pin holds, one seat never gets two tasks in a tick, design stays with principals', async () => {
  idle();
  const rework = store.createTicket({ title: 'QA sent it back', type: 'bug', status: 'todo', area: 'backend', complexity: 'S', assignee: 'junior' });
  store.updateTicket(rework.key, { builder: 'junior', qa_loops: 1, branch: 'sigmadesk/x' });
  const pinned = store.createTicket({ title: 'Owner wants Quinn', type: 'bug', status: 'todo', area: 'backend', complexity: 'S', assignee: 'senior-fe' });
  store.updateTicket(pinned.key, { assign_pinned: 1 });
  const big = store.createTicket({ title: 'Large risky change', type: 'bug', status: 'todo', area: 'backend', complexity: 'L', assignee: 'principal-be' });
  store.updateAgent('junior', { status: 'working', current_ticket: 'X-2' }); store.updateAgent('senior-fe', { status: 'working', current_ticket: 'X-3' });
  const a = store.createTicket({ title: 'First small', type: 'bug', status: 'todo', area: 'backend', complexity: 'S' });
  const b = store.createTicket({ title: 'Second small', type: 'bug', status: 'todo', area: 'backend', complexity: 'S' });
  await tickOnce();
  assert.equal(store.getTicket(rework.key).status, 'todo', 'the author is busy: rework waits for them');
  assert.match(sched.health().waiting.find((w) => w.key === rework.key)?.reason || '', /Riley, who built it/);
  assert.equal(store.getTicket(pinned.key).status, 'todo', 'pinned to a busy seat: it waits');
  for (let i = 0; i < 100 && !pickedBy(big.key); i++) await new Promise((r) => setTimeout(r, 30)); // a design logs its pickup after preparing
  assert.equal(pickedBy(big.key), 'principal-be', 'large work still goes to its principal to design');
  const starts = [a, b].map((t) => pickedBy(t.key)).filter(Boolean);
  assert.equal(starts.length, 1, 'only one idle builder fits small backend work, and it takes one task');
  assert.equal(starts[0], 'senior-be');
  store.updateAgent('junior', { status: 'idle', current_ticket: null }); store.updateAgent('senior-fe', { status: 'idle', current_ticket: null });
  await settle();
});

test('explicit seats pin the task, a principal named for small work is routed to a builder, and running work cannot be reassigned', async () => {
  const parent = store.createTicket({ title: 'Epic', status: 'in_progress', type: 'feature' });
  const run = store.createRun({ agent_id: 'manager', ticket_key: parent.key, kind: 'groom', token: 'assign-fixture', model: 'claude:fixture' });
  const made = (s) => s.match(/created (\S+)/)[1];
  const p = made(await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Pinned', complexity: 'M', area: 'backend', body: 'x', assign: 'senior-be' }));
  assert.equal(store.getTicket(p).assign_pinned, 1);
  const r = made(await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Small for a principal', complexity: 'S', area: 'backend', body: 'x', assign: 'principal-be' }));
  assert.equal(store.getTicket(r).assignee, 'junior'); assert.equal(store.getTicket(r).assign_pinned, 0);
  assert.match(store.listComments(r).at(-1).body, /Principals design and slice/);
  sched.ownerPatch(r, { assignee: 'senior-be' }); assert.equal(store.getTicket(r).assign_pinned, 1);
  sched.ownerPatch(r, { assignee: '' }); assert.equal(store.getTicket(r).assign_pinned, 0, 'clearing the seat lets the desk choose');
  store.updateTicket(r, { active_run: 7 });
  assert.throws(() => sched.ownerPatch(r, { assignee: 'senior-fe' }), /being worked on/);
  store.updateTicket(r, { active_run: null });
});

test('the facts come from the real records: a GitHub merge counts as shipped, the first QA verdict wins', () => {
  const t = store.createTicket({ title: 'Merged on GitHub', type: 'bug', status: 'qa', area: 'backend', complexity: 'S', assignee: 'junior' });
  const run = store.createRun({ agent_id: 'junior', ticket_key: t.key, kind: 'implement', token: 'facts', model: 'claude:fixture' });
  store.updateRun(run.id, { status: 'success', cost_usd: 1.5, ended_at: store.now() });
  store.logEvent({ kind: 'action', agent_id: 'qa', ticket_key: t.key, text: `QA failed ${t.key}` });
  store.logEvent({ kind: 'action', agent_id: 'qa', ticket_key: t.key, text: `QA passed ${t.key}` });
  store.updateTicket(t.key, { pr_url: 'https://github.com/x/y/pull/9' });
  sched.prActions.merged(store.getTicket(t.key), { at: '2026-10-04T12:00:00Z' });
  const facts = store.assignmentFacts('2000-01-01');
  assert.equal(facts.qa.find((q) => q.ticket_key === t.key).text, `QA failed ${t.key}`, 'the first verdict, not the latest');
  assert.equal(facts.merged.filter((m) => m.ticket_key === t.key).length, 1, 'one merge per ticket');
  const s = stats.current();
  assert.ok(s.seats.junior.S.shipped >= 1);
});

test('a pin to a switched-off seat says so, a principal reroute never lands on a principal, and taken seats are not reused', async () => {
  const t = { key: 'P-1', complexity: 'S', assign_pinned: 1, assignee: 'dba' };
  const off = assign.pick(t, { candidates: ['dba'], launchable: new Set(), off: new Set(['dba']), names: { dba: 'Casey' } });
  assert.equal(off.code, 'seat_off'); assert.match(off.reason, /switched off/);
  team.agentById.dba.enabled = false;
  const parent = store.createTicket({ title: 'Epic 2', status: 'in_progress', type: 'feature' });
  const run = store.createRun({ agent_id: 'manager', ticket_key: parent.key, kind: 'groom', token: 'reroute', model: 'claude:fixture' });
  const made = (s) => s.match(/created (\S+)/)[1];
  const k = made(await sched.deskAction(run, 'create-task', { parent: parent.key, title: 'Small db fix', complexity: 'S', area: 'db', body: 'x', assign: 'principal-be' }));
  assert.equal(store.getTicket(k).assignee, 'senior-be', 'with the DBA off, a builder still gets it');
  team.agentById.dba.enabled = true;
  // Two builders free, two small tasks: each seat gets one, never both.
  idle();
  const ctx = sched.assignContext();
  const taken = new Set();
  const first = sched.buildDecision({ key: 'Q-1', complexity: 'S', area: 'backend' }, { ctx, taken });
  taken.add(first.order[0]);
  const second = sched.buildDecision({ key: 'Q-2', complexity: 'S', area: 'backend' }, { ctx, taken });
  assert.notEqual(second.order[0], first.order[0]);
  assert.ok(!second.order.includes(first.order[0]));
});

test('exploration rotates in the least-used fitting seat, but not onto an engine near its limit', () => {
  const key = Array.from({ length: 500 }, (_, i) => `X-${i}`).find((k) => assign.explores({ key: k, complexity: 'S' }));
  const t = { key, complexity: 'S' };
  const ctx = { candidates: ['junior', 'senior-be'], launchable: new Set(['junior', 'senior-be']), recent: { junior: 9, 'senior-be': 0 }, team: {}, stats: {} };
  const r = assign.pick(t, ctx);
  assert.equal(r.explored, true); assert.deepEqual(r.order, ['senior-be', 'junior']);
  assert.notEqual(assign.pick(t, { ...ctx, quota: { 'senior-be': 0.9 } }).explored, true);
});

test('Codex review regressions: a pin to a switched-off builder never becomes a design, grooming keeps a pin, inherited high risk is not rerouted, provider outages are not "busy", stale quota is ignored', async () => {
  idle();
  team.agentById.dba.enabled = false;
  const db = store.createTicket({ title: 'Pinned db fix', type: 'bug', status: 'todo', area: 'db', complexity: 'S', assignee: 'dba' });
  store.updateTicket(db.key, { assign_pinned: 1 });
  await tickOnce();
  assert.equal(store.getTicket(db.key).status, 'todo', 'no principal design run starts for a builder pin');
  assert.equal(sched.health().waiting.find((w) => w.key === db.key)?.code, 'seat_off');
  team.agentById.dba.enabled = true;
  store.updateTicket(db.key, { status: 'wontdo' });

  const prop = store.createTicket({ title: 'Owner pinned before grooming', type: 'bug', status: 'proposed', assignee: 'senior-be' });
  store.updateTicket(prop.key, { assign_pinned: 1 });
  const g = store.createRun({ agent_id: 'manager', ticket_key: prop.key, kind: 'groom', token: 'keep-pin', model: 'claude:fixture' });
  await sched.deskAction(g, 'groom', { complexity: 'S', area: 'backend', body: 'spec' });
  assert.equal(store.getTicket(prop.key).assignee, 'senior-be'); assert.equal(store.getTicket(prop.key).assign_pinned, 1);
  store.updateTicket(prop.key, { status: 'wontdo' });

  const risky = store.createTicket({ title: 'Risky epic', status: 'in_progress', type: 'feature' });
  store.updateTicket(risky.key, { risk: 'high' });
  const r = store.createRun({ agent_id: 'manager', ticket_key: risky.key, kind: 'groom', token: 'inherit', model: 'claude:fixture' });
  const k = (await sched.deskAction(r, 'create-task', { parent: risky.key, title: 'Needs design', complexity: 'M', area: 'backend', body: 'x', assign: 'principal-be' })).match(/created (\S+)/)[1];
  assert.equal(store.getTicket(k).assignee, 'principal-be', 'inherited high risk keeps the principal');
  store.updateTicket(k, { status: 'wontdo' });

  const out = assign.pick({ key: 'O-1', complexity: 'S' }, { candidates: ['junior', 'senior-be'], launchable: new Set(), off: new Set(['junior', 'senior-be']), names: {} });
  assert.equal(out.code, 'provider_hold');
  assert.equal(sched.liveUsage({ five_hour: 0.95, five_hour_resets_at: '2000-01-01T00:00:00Z' }), 0, 'a window that already reset is empty');
  assert.equal(sched.liveUsage({ five_hour: 0.95, five_hour_resets_at: '2999-01-01T00:00:00Z' }), 0.95);
});
