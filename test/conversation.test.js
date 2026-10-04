import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationItems, nearLatest, comparable, dayLabel } from '../public/conversation.js';
const event = (id, kind, text, who = 'engineer', run = 1) => ({ id, kind, text, agent_id: who, run_id: run, ts: `2026-10-04T02:00:${String(id).padStart(2, '0')}Z` });

test('conversation interleaves owner messages, agent updates and handoffs chronologically', () => {
  const items = conversationItems({ comments: [{ id: 1, ts: '2026-10-04T02:00:02Z', author: 'owner', body: 'Please verify mobile.' }],
    events: [event(4, 'pickup', 'QA picked up the task', 'qa', 2), event(3, 'action', '70% · testing mobile'), event(1, 'say', 'I will check the layout.')] });
  assert.deepEqual(items.map((i) => i.id), ['e1', 'c1', 'e3', 'e4']);
  assert.equal(items[2].text, 'Testing mobile');
  assert.equal(items[3].who, 'qa');
});

test('commands and failed checks group only within the same agent and run', () => {
  const events = [event(1, 'tool', '$ npm test'), event(2, 'error', 'exit 1: 2 failed tests'), event(3, 'say', 'Fixing the assertion.'),
    event(4, 'tool', '$ npm test'), event(5, 'tool', '$ npm test', 'qa', 2), event(6, 'tool', '$ npm test', 'qa', 3)];
  const items = conversationItems({ events: [...events, events[1]] });
  assert.equal(items.length, 5);
  assert.equal(items[0].steps.length, 2);
  assert.equal(items[0].steps[1].raw, 'exit 1: 2 failed tests');
  assert.equal(items[1].text, 'Fixing the assertion.');
  assert.equal(items.at(-1).runId, 3);
});

test('filter includes only the selected participant, with genuine errors visible', () => {
  const items = conversationItems({ agent: 'qa', events: [event(1, 'say', 'Implementing'), event(2, 'error', 'Provider disconnected', 'qa', 2)],
    comments: [{ id: 1, ts: '2026-10-04T02:00:03Z', author: 'qa', body: 'QA needs another run.' }] });
  assert.deepEqual(items.map((i) => i.kind), ['error', 'comment']);
  assert.deepEqual(conversationItems(), []);
});

test('follow latest pauses when the reader scrolls up', () => {
  assert.equal(nearLatest({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true);
  assert.equal(nearLatest({ scrollHeight: 1000, clientHeight: 400, scrollTop: 570 }), true);
  assert.equal(nearLatest({ scrollHeight: 1000, clientHeight: 400, scrollTop: 200 }), false);
});

test('comment activity echoes are removed without hiding repeated comments or unrelated events', () => {
  const comments = [{ id: 1, author: 'owner', ts: '2026-10-04T02:00:01Z', body: 'Approved the design.' },
    { id: 2, author: 'owner', ts: '2026-10-04T02:00:02Z', body: 'Approved the design.' }];
  const events = [event(1, 'system', 'Approved the design.', 'owner'), event(2, 'action', 'commented: Approved the design.', 'owner'),
    event(10, 'system', 'Approved the design.', 'owner')];
  assert.deepEqual(conversationItems({ comments, events }).map(i=>i.id), ['c1', 'c2', 'e10']);
});

const at = (s) => `2026-10-04T02:00:${String(s).padStart(2, '0')}Z`;
test('the server\'s real echo strings never duplicate a message', () => {
  const comments = [
    { id: 1, author: 'senior-be', ts: at(1), body: 'Tests are green on the branch; opening the PR next.' },
    { id: 2, author: 'senior-be', ts: at(2), body: '❓ **Question for the owner:** Should alerts **page** after three errors?' },
    { id: 3, author: 'manager', ts: at(3), body: '🗣 **Asked Rowan (Principal Backend Engineer):** Is a queue needed here?' },
    { id: 4, author: 'principal-be', ts: at(4), body: '💬 No queue; a cron-free retry loop is enough for this volume.' },
    { id: 5, author: 'manager', ts: at(50), body: '💬 **Design response #2**\n\nUse a feature branch and one owner-controlled merge.' },
  ];
  const events = [
    { id: 1, kind: 'action', agent_id: 'senior-be', ts: at(1), text: 'commented: Tests are green on the branch; opening the PR next.' },
    { id: 2, kind: 'action', agent_id: 'senior-be', ts: at(2), text: 'asked the owner: Should alerts **page** after three errors?' },
    { id: 3, kind: 'action', agent_id: 'manager', ts: at(3), text: '🗣 planning discussion with Principal Backend Engineer: Is a queue needed here?' },
    { id: 4, kind: 'say', agent_id: 'principal-be', ts: at(4), text: '→ Engineering Manager: No queue; a cron-free retry loop is enough for this volume.' },
    { id: 5, kind: 'say', agent_id: 'manager', ts: at(20), text: 'Use a feature branch and one owner-controlled merge.' },
    { id: 6, kind: 'say', agent_id: 'manager', ts: at(21), text: 'Reading the merge train code first.' },
  ];
  assert.deepEqual(conversationItems({ comments, events }).map((i) => i.id), ['c1', 'c2', 'c3', 'c4', 'e6', 'c5']);
  assert.equal(comparable('commented: **Bold** `x`…'), 'bold x');
});

test('only the latest unanswered question is open; discussions show their state in the thread', () => {
  const comments = [{ id: 1, author: 'junior', ts: at(1), body: '❓ First?' }, { id: 2, author: 'owner', ts: at(2), body: 'Yes.' },
    { id: 3, author: 'junior', ts: at(3), body: '❓ Second?' }];
  const items = conversationItems({ comments, status: 'needs_human', discussions: [{ id: 7, status: 'failed', created_at: at(2), error: 'provider unavailable' }] });
  assert.deepEqual(items.map((i) => [i.id, !!i.open]), [['c1', false], ['c2', false], ['d7', false], ['c3', true]]);
  assert.match(items[2].text, /#7: Failed/);
  assert.equal(conversationItems({ comments, status: 'todo' }).some((i) => i.open), false);
});

test('day labels for multi-day threads', () => {
  const now = new Date('2026-10-04T15:00:00');
  assert.equal(dayLabel('2026-10-04T09:00:00', now), 'Today');
  assert.equal(dayLabel('2026-10-03T09:00:00', now), 'Yesterday');
  assert.match(dayLabel('2026-09-28T09:00:00', now), /Sep/);
});
