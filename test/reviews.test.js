// Two independent reviewers on every PR (sowmith95/sigmadesk#2). GitHub is a stub: no real API is ever called.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-reviews-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init');

// Fake `gh`: records calls; answers PR views, comment posts/searches and the workflow count from state files.
const ghLog = path.join(tmp, 'gh.log');
const ghDir = path.join(tmp, 'gh'); fs.mkdirSync(ghDir);
const fakeGh = path.join(tmp, 'gh.mjs');
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2); const d = ${JSON.stringify(ghDir)};
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(d + '/' + f, 'utf8')); } catch { return def; } };
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify(read('pr.json', {}))); process.exit(0); }
if (a[0] === 'api' && /actions\\/workflows/.test(a[1])) { process.stdout.write(String(read('workflows.json', 1))); process.exit(0); }
if (a[0] === 'api' && a[1] === '-X' && a[2] === 'POST') {
  if (fs.existsSync(d + '/fail-post')) { process.stderr.write('HTTP 502'); process.exit(1); }
  const comments = read('comments.json', []); const body = a[a.indexOf('-f') + 1].slice(5);
  const id = 1000 + comments.length; comments.push({ id, body }); fs.writeFileSync(d + '/comments.json', JSON.stringify(comments));
  process.stdout.write(String(id)); process.exit(0);
}
if (a[0] === 'api' && /issues\\/\\d+\\/comments$/.test(a[1])) {
  const marker = a[a.indexOf('--jq') + 1].match(/contains\\((".*")\\)/)[1];
  process.stdout.write(read('comments.json', []).filter((c) => c.body.includes(JSON.parse(marker))).map((c) => c.id).join('\\n')); process.exit(0);
}
if (a[0] === 'issue' || a[0] === 'label') { process.stdout.write('[]'); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });

const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({
  project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'R' },
  bins: { gh: fakeGh }, github: { sync: true, openDraftPrs: false }, pm: { enabled: false },
  limits: { busyWindow: { enabled: true, timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:30', end: '16:15', maxConcurrent: 1 } },
}));
process.env.SIGMADESK_CONFIG = cfg;
process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, store, sched, reviews, runner, team, dispatch, github, prs;
before(async () => {
  ({ config } = await import('../src/config.js'));
  config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  team = await import('../src/team.js');
  dispatch = await import('../src/dispatch.js');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
  runner = await import('../src/runner.js');
  github = await import('../src/github.js');
  prs = await import('../src/prs.js');
  sched = await import('../src/scheduler.js');
  reviews = await import('../src/reviews.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const setGh = (file, value) => fs.writeFileSync(path.join(ghDir, file), JSON.stringify(value));
const SATURDAY = new Date('2026-10-03T15:00:00Z');
const WEDNESDAY_11_ET = new Date('2026-09-30T15:00:00Z');
let runSeq = 0;
const run = (agent_id, kind, ticket_key, nonce = null) => store.createRun({ agent_id, kind, ticket_key, token: `tok-${++runSeq}-${Math.random()}`, model: 'claude:x', nonce });

/** A slice designed by principal-be, built by the junior, with one committed change, already through QA. */
async function sliceThroughQa({ file = 'docs/note.md', risk = 'low', designer = 'principal-be', assignee = 'junior' } = {}) {
  const t0 = store.createTicket({ title: `Slice ${++runSeq}`, status: 'in_progress', assignee, area: 'backend', complexity: 'S' });
  store.updateTicket(t0.key, { designer, risk });
  const ws = await runner.ensureWorkspace(store.getTicket(t0.key));
  store.updateTicket(t0.key, { branch: ws.branch });
  fs.mkdirSync(path.dirname(path.join(ws.dir, file)), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, file), `change ${runSeq}\n`);
  g(ws.dir, 'add', '.'); g(ws.dir, 'commit', '-qm', 'change');
  const sha = g(ws.dir, 'rev-parse', 'HEAD');
  store.updateTicket(t0.key, { status: 'qa', head_sha: sha });
  if (file.startsWith('docs/')) {
    const qa = run('qa', 'qa', t0.key, 'qacode');
    await sched.deskAction(qa, 'qa', { verdict: 'pass', code: 'qacode', body: 'docs only' });
  } else await reviews.afterQaPass(store.getTicket(t0.key), sha); // code changes need QA test evidence: covered by desk.test
  store.updateTicket(t0.key, { pr_url: 'https://github.com/owner/demo/pull/7' });
  return { key: t0.key, dir: ws.dir, sha };
}
/** Bind a review run to the next pending assignment (what launchPrReview does). */
function startReview(key) {
  const job = reviews.nextJobs().find((j) => j.key === key);
  assert.equal(job?.kind, 'pr_review');
  const code = `c${++runSeq}`;
  const r = run(job.seat, 'pr_review', key, code);
  store.updatePrReview(job.review.id, { nonce: code, run_id: r.id, round: store.getTicket(key).review_round || 0 });
  return { run: r, code, job };
}
const approve = (key) => { const { run: r, code, job } = startReview(key); return sched.deskAction(r, 'review', { verdict: 'approve', code, checked: 'Read the full diff and the tests it adds', risks: 'none', body: 'Looks right.' }).then(() => job); };
const FINDINGS = JSON.stringify([{ file: 'alpaca_trader/app/oms/exit_monitor.py', line: 3090, problem: 'Stop is placed before the fill is confirmed', why_it_matters: 'A partial fill leaves an unprotected position', suggested_fix: 'Wait for the fill event', blocking: true },
  { file: 'README.md', problem: 'Typo', blocking: false }]);

test('reviewer selection: designer first, else EM; never PM/SRE/author; independent prefers another engine', () => {
  const base = { assignee: 'junior', area: 'backend', risk: 'low', diff_risk: 'low' };
  assert.equal(reviews.selectReviewers({ ...base, designer: 'principal-be' }).context, 'principal-be');
  assert.equal(reviews.selectReviewers({ ...base, designer: null }).context, 'manager');
  assert.equal(reviews.selectReviewers({ ...base, designer: 'pm' }).context, 'manager', 'a PM is never the code reviewer');
  const own = reviews.selectReviewers({ ...base, assignee: 'senior-be', designer: 'principal-be' });
  assert.notEqual(own.independent, 'senior-be', 'the author never reviews their own work');
  for (let i = 0; i < 5; i++) {
    const r = reviews.selectReviewers({ ...base, designer: 'principal-be' });
    assert.ok(team.PRINCIPALS.includes(r.independent) || ['senior-be', 'senior-fe', 'dba'].includes(r.independent));
    assert.notEqual(r.independent, r.context);
  }
  team.agentById['senior-fe'].engine = 'codex';
  assert.equal(reviews.selectReviewers({ ...base, designer: 'principal-be' }).independent, 'senior-fe', 'a different engine than the author wins');
  team.agentById['senior-fe'].engine = 'claude';
  assert.equal(reviews.selectReviewers({ ...base, designer: 'principal-be' }).independent, 'senior-be', 'otherwise someone who knows the area');
  const off = ['manager', 'principal-be'];
  for (const id of off) team.agentById[id].enabled = false;
  assert.match(reviews.selectReviewers({ ...base, designer: 'principal-be' }).error, /neither the designer nor the Engineering Manager/);
  for (const id of off) team.agentById[id].enabled = true;
});

test('risk: deterministic diff classifier and the auto-merge policy (unknown counts as high)', () => {
  assert.equal(reviews.classifyDiff(['alpaca_trader/app/oms/exit_monitor.py']).risk, 'high');
  assert.equal(reviews.classifyDiff(['alpaca_trader/app/services/order_execution_service.py']).risk, 'high');
  assert.equal(reviews.classifyDiff(['docker-compose.mac-mini.yml', 'README.md']).hits.length, 1);
  assert.equal(reviews.classifyDiff(['.github/workflows/ci.yml']).risk, 'high');
  assert.equal(reviews.classifyDiff(['alpaca_trader/app/migrations/004.sql']).risk, 'high');
  assert.equal(reviews.classifyDiff(['ui-trader/src/App.tsx', 'docs/x.md']).risk, 'low');
  assert.equal(reviews.classifyDiff([]).risk, 'unknown');
  assert.equal(reviews.autoMergePolicy({ risk: 'low', diff_risk: 'low' }).eligible, true);
  assert.match(reviews.autoMergePolicy({ risk: null, diff_risk: 'low' }).reason, /never|nobody recorded/);
  assert.match(reviews.autoMergePolicy({ risk: 'high', diff_risk: 'low' }).reason, /high-risk/);
  assert.match(reviews.autoMergePolicy({ risk: 'low', diff_risk: 'unknown' }).reason, /could not be classified/);
});

test('grooming stores --risk; slices record their designer and inherit the parent risk', async () => {
  const p = store.createTicket({ title: 'Epic', status: 'proposed' });
  await sched.deskAction(run('manager', 'groom', p.key), 'groom', { complexity: 'L', area: 'backend', risk: 'high', body: 'spec' });
  assert.equal(store.getTicket(p.key).risk, 'high');
  const out = await sched.deskAction(run('principal-be', 'design', p.key), 'create-task', { title: 's1', body: 'b', complexity: 'S', area: 'backend' });
  const slice = store.getTicket(out.match(/R-\d+/)[0]);
  assert.equal(slice.designer, 'principal-be');
  assert.equal(slice.risk, 'high');
  const q = store.createTicket({ title: 'No risk given', status: 'proposed' });
  await sched.deskAction(run('manager', 'groom', q.key), 'groom', { complexity: 'S', area: 'backend' });
  assert.equal(store.getTicket(q.key).risk, null, 'omitted risk stays unknown (treated as high)');
});

test('happy path: QA pass → context approves → independent approves → ready for the owner, in that order', async () => {
  const s = await sliceThroughQa();
  let t = store.getTicket(s.key);
  assert.equal(t.status, 'review'); assert.equal(t.review_stage, 'reviewing'); assert.equal(t.qa_sha, s.sha); assert.equal(t.diff_risk, 'low');
  assert.equal(t.reviewer_context, 'principal-be');
  const first = reviews.nextJobs().find((j) => j.key === s.key);
  assert.equal(first.seat, 'principal-be', 'the context reviewer goes first');
  assert.equal(reviews.nextJobs().filter((j) => j.key === s.key).length, 1, 'sequential: one reviewer at a time');
  await approve(s.key);
  assert.equal(store.getTicket(s.key).status, 'review', 'one approval is not enough (and is not a failed run)');
  const second = await approve(s.key);
  assert.equal(second.seat, t.reviewer_independent);
  t = store.getTicket(s.key);
  assert.equal(t.status, 'ready_for_human'); assert.equal(t.review_stage, 'approved');
  assert.match(t.progress_msg, /^Approved by Rowan and \w+ — SigmaDesk will merge/);
  assert.ok(store.approvalsAt(s.key, s.sha).ok);
  const bodies = store.listOutbox(s.key).map((o) => o.body);
  assert.match(bodies[0], /\*\*Rowan — Principal Backend Engineer \(designed this change\)\*\* · ✅ Approved/);
  assert.match(bodies[0], /\*\*What I checked:\*\* Read the full diff/);
  assert.ok(bodies.some((b) => /Two approvals at/.test(b)));
  const s2 = reviews.summary(s.key);
  assert.deepEqual(s2.reviews.map((r) => [r.role, r.verdict]), [['context', 'approve'], ['independent', 'approve']]);
});

test('verdict nonce is bound to the assignment, run, seat, commit and round', async () => {
  const s = await sliceThroughQa();
  const { run: r, code, job } = startReview(s.key);
  const ok = { verdict: 'approve', code, checked: 'Read the full diff and the tests it adds', body: 'fine' };
  await assert.rejects(sched.deskAction(r, 'review', { ...ok, code: 'nope' }), /wrong --code/);
  const stranger = run(job.seat, 'pr_review', s.key, code); // same code, different run: not bound
  await assert.rejects(sched.deskAction(stranger, 'review', ok), /no review assignment is bound/);
  await assert.rejects(sched.deskAction(run('pm', 'pr_review', s.key, code), 'review', ok), /cannot run "review"/);
  await assert.rejects(sched.deskAction(r, 'review', { ...ok, checked: 'ok' }), /what you checked/);
  store.updateTicket(s.key, { review_round: 5 });
  await assert.rejects(sched.deskAction(r, 'review', ok), /round is over/);
  store.updateTicket(s.key, { review_round: 0, head_sha: 'f'.repeat(40) });
  await assert.rejects(sched.deskAction(r, 'review', ok), /change moved/);
  store.updateTicket(s.key, { head_sha: s.sha });
  await sched.deskAction(r, 'review', ok);
  await assert.rejects(sched.deskAction(r, 'review', ok), /already recorded|not bound/, 'no duplicate verdicts');
});

test('pushback loop: same commit → the requesting reviewer re-reviews with the thread and resolves', async () => {
  const s = await sliceThroughQa();
  await approve(s.key);
  const { run: r, code } = startReview(s.key);
  await sched.deskAction(r, 'review', { verdict: 'changes', code, findings: FINDINGS, body: 'One real problem.' });
  let t = store.getTicket(s.key);
  assert.equal(t.review_stage, 'responding'); assert.equal(t.review_round, 1);
  const changes = store.listOutbox(s.key).at(-1).body;
  assert.match(changes, /✏️ Changes requested — 1 thing to fix \(\+1 optional\)/);
  assert.match(changes, /1\. `alpaca_trader\/app\/oms\/exit_monitor.py:3090` — Stop is placed/);
  const job = reviews.nextJobs().find((j) => j.key === s.key);
  assert.deepEqual([job.kind, job.seat], ['respond', 'junior']);
  assert.match(reviews.respondPrompt(t), /BLOCKING/);
  const author = run('junior', 'respond', s.key);
  const ids = store.listFindings(s.key).map((f) => f.id);
  await assert.rejects(sched.deskAction(author, 'respond', { action: 'done', body: 'all good' }), /answer these first/);
  await assert.rejects(sched.deskAction(author, 'respond', { action: 'fixed', finding: ids[0], body: 'fixed it' }), /commit the fix first/);
  await sched.deskAction(author, 'respond', { action: 'pushback', finding: ids[0], body: 'The fill is confirmed synchronously at exit_monitor.py:3071; see test_partial_fill.' });
  await sched.deskAction(author, 'respond', { action: 'done', body: 'Answered.' });
  t = store.getTicket(s.key);
  assert.equal(t.status, 'review'); assert.equal(t.review_stage, 'reviewing'); assert.equal(t.head_sha, s.sha);
  assert.ok(store.listOutbox(s.key).some((o) => /^\*\*Riley — Junior Engineer\*\* replying to .* on R\d+-1/.test(o.body) && /Pushing back: The fill/.test(o.body)));
  const again = startReview(s.key);
  assert.equal(again.job.review.role, 'independent', 'the reviewer who asked re-reviews; the context approval still stands');
  assert.match(reviews.reviewPrompt(t, store.getPrReview(again.job.review.id), again.code), /pushed back: The fill is confirmed/);
  await sched.deskAction(again.run, 'review', { verdict: 'approve', code: again.code, checked: 'Re-read exit_monitor.py:3071 and the partial-fill test', body: 'Convinced.' });
  assert.equal(store.getTicket(s.key).status, 'ready_for_human');
  assert.equal(store.getFinding(ids[0]).resolution, 'resolved');
  assert.match(store.listOutbox(s.key).find((o) => /Convinced/.test(o.body)).body, /accepted the pushback/);
});

test('a fix commit voids BOTH approvals and QA; both reviewers look again at the new commit', async () => {
  const s = await sliceThroughQa();
  await approve(s.key);
  const { run: r, code } = startReview(s.key);
  await sched.deskAction(r, 'review', { verdict: 'changes', code, findings: FINDINGS, body: 'Fix the stop.' });
  const [blocking] = store.listFindings(s.key);
  fs.writeFileSync(path.join(s.dir, 'docs/note.md'), 'fixed\n'); g(s.dir, 'commit', '-qam', 'fix');
  const author = run('junior', 'respond', s.key);
  await sched.deskAction(author, 'respond', { action: 'fixed', finding: blocking.id, body: 'Waits for the fill event now.' });
  await sched.deskAction(author, 'respond', { action: 'done', body: 'Fixed.' });
  const t = store.getTicket(s.key);
  assert.equal(t.status, 'qa', 'new commit → QA first');
  assert.notEqual(t.head_sha, s.sha);
  assert.equal(store.approvalsAt(s.key, s.sha).ok, false);
  assert.ok(store.listPrReviews(s.key).every((x) => x.state === 'superseded'), 'every earlier verdict is void');
  const qa = run('qa', 'qa', s.key, 'qa2');
  await sched.deskAction(qa, 'qa', { verdict: 'pass', code: 'qa2', body: 'ok' });
  const job = reviews.nextJobs().find((j) => j.key === s.key);
  assert.equal(job.role ?? job.review.role, 'context', 'context reviewer re-reviews first');
  assert.equal(job.review.sha, t.head_sha);
  assert.match(reviews.threadFor(s.key), /fixed in [0-9a-f]{7}: Waits for the fill/);
});

test('round cap: past review.maxRounds the owner gets a plain summary of the disagreement', async () => {
  const cap = config.review.maxRounds; config.review.maxRounds = 1;
  try {
    const s = await sliceThroughQa();
    let { run: r, code } = startReview(s.key);
    await sched.deskAction(r, 'review', { verdict: 'changes', code, findings: FINDINGS, body: 'Fix the stop.' });
    const author = run('junior', 'respond', s.key);
    await sched.deskAction(author, 'respond', { action: 'pushback', finding: store.listFindings(s.key)[0].id, body: 'Out of scope for this slice.' });
    await sched.deskAction(author, 'respond', { action: 'done', body: 'Pushed back.' });
    ({ run: r, code } = startReview(s.key));
    await sched.deskAction(r, 'review', { verdict: 'changes', code, findings: FINDINGS, body: 'Still unsafe.' });
    const t = store.getTicket(s.key);
    assert.equal(t.status, 'needs_human'); assert.equal(t.resume_status, 'review'); assert.equal(t.review_round, 2);
    const msg = store.listComments(s.key).at(-1).body;
    assert.match(msg, /Your call: the review has gone 2 rounds\*\* \(limit 1\)/);
    assert.match(msg, /What Riley argued earlier:[\s\S]*Out of scope/);
    sched.ownerReply(s.key, 'Rowan is right — fix it.');
    assert.equal(store.getTicket(s.key).status, 'review');
    assert.equal(reviews.nextJobs().find((j) => j.key === s.key).kind, 'respond', 'the author answers with the owner’s guidance');
  } finally { config.review.maxRounds = cap; }
});

test('outbox: posts once with a marker, keeps failures pending, and adopts a comment posted before a crash', async () => {
  const t = store.createTicket({ title: 'Outbox', status: 'review' });
  store.updateTicket(t.key, { pr_url: 'https://github.com/owner/demo/pull/9' });
  // drain anything earlier tests queued
  await github.flushOutbox();
  fs.writeFileSync(path.join(ghDir, 'fail-post'), '1');
  const o = store.enqueueOutbox(t.key, `${t.key}:a`, 'hello reviewers');
  assert.equal(store.enqueueOutbox(t.key, `${t.key}:a`, 'dupe').id, o.id, 'same marker = same row');
  await github.flushOutbox();
  let row = store.listOutbox(t.key)[0];
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 1); assert.equal(row.gh_comment_id, null);
  assert.ok(store.approvalsAt(t.key, 'x').unpublished > 0, 'merge sees unpublished comments');
  fs.rmSync(path.join(ghDir, 'fail-post'));
  // Simulate "GitHub accepted the POST but the desk crashed before recording it".
  const comments = JSON.parse(fs.readFileSync(path.join(ghDir, 'comments.json'), 'utf8'));
  comments.push({ id: 4242, body: `hello reviewers\n\n${github.outboxMarker(`${t.key}:a`)}` });
  fs.writeFileSync(path.join(ghDir, 'comments.json'), JSON.stringify(comments));
  const posts = ghCalls().filter((c) => c[1] === '-X').length;
  await github.flushOutbox();
  row = store.listOutbox(t.key)[0];
  assert.equal(row.status, 'sent'); assert.equal(row.gh_comment_id, '4242');
  assert.equal(ghCalls().filter((c) => c[1] === '-X').length, posts, 'no second POST');
  store.enqueueOutbox(t.key, `${t.key}:b`, 'second');
  await github.flushOutbox();
  const b = store.listOutbox(t.key)[1];
  assert.equal(b.status, 'sent'); assert.ok(Number(b.gh_comment_id) >= 1000);
  assert.match(JSON.parse(fs.readFileSync(path.join(ghDir, 'comments.json'), 'utf8')).at(-1).body, /<!-- sigmadesk-review:R-\d+:b -->/);
});

test('merge authorization matrix', () => {
  const sha = 'a'.repeat(40);
  const ok = { state: 'OPEN', headRefOid: sha, baseRefName: 'main', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] };
  const good = { ok: true, unpublished: 0, context: { seat: 'principal-be', verdict: 'approve' }, independent: { seat: 'senior-be', verdict: 'approve' } };
  const auth = (p, o = {}) => prs.authorizeMerge({ ...ok, ...p }, { expectedSha: sha, gate: { approvals: good, qaSha: sha }, ...o }).blockers;
  assert.deepEqual(auth({}), []);
  assert.match(auth({}, { expectedSha: '' })[0], /expected head SHA/);
  assert.match(auth({ headRefOid: 'b'.repeat(40) })[0], /head moved/);
  assert.match(auth({ baseRefName: 'sigmadesk/r-1-x' })[0], /targets/);
  assert.match(auth({ mergeable: 'UNKNOWN' })[0], /mergeability/);
  assert.match(auth({ mergeable: 'CONFLICTING' })[0], /conflicts/);
  assert.match(auth({ statusCheckRollup: [{ conclusion: 'FAILURE' }] })[0], /failing/);
  assert.match(auth({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] })[0], /still running/);
  assert.match(auth({ statusCheckRollup: [{ conclusion: 'SKIPPED' }, { conclusion: 'NEUTRAL' }] })[0], /skipped or neutral/);
  assert.match(auth({ statusCheckRollup: [] })[0], /no CI result/);
  assert.deepEqual(auth({ statusCheckRollup: [] }, { noChecksConfigured: true }), [], 'a repo with no workflows has no CI to wait for');
  assert.match(auth({}, { inBusyWindow: true })[0], /busy window/);
  assert.deepEqual(auth({}, { inBusyWindow: true, override: 'merge during market hours' }), []);
  assert.match(auth({}, { inBusyWindow: true, override: 'merge during market hours', actor: 'desk' })[0], /busy window/, 'the desk never overrides');
  assert.match(auth({}, { actor: 'desk', halted: true })[0], /paused/);
  const half = { ...good, ok: false, independent: { seat: 'senior-be', verdict: 'pending' } };
  assert.match(auth({}, { gate: { approvals: half, qaSha: sha } })[0], /two reviewer approvals.*Rowan: approve, Jordan: pending.*override reason/);
  assert.match(auth({}, { gate: { approvals: { ...good, unpublished: 2 }, qaSha: sha } })[0], /not on the PR yet/);
  assert.match(auth({}, { gate: { approvals: good, qaSha: 'c'.repeat(40) } })[0], /QA passed a different commit/);
  const over = prs.authorizeMerge(ok, { expectedSha: sha, gate: { approvals: half, qaSha: sha }, overrideReason: 'hotfix for a live incident' });
  assert.deepEqual(over.blockers, []); assert.equal(over.overridden.length, 1);
  assert.equal(prs.authorizeMerge(ok, { expectedSha: sha, gate: { approvals: half, qaSha: sha }, overrideReason: 'hotfix for a live incident', actor: 'desk' }).blockers.length, 1);
  assert.equal(prs.authorizeMerge({ ...ok, mergeable: 'CONFLICTING' }, { expectedSha: sha, gate: { approvals: half }, overrideReason: 'hotfix for a live incident' }).blockers.length, 1, 'an override never skips conflicts or CI');
});

async function approvedTicket(opts) {
  const s = await sliceThroughQa(opts);
  await approve(s.key); await approve(s.key);
  await github.flushOutbox();
  const t = store.getTicket(s.key);
  setGh('pr.json', { number: 7, title: `[${t.key}] ${t.title}`, state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE', headRefOid: t.head_sha, baseRefName: 'main',
    body: 'Opened by SigmaDesk', statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  return t;
}
const merges = () => ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'merge');

test('auto-merge: low risk outside the window merges exactly the approved commit and says so on the PR', async () => {
  store.setSetting('paused', 'false');
  const t = await approvedTicket();
  const before = merges().length;
  const r = await reviews.tryAutoMerge(t, { now: SATURDAY });
  assert.equal(r.merged, true, r.reason);
  const m = merges().at(-1);
  assert.equal(merges().length, before + 1);
  assert.deepEqual(m.slice(-2), ['--match-head-commit', t.head_sha]);
  assert.ok(ghCalls().some((c) => c[0] === 'pr' && c[1] === 'ready'), 'draft is readied first');
  assert.match(store.listOutbox(t.key).at(-1).body, /Merged by SigmaDesk\*\* after approvals from Rowan \(Principal Backend Engineer\) and/);
  assert.equal(store.getTicket(t.key).review_stage, 'merged');
});

test('auto-merge: high risk, unknown risk, busy window and a paused desk wait for the owner', async () => {
  store.setSetting('paused', 'false');
  const before = merges().length;
  const high = await approvedTicket({ file: 'alpaca_trader/app/oms/exit_monitor.py' });
  assert.equal(store.getTicket(high.key).diff_risk, 'high');
  let r = await reviews.tryAutoMerge(store.getTicket(high.key), { now: SATURDAY });
  assert.equal(r.merged, false);
  assert.match(store.getTicket(high.key).progress_msg, /^Approved by Rowan and \w+ — waiting for your merge \(it touches trading\/deploy paths \(alpaca_trader\/app\/oms\/exit_monitor.py\)\)/);
  const unknown = await approvedTicket({ risk: null });
  r = await reviews.tryAutoMerge(store.getTicket(unknown.key), { now: SATURDAY });
  assert.match(r.reason, /nobody recorded a risk/);
  const low = await approvedTicket();
  r = await reviews.tryAutoMerge(store.getTicket(low.key), { now: WEDNESDAY_11_ET });
  assert.match(r.reason, /market-hours window/);
  assert.match(store.getTicket(low.key).progress_msg, /auto-merge waiting: inside the market-hours window/);
  store.setSetting('paused', 'true');
  r = await reviews.tryAutoMerge(store.getTicket(low.key), { now: SATURDAY });
  assert.match(r.reason, /paused/);
  store.setSetting('paused', 'false');
  setGh('pr.json', { ...JSON.parse(fs.readFileSync(path.join(ghDir, 'pr.json'), 'utf8')), statusCheckRollup: [{ status: 'QUEUED' }] });
  r = await reviews.tryAutoMerge(store.getTicket(low.key), { now: SATURDAY });
  assert.match(r.reason, /CI is still running/);
  assert.equal(merges().length, before, 'nothing merged');
});

test('owner UI merge: the two-approval gate applies, an audited reason overrides it', async () => {
  const s = await sliceThroughQa();
  await approve(s.key); // only the context reviewer so far
  await github.flushOutbox();
  const t = store.getTicket(s.key);
  setGh('pr.json', { number: 7, title: `[${t.key}] x`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: t.head_sha, baseRefName: 'main', body: 'SigmaDesk', statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  await assert.rejects(prs.merge(7, { expectedSha: t.head_sha }), /two reviewer approvals/);
  const res = await prs.merge(7, { expectedSha: t.head_sha, overrideReason: 'Owner verified the diff by hand' });
  assert.equal(res.overridden.length, 1);
  const audit = ghCalls().filter((c) => c[0] === 'pr' && c[1] === 'comment').at(-1);
  assert.match(audit.at(-1), /merging without the full SigmaDesk review[\s\S]*Owner verified the diff by hand/);
  assert.ok(store.recentEvents({ ticket_key: t.key }).some((e) => /merge override/.test(e.text)));
});

test('restart mid-review resumes from persisted state without duplicate verdicts or comments', async () => {
  const s = await sliceThroughQa();
  const { run: r, job } = startReview(s.key);
  store.updateTicket(s.key, { active_run: r.id });
  sched.recoverOrphans();
  assert.equal(store.getRun(r.id).status, 'killed');
  assert.equal(store.getTicket(s.key).active_run, null);
  const resumed = reviews.nextJobs().find((j) => j.key === s.key);
  assert.equal(resumed.review.id, job.review.id, 'the same frozen assignment is picked up again');
  // A verdict was stored but the desk died before moving the ticket on: advance() settles it, idempotently.
  store.updatePrReview(job.review.id, { verdict: 'changes' });
  reviews.advance(s.key);
  reviews.advance(s.key);
  assert.equal(store.getTicket(s.key).review_stage, 'responding');
  store.enqueueOutbox(s.key, `${s.key}:review:${job.review.id}`, 'first');
  const n = store.listOutbox(s.key).length;
  store.enqueueOutbox(s.key, `${s.key}:review:${job.review.id}`, 'replayed');
  assert.equal(store.listOutbox(s.key).length, n, 'a replayed comment is deduplicated by its marker');
  assert.equal(store.listPrReviews(s.key).filter((x) => x.verdict !== 'pending').length, 1, 'no duplicate verdict rows');
});

test('reviewers get a read-only snapshot pinned to the reviewed commit, not the author clone', async () => {
  const s = await sliceThroughQa();
  const dir = await reviews.prepareSnapshot(store.getTicket(s.key), 'principal-be');
  assert.notEqual(dir, s.dir);
  assert.equal(g(dir, 'rev-parse', 'HEAD'), s.sha);
  assert.match(g(dir, 'diff', '--name-only', 'origin/main...HEAD'), /docs\/note.md/);
  assert.ok(team.permissionsFor('pr_review').tools.every((x) => !['Edit', 'Write'].includes(x)));
  assert.ok(team.permissionsFor('respond').tools.includes('Edit'));
});
