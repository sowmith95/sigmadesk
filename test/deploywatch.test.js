// Post-deploy watch (sowmith95/sigmadesk#7). Stubs only: a fake gh (workflow runs), a fake docker, a fake psql and a
// local HTTP server for the app's /health. Nothing reaches GitHub, a container, a database or a real service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-pdw-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'ignore' });

// ---- fakes ----
const ghDir = path.join(tmp, 'gh'); fs.mkdirSync(ghDir);
const fakeGh = path.join(tmp, 'gh.mjs');
fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2); const d = ${JSON.stringify(ghDir)};
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(d + '/' + f, 'utf8')); } catch { return def; } };
const out = (x) => { process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x)); process.exit(0); };
if (a[0] === 'api' && /actions\\/runs\\?branch=/.test(a[1])) out(read('branch-runs.json', []));
if (a[0] === 'api' && /actions\\/runs/.test(a[1])) { const sha = (a[1].match(/head_sha=([0-9a-f]+)/) || [])[1]; out(read('runs-' + sha + '.json', [])); }
if (a[0] === 'api' && a[1] === '-X') out('1');
if (a[0] === 'api') out('');
out('[]');
`, { mode: 0o755 });
const dockerCtl = path.join(tmp, 'docker.json');
const fakeDocker = path.join(tmp, 'docker');
fs.writeFileSync(fakeDocker, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const c = (() => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(dockerCtl)}, 'utf8')); } catch { return {}; } })();
if (a[0] === 'ps') console.log(c.ps ?? 'alpaca-trader\\trunning\\tUp 1 minute\\t1 minute ago');
else if (a[0] === 'inspect') console.log(c.inspect ?? '/alpaca-trader\\thealthy\\t0\\t2026-10-03T15:01:00Z\\tfalse\\tghcr.io/o/alpaca:main@sha256:abc');
else if (a[0] === 'stats') console.log('alpaca-trader\\t3%\\t512MiB / 2GiB\\t25%');
else if (a[0] === 'logs') console.log(c.logs ?? '2026-10-03T15:02:00Z INFO started');
`);
fs.chmodSync(fakeDocker, 0o755);
const psqlCtl = path.join(tmp, 'psql.json');
const fakePsql = path.join(tmp, 'psql');
fs.writeFileSync(fakePsql, `#!/usr/bin/env node
const fs = require('fs');
const c = (() => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(psqlCtl)}, 'utf8')); } catch { return {}; } })();
process.stdin.on('data', () => {}); process.stdin.on('end', () => { process.stdout.write(c.out || 'source\\tlatest\\tlag_s\\nbars\\t2026-10-03 15:00:00+00\\t4\\n'); process.exit(0); });
`);
fs.chmodSync(fakePsql, 0o755);

const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'D' },
  bins: { gh: fakeGh }, github: { sync: true }, pm: { enabled: false },
  deploy: { workflows: ['deploy.yml'], targets: { 'deploy.yml': 'alpaca-trader' } },
  ops: { enabled: true, psql: fakePsql, docker: fakeDocker, databases: { timescale: { host: '127.0.0.1', port: 5433, dbname: 'ts', user: 'ro' } },
    freshness: [{ label: 'bars', db: 'timescale' }], containers: ['alpaca-trader'],
    normal: { statementMs: 15000, lockMs: 1000, idleMs: 10000, perRun: 12, perHour: 100000, maxLogHours: 6, maxFreshnessMinutes: 1440, maxTail: 400 } },
}));
process.env.SIGMADESK_CONFIG = cfgFile;
process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');

let config, store, ops, access, sched, train, dw, cal, reviews, attention, departments;
let appSrv; const app = { status: 200, body: '{"status":"ok"}' };
before(async () => {
  ({ config } = await import('../src/config.js'));
  config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  ops = await import('../src/ops.js');
  access = await import('../src/access.js');
  sched = await import('../src/scheduler.js');
  train = await import('../src/mergetrain.js');
  dw = await import('../src/deploywatch.js');
  cal = await import('../src/exchange-calendar.js');
  reviews = await import('../src/reviews.js');
  attention = await import('../public/attention.js');
  departments = await import('../public/departments.js');
  appSrv = http.createServer((req, res) => { res.writeHead(app.status, { 'Content-Type': 'application/json' }); res.end(app.body); });
  await new Promise((r) => appSrv.listen(0, '127.0.0.1', r));
  config.ops.appHealth.baseUrl = `http://127.0.0.1:${appSrv.address().port}`;
  ops.setNow(() => new Date('2026-10-03T15:00:00Z')); // a Saturday: normal (not market-hours) probe limits
  store.setSetting('ops_enabled', 'true');
  store.setSetting('github_sync', 'true');
});
after(() => { appSrv?.close(); ops.setNow(null); fs.rmSync(tmp, { recursive: true, force: true }); });

const setGh = (file, v) => fs.writeFileSync(path.join(ghDir, file), JSON.stringify(v));
const docker = (v = {}) => fs.writeFileSync(dockerCtl, JSON.stringify(v));
let seq = 0;
const sha = () => (++seq).toString(16).padStart(40, 'a');
const T0 = new Date('2026-10-03T15:00:00Z'); // Saturday 11:00 New York
const at = (min) => new Date(T0.getTime() + min * 60_000);
const run = (sid, attempt = 1, sh, extra = {}) => ({ path: '.github/workflows/deploy.yml', name: 'Deploy', status: 'completed', conclusion: 'success', id: sid, run_attempt: attempt,
  run_started_at: at(1).toISOString(), updated_at: at(3).toISOString(), event: 'push', head_sha: sh, ...extra });
const lockFor = (key, mergeSha, by = 'desk') => store.kvSet('train:deploy', JSON.stringify({ id: `L${++seq}`, key, pr: 7, head: 'h', at: T0.toISOString(), state: 'running', merge_sha: mergeSha, workflows: ['.github/workflows/deploy.yml'], by }));
const doneTicket = (extra = {}) => { const t = store.createTicket({ title: `Change ${++seq}`, status: 'done', area: 'backend', complexity: 'S', assignee: 'junior' }); store.updateTicket(t.key, { builder: 'junior', risk: 'low', diff_risk: 'low', ...extra }); return store.getTicket(t.key); };
const reset = () => {
  store.kvSet('train:deploy', 'null'); store.kvSet('train:deploy-pending', '[]');
  for (const w of store.recentWatches(1000)) store.updateWatch(w.id, { status: 'superseded', hold: 0 });
  for (const s of ['pending', 'needs_sre', 'sre_running', 'running']) for (const c of store.checkpointsByStatus(s)) store.updateCheckpoint(c.id, { status: 'superseded' });
  docker(); app.status = 200; app.body = '{"status":"ok"}'; fs.writeFileSync(psqlCtl, '{}'); setGh('branch-runs.json', []);
  store.kvSet('deploywatch:reconciled', '');
};
/** A deploy of a fresh merge commit that finished OK, released by the lock → its watch. */
async function deployed(t, { attempt = 1 } = {}) {
  const m = sha(); const rid = 1000 + seq;
  lockFor(t?.key || null, m);
  dw.clock.now = () => at(0);
  await dw.captureBaseline({ mergeSha: m });
  setGh(`runs-${m}.json`, [run(rid, attempt, m)]);
  await train.deployLock(at(4));
  return { m, rid, w: store.watchByKey(store.deploysForSha(m)[0].deploy_key) };
}

test('exchange calendar: holidays, early closes, DST and an owner override pick the next session open', () => {
  const c = cal.calendar();
  // Independence Day observed Fri 3 Jul 2026: Thursday evening → Monday 6 Jul 09:30 EDT.
  assert.equal(cal.nextSessionOpen(new Date('2026-07-02T21:00:00Z'), c).open.toISOString(), '2026-07-06T13:30:00.000Z');
  // Thanksgiving Thu 26 Nov 2026 → Fri 27 Nov opens 09:30 EST and closes early at 13:00.
  const fri = cal.nextSessionOpen(new Date('2026-11-25T22:00:00Z'), c);
  assert.equal(fri.open.toISOString(), '2026-11-27T14:30:00.000Z');
  assert.equal(fri.close.toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(fri.early, true);
  assert.equal(cal.isSessionOpen(new Date('2026-11-27T18:30:00Z'), c), false, 'after the 13:00 early close');
  assert.equal(cal.isSessionOpen(new Date('2026-11-27T17:30:00Z'), c), true);
  // DST starts Sun 8 Mar 2026: Monday opens at 13:30 UTC (the Friday before opened at 14:30 UTC).
  assert.equal(cal.nextSessionOpen(new Date('2026-03-07T12:00:00Z'), c).open.toISOString(), '2026-03-09T13:30:00.000Z');
  assert.equal(cal.nextSessionOpen(new Date('2026-03-05T22:00:00Z'), c).open.toISOString(), '2026-03-06T14:30:00.000Z');
  // Christmas observed Fri 24 Dec 2027 → Monday 27 Dec.
  assert.equal(cal.nextSessionOpen(new Date('2027-12-23T22:00:00Z'), c).open.toISOString(), '2027-12-27T14:30:00.000Z');
  assert.equal(cal.nextSessionOpen(new Date('2028-03-01T12:00:00Z'), c).known, false, 'a year beyond the table says so');
  // Override: an extra closure the owner configured (e.g. a market emergency closure).
  const o = cal.calendar({ holidays: ['2026-10-12'] });
  assert.equal(cal.nextSessionOpen(new Date('2026-10-09T21:00:00Z'), o).date, '2026-10-13');
  assert.equal(cal.nextSessionOpen(new Date('2026-10-09T21:00:00Z'), c).date, '2026-10-12');
});

test('app health: HTTP 5xx is an unhealthy application, not a successful check; cached answers are not fresh evidence', async () => {
  store.setSetting('ops_enabled', 'true');
  app.status = 503; app.body = '{"status":"degraded"}';
  const d = await ops.deskProbe('app_health');
  assert.equal(d.outcome, 'ok', 'the probe itself ran');
  assert.equal(d.health, 'unhealthy');
  assert.equal(d.fresh, true);
  assert.match(d.text, /UNHEALTHY/);
  // A verify run whose only evidence is the 5xx answer cannot say "verified".
  const t = store.createTicket({ title: 'Check prod health', status: 'in_progress', assignee: 'sre' });
  access.ownerGrant({ seat: 'sre', probes: ['*'], minutes: 60, reason: 'test' });
  const vr = store.createRun({ agent_id: 'sre', kind: 'verify', ticket_key: t.key, token: `v${++seq}`, model: 'x' });
  ops.clearCache();
  assert.match(await ops.handle(vr, { probe: 'app_health' }), /health="unhealthy"/);
  await assert.rejects(sched.deskAction(vr, 'verify', { action: 'done', body: 'fine' }), /UNHEALTHY/);
  // A healthy answer served from another run's cache is not this run's evidence.
  app.status = 200;
  const a = store.createRun({ agent_id: 'sre', kind: 'verify', ticket_key: t.key, token: `a${++seq}`, model: 'x' });
  ops.clearCache();
  await ops.handle(a, { probe: 'app_health' });
  const b = store.createRun({ agent_id: 'sre', kind: 'verify', ticket_key: t.key, token: `b${++seq}`, model: 'x' });
  assert.match(await ops.handle(b, { probe: 'app_health' }), /cached="true"/);
  assert.equal(store.opsSucceededInRun(a.id), 1);
  assert.equal(store.opsSucceededInRun(b.id), 0, 'a cache hit is not fresh evidence');
  for (const g of store.openGrants()) store.endGrant(g.id, 'owner', 'reset');
});

test('deploy history + watch are written with the lock release; a crash in between leaves the lock, not half a record', async () => {
  reset();
  const t = doneTicket();
  const m = sha();
  lockFor(t.key, m);
  setGh(`runs-${m}.json`, [run(77, 1, m)]);
  dw.hooks.beforeWatch = () => { throw new Error('simulated crash'); };
  await assert.rejects(train.deployLock(at(4)), /simulated crash/);
  assert.equal(JSON.parse(store.kvGet('train:deploy')).state, 'running', 'the lock is still held');
  assert.equal(store.deploysForSha(m).length, 0, 'no history row without its release');
  assert.equal(store.watchesForTicket(t.key).length, 0);
  dw.hooks.beforeWatch = null;
  assert.equal(await train.deployLock(at(5)), null, 'the next refresh releases it');
  const rows = store.deploysForSha(m);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].run_id, rows[0].run_attempt, rows[0].target, rows[0].source], ['success', 77, 1, 'alpaca-trader', 'desk']);
  const [w] = store.watchesForTicket(t.key);
  assert.equal(w.status, 'watching');
  assert.deepEqual(store.checkpointsOf(w.id).map((c) => c.name), ['smoke', 'settle', 'session_open']);
  const due = Object.fromEntries(store.checkpointsOf(w.id).map((c) => [c.name, c.due_at]));
  assert.equal(due.smoke, at(8).toISOString(), 'T+5 after the run completed (T+3)');
  assert.equal(due.settle, at(33).toISOString());
  assert.equal(due.session_open, '2026-10-05T13:35:00.000Z', 'Monday 09:35 New York');
  assert.ok(store.listComments(t.key).some((c) => /Deployed/.test(c.body) && /limited/.test(c.body)), 'the ticket says it is watched, and that its checks are limited');
  // Idempotent: the same deploy is never recorded twice.
  dw.recordLockOutcome({ id: rows[0].deploy_key.slice('lock:'.length), key: t.key, merge_sha: m, workflows: ['.github/workflows/deploy.yml'] }, 'success', [{ file: '.github/workflows/deploy.yml', run: run(77, 1, m) }]);
  assert.equal(store.deploysForSha(m).length, 1);
  assert.equal(store.watchesForTicket(t.key).length, 1);
});

test('failed and unconfirmed deploys: history says failed/unknown, the owner clearing the hold never makes them deployed', async () => {
  reset();
  const t = doneTicket();
  const m = sha();
  lockFor(t.key, m);
  setGh(`runs-${m}.json`, [run(88, 1, m, { conclusion: 'failure' })]);
  assert.equal((await train.deployLock(at(4))).state, 'failed');
  assert.equal(store.deploysForSha(m)[0].status, 'failed');
  train.ownerClearDeploy({ merge_sha: m });
  const r = store.deploysForSha(m)[0];
  assert.deepEqual([r.status, r.cleared_by], ['failed', 'owner']);
  assert.equal(store.watchesForTicket(t.key).length, 0, 'no watch for a deploy that failed');
  // Escalated (never confirmed), then cleared: unknown, cleared by the owner.
  const m2 = sha();
  lockFor(t.key, m2);
  setGh(`runs-${m2}.json`, []);
  assert.equal((await train.deployLock(new Date(T0.getTime() + 60 * 60_000))).state, 'escalated');
  train.ownerClearDeploy({ merge_sha: m2 });
  const r2 = store.deploysForSha(m2)[0];
  assert.deepEqual([r2.status, r2.run_id, r2.cleared_by], ['unknown', 0, 'owner']);
  assert.equal(dw.summary(at(70)).kpis.deployed, dw.summary(at(70)).kpis.deployed, 'stable');
});

test('reconciliation: a re-run attempt and a manual dispatch are new deployments; production advancing supersedes watches', async () => {
  reset();
  const t = doneTicket();
  const { m, rid, w } = await deployed(t);
  assert.equal(w.status, 'watching');
  // The same run re-run (attempt 2) and a manual dispatch of a newer commit, both missed by the lock.
  const m2 = sha();
  setGh('branch-runs.json', [run(rid, 1, m), run(rid, 2, m, { updated_at: at(20).toISOString(), run_started_at: at(15).toISOString() }),
    run(5555, 1, m2, { event: 'workflow_dispatch', updated_at: at(40).toISOString(), run_started_at: at(35).toISOString() }),
    run(6666, 1, m2, { path: '.github/workflows/ci.yml' })]);
  const out = await dw.reconcile({ now: at(41), force: true });
  assert.deepEqual(out.recorded.map((x) => [x.run, x.attempt]), [[rid, 2], [5555, 1]], 'known runs and non-deploying workflows are skipped');
  const rerun = store.deployRun(rid, 2);
  assert.deepEqual([rerun.source, rerun.ticket_key, rerun.status], ['external', t.key, 'success'], 'a re-run of a desk merge stays on its ticket');
  assert.equal(store.getWatch(w.id).status, 'superseded');
  assert.ok(store.checkpointsOf(w.id).every((c) => c.status === 'superseded'), 'its remaining checkpoints stop');
  const w2 = store.watchByKey(`run:${rid}:2`);
  assert.equal(store.getWatch(w2.id).status, 'superseded', 'the manual deploy of a newer commit advanced production again');
  const w3 = store.watchByKey('run:5555:1');
  assert.equal(w3.status, 'watching');
  assert.equal(w3.source, 'external');
  // A second pass records nothing new; a superseded checkpoint is never run.
  assert.deepEqual((await dw.reconcile({ now: at(42), force: true })).recorded, []);
  const due = store.dueCheckpoints(at(500).toISOString()).map((c) => c.watch_id);
  assert.ok(!due.includes(w.id) && !due.includes(w2.id));
  // KPIs count distinct deployments (deploy keys), over one window.
  const k = dw.summary(at(45)).kpis;
  assert.ok(k.deployed >= 3 && k.superseded >= 2 && k.watching >= 1);
});

test('a healthy deploy: the desk verifies every checkpoint itself (fresh, structured evidence), limited without criteria', async () => {
  reset();
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = JSON.stringify({ status: 'ok', git_sha: m.slice(0, 12) });
  for (const [min, name] of [[9, 'smoke'], [34, 'settle']]) {
    dw.clock.now = () => at(min);
    const r = await dw.sweep({ now: at(min) });
    assert.equal(r.checkpoints.find((x) => x.id)?.verdict, 'verified', name);
  }
  const smoke = store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  const ev = JSON.parse(smoke.evidence);
  assert.equal(ev.fresh, true);
  assert.equal(ev.identity.app_sha, m.slice(0, 12));
  assert.match(ev.identity.images['alpaca-trader'], /sha256:abc/);
  const health = ev.items.find((i) => i.probe === 'app_health');
  assert.deepEqual([health.result, health.threshold, health.observed], ['pass', 'HTTP 2xx (5xx = unhealthy)', 'HTTP 200']);
  assert.ok(ev.items.every((i) => i.observed_at && i.criterion && 'threshold' in i), 'every item has its observation time, criterion and threshold');
  assert.ok(ev.items.some((i) => i.criterion === 'ingest bars is fresh' && i.result === 'pass'));
  assert.equal(smoke.limited, 1, 'no ticket criteria: limited');
  assert.equal(store.getWatch(w.id).status, 'watching', 'the session-open check is still to come');
  const open = new Date('2026-10-05T13:36:00Z');
  dw.clock.now = () => open;
  await dw.sweep({ now: open });
  assert.equal(store.getWatch(w.id).status, 'verified');
  assert.ok(store.listComments(t.key).some((c) => /verified\*\* \(limited\)/.test(c.body)));
  assert.ok(store.listOutbox(t.key).some((o) => /Production T\+5 min smoke check: verified/.test(o.body)), 'posted to the PR through the outbox');
  assert.equal(dw.ticketView(t.key).watches[0].status, 'verified');
});

test('5xx after a deploy: confirmed once, then regression → page, hold, P0 incident, owner-only revert; owner clears', async () => {
  reset();
  const t = doneTicket({ risk: 'high', diff_risk: 'high', prod_verify: 'orders route answers 200' });
  store.kvSet(`diff-files:${t.key}`, JSON.stringify(['app/oms/orders.py', 'migrations/0042_fills.sql', 'app/ui/border.css']));
  const { m, w } = await deployed(t);
  app.status = 502;
  dw.clock.now = () => at(9);
  assert.equal((await dw.sweep({ now: at(9) })).checkpoints[0].status, 'retry', 'one confirming look before paging');
  assert.equal(store.getWatch(w.id).hold, 0);
  dw.clock.now = () => at(12);
  const r = await dw.sweep({ now: at(12) });
  assert.equal(r.checkpoints[0].verdict, 'regression');
  const held = store.getWatch(w.id);
  assert.deepEqual([held.status, held.hold], ['regression', 1]);
  assert.equal(dw.regressionHold().id, w.id);
  const inc = store.getTicket(held.incident_key);
  assert.deepEqual([inc.type, inc.priority, inc.status], ['bug', 'P0', 'proposed'], 'trading path → P0');
  const rev = store.getTicket(held.revert_key);
  assert.equal(rev.owner_merge_only, 1);
  assert.equal(rev.assignee, 'junior', 'the builder who made it prepares the revert');
  assert.match(rev.description, /git revert/);
  assert.match(rev.description, /0042_fills\.sql/, 'migrations a revert cannot undo are flagged');
  assert.match(rev.description, /oms\/orders\.py/, 'broker/order code is flagged');
  assert.doesNotMatch(rev.description, /border\.css/);
  assert.equal(reviews.autoMergePolicy({ ...rev, risk: 'low', diff_risk: 'low' }).eligible, false, 'a revert is never merged by the train');
  assert.match(train.mergeState({ ...rev, status: 'ready_for_human', review_stage: 'approved', pr_url: 'x' }).reason, /only the owner merges reverts/);
  assert.ok(store.checkpointsOf(w.id).filter((c) => c.name !== 'smoke').every((c) => c.status === 'superseded'), 'the owner decides from here');
  assert.ok(store.listComments(t.key).some((c) => /Regression suspected/.test(c.body) && /migrations/.test(c.body)));
  // The merge train holds deploying merges: the live gate refuses a desk merge that redeploys.
  const k = store.createTicket({ title: 'next', status: 'ready_for_human' }).key;
  store.updateTicket(k, { head_sha: 'f'.repeat(40), review_stage: 'merging' });
  store.kvSet('train:intent', JSON.stringify({ key: k, at: 'i1', head: 'f'.repeat(40), deploys: true, by: 'desk', reservation: store.reserve(k, 'desk-merge').token, epoch: (await import('../src/runner.js')).currentEpoch() }));
  await assert.rejects(train.authorizeMerge(k, JSON.parse(store.kvGet('train:intent'))), /suspected regression/);
  store.kvSet('train:intent', 'null');
  // The owner page: an Inbox item of kind regression (protected, first), on the reliability wall.
  const snap = { tickets: store.listTickets(), agents: [], meta: { production: dw.summary(at(13)) }, incidents: [] };
  const B = attention.board(snap);
  const page = B.needs_you.find((x) => x.kind === 'regression');
  assert.ok(page && page.protected, 'regressions page the owner and cannot be snoozed');
  assert.equal(B.do_first, page.id);
  const deps = departments.departmentsFor([{ id: 'sre' }, { id: 'qa' }]);
  assert.equal(departments.departmentOf(page, deps), 'reliability');
  assert.equal(departments.exceptions({ board: B })[0].type, 'regression');
  // The owner clears it: deploying merges continue, the verdict stays.
  dw.clearRegressionHold(w.id, { note: 'rolled back by hand' });
  assert.deepEqual([store.getWatch(w.id).hold, store.getWatch(w.id).status, store.getWatch(w.id).cleared_by], [0, 'regression', 'owner']);
  assert.equal(dw.regressionHold(), null);
  assert.throws(() => dw.clearRegressionHold(w.id), /no longer active/);
  assert.equal(m.length, 40);
});

test('revert commands follow the merge commit\'s parents', () => {
  assert.equal(dw.revertCommand('abc', ['p1', 'p2']).command, 'git revert -m 1 abc');
  assert.equal(dw.revertCommand('abc', ['p1']).command, 'git revert abc');
  assert.match(dw.revertCommand('abc', null).command, /if it is a merge commit with two parents: git revert -m 1 abc/);
  assert.deepEqual(dw.flaggedFiles(['db/migrations/1.py', 'x/border.js', 'src/broker/client.py']), { migrations: ['db/migrations/1.py'], broker: ['src/broker/client.py'] });
});

test('anomalies wake the SRE in a capped run: grants only with the owner\'s opt-in, re-checked and revoked; never publishes', async () => {
  reset();
  const t = doneTicket({ prod_verify: 'the fills panel shows today\'s fills' });
  const { w } = await deployed(t);
  // The container restarted once since the deploy: an anomaly, not a hard failure.
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg@sha256:abc' });
  dw.clock.now = () => at(9);
  assert.equal((await dw.sweep({ now: at(9) })).checkpoints[0].status, 'needs_sre');
  const [job] = dw.nextJobs();
  assert.equal(job.seat, 'sre');
  const cp = dw.claimJob(job.checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `w${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  // Policy off (default): no automatic grant.
  assert.equal(access.policy().postDeployAutoGrant, false);
  assert.equal(dw.jobStarted(cp, r), null);
  assert.match(ops.denial(r, 'app_health') || '', /no production read access grant/);
  // The owner opts in: a run-bound grant to exactly the checkpoint's probes.
  access.setPolicy({ ...access.validatePolicy(access.policy()), postDeployAutoGrant: true });
  const g = dw.jobStarted(store.getCheckpoint(cp.id), r);
  assert.deepEqual(JSON.parse(g.probes), ['app_health', 'container_status', 'container_logs', 'ingest_freshness']);
  assert.deepEqual([g.run_id, g.watch_checkpoint, g.granted_by], [r.id, cp.id, 'post_deploy']);
  assert.ok(Date.parse(g.expires_at) - Date.now() <= 15 * 60_000 + 1000);
  assert.equal(ops.denial(r, 'app_health'), null);
  assert.ok(ops.denial(r, 'db_health'), 'only the exact probes');
  const other = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `o${++seq}`, model: 'x' });
  assert.ok(ops.denial(other, 'app_health'), 'bound to that run');
  // A watch run never publishes, comments or changes tickets.
  await assert.rejects(sched.deskAction(r, 'submit', {}), /post-deploy check reads production/);
  await assert.rejects(sched.deskAction(r, 'comment', { body: 'x' }), /post-deploy check reads production/);
  // "verified" on ticket criteria needs a fresh probe in this run.
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'fine' }), /fresh probe/);
  // The owner tightens the policy: the very next probe is refused and the grant ends.
  access.setPolicy({ ...access.validatePolicy(access.policy()), postDeployAutoGrant: false });
  assert.match(ops.denial(r, 'app_health') || '', /no production read access grant/);
  assert.equal(store.getGrant(g.id).revoked_by, 'policy changed');
  // The SRE's verdict decides the checkpoint.
  assert.match(await sched.deskAction(r, 'watch', { action: 'inconclusive', body: 'one restart at 15:05; logs clean; cannot tell yet' }), /Recorded/);
  const done = store.getCheckpoint(cp.id);
  assert.deepEqual([done.status, done.verdict], ['done', 'inconclusive']);
  assert.equal(JSON.parse(done.evidence).sre.verdict, 'inconclusive');
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'regression', body: 'x' }), /not checking a post-deploy checkpoint/);
  await assert.rejects(sched.deskAction(store.createRun({ agent_id: 'sre', kind: 'investigate', ticket_key: t.key, token: `x${++seq}`, model: 'x' }), 'watch', { action: 'verified', body: 'x' }), /only works inside a post-deploy check/);
});

test('a superseded deployment ends its checkpoint grant; exhausted budgets and silent runs end inconclusive', async () => {
  reset();
  access.setPolicy({ ...access.validatePolicy(access.policy()), postDeployAutoGrant: true });
  const t = doneTicket();
  const { w } = await deployed(t);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `s${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  const g = dw.jobStarted(cp, r);
  assert.equal(ops.denial(r, 'container_status'), null);
  docker();
  await deployed(t); // production advances
  assert.equal(store.getWatch(w.id).status, 'superseded');
  assert.ok(ops.denial(r, 'container_status'));
  access.sweep();
  assert.ok(store.getGrant(g.id).revoked_at, 'the grant ended with its deployment');
  assert.match(store.getGrant(g.id).revoked_by, /deployment no longer watched|run ended/);
  access.setPolicy({ ...access.validatePolicy(access.policy()), postDeployAutoGrant: false });
  // Budget: what is left of the checkpoint's allowance across attempts (plan-billed engine: time and steps).
  reset();
  const t2 = doneTicket();
  const { w: w2 } = await deployed(t2);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const c2 = store.checkpointsOf(w2.id).find((c) => c.name === 'smoke');
  store.updateCheckpoint(c2.id, { spent_ms: 11 * 60_000 });
  const a = dw.admit(store.getCheckpoint(c2.id), { id: 'sre', engine: 'codex', model: 'gpt' });
  assert.equal(a.exhausted, true);
  assert.match(a.refuse, /this checkpoint's whole allowance/);
  const ok = dw.admit({ ...store.getCheckpoint(c2.id), spent_ms: 60_000 }, { id: 'sre', engine: 'codex', model: 'gpt' });
  assert.equal(ok.limits.minutes, 9);
  dw.claimJob(store.getCheckpoint(c2.id));
  await dw.jobEnded(c2.id, { refused: a.refuse, exhausted: true });
  assert.deepEqual([store.getCheckpoint(c2.id).verdict, store.getCheckpoint(c2.id).status], ['inconclusive', 'done']);
  assert.match(store.getCheckpoint(c2.id).summary, /allowance/);
  // A run that ends without a verdict is asked again (bounded), then inconclusive.
  const c3 = store.checkpointsOf(w2.id).find((c) => c.name === 'settle');
  store.updateCheckpoint(c3.id, { status: 'needs_sre', sre_reason: 'anomalies: x' });
  dw.claimJob(store.getCheckpoint(c3.id)); await dw.jobEnded(c3.id, {});
  assert.equal(store.getCheckpoint(c3.id).status, 'needs_sre');
  dw.claimJob(store.getCheckpoint(c3.id)); await dw.jobEnded(c3.id, {});
  assert.deepEqual([store.getCheckpoint(c3.id).status, store.getCheckpoint(c3.id).verdict], ['done', 'inconclusive']);
  assert.match(store.getCheckpoint(c3.id).summary, /did not answer/);
});

test('coverage: production access off is inconclusive at once; a missed check says so; restarts resume checkpoints', async () => {
  reset();
  const t = doneTicket();
  const { w } = await deployed(t);
  store.setSetting('ops_enabled', 'false');
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const smoke = store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  assert.equal(smoke.verdict, 'inconclusive', 'no retries when nothing can ever be observed');
  assert.match(JSON.parse(smoke.evidence).coverage.join(' '), /switched off/);
  store.setSetting('ops_enabled', 'true');
  // The desk was down for hours: the T+30 check is recorded as missed, not run late as if fresh.
  const late = at(33 + 7 * 60);
  dw.clock.now = () => late;
  await dw.sweep({ now: late });
  assert.match(store.checkpointsOf(w.id).find((c) => c.name === 'settle').summary, /missed/);
  // Restart recovery.
  const open = store.checkpointsOf(w.id).find((c) => c.name === 'session_open');
  store.updateCheckpoint(open.id, { status: 'running' });
  dw.recover();
  assert.equal(store.getCheckpoint(open.id).status, 'pending');
  store.updateCheckpoint(open.id, { status: 'sre_running', run_id: 999999 });
  dw.recover();
  assert.equal(store.getCheckpoint(open.id).status, 'needs_sre');
});

test('baselines are bounded: one taken after the deploy started is not trusted for restart and error comparisons', () => {
  const m = sha();
  store.kvSet(`deploy:baseline:${m}`, JSON.stringify({ captured_at: at(2).toISOString(), completed_at: at(2).toISOString(), containers: { rows: {} }, coverage: [] }));
  const b = dw.boundedBaseline(m, { startedAt: at(1).toISOString(), mergedAt: at(0).toISOString() });
  assert.equal(b.trusted, false);
  assert.match(b.coverage.join(' '), /after the deploy started/);
  assert.equal(dw.boundedBaseline(m, { startedAt: at(5).toISOString(), mergedAt: at(0).toISOString() }).trusted, true);
  assert.equal(dw.boundedBaseline(sha(), {}).missing, true);
  // New error signatures after the deploy: below the threshold an anomaly, at it a regression.
  const logs = [0, 1, 2].map((i) => `2026-10-03T15:1${i}:00.123456789Z ERROR order router timeout id=${i}`).join('\n');
  const s = dw.logSignatures(`# x since 10m: 3 line(s)\n2026-10-03T14:00:00Z ERROR old thing\n${logs}`, 'alpaca-trader', at(5).toISOString());
  assert.equal(Object.values(s.signatures).reduce((n, x) => n + x.count, 0), 3, 'only lines after the deploy, one signature');
});

test('trading-path work needs "How to verify in production" criteria to merge; the owner can add them', () => {
  const t = store.createTicket({ title: 'Touch order routing', status: 'ready_for_human' });
  store.updateTicket(t.key, { risk: 'high', review_stage: 'approved', pr_url: 'https://github.com/owner/demo/pull/9' });
  assert.match(dw.criteriaBlock(store.getTicket(t.key)), /How to verify in production/);
  const st = train.mergeState(store.getTicket(t.key));
  assert.deepEqual([st.state, st.blocked], ['owner', 'criteria']);
  sched.ownerProdVerify(t.key, { text: 'After the deploy the order router logs "routes loaded: 5" and /health is 200.' });
  assert.equal(dw.criteriaBlock(store.getTicket(t.key)), null);
  assert.equal(store.getTicket(t.key).prod_verify_by, 'owner');
  const low = store.createTicket({ title: 'Copy change' });
  store.updateTicket(low.key, { risk: 'low', diff_risk: 'low' });
  assert.equal(dw.criteriaBlock(store.getTicket(low.key)), null, 'others merge; their checks are labelled limited');
});

test('Team KPIs: deployed and production-verified are distinct deployments over one window', () => {
  const state = { tickets: [], meta: { production: { kpis: { window_days: 7, since: '2026-09-26T00:00:00.000Z', observed_at: '2026-10-03T00:00:00.000Z', deployments: 5, deployed: 4, failed: 1, verified: 2, regression: 1, inconclusive: 0, watching: 1, superseded: 0 } } } };
  const deps = departments.departmentsFor([{ id: 'qa' }]);
  const { release } = departments.departmentKpis(state, deps, { now: Date.parse('2026-10-03T00:00:00Z') });
  const by = Object.fromEntries(release.map((k) => [k.label, k]));
  assert.equal(by.Deployed.value, '4');
  assert.match(by.Deployed.window, /last 7 days/);
  assert.equal(by['Production-verified'].value, '2 of 4');
  assert.equal(by['Production-verified'].window, by.Deployed.window, 'the same window and denominator');
  const none = departments.departmentKpis({ tickets: [], meta: {} }, deps, {}).release;
  assert.ok(none.find((k) => k.label === 'Deployed').unknown);
});

test('holiday scheduling: a deploy on the evening before Independence Day (observed) is checked at Monday\'s open', () => {
  const m = sha();
  const rows = [store.recordDeploy({ deploy_key: `run:${seq}:1`, merge_sha: m, workflow: '.github/workflows/deploy.yml', run_id: 90000 + seq, target: 'other-target', status: 'success',
    completed_at: '2026-07-02T21:00:00.000Z', source: 'external' }).row];
  const w = store.transaction(() => dw.createWatchFor({ deployKey: rows[0].deploy_key, mergeSha: m, ticketKey: null, pr: null, rows, source: 'external' }));
  const open = store.checkpointsOf(w.id).find((c) => c.name === 'session_open');
  assert.equal(open.due_at, '2026-07-06T13:35:00.000Z', 'Monday 6 July 09:35 EDT, not the Friday holiday');
});

test('logs since the deploy: a new error signature at the threshold is a regression with a baseline, an anomaly without one', async () => {
  reset();
  const t = doneTicket();
  const { w } = await deployed(t); // baseline: the logs had no errors
  const errs = [0, 1, 2].map((i) => `2026-10-03T15:0${5 + i}:00.000000000Z ERROR fill writer crashed: KeyError 'qty' id=${i}`).join('\n');
  docker({ logs: `2026-10-03T14:59:00Z ERROR old noise before the deploy\n${errs}` });
  for (const min of [9, 12]) { dw.clock.now = () => at(min); await dw.sweep({ now: at(min) }); }
  const smoke = store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  assert.equal(smoke.verdict, 'regression');
  const item = JSON.parse(smoke.evidence).items.find((i) => i.probe === 'container_logs');
  assert.match(item.observed, /1 new error signature\(s\), 3 line\(s\)/, 'the pre-deploy line is outside the window');
  dw.clearRegressionHold(w.id);
  // The same errors with no baseline at all: the SRE is asked instead of paging the owner.
  reset();
  const t2 = doneTicket();
  const m = sha();
  lockFor(t2.key, m);
  setGh(`runs-${m}.json`, [run(4242, 1, m)]);
  await train.deployLock(at(4));
  const w2 = store.watchesForTicket(t2.key)[0];
  assert.equal(JSON.parse(w2.baseline).missing, true);
  docker({ logs: errs });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const s2 = store.checkpointsOf(w2.id).find((c) => c.name === 'smoke');
  assert.equal(s2.status, 'needs_sre');
  assert.match(JSON.parse(s2.evidence).items.find((i) => i.probe === 'container_logs').note, /no trusted baseline/);
});
