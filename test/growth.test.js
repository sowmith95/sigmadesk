// Team growth: QA verdicts as structured facts, report cards that say "too early" instead of guessing, and the lessons
// loop (a builder proposes, the owner approves, build prompts carry it, QA counts repeats).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-growth-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'G' }, github: { sync: false }, pm: { enabled: false }, sandbox: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'ws');
let store, sched, stats, lessons, config;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  sched = await import('../src/scheduler.js'); stats = await import('../src/team-stats.js'); lessons = await import('../src/lessons.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('intervals: Wilson 80%, a difference interval against the rest of the team, and bands that wait for evidence', () => {
  const w = stats.wilson(8, 10);
  assert.ok(Math.abs(w[0] - 0.602) < 0.002 && Math.abs(w[1] - 0.914) < 0.002);
  assert.equal(stats.band(5, 8, 11, 12), 'too_early', 'under 15 verdicts nothing is concluded');
  assert.equal(stats.band(18, 20, 40, 50), 'inconclusive', '90% vs 80% on these counts is not a clear difference');
  assert.equal(stats.band(10, 30, 40, 42), 'below');
  assert.equal(stats.band(29, 30, 20, 40), 'above');
});

test('report cards: spec/base/flaky failures are shown, not counted; each model gets its own record', () => {
  const run = (agent_id, ticket_key, model = 'claude:sonnet') => ({ agent_id, ticket_key, kind: 'implement', status: 'success', model, cost_usd: 1, cost_estimated: 0, started_at: '2026-10-03T10:00:00Z', ended_at: '2026-10-03T10:05:00Z' });
  const s = stats.compute({
    runs: [run('junior', 'A'), run('junior', 'B'), run('junior', 'C', 'codex:gpt'), run('senior-be', 'D', 'claude:opus')],
    tickets: ['A', 'B', 'C'].map((key) => ({ key, status: 'qa', complexity: 'S' })).concat([{ key: 'D', status: 'qa', complexity: 'S' }]),
    qa: [{ ticket_key: 'A', verdict: 'fail', reason: 'spec', builder: 'junior', model: 'claude:sonnet' }, { ticket_key: 'B', verdict: 'fail', reason: 'bug', builder: 'junior', model: 'claude:sonnet' },
      { ticket_key: 'C', verdict: 'pass', builder: 'junior', model: 'codex:gpt' }, { ticket_key: 'D', verdict: 'pass', builder: 'senior-be', model: 'claude:opus' }],
    merged: [],
  }, Date.parse('2026-10-04T00:00:00Z'));
  const j = s.seats.junior.S;
  assert.equal(j.qa_first, 2, 'the unclear-ticket failure is not counted'); assert.equal(j.qa_first_pass, 1);
  assert.deepEqual(j.excluded, { spec: 1 });
  assert.deepEqual(j.models, { 'claude:sonnet': { qa_first: 1, qa_first_pass: 0 }, 'codex:gpt': { qa_first: 1, qa_first_pass: 1 } });
  assert.equal(j.band, 'too_early'); assert.equal(j.rest_rate, 1, 'compared with the rest of the team, not with itself');
});

const ticketInQa = (extra = {}) => {
  const t = store.createTicket({ title: 'Built and submitted', type: 'bug', status: 'qa', area: 'backend', complexity: 'S', assignee: 'junior' });
  store.updateTicket(t.key, { builder: 'junior', head_sha: 'abc1234', ...extra });
  const b = store.createRun({ agent_id: 'junior', ticket_key: t.key, kind: 'implement', token: `b-${t.key}`, model: 'claude:sonnet' });
  store.updateRun(b.id, { status: 'success', ended_at: store.now() });
  return store.getTicket(t.key);
};
const qaRun = (t) => store.createRun({ agent_id: 'qa', ticket_key: t.key, kind: 'qa', token: `q-${t.key}`, model: 'claude:sonnet', nonce: 'N1' });

test('a QA failure needs a reason and becomes a fact: who built it, on which model, and which lesson it repeats', async () => {
  const t = ticketInQa();
  await assert.rejects(sched.deskAction(qaRun(t), 'qa', { verdict: 'fail', code: 'N1', body: 'broken' }), /--reason bug\|tests\|spec\|base\|flaky required/);
  await assert.rejects(sched.deskAction(qaRun(t), 'qa', { verdict: 'fail', code: 'N1', reason: 'bug', lesson: '999', body: 'x' }), /active lesson/);
  await sched.deskAction(qaRun(t), 'qa', { verdict: 'fail', code: 'N1', reason: 'tests', body: '1. no test for the empty case' });
  const [v] = store.qaVerdicts(t.key);
  assert.equal(v.verdict, 'fail'); assert.equal(v.reason, 'tests'); assert.equal(v.builder, 'junior'); assert.equal(v.model, 'claude:sonnet'); assert.equal(v.sha, 'abc1234');
  assert.match(store.listComments(t.key).at(-1).body, /QA failed\*\* \(round 1, tests\)/);
});

test('lessons: proposed from the fixing run, approved by the owner, carried in build prompts, repeats counted by QA', async () => {
  const t = ticketInQa();
  store.updateTicket(t.key, { status: 'in_progress' });
  const fix = store.createRun({ agent_id: 'junior', ticket_key: t.key, kind: 'implement', token: `fix-${t.key}`, model: 'claude:sonnet' });
  await assert.rejects(sched.deskAction(fix, 'lesson', { body: 'short' }), /10 to 300/);
  const out = await sched.deskAction(fix, 'lesson', { body: 'Add a test for the empty input before submitting a parser change.' });
  const id = Number(out.match(/#(\d+)/)[1]);
  assert.match(await sched.deskAction(fix, 'lesson', { body: 'add a test for the EMPTY input before submitting a parser change' }), /already says that/);
  const qaSeat = store.createRun({ agent_id: 'qa', ticket_key: t.key, kind: 'qa', token: `qq-${t.key}`, model: 'claude:sonnet', nonce: 'Z' });
  await assert.rejects(sched.deskAction(qaSeat, 'lesson', { body: 'QA cannot propose lessons for builders here.' }), /cannot run "lesson"|builders propose/);
  let l = store.getLesson(id);
  assert.equal(l.status, 'proposed'); assert.equal(l.area, 'backend'); assert.equal(l.proposed_by, 'junior');
  assert.throws(() => lessons.decide(id, { action: 'approve', expected_updated_at: 'stale' }), /changed while you were reading/);
  l = lessons.decide(id, { action: 'approve', text: 'Add a test for empty input before submitting a parser change.', expected_updated_at: l.updated_at });
  assert.equal(l.status, 'active'); assert.match(l.text, /^Add a test for empty input/);
  const prompt = lessons.decorate({ kind: 'implement', ticket: store.getTicket(t.key), prompt: 'BUILD', runId: fix.id });
  assert.match(prompt, /Team lessons[\s\S]*empty input[\s\S]*\(from Riley\)/);
  assert.equal(lessons.decorate({ kind: 'implement', ticket: { ...store.getTicket(t.key), area: 'frontend', key: t.key }, prompt: 'X', runId: fix.id }), 'X', 'another area does not carry it');
  assert.match(lessons.decorate({ kind: 'qa', ticket: store.getTicket(t.key), prompt: 'QA', runId: 0 }), new RegExp(`#${id}: Add a test`));
  const t2 = ticketInQa();
  await sched.deskAction(qaRun(t2), 'qa', { verdict: 'fail', code: 'N1', reason: 'tests', lesson: String(id), body: 'again no empty-input test' });
  const row = store.listLessons().find((x) => x.id === id);
  assert.equal(row.repeats, 1); assert.equal(row.tasks, 1);
  lessons.decide(id, { action: 'retire' });
  assert.equal(lessons.decorate({ kind: 'implement', ticket: store.getTicket(t.key), prompt: 'BUILD', runId: fix.id }), 'BUILD');
});

test('history: QA verdicts recorded only as events are rebuilt once, reason unknown, attributed to the builder', () => {
  store.openDb(path.join(tmp, 'history.db')); // a fresh database: the backfill ran at open, on no history
  const t = store.createTicket({ title: 'Old work', type: 'bug', status: 'done', area: 'db', complexity: 'M', assignee: 'dba' });
  store.createRun({ agent_id: 'dba', ticket_key: t.key, kind: 'implement', token: 'old', model: 'claude:opus' });
  store.logEvent({ kind: 'action', agent_id: 'qa', ticket_key: t.key, text: `QA failed ${t.key}` });
  store.logEvent({ kind: 'action', agent_id: 'qa', ticket_key: t.key, text: `QA passed ${t.key}` });
  store.backfillQaVerdicts();
  const vs = store.qaVerdicts(t.key);
  assert.deepEqual(vs.map((v) => [v.verdict, v.reason, v.builder, v.model]), [['fail', 'unknown', 'dba', 'claude:opus'], ['pass', null, 'dba', 'claude:opus']]);
  store.backfillQaVerdicts();
  assert.equal(store.qaVerdicts(t.key).length, 2, 'never twice');
});
