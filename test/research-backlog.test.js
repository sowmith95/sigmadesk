// Research waits while its backlog is large: research-born items still under review, revision, grooming or an owner
// decision hold new research back (scheduled and manual alike), while the work that finishes them keeps running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-backlog-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const fakeClaude = path.join(tmp, 'claude'); // a "model" that ends at once without doing anything
fs.writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'B' }, github: { sync: false }, bins: { claude: fakeClaude }, sandbox: { enabled: false },
  pm: { enabled: true, intervalMinutes: 1, maxOpenProposals: 50 }, research: { review: { minReviewers: 1, reviewers: ['principal-be'] } } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'ws');
let store, sched, research, rr, dispatch, config, runner;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  dispatch = await import('../src/dispatch.js'); dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: false }]);
  sched = await import('../src/scheduler.js'); runner = await import('../src/runner.js'); research = await import('../src/research.js'); rr = await import('../src/research-review.js');
  store.setSetting('max_concurrent', '6');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ago = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const job = { program: 'product-discovery', seat: 'pm', maxProposals: 3, proposals: 0, web: true, connectors: [], sources: [], focus: '', review: { minReviewers: 1, reviewers: ['principal-be'] } };
/** A research-born ticket as `desk propose` leaves it, then moved to the given state. */
function researchTicket(patch = {}) {
  const t = store.createTicket({ title: `Idea ${Math.random().toString(36).slice(2, 7)}`, type: 'feature', status: 'proposed', reporter: 'pm', source: 'research',
    description: '## Problem\np\n## Evidence\ne\n## Proposal\nx\n## Acceptance criteria\n- a\n## Success metric\nm' });
  const run = store.createRun({ agent_id: 'pm', kind: 'research', program: 'product-discovery', token: `t-${Math.random()}`, model: 'x' });
  store.updateRun(run.id, { status: 'success', started_at: ago(3), ended_at: ago(3) });
  rr.open(t, job, run);
  return store.updateTicket(t.key, patch);
}
const held = () => researchTicket({ status: 'needs_human', research_review: 'held', resume_status: 'proposed', hold_kind: 'research', progress_msg: 'Research review: rejected' });
const runsOf = (kind, agent) => store.recentRuns(500).filter((r) => r.kind === kind && (!agent || r.agent_id === agent));
const sessions = () => runsOf('research').filter((r) => !store.getRun(r.id).token?.startsWith('t-')); // real launches, not fixtures
const dueAgain = () => { for (const r of runsOf('research')) store.updateRun(r.id, { started_at: ago(2) }); }; // cadence is due
async function tick() { store.setSetting('paused', 'false'); await sched.tick(); store.setSetting('paused', 'true'); await waitIdle(); }
const waitIdle = async () => { for (let i = 0; i < 200 && store.listAgentStates().some((a) => a.status === 'working'); i++) await new Promise((r) => setTimeout(r, 25)); };
const clear = () => { for (const t of store.listTickets()) if (!['done', 'wontdo'].includes(t.status)) store.updateTicket(t.key, { status: 'wontdo', active_run: null }); };

test('the backlog counts research-born items still in the research pipeline, by status and hold', () => {
  clear();
  const counted = [
    researchTicket(), // proposed, second review pending
    researchTicket({ research_review: 'changes' }), // proposed, author revising
    researchTicket({ research_review: 'passed' }), // passed review, not yet groomed
    held(), // held for the owner on its review
    researchTicket({ status: 'needs_human', research_review: 'held', resume_status: 'proposed', hold_kind: null }), // older holds carry no hold_kind
    researchTicket({ status: 'needs_human', research_review: 'passed', resume_status: 'proposed', hold_kind: 'route' }), // grooming routed it to the owner
  ];
  const notCounted = [
    researchTicket({ status: 'todo', research_review: 'passed' }), // groomed into ordinary work
    researchTicket({ status: 'in_progress', research_review: 'waived' }),
    researchTicket({ status: 'needs_human', research_review: 'passed', resume_status: 'todo', hold_kind: 'qa_loops' }), // an ordinary work hold
    researchTicket({ status: 'done', research_review: 'passed' }),
    researchTicket({ status: 'wontdo', research_review: 'held' }),
    store.createTicket({ title: 'Not from research', status: 'proposed' }),
    store.createTicket({ title: 'Owner hold, not research', status: 'needs_human', resume_status: 'proposed', hold_kind: 'route' }),
  ];
  const b = sched.researchBacklog();
  assert.deepEqual(new Set(b.keys), new Set(counted.map((t) => t.key)));
  assert.equal(b.count, 6); assert.equal(b.max, 8, 'default limit'); assert.equal(b.full, false); assert.equal(b.reason, null);
  for (const t of notCounted) assert.equal(sched.inResearchPipeline(store.getTicket(t.key)), false, `${t.key} (${t.status})`);
  held(); held();
  const full = sched.researchBacklog();
  assert.equal(full.full, true);
  assert.equal(full.reason, '8 research items are waiting — research resumes when fewer than 8 are open');
});

test('setting validation: research_backlog_max is an integer from 0 to 100, defaulting to the configuration', () => {
  assert.equal(store.settingDefaults().research_backlog_max, String(config.research.backlogMax));
  assert.equal(config.research.backlogMax, 8);
  for (const bad of ['-1', '101', '2.5', 'many', '', ' ']) assert.throws(() => store.setSetting('research_backlog_max', bad), /research_backlog_max must be an integer from 0 to 100/, bad);
  for (const ok of ['0', '100', '8']) { store.setSetting('research_backlog_max', ok); assert.equal(store.getSettings().research_backlog_max, ok); }
});

test('manual research is refused at the cap with a plain reason and allowed again below it; the allowance never exceeds the room left', async () => {
  clear();
  store.setSetting('paused', 'false'); store.setSetting('research_backlog_max', '3');
  const items = [held(), held(), held()];
  const a = sched.researchAdmission();
  assert.ok(a.room <= 0 && sched.researchAllowance() <= 0);
  assert.equal(a.reason, '3 research items are waiting — research resumes when fewer than 3 are open');
  await assert.rejects(sched.launchResearch('', undefined, 'product-discovery'), (e) => e.status === 409 && e.message === a.reason);
  assert.equal(research.eligibility(research.get('product-discovery'), { settings: store.getSettings() }).code, 'backlog', 'the Research page says why the program waits');
  assert.equal(research.status().backlog.count, 3);
  rr.ownerDecide(store.getTicket(items[0].key), 'reject', 'not now'); // the owner finishes one: the backlog drains
  assert.equal(sched.researchBacklog().count, 2);
  assert.equal(sched.researchAllowance(), 1, 'room for one more research item, not the program\'s three');
  await sched.launchResearch('', undefined, 'product-discovery'); await waitIdle();
  assert.equal(JSON.parse(store.getRun(sessions()[0].id).job).maxProposals, 1, 'the session may file only what the backlog has room for');
  store.setSetting('research_backlog_max', '0');
  assert.match(sched.researchAdmission().reason, /research backlog limit is 0/);
  await assert.rejects(sched.launchResearch('', undefined, 'product-discovery'), /limit is 0/);
  store.setSetting('paused', 'true'); store.setSetting('research_backlog_max', '8');
});

test('scheduled research waits at the cap and resumes below it; reviews and revisions keep launching at the cap', async () => {
  clear(); await waitIdle();
  for (const r of store.unfinishedRuns()) store.updateRun(r.id, { status: 'success', ended_at: store.now() });
  store.setSetting('research_backlog_max', '4');
  const holds = [held(), held(), held(), held()];
  assert.equal(sched.researchBacklog().full, true);
  dueAgain();
  assert.equal(research.eligibility(research.get('product-discovery'), { settings: store.getSettings() }).code, 'backlog', 'due by cadence, held by the backlog');
  const before = sessions().length;
  await tick();
  assert.equal(sessions().length, before, 'no research session started while the backlog is full (Avery was idle and due)');
  // Work that finishes research items is not throttled: a second review and an author's revision both start at the cap.
  store.updateTicket(holds[0].key, { status: 'wontdo' }); store.updateTicket(holds[1].key, { status: 'wontdo' });
  const review = researchTicket(); // a second review is due
  const revision = researchTicket({ research_review: 'changes' }); // the author owes one revision
  assert.equal(sched.researchBacklog().full, true);
  dueAgain();
  await tick();
  assert.equal(runsOf('research_review', 'principal-be').filter((r) => r.ticket_key === review.key).length, 1, 'the second review ran');
  assert.equal(runsOf('research_revision', 'pm').filter((r) => r.ticket_key === revision.key).length, 1, 'the revision ran');
  assert.equal(sessions().length, before, 'and still no new research');
  // The owner closes two: fewer than the limit are open, so research resumes on the next tick.
  store.updateTicket(holds[2].key, { status: 'wontdo' }); store.updateTicket(review.key, { status: 'wontdo' });
  assert.equal(sched.researchBacklog().full, false);
  dueAgain();
  await tick();
  assert.equal(sessions().length, before + 1, 'research resumes once fewer than the limit are open');
  store.setSetting('research_backlog_max', '8');
});

// Two sessions can never claim the same room: admission reserves it synchronously, before the workspace is prepared.
function secondProgram() {
  if (research.get('second-look')) return;
  research.save([...research.programs().map((p) => ({ ...p, intervalMinutes: 15 })), { id: 'second-look', label: 'Second look', seat: 'quant-research', enabled: true, intervalMinutes: 15, window: 'any', focus: '', sources: [],
    tools: { web: true, connectors: [] }, maxProposals: 3, review: { minReviewers: 1, reviewers: ['principal-be'] } }]);
}
function atOneBelowTheLimit() {
  clear();
  for (const r of store.unfinishedRuns()) store.updateRun(r.id, { status: 'success', ended_at: store.now() });
  store.setSetting('research_backlog_max', '4');
  held(); held(); held();
  assert.equal(sched.researchAllowance(), 1, 'room for exactly one more research item');
}

test('concurrent admissions at the limit minus one: a manual run and a program run cannot both take the last room', async () => {
  await waitIdle(); secondProgram(); atOneBelowTheLimit();
  store.setSetting('paused', 'false');
  const before = sessions().length;
  const first = sched.launchResearch('', undefined, 'product-discovery'); // preparing its workspace, no run yet
  assert.equal(sched.preparingResearchRoom(), 1, 'the room is reserved before the first await');
  assert.ok(sched.researchAllowance() <= 0);
  await assert.rejects(sched.launchResearch('', undefined, 'second-look'), (e) => e.status === 409 && /holds the remaining room/.test(e.message));
  await first; await waitIdle();
  store.setSetting('paused', 'true');
  assert.equal(sessions().length, before + 1, 'exactly one session admitted');
  assert.equal(JSON.parse(store.getRun(sessions()[0].id).job).maxProposals, 1);
  assert.equal(sched.preparingResearchRoom(), 0, 'the reservation moved to the run, then the run finished');
  store.setSetting('research_backlog_max', '8');
});

test('concurrent admissions at the limit minus one: a scheduled session and a manual one cannot both take the last room', async () => {
  await waitIdle(); secondProgram(); atOneBelowTheLimit();
  dueAgain();
  const before = sessions().length;
  store.setSetting('paused', 'false');
  await sched.tick(); // both programs are due and both seats idle: only the first admitted may start
  await assert.rejects(sched.launchResearch('', undefined, 'product-discovery'), /holds the remaining room|is busy/);
  await assert.rejects(sched.launchResearch('', undefined, 'second-look'), /holds the remaining room|is busy/);
  store.setSetting('paused', 'true');
  await waitIdle();
  assert.equal(sessions().length, before + 1, 'exactly one session admitted');
  store.setSetting('research_backlog_max', '8');
});

test('a research session whose preparation fails releases its reserved room', async () => {
  await waitIdle(); atOneBelowTheLimit();
  store.setSetting('paused', 'false');
  const root = config.workspaceRoot, file = path.join(tmp, 'not-a-dir'); fs.writeFileSync(file, 'x');
  config.workspaceRoot = path.join(file, 'ws'); // the workspace copy cannot be made
  try {
    const launching = sched.launchResearch('', undefined, 'product-discovery');
    assert.equal(sched.preparingResearchRoom(), 1);
    await assert.rejects(launching);
  } finally { config.workspaceRoot = root; store.setSetting('paused', 'true'); }
  assert.equal(sched.preparingResearchRoom(), 0, 'released on failure');
  assert.equal(sched.researchAllowance(), 1, 'the room is free again');
  assert.equal(store.getAgentState('pm').status, 'idle');
  store.setSetting('research_backlog_max', '8');
});

test('a full backlog is the reason a program gives even before its next session is due', () => {
  atOneBelowTheLimit(); held();
  const recent = store.createRun({ agent_id: 'pm', kind: 'research', program: 'product-discovery', token: `t-${Math.random()}`, model: 'x' });
  store.updateRun(recent.id, { status: 'success', ended_at: store.now() }); // a session just ran: by cadence it is not due
  const e = research.eligibility(research.get('product-discovery'), { settings: store.getSettings() });
  assert.equal(e.code, 'backlog'); assert.match(e.reason, /4 research items are waiting/);
  assert.ok(e.next_eligible_at, 'the next session time is still given');
  store.setSetting('research_backlog_max', '8');
  assert.equal(research.eligibility(research.get('product-discovery'), { settings: store.getSettings() }).code, 'cadence');
});

test('a run whose setup fails after its row exists ends as an error: it holds no research room and frees its seat', async () => {
  await waitIdle(); atOneBelowTheLimit();
  store.setSetting('paused', 'false');
  const db = store.handle();
  db.exec("CREATE TRIGGER fail_reserve BEFORE UPDATE OF reserve_usd ON runs BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
  try { await assert.rejects(sched.launchResearch('', undefined, 'product-discovery'), /disk I\/O error/); }
  finally { db.exec('DROP TRIGGER fail_reserve'); store.setSetting('paused', 'true'); }
  const run = store.getRun(sessions()[0].id);
  assert.deepEqual([run.status, !!run.ended_at, run.token, run.pid ?? null], ['error', true, null, null], 'the run ended: no "running" row without a process');
  assert.match(run.result_text, /Run setup failed: disk I\/O error/);
  assert.equal(store.unfinishedRuns().filter((r) => r.id === run.id).length, 0);
  assert.equal(sched.preparingResearchRoom(), 0);
  assert.equal(sched.researchAllowance(), 1, 'the room is free again');
  assert.deepEqual([store.getAgentState('pm').status, store.getAgentState('pm').current_run ?? null], ['idle', null]);
  store.setSetting('research_backlog_max', '8');
});

// ---- the setup phase of a run (src/runner.js setupPhase): fault injection on the store, no production seams ----
/** After a statement matching `after` is prepared (immediately when null), let `skip` matching reads through, then fail one. */
function failRead(target, { after = null, skip = 0 } = {}) {
  const db = store.handle(), prepare = db.prepare;
  let armed = !after, left = skip;
  db.prepare = function (sql) {
    if (!armed && after.test(sql)) armed = true;
    else if (armed && target.test(sql) && left-- <= 0) { db.prepare = prepare; return { get() { throw new Error('injected read failure'); }, all() { throw new Error('injected read failure'); }, run() { throw new Error('injected read failure'); } }; }
    return prepare.call(this, sql);
  };
  return () => { db.prepare = prepare; };
}
const RUN_READ = /^SELECT \* FROM runs WHERE id=\?$/;
const lastRun = () => store.getRun(store.recentRuns(1)[0].id);

test('setup phase: a read failing right before the spawn decision ends the run and frees the seat', async () => {
  await waitIdle();
  let restore = () => {};
  try {
    await assert.rejects(runner.startRun({ agentId: 'pm', kind: 'implement', prompt: 'x', cwd: repo, onStart: () => { restore = failRead(RUN_READ); } }), /injected read failure/);
  } finally { restore(); }
  const run = lastRun();
  assert.deepEqual([run.status, !!run.ended_at, run.token, run.pid ?? null], ['error', true, null, null]);
  assert.match(run.result_text, /^Run setup failed: injected read failure/);
  assert.deepEqual([store.getAgentState('pm').status, store.getAgentState('pm').current_run ?? null], ['idle', null]);
});

test('setup phase: a start callback that stops the run and then throws keeps the stop and its reason', async () => {
  await waitIdle();
  await assert.rejects(runner.startRun({ agentId: 'pm', kind: 'implement', prompt: 'x', cwd: repo, onStart: (r) => { runner.killRun(r.id, 'owner stopped'); throw new Error('callback broke'); } }), /callback broke/);
  const run = lastRun();
  assert.deepEqual([run.status, run.result_text, run.token, !!run.ended_at], ['killed', 'owner stopped', null, true], 'never downgraded to an error');
  assert.equal(store.getAgentState('pm').status, 'idle');
});

test('setup phase: a failure after the spawn but before the run is wired up stops the process and ends the run', async () => {
  await waitIdle();
  const db = store.handle();
  db.exec("CREATE TRIGGER fail_pid BEFORE UPDATE OF pid ON runs BEGIN SELECT RAISE(ABORT, 'pid write failed'); END;");
  try { await assert.rejects(runner.startRun({ agentId: 'pm', kind: 'implement', prompt: 'x', cwd: repo }), /pid write failed/); }
  finally { db.exec('DROP TRIGGER fail_pid'); }
  const run = lastRun();
  assert.deepEqual([run.status, run.token, !!run.ended_at], ['error', null, true]);
  assert.match(run.result_text, /^Run setup failed: pid write failed/);
  assert.equal(store.getAgentState('pm').status, 'idle'); // and the test process can exit: the half-wired child was stopped
});

test('setup phase: a spawned and wired run is its close handler\'s alone: it ends once, from the process exit', async () => {
  await waitIdle();
  const out = await runner.startRun({ agentId: 'pm', kind: 'implement', prompt: 'x', cwd: repo });
  assert.ok(out.run.pid, 'it was spawned');
  assert.notEqual(out.run.status, 'running');
  assert.doesNotMatch(out.run.result_text || '', /Run setup failed/);
  const events = store.recentEvents({ limit: 50 }).filter((e) => e.run_id === out.run.id);
  assert.equal(events.filter((e) => /Run setup failed/.test(e.text)).length, 0, 'the setup phase never ended it');
  assert.equal(events.filter((e) => /implement run (finished|error|killed)/.test(e.text)).length, 1, 'ended exactly once');
});
