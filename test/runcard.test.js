import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCard, humanizeStep, parsePlan, deriveEvidence, nextActor } from '../public/runcard.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const ticket = { key: 'X-1', status: 'in_progress', assignee: 'senior-be', title: 'Fix the thing' };
const agents = [{ id: 'senior-be', name: 'Jordan', status: 'working', current_ticket: 'X-1', current_run: 7 }, { id: 'qa', name: 'Taylor', status: 'idle' }];
const runs = [{ id: 7, ticket_key: 'X-1', kind: 'implement', model: 'claude:opus', status: 'running', cost_usd: 0, reserve_usd: 5, started_at: at(12) }];
let id = 0;
const ev = (kind, text, min, extra = {}) => ({ id: ++id, ts: at(min), run_id: 7, agent_id: 'senior-be', ticket_key: 'X-1', kind, text, ...extra });

test('humanizeStep strips the agent percentage and capitalizes', () => {
  assert.equal(humanizeStep('45% · reading code'), 'Reading code');
  assert.equal(humanizeStep('5% reading code'), 'Reading code');
  assert.equal(humanizeStep('submitted X-1 for QA (2613781)'), 'Submitted X-1 for QA (2613781)');
  assert.equal(humanizeStep(''), '');
});

test('parsePlan counts done milestones', () => {
  const p = parsePlan('✓ read the code\n✓ write tests\n▸ implement\n· submit');
  assert.equal(p.done, 2);
  assert.equal(p.total, 4);
  assert.deepEqual(p.items.map((i) => i.state), ['done', 'done', 'now', 'todo']);
  assert.equal(p.items[2].text, 'implement');
  assert.equal(parsePlan(''), null);
});

test('Now is the latest action without the percentage; tools fold; only two say lines', () => {
  id = 0;
  const events = [ev('plan', '✓ read\n▸ build\n· submit', 11), ev('action', '5% · reading code', 10), ev('tool', '$ rg foo', 9), ev('tool', '$ sed -n 1,20p x', 9),
    ev('say', 'one', 8), ev('say', 'two', 7), ev('say', 'three', 2), ev('action', '50% · tests drafted; running', 1)];
  const c = runCard({ ticket, events, runs, agents, now: NOW });
  assert.equal(c.live, true);
  assert.equal(c.now.text, 'Tests drafted; running');
  assert.equal(c.now.error, false);
  assert.deepEqual(c.says.map((s) => s.text), ['two', 'three']);
  assert.equal(c.sayCount, 3);
  assert.equal(c.toolCount, 2);
  assert.equal(c.plan.done, 1);
  assert.equal(c.plan.total, 3);
  assert.equal(c.stale, null);
  assert.equal(c.cost.label, '$5.00 reserved');
  assert.equal(c.result, null); // still running
  assert.equal(c.elapsedMin, 12);
});

test('a tool exit is a note under Now; a real error replaces Now until an explicit recovery step', () => {
  id = 0;
  const base = [ev('action', '20% · running checks', 6), ev('error', 'Exit code 1\nAll checks passed! Would reformat: a/b.py Would reformat: c/d.py 2 files would be reformatted', 5)];
  const c = runCard({ ticket, events: base, runs, agents, now: NOW });
  assert.equal(c.now.error, false);
  assert.equal(c.now.text, 'Running checks');
  assert.equal(c.issue.text, 'Formatting check failed — 2 files need formatting');
  const hard = [ev('action', '20% · pushing', 6), ev('error', 'publish failed: remote rejected', 5)];
  const h1 = runCard({ ticket, events: hard, runs, agents, now: NOW });
  assert.equal(h1.now.error, true);
  assert.equal(runCard({ ticket, events: [...hard, ev('say', 'fixing it', 4)], runs, agents, now: NOW }).now.error, true); // narration is not recovery
  const ok = runCard({ ticket, events: [...hard, ev('action', '30% · retried push', 3)], runs, agents, now: NOW });
  assert.equal(ok.now.error, false);
  assert.equal(ok.now.text, 'Retried push');
});

test('a failed run shows red; another run\'s events never leak into this run', () => {
  id = 0;
  const failed = [{ ...runs[0], status: 'error', ended_at: at(1) }];
  const c = runCard({ ticket, events: [ev('error', 'Exit code 2 tests 3 failed, 10 passed', 2)], runs: failed, agents: [], now: NOW });
  assert.equal(c.now.error, true);
  assert.equal(c.now.text, 'Tests failed — 3 failing');
  const other = runCard({ ticket, events: [ev('plan', '✓ old\n· plan', 9, { run_id: 3 }), ev('action', '10% · old step', 8, { run_id: 3 })], runs, agents, now: NOW });
  assert.equal(other.plan, null);
  assert.equal(other.now.text, 'Starting implement');
});

test('quiet working run reports "no update for N min"', () => {
  id = 0;
  const c = runCard({ ticket, events: [ev('action', '10% · reading', 8)], runs, agents, now: NOW });
  assert.deepEqual(c.stale, { minutes: 8, severe: false });
  const idle = runCard({ ticket, events: [ev('action', '10% · reading', 8)], runs: [{ ...runs[0], status: 'ok' }], agents: [], now: NOW });
  assert.equal(idle.stale, null); // not working → not "stale"
});

test('finished run gives a result, next actor and cost against the cap', () => {
  id = 0;
  const t = { ...ticket, status: 'qa' };
  const done = [{ ...runs[0], status: 'ok', cost_usd: 1.6, ended_at: at(1) }];
  const events = [ev('say', 'I added 85 tests that pin the hold gate.', 3), ev('done', 'implement run finished · $1.60', 2)];
  const c = runCard({ ticket: t, events, runs: done, agents: [{ id: 'qa', name: 'Taylor', status: 'idle' }], now: NOW });
  assert.equal(c.live, false);
  assert.equal(c.result.text, 'implement run finished · $1.60');
  assert.equal(c.result.summary, 'I added 85 tests that pin the hold gate.');
  assert.equal(c.result.next, 'Taylor tests it');
  assert.equal(c.cost.label, '$1.60 of $5.00 cap');
});

test('evidence separates QA-verified from engineer-claimed, and says QA pending honestly', () => {
  const t = { key: 'X-1', status: 'qa' };
  const claimed = deriveEvidence({ ticket: t, comments: [{ id: 1, author: 'senior-be', body: '🚀 **Submitted for QA** at `54a46da8f6`\n\nadded alpaca_trader/tests/test_hold.py and app/x.py' }],
    events: [{ id: 2, kind: 'say', agent_id: 'senior-be', text: 'All 87 pass … 153 passed, ruff clean' }] });
  assert.deepEqual(claimed.map((e) => [e.kind, e.source]), [['qa', 'pending'], ['tests', 'claimed'], ['files', 'claimed']]);
  assert.equal(claimed[1].label, '153 tests passed');
  assert.equal(claimed[2].label, '2 files changed');

  const verified = deriveEvidence({ ticket: { ...t, status: 'ready_for_human', pr_url: 'https://github.com/o/r/pull/392' },
    comments: [{ id: 3, author: 'qa', body: '✅ **QA passed** at `54a46da8f6`\n\nRequired pytest = 153 passed, rc 0' }, { id: 4, author: 'manager', body: '🤝 **Accepted by Morgan** (Engineering Manager)\n\nok' }] });
  assert.deepEqual(verified.map((e) => [e.kind, e.source, e.label]), [
    ['qa', 'verified', 'QA passed'], ['tests', 'verified', '153 tests passed'], ['acceptance', 'verified', 'Accepted by Morgan (Engineering Manager)'], ['pr', 'verified', 'Draft PR #392']]);
  assert.equal(verified[0].detail, 'at 54a46da8');

  const stale = deriveEvidence({ ticket: { ...t, head_sha: 'bbbbbbbb11' }, comments: [{ id: 6, author: 'qa', body: '✅ **QA passed** at `aaaaaaaa22`\n\n12 passed' }] });
  assert.deepEqual(stale.map((e) => [e.kind, e.source]), [['qa-current', 'pending'], ['qa', 'earlier'], ['tests', 'earlier']]);
  assert.equal(stale[1].label, 'QA passed on an earlier commit');
  const failed = deriveEvidence({ ticket: t, comments: [{ id: 5, author: 'qa', body: '❌ **QA failed** (round 2)\n\n1. broken' }] });
  assert.equal(failed[0].label, 'QA failed');
  assert.equal(failed[0].tone, 'bad');
  assert.equal(failed[0].detail, 'round 2');
});

test('nextActor names who moves the ticket', () => {
  assert.equal(nextActor({ status: 'ready_for_human' }), 'You');
  assert.equal(nextActor({ status: 'todo', assignee: 'senior-be' }, agents), 'Jordan picks it up');
  assert.equal(nextActor({ status: 'done' }), 'Nobody — shipped');
});

test('no events and no run yields an empty but valid card', () => {
  const c = runCard({ ticket: { key: 'X-9', status: 'todo' }, now: NOW });
  assert.equal(c.live, false);
  assert.equal(c.now, null);
  assert.equal(c.plan, null);
  assert.equal(c.cost, null);
  assert.equal(c.evidence[0].label, 'QA pending');
});
