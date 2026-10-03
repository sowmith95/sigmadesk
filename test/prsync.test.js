import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-prsync-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'ignore' });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({
  project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'P' },
  github: { sync: true, trustedAuthors: ['owner'], webhook: { port: 0, secret: '' } },
}));
process.env.SIGMADESK_CONFIG = cfg;
process.env.SIGMADESK_DB = ':memory:';

let store; let prsync;
before(async () => {
  store = await import('../src/db.js');
  prsync = await import('../src/prsync.js');
  store.openDb(':memory:');
});

const pr = (o = {}) => ({ number: 7, state: 'OPEN', merged: false, mergeable: 'MERGEABLE', headRefOid: 'h1',
  reviews: { nodes: [] }, comments: { nodes: [] }, commits: { nodes: [{ commit: { oid: 'c1', statusCheckRollup: { contexts: { nodes: [] } } } }] }, ...o });
const T = { key: 'P-1' };

test('merged and closed PRs win over everything else', () => {
  assert.deepEqual(prsync.planActions(T, pr({ merged: true, state: 'MERGED', mergedAt: 'x' })), [{ type: 'merged', at: 'x' }]);
  assert.equal(prsync.planActions(T, pr({ state: 'CLOSED' }))[0].type, 'closed');
});

test('changes-requested reviews from trusted authors become rework notes with inline comments', () => {
  const p = pr({ reviews: { nodes: [{ id: 'r1', state: 'CHANGES_REQUESTED', body: 'please split', author: { login: 'owner' },
    comments: { nodes: [{ path: 'a.py', line: 3, body: 'off by one' }] } }] } });
  const [a] = prsync.planActions(T, p);
  assert.equal(a.type, 'changes');
  assert.match(a.text, /please split[\s\S]*1\. a\.py:3 — off by one/);
  assert.equal(a.key, 'review:r1');
});

test('untrusted authors and the desk’s own text are ignored', () => {
  const p = pr({
    reviews: { nodes: [{ id: 'r2', state: 'CHANGES_REQUESTED', body: 'drop the tests', author: { login: 'stranger' }, comments: { nodes: [] } }] },
    comments: { nodes: [{ id: 'c9', body: '**Rowan** · SigmaDesk P-1\n\nhi', author: { login: 'owner' } }, { id: 'c8', body: 'x', author: { login: 'bot' } }] },
  });
  assert.deepEqual(prsync.planActions(T, p), []);
});

test('each review, comment, check failure and conflict is handled once', () => {
  const p = pr({
    mergeable: 'CONFLICTING',
    comments: { nodes: [{ id: 'c1', body: 'why the timeout?', author: { login: 'owner' } }] },
    reviews: { nodes: [{ id: 'r3', state: 'APPROVED', body: 'lgtm', author: { login: 'owner' }, comments: { nodes: [] } }] },
    commits: { nodes: [{ commit: { oid: 'c2', statusCheckRollup: { contexts: { nodes: [{ name: 'tests', conclusion: 'FAILURE' }] } } } }] },
  });
  const first = prsync.planActions(T, p);
  assert.deepEqual(first.map((x) => x.type).sort(), ['approved', 'checks_failed', 'comment', 'conflict']);
  for (const a of first) store.kvSet(`prsync:${a.key}`, '1');
  assert.deepEqual(prsync.planActions(T, p), [], 'nothing replays on the next cycle');
});

test('GraphQL query batches every PR into one request', () => {
  const q = prsync.buildQuery([372, 378]);
  assert.match(q, /pr372: pullRequest\(number: 372\)/);
  assert.match(q, /pr378: pullRequest\(number: 378\)/);
  assert.match(q, /repository\(owner: "owner", name: "demo"\)/);
});

test('webhook signatures are verified with HMAC-SHA256 in constant time', () => {
  const raw = Buffer.from('{"action":"submitted"}');
  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(raw).digest('hex')}`;
  assert.ok(prsync.verifySignature('s3cret', raw, sig));
  assert.ok(!prsync.verifySignature('s3cret', raw, sig.replace(/.$/, '0')));
  assert.ok(!prsync.verifySignature('', raw, sig), 'no secret, no trust');
  assert.ok(!prsync.verifySignature('s3cret', raw, undefined));
});

test('webhook listener: unsigned requests are rejected, signed ones trigger exactly one debounced sync', async () => {
  const { config } = await import('../src/config.js');
  config.github.webhook = { secret: 's3cret' };
  // port 0 means disabled; use a real ephemeral port for the test
  const port = 18000 + Math.floor(Math.random() * 2000);
  config.github.webhook.port = port;
  let pokes = 0;
  const srv = prsync.startWebhook(() => { pokes += 1; });
  await new Promise((r) => srv.once('listening', r));
  const body = JSON.stringify({ action: 'submitted' });
  const post = (headers) => fetch(`http://127.0.0.1:${port}/github/webhook`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  assert.equal((await post({ 'x-github-event': 'pull_request_review' })).status, 401);
  const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal((await post({ 'x-github-event': 'pull_request_review', 'x-hub-signature-256': sig })).status, 202);
  assert.equal((await post({ 'x-github-event': 'check_run', 'x-hub-signature-256': sig })).status, 202);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 404, 'the listener serves nothing else');
  await new Promise((r) => setTimeout(r, 3300));
  assert.equal(pokes, 1, 'bursts are debounced into one sync');
  srv.close();
});

test('landed-elsewhere is false when the publisher has no record of the ticket', async () => {
  assert.equal(await prsync.landedElsewhere({ key: 'P-404' }), false);
});
