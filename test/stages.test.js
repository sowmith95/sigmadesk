// The request tracker's stages (public/stages.js): a projection of the real lifecycle, never its own judgement of what
// needs the owner, and honest about rework, design, automatic merges, completion without code and unknown states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOf } from '../public/stages.js';

const T = (extra) => ({ key: 'R-1', title: 'x', status: 'triage', reporter: 'owner', ...extra });
const names = { 'senior-be': 'Jordan', 'principal-be': 'Rowan', junior: 'Riley' };
const at = (t, ctx = {}) => stageOf(t, { names, ...ctx });

test('each status lands on its step, and a held ticket shows where it stopped', () => {
  assert.equal(at(T()).at, 'received');
  assert.equal(at(T({ status: 'proposed' })).at, 'planned');
  assert.equal(at(T({ status: 'todo', assignee: 'junior' })).at, 'assigned');
  assert.equal(at(T({ status: 'in_progress', assignee: 'junior' })).at, 'building');
  assert.equal(at(T({ status: 'qa' })).at, 'qa');
  assert.equal(at(T({ status: 'review' })).at, 'review');
  assert.equal(at(T({ status: 'ready_for_human' })).at, 'ready');
  assert.equal(at(T({ status: 'needs_human', resume_status: 'review' })).at, 'review');
  assert.equal(at(T({ status: 'needs_human', resume_status: 'done' })).at, 'ready', 'a held merge is not "merged"');
  const s = at(T({ status: 'qa' }));
  assert.deepEqual(s.steps.slice(0, 5).map((x) => x.state), ['done', 'done', 'done', 'done', 'current']);
});

test('planned vs current engineer, design vs build, and rework moving back', () => {
  assert.match(at(T({ status: 'todo', assignee: 'junior' })).line, /Planned for Riley; another engineer who fits may take it first/);
  assert.match(at(T({ status: 'todo' })).line, /Waiting for an engineer/);
  const design = at(T({ status: 'in_progress', assignee: 'principal-be' }));
  assert.match(design.line, /Rowan is designing it and splitting it into tasks/);
  const rework = at(T({ status: 'todo', assignee: 'senior-be', qa_loops: 1, head_sha: 'abc' }));
  assert.equal(rework.at, 'building', 'sent back by QA: building again');
  assert.match(rework.line, /Back with Jordan/);
  assert.equal(at(T({ status: 'in_progress', assignee: 'junior', assign_reason: 'Riley: best fit' })).why, 'Riley: best fit');
});

test('what needs the owner comes from the board; an automatic merge is not the owner\'s job', () => {
  const merge = { id: 'R-1:merge', key: 'R-1', kind: 'merge', verb: 'Merge x' };
  const queued = at(T({ status: 'ready_for_human', pr_url: 'u' }), { merges: { 'R-1': 'queued' }, decisions: [merge] });
  assert.deepEqual(queued.actions, []); assert.match(queued.line, /merges automatically/);
  const owner = at(T({ status: 'ready_for_human', pr_url: 'u' }), { merges: { 'R-1': 'owner' }, decisions: [merge] });
  assert.equal(owner.actions.length, 1); assert.equal(owner.line, 'Merge x');
  const q = at(T({ status: 'needs_human', resume_status: 'todo', assignee: 'junior' }), { decisions: [{ id: 'R-1:question', key: 'R-1', kind: 'question', verb: 'Answer Riley' }] });
  assert.equal(q.actions[0].kind, 'question');
  assert.deepEqual(at(T({ status: 'needs_human' })).actions, [], 'no board decision, no invented action');
});

test('features plan first, epics build through their tasks, and done means what happened', () => {
  assert.equal(at(T({ status: 'proposed', type: 'feature' }), { plan: { status: 'grooming' } }).line, 'The manager is writing the plan');
  assert.equal(at(T({ status: 'proposed', type: 'feature' }), { plan: { status: 'ready' } }).at, 'planned');
  const kids = [{ key: 'R-2', status: 'done' }, { key: 'R-3', status: 'in_progress' }, { key: 'R-4', status: 'wontdo' }];
  const epic = at(T({ status: 'in_progress', assignee: 'manager' }), { kids, plan: { status: 'approved' } });
  assert.equal(epic.at, 'building'); assert.equal(epic.line, '1 of 2 tasks done'); assert.equal(epic.who, null, 'the manager is not "building" the epic');
  assert.equal(at(T({ status: 'done' }), { kids }).line, 'Done (some tasks were dropped)');
  assert.equal(at(T({ status: 'done', pr_url: 'u' })).line, 'Merged');
  assert.equal(at(T({ status: 'done', owner_task: 1 })).line, 'Completed', 'an owner task is completed, not merged');
  const deploying = at(T({ status: 'done', pr_url: 'u' }), { deploy: { key: 'R-1', state: 'running' } });
  assert.equal(deploying.line, 'Merged; the deploy is running'); assert.equal(deploying.done, false);
  assert.equal(at(T({ status: 'done', pr_url: 'u' }), { deploy: { key: 'OTHER', state: 'running' } }).done, true);
  assert.equal(at(T({ status: 'wontdo' })).closed, true);
  assert.match(at(T({ status: 'mystery' })).line, /Status unavailable \(mystery\)/);
});

test('review regressions: a held merge is the owner\'s, a child queued for auto-merge is not, built parents keep their real step', () => {
  const merge = (key) => ({ id: `${key}:merge`, key, kind: 'merge', verb: `Merge ${key}` });
  const held = at(T({ status: 'ready_for_human', pr_url: 'u' }), { merges: { 'R-1': 'held' }, decisions: [merge('R-1')] });
  assert.equal(held.actions.length, 1, 'releasing a hold is the owner\'s call'); assert.match(held.line, /On hold/);
  const kids = [{ key: 'R-2', status: 'ready_for_human' }, { key: 'R-3', status: 'in_progress' }];
  const feature = at(T({ status: 'in_progress' }), { kids, merges: { 'R-2': 'queued' }, decisions: [merge('R-2')], plan: { status: 'approved' } });
  assert.deepEqual(feature.actions, [], 'the child merges by itself');
  const parent = at(T({ status: 'qa', assignee: 'senior-be' }), { kids: [{ key: 'R-4', status: 'done' }] });
  assert.equal(parent.at, 'qa', 'a ticket that has slices still shows its own QA');
  const escalated = at(T({ status: 'needs_human', resume_status: 'todo', head_sha: 'abc', qa_loops: 3, assignee: 'junior' }));
  assert.equal(escalated.at, 'building', 'repeated QA failures are rework, not "assigned"');
  assert.equal(at(T({ status: 'review', review_stage: 'merge_unknown' }), { merges: { 'R-1': 'merging' }, decisions: [merge('R-1')] }).actions.length, 0);
});
