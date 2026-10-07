// The decision snapshot (sowmith95/sigmadesk#6): what approving does (detected workflows; a deploy target only from
// deploy.targets), the ordered gate, evidence freshness with stale/unknown said plainly, and the server side: briefs
// embedded in the snapshot, and "Verify in production" on a closed ticket filing ONE linked task without reopening it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as M from '../src/decision-model.js';

const NOW = Date.parse('2026-10-07T15:00:00Z');
const H = 'a17c0de9b1', OLD = '4be91c2aa0';
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const WF = [{ file: '.github/workflows/deploy-mac-mini.yml', name: 'Deploy Mac Mini', reason: 'runs on push to main' }, { file: '.github/workflows/ci.yml', name: 'CI', reason: 'runs on push to main' }];

test('consequence: detected workflows; a target only from deploy.targets; unknown and not-checked said plainly; workflow edits called out', () => {
  const none = M.deployConsequence({ state: 'none', workflows: [] });
  assert.equal(none.state, 'none'); assert.match(none.steps[0].text, /nothing redeploys/);
  const unmapped = M.deployConsequence({ state: 'deploys', workflows: WF });
  assert.equal(unmapped.target, 'unknown');
  assert.deepEqual(unmapped.workflows, ['Deploy Mac Mini', 'CI']);
  assert.match(unmapped.steps.map((s) => s.text).join(' '), /Deployment target unknown/);
  const mapped = M.deployConsequence({ state: 'deploys', workflows: WF }, { targets: { 'deploy-mac-mini.yml': 'alpaca-trader', 'ci.yml': [] } });
  assert.equal(mapped.target, 'partial', 'a workflow without a (non-empty) entry keeps the target partly unknown');
  assert.deepEqual(mapped.targets, ['alpaca-trader']);
  const all = M.deployConsequence({ state: 'deploys', workflows: [WF[0]] }, { targets: { 'deploy-mac-mini.yml': 'alpaca-trader' } });
  assert.equal(all.target, 'known'); assert.match(all.steps[1].text, /Redeploys alpaca-trader/);
  assert.equal(M.deployConsequence(null).state, 'unknown');
  assert.match(M.deployConsequence(null).steps[0].text, /Not checked yet/);
  assert.match(M.deployConsequence({ state: 'unknown', workflows: [], reason: 'the changed files are unknown' }).steps[0].text, /unknown \(the changed files are unknown\)/);
  const edits = M.deployConsequence({ state: 'deploys', workflows: [WF[0]] }, { files: ['app/x.py', '.github/workflows/deploy-mac-mini.yml'] });
  assert.deepEqual(edits.workflow_changes, ['.github/workflows/deploy-mac-mini.yml']);
  assert.match(edits.steps.at(-1).text, /edits 1 workflow file \(deploy-mac-mini\.yml\)/);
});

test('evidence freshness: QA, reviews and CI each current, stale or unknown for the commit on screen', () => {
  assert.equal(M.qaEvidence({ head: H, qaSha: H, qaAt: at(30), now: NOW }).state, 'current');
  assert.match(M.qaEvidence({ head: H, qaSha: H, qaAt: at(30), now: NOW }).text, /QA passed a17c0de 30 min ago/);
  assert.equal(M.qaEvidence({ head: H, qaSha: OLD, now: NOW }).state, 'stale');
  assert.equal(M.qaEvidence({ head: H, qaSha: null, now: NOW }).state, 'none');
  assert.equal(M.qaEvidence({ head: null, now: NOW }).state, 'unknown');
  const ok = M.reviewEvidence({ head: H, ok: true, context: { seat: 'manager', verdict: 'approve', updated_at: at(20) }, independent: { seat: 'principal-be', verdict: 'approve', updated_at: at(10) }, now: NOW });
  assert.equal(ok.state, 'current'); assert.match(ok.text, /2 approvals at a17c0de \(manager and principal-be\) 10 min ago/);
  assert.equal(M.reviewEvidence({ head: H, ok: false, context: { seat: 'manager', verdict: 'approve' }, now: NOW }).state, 'none');
  assert.equal(M.reviewEvidence({ head: H, inFlow: false }).flow, false);
  assert.equal(M.ciEvidence({ head: H, ci: null }).state, 'unknown');
  assert.equal(M.ciEvidence({ head: H, ci: { sha: OLD, checks: 'passing', at: at(5) }, now: NOW }).state, 'stale');
  const cur = M.ciEvidence({ head: H, ci: { sha: H, checks: 'passing', at: at(5) }, now: NOW });
  assert.equal(cur.state, 'current'); assert.equal(cur.age_minutes, 5);
  assert.equal(M.ciEvidence({ head: H, ci: { sha: H, checks: 'passing', at: at(180) }, now: NOW }).state, 'old');
});

test('merge gate: ordered QA → reviews → CI → deploy window → policy; the busy window blocks only what deploys', () => {
  const qa = M.qaEvidence({ head: H, qaSha: H, qaAt: at(30), now: NOW });
  const reviews = { state: 'current', text: '2 approvals' };
  const ci = M.ciEvidence({ head: H, ci: { sha: H, checks: 'passing', at: at(5) }, now: NOW });
  const dep = M.deployConsequence({ state: 'deploys', workflows: WF });
  const g = M.mergeGate({ qa, reviews, ci, deploy: dep, busy: true, windowEnd: '4:15 PM ET', policy: { eligible: false, reason: 'the ticket is marked high-risk' } });
  assert.deepEqual(g.items.map((i) => i.id), ['qa', 'reviews', 'ci', 'deploy_window', 'policy']);
  assert.equal(g.state, 'blocked'); assert.match(g.headline, /^Deploy window: Inside the busy window until 4:15 PM ET/);
  assert.equal(g.items.at(-1).state, 'yours');
  const quiet = M.mergeGate({ qa, reviews, ci, deploy: M.deployConsequence({ state: 'none', workflows: [] }), busy: true, policy: { eligible: false, reason: 'x' } });
  assert.equal(quiet.state, 'ready', 'nothing deploys: the busy window does not apply');
  const stale = M.mergeGate({ qa: M.qaEvidence({ head: H, qaSha: OLD }), reviews, ci: M.ciEvidence({ head: H, ci: null }), deploy: dep, busy: false, policy: { eligible: true } });
  assert.equal(stale.items[0].state, 'blocked'); assert.equal(stale.items[2].state, 'unknown');
  const lock = M.mergeGate({ qa, reviews, ci, deploy: dep, busy: false, lock: { key: 'SD-9', state: 'failed' }, policy: { eligible: true } });
  assert.ok(lock.items.some((i) => i.id === 'deploy_lock' && i.state === 'blocked'));
  assert.equal(M.publishGate({ qa, githubSync: true, draftPrs: false }).state, 'blocked', 'draft PRs off: approving pushes nothing');
});

test('brief: "you decide", consequence, releases, wait from the decision start, gate, freshness and what stays yours; no blanket production copy', () => {
  const ticket = { key: 'SD-4', title: 'Preserve review contracts', status: 'ready_for_human', head_sha: H, qa_sha: H, pr_url: 'https://github.com/x/y/pull/12', risk: 'high', diff_risk: 'high' };
  const d = { id: 'SD-4:merge', key: 'SD-4', kind: 'merge', name: 'Review contracts', verb: 'Merge Review contracts', ticket };
  const b = M.brief({ decision: d, ticket, now: NOW, since: at(190), releases: [{ key: 'SD-7', name: 'Model switch', status: 'todo' }], qaAt: at(60),
    reviews: { ok: true, context: { seat: 'manager', verdict: 'approve', updated_at: at(40) }, independent: { seat: 'principal-be', verdict: 'approve', updated_at: at(35) } },
    ci: { sha: H, checks: 'passing', at: at(4) }, deploy: { state: 'deploys', workflows: [WF[0]] }, targets: { 'deploy-mac-mini.yml': 'alpaca-trader' },
    busy: false, policy: { eligible: false, reason: 'the ticket is marked high-risk' }, pr: 12, policyVersion: 'abc' });
  assert.equal(b.you_decide, 'Merge Review contracts into main');
  assert.equal(b.consequence.summary, 'Merges PR #12 into main → starts Deploy Mac Mini → redeploys alpaca-trader');
  assert.equal(b.wait.text, 'waiting 3 h'); assert.equal(b.wait.since, at(190));
  assert.match(b.releases.text, /Unblocks 1 task: Model switch/);
  assert.equal(b.gate.state, 'ready'); assert.equal(b.evidence.qa.state, 'current'); assert.equal(b.evidence.ci.state, 'current');
  assert.match(b.human.join(' '), /Watching the deploy/);
  assert.equal(b.policy_version, 'abc');
  assert.doesNotMatch(JSON.stringify(b), /deploys production/i);
  const unknownTarget = M.brief({ decision: d, ticket, now: NOW, deploy: { state: 'deploys', workflows: [WF[0]] } });
  assert.match(unknownTarget.consequence.summary, /deployment target unknown$/);
  assert.match(unknownTarget.human.join(' '), /no deploy.targets mapping/);
  const q = M.brief({ decision: { id: 'SD-5:question', key: 'SD-5', kind: 'question', verb: 'Answer Morgan', worker: null }, ticket: { key: 'SD-5', status: 'needs_human', assignee: 'manager' }, now: NOW, nameOf: () => 'Morgan' });
  assert.match(q.consequence.summary, /Morgan resumes/); assert.equal(q.wait.text, 'waiting time unknown');
  const what = M.beforeMerge({ ticket: { ...ticket, status: 'review' }, qa: b.evidence.qa, reviews: { state: 'none', text: '1 of 2' }, ci: b.evidence.ci, policy: { eligible: false, reason: 'high risk' } });
  assert.equal(what.steps.find((s) => s.id === 'reviews').state, 'now'); assert.match(what.text, /next: two code reviews approve it/);
  assert.equal(M.beforeMerge({ ticket: { ...ticket, status: 'done' } }).closed, true);
});

// ---------------- server side ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-decision-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'f']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false }, ops: { enabled: true }, deploy: { targets: { 'deploy.yml': 'api' } } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let store, decision, server;
before(async () => {
  const { config } = await import('../src/config.js'); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  decision = await import('../src/decision.js'); server = await import('../src/server.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the snapshot embeds one brief per decision, keyed by decision id, with the cached deploy facts for the current commit only', () => {
  const t = store.createTicket({ title: 'Merge me', status: 'ready_for_human', assignee: 'senior-be' });
  store.updateTicket(t.key, { pr_url: 'https://github.com/x/y/pull/3', head_sha: H, qa_sha: H, risk: 'high' });
  store.kvSet(`decision:deploy:${t.key}`, JSON.stringify({ head: OLD, base: null, state: 'deploys', workflows: [{ file: '.github/workflows/deploy.yml', name: 'Deploy' }], at: store.now() }));
  let snap = server.snapshot();
  const id = `${t.key}:merge`;
  assert.ok(snap.meta.decision_briefs[id], 'a brief for the merge decision');
  assert.equal(snap.meta.decision_briefs[id].consequence.deploy.state, 'unknown', 'deploy facts for another commit are not used');
  store.kvSet(`decision:deploy:${t.key}`, JSON.stringify({ head: H, base: null, state: 'deploys', workflows: [{ file: '.github/workflows/deploy.yml', name: 'Deploy' }], at: store.now() }));
  snap = server.snapshot();
  const b = snap.meta.decision_briefs[id];
  assert.equal(b.consequence.deploy.target, 'known'); assert.deepEqual(b.consequence.deploy.targets, ['api']);
  assert.equal(b.evidence.ci.state, 'unknown', 'CI never read: unknown, not green');
  assert.ok(b.wait.since, 'the wait starts when the decision first appeared');
  assert.equal(b.wait.since, snap.meta.waiting_since[id]);
});

test('Verify in production on a merged ticket: one linked task, idempotent, the ticket stays merged; refused with the reason when nobody can read production', async () => {
  const sched = await import('../src/scheduler.js');
  const t = store.createTicket({ title: 'Shipped thing', status: 'done', assignee: 'senior-be' });
  store.updateTicket(t.key, { pr_url: 'https://github.com/x/y/pull/4' });
  store.setSetting('ops_enabled', 'false');
  assert.equal(sched.verifyReady(), false);
  assert.throws(() => decision.verifyTask(t.key), (e) => e.code === 'verify_unavailable' && /Nothing was filed/.test(e.message) && /stays merged/.test(e.message));
  store.setSetting('ops_enabled', 'true');
  const first = decision.verifyTask(t.key, { what: 'fills count matches' });
  assert.equal(first.duplicate, false); assert.equal(first.ticket.assignee, 'sre'); assert.equal(store.kvGet(`verify:${first.ticket.key}`), '1');
  assert.match(first.ticket.description, /fills count matches/);
  const again = decision.verifyTask(t.key);
  assert.equal(again.duplicate, true); assert.equal(again.ticket.key, first.ticket.key);
  assert.equal(store.getTicket(t.key).status, 'done', 'never reopened');
  assert.match(store.listComments(t.key).at(-1).body, new RegExp(`Filed ${first.ticket.key}`));
  const open = store.createTicket({ title: 'Still open', status: 'todo' });
  assert.throws(() => decision.verifyTask(open.key), (e) => e.code === 'ticket_open');
  store.updateTicket(first.ticket.key, { status: 'done' });
  assert.notEqual(decision.verifyTask(t.key).ticket.key, first.ticket.key, 'after the check finished, asking again files a new one');
});
