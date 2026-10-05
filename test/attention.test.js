import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attend, board, deskStatus } from '../public/attention.js';
import { shortName } from '../public/names.js';

const agents = [{ id: 'senior-be', name: 'Rowan Hale', status: 'working', current_ticket: 'X-3' }, { id: 'junior', name: 'Sage Kim', status: 'idle' }];
const T = (key, status, extra = {}) => ({ key, status, title: `Fix ${key} thing`, updated_at: '2026-10-03T00:00:00Z', ...extra });

test('owner decisions get a verb and a single bucket', () => {
  const tickets = [
    T('X-1', 'needs_human', { assignee: 'junior', progress_msg: 'Which option?' }),
    T('X-2', 'needs_human', { progress_msg: 'publish guard: needs owner approval' }),
    T('X-3', 'in_progress', { assignee: 'senior-be' }),
    T('X-4', 'ready_for_human', { pr_url: 'https://github.com/o/r/pull/1' }),
    T('X-5', 'ready_for_human', { name: 'Eastern session helpers' }),
    T('X-6', 'todo', { after_key: 'X-4' }),
    T('X-7', 'done'), T('X-8', 'wontdo'),
  ];
  const b = board({ agents, tickets, events: [], meta: { scheduler: { waiting: [{ key: 'X-6', reason: 'Waiting for X-4 to merge' }] } } });
  assert.deepEqual(b.counts, { needs_you: 4, blocked: 0, working: 1, queued: 1, shipped: 1, closed: 1, snoozed: 0 });
  assert.equal(b.needs_you[0].kind, 'guard');                     // guard first
  assert.match(b.needs_you[1].verb, /^Answer Sage$/);
  assert.equal(b.needs_you.find((x) => x.key === 'X-5').verb, 'Publish Eastern session helpers');
  assert.equal(b.needs_you.find((x) => x.key === 'X-4').action, 'Review merge');
  assert.match(b.queued[0].reason, /Waiting for X-4 thing to merge|X-4/);
});

test('epic parent never double-counts its slices', () => {
  const tickets = [T('E-1', 'in_progress'), T('E-2', 'ready_for_human', { parent_key: 'E-1' }), T('E-3', 'done', { parent_key: 'E-1' })];
  const b = board({ agents: [], tickets, events: [] });
  assert.equal(b.counts.needs_you, 1);
  assert.equal(attend(tickets[0], { tickets }).reason, '1 of 2 slices shipped');
});

test('non-self-resolving waits and stalled errors are blocked; design proposals and pages need you', () => {
  const tickets = [T('B-1', 'todo'), T('B-2', 'in_progress', { stalls: 1 }), T('B-3', 'todo')];
  const b = board({ agents: [], tickets, events: [{ id: 9, ticket_key: 'B-2', kind: 'error', text: 'Exit code 2' }],
    incidents: [{ id: 4, status: 'paged', label: 'ingestor', normalized: 'boom' }],
    meta: { scheduler: { waiting: [{ key: 'B-1', reason: 'Credits or rate limit reached' }] }, decisions: { proposals: [{ id: 7, ticket_key: 'B-3' }] } } });
  assert.deepEqual(b.blocked.map((x) => x.key).sort(), ['B-1', 'B-2']);
  assert.deepEqual(b.needs_you.map((x) => x.kind).sort(), ['design', 'page']);
});

test('desk status reads halt and holds', () => {
  assert.equal(deskStatus({ settings: { paused: 'true' } }).label, 'Halted');
  assert.equal(deskStatus({ settings: {}, meta: { providers: [{ available: true, ready: false, label: 'C' }] } }).label, 'Held');
  assert.equal(deskStatus({ settings: {}, meta: { providers: [{ available: true, ready: true }], running: 1 } }).label, 'Running');
});

test('slice prefixes are not part of the human name', () => {
  assert.equal(shortName('SD-9a: extract exit_monitor helpers'), 'Extract exit_monitor helpers');
});

test('a halted desk queues work instead of calling it blocked', () => {
  const b = board({ agents: [], tickets: [T('X-1', 'todo')], events: [], meta: { scheduler: { waiting: [{ key: 'X-1', reason: 'Desk paused' }] } } });
  assert.equal(b.counts.blocked, 0);
  assert.equal(b.queued[0].reason, 'Desk paused');
});

test('each decision is its own item: a question and two proposals and a council on one ticket', () => {
  const tickets = [T('D-1', 'needs_human', { assignee: 'junior', progress_msg: 'Which?' })];
  const b = board({ agents, tickets, events: [], meta: { decisions: { proposals: [{ id: 9, ticket_key: 'D-1' }, { id: 4, ticket_key: 'D-1' }] },
    council: { councils: [{ id: 2, ticket_key: 'D-1', status: 'complete', decision: null }] } } });
  assert.equal(b.counts.needs_you, 4);
  assert.deepEqual(b.needs_you.map((x) => x.id), ['D-1:question', 'D-1:design:4', 'D-1:design:9', 'D-1:council:2']);
  assert.equal(b.needs_you.find((x) => x.id === 'D-1:design:9').proposal_id, 9);
  assert.equal(new Set(b.needs_you.map((x) => x.id)).size, 4);
});

test('structured wait codes: tick and dependency are queued, provider hold is blocked', () => {
  const tickets = [T('W-1', 'todo'), T('W-2', 'todo'), T('W-3', 'todo'), T('W-4', 'todo')];
  const b = board({ agents: [], tickets, events: [], meta: { scheduler: { waiting: [
    { key: 'W-1', code: 'tick', reason: 'Ready for next scheduler tick' }, { key: 'W-2', code: 'dependency', reason: 'Waiting for W-1 to merge' },
    { key: 'W-3', code: 'provider_hold', reason: 'Claude credits exhausted' }, { key: 'W-4', reason: 'Ready for next scheduler tick' }] } } });
  assert.deepEqual(b.blocked.map((x) => x.key), ['W-3']);
  assert.equal(b.counts.queued, 3);
});

test('working counts leaves only; linked pages are not double-counted; no providers means offline', () => {
  const tickets = [T('E-1', 'in_progress'), T('E-2', 'in_progress', { parent_key: 'E-1' })];
  const b = board({ agents: [{ id: 'senior-be', name: 'Rowan', status: 'working', current_ticket: 'E-2' }], tickets, events: [],
    incidents: [{ id: 1, status: 'paged', ticket_key: 'E-2', label: 'x' }, { id: 2, status: 'paged', label: 'y' }] });
  assert.equal(b.counts.working, 1);
  assert.equal(b.epics.length, 1);
  assert.equal(b.epics[0].live, true);
  assert.deepEqual(b.needs_you.map((x) => x.key), ['incident-2']);
  assert.equal(deskStatus({ settings: {}, meta: { providers: [{ id: 'claude', available: false }] } }).label, 'Offline');
});

test('product review objections surface as decisions and pending feedback never advertises publication',()=>{
 const t=T('R-1','todo');
 const changes={ticket_key:t.key,phase:'plan',revision:1,status:'changes'};
 const result=board({tickets:[t],meta:{product_reviews:[changes]}});
 assert.equal(result.needs_you[0].kind,'product');
 const waiting=board({tickets:[{...t,status:'ready_for_human'}],meta:{product_reviews:[{...changes,phase:'feedback',status:'reviewing'}]}});
 assert.equal(waiting.needs_you.length,0);assert.equal(waiting.queued[0].stage,'User feedback');
});
