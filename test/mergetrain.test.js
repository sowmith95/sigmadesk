// Merge train (sowmith95/sigmadesk#3): open PRs, deploy-aware auto-merge, post-merge conflict sweep.
// A local bare repo plays GitHub's git side; a stub `gh` plays its API. No real GitHub call is ever made.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-train-'));
const g = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const origin = path.join(tmp, 'origin.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
const repo = path.join(tmp, 'repo');
execFileSync('git', ['clone', '-q', origin, repo]);
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
write(repo, '.github/workflows/deploy.yml', `name: Deploy
on:
  push:
    branches: [main]
    paths:
      - 'app/**'
      - '!app/**/*.md'
  workflow_dispatch:
jobs: {}
`);
write(repo, '.github/workflows/pr.yml', 'name: PR checks\non: [pull_request]\n');
write(repo, 'shared.txt', 'one\ntwo\nthree\n');
write(repo, 'app/main.py', 'print(1)\n');
g(repo, 'checkout', '-q', '-b', 'main'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init'); g(repo, 'push', '-q', 'origin', 'main');
// Another engineer's clone, used to land "other PRs" on main.
const other = path.join(tmp, 'other');
execFileSync('git', ['clone', '-q', origin, other]);
function landOnMain(file, text, subject) {
  g(other, 'pull', '-q', '--rebase', 'origin', 'main'); write(other, file, text); g(other, 'add', '.'); g(other, 'commit', '-qm', subject); g(other, 'push', '-q', 'origin', 'HEAD:main');
  return g(other, 'rev-parse', 'HEAD');
}

const ghLog = path.join(tmp, 'gh.log');
const ghDir = path.join(tmp, 'gh'); fs.mkdirSync(ghDir);
const fakeGh = path.join(tmp, 'gh.mjs');
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2); const d = ${JSON.stringify(ghDir)};
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(a) + '\\n');
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(d + '/' + f, 'utf8')); } catch { return def; } };
const out = (x) => { process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
if (a[0] === 'pr' && a[1] === 'view') out(a.join(' ').includes('mergeCommit') ? read('merge.json', {}) : read('pr.json', {}));
if (a[0] === 'pr' && a[1] === 'list') out('[]');
if (a[0] === 'pr' && a[1] === 'create') out('https://github.com/owner/demo/pull/55');
if (a[0] === 'run' && a[1] === 'list') out(read('runs.json', []));
if (a[0] === 'api' && /actions\\/workflows/.test(a[1])) out('2');
if (a[0] === 'api' && a[1] === '-X') { const c = read('comments.json', []); c.push({ id: 1000 + c.length, body: a[a.indexOf('-f') + 1].slice(5) }); fs.writeFileSync(d + '/comments.json', JSON.stringify(c)); out(String(999 + c.length)); }
if (a[0] === 'api') out('');
if (a[0] === 'issue' || a[0] === 'label') out('[]');
process.exit(0);
`, { mode: 0o755 });

const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({
  project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'M' },
  bins: { gh: fakeGh }, github: { sync: true }, pm: { enabled: false },
  limits: { busyWindow: { enabled: true, timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start: '09:30', end: '16:15', maxConcurrent: 1 } },
}));
process.env.SIGMADESK_CONFIG = cfg;
process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, store, sched, reviews, train, runner, wf, github, dispatch;
before(async () => {
  ({ config } = await import('../src/config.js'));
  config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  dispatch = await import('../src/dispatch.js');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
  runner = await import('../src/runner.js');
  github = await import('../src/github.js');
  wf = await import('../src/workflows.js');
  sched = await import('../src/scheduler.js');
  reviews = await import('../src/reviews.js');
  train = await import('../src/mergetrain.js');
  store.setSetting('paused', 'false');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const calls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const merges = () => calls().filter((c) => c[0] === 'pr' && c[1] === 'merge');
const setGh = (file, v) => fs.writeFileSync(path.join(ghDir, file), JSON.stringify(v));
const WED_11_ET = new Date('2026-09-30T15:00:00Z'); // EDT
const WED_AFTER = new Date('2026-09-30T20:16:00Z'); // 4:16 PM EDT
const SAT = new Date('2026-10-03T15:00:00Z');
let seq = 0;
const run = (agent_id, kind, ticket_key, nonce = null, extra = {}) => store.createRun({ agent_id, kind, ticket_key, token: `t${++seq}${Math.random()}`, model: 'claude:x', nonce, ...extra });
function startReview(key) {
  const job = reviews.nextJobs().find((j) => j.key === key);
  const code = `c${++seq}`;
  const r = run(job.seat, 'pr_review', key, code);
  store.updatePrReview(job.review.id, { nonce: code, run_id: r.id, round: store.getTicket(key).review_round || 0 });
  return { run: r, code };
}
async function approveBoth(key) {
  for (let i = 0; i < 2; i++) {
    const { run: r, code } = startReview(key);
    await sched.deskAction(r, 'review', { verdict: 'approve', code, checked: 'Read the diff and the tests it touches', body: 'ok' });
  }
}
/** A ticket whose PR branch is on origin, through QA and two approvals. */
async function approvedPr(file, text = `change ${++seq}\n`, { risk = 'low' } = {}) {
  const t0 = store.createTicket({ title: `Change ${file} ${++seq}`, status: 'in_progress', assignee: 'junior', area: 'backend', complexity: 'S' });
  store.updateTicket(t0.key, { designer: 'principal-be', risk, builder: 'junior' });
  const ws = await runner.ensureWorkspace(store.getTicket(t0.key));
  write(ws.dir, file, text); g(ws.dir, 'add', '.'); g(ws.dir, 'commit', '-qm', `change ${file}`);
  g(ws.dir, 'push', '-q', origin, `HEAD:refs/heads/${ws.branch}`);
  const sha = g(ws.dir, 'rev-parse', 'HEAD');
  store.updateTicket(t0.key, { branch: ws.branch, head_sha: sha, status: 'qa', pr_url: `https://github.com/owner/demo/pull/${100 + seq}` });
  store.kvSet(`published:${t0.key}`, sha);
  await reviews.afterQaPass(store.getTicket(t0.key), sha);
  await approveBoth(t0.key);
  await github.flushOutbox();
  return store.getTicket(t0.key);
}
const prFor = (t, o = {}) => setGh('pr.json', { number: 7, title: `[${t.key}] x`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', headRefOid: t.head_sha,
  baseRefName: 'main', body: 'Opened by SigmaDesk', statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...o });

test('glob + workflow filters: negation, ** and ? semantics, branches, paths-ignore, tags-only, unknown = deploys', () => {
  assert.ok(wf.matchesFilters('app/x/y.py', ['app/**']));
  assert.ok(!wf.matchesFilters('app/x/README.md', ['app/**', '!app/**/*.md']));
  assert.ok(wf.matchesFilters('app/x/README.md', ['app/**', '!app/**/*.md', 'app/x/README.md']), 'a later pattern re-includes');
  assert.ok(wf.matchesFilters('README.md', ['**/README.md']), '**/ matches at the root');
  assert.ok(!wf.matchesFilters('docs/a/b.md', ['docs/*']), '* stops at /');
  assert.ok(wf.matchesFilters('file.js', ['file.jsx?']) && wf.matchesFilters('file.jsx', ['file.jsx?']));
  assert.ok(wf.matchesFilters('releases/v10', ['releases/v[0-9]+']));
  const parse = (on) => wf.parseWorkflow(`name: X\non:\n${on}\njobs: {}\n`);
  assert.equal(wf.pushTriggers(wf.parseWorkflow('on: push'), 'main', ['a']), true);
  assert.equal(wf.pushTriggers(wf.parseWorkflow("'on': [push, pull_request]"), 'main', ['a']), true);
  assert.equal(wf.pushTriggers(wf.parseWorkflow('on: pull_request'), 'main', ['a']), false);
  assert.equal(wf.pushTriggers(parse('  push:\n    branches: ["*", "!main"]'), 'main', ['a']), false);
  assert.equal(wf.pushTriggers(parse('  push:\n    branches-ignore:\n      - main'), 'main', ['a']), false);
  assert.equal(wf.pushTriggers(parse('  push:\n    paths-ignore: ["docs/**"]'), 'main', ['docs/a.md']), false);
  assert.equal(wf.pushTriggers(parse('  push:\n    paths-ignore: ["docs/**"]'), 'main', ['docs/a.md', 'app/x']), true);
  assert.equal(wf.pushTriggers(parse('  push:\n    tags: ["v*"]'), 'main', ['a']), false, 'tags-only pushes never fire for a branch');
  assert.equal(wf.pushTriggers(parse('  schedule:\n    - cron: "0 * * * *"\n  push:\n    branches: [main] # deploy'), 'main', ['a']), true);
  const deploy = { file: '.github/workflows/d.yml', text: 'name: Deploy\non:\n  push:\n    branches: [main]\n    paths: ["app/**"]\n' };
  assert.equal(wf.deploysFor({ files: ['docs/x.md'], branch: 'main', workflows: [deploy] }).deploys, false);
  assert.deepEqual(wf.deploysFor({ files: ['app/a.py'], branch: 'main', workflows: [deploy] }).workflows.map((w) => w.name), ['Deploy']);
  assert.equal(wf.deploysFor({ files: ['x'], branch: 'main', workflows: [{ file: 'w.yml', text: 'on: {push: {}}' }] }).deploys, true, 'unparseable = deploys');
  assert.equal(wf.deploysFor({ files: ['docs/x.md'], branch: 'main', workflows: [deploy], registered: ['missing.yml'] }).deploys, true, 'a registered workflow that is gone = deploys');
  assert.equal(wf.deploysFor({ files: ['app/a.py'], branch: 'main', workflows: [deploy, { file: 'k.yml', text: 'on:\n  push:\n    branches: [main]\n' }], registered: ['d.yml'] }).workflows.length, 1, 'only registered workflows count');
});

test('busy-window end is DST-safe in America/New_York', () => {
  assert.equal(train.windowEnd(new Date('2026-10-30T15:00:00Z')).toISOString(), '2026-10-30T20:15:00.000Z'); // EDT Friday
  assert.equal(train.windowEnd(new Date('2026-11-02T16:00:00Z')).toISOString(), '2026-11-02T21:15:00.000Z'); // EST Monday after the change
  assert.equal(train.windowEnd(SAT).toISOString(), SAT.toISOString(), 'outside the window = now');
  assert.equal(train.fmtTime(new Date('2026-11-02T21:15:00Z')), '4:15 PM ET');
});

test('merge-tree: clean, real conflicts (content, rename/delete, binary) and errors are told apart', async () => {
  const d = path.join(tmp, 'mt'); execFileSync('git', ['init', '-q', '-b', 'main', d]);
  write(d, 'f.txt', 'a\nb\nc\n'); write(d, 'r.txt', 'x\n'); fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 1]));
  g(d, 'add', '.'); g(d, 'commit', '-qm', 'i'); g(d, 'checkout', '-qb', 'pr');
  write(d, 'f.txt', 'a\nPR\nc\n'); g(d, 'mv', 'r.txt', 'r2.txt'); fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 2])); g(d, 'commit', '-qam', 'pr');
  g(d, 'checkout', '-q', 'main'); write(d, 'f.txt', 'a\nMAIN\nc\n'); g(d, 'rm', '-q', 'r.txt'); fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.from([0, 3])); g(d, 'commit', '-qam', 'main');
  let out = ''; try { execFileSync('git', ['-C', d, 'merge-tree', '--write-tree', '-z', 'main', 'pr']); } catch (e) { assert.equal(e.status, 1); out = e.stdout.toString(); }
  const r = train.parseMergeTree(out);
  assert.match(r.tree, /^[0-9a-f]{40}$/);
  const by = Object.fromEntries(r.conflicts.map((c) => [c.path, c]));
  assert.equal(by['f.txt'].kind, 'content'); assert.deepEqual(by['f.txt'].stages.map((s) => s.stage), [1, 2, 3]);
  assert.equal(by['bin.dat'].kind, 'binary');
  assert.equal(by['r2.txt'].kind, 'rename/delete');
  // through the desk's publisher repo (base watcher fetch), cached per (base, head)
  const t = await approvedPr('notes/clean.txt');
  const snap = await train.watchBase();
  const head = snap.heads.find((h) => h.t.key === t.key).head;
  assert.equal((await train.mergeTree(snap.base, head)).status, 'clean');
  assert.equal((await train.mergeTree(snap.base, 'f'.repeat(40))).status, 'error', 'unknown objects are errors, not conflicts');
});

test('deploying PR inside the window is scheduled, then merges after the window; non-deploying merges at once', async () => {
  const docs = await approvedPr('docs/guide.md');
  prFor(docs); setGh('merge.json', { mergeCommit: { oid: 'd'.repeat(40) } });
  let r = await train.consider(docs, { now: WED_11_ET, snap: await train.watchBase() });
  assert.equal(r.action, 'merged', JSON.stringify(r));
  assert.equal(train.deployState(), null, 'no deploy lock for a non-deploying merge');

  const app = await approvedPr('app/feature.py');
  prFor(app);
  r = await train.consider(app, { now: WED_11_ET, snap: await train.watchBase() });
  assert.equal(r.action, 'scheduled');
  const t = store.getTicket(app.key);
  assert.equal(t.merge_after, '2026-09-30T20:15:00.000Z');
  assert.deepEqual(train.mergeState(t, WED_11_ET), { state: 'scheduled', at: t.merge_after, label: '4:15 PM ET' });
  assert.match(store.listOutbox(app.key).at(-1).body, /Scheduled to merge automatically after 4:15 PM ET\*\* because it redeploys via Deploy/);
  assert.match(t.progress_msg, /merges automatically at 4:15 PM ET/);
  const before = merges().length;
  await train.consider(store.getTicket(app.key), { now: WED_11_ET });
  assert.equal(merges().length, before, 'still waiting');
  assert.equal(store.listOutbox(app.key).filter((o) => /Scheduled/.test(o.body)).length, 1, 'scheduled once, not every minute');
  setGh('merge.json', { mergeCommit: { oid: 'e'.repeat(40) } });
  r = await train.consider(store.getTicket(app.key), { now: WED_AFTER, snap: await train.watchBase() });
  assert.equal(r.action, 'merged', JSON.stringify(r));
  assert.deepEqual(merges().at(-1).slice(-2), ['--match-head-commit', app.head_sha]);
  assert.equal(store.getTicket(app.key).merge_after, null);
  assert.equal(train.deployState().key, app.key, 'its deploy is now in flight');
  assert.match(store.listOutbox(app.key).at(-1).body, /Merged by SigmaDesk\*\* after approvals.*redeploys via Deploy/);
});

test('one deploying merge at a time: wait for the deploy run, owner on failure or timeout', async () => {
  const next = await approvedPr('app/second.py');
  prFor(next);
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'in_progress', conclusion: '' }]);
  let r = await train.consider(next, { now: WED_AFTER, snap: await train.watchBase() });
  assert.equal(r.action, 'queued', JSON.stringify(r)); assert.match(r.reason, /deploy of M-\d+ is still running/);
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'failure' }]);
  r = await train.consider(store.getTicket(next.key), { now: WED_AFTER, snap: await train.watchBase() });
  assert.match(r.reason, /last deploy failed/);
  assert.equal(train.deployState().state, 'failed');
  train.clearDeployLock('owner');
  // timeout: a run that never finishes
  store.kvSet('train:deploy', JSON.stringify({ key: 'M-1', merge_sha: 'e'.repeat(40), at: new Date(WED_AFTER - 50 * 60_000).toISOString(), workflows: ['Deploy'], state: 'running' }));
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'queued', conclusion: '' }]);
  r = await train.consider(store.getTicket(next.key), { now: WED_AFTER, snap: await train.watchBase() });
  assert.match(r.reason, /did not finish/);
  assert.equal(train.deployState().state, 'escalated');
  train.clearDeployLock('owner');
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'success' }]);
  setGh('merge.json', { mergeCommit: { oid: 'f'.repeat(40) } });
  r = await train.consider(store.getTicket(next.key), { now: WED_AFTER, snap: await train.watchBase() });
  assert.equal(r.action, 'merged');
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'success' }]);
  assert.equal(await train.deployLock(WED_AFTER), null, 'a finished, green deploy releases the lock');
});

test('high risk still waits for the owner; hold and release are persisted and said on the PR', async () => {
  const high = await approvedPr('app/oms/exit_monitor.py');
  prFor(high);
  const before = merges().length;
  const r = await train.consider(high, { now: SAT });
  assert.equal(r.action, 'owner');
  assert.match(store.getTicket(high.key).progress_msg, /waiting for your merge \(it touches trading\/deploy paths/);
  assert.equal(train.mergeState(store.getTicket(high.key)).state, 'owner');
  const low = await approvedPr('docs/hold.md');
  prFor(low);
  assert.equal(train.setHold(low.key, true, 'wait for the release notes').state, 'held');
  assert.equal((await train.consider(store.getTicket(low.key), { now: SAT })).action, 'held');
  assert.match(store.listOutbox(low.key).at(-1).body, /On hold by the owner\*\*: wait for the release notes/);
  assert.equal(train.setHold(low.key, false).state, 'queued');
  assert.equal(merges().length, before);
});

test('PRs open as normal (non-draft) PRs by default; the draft setting still works', async () => {
  const t = store.createTicket({ title: 'Open PR', status: 'review' });
  store.updateTicket(t.key, { branch: 'sigmadesk/open-pr', head_sha: 'a'.repeat(40) });
  assert.equal(store.getSettings().draft_prs, 'false');
  await github.openDraftPr(t.key, 'summary');
  let create = calls().filter((c) => c[0] === 'pr' && c[1] === 'create').at(-1);
  assert.ok(!create.includes('--draft'));
  const t2 = store.createTicket({ title: 'Draft PR', status: 'review' });
  store.updateTicket(t2.key, { branch: 'sigmadesk/draft-pr', head_sha: 'b'.repeat(40) });
  store.setSetting('draft_prs', 'true');
  await github.openDraftPr(t2.key, 'summary');
  create = calls().filter((c) => c[0] === 'pr' && c[1] === 'create').at(-1);
  assert.ok(create.includes('--draft'));
  store.setSetting('draft_prs', 'false');
});

test('lazy update: the queue front is rebased desk-side; a moved branch loses the lease race', async () => {
  const raced = await approvedPr('notes/race.txt');
  const fresh = await approvedPr('notes/fresh.txt');
  landOnMain('notes/unrelated.txt', 'u\n', '[M-900] Unrelated tweak (#390)');
  const snap = await train.watchBase();
  // someone pushes to the first PR branch after the desk looked
  const w = path.join(tmp, 'pusher'); execFileSync('git', ['clone', '-q', '-b', raced.branch, origin, w]);
  write(w, 'notes/race.txt', 'theirs\n'); g(w, 'commit', '-qam', 'push'); g(w, 'push', '-q', 'origin', raced.branch);
  assert.equal((await train.lazyUpdate(store.getTicket(raced.key), snap)).action, 'raced');
  assert.equal(store.getTicket(raced.key).head_sha, raced.head_sha, 'nothing changed on a lost race');
  const u = await train.lazyUpdate(store.getTicket(fresh.key), snap);
  assert.equal(u.action, 'updated');
  const t = store.getTicket(fresh.key);
  assert.equal(t.status, 'qa'); assert.equal(t.reconfirm_kind, 'rebase'); assert.equal(t.reconfirm_from, fresh.head_sha);
  assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', `refs/heads/${t.branch}`], { encoding: 'utf8' }).trim(), u.head);
  assert.equal(g(runner.workspaceDir(t.key), 'rev-parse', 'HEAD'), u.head, 'QA will test exactly the updated commit');
  assert.equal(g(origin, 'merge-base', '--is-ancestor', snap.base, u.head), '');
  assert.match(store.listOutbox(t.key).at(-1).body, /Brought up to date with `main`.*#390 \(Unrelated tweak\)/s);
  assert.equal(store.approvalsAt(t.key, u.head).ok, false, 'approvals bind to the old head');
  // after QA, the reviewers only re-confirm with a range-diff
  await reviews.afterQaPass(store.getTicket(t.key), u.head);
  const ctx = await reviews.reconfirmContext(store.getTicket(t.key));
  assert.equal(ctx.kind, 'rebase'); assert.match(ctx.rangeDiff, /change notes\/fresh.txt/);
  assert.match(reviews.reviewPrompt(store.getTicket(t.key), store.listPrReviews(t.key).at(-2), 'x', ctx), /LIGHT RE-CONFIRM/);
});

test('real conflict → one durable resolve job for the builder, recovered after restart, verified, then QA', async () => {
  const pr = await approvedPr('shared.txt', 'one\nPR side\nthree\n');
  landOnMain('shared.txt', 'one\nMAIN side\nthree\n', '[M-901] Eastern session helpers (#391)');
  await train.sweep({ now: SAT });
  let t = store.getTicket(pr.key);
  assert.equal(t.status, 'review'); assert.equal(t.review_stage, 'resolving');
  const jobs = store.conflictJobsFor(pr.key);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].seat, 'junior');
  assert.match(store.listOutbox(pr.key).find((o) => /Conflicted/.test(o.body)).body, /Conflicted with #391 \(Eastern session helpers\)\*\* in `shared.txt` — Riley \(Junior Engineer\) is resolving it/);
  await train.sweep({ now: SAT });
  assert.equal(store.conflictJobsFor(pr.key).length, 1, 'same (PR, base, head) = same job');
  const ms = train.mergeState(t);
  assert.equal(ms.state, 'conflict'); assert.deepEqual(ms.files, ['shared.txt']); assert.equal(ms.resolver.seat, 'junior');
  // restart in the middle of a resolution
  store.updateConflictJob(jobs[0].id, { status: 'running', run_id: 999 });
  sched.recoverOrphans();
  assert.equal(store.getConflictJob(jobs[0].id).status, 'pending');
  const [job] = train.nextResolveJobs().filter((j) => j.key === pr.key);
  assert.equal(job.seat, 'junior');
  const { dir, clean } = await train.prepareResolve(job.job);
  assert.equal(clean, false);
  const pack = await train.conflictPack(job.job, t, dir);
  assert.match(pack, /Pinned commits: your PR head [0-9a-f]{40}/); assert.match(pack, /#391 Eastern session helpers/); assert.match(pack, /\+MAIN side/);
  assert.ok(pack.length < 16000, 'the pack stays compact');
  const r = run('junior', 'resolve', pr.key, null, { cwd: dir });
  store.updateConflictJob(job.job.id, { status: 'running', run_id: r.id });
  await assert.rejects(sched.deskAction(r, 'resolve', { action: 'done', body: 'kept both' }), /not committed yet/);
  write(dir, 'shared.txt', 'one\nMAIN side\nPR side\nthree\n'); g(dir, 'add', 'shared.txt'); g(dir, 'commit', '-q', '--no-edit');
  await sched.deskAction(r, 'resolve', { action: 'done', body: 'Kept the Eastern helper line and my line, in that order.' });
  t = store.getTicket(pr.key);
  assert.equal(t.status, 'qa'); assert.equal(t.reconfirm_kind, 'resolution'); assert.equal(t.reconfirm_from, pr.head_sha);
  assert.equal(store.getConflictJob(job.job.id).status, 'resolved');
  assert.equal(g(runner.workspaceDir(t.key), 'rev-parse', 'HEAD'), t.head_sha);
  assert.match(store.listOutbox(pr.key).at(-1).body, /Riley resolved the conflict\*\* with #391/);
  await reviews.afterQaPass(t, t.head_sha);
  const ctx = await reviews.reconfirmContext(store.getTicket(pr.key));
  assert.equal(ctx.kind, 'resolution'); assert.match(ctx.resolution, /shared.txt/);
});

test('resume is off by default and only chosen when estimated cheaper', () => {
  const prev = { session_id: 's', ended_at: new Date().toISOString(), usage_json: JSON.stringify({ input_tokens: 2000, cache_read_input_tokens: 40000 }) };
  assert.equal(train.shouldResume(prev, 'x'.repeat(8000)), false, 'never by default');
  assert.equal(train.shouldResume(prev, 'x'.repeat(8000), 'if-cheaper'), true);
  assert.equal(train.shouldResume({ ...prev, usage_json: JSON.stringify({ cache_read_input_tokens: 900000 }) }, 'x', 'if-cheaper'), false);
  assert.equal(train.shouldResume({ ...prev, ended_at: new Date(Date.now() - 3600_000).toISOString() }, 'x', 'if-cheaper'), false, 'cold cache');
});

test('after_key is sequencing, not stacking: a squash-merged parent is dropped with rebase --onto', async () => {
  const parent = await approvedPr('notes/parent.txt', 'parent\n');
  // the child slice was built on top of the parent's branch
  const child0 = store.createTicket({ title: 'Child slice', status: 'in_progress', assignee: 'junior', area: 'backend', complexity: 'S' });
  store.updateTicket(child0.key, { designer: 'principal-be', risk: 'low', builder: 'junior', after_key: parent.key });
  const ws = await runner.ensureWorkspace(store.getTicket(child0.key));
  g(ws.dir, 'fetch', '-q', origin, parent.branch); g(ws.dir, 'reset', '-q', '--hard', 'FETCH_HEAD');
  write(ws.dir, 'notes/child.txt', 'child\n'); g(ws.dir, 'add', '.'); g(ws.dir, 'commit', '-qm', 'child');
  g(ws.dir, 'push', '-q', origin, `HEAD:refs/heads/${ws.branch}`);
  const sha = g(ws.dir, 'rev-parse', 'HEAD');
  store.updateTicket(child0.key, { branch: ws.branch, head_sha: sha, status: 'qa', pr_url: 'https://github.com/owner/demo/pull/300' });
  await reviews.afterQaPass(store.getTicket(child0.key), sha);
  await approveBoth(child0.key);
  // the parent lands as ONE squashed commit (different SHA, same content), then the child is at the queue front
  landOnMain('notes/parent.txt', 'parent\n', `[${parent.key}] Parent (#299)`);
  store.updateTicket(parent.key, { status: 'done' });
  const snap = await train.watchBase();
  const u = await train.lazyUpdate(store.getTicket(child0.key), snap);
  assert.equal(u.action, 'updated');
  assert.equal(g(origin, 'rev-parse', `${u.head}^`), snap.base, 'only the child commit sits on top of main');
  assert.match(store.listOutbox(child0.key).at(-1).body, new RegExp(`dropping the commits of ${parent.key}`));
});

// ---------------- release-blocker fixes (independent review) ----------------
const lockNow = () => train.deployState();
const resetTrain = () => { train.clearDeployLock('test'); store.kvSet('train:intent', 'null'); setGh('runs.json', []); };

test('live gate right before dispatch: halt, Hold, risk, stop-all fence and a moved base all stop the merge', async () => {
  resetTrain();
  const t = await approvedPr('docs/gate.md');
  prFor(t);
  const before = merges().length;
  const snap = await train.watchBase();
  // stop-all between the checks and the dispatch: the fence (epoch) no longer matches
  let r = await train.consider(t, { now: SAT, snap, epoch: runner.currentEpoch() - 1 });
  assert.match(r.reason, /stopped \(circuit breaker\)/);
  assert.equal(store.getTicket(t.key).review_stage, 'approved', 'rolled back to the queue');
  // each live condition re-read by authorizeMerge
  const intent = { key: t.key, head: t.head_sha, by: 'desk', deploys: false, epoch: runner.currentEpoch(), at: 'x', base: snap.base };
  store.updateTicket(t.key, { review_stage: 'merging' });
  store.setSetting('paused', 'true');
  await assert.rejects(train.authorizeMerge(t.key, intent), /paused/);
  store.setSetting('paused', 'false');
  store.updateTicket(t.key, { merge_hold: 'owner said wait' });
  await assert.rejects(train.authorizeMerge(t.key, intent), /on hold/);
  store.updateTicket(t.key, { merge_hold: null, risk: 'high' });
  await assert.rejects(train.authorizeMerge(t.key, intent), /high-risk/);
  store.updateTicket(t.key, { risk: 'low' });
  await assert.rejects(train.authorizeMerge(t.key, { ...intent, deploys: true }, WED_11_ET), /deploy lock is not held|busy window/);
  await train.authorizeMerge(t.key, intent); // all clear
  landOnMain('notes/moved.txt', 'm\n', 'base moves after the CI was read');
  await assert.rejects(train.authorizeMerge(t.key, intent), /moved since its CI was read/);
  store.updateTicket(t.key, { review_stage: 'approved' });
  // without a fresh base snapshot the train fails closed
  r = await train.consider(store.getTicket(t.key), { now: SAT, snap: null });
  assert.match(r.reason, /no fresh view of main/);
  assert.equal(merges().length, before, 'nothing was merged');
});

test('merge intent + deploy lock are persisted before merging and reconciled after a crash', async () => {
  resetTrain();
  const t = await approvedPr('app/intent.py');
  // crash after GitHub merged but before the desk recorded it
  store.kvSet('train:intent', JSON.stringify({ key: t.key, pr: 7, head: t.head_sha, deploys: true, by: 'desk', at: 'a1', workflows: ['Deploy'] }));
  store.kvSet('train:deploy', JSON.stringify({ key: t.key, state: 'merging', intent_at: 'a1', workflows: ['Deploy'] }));
  setGh('merge.json', { state: 'MERGED', mergeCommit: { oid: '1'.repeat(40) } });
  assert.deepEqual(await train.reconcileIntent(), { reconciled: 'merged' });
  assert.equal(lockNow().state, 'running'); assert.equal(lockNow().merge_sha, '1'.repeat(40));
  assert.equal(store.kvGet('train:intent'), 'null');
  // crash before GitHub merged: rolled back, lock released
  resetTrain();
  store.kvSet('train:intent', JSON.stringify({ key: t.key, pr: 7, head: t.head_sha, deploys: true, by: 'desk', at: 'a2', workflows: ['Deploy'] }));
  store.kvSet('train:deploy', JSON.stringify({ key: t.key, state: 'merging', intent_at: 'a2', workflows: ['Deploy'] }));
  setGh('merge.json', { state: 'OPEN', mergeCommit: null });
  assert.deepEqual(await train.reconcileIntent(), { reconciled: 'rolled_back' });
  assert.equal(lockNow(), null);
  // a desk merge takes the lock BEFORE dispatching (seen by the fake gh at merge time)
  prFor(t); setGh('merge.json', { state: 'MERGED', mergeCommit: { oid: '2'.repeat(40) } });
  const r = await train.consider(store.getTicket(t.key), { now: SAT, snap: await train.watchBase() });
  assert.equal(r.action, 'merged', JSON.stringify(r));
  assert.equal(lockNow().merge_sha, '2'.repeat(40));
});

test('deploy lock: every expected workflow must succeed; missing or failed stays locked and escalates', async () => {
  resetTrain();
  const at = new Date(SAT.getTime() - 10 * 60_000).toISOString();
  store.kvSet('train:deploy', JSON.stringify({ key: null, merge_sha: '3'.repeat(40), at, workflows: ['Deploy', 'Publish UI'], state: 'running' }));
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'success', databaseId: 1 }]);
  assert.ok(await train.deployLock(SAT), 'one of two expected deploys is not enough');
  setGh('runs.json', []);
  assert.ok(await train.deployLock(SAT), 'no runs at all is not a release');
  store.kvSet('train:deploy', JSON.stringify({ key: null, merge_sha: '3'.repeat(40), at: new Date(SAT.getTime() - 60 * 60_000).toISOString(), workflows: ['Deploy', 'Publish UI'], state: 'running' }));
  assert.equal((await train.deployLock(SAT)).state, 'escalated');
  assert.match(lockNow().note, /Deploy never started|Publish UI never started/);
  resetTrain();
  store.kvSet('train:deploy', JSON.stringify({ key: null, merge_sha: '3'.repeat(40), at, workflows: ['Deploy', 'Publish UI'], state: 'running' }));
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'success', databaseId: 1 }, { workflowName: 'Publish UI', status: 'completed', conclusion: 'skipped', databaseId: 2 }]);
  assert.equal((await train.deployLock(SAT)).state, 'failed', 'skipped is not a successful deploy');
  resetTrain();
  store.kvSet('train:deploy', JSON.stringify({ key: null, merge_sha: '3'.repeat(40), at, workflows: ['Deploy', 'Publish UI'], state: 'running' }));
  setGh('runs.json', [{ workflowName: 'Deploy', status: 'completed', conclusion: 'success', databaseId: 1 }, { workflowName: 'Publish UI', status: 'completed', conclusion: 'success', databaseId: 2 }]);
  assert.equal(await train.deployLock(SAT), null);
});

test('owner merges of deploying changes and external deploying commits on main take the deploy lock', async () => {
  resetTrain();
  const t = await approvedPr('app/owner.py', 'x\n', { risk: 'high' });
  prFor(t, { number: 7 }); setGh('merge.json', { state: 'MERGED', mergeCommit: { oid: '4'.repeat(40) } });
  store.updateTicket(t.key, { pr_url: 'https://github.com/owner/demo/pull/7' });
  await train.ownerMerge(7, { expectedSha: t.head_sha, method: 'squash' });
  assert.equal(lockNow().by, 'owner'); assert.equal(lockNow().merge_sha, '4'.repeat(40));
  await assert.rejects(train.ownerMerge(7, { expectedSha: t.head_sha }), /deploy of .* still running/, 'a second deploying merge waits');
  resetTrain();
  await train.sweep({ now: SAT }); // remember the current base
  landOnMain('app/hotfix.py', 'h\n', 'hotfix merged on GitHub by hand');
  store.setSetting('paused', 'true'); // nothing in the queue should move; only the watcher runs
  await train.sweep({ now: SAT });
  store.setSetting('paused', 'false');
  assert.equal(lockNow().by, 'external');
  assert.deepEqual(lockNow().workflows, ['Deploy']);
  resetTrain();
});

test('a force-push journaled before a crash is recognized as the desk\'s own update, not a foreign push', async () => {
  resetTrain();
  const t = await approvedPr('notes/journal.txt');
  landOnMain('notes/other.txt', 'o\n', 'unrelated (#392)');
  const snap = await train.watchBase();
  // what lazyUpdate would have produced and pushed before the desk died
  const w = path.join(tmp, `j-${seq}`); execFileSync('git', ['clone', '-q', '-b', t.branch, origin, w]);
  g(w, 'fetch', '-q', origin, 'main'); g(w, 'rebase', '-q', 'FETCH_HEAD'); const newHead = g(w, 'rev-parse', 'HEAD');
  g(w, 'push', '-q', '-f', 'origin', `HEAD:${t.branch}`);
  await runner.fetchIntoPublisher(t.key, w, newHead);
  store.kvSet(`train:push:${t.key}`, JSON.stringify({ old: t.head_sha, new: newHead, base: snap.base, how: 'rebased onto `main`', incoming: '#392', at: 'x' }));
  const snap2 = await train.watchBase();
  const u = await train.lazyUpdate(store.getTicket(t.key), snap2);
  assert.equal(u.action, 'updated');
  assert.equal(store.getTicket(t.key).head_sha, newHead); assert.equal(store.getTicket(t.key).merge_hold, null);
  assert.equal(store.kvGet(`train:push:${t.key}`), 'null');
});

test('approved PRs whose GitHub branch holds an older commit are re-published', async () => {
  const t = await approvedPr('docs/republish.md');
  store.kvSet(`published:${t.key}`, '0'.repeat(40));
  store.setSetting('open_draft_prs', 'true');
  sched.retryPublications();
  for (let i = 0; i < 50 && store.kvGet(`published:${t.key}`) !== t.head_sha; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.kvGet(`published:${t.key}`), t.head_sha);
});

test('resolve jobs only run on engines that enforce the spend cap', async () => {
  const team = await import('../src/team.js');
  assert.equal(runner.capsSpend({ ...team.agentById.junior, engine: 'claude' }), true);
  assert.equal(runner.capsSpend({ ...team.agentById.junior, engine: 'codex' }), false);
  const t = { builder: 'junior', assignee: 'junior', area: 'backend', complexity: 'S' };
  assert.equal(train.resolverFor(t), 'junior');
  team.applyTeamOverrides({ junior: { engine: 'codex' } });
  assert.notEqual(train.resolverFor(t), 'junior', 'a builder on an uncapped engine is skipped');
  team.applyTeamOverrides({ junior: { engine: 'codex' }, 'senior-be': { engine: 'codex' }, 'senior-fe': { engine: 'codex' }, dba: { engine: 'codex' } });
  assert.equal(train.resolverFor(t), null);
  team.applyTeamOverrides({});
  const args = runner.buildCommand({ ...team.agentById.junior, model: 'opus' }, 'resolve', '/tmp/x').args;
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '1.5');
});
