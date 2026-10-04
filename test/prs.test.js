import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-prs-'));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
// A fake `gh` that records every call and answers like GitHub would.
const log = path.join(tmp, 'gh.log');
const ghState = path.join(tmp, 'pr.json');
const fakeGh = path.join(tmp, 'gh');
fs.writeFileSync(fakeGh, `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "pr view") cat ${ghState} ;;
  "pr review") echo "GraphQL: Can not approve your own pull request (addPullRequestReview)" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'Q' }, bins: { gh: fakeGh }, github: { sync: true } }));
process.env.SIGMADESK_CONFIG = cfg;
process.env.SIGMADESK_DB = ':memory:';

let prs; let ui; let store;
const setPr = (o) => fs.writeFileSync(ghState, JSON.stringify({ number: 9, title: '[Q-1] thing', state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE',
  headRefOid: 'abc123', body: 'Opened by SigmaDesk', statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...o }));
const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
before(async () => {
  store = await import('../src/db.js');
  store.openDb(':memory:');
  prs = await import('../src/prs.js');
  ui = await import('../public/prs.js');
});

test('CI state rolls up checks', () => {
  assert.equal(prs.checksState([]), 'none');
  assert.equal(prs.checksState([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passing');
  assert.equal(prs.checksState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(prs.checksState([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing');
});

test('merge blockers: state, conflicts, CI, and the market-hours window', () => {
  const ok = { state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
  assert.deepEqual(prs.mergeBlockers(ok), []);
  assert.match(prs.mergeBlockers({ ...ok, mergeable: 'CONFLICTING' })[0], /conflicts/);
  assert.match(prs.mergeBlockers({ ...ok, statusCheckRollup: [{ conclusion: 'FAILURE' }] })[0], /failing/);
  assert.match(prs.mergeBlockers({ ...ok, statusCheckRollup: [{ status: 'QUEUED' }] })[0], /still running/);
  assert.match(prs.mergeBlockers({ ...ok, state: 'MERGED' })[0], /merged/);
  assert.match(prs.mergeBlockers(ok, { inBusyWindow: true })[0], /deploys production/);
  assert.deepEqual(prs.mergeBlockers(ok, { inBusyWindow: true, override: 'Merge during market hours' }), []);
});

test('approve falls back to comment + owner-approved label when GitHub blocks self-approval', async () => {
  setPr({});
  const r = await prs.approve(9, 'looks right');
  assert.equal(r.mode, 'label');
  const c = calls().join('\n');
  assert.match(c, /pr edit 9 -R owner\/demo --add-label owner-approved/);
  assert.match(c, /pr comment 9 -R owner\/demo --body/);
});

test('merge readies a draft and merges exactly the checked head commit', async () => {
  fs.rmSync(log, { force: true });
  setPr({});
  await prs.merge(9, { method: 'squash' });
  const c = calls();
  assert.ok(c.some((l) => l.startsWith('pr ready 9')));
  assert.ok(c.some((l) => /^pr merge 9 -R owner\/demo --squash --delete-branch --match-head-commit abc123$/.test(l)), c.join('\n'));
});

test('merge refuses red, conflicting or out-of-window PRs without calling merge', async () => {
  fs.rmSync(log, { force: true });
  setPr({ statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  await assert.rejects(prs.merge(9, {}), /CI is failing/);
  setPr({});
  await assert.rejects(prs.merge(9, { inBusyWindow: true }), /market hours/);
  assert.ok(!calls().some((l) => l.startsWith('pr merge')));
});

test('the console only acts on SigmaDesk PRs and validates inputs', async () => {
  setPr({ body: 'someone else wrote this' });
  await assert.rejects(prs.close(9), /not a SigmaDesk PR/);
  await assert.rejects(prs.addReviewer(9, 'bad login; rm -rf /'), /reviewer must be/);
  await assert.rejects(prs.setTags(9, { add: ['!!!'] }), /no valid tags/);
  await assert.rejects(prs.merge(9, { method: 'yolo' }), /method must be/);
});

test('UI filters: active by default, by seat, tag and search', () => {
  const rows = [
    { number: 1, state: 'OPEN', draft: true, owner_approved: false, seat: 'junior', requester: 'pm', tags: ['dst'], title: 'a', branch: 'x', key: 'Q-1' },
    { number: 2, state: 'MERGED', draft: false, seat: 'senior-be', requester: 'sre', tags: [], title: 'b', branch: 'y', key: 'Q-2' },
    { number: 3, state: 'OPEN', draft: false, owner_approved: true, seat: 'junior', requester: 'sre', tags: ['whale'], title: 'c', branch: 'z', key: 'Q-3' },
  ];
  assert.deepEqual(ui.filterRows(rows, { state: 'active' }).map((r) => r.number), [1, 3]);
  assert.deepEqual(ui.filterRows(rows, { state: 'merged' }).map((r) => r.number), [2]);
  assert.deepEqual(ui.filterRows(rows, { state: 'all', seat: 'junior', tag: 'whale' }).map((r) => r.number), [3]);
  assert.deepEqual(ui.filterRows(rows, { state: 'all', q: 'q-2' }).map((r) => r.number), [2]);
  assert.equal(ui.stateOf(rows[2]), 'approved');
});

test('PR console links only to https github.com', async () => {
  const { safeGithubUrl } = await import('../public/prs.js');
  assert.equal(safeGithubUrl('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(safeGithubUrl('javascript:alert(1)'), null);
  assert.equal(safeGithubUrl('https://github.com.evil.io/o/r/pull/1'), null);
  assert.equal(safeGithubUrl('http://github.com/o/r/pull/1'), null);
});
