// Which CI applies to a PR, and what the merge gate does when no CI covers the files it changes (PR #410, SD-23).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-ci-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { name: 'demo', repoPath: repo, githubRepo: 'owner/demo', ticketPrefix: 'Q' }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_DB = ':memory:';
let prs, wf, store;
before(async () => { store = await import('../src/db.js'); store.openDb(':memory:'); prs = await import('../src/prs.js'); wf = await import('../src/workflows.js'); });

const CI = { file: '.github/workflows/cicd.yml', text: `name: CI Tests
on:
  push:
    branches: [ '*' ]
    paths: [ 'alpaca_trader/**' ]
  pull_request:
    branches: [ main ]
    paths:
      - 'alpaca_trader/**'
      - 'scenario_research/**'
      - '!alpaca_trader/ingestor/**'
  workflow_dispatch:
jobs:
  test:
    name: Run tests (alpaca_trader)
` };
const PREREQ = { file: '.github/workflows/prerequisite-checker.yml', text: `name: Prerequisite Checker
on:
  schedule:
    - cron: '0 */6 * * *'
  issues:
    types: [opened]
jobs: {}
` };
const DEPLOY = { file: '.github/workflows/deploy-mac-mini.yml', text: 'name: Deploy\non:\n  push:\n    branches: [main]\njobs: {}\n' };
const checkFiles = { 'Run tests (alpaca_trader)': [CI.file], 'check-prerequisites': [PREREQ.file], deploy: [DEPLOY.file] };
const PR = (rollup = []) => ({ state: 'OPEN', headRefOid: 'a'.repeat(40), baseRefName: 'main', mergeable: 'MERGEABLE', statusCheckRollup: rollup });

test('pull_request triggers honour branches, paths and exclusions', () => {
  const ci = wf.parseWorkflow(CI.text);
  assert.equal(wf.pullRequestTriggers(ci, 'main', ['alpaca_trader/app.py']), true);
  assert.equal(wf.pullRequestTriggers(ci, 'main', ['ui-trader/src/x.ts', 'docs/a.md']), false);
  assert.equal(wf.pullRequestTriggers(ci, 'main', ['alpaca_trader/ingestor/x.py']), false);
  assert.equal(wf.pullRequestTriggers(ci, 'release', ['alpaca_trader/app.py']), false);
  assert.equal(wf.pullRequestTriggers(wf.parseWorkflow('on: [push, pull_request]\n'), 'main', ['x']), true);
  assert.equal(wf.hasPullRequestTrigger(wf.parseWorkflow(PREREQ.text)), false);
});

test('a UI-only PR: the alpaca check does not apply, no workflow fires, so it is uncovered', () => {
  const cov = prs.ciCoverage({ required: Object.keys(checkFiles), files: ['ui-trader/src/x.test.ts', 'docs/n.md'], workflows: [CI, PREREQ, DEPLOY], checkFiles });
  assert.deepEqual(cov.applicable, []);
  assert.equal(cov.uncovered, true); assert.deepEqual(cov.areas, ['ui-trader', 'docs']);
  assert.equal(cov.rows.find((r) => r.name === 'Run tests (alpaca_trader)').state, 'not_run_for_files');
  // A backend change: the check applies and is waiting until CI reports.
  const be = prs.ciCoverage({ required: ['Run tests (alpaca_trader)'], files: ['alpaca_trader/app.py'], workflows: [CI], checkFiles });
  assert.deepEqual(be.applicable, ['Run tests (alpaca_trader)']); assert.equal(be.uncovered, false); assert.equal(be.rows[0].state, 'waiting');
  // Unknown workflows: never uncovered, the check stays required.
  const unknown = prs.ciCoverage({ required: ['Run tests (alpaca_trader)'], files: ['ui-trader/x.ts'], workflows: null, checkFiles });
  assert.equal(unknown.uncovered, false); assert.deepEqual(unknown.applicable, ['Run tests (alpaca_trader)']);
});

test('the owner can merge an uncovered PR with a reason; the desk itself never can; red or missing applicable CI still blocks', () => {
  const cov = prs.ciCoverage({ required: Object.keys(checkFiles), files: ['ui-trader/x.ts'], workflows: [CI, PREREQ, DEPLOY], checkFiles });
  const args = { expectedSha: 'a'.repeat(40), required: cov.applicable, uncovered: cov };
  const blocked = prs.authorizeMerge(PR(), { ...args, actor: 'owner' });
  assert.match(blocked.blockers.join(' '), /no CI workflow runs for the files this PR changes \(ui-trader\)/);
  assert.match(blocked.blockers.join(' '), /owner override reason/);
  const ok = prs.authorizeMerge(PR(), { ...args, actor: 'owner', overrideReason: 'UI-only test file; ui-trader has no PR CI yet' });
  assert.deepEqual(ok.blockers, []); assert.equal(ok.overridden.length, 1);
  assert.ok(prs.authorizeMerge(PR(), { ...args, actor: 'desk', overrideReason: 'x'.repeat(40) }).blockers.length, 'auto-merge never overrides');
  const backend = prs.authorizeMerge(PR(), { expectedSha: 'a'.repeat(40), actor: 'owner', overrideReason: 'x'.repeat(40), required: ['Run tests (alpaca_trader)'], uncovered: null });
  assert.match(backend.blockers.join(' '), /no CI result has been reported|never reported/);
  const red = prs.authorizeMerge(PR([{ name: 'Run tests (alpaca_trader)', conclusion: 'FAILURE' }]), { ...args, actor: 'owner', overrideReason: 'x'.repeat(40) });
  assert.match(red.blockers.join(' '), /CI is failing/);
});

test('auto-learned checks that only come from non-PR workflows are pruned; owner lists are never touched', () => {
  prs.setRequiredChecks(['Run tests (alpaca_trader)', 'check-prerequisites', 'sync', 'deploy'], 'auto');
  prs.pruneImpossibleChecks(['check-prerequisites', 'sync', 'deploy']);
  assert.deepEqual(prs.requiredChecks().names, ['Run tests (alpaca_trader)']);
  prs.setRequiredChecks(['Run tests (alpaca_trader)', 'deploy'], 'owner');
  prs.pruneImpossibleChecks(['deploy']);
  assert.deepEqual(prs.requiredChecks().names, ['Run tests (alpaca_trader)', 'deploy']);
});
