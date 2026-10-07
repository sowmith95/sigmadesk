// The autonomy matrix (sowmith95/sigmadesk#6): per action, authorized MODE and READINESS are separate dimensions;
// the mode comes from policy/config only; production writes and trading are not representable; the ticket line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matrix, forTicket, MODES, NOT_REPRESENTABLE } from '../src/autonomy-model.js';

const base = (over = {}) => ({
  settings: { paused: 'false', github_sync: 'true', open_draft_prs: 'true', ops_enabled: 'true' },
  seats: { manager: true, sre: true, builders: 3 }, autoMerge: { enabled: true, excludeRiskHigh: true }, mergeTrain: true, reviewsRequired: 2,
  requiredChecks: { names: ['test'], unknownBlocks: false }, busyWindow: { enabled: true, start: '09:30', end: '16:15', timezone: 'America/New_York' },
  busyNow: false, deployLock: null, ops: { configured: true, on: true, verify: true }, policy: { approvers: ['manager', 'sre'], ownerMentionAutoGrant: true, maxMinutes: 240, maxActive: 3 },
  grants: [], budgetLeft: 50, names: { manager: 'Morgan', sre: 'Devon' }, policyVersion: 'v1', ...over,
});
const by = (m) => Object.fromEntries(m.actions.map((a) => [a.id, a]));

test('every action has a mode from the ladder and a readiness; nothing can say production writes or trading', () => {
  const m = matrix(base());
  assert.deepEqual(m.actions.map((a) => a.id), ['groom', 'implement', 'merge_low', 'merge_high', 'deploy_timing', 'prod_read', 'tag_access', 'publish']);
  for (const a of m.actions) { assert.ok(MODES.includes(a.mode), a.id); assert.ok(['ready', 'blocked'].includes(a.readiness.state), a.id); }
  assert.ok(!m.actions.some((a) => /write|trad|order/i.test(a.id)));
  assert.deepEqual(m.not_representable.map((n) => n.id), NOT_REPRESENTABLE.map((n) => n.id));
  assert.equal(m.policy_version, 'v1');
});

test('readiness is not authority: a halted desk or unconfirmed CI blocks an autonomous merge, it does not make it human-led', () => {
  const a = by(matrix(base({ settings: { ...base().settings, paused: 'true' }, requiredChecks: { names: [], unknownBlocks: true } })));
  assert.equal(a.merge_low.mode, 'autonomous');
  assert.equal(a.merge_low.readiness.state, 'blocked');
  assert.deepEqual(a.merge_low.readiness.reasons.map((r) => r.split(' ').slice(0, 3).join(' ')), ['The desk is', 'It waits until']);
  const lock = by(matrix(base({ deployLock: { key: 'SD-3', state: 'failed' }, busyNow: true, windowEnd: '4:15 PM ET' })));
  assert.equal(lock.deploy_timing.mode, 'autonomous');
  assert.match(lock.deploy_timing.readiness.reasons[0], /SD-3\) failed/); assert.match(lock.deploy_timing.readiness.reasons[1], /until 4:15 PM ET/);
});

test('merge by risk class: high and unknown risk need the owner unless the config waives it, and the waiver is said', () => {
  let a = by(matrix(base()));
  assert.equal(a.merge_high.mode, 'assisted'); assert.equal(a.merge_high.waiver, null);
  a = by(matrix(base({ autoMerge: { enabled: true, excludeRiskHigh: false } })));
  assert.equal(a.merge_high.mode, 'autonomous'); assert.match(a.merge_high.waiver, /excludeRiskHigh is false/);
  a = by(matrix(base({ autoMerge: { enabled: false } })));
  assert.equal(a.merge_low.mode, 'assisted'); assert.equal(a.merge_high.mode, 'assisted');
  assert.equal(a.merge_low.control.editable, false, 'auto-merge has no owner write path: read-only, and it says where it is set');
  assert.match(a.merge_low.control.text, /review\.autoMerge\.enabled/);
});

test('production checks are at most assisted (the SRE never approves its own access); off or unconfigured is human-led; only existing write paths are editable', () => {
  let a = by(matrix(base()));
  assert.equal(a.prod_read.mode, 'assisted'); assert.match(a.prod_read.mode_text, /own access is always yours/);
  assert.deepEqual([a.prod_read.control.kind, a.prod_read.control.key, a.prod_read.control.editable], ['setting', 'ops_enabled', true]);
  assert.deepEqual([a.tag_access.control.kind, a.tag_access.control.key, a.tag_access.mode], ['policy', 'ownerMentionAutoGrant', 'autonomous']);
  assert.deepEqual([a.publish.control.key, a.publish.mode], ['open_draft_prs', 'autonomous']);
  a = by(matrix(base({ ops: { configured: true, on: false, verify: true }, policy: { ...base().policy, ownerMentionAutoGrant: false } })));
  assert.equal(a.prod_read.mode, 'human-led'); assert.equal(a.tag_access.mode, 'assisted');
  assert.equal(a.tag_access.readiness.state, 'blocked');
  a = by(matrix(base({ ops: { configured: false } })));
  assert.equal(a.prod_read.control.editable, false, 'not configured: no switch to flip');
  assert.equal(by(matrix(base({ settings: { ...base().settings, open_draft_prs: 'false' } }))).publish.mode, 'human-led');
});

test('ticket line: build, merge by risk class, production read with its expiry', () => {
  const m = matrix(base());
  const until = '2026-10-07T18:30:00Z';
  let r = forTicket({ ticket: { key: 'A-1', status: 'in_progress', risk: 'high' }, matrix: m, grants: [{ seat: 'sre', expires_at: until }], nameOf: () => 'Devon' });
  assert.equal(r.text, 'Build automatic · merge needs you (risk high) · prod read expires');
  assert.equal(r.items.at(-1).until, until);
  r = forTicket({ ticket: { key: 'A-2', status: 'ready_for_human', pr_url: 'x', risk: 'low', diff_risk: 'low' }, matrix: m });
  assert.match(r.text, /^Merge automatic \(low risk\)/);
  r = forTicket({ ticket: { key: 'A-3', status: 'todo', owner_task: 1 }, matrix: m });
  assert.match(r.text, /^Build is yours/);
  r = forTicket({ ticket: { key: 'A-4', status: 'ready_for_human', pr_url: 'x', risk: 'low', diff_risk: 'low', merge_hold: 'waiting for the release' }, matrix: m });
  assert.match(r.text, /^Merge held/);
  r = forTicket({ ticket: { key: 'A-5', status: 'todo', risk: null }, matrix: matrix(base({ autoMerge: { enabled: true, excludeRiskHigh: false } })) });
  assert.match(r.text, /merge automatic \(risk unknown, waived\)/);
});

test('production-read readiness (repro, review P2): no SRE grant, a halted desk, no budget or nothing to probe blocks it; the authorized mode stays assisted', () => {
  const ops = { configured: true, on: true, verify: true, targets: 2 };
  let a = by(matrix(base({ ops, settings: { ...base().settings, paused: 'true' } })));
  assert.equal(a.prod_read.mode, 'assisted'); assert.equal(a.prod_read.readiness.state, 'blocked');
  assert.match(a.prod_read.readiness.reasons[0], /halted.*no verify run starts/);
  assert.match(a.prod_read.readiness.reasons[1], /Devon holds no production access/);
  a = by(matrix(base({ ops: { ...ops, targets: 0 }, ownerGrants: [{ seat: 'sre', expires_at: '2026-10-07T18:00:00Z' }] })));
  assert.deepEqual(a.prod_read.readiness.reasons, ['No database or container is configured for the probes, so they have nothing to read.']);
  a = by(matrix(base({ ops, budgetLeft: 0.01, caps: { verify: 5 }, ownerGrants: [{ seat: 'sre' }] })));
  assert.deepEqual(a.prod_read.readiness.reasons, ['The daily budget has $0.01 left; a verify run reserves $5.00.'], 'repro: headroom under the run cap blocks, as the scheduler does');
  assert.equal(by(matrix(base({ ops, budgetLeft: 5, caps: { verify: 5 }, ownerGrants: [{ seat: 'sre' }] }))).prod_read.readiness.state, 'ready');
  a = by(matrix(base({ ops, ownerGrants: [{ seat: 'sre', expires_at: '2026-10-07T18:00:00Z' }] })));
  assert.equal(a.prod_read.readiness.state, 'ready'); assert.equal(a.prod_read.mode, 'assisted');
});
