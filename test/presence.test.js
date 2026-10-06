import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceFor, writingSentence, writingDetail, presenceAnnouncement, stepLabel, writingNames, WRITING_MS, STALE_MS } from '../public/presence.js';
import { STALE_MS as RUN_CARD_STALE } from '../public/runcard.js';

const NOW = Date.parse('2026-10-05T15:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const agents = [
  { id: 'principal-be', name: 'Rowan Lee', status: 'idle' }, { id: 'manager', name: 'Morgan Diaz', status: 'idle' },
  { id: 'senior-fe', name: 'Quinn Park', status: 'idle' }, { id: 'qa', name: 'Taylor Kim', status: 'idle' },
  { id: 'principal-fe', name: 'Sage Ito', status: 'idle' }, { id: 'junior', name: 'Riley Fox', status: 'idle' },
];
const working = (id, key, run, kind = 'implement') => ({ ...agents.find((a) => a.id === id), status: 'working', current_ticket: key, current_run: run, current_kind: kind });
const seats = (...w) => agents.map((a) => w.find((x) => x.id === a.id) || a);
const ev = (id, run, kind, text, msAgo, key = 'SD-1') => ({ id, run_id: run, ticket_key: key, agent_id: 'x', kind, text, ts: at(msAgo) });
const run = (id, agent, msAgo, status = 'running', key = 'SD-1') => ({ id, agent_id: agent, ticket_key: key, kind: 'implement', status, started_at: at(msAgo) });

test('the stalled threshold is the run card one, and writing means a step in the last 45 s', () => {
  assert.equal(STALE_MS, RUN_CARD_STALE);
  assert.equal(WRITING_MS, 45_000);
});

test('writing: an active run posted a step under 45 s ago; label is the humanized latest step', () => {
  const p = presenceFor({ key: 'SD-1', agents: seats(working('principal-be', 'SD-1', 7)), runs: [run(7, 'principal-be', 600_000)],
    events: [ev(1, 7, 'say', 'Looking at the diff', 90_000), ev(2, 7, 'tool', 'Reading ui/src/ticket/TicketSheet.tsx', 12_000)], now: NOW });
  assert.equal(p.writers.length, 1);
  const [w] = p.writers;
  assert.equal(w.state, 'writing'); assert.equal(w.name, 'Rowan'); assert.equal(w.label, 'reading TicketSheet.tsx');
  assert.equal(w.text, 'Rowan is writing…'); assert.equal(writingDetail(w), 'reading TicketSheet.tsx · 12s ago');
  assert.deepEqual(writingNames(p), ['Rowan']);
});

test('the 45 s boundary: 44.9 s is writing, 45 s is quiet', () => {
  const base = { key: 'SD-1', agents: seats(working('principal-be', 'SD-1', 7)), runs: [run(7, 'principal-be', 600_000)], now: NOW };
  assert.equal(presenceFor({ ...base, events: [ev(1, 7, 'action', 'drafting review', 44_900)] }).writers[0].state, 'writing');
  const q = presenceFor({ ...base, events: [ev(1, 7, 'action', 'drafting review', 45_000)] }).writers[0];
  assert.equal(q.state, 'quiet'); assert.equal(q.text, 'Rowan · working quietly for 1 min');
});

test('quiet between 45 s and the stall threshold; stalled past it, matching "No update for N min"', () => {
  const base = { key: 'SD-1', agents: seats(working('principal-be', 'SD-1', 7)), runs: [run(7, 'principal-be', 3_600_000)], now: NOW };
  const quiet = presenceFor({ ...base, events: [ev(1, 7, 'tool', '$ npm test', 120_000)] }).writers[0];
  assert.equal(quiet.state, 'quiet'); assert.equal(quiet.text, 'Rowan · working quietly for 2 min'); assert.equal(quiet.label, 'running npm test');
  assert.equal(presenceFor({ ...base, events: [ev(1, 7, 'tool', '$ npm test', STALE_MS)] }).writers[0].state, 'quiet', 'exactly at the threshold is not yet stalled');
  const stalled = presenceFor({ ...base, events: [ev(1, 7, 'tool', '$ npm test', 7 * 60_000)] }).writers[0];
  assert.equal(stalled.state, 'stalled'); assert.equal(stalled.text, 'Rowan · no update for 7 min');
  // Any event of the run (an error, a wait) is activity for the stall clock, but only steps make someone "writing".
  const err = presenceFor({ ...base, events: [ev(1, 7, 'tool', '$ npm test', 7 * 60_000), ev(2, 7, 'error', 'Exit code 1', 10_000)] }).writers[0];
  assert.equal(err.state, 'quiet');
});

test('a run that has not posted yet is quiet ("starting"), and stalls from its start time', () => {
  const base = { key: 'SD-1', agents: seats(working('principal-be', 'SD-1', 7)), now: NOW, events: [] };
  const fresh = presenceFor({ ...base, runs: [run(7, 'principal-be', 10_000)] }).writers[0];
  assert.equal(fresh.state, 'quiet'); assert.equal(fresh.label, 'starting implement'); assert.equal(fresh.text, 'Rowan · starting implement');
  assert.equal(presenceFor({ ...base, runs: [run(7, 'principal-be', 20 * 60_000)] }).writers[0].state, 'stalled');
  // A seat marked working before its run row exists: getting ready, never "writing".
  const prep = presenceFor({ key: 'SD-1', agents: seats(working('principal-be', 'SD-1', null)), now: NOW }).writers[0];
  assert.equal(prep.state, 'quiet'); assert.equal(prep.label, 'getting ready');
});

test('events from a finished run never count, even if very recent', () => {
  const p = presenceFor({ key: 'SD-1', agents, runs: [run(5, 'principal-be', 600_000, 'success')], events: [ev(1, 5, 'say', 'Done, submitting', 2_000)], now: NOW });
  assert.deepEqual(p.writers, []);
  // The seat has moved on to a new run: only the new run's events describe it.
  const moved = presenceFor({ key: 'SD-1', agents: seats(working('principal-be', 'SD-1', 8)), runs: [run(5, 'principal-be', 600_000, 'success'), run(8, 'principal-be', 5_000)],
    events: [ev(1, 5, 'say', 'Done, submitting', 2_000)], now: NOW }).writers[0];
  assert.equal(moved.state, 'quiet'); assert.equal(moved.label, 'starting implement');
  // A seat working on another ticket is not present here, and another ticket's events do not leak in.
  assert.deepEqual(presenceFor({ key: 'SD-1', agents: seats(working('qa', 'SD-2', 9)), runs: [run(9, 'qa', 1000, 'running', 'SD-2')], events: [ev(1, 9, 'say', 'hi', 1000, 'SD-2')], now: NOW }).writers, []);
});

test('multiple runs on one ticket stack in a natural sentence; writing first, then quiet, then stalled', () => {
  const w = [working('principal-be', 'SD-1', 1), working('manager', 'SD-1', 2, 'review'), working('senior-fe', 'SD-1', 3), working('qa', 'SD-1', 4, 'qa'), working('junior', 'SD-1', 5)];
  const runs = [1, 2, 3, 4, 5].map((i) => run(i, w[i - 1].id, 3_600_000));
  const events = [ev(1, 1, 'say', 'a', 5_000), ev(2, 2, 'action', 'b', 3_000), ev(3, 3, 'tool', 'c', 20_000), ev(4, 4, 'action', 'd', 10 * 60_000), ev(5, 5, 'action', 'e', 90_000)];
  const p = presenceFor({ key: 'SD-1', agents: seats(...w), runs, events, now: NOW });
  assert.deepEqual(p.writers.map((x) => [x.name, x.state]), [['Morgan', 'writing'], ['Rowan', 'writing'], ['Quinn', 'writing'], ['Riley', 'quiet'], ['Taylor', 'stalled']]);
  assert.equal(writingSentence(writingNames(p)), 'Morgan, Rowan and Quinn are writing…');
  assert.equal(writingSentence(['Rowan']), 'Rowan is writing…');
  assert.equal(writingSentence(['Rowan', 'Morgan']), 'Rowan and Morgan are writing…');
  assert.equal(writingSentence(['Rowan', 'Morgan', 'Quinn', 'Sage']), 'Rowan, Morgan and 2 others are writing…');
  assert.equal(writingSentence([]), '');
  assert.equal(presenceAnnouncement(p), 'Morgan, Rowan and Quinn are writing. Taylor has not posted an update for a while');
});

test('a running run the server reports counts even before the agent row catches up; one entry per seat', () => {
  const p = presenceFor({ key: 'SD-1', agents, runs: [run(3, 'qa', 60_000)], events: [ev(1, 3, 'plan', '✓ read\n▸ Run the acceptance suite\n· report', 4_000)], now: NOW });
  assert.equal(p.writers.length, 1); assert.equal(p.writers[0].label, 'run the acceptance suite');
  const dup = presenceFor({ key: 'SD-1', agents: seats(working('qa', 'SD-1', 3)), runs: [run(3, 'qa', 60_000)], events: [], now: NOW });
  assert.equal(dup.writers.length, 1);
});

test('up next comes from the scheduler waiting entry; held reasons are said, owner/prerequisite waits are not a seat', () => {
  const waiting = [{ key: 'SD-1', seat: 'principal-fe', code: 'seat_busy' }, { key: 'SD-1', seat: 'qa', code: 'tick' }, { key: 'SD-2', seat: 'junior', code: 'tick' }];
  const p = presenceFor({ key: 'SD-1', agents, waiting, now: NOW });
  assert.deepEqual(p.next.map((n) => n.text), ['Sage is up next, after their current work', 'Taylor is up next']);
  assert.equal(presenceFor({ key: 'SD-1', agents, waiting: [{ key: 'SD-1', seat: 'qa', code: 'paused' }], now: NOW }).next[0].text, 'Taylor is next · desk paused');
  for (const code of ['owner_task', 'dependency', 'research_review', 'product_review']) assert.deepEqual(presenceFor({ key: 'SD-1', agents, waiting: [{ key: 'SD-1', seat: 'qa', code }], now: NOW }).next, [], code);
  assert.deepEqual(presenceFor({ key: 'SD-1', agents, waiting: [{ key: 'SD-1', code: 'tick' }], now: NOW }).next, [], 'no seat named, no up next');
  // A seat already working here is not also "up next".
  assert.deepEqual(presenceFor({ key: 'SD-1', agents: seats(working('qa', 'SD-1', 3)), runs: [run(3, 'qa', 1000)], waiting: [{ key: 'SD-1', seat: 'qa', code: 'tick' }], now: NOW }).next, []);
});

test('the owner draft is local and per ticket; blank drafts and other tickets do not count', () => {
  assert.deepEqual(presenceFor({ key: 'SD-1', drafts: { 'SD-1:msg': 'half a thought' }, now: NOW }).draft, { id: 'msg' });
  assert.deepEqual(presenceFor({ key: 'SD-1', drafts: { 'SD-1:dec-question-3': 'yes' }, now: NOW }).draft, { id: 'dec-question-3' });
  assert.equal(presenceFor({ key: 'SD-1', drafts: { 'SD-1:msg': '   ' }, now: NOW }).draft, null);
  assert.equal(presenceFor({ key: 'SD-1', drafts: { 'SD-10:msg': 'x', 'SD-2:msg': 'y' }, now: NOW }).draft, null);
  assert.deepEqual(presenceFor({ now: NOW }), { writers: [], next: [], draft: null });
});

test('step labels are short and plain', () => {
  assert.equal(stepLabel({ kind: 'say', text: 'A long narration…' }), 'writing a message');
  assert.equal(stepLabel({ kind: 'action', text: '45% · Drafting the review' }), 'drafting the review');
  assert.equal(stepLabel({ kind: 'tool', text: 'Editing src/server.js' }), 'editing server.js');
  assert.equal(stepLabel({ kind: 'tool', text: '$ node --test test/presence.test.js' }), 'running node --test test/presence.test.js');
  assert.equal(stepLabel({ kind: 'plan', text: '✓ a\n· b' }), 'updating the plan');
  assert.ok(stepLabel({ kind: 'action', text: 'x'.repeat(200) }).length <= 64);
});
