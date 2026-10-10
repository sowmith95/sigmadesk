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
if (c.sleepMs && ['ps', 'logs'].includes(a[0])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, c.sleepMs);
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
const db = ((process.argv.join(' ').match(/dbname=(\\S+)/) || [])[1]);
process.stdin.on('data', () => {}); process.stdin.on('end', () => { process.stdout.write((c.byDb && c.byDb[db]) || c.out || 'source\\tlatest\\tlag_s\\nbars\\t2026-10-03 15:00:00+00\\t4\\n'); process.exit(0); });
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
  store.handle().exec("UPDATE deploy_watches SET target = 'retired-by-test'"); // every test restarts the same timeline
  for (const s of ['pending', 'needs_sre', 'sre_running', 'running']) for (const c of store.checkpointsByStatus(s)) store.updateCheckpoint(c.id, { status: 'superseded' });
  docker(); app.status = 200; app.body = '{"status":"ok"}'; fs.writeFileSync(psqlCtl, '{}'); setGh('branch-runs.json', []);
  store.kvSet('deploywatch:reconciled', '');
  for (const g of store.openGrants()) store.endGrant(g.id, 'owner', 'test reset');
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
  dw.hooks.beforeWatch = () => { throw Object.assign(new Error('simulated crash'), { simulatedCrash: true }); };
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
    const got = r.checkpoints.find((x) => x.id);
    assert.equal(got?.verdict, 'verified', name);
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
  // Review #1: a limited verification (no ticket criteria) is not counted as production-verified.
  const k = dw.summary(open).kpis;
  assert.equal(k.verified, 0);
  assert.equal(k.verified_limited, 1);
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
  assert.equal((await dw.sweep({ now: at(9) })).checkpoints[0].status, 'retry', 'one confirming look before the incident');
  // Review #2: the FIRST hard failure already holds the train and pages the owner (before retries or revert prep).
  assert.deepEqual([store.getWatch(w.id).hold, store.getWatch(w.id).hold_kind], [1, 'provisional']);
  assert.equal(dw.regressionHold().id, w.id);
  assert.ok(store.listComments(t.key).some((c) => /Possible regression/.test(c.body)));
  assert.equal(store.getWatch(w.id).incident_key, null, 'no incident yet: confirmation first');
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
  assert.ok(store.listComments(t.key).some((c) => /Regression suspected/.test(c.body)));
  assert.ok(store.listComments(t.key).some((c) => /Incident: /.test(c.body) && /migrations/.test(c.body)), 'the tickets follow the hold');
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
  assert.match(item.observed, /^new: .*×3$/, 'the pre-deploy line is outside the window');
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

// ---------------- review fixes (Codex review of the first version) ----------------
const sha40 = (m) => JSON.stringify({ status: 'ok', git_sha: m.slice(0, 12) });

test('review #1: verified needs a matching identity and complete healthy evidence; an unhealthy probe vetoes the SRE', async () => {
  reset();
  const t = doneTicket();
  const { w } = await deployed(t); // the app does not report its commit
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const smoke = store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  assert.equal(smoke.verdict, 'inconclusive');
  assert.match(smoke.summary, /identity unresolved/);
  // Partial evidence (a health check still starting) is inconclusive, never verified.
  reset();
  const t2 = doneTicket();
  const { m: m2, w: w2 } = await deployed(t2);
  app.body = sha40(m2);
  docker({ inspect: '/alpaca-trader\tstarting\t0\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const s2 = store.checkpointsOf(w2.id).find((c) => c.name === 'smoke');
  assert.deepEqual([s2.verdict, /partial evidence/.test(s2.summary)], ['inconclusive', true]);
  // The SRE cannot say verified while any probe in its run answered 5xx, even if another probe was fine.
  reset();
  const t3 = doneTicket();
  const { m: m3, w: w3 } = await deployed(t3);
  app.body = sha40(m3);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t3.key, token: `v${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  store.updateCheckpoint(cp.id, { run_id: r.id });
  const g = access.ownerGrant({ seat: 'sre', probes: ['*'], minutes: 30, reason: 'test' });
  ops.clearCache();
  await ops.handle(r, { probe: 'container_status' });
  app.status = 503;
  await ops.handle(r, { probe: 'app_health' });
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'restart was benign' }), /UNHEALTHY/);
  // A foreign identity also vetoes it.
  app.status = 200;
  store.handle().exec(`UPDATE ops_audit SET health = NULL WHERE run_id = ${r.id}`);
  const ev = JSON.parse(store.getCheckpoint(cp.id).evidence);
  store.updateCheckpoint(cp.id, { evidence: JSON.stringify({ ...ev, identity: { ...ev.identity, status: 'mismatch' } }) });
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'x' }), /identity/);
  store.endGrant(g.id, 'owner', 'reset');
});

test('review #3: post-deploy grants obey the policy (seats, maxActive, maxMinutes, probes) and the deployment\'s resources', async () => {
  reset();
  const base = access.validatePolicy(access.policy());
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const mk = () => store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `p${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  access.setPolicy({ ...base, postDeployAutoGrant: true, seats: ['dba'] });
  assert.equal(dw.jobStarted(store.getCheckpoint(cp.id), mk()), null, 'the SRE is not a seat the policy allows');
  access.setPolicy({ ...base, postDeployAutoGrant: true, maxActive: 0 });
  assert.equal(dw.jobStarted(store.getCheckpoint(cp.id), mk()), null, 'no room under maxActive');
  access.setPolicy({ ...base, postDeployAutoGrant: true, maxMinutes: 5 });
  const r = mk();
  const g = dw.jobStarted(store.getCheckpoint(cp.id), r);
  assert.ok(Date.parse(g.expires_at) - Date.now() <= 5 * 60_000 + 1000, 'capped at the policy\'s longest grant');
  assert.deepEqual(JSON.parse(g.scope).containers, ['alpaca-trader'], 'scoped to the target\'s containers');
  config.ops.containers = ['alpaca-trader', 'broker-gateway'];
  ops.clearCache();
  await assert.rejects(ops.handle(r, { probe: 'container_logs', container: 'broker-gateway' }), /covers only alpaca-trader/);
  assert.match(await ops.handle(r, { probe: 'container_logs', container: 'alpaca-trader' }), /ops-result/);
  config.ops.containers = ['alpaca-trader'];
  // The owner narrows the probe list: the grant ends at the very next probe.
  access.setPolicy({ ...base, postDeployAutoGrant: true, maxMinutes: 5, probes: ['app_health'] });
  assert.ok(ops.denial(r, 'app_health'));
  assert.equal(store.getGrant(g.id).revoked_by, 'policy changed');
  access.setPolicy({ ...base, postDeployAutoGrant: false });
  assert.equal(w.id > 0, true);
});

test('review #4: known error signatures count when their RATE rises; an untrusted baseline never excuses staleness', async () => {
  reset();
  docker({ logs: '2026-10-03T14:50:00Z ERROR cache miss storm id=1' }); // the baseline: once in 30 minutes
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  const storm = Array.from({ length: 10 }, (_, i) => `2026-10-03T15:0${5 + (i % 4)}:${String(i).padStart(2, '0')}.000Z ERROR cache miss storm id=${i}`).join('\n');
  docker({ logs: storm });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const ev = JSON.parse(store.checkpointsOf(w.id).find((c) => c.name === 'smoke').evidence);
  const logs = ev.items.find((i) => i.probe === 'container_logs');
  assert.equal(logs.result, 'fail', 'a known signature at ~10× its before-rate');
  assert.match(logs.observed, /rate .*\/min → .*\/min/);
  dw.clearRegressionHold(w.id);
  // Freshness: stale during the session with an UNTRUSTED baseline that was also stale → still a failure.
  fs.writeFileSync(psqlCtl, JSON.stringify({ out: 'source\tlatest\tlag_s\nbars\t2026-10-07 14:40:00+00\t900\n' }));
  const fake = (baseline) => ({ id: 0, merge_sha: m, deployed_at: '2026-10-07T14:30:00.000Z', target: 'x', ticket_key: null, workflows: '[]', baseline: JSON.stringify(baseline) });
  const cpx = { name: 'settle', due_at: '2026-10-07T15:00:00.000Z', attempts: 1, evidence: null };
  const open = new Date('2026-10-07T15:00:00Z');
  const fr = (b) => dw.observe(fake(b), cpx, open).then((e) => e.items.find((i) => i.probe === 'ingest_freshness').result);
  assert.equal(await fr({ trusted: false, coverage: [], freshness: { rows: { bars: { lag_s: 900 } } } }), 'fail');
  assert.equal(await fr({ trusted: true, coverage: [], freshness: { rows: { bars: { lag_s: 900 } } } }), 'unknown', 'only a trusted "already stale" excuses it');
  fs.writeFileSync(psqlCtl, '{}');
});

test('review #5: only a matched target supersedes; an older deployment found later is superseded at once (watermark)', () => {
  reset();
  const mk = (target, completed, key) => { const m = sha(); const row = store.recordDeploy({ deploy_key: key, merge_sha: m, workflow: '.github/workflows/deploy.yml', run_id: 70000 + seq, target, status: 'success', completed_at: completed, source: 'external' }).row;
    return store.transaction(() => dw.createWatchFor({ deployKey: key, mergeSha: m, ticketKey: null, pr: null, rows: [row], source: 'external' })); };
  const trading = mk('alpaca-trader', at(10).toISOString(), `k${++seq}`);
  const unknown = mk(null, at(20).toISOString(), `k${++seq}`);
  assert.equal(store.getWatch(trading.id).status, 'watching', 'an unmapped deployment does not cancel a trading watch');
  assert.equal(store.getWatch(unknown.id).status, 'watching', 'and is itself monitored');
  const newer = mk('alpaca-trader', at(30).toISOString(), `k${++seq}`);
  assert.equal(store.getWatch(trading.id).status, 'superseded');
  const older = mk('alpaca-trader', at(5).toISOString(), `k${++seq}`);
  assert.deepEqual([store.getWatch(older.id).status, store.getWatch(older.id).superseded_by], ['superseded', newer.id]);
  assert.equal(store.checkpointsOf(older.id).length, 0, 'nothing is scheduled for it');
  assert.equal(store.getWatch(unknown.id).trading_path, 1, 'no ticket to classify: treated as trading-path');
});

test('review #6: unknown risk is high — criteria are required unless BOTH classifications are low', () => {
  assert.match(dw.criteriaBlock({ risk: null, diff_risk: 'low' }), /not classified low/);
  assert.match(dw.criteriaBlock({ risk: 'low', diff_risk: null }), /not classified low/);
  assert.match(dw.criteriaBlock({ risk: 'high', diff_risk: 'low' }), /changes the trading path/);
  assert.equal(dw.criteriaBlock({ risk: 'low', diff_risk: 'low' }), null);
  assert.equal(dw.tradingPath(null), true, 'an external deployment is trading-path');
  const t = store.createTicket({ title: 'Unclassified', status: 'ready_for_human' });
  store.updateTicket(t.key, { review_stage: 'approved', pr_url: 'https://github.com/owner/demo/pull/11' });
  assert.equal(train.mergeState(store.getTicket(t.key)).blocked, 'criteria');
});

test('review #7: a deploy that completes after escalation (and an owner clear) still gets a watch; the hold record stays', async () => {
  reset();
  const t = doneTicket();
  const m = sha();
  lockFor(t.key, m);
  setGh(`runs-${m}.json`, [run(4321, 1, m, { status: 'in_progress', conclusion: null })]);
  assert.equal((await train.deployLock(new Date(T0.getTime() + 60 * 60_000))).state, 'escalated');
  train.ownerClearDeploy({ merge_sha: m });
  const held = store.deploysForSha(m)[0];
  assert.deepEqual([held.status, held.hold_status, held.cleared_by, held.run_id], ['unknown', 'unknown', 'owner', 4321]);
  setGh('branch-runs.json', [run(4321, 1, m, { updated_at: at(70).toISOString() })]);
  const out = await dw.reconcile({ now: at(71), force: true });
  assert.equal(out.recorded[0].late, true);
  const after = store.deploysForSha(m)[0];
  assert.deepEqual([after.status, after.hold_status, after.cleared_by], ['success', 'unknown', 'owner'], 'the observation moved on; the hold history did not');
  const w = store.watchByKey(after.deploy_key);
  assert.equal(w.status, 'watching');
  assert.equal(dw.ticketView(t.key).deploys[0].held_as, 'unknown');
});

test('review #8: the merge train checks due post-deploy smoke checks before merging, and monitoring has its own timer', async () => {
  reset();
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m); app.status = 500;
  dw.clock.now = () => at(9);
  store.setSetting('github_sync', 'false');
  await train.sweep({ now: at(9) });
  store.setSetting('github_sync', 'true');
  assert.equal(store.getWatch(w.id).hold, 1, 'the provisional hold exists before the train considered anything');
  dw.clearRegressionHold(w.id);
  const srv = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(srv, /setInterval\(\(\) => deploywatch\.sweep\(/, 'its own timer, independent of the merge train and reviews');
});

test('review #9: a post-deploy run\'s access request lives with its checkpoint run, not the (done) ticket', async () => {
  reset();
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `q${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  store.updateCheckpoint(cp.id, { run_id: r.id });
  await ops.handle(r, { probe: 'request', probes: ['app_health'], why: 'look at /health after the restart' });
  const req = store.openAccessRequests().find((x) => x.run_id === r.id);
  assert.ok(req && !req.ticket_key && req.ticket_scoped === 1);
  access.sweep();
  assert.ok(store.openAccessRequests().some((x) => x.id === req.id), 'still open although the ticket is done');
  await dw.jobEnded(cp.id, { refused: 'test' });
  access.sweep();
  assert.equal(store.getAccessRequest(req.id).status, 'withdrawn');
  assert.equal(w.id > 0, true);
});

test('review #10: a small market-hours allowance rotates through every container\'s logs across retries, then verifies', async () => {
  reset();
  config.ops.containers = ['alpaca-trader', 'ingestor', 'precompute'];
  config.deployWatch.targetContainers = { 'alpaca-trader': ['alpaca-trader', 'ingestor', 'precompute'] };
  const ps = config.ops.containers.map((c) => `${c}\trunning\tUp 1 minute\t1 minute ago`).join('\n');
  const ins = config.ops.containers.map((c) => `/${c}\thealthy\t0\t2026-10-03T15:01:00Z\tfalse\timg`).join('\n');
  docker({ ps, inspect: ins });
  config.ops.busy.perHour = 100000;
  ops.setNow(() => new Date('2026-10-07T15:00:00Z')); // market hours: 4 probes per checkpoint attempt
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ ps, inspect: ins });
  const smoke = () => store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  for (const min of [9, 11, 16]) { dw.clock.now = () => at(min); await dw.sweep({ now: at(min) }); }
  const ev = JSON.parse(smoke().evidence);
  assert.deepEqual(ev.items.filter((i) => i.probe === 'container_logs').map((i) => i.container).sort(), ['alpaca-trader', 'ingestor', 'precompute']);
  assert.equal(smoke().verdict, 'verified', 'complete after rotating');
  assert.equal(smoke().attempts, 2, 'two secondary slots per attempt: three logs and one database in two attempts');
  ops.setNow(() => new Date('2026-10-03T15:00:00Z'));
  config.ops.containers = ['alpaca-trader'];
  delete config.deployWatch.targetContainers;
});

test('review #11: calendar config is validated; an uncovered year fails closed to the owner; a recording error never wedges the lock', async () => {
  const { validateConfig } = await import('../src/config.js');
  const saved = config.deployWatch.calendar;
  config.deployWatch.calendar = { timezone: 'Mars/Olympus', holidays: ['2026-13-40'], earlyCloses: { '2026-11-27': '1pm' } };
  const problems = validateConfig(config).join('\n');
  assert.match(problems, /timezone "Mars\/Olympus"/);
  assert.match(problems, /holidays must be/);
  assert.match(problems, /earlyCloses must map/);
  // A year outside the table: the release still happens; the session-open check waits for the owner.
  reset();
  config.deployWatch.calendar = { replace: true, years: [] };
  const t = doneTicket();
  const { w } = await deployed(t);
  assert.equal(store.kvGet('train:deploy'), 'null', 'the lock was released');
  const open = store.checkpointsOf(w.id).find((c) => c.name === 'session_open');
  assert.equal(open.status, 'unschedulable');
  const s = dw.summary(at(5));
  assert.equal(s.unschedulable[0].id, open.id);
  const B = attention.board({ tickets: store.listTickets(), agents: [], meta: { production: s }, incidents: [] });
  assert.ok(B.needs_you.some((x) => x.kind === 'watch_schedule'));
  assert.throws(() => dw.ownerCheckpoint(open.id), /Still cannot schedule/);
  config.deployWatch.calendar = saved;
  assert.equal(dw.ownerCheckpoint(open.id).status, 'pending', 'retried after the fix');
  // A bug while recording a finished deploy escalates the lock (owner-clearable) instead of leaving it "running".
  reset();
  const t2 = doneTicket();
  const m2 = sha();
  lockFor(t2.key, m2);
  setGh(`runs-${m2}.json`, [run(8080, 1, m2)]);
  dw.hooks.beforeWatch = () => { throw new Error('disk full'); };
  const l = await train.deployLock(at(4));
  dw.hooks.beforeWatch = null;
  assert.deepEqual([l.state, /could not be recorded/.test(l.note)], ['escalated', true]);
  assert.ok(train.ownerClearDeploy({ merge_sha: m2 }));
});

// ---------------- round-2 review fixes ----------------
test('round 2 #1: every criterion needs its own fresh evidence — an unrelated probe never settles it; unread freshness stays unresolved', async () => {
  reset();
  const t = doneTicket({ prod_verify: 'fills panel shows today' });
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' }); // one restart: an anomaly
  fs.writeFileSync(psqlCtl, JSON.stringify({ out: 'source\tlatest\tlag_s\n' })); // freshness reports nothing: unresolved
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `r1${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  store.updateCheckpoint(cp.id, { run_id: r.id });
  const g = access.ownerGrant({ seat: 'sre', probes: ['*'], minutes: 30, reason: 'test' });
  ops.clearCache();
  await ops.handle(r, { probe: 'db_health', db: 'timescale' }); // unrelated to the restart
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'fine' }), /not settled by a fresh probe of its own.*container alpaca-trader runs/);
  await ops.handle(r, { probe: 'container_status' }); // the anomaly's own probe
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'fine' }), /not every required criterion has fresh healthy evidence.*ingest freshness/);
  fs.writeFileSync(psqlCtl, '{}'); // now the desk's fresh look can read freshness
  assert.match(await sched.deskAction(r, 'watch', { action: 'verified', body: 'restart was the deploy itself; all healthy' }), /Recorded/);
  assert.equal(store.getCheckpoint(cp.id).verdict, 'verified');
  assert.ok(JSON.parse(store.getCheckpoint(cp.id).evidence).items.some((i) => i.criterion === 'ingest bars is fresh' && i.result === 'pass'), 'the stored evidence is the fresh look');
  store.endGrant(g.id, 'owner', 'reset');
  assert.equal(w.id > 0, true);
});

test('round 2 #2: a provisional hold lifts only on a fresh healthy look at what failed; a refused confirmation keeps it', async () => {
  reset();
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m); app.status = 503;
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  assert.equal(store.getWatch(w.id).hold_kind, 'provisional');
  // The confirming look is refused by the hourly budget: no recovery evidence, the hold stays.
  app.status = 200;
  const per = config.ops.normal.perHour;
  config.ops.normal.perHour = 1;
  dw.clock.now = () => at(11);
  await dw.sweep({ now: at(11) });
  config.ops.normal.perHour = per;
  assert.deepEqual([store.getWatch(w.id).hold, store.getWatch(w.id).hold_kind], [1, 'provisional'], 'no positive evidence: still held');
  // A fresh, healthy answer of the failed check lifts it.
  const next = store.checkpointsOf(w.id).find((c) => c.name === 'smoke').next_attempt_at;
  dw.clock.now = () => new Date(next);
  await dw.sweep({ now: new Date(next) });
  assert.equal(store.getWatch(w.id).hold, 0);
  assert.ok(store.listComments(t.key).some((c) => /passed again on a fresh look/.test(c.body)));
});

test('round 2 #3: a scoped grant sees only its containers in container_status; lowering maxActive ends the oldest agent grants', async () => {
  reset();
  const base = access.validatePolicy(access.policy());
  access.setPolicy({ ...base, postDeployAutoGrant: true });
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = dw.claimJob(dw.nextJobs()[0].checkpoint);
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `r3${++seq}`, model: 'x', job: { checkpoint: cp.id } });
  const g = dw.jobStarted(store.getCheckpoint(cp.id), r);
  config.ops.containers = ['alpaca-trader', 'broker-gateway'];
  docker({ ps: 'alpaca-trader\trunning\tUp\t1m\nbroker-gateway\trunning\tUp\t1m', inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  const out = await ops.handle(r, { probe: 'container_status' });
  assert.match(out, /alpaca-trader/);
  assert.doesNotMatch(out, /broker-gateway/, 'nothing about containers outside the grant');
  config.ops.containers = ['alpaca-trader'];
  // An older agent grant exists too; the owner lowers maxActive to 1: the oldest ends at the next probe.
  const older = store.insertGrant({ seat: 'dba', probes: ['db_health'], expires_at: new Date(Date.now() + 3600_000).toISOString(), granted_by: 'manager', reason: 'older' });
  store.handle().exec(`UPDATE ops_grants SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ${older.id}`);
  access.setPolicy({ ...base, postDeployAutoGrant: true, maxActive: 1 });
  assert.equal(ops.denial(r, 'app_health'), null, 'the newest grant keeps working');
  assert.equal(store.getGrant(older.id).revoked_by, 'policy changed');
  access.setPolicy({ ...base, postDeployAutoGrant: true, maxActive: 0 });
  assert.ok(ops.denial(r, 'app_health'));
  assert.equal(store.getGrant(g.id).revoked_by, 'policy changed');
  access.setPolicy({ ...base, postDeployAutoGrant: false });
  assert.equal(w.id > 0, true);
});

test('round 2 #4: an ingestor-only deployment retires only the ingestor part of a trader+ingestor watch', async () => {
  reset();
  config.ops.containers = ['alpaca-trader', 'ingestor'];
  const mk = (targets, completed, key) => { const m = sha(); const rows = targets.map((tg, i) => store.recordDeploy({ deploy_key: key, merge_sha: m, workflow: `.github/workflows/${tg}.yml`, run_id: 80000 + seq * 10 + i, target: tg, status: 'success', completed_at: completed, source: 'external' }).row);
    return store.transaction(() => dw.createWatchFor({ deployKey: key, mergeSha: m, ticketKey: null, pr: null, rows, source: 'external' })); };
  const both = mk(['alpaca-trader', 'ingestor'], at(3).toISOString(), `b${++seq}`);
  mk(['ingestor'], at(6).toISOString(), `i${++seq}`);
  const w = store.getWatch(both.id);
  assert.deepEqual([w.status, dw.activeResources(w), JSON.parse(w.retired_targets)], ['watching', ['container:alpaca-trader'], ['ingestor']], 'trader monitoring continues');
  docker({ ps: 'alpaca-trader\trunning\tUp\t1m\ningestor\trunning\tUp\t1m', inspect: '/alpaca-trader\thealthy\t0\t2026-10-03T15:01:00Z\tfalse\timg\n/ingestor\thealthy\t5\t2026-10-03T15:06:00Z\tfalse\timg' });
  const ev = await dw.observe(w, { name: 'settle', due_at: at(33).toISOString(), attempts: 1, evidence: null }, at(33));
  assert.ok(!ev.items.some((i) => /ingestor/.test(i.criterion)), 'the ingestor now runs another deployment: not judged here');
  assert.ok(ev.items.some((i) => i.criterion === 'container alpaca-trader runs'));
  // An older trader+ingestor deployment discovered after the ingestor one: only its trader part is watched.
  const late = mk(['alpaca-trader', 'ingestor'], at(4).toISOString(), `l${++seq}`);
  assert.deepEqual(dw.activeResources(store.getWatch(late.id)), ['container:alpaca-trader']);
  config.ops.containers = ['alpaca-trader'];
});

test('round 2 #5: two freshness databases cannot starve logs; an impossible allowance ends inconclusive with the exact gap', async () => {
  reset();
  config.ops.databases.ts2 = { host: '127.0.0.1', port: 5433, dbname: 'ts2', user: 'ro' };
  config.ops.freshness = [{ label: 'bars', db: 'timescale' }, { label: 'bars2', db: 'ts2' }];
  config.ops.busy.perHour = 100000;
  ops.setNow(() => new Date('2026-10-07T15:00:00Z')); // market hours: 4 probes per attempt
  const t = doneTicket();
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const ev1 = JSON.parse(store.checkpointsOf(w.id).find((c) => c.name === 'smoke').evidence);
  assert.ok(ev1.items.some((i) => i.probe === 'container_logs' && !i.incomplete), 'logs are read on the first attempt');
  assert.match(ev1.coverage.join(' '), /not read within the probe allowance .*ingest freshness of ts2/);
  dw.clock.now = () => at(11);
  await dw.sweep({ now: at(11) });
  assert.equal(store.checkpointsOf(w.id).find((c) => c.name === 'smoke').verdict, 'verified', 'covered across two attempts');
  // An allowance that can never reach the secondary checks: inconclusive, naming exactly what was never read.
  reset();
  config.deployWatch.probesPerCheckpoint = 2;
  const t2 = doneTicket();
  const { m: m2, w: w2 } = await deployed(t2);
  app.body = sha40(m2);
  for (const min of [9, 11, 16, 26]) { dw.clock.now = () => at(min); await dw.sweep({ now: at(min) }); }
  const s2 = store.checkpointsOf(w2.id).find((c) => c.name === 'smoke');
  assert.equal(s2.verdict, 'inconclusive');
  assert.match(s2.summary, /never read within the probe allowance — logs of alpaca-trader, ingest freshness of timescale, ingest freshness of ts2/);
  delete config.deployWatch.probesPerCheckpoint;
  delete config.ops.databases.ts2;
  config.ops.freshness = [{ label: 'bars', db: 'timescale' }];
  ops.setNow(() => new Date('2026-10-03T15:00:00Z'));
});

// ---------------- round-3: evidence identity {criterion, kind, resource} and live grant scope ----------------
const mkGrantRun = async (t, w, cfg = {}) => {
  const base = access.validatePolicy(access.policy());
  access.setPolicy({ ...base, postDeployAutoGrant: true, ...cfg });
  const cp = dw.claimJob(store.checkpointsByStatus('needs_sre').find((c) => c.watch_id === w.id));
  const r = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t?.key || null, token: `g${++seq}${Math.random()}`, model: 'x', job: { checkpoint: cp.id } });
  const g = dw.jobStarted(store.getCheckpoint(cp.id), r);
  return { cp, r, g, done: () => access.setPolicy({ ...base, postDeployAutoGrant: false }) };
};

test('round 3: a trader-scoped container_status never settles the broker\'s anomaly', async () => {
  reset();
  config.ops.containers = ['alpaca-trader', 'broker'];
  const ps = 'alpaca-trader\trunning\tUp\t1m\nbroker\trunning\tUp\t1m';
  const t = doneTicket();
  docker({ ps, inspect: '/alpaca-trader\thealthy\t0\t2026-10-03T15:01:00Z\tfalse\timg\n/broker\thealthy\t0\t2026-10-03T14:00:00Z\tfalse\timg' });
  const { m, w } = await deployed(t);
  app.body = sha40(m);
  docker({ ps, inspect: '/alpaca-trader\thealthy\t0\t2026-10-03T15:01:00Z\tfalse\timg\n/broker\thealthy\t1\t2026-10-03T14:00:00Z\tfalse\timg' }); // broker restarted once
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const { cp, r, done } = await mkGrantRun(t, w);
  const out = await ops.handle(r, { probe: 'container_status' });
  assert.doesNotMatch(out, /broker/, 'the grant only sees the trader');
  assert.deepEqual(JSON.parse(store.opsAuditOfRun(r.id).at(-1).resources), ['alpaca-trader']);
  await assert.rejects(sched.deskAction(r, 'watch', { action: 'verified', body: 'fine' }), /container broker runs \[broker\]/);
  assert.equal(store.getCheckpoint(cp.id).status, 'sre_running', 'not verified');
  done();
  config.ops.containers = ['alpaca-trader'];
});

test('round 3: two databases with the same source label — A\'s failure is released only by a healthy read of A', async () => {
  const bars = (lag) => `source\tlatest\tlag_s\nbars\t2026-10-07 14:55:00+00\t${lag}\n`;
  config.ops.databases.ts2 = { host: '127.0.0.1', port: 5433, dbname: 'ts2', user: 'ro' };
  config.ops.freshness = [{ label: 'bars', db: 'timescale' }, { label: 'bars', db: 'ts2' }];
  const m = sha();
  const w = { id: 0, merge_sha: m, deployed_at: '2026-10-07T14:30:00.000Z', target: 'x', ticket_key: null, workflows: '[]', baseline: JSON.stringify({ trusted: true, coverage: [], freshness: { rows: { bars: { lag_s: 4 } } } }) };
  const look = async (byDb) => { fs.writeFileSync(psqlCtl, JSON.stringify({ byDb })); return dw.observe(w, { name: 'settle', due_at: '2026-10-07T15:00:00.000Z', attempts: 1, evidence: null }, new Date('2026-10-07T15:00:00Z')); };
  const ev1 = await look({ ts: bars(900), ts2: bars(4) });
  const failed = ev1.items.filter((i) => i.result === 'fail').map(dw.evKey);
  assert.deepEqual(failed, ['ingest_freshness|timescale|ingest bars is fresh']);
  const ev2 = await look({ ts: 'source\tlatest\tlag_s\n', ts2: bars(4) }); // A reports nothing; B (same label) passes
  assert.equal(dw.recovered(failed, ev2), false, 'B\'s pass is not A\'s recovery');
  assert.equal(dw.recovered(failed, await look({ ts: bars(5), ts2: bars(900) })), true, 'a healthy read of A releases A');
  delete config.ops.databases.ts2;
  config.ops.freshness = [{ label: 'bars', db: 'timescale' }];
  fs.writeFileSync(psqlCtl, '{}');
});

test('round 3: grant scope is live — a component retired by a newer deployment is refused at once (both directions)', async () => {
  for (const [retire, keep] of [['ingestor', 'alpaca-trader'], ['alpaca-trader', 'ingestor']]) {
    reset();
    config.ops.containers = ['alpaca-trader', 'ingestor'];
    const ps = 'alpaca-trader\trunning\tUp\t1m\ningestor\trunning\tUp\t1m';
    docker({ ps, inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg\n/ingestor\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
    const mk = (targets, completed, key) => { const m = sha(); const rows = targets.map((tg, i) => store.recordDeploy({ deploy_key: key, merge_sha: m, workflow: `.github/workflows/${tg}.yml`, run_id: 90000 + seq * 10 + i, target: tg, status: 'success', completed_at: completed, source: 'external' }).row);
      return store.transaction(() => dw.createWatchFor({ deployKey: key, mergeSha: m, ticketKey: null, pr: null, rows, source: 'external' })); };
    const w = mk(['alpaca-trader', 'ingestor'], at(3).toISOString(), `lv${++seq}`);
    app.body = sha40(w.merge_sha);
    dw.clock.now = () => at(9);
    await dw.sweep({ now: at(9) });
    const { r, done } = await mkGrantRun(null, w);
    assert.match(await ops.handle(r, { probe: 'container_logs', container: retire }), /ops-result/, 'both components readable before');
    mk([retire], at(12).toISOString(), `nv${++seq}`); // a newer deployment takes over one component
    await assert.rejects(ops.handle(r, { probe: 'container_logs', container: retire }), new RegExp(`covers only ${keep}`));
    const st = await ops.handle(r, { probe: 'container_status' });
    assert.doesNotMatch(st, new RegExp(`^${retire}\\t`, 'm'));
    assert.match(st, new RegExp(keep));
    done();
  }
  config.ops.containers = ['alpaca-trader'];
});

test('round 3 property: verified ⇒ every required key has fresh healthy evidence from its own resource; release ⇒ every failed key re-observed healthy', () => {
  let x = 7;
  const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const pick = (a) => a[rnd(a.length)];
  const KINDS = { app_health: ['app'], container_status: ['trader', 'broker', 'ingestor'], container_logs: ['trader', 'broker'], ingest_freshness: ['dbA', 'dbB'] };
  const RES = ['pass', 'fail', 'anomaly', 'unknown', 'n/a'];
  const mkItem = () => { const kind = pick(Object.keys(KINDS)); const resource = pick(KINDS[kind]); return { criterion: pick(['c1', 'c2']), probe: kind, kind, resource, result: pick(RES), carried: rnd(5) === 0 }; };
  for (let n = 0; n < 2000; n++) {
    const ev = { items: Array.from({ length: 1 + rnd(5) }, mkItem) };
    const re = { items: Array.from({ length: 1 + rnd(6) }, mkItem), identity: { status: rnd(6) ? 'match' : 'unresolved' } };
    const audit = Array.from({ length: rnd(4) }, () => { const k = pick(Object.keys(KINDS)); return { probe: k, outcome: rnd(5) ? 'ok' : 'error', health: rnd(6) ? null : 'unhealthy', resources: JSON.stringify([pick(KINDS[k])]) }; });
    if (!dw.verificationProblems(ev, re, audit).length) {
      // Oracle, written independently: every non-n/a key of ev (resolved ones) and re has a fresh pass/n/a item with the
      // same kind+resource+criterion in re, or an anomaly with an ok, healthy audit row of that kind on that resource.
      assert.equal(re.identity.status, 'match');
      const k = (i) => `${i.kind}|${i.resource}|${i.criterion}`;
      for (const i of [...ev.items.filter((y) => y.result !== 'unknown'), ...re.items].filter((y) => y.result !== 'n/a')) {
        const all = re.items.filter((y) => k(y) === k(i));
        assert.ok(all.length, `missing ${k(i)}`);
        for (const now of all) assert.ok(now.result === 'pass' || now.result === 'n/a'
          || (now.result === 'anomaly' && audit.some((a) => a.outcome === 'ok' && a.health !== 'unhealthy' && a.probe === now.kind && JSON.parse(a.resources).includes(now.resource))), `${k(i)} is ${now.result}`);
      }
      for (const i of ev.items.filter((y) => y.result === 'unknown')) assert.ok(re.items.some((y) => y.kind === i.kind && y.resource === i.resource), `unknown ${i.kind}|${i.resource} never re-read`);
    }
    const failed = [...new Set(ev.items.filter((i) => i.result === 'fail').map(dw.evKey))];
    if (dw.recovered(failed, re)) for (const f of failed) { const seen = re.items.filter((y) => `${y.kind}|${y.resource}|${y.criterion}` === f); assert.ok(seen.length && seen.every((y) => y.result === 'pass' && !y.carried), `released without ${f}`); }
  }
});

// ---------------- round-4: scope at completion, and resources instead of target labels ----------------
const mkRows = (targets, completed, key) => { const m = sha(); const rows = targets.map((tg, i) => store.recordDeploy({ deploy_key: key, merge_sha: m, workflow: `.github/workflows/${tg}.yml`, run_id: 95000 + seq * 10 + i, target: tg, status: 'success', completed_at: completed, source: 'external' }).row);
  return store.transaction(() => dw.createWatchFor({ deployKey: key, mergeSha: m, ticketKey: null, pr: null, rows, source: 'external' })); };

test('round 4: a probe queued or running when its resource leaves the watch drops that resource (status) or its result (logs)', async () => {
  reset();
  config.ops.containers = ['alpaca-trader', 'ingestor'];
  const ps = 'alpaca-trader\trunning\tUp\t1m\ningestor\trunning\tUp\t1m';
  const ins = '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg\n/ingestor\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg';
  docker({ ps, inspect: ins });
  const w = mkRows(['alpaca-trader', 'ingestor'], at(3).toISOString(), `q${++seq}`);
  app.body = sha40(w.merge_sha);
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const { r, done } = await mkGrantRun(null, w);
  // Both docker lanes busy with slow desk probes; the seat's status probe waits in the queue.
  docker({ ps, inspect: ins, sleepMs: 700 });
  const blockers = [ops.deskProbe('container_status'), ops.deskProbe('container_status')];
  await new Promise((res) => setTimeout(res, 100));
  const queued = ops.handle(r, { probe: 'container_status' });
  await new Promise((res) => setTimeout(res, 100));
  mkRows(['ingestor'], at(12).toISOString(), `nq${++seq}`); // the ingestor leaves this watch while the probe waits
  const out = await queued;
  await Promise.all(blockers);
  assert.doesNotMatch(out, /^ingestor\t/m);
  assert.deepEqual(JSON.parse(store.opsAuditOfRun(r.id).at(-1).resources), ['alpaca-trader']);
  // Running (not queued) when the change happens: the answer comes back, the departed rows are dropped and said so.
  const w2 = mkRows(['alpaca-trader', 'ingestor'], at(20).toISOString(), `q${++seq}`);
  app.body = sha40(w2.merge_sha);
  dw.clock.now = () => at(26);
  docker({ ps, inspect: ins });
  await dw.sweep({ now: at(26) });
  const g2 = await mkGrantRun(null, w2);
  docker({ ps, inspect: ins, sleepMs: 500 });
  const running = ops.handle(g2.r, { probe: 'container_status' });
  const logs = ops.handle(g2.r, { probe: 'container_logs', container: 'ingestor' }).then(() => null, (e) => e);
  await new Promise((res) => setTimeout(res, 150));
  mkRows(['ingestor'], at(28).toISOString(), `nr${++seq}`);
  const out2 = await running;
  assert.match(out2, /ingestor left this watch while the probe ran: dropped/);
  assert.doesNotMatch(out2, /^ingestor\t/m);
  assert.match(String((await logs)?.message), /ingestor left this watch while the probe ran/);
  docker({ ps, inspect: ins });
  done(); g2.done();
  config.ops.containers = ['alpaca-trader'];
});

test('round 4: blue and green share the trader container — a newer green retires trader from the blue+ingestor watch', async () => {
  reset();
  config.ops.containers = ['trader', 'ingestor'];
  config.deployWatch.targetContainers = { blue: ['trader'], green: ['trader'], ingestor: ['ingestor'] };
  const ps = 'trader\trunning\tUp\t1m\ningestor\trunning\tUp\t1m';
  docker({ ps, inspect: '/trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg\n/ingestor\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  const w = mkRows(['blue', 'ingestor'], at(3).toISOString(), `bg${++seq}`);
  app.body = sha40(w.merge_sha);
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const { r, done } = await mkGrantRun(null, w);
  assert.match(await ops.handle(r, { probe: 'container_logs', container: 'trader' }), /ops-result/);
  mkRows(['green'], at(12).toISOString(), `gr${++seq}`);
  assert.deepEqual(dw.activeResources(store.getWatch(w.id)), ['container:ingestor']);
  await assert.rejects(ops.handle(r, { probe: 'container_logs', container: 'trader' }), /covers only ingestor/);
  assert.match(await ops.handle(r, { probe: 'container_logs', container: 'ingestor' }), /ops-result/);
  // An older blue-only deployment found later: everything it ran was already replaced → superseded at once.
  const old = mkRows(['blue'], at(5).toISOString(), `ob${++seq}`);
  assert.equal(store.getWatch(old.id).status, 'superseded');
  done();
  delete config.deployWatch.targetContainers;
  config.ops.containers = ['alpaca-trader'];
});

test('round 4 property: aliased targets retire exactly the shared resources; queued/running drops leave nothing out of scope', () => {
  let x = 11;
  const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const C = ['c1', 'c2', 'c3', 'c4'];
  const saved = config.ops.containers;
  config.ops.containers = C;
  for (let n = 0; n < 60; n++) {
    reset();
    const labels = ['l1', 'l2', 'l3', 'l4'];
    const map = Object.fromEntries(labels.map((l) => [l, C.filter(() => rnd(3) === 0).concat(rnd(2) ? [] : [C[rnd(4)]]).filter((v, i, a) => a.indexOf(v) === i)]));
    config.deployWatch.targetContainers = map;
    const deps = Array.from({ length: 2 + rnd(4) }, (_, i) => ({ labels: labels.filter(() => rnd(2)).slice(0, 2), at: at(5 + rnd(60)).toISOString(), i })).filter((d) => d.labels.length);
    const made = deps.map((d) => ({ d, w: mkRows(d.labels, d.at, `p${++seq}`) })); // created in random time order
    const res = (ls) => [...new Set(ls.flatMap((l) => (map[l].length ? map[l].map((c) => `container:${c}`) : [`target:${l}`])))];
    for (const { d, w } of made) {
      const later = made.filter((o) => o.d.at > d.at).flatMap((o) => res(o.d.labels));
      const want = res(d.labels).filter((r) => !later.includes(r)).sort();
      const now = store.getWatch(w.id);
      if (!want.length) assert.equal(now.status, 'superseded', `case ${n}: nothing left`);
      else { assert.equal(now.status, 'watching', `case ${n}`); assert.deepEqual(dw.activeResources(now).sort(), want, `case ${n}`); }
    }
    // Drops: whatever left scope while a status probe ran is gone from the answer and from the audited resources.
    const before = C.filter(() => rnd(2)); const after = before.filter(() => rnd(2));
    const text = `# containers\nname\tstate\n${before.map((c) => `${c}\trunning`).join('\n')}\n# health\n${before.map((c) => `/${c}\thealthy`).join('\n')}`;
    const out = ops.dropContainers(text, before.filter((c) => !after.includes(c)));
    for (const c of before.filter((y) => !after.includes(y))) assert.doesNotMatch(out, new RegExp(`^/?${c}\\t`, 'm'));
    for (const c of ops.observedResources('container_status', {}, { outcome: 'ok', text: out }, after)) assert.ok(after.includes(c));
  }
  delete config.deployWatch.targetContainers;
  config.ops.containers = saved;
});

test('round 5: a parent-shape watch (retired_targets set, retired_resources NULL) still never judges the retired ingestor', async () => {
  reset();
  config.ops.containers = ['alpaca-trader', 'ingestor'];
  const w0 = mkRows(['alpaca-trader'], at(3).toISOString(), `ps${++seq}`);
  store.handle().exec(`UPDATE deploy_watches SET retired_targets='["ingestor"]', retired_resources=NULL WHERE id=${w0.id}`);
  const w = store.getWatch(w0.id);
  assert.deepEqual(dw.retiredResourcesOf(w), ['container:ingestor']);
  app.body = sha40(w.merge_sha);
  docker({ ps: 'alpaca-trader\trunning\tUp\t1m\ningestor\texited\tExited (1)\t1m', inspect: '/alpaca-trader\thealthy\t0\t2026-10-03T15:01:00Z\tfalse\timg\n/ingestor\tunhealthy\t9\t2026-10-03T15:01:00Z\ttrue\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const ev = JSON.parse(store.checkpointsOf(w.id).find((c) => c.name === 'smoke').evidence);
  assert.ok(!ev.items.some((i) => i.resource === 'ingestor'), 'no evidence about the retired ingestor');
  assert.equal(store.getWatch(w.id).hold, 0);
  config.ops.containers = ['alpaca-trader'];
});

test('watch steps are enforced across attempts: a plan-billed check stops past what is left of its checkpoint\'s steps', async () => {
  const runner = await import('../src/runner.js');
  reset();
  const t = doneTicket();
  const { w } = await deployed(t);
  docker({ inspect: '/alpaca-trader\thealthy\t1\t2026-10-03T15:01:00Z\tfalse\timg' });
  dw.clock.now = () => at(9);
  await dw.sweep({ now: at(9) });
  const cp = store.checkpointsOf(w.id).find((c) => c.name === 'smoke');
  const plan = { id: 'sre', engine: 'codex', model: 'gpt' };
  const tools = (ctx, n, from = 0) => runner.applyEvents(Array.from({ length: n }, (_, i) => ({ type: 'tool', text: `Probe ${from + i}` })), ctx);
  // Attempt 1 is given the whole 40 steps, takes 25 and ends without a verdict: the checkpoint keeps the 25.
  const a1 = dw.admit(store.getCheckpoint(cp.id), plan);
  assert.equal(a1.limits.steps, 40);
  const run1 = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `w${++seq}`, model: 'codex:gpt', job: { checkpoint: cp.id } });
  const ctx1 = { run: run1, state: {}, presence: false, maxSteps: a1.limits.steps };
  tools(ctx1, 25);
  assert.equal(store.getRun(run1.id).status, 'running');
  store.updateRun(run1.id, { status: 'success', token: null, ended_at: store.now() });
  dw.chargeJob(cp.id, store.getRun(run1.id), ctx1.state.steps);
  assert.equal(store.getCheckpoint(cp.id).steps_used, 25);
  // Attempt 2 gets what is left (15). Its request after the 15th step is the 16th: refused before it is carried out.
  const a2 = dw.admit(store.getCheckpoint(cp.id), plan);
  assert.equal(a2.limits.steps, 15);
  const run2 = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `w${++seq}`, model: 'codex:gpt', job: { checkpoint: cp.id } });
  const ctx2 = { run: run2, state: {}, presence: false, maxSteps: a2.limits.steps };
  tools(ctx2, 15);
  assert.equal(store.getRun(run2.id).status, 'running', '15 steps: within what was left');
  await assert.rejects(sched.deskAction(store.getRun(run2.id), 'watch', { action: 'verified', body: 'healthy after the deploy' }), /used its 15 steps/);
  assert.deepEqual([store.getRun(run2.id).status, store.getRun(run2.id).result_text], ['killed', 'step limit (15)']);
  assert.notEqual(store.getCheckpoint(cp.id).verdict, 'verified', 'no verdict past the allowance');
  dw.chargeJob(cp.id, store.getRun(run2.id), 16);
  const a3 = dw.admit(store.getCheckpoint(cp.id), plan);
  assert.equal(a3.exhausted, true, 'nothing is left for a third attempt');
  // A dollar-capped engine's allowance is dollars: its steps are counted, never stopped.
  const run3 = store.createRun({ agent_id: 'sre', kind: 'watch', ticket_key: t.key, token: `w${++seq}`, model: 'claude:opus', job: { checkpoint: cp.id } });
  const ctx3 = { run: run3, state: {}, presence: false };
  tools(ctx3, 100);
  assert.deepEqual([store.getRun(run3.id).status, ctx3.state.steps], ['running', 100]);
  store.updateRun(run3.id, { status: 'success', token: null, ended_at: store.now() });
});
