import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-council-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg;
let store, council, sched, config, runner, dispatch;
const realFetch = globalThis.fetch;
const report = (verdict = 'changes', issue = 'Concurrent workers can overspend') => ({ verdict, recommendation: verdict === 'changes' ? 'Reserve all calls before starting' : 'The contract is satisfied', findings: verdict === 'changes' ? [{ severity: 'high', evidence: 'budget.js:2 omits active reservations', issue, test: 'Start two workers with one-call headroom' }] : [], alternatives: [], dissent: [], conditions: [] });
const reply = (r) => ({ ok: true, json: async () => ({ output_text: JSON.stringify(r), usage: { cost: { total_cost: .05 } } }) });
const options = { members: [{ model: 'perplexity/kimi-k3', lens: 'architecture' }, { model: 'perplexity/glm-5.3', lens: 'reliability' }], synthesizer: 'perplexity/kimi-k3' };
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); council = await import('../src/council.js'); sched = await import('../src/scheduler.js'); runner = await import('../src/runner.js'); dispatch = await import('../src/dispatch.js');
});
after(() => { globalThis.fetch = realFetch; delete process.env.PERPLEXITY_API_KEY; fs.rmSync(tmp, { recursive: true, force: true }); });
function reset() {
  store.openDb(':memory:'); store.setSetting('paused', 'false'); store.setSetting('daily_budget_usd', '100'); store.setSetting('max_concurrent', '3');
  process.env.PERPLEXITY_API_KEY = 'fixture-key'; config.advisors.keyFile = '';
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true, defaultModel: 'fixture' }]);
  return store.createTicket({ title: 'Concurrent budget accounting', description: 'budget.js:2 computes daily - spend. API_KEY=secret-example-value', status: 'needs_human', area: 'backend', complexity: 'L' });
}
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('Council did not settle'); }
const done = (id) => until(() => ['complete','partial','failed','cancelled','stale'].includes(store.getCouncil(id).status) && !council.preparingCount() && !council.externalRunningCount());

test('parallel reviews see the same frozen evidence, reserve every call and leave a QA slot', async () => {
  const t = reset(), requests = [], resolvers = [];
  globalThis.fetch = async (_url, opts) => { requests.push(JSON.parse(opts.body).input); if (requests.length <= 2) return new Promise((r) => resolvers.push(r)); return reply(report()); };
  const c = council.create(t.key, options); council.queue(c.id);
  assert.equal(sched.budgetHeadroom(), 97); council.pump();
  assert.equal(requests.length, 2); assert.equal(sched.workCount(), 2); assert.equal(sched.budgetHeadroom(), 97);
  const frozen = (p) => p.slice(p.indexOf('<evidence'), p.indexOf('</evidence>'));
  assert.equal(frozen(requests[0]), frozen(requests[1])); assert.ok(requests.every((p) => !p.includes('<blinded-reviews') && !p.includes('secret-example-value')));
  resolvers.forEach((r) => r(reply(report()))); await done(c.id);
  const complete = council.current(c.id); assert.equal(complete.status, 'complete'); assert.equal(requests.length, 3);
  assert.ok(requests[2].includes('Reviewer A')); assert.ok(!requests[2].includes('perplexity/kimi-k3') && !requests[2].includes('perplexity/glm-5.3'));
  assert.equal(complete.members.filter((m) => m.status === 'complete').length, 3); assert.equal(store.getTicket(t.key).status, 'needs_human');
  assert.equal(council.reservations(), 0); assert.ok(Math.abs(sched.budgetHeadroom() - 99.85) < 1e-6);
});

test('partial failures retain successful evidence and retry only failed reviewers plus synthesis', async () => {
  const t = reset(); let n = 0;
  globalThis.fetch = async () => { n++; if (n === 2) return { ok: false, status: 429 }; return reply(report()); };
  const c = council.create(t.key, options); council.queue(c.id); council.pump(); await done(c.id);
  const partial = council.current(c.id); assert.equal(partial.status, 'partial'); assert.ok(partial.members[0].result); assert.ok(partial.members[1].error);
  assert.throws(() => council.decide(c.id, { decision: 'approve' }), /partial/);
  const retry = council.retry(c.id); assert.equal(retry.members[0].run_id, partial.members[0].run_id); assert.equal(council.reservations(), 2);
  council.pump(); await done(retry.id); assert.equal(n, 5); assert.equal(council.current(retry.id).status, 'complete');
  assert.equal(council.current(c.id).members[0].result, partial.members[0].result);
});

test('changed SHA/spec invalidates a council, progress does not; corrections schedule a new council and never move tickets', async () => {
  const t = reset(); globalThis.fetch = async () => reply(report());
  const c = council.create(t.key, options); store.updateTicket(t.key, { progress: 50 }); assert.equal(council.current(c.id).stale, false);
  council.queue(c.id); council.pump(); await done(c.id);
  assert.throws(() => council.decide(c.id, { decision: 'correction' }), /Describe/);
  const decision = council.decide(c.id, { decision: 'correction', message: 'Compare bounded reservations with admission tokens' });
  assert.equal(decision.followup.status, 'queued'); assert.notEqual(decision.followup.input_hash, c.input_hash); assert.equal(store.getTicket(t.key).status, 'needs_human');
  council.pump(); await done(decision.followup.id);
  store.updateTicket(t.key, { head_sha: 'a'.repeat(40) }); assert.equal(council.current(decision.followup.id).stale, true);
  assert.throws(() => council.decide(decision.followup.id, { decision: 'approve' }), /stale/);
  assert.throws(() => council.queue(council.create(t.key, { ...options, question: 'new' }).id + 99), /not found/);
});

test('a single bounded blinded challenge runs only on disagreement, without model identities', async () => {
  const t = reset(), requests = []; let n = 0;
  globalThis.fetch = async (_url, opts) => { requests.push(JSON.parse(opts.body).input); return reply(report(++n === 2 ? 'acceptable' : 'changes')); };
  const c = council.create(t.key, { ...options, challenge: true }); council.queue(c.id); assert.equal(council.reservations(), 5); council.pump(); await done(c.id);
  assert.equal(requests.length, 5); assert.equal(council.current(c.id).members.filter((m) => m.stage === 'challenge' && m.status === 'complete').length, 2);
  assert.ok(requests[2].includes('blinded-reviews') && !requests[2].includes('perplexity/glm-5.3'));
  const c2 = council.create(t.key, { ...options, challenge: true }); council.queue(c2.id); council.pump(); await done(c2.id);
  assert.equal(requests.length, 8); assert.equal(council.current(c2.id).members.filter((m) => m.status === 'skipped').length, 2);
});

test('capacity/budget/provider guards and cancellation finalize API runs without losing completed work', async () => {
  const t = reset(); const c = council.create(t.key, options);
  store.setSetting('daily_budget_usd', '2'); assert.throws(() => council.queue(c.id), /Daily/); store.setSetting('daily_budget_usd', '100');
  store.setSetting('max_concurrent', '1'); assert.throws(() => council.queue(c.id), /at least two/); store.setSetting('max_concurrent', '3');
  delete process.env.PERPLEXITY_API_KEY; assert.throws(() => council.queue(c.id), /unavailable/); process.env.PERPLEXITY_API_KEY = 'fixture-key';
  globalThis.fetch = async (_url, opts) => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  council.queue(c.id); council.pump(); assert.equal(sched.workCount(), 2);
  council.cancel(c.id); await done(c.id); assert.equal(council.reservations(), 0); assert.equal(store.unfinishedRuns().length, 0); assert.equal(store.spendSince(sched.startOfToday()), 2);
});

test('restart retains first judgments and requires an explicit retry; council calls cannot mutate the desk', async () => {
  const t = reset(), c = council.create(t.key, options); council.queue(c.id);
  store.updateCouncilMember(c.members[0].id, { status: 'complete', result: JSON.stringify(report()) });
  store.updateCouncilMember(c.members[1].id, { status: 'preparing' }); council.recoverOrphans();
  const orphan = council.current(c.id); assert.equal(orphan.status, 'failed'); assert.ok(orphan.members[0].result); assert.equal(council.reservations(), 0);
  await assert.rejects(sched.deskAction({ kind: 'council_review', agent_id: 'principal-be', ticket_key: t.key }, 'create-task', {}), /cannot invoke/);
  assert.throws(() => council.create(t.key, { ...options, members: [{ model: 'evil', lens: 'architecture' }, options.members[1]] }), /Unknown/);
  assert.throws(() => council.create(t.key, { ...options, members: [{ model: options.members[0].model, lens: 'make-pushes' }, options.members[1]] }), /lens/);
  const codex = runner.buildCommand({ id: 'principal-be', engine: 'codex', model: '', effort: 'high' }, 'council_review', tmp);
  assert.ok(codex.args.includes('features.shell_tool=false')); assert.ok(codex.args.includes('default_permissions="sigmadesk_review"')); assert.equal(codex.mailbox, false);
  const claude = runner.buildCommand({ id: 'principal-be', engine: 'claude', model: 'sonnet', effort: 'high' }, 'council_review', tmp);
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.throws(() => runner.startRun({ agentId: 'principal-be', kind: 'implement', prompt: '', cwd: tmp, reviewProfile: { engine: 'codex', model: '', effort: 'high' } }), /restricted/);
});

test('single and sequential baselines use one/two calls and sequential access to previous findings is explicit', async () => {
  const t = reset(), requests = [];
  globalThis.fetch = async (_url, opts) => { requests.push(JSON.parse(opts.body).input); return reply(report()); };
  const single = council.create(t.key, { ...options, strategy: 'single', members: [options.members[0]] }); council.queue(single.id); council.pump(); await done(single.id); assert.equal(requests.length, 1);
  const sequential = council.create(t.key, { ...options, strategy: 'sequential' }); council.queue(sequential.id); council.pump(); await done(sequential.id); assert.equal(requests.length, 3);
  assert.ok(!requests[1].includes('previous-review')); assert.ok(requests[2].includes('previous-review'));
});

test('correction preflight is atomic and never creates a phantom follow-up when funds are unavailable', async () => {
  const t = reset(); globalThis.fetch = async () => reply(report());
  const c = council.create(t.key, options); council.queue(c.id); council.pump(); await done(c.id);
  store.setSetting('daily_budget_usd', '.2');
  assert.throws(() => council.decide(c.id, { decision: 'correction', message: 'Revisit reservation granularity' }), /Daily/);
  assert.equal(store.listCouncils(t.key).length, 1); assert.equal(council.current(c.id).decision, null);
});

test('never-started queued councils survive restart and structured redaction preserves valid JSON', async () => {
  const t = reset(), c = council.create(t.key, options); council.queue(c.id); council.recoverOrphans();
  assert.equal(council.current(c.id).status, 'queued'); assert.equal(council.reservations(), 3);
  globalThis.fetch = async () => reply({ ...report(), recommendation: 'Use scoped auth. API_KEY=not-a-real-secret' });
  council.pump(); await done(c.id); const final = council.current(c.id);
  assert.equal(final.status, 'complete'); assert.ok(!final.result.includes('not-a-real-secret')); assert.ok(JSON.parse(final.result).recommendation);
});

test('manager council routing is bounded and respects its approved model catalog', async () => {
  const t = reset(), run = store.createRun({ agent_id: 'manager', ticket_key: t.key, kind: 'groom', model: 'codex:fixture', token: null });
  const output = await sched.deskAction(run, 'council', { reviewer: 'perplexity/kimi-k3', challenger: 'perplexity/glm-5.3', profile: 'data', body: 'Assess atomic cursor advancement' });
  assert.match(output, /queued/); assert.equal(store.pendingCouncils().length, 1); assert.equal(store.getCouncil(1).members[0].lens, 'data');
  await assert.rejects(sched.deskAction(run, 'council', { body: 'again' }), /one peer review or council/);
  council.cancelAll(); store.updateRun(run.id, { status: 'success', ended_at: store.now() });
});

test('council evidence stays in the desk instead of being automatically posted to GitHub', async () => {
  const t = reset(); store.updateTicket(t.key, { issue_number: 123 }); globalThis.fetch = async () => reply(report());
  const c = council.create(t.key, options); council.queue(c.id); council.pump(); await done(c.id);
  council.decide(c.id, { decision: 'reject', message: 'Keep the current approach' });
  assert.ok(store.listComments(t.key).some((c) => c.author === 'council'));
  assert.ok(!store.unsyncedComments().some((c) => c.author === 'council')); assert.equal(store.getTicket(t.key).status, 'needs_human');
});

test('a thinking-seat relay without council support cannot silently substitute a different reviewer', () => {
  reset();
  assert.ok(council.models().filter((m) => m.engine).every((m) => ['claude','codex'].includes(m.engine)));
  assert.throws(() => dispatch.reviewSelection('principal-be', { engine: 'perplexity', model: 'pplx_asi_kimi_k3', effort: 'high' }), /approved catalog/);
});
