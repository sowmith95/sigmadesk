import { test } from 'node:test';
import assert from 'node:assert/strict';
import { departmentsFor, departmentConfig, DEFAULT_DEPARTMENTS, departmentOf, departmentCounts, seatStates, flowsFrom, departmentFlows,
  departmentKpis, exceptions, isNight, FLOW_WINDOW_MS } from '../public/departments.js';
import { presenceFor } from '../public/presence.js';
import { board } from '../public/attention.js';

const NOW = Date.parse('2026-10-07T15:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const A = (id, name, role, extra = {}) => ({ id, name, role, status: 'idle', enabled: true, ...extra });
const agents = [
  A('pm', 'Avery', 'Principal Product Manager'), A('manager', 'Morgan', 'Engineering Manager'), A('principal-be', 'Rowan', 'Principal Backend Engineer'),
  A('senior-be', 'Jordan', 'Senior Backend Engineer'), A('principal-fe', 'Sage', 'Principal Frontend Engineer'), A('senior-fe', 'Quinn', 'Senior Frontend Engineer'),
  A('dba', 'Casey', 'Database Engineer'), A('junior', 'Riley', 'Junior Engineer'), A('qa', 'Taylor', 'QA Engineer'), A('sre', 'Devon', 'Site Reliability Engineer'),
  A('support', 'Skyler', 'Support Bot'), A('product-design', 'Harper', 'Product Designer', { kinds: ['product_review'], advisor: { id: 'product-design' } }),
  A('quant-research', 'Reese', 'Quant Researcher', { kinds: ['product_review'], advisor: { id: 'quant-research' } }),
];

test('default departments: every seat in exactly one, advisors with Research unless listed, in config order', () => {
  const deps = departmentsFor(agents);
  assert.deepEqual(deps.map((d) => d.id), ['planning', 'backend', 'data', 'ui', 'qa', 'reliability', 'research']);
  assert.deepEqual(deps.find((d) => d.id === 'ui').seats, ['principal-fe', 'senior-fe', 'product-design']);
  assert.deepEqual(deps.find((d) => d.id === 'research').seats, ['pm', 'quant-research']);
  const all = deps.flatMap((d) => d.seats);
  assert.equal(all.length, agents.length); assert.equal(new Set(all).size, agents.length);
});

test('a configured grouping wins; unknown seats go to Other seats; a malformed setting falls back to the defaults', () => {
  const deps = departmentsFor(agents, JSON.stringify([{ id: 'build', label: 'Build', seats: ['senior-be', 'senior-fe', 'nobody'], areas: ['backend'] }, { id: 'ideas', seats: ['pm'], advisors: true }]));
  assert.deepEqual(deps.map((d) => d.id), ['build', 'ideas', 'other']);
  assert.deepEqual(deps[0].seats, ['senior-be', 'senior-fe']);
  assert.deepEqual(deps[1].seats, ['pm', 'product-design', 'quant-research']);
  for (const bad of ['{nope', '[{"label":"no id"}]', '[]']) assert.equal(departmentConfig(bad), DEFAULT_DEPARTMENTS);
});

test('an item belongs to its worker, else its assignee, else its area, else planning; desk items by kind', () => {
  const deps = departmentsFor(agents);
  assert.equal(departmentOf({ worker: 'qa', ticket: { assignee: 'senior-fe' } }, deps), 'qa');
  assert.equal(departmentOf({ ticket: { assignee: 'dba', area: 'frontend' } }, deps), 'data');
  assert.equal(departmentOf({ ticket: { assignee: null, area: 'frontend' } }, deps), 'ui');
  assert.equal(departmentOf({ ticket: { area: 'infra' } }, deps), 'reliability');
  assert.equal(departmentOf({ ticket: {} }, deps), 'planning');
  assert.equal(departmentOf({ kind: 'page' }, deps), 'reliability');
  assert.equal(departmentOf({ kind: 'deploy', ticket: { assignee: 'senior-be' } }, deps), 'qa');
  assert.equal(departmentOf({ kind: 'access', access: { seat: 'sre' } }, deps), 'reliability');
});

const working = (id, key, run, kind = 'implement') => ({ ...agents.find((a) => a.id === id), status: 'working', current_ticket: key, current_run: run, current_kind: kind });
const seats = (...w) => agents.map((a) => w.find((x) => x.id === a.id) || a);
const run = (id, agent, msAgo, key, status = 'running', kind = 'implement') => ({ id, agent_id: agent, ticket_key: key, kind, status, started_at: at(msAgo) });
const ev = (id, kind, text, msAgo, extra = {}) => ({ id, kind, text, ts: at(msAgo), ...extra });

test('department counts partition the attention board: they add up to the Inbox and Work counts', () => {
  const tickets = [
    { key: 'SD-1', title: 'Build the composer', status: 'in_progress', assignee: 'senior-fe', area: 'frontend' },
    { key: 'SD-2', title: 'Replay fills', status: 'todo', assignee: 'junior', area: 'backend' },
    { key: 'SD-3', title: 'Verify fallbacks', status: 'qa', assignee: 'qa' },
    { key: 'SD-4', title: 'Nobody owns this', status: 'todo', assignee: null },
    { key: 'SD-5', title: 'Unblock the feed', status: 'todo', assignee: 'sre' },
    { key: 'SD-6', title: 'Reviewed by Sage', status: 'review', assignee: 'senior-be' },
    { key: 'SD-7', title: 'Should alerts page', status: 'needs_human', assignee: 'manager', progress_msg: 'question' },
    { key: 'SD-8', title: 'Merge the journal', status: 'ready_for_human', assignee: 'dba', pr_url: 'https://github.com/x/y/pull/3' },
  ];
  const ag = seats(working('senior-fe', 'SD-1', 1), working('principal-fe', 'SD-6', 2, 'review'));
  const state = { tickets, agents: ag, events: [], incidents: [{ id: 9, status: 'paged', label: 'API', normalized: 'boom' }],
    meta: { scheduler: { waiting: [{ key: 'SD-5', seat: 'sre', code: 'provider_hold', reason: 'no engine available' }] } } };
  const B = board(state, { now: NOW });
  const deps = departmentsFor(ag);
  const c = departmentCounts(B, deps);
  for (const k of ['working', 'queued', 'blocked']) assert.equal(Object.values(c).reduce((s, x) => s + x[k], 0), B.counts[k], k);
  assert.equal(Object.values(c).reduce((s, x) => s + x.waiting.length, 0), B.counts.needs_you, 'waiting decisions = the Inbox count');
  assert.equal(c.ui.working, 2, 'the reviewer runs SD-6: it is UI work while Sage reviews it');
  assert.equal(c.reliability.blocked, 1);
  assert.equal(c.planning.queued, 1, 'an unassigned ticket with no area lands in planning, counted once');
  assert.deepEqual(c.reliability.waiting.map((x) => x.kind), ['page']);
  assert.deepEqual(c.data.waiting.map((x) => x.kind), ['merge']);
});

test('seat states are the presence verdicts: working (fresh step), quiet, stalled; off, next and idle otherwise', () => {
  const ag = seats(working('senior-fe', 'SD-1', 1), working('principal-fe', 'SD-1', 2, 'review'), working('junior', 'SD-2', 3), { ...agents.find((a) => a.id === 'support'), enabled: false });
  const runs = [run(1, 'senior-fe', 600_000, 'SD-1'), run(2, 'principal-fe', 600_000, 'SD-1', 'running', 'review'), run(3, 'junior', 8 * 60_000, 'SD-2')];
  const events = [ev(1, 'tool', 'Reading ui/src/ticket/TicketSheet.tsx', 10_000, { run_id: 1, ticket_key: 'SD-1' }), ev(2, 'action', 'Drafting the review', 120_000, { run_id: 2, ticket_key: 'SD-1' })];
  const st = seatStates({ agents: ag, runs, events, waiting: [{ key: 'SD-3', seat: 'qa', code: 'paused' }], now: NOW });
  assert.deepEqual(['senior-fe', 'principal-fe', 'junior', 'support', 'qa', 'pm'].map((s) => st[s].state), ['working', 'quiet', 'stalled', 'off', 'next', 'idle']);
  for (const id of ['senior-fe', 'principal-fe', 'junior']) {
    const w = presenceFor({ key: st[id].ticket, agents: ag, runs, events, now: NOW }).writers.find((x) => x.seat === id);
    assert.equal(st[id].state, w.state === 'writing' ? 'working' : w.state, id);
  }
  const done = seatStates({ agents, runs: [run(9, 'qa', 60_000, 'SD-3', 'done')], events: [ev(5, 'tool', '$ npm test', 5_000, { run_id: 9, ticket_key: 'SD-3' })], now: NOW });
  assert.equal(done.qa.state, 'idle', 'a finished run never makes anyone working');
  const sre = seats({ ...agents.find((a) => a.id === 'sre'), status: 'working', current_run: 4, current_ticket: null, current_kind: 'investigate' });
  assert.equal(seatStates({ agents: sre, runs: [run(4, 'sre', 300_000, null, 'running', 'investigate')], events: [ev(1, 'tool', '$ tail', 5_000, { run_id: 4 })], now: NOW }).sre.state, 'working');
});

test('hand-offs come only from logged events, inside the window, and roll up per department pair', () => {
  const tickets = [{ key: 'SD-1', title: 'Composer', status: 'qa', assignee: 'senior-fe' }, { key: 'SD-7', title: 'Fills', status: 'in_progress', assignee: 'principal-be' }];
  const events = [
    ev(1, 'tool', 'Editing parts.tsx', 9 * 60_000, { agent_id: 'senior-fe', ticket_key: 'SD-1', run_id: 1 }),
    ev(2, 'action', 'submitted SD-1 for QA (abc1234)', 8 * 60_000, { agent_id: 'senior-fe', ticket_key: 'SD-1', run_id: 1 }),
    ev(3, 'pickup', 'QA picked up SD-1', 7 * 60_000, { agent_id: 'qa', ticket_key: 'SD-1' }),
    ev(4, 'pickup', 'Principal Frontend Engineer is reviewing SD-1 at abc1234 (frontend reviewer)', 6 * 60_000, { agent_id: 'principal-fe', ticket_key: 'SD-1' }),
    ev(5, 'action', 'sliced SD-8 (S) for Junior Engineer after SD-9', 5 * 60_000, { agent_id: 'principal-be', ticket_key: 'SD-8' }),
    ev(6, 'action', 'created task SD-9 for the owner', 4 * 60_000, { agent_id: 'principal-be', ticket_key: 'SD-9' }),
    ev(7, 'run', 'Site Reliability Engineer started mention on opus (high)', 3 * 60_000, { agent_id: 'sre', ticket_key: 'SD-7' }),
    ev(8, 'action', 'Morgan gave Devon production read access for 1 hour to use the read-only probes', 2 * 60_000, { agent_id: 'manager' }),
    ev(9, 'action', 'The owner gave Casey production read access for SD-7 to use the read-only probes', 90_000, { agent_id: 'owner', ticket_key: 'SD-7' }),
    ev(10, 'pickup', 'verifying in production: Fills', 60_000, { agent_id: 'sre', ticket_key: 'SD-7' }),
    ev(11, 'action', "answered the owner's tag: yes, covered", 30_000, { agent_id: 'sre', ticket_key: 'SD-7' }),
    ev(12, 'action', 'groomed SD-7 → M/backend, staffed Principal Backend Engineer', 20_000, { agent_id: 'manager', ticket_key: 'SD-7' }),
    ev(13, 'pickup', 'QA picked up SD-99', 10_000, { agent_id: 'qa', ticket_key: 'SD-99' }), // nobody else on record: no line
    ev(14, 'pickup', 'QA picked up SD-1', FLOW_WINDOW_MS + 1000, { agent_id: 'qa', ticket_key: 'SD-1' }), // too old
    ev(15, 'say', 'I will hand this to QA', 5_000, { agent_id: 'senior-fe', ticket_key: 'SD-1' }), // talk is not a hand-off
  ];
  const f = flowsFrom({ events, agents, tickets, now: NOW });
  assert.deepEqual(f.map((x) => `${x.kind}:${x.from}>${x.to}`), [
    'slice:manager>principal-be', 'mention:sre>owner', 'verify:principal-be>sre', 'access:owner>dba', 'access:manager>sre',
    'mention:owner>sre', 'slice:principal-be>owner', 'slice:principal-be>junior', 'review:qa>principal-fe', 'qa:senior-fe>qa',
  ]);
  assert.ok(f[0].strength > f.at(-1).strength, 'newer hand-offs are stronger');
  const d = departmentFlows(f, departmentsFor(agents));
  const pairs = d.map((x) => `${x.from}>${x.to}:${x.count}`);
  assert.ok(pairs.includes('ui>qa:1') && pairs.includes('qa>ui:1') && pairs.includes('planning>backend:1') && pairs.includes('owner>reliability:1'));
  assert.ok(!pairs.some((p) => p.startsWith('backend>backend')), 'hand-offs inside a department are not drawn between departments');
});

test('KPIs say their source, time and window, and unknown ones say why; merged, deployed and verified stay separate', () => {
  const deps = departmentsFor(agents);
  const tickets = [
    { key: 'SD-1', title: 'A request', status: 'triage', created_at: at(4 * 86400_000) },
    { key: 'SD-2', title: 'Wrong fill price', status: 'todo', type: 'bug', assignee: 'senior-be' },
    { key: 'SD-3', title: 'Merged last week', status: 'done', pr_url: 'u', done_at: at(2 * 86400_000) },
    { key: 'SD-4', title: 'Merged long ago', status: 'done', pr_url: 'u', done_at: at(20 * 86400_000) },
    { key: 'SD-5', title: 'Awaiting merge', status: 'ready_for_human', pr_url: 'u', updated_at: at(3 * 3600_000) },
  ];
  const state = { tickets, agents, incidents: [{ id: 1, status: 'investigating', first_seen: at(40 * 60_000) }],
    events: [ev(1, 'action', 'verified in production: counts match', 60_000, { agent_id: 'sre' })],
    meta: { deploy_lock: { state: 'failed', at: at(25 * 60_000) }, watch: { enabled: true, sources: [{ type: 'file', label: 'API log', ok: true, lastPoll: at(20_000) }] } } };
  const { departments: K, release } = departmentKpis(state, deps, { now: NOW, board: board(state, { now: NOW }) });
  for (const d of deps) {
    assert.equal(K[d.id].kpis.length, 2, d.id);
    for (const k of K[d.id].kpis) {
      assert.ok(k.source, `${d.id}/${k.label} has a source`);
      if (k.unknown) assert.equal(k.value, null); else assert.ok(k.at && k.window, `${d.id}/${k.label} has a time and a window`);
    }
  }
  const v = (id, label) => K[id].kpis.find((k) => k.label === label);
  assert.equal(v('planning', 'Oldest unresolved request').value, '4 d');
  assert.equal(v('backend', 'Open backend defects').value, '1');
  assert.match(v('data', 'Ingest freshness vs threshold').unknown, /does not observe/);
  assert.equal(v('qa', 'Oldest review wait').value, '3 h');
  assert.equal(v('qa', 'Deployment hold').value, 'failed deploy · 25 min'); assert.equal(v('qa', 'Deployment hold').tone, 'blocked');
  assert.equal(v('reliability', 'Active production incidents').value, '1 · oldest 40 min');
  assert.equal(v('reliability', 'Latest healthy observation').value, '0 min ago');
  // Without deploy history from the server, deployed and verified are unknown: a "verified in production" event is a
  // verification report, not a deployment, so it is never counted as one (#7).
  assert.deepEqual(release.map((r) => [r.label, r.value]), [['Merged', '1'], ['Deployed', null], ['Production-verified', null]]);
  assert.match(release[1].unknown, /deploy history/);
  // With the post-deploy watch summary: distinct deployments, one window, verified as "x of deployed".
  const withHistory = departmentKpis({ ...state, meta: { ...state.meta, production: { kpis: { window_days: 7, since: at(7 * 86400_000), observed_at: at(0), deployments: 3, deployed: 2, failed: 1, verified: 1, regression: 0, inconclusive: 0, watching: 1, superseded: 0 } } } }, deps, { now: NOW }).release;
  assert.deepEqual(withHistory.map((r) => [r.label, r.value]), [['Merged', '1'], ['Deployed', '2'], ['Production-verified', '1 of 2']]);
  assert.ok(withHistory.every((r) => r.window === 'last 7 days'), 'one window for all three');
});

test('exceptions lead with deploy holds, incidents and stalled runs, then approvals oldest first', () => {
  const B = { needs_you: [
    { id: 'SD-1:merge', kind: 'merge', verb: 'Merge A', since: at(10 * 60_000) },
    { id: 'SD-2:question', kind: 'question', verb: 'Answer Rowan', since: at(50 * 60_000) },
    { id: 'deploy:x:failed', kind: 'deploy', verb: 'The deploy failed', reason: 'ci', deploy: { at: at(5 * 60_000) } },
  ] };
  const ex = exceptions({ board: B, states: { junior: { state: 'stalled', ageMs: 8 * 60_000, ticket: 'SD-9', label: '' } }, agents, incidents: [{ id: 3, status: 'paged', label: 'API', first_seen: at(60_000) }], now: NOW });
  assert.deepEqual(ex.map((e) => e.type), ['deploy', 'incident', 'stalled', 'approval', 'approval']);
  assert.equal(ex[2].title, 'Riley · no update for 8 min');
  assert.deepEqual(ex.slice(3).map((e) => e.id), ['SD-2:question', 'SD-1:merge']);
});

test('night on the wall wraps past midnight and can be switched off', () => {
  const d = (h) => new Date(2026, 9, 7, h, 30);
  assert.equal(isNight(d(23)), true); assert.equal(isNight(d(3)), true); assert.equal(isNight(d(7)), false); assert.equal(isNight(d(12)), false);
  assert.equal(isNight(d(13), '12-14'), true); assert.equal(isNight(d(23), 'off'), false);
});
