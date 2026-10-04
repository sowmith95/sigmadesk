// Contributors are recorded when a seat PICKS UP a ticket (not only on submit): an author interrupted or reassigned
// before submitting can never become one of its reviewers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-pickup-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'i']);
const fakeClaude = path.join(tmp, 'claude'); // a "model" that ends at once without doing anything
fs.writeFileSync(fakeClaude, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo, ticketPrefix: 'P' }, github: { sync: false }, pm: { enabled: false }, bins: { claude: fakeClaude }, sandbox: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'ws');
let store, sched, reviews, dispatch, config;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp; config.dataDir = path.join(tmp, 'data');
  store = await import('../src/db.js'); store.openDb(':memory:');
  dispatch = await import('../src/dispatch.js'); dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: false }]);
  sched = await import('../src/scheduler.js'); reviews = await import('../src/reviews.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('picking up a ticket makes the seat a contributor before any submission', async () => {
  const t = store.createTicket({ title: 'Picked up then interrupted', type: 'bug', status: 'todo', area: 'frontend', complexity: 'M', assignee: 'senior-fe' });
  store.setSetting('paused', 'false');
  await sched.tick();
  for (let i = 0; i < 100 && !store.contributorsOf({ contributors: store.getTicket(t.key).contributors }).has('senior-fe'); i++) await new Promise((r) => setTimeout(r, 30));
  store.setSetting('paused', 'true');
  assert.ok(store.contributorsOf({ contributors: store.getTicket(t.key).contributors }).has('senior-fe'));
  // reassigned to someone else who submits: the first author is still excluded from reviewing
  const after = { ...store.getTicket(t.key), assignee: 'junior', builder: 'junior', designer: null };
  assert.notEqual(reviews.selectReviewers(after).independent, 'senior-fe', 'the interrupted first author is excluded');
  for (let i = 0; i < 100 && store.getAgentState('senior-fe').status === 'working'; i++) await new Promise((r) => setTimeout(r, 30));
});
