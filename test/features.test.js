// Features: Codex grooming rounds, owner approval, task creation, holds and the product-review waiver.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-features-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'fixture');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: repo }, github: { sync: false, openDraftPrs: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
let store, sched, features, productReview, dispatch;
before(async () => {
  const { config } = await import('../src/config.js'); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  sched = await import('../src/scheduler.js'); features = await import('../src/features.js');
  productReview = await import('../src/product-review.js'); dispatch = await import('../src/dispatch.js');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PLAN = {
  summary: 'Record option fill costs observe-only.', goal: 'Know what fills cost, for the owner.', users: ['Owner reviewing ETF4 fills'],
  scope: ['Journal table', 'Writer'], out_of_scope: ['Any trading change'], acceptance: ['Every fill has a cost row'], risks: ['Writes in the trading path'], questions: [],
  tasks: [
    { ref: 'T1', title: 'Define the journal contract', area: 'db', complexity: 'S', risk: 'low', after: null, description: 'Draft DDL and contract.', acceptance: ['DDL reviewed'] },
    { ref: 'T2', title: 'Write fills observe-only', area: 'backend', complexity: 'M', risk: 'high', after: 'T1', description: 'Writer behind a flag.', acceptance: ['No order path touched'] },
  ],
};
// Simulates the Codex run finishing: grooming status with a known attempt, then complete().
function groomed(key, plan = PLAN, attempt = 'a1') {
  const p = features.current(key);
  store.kvSet(`feature-plan:${key}`, JSON.stringify({ ...p, stale: undefined, status: 'grooming', attempt }));
  return features.complete(key, p.revision, attempt, { plan: features.parsePlan(JSON.stringify(plan)), run_id: 7, model: 'codex:fixture' });
}

test('a new feature skips triage, queues a Codex round, and is held from every pickup path until approved', () => {
  const { ticket, plan } = features.create({ title: 'Fill-cost journal', goal: 'Record what each ETF4 fill costs.', priority: 'P1' });
  assert.equal(ticket.type, 'feature'); assert.equal(ticket.status, 'proposed'); assert.equal(plan.status, 'queued'); assert.equal(plan.engine, 'codex');
  assert.equal(features.holds(ticket), true);
  assert.equal(features.next().ticket_key, ticket.key);
  assert.throws(() => features.start(ticket.key), /already running/);
  assert.throws(() => features.create({ title: 'x' }), /Describe/);
});

test('plans are validated: small or medium tasks, known areas, earlier dependencies only', () => {
  assert.equal(features.parsePlan('```json\n' + JSON.stringify(PLAN) + '\n```').tasks.length, 2);
  const bad = (tasks) => assert.throws(() => features.parsePlan(JSON.stringify({ ...PLAN, tasks })));
  bad([{ ...PLAN.tasks[0], complexity: 'L' }]);
  bad([{ ...PLAN.tasks[0], area: 'mobile' }]);
  bad([PLAN.tasks[1], PLAN.tasks[0]]); // T2 depends on a later task
  bad(Array.from({ length: 9 }, (_, i) => ({ ...PLAN.tasks[0], ref: `T${i + 1}` })));
  assert.throws(() => features.parsePlan('no json here'), /did not return a JSON plan/);
});

test('only the running attempt can finish a round; a ready plan posts a summary to the thread', () => {
  const { ticket } = features.create({ title: 'Attempt fencing', goal: 'Late results are ignored.' });
  const p = features.current(ticket.key);
  store.kvSet(`feature-plan:${ticket.key}`, JSON.stringify({ ...p, stale: undefined, status: 'grooming', attempt: 'new' }));
  assert.equal(features.complete(ticket.key, p.revision, 'old', { plan: features.parsePlan(JSON.stringify(PLAN)) }), null);
  assert.equal(features.current(ticket.key).status, 'grooming');
  assert.equal(features.complete(ticket.key, p.revision, 'new', { plan: features.parsePlan(JSON.stringify(PLAN)) }).status, 'ready');
  assert.match(store.listComments(ticket.key).at(-1).body, /Plan ready/);
});

test('approval creates ordered tasks with the feature context, starts the feature, waives the plan review, and cannot repeat', () => {
  const { ticket } = features.create({ title: 'Fill-cost journal', goal: 'Record what each ETF4 fill costs.\n\nKeep it observe-only.' });
  const ready = groomed(ticket.key);
  assert.throws(() => features.approve(ticket.key, { expected_revision: ready.revision + 1 }), { status: 409 });
  assert.throws(() => features.approve(ticket.key, { expected_revision: ready.revision, edits: [{ ref: 'T1', include: false }] }), /keep both or drop both/);
  assert.throws(() => features.approve(ticket.key, { expected_revision: ready.revision, edits: [{ ref: 'T1', include: false }, { ref: 'T2', include: false }] }), /at least one/);
  const out = features.approve(ticket.key, { expected_revision: ready.revision, edits: [{ ref: 'T2', title: 'Journal writer (observe-only)' }] });
  assert.equal(out.tasks.length, 2);
  const [a, b] = out.tasks.map((k) => store.getTicket(k));
  assert.equal(a.parent_key, ticket.key); assert.equal(b.after_key, a.key); assert.equal(b.title, 'Journal writer (observe-only)'); assert.equal(b.risk, 'high');
  assert.match(b.description, /Part of feature .*Fill-cost journal[\s\S]*Every fill has a cost row/);
  const f = store.getTicket(ticket.key);
  assert.equal(f.status, 'in_progress'); assert.equal(f.assignee, 'manager');
  assert.equal(features.requestOf(f.description), 'Record what each ETF4 fill costs.\n\nKeep it observe-only.', 'the owner text is untouched');
  assert.match(f.description, /## Plan \(approved, round 1/);
  assert.equal(features.holds(f), false);
  assert.equal(productReview.required(f), false); assert.equal(productReview.blocks(a), false);
  assert.throws(() => features.approve(ticket.key, { expected_revision: ready.revision }), { status: 409 });
  // The feature closes when its tasks settle.
  store.updateTicket(a.key, { status: 'done' }); sched.rollupParent(ticket.key);
  store.updateTicket(b.key, { status: 'done' }); sched.rollupParent(ticket.key);
  assert.equal(store.getTicket(ticket.key).status, 'done');
});

test('a reply starts a new round with the previous plan; a request edit makes a ready plan stale; set aside stays held', () => {
  const { ticket } = features.create({ title: 'Round trip', goal: 'Plan, reply, re-plan.' });
  const r1 = groomed(ticket.key);
  const r2 = features.start(ticket.key, { direction: 'Drop the writer; journal only.', expected_revision: r1.revision });
  assert.equal(r2.revision, 2); assert.equal(r2.status, 'queued');
  assert.equal(store.listComments(ticket.key).at(-1).body, 'Drop the writer; journal only.');
  assert.match(features.promptFor(r2, store.getTicket(ticket.key)), /previous-plan round="1"[\s\S]*Drop the writer/);
  assert.equal(features.history(ticket.key).length, 2);
  const ready = groomed(ticket.key);
  const t = store.getTicket(ticket.key);
  sched.ownerPatch(ticket.key, { description: 'Plan, reply, re-plan, and export CSV.', expected_updated_at: t.updated_at });
  assert.equal(features.current(ticket.key).stale, true);
  assert.throws(() => features.approve(ticket.key, { expected_revision: ready.revision }), /request changed/);
  assert.throws(() => sched.ownerPatch(ticket.key, { description: 'x', expected_updated_at: 'old' }), { status: 409 });
  assert.equal(features.discard(ticket.key, { expected_revision: ready.revision }).status, 'discarded');
  assert.equal(features.holds(store.getTicket(ticket.key)), true, 'nothing starts without an approved plan');
  assert.equal(features.start(ticket.key, { expected_revision: ready.revision }).revision, 3);
});

test('editing the request keeps the generated plan block', () => {
  const desc = `Old request\n\n${features.PLAN_START}\n## Plan\n- a\n${features.PLAN_END}\n\nOwner footnote`;
  assert.equal(features.requestOf(desc), 'Old request\n\nOwner footnote');
  const next = features.replaceRequest(desc, 'New request');
  assert.match(next, /^New request\n\n<!-- sigmadesk:feature-plan -->[\s\S]*<!-- \/sigmadesk:feature-plan -->$/);
});

test('feature grooming refuses desk commands and reserves the Codex budget', async () => {
  const run = store.createRun({ agent_id: 'manager', ticket_key: null, kind: 'feature_groom', token: 'fg', model: 'codex:fixture' });
  await assert.rejects(sched.deskAction(run, 'comment', { body: 'hi' }), /read-only/);
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: false }]);
  assert.equal(dispatch.pinnedSelection('manager', 'codex', 'feature_groom').seat, null);
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true }]);
});
