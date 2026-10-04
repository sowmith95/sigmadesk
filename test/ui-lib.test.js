import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-uilib-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = cfg;
let P, F, sync, research, store, team;
before(async () => {
  P = await import('../ui/src/lib/programs.js'); F = await import('../ui/src/lib/format.js'); sync = await import('../ui/src/lib/sync.js');
  store = await import('../src/db.js'); store.openDb(':memory:'); research = await import('../src/research.js'); team = await import('../src/team.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const seats = () => team.AGENTS.map((a) => a.id);
const review = { minReviewers: 1, reviewers: ['trading-advisor', 'quant-research', 'principal-be'] };

test('frequency presets, phrases and custom intervals', () => {
  assert.equal(P.frequencyPhrase(180), 'every 3 hours'); assert.equal(P.frequencyPhrase(2880), 'every 2 days'); assert.equal(P.frequencyPhrase(45), 'every 45 minutes');
  assert.equal(P.frequencyLabel(1440), 'Daily'); assert.equal(P.frequencyLabel(240), 'Every 4 hours');
  assert.deepEqual(['90', '90m', '4h', '2d', '1w', '1.5h', '10', 'x', '400d'].map(P.parseInterval), [90, 90, 240, 2880, 10080, 90, null, null, null]);
  assert.equal(P.windowPhrase('off-market'), 'outside market hours');
});

test('ids come from the label, stay valid and unique', () => {
  assert.equal(P.slugify('Reeesrch-latest articles on quant snd trading'), 'reeesrch-latest-articles-on-quant-snd-tr');
  assert.equal(P.slugify('Review complexTrading UI module!'), 'review-complextrading-ui-module');
  assert.equal(P.slugify('  '), 'program'); assert.equal(P.slugify('-- 42 --'), '42');
  assert.equal(P.uniqueId('Quant papers', ['quant-papers']), 'quant-papers-2');
  assert.match(P.slugify('Ünïcode Résumé'), /^unicode-resume$/);
});

test('templates and blank drafts produce payloads the server accepts', () => {
  const opts = { takenIds: ['product-discovery'], defaultReview: review, seats: seats() };
  const drafts = [...P.TEMPLATES.map((t) => P.fromTemplate(t, opts)), P.blankDraft(opts)];
  for (const d of drafts) {
    assert.deepEqual(P.problems(d), [], d.label);
    assert.ok(!d.reviewers.includes(d.seat), `${d.label}: researcher not in their own pool`);
  }
  const saved = research.validatePrograms(drafts.map(P.toProgram));
  assert.equal(saved.length, drafts.length);
  assert.equal(saved.find((p) => p.id === 'quant-papers').window, 'off-market');
  assert.equal(saved.find((p) => p.id === 'competitor-scan').focus, '', 'own judgment means an empty focus');
});

test('switching the researcher drops them from reviewers; mode own clears the topic in the payload', () => {
  const d = P.fromTemplate(P.TEMPLATES[0], { defaultReview: review, seats: seats() });
  const moved = P.withSeat(d, 'trading-advisor');
  assert.ok(!moved.reviewers.includes('trading-advisor')); assert.equal(moved.minReviewers, 1);
  const strict = P.withSeat({ ...d, minReviewers: 2, reviewers: ['trading-advisor', 'quant-research'] }, 'quant-research');
  assert.equal(strict.minReviewers, 2, 'the bar is not lowered'); assert.match(P.problems(strict)[0], /at least 2 reviewers/);
  const own = { ...P.fromTemplate(P.TEMPLATES[1], { defaultReview: review, seats: seats() }), mode: 'own' };
  assert.equal(P.toProgram(own).focus, '');
  assert.deepEqual(P.problems({ ...own, mode: 'directed', focus: '  ' }), ['Write the topic, or switch to "On their own".']);
});

test('client checks mirror the server rules', () => {
  const d = P.fromTemplate(P.TEMPLATES[0], { defaultReview: review, seats: seats() });
  const msgs = (patch, opts) => P.problems({ ...d, ...patch }, opts);
  assert.match(msgs({ label: ' ' })[0], /name/);
  assert.match(msgs({ intervalMinutes: 5 })[0], /how often/);
  assert.match(msgs({ reviewers: ['pm'] })[0], /cannot check their own/);
  assert.match(msgs({ minReviewers: 2, reviewers: ['quant-research'] })[0], /at least 2 reviewers/);
  assert.match(msgs({ connectors: ['paper-search'] })[0], /not approved/);
  assert.match(msgs({}, { seatEngine: 'codex' })[0], /no web search/);
  assert.match(msgs({ connectors: ['x'], web: false }, { approvedConnectors: ['x'], seatEngine: 'perplexity' })[0], /Claude Code/);
  for (const [patch, re] of [[{ reviewers: ['pm'] }, /cannot review its own/], [{ intervalMinutes: 5 }, /15 to 525600/]])
    assert.throws(() => research.normalize(P.toProgram({ ...d, ...patch })), re, 'the server agrees');
});

test('saving one program keeps the others exactly as saved', () => {
  const saved = research.programs();
  const draft = P.fromTemplate(P.TEMPLATES[1], { takenIds: saved.map((p) => p.id), defaultReview: review, seats: seats() });
  const list = P.listWith(saved, draft);
  assert.equal(list.length, saved.length + 1);
  assert.deepEqual(research.validatePrograms(list).map((p) => p.id), [...saved.map((p) => p.id), draft.id]);
  const edited = P.listWith(research.validatePrograms(list), { ...draft, label: 'Quant papers weekly', intervalMinutes: 10080 });
  assert.equal(edited.length, saved.length + 1); assert.equal(edited.at(-1).intervalMinutes, 10080);
  assert.deepEqual(P.listWithout(research.validatePrograms(list), draft.id).map((p) => p.id), saved.map((p) => p.id));
});

test('the program sentence reads naturally', () => {
  const agents = team.AGENTS;
  const d = { ...P.fromTemplate(P.TEMPLATES[1], { defaultReview: review, seats: seats() }), reviewers: ['trading-advisor'], minReviewers: 1 };
  const text = P.sentence(d, agents).map((p) => p.text).join('');
  assert.equal(text, 'Reese researches volatility, options pricing and execution papers that could change… once a day, outside market hours. Checked by Alex.');
  assert.match(P.sentence({ ...d, focus: 'Earnings season flow' }, agents).map((p) => p.text).join(''), /researches earnings season flow once/);
  assert.match(P.sentence({ ...d, focus: 'SEC filings' }, agents).map((p) => p.text).join(''), /researches SEC filings once/);
  const own = P.sentence({ ...d, mode: 'own', reviewers: ['trading-advisor', 'principal-be'], minReviewers: 1 }, agents).map((p) => p.text).join('');
  assert.match(own, /researches on their own judgment once a day/); assert.match(own, /Checked by 1 of Alex, Rowan\./);
  assert.ok(P.sentence(d, agents).filter((p) => p.slot).length === 5);
});

test('formatting helpers and the stream contract', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(F.ago('2026-10-04T11:58:00Z', now), '2 min ago'); assert.equal(F.until('2026-10-04T14:00:00Z', now), 'in 2 h'); assert.equal(F.waited('2026-10-04T11:59:40Z', now), 'waiting under a minute');
  assert.equal(F.outcome('Changed a/b/c/file.py. Tests pass! Extra sentence.'), 'Changed file.py. Tests pass!');
  assert.equal(F.outcome('Bumped to v1.2 today. Done.'), 'Bumped to v1.2 today. Done.');
  assert.equal(F.prNumber('https://github.com/o/r/pull/42'), 42); assert.equal(F.questionText('❓ **Question for the owner:** Which?'), 'Which?');
  // Stream deltas: tickets upsert, events dedupe and cap, detail routing parks items until the detail loads.
  const S = { tickets: [{ key: 'T-1', title: 'a' }], agents: [{ id: 'pm', status: 'idle' }], events: [], runs: [], settings: { team: '{}' }, incidents: [], councils: { 3: {} }, questions: { 'T-1': {} },
    detail: { key: 'T-1', data: null, pending: sync.emptyPending() }, seat: { id: 'pm', events: [] } };
  sync.applyDelta(S, { type: 'ticket', data: { key: 'T-1', title: 'b' } }); assert.equal(S.tickets[0].title, 'b');
  sync.applyDelta(S, { type: 'event', data: { id: 1, ticket_key: 'T-1', agent_id: 'pm', text: 'x' } });
  sync.applyDelta(S, { type: 'event', data: { id: 1, ticket_key: 'T-1', agent_id: 'pm', text: 'x' } });
  assert.equal(S.events.length, 1); assert.equal(S.detail.pending.events.length, 1); assert.equal(S.seat.events.length, 2, 'seat log appends raw');
  sync.applyDelta(S, { type: 'comment', data: { id: 9, ticket_key: 'T-1', body: '❓ q' } }); assert.equal(S.questions['T-1'], undefined);
  assert.deepEqual(sync.applyDelta(S, { type: 'council', data: { id: 3 } }), { meta: true, research: false }); assert.equal(S.councils[3], undefined);
  assert.deepEqual(sync.applyDelta(S, { type: 'connector', data: {} }), { meta: true, research: true });
  assert.equal(sync.applyDelta(S, { type: 'settings', data: { team: '{}' } }).meta, false, 'unchanged team: no snapshot');
  // Before the detail loads, reviews and branch refreshes are parked too (v2 dropped them).
  sync.applyDelta(S, { type: 'branch-refresh', data: { ticket_key: 'T-1', status: 'rebased' } });
  sync.applyDelta(S, { type: 'product-review', data: { ticket_key: 'T-1', phase: 'plan', revision: 2, status: 'reviewing' } });
  sync.applyDelta(S, { type: 'research-review', data: { id: 4, ticket_key: 'T-1', verdict: 'pass' } });
  sync.applyDelta(S, { type: 'research-review', data: { id: 4, ticket_key: 'T-2', verdict: 'x' } });
  assert.equal(S.detail.pending.refresh.status, 'rebased'); assert.equal(S.detail.pending.product_reviews.length, 1); assert.equal(S.detail.pending.research_reviews.length, 1);
  const pend = { ...sync.emptyPending(), comments: [{ id: 1, body: 'new' }, { id: 5, body: 'live' }], events: [{ id: 1 }], discussions: [{ id: 7, status: 'complete' }],
    product_reviews: [{ phase: 'plan', revision: 2, status: 'reviewing' }], research_reviews: [{ id: 4, verdict: 'pass' }], refresh: { status: 'rebased' } };
  const prev = { discussions: [{ id: 7, status: 'running' }, { id: 6, status: 'complete' }] };
  const merged = sync.mergeDetail(prev, { comments: [{ id: 1, body: 'old' }], events: [{ id: 2 }], discussions: [{ id: 7, status: 'running' }], product_reviews: [{ phase: 'plan', revision: 1 }], research_reviews: [] }, pend);
  assert.deepEqual(merged.comments.map((c) => c.body), ['new', 'live']); assert.deepEqual(merged.events.map((e) => e.id), [1, 2]);
  assert.deepEqual(merged.discussions.map((x) => [x.id, x.status]), [[6, 'complete'], [7, 'complete']], 'shown discussions kept; newest status wins');
  assert.equal(merged.product_reviews[0].revision, 2); assert.equal(merged.research_reviews[0].verdict, 'pass'); assert.equal(merged.refresh.status, 'rebased');
  const fresher = sync.mergeDetail({ discussions: [{ id: 7, status: 'running' }] }, { discussions: [{ id: 7, status: 'approved' }] }, sync.emptyPending());
  assert.equal(fresher.discussions[0].status, 'approved', 'a refetch beats what was shown');
});
