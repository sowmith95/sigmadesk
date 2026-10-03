import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-advisors-'));
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { repoPath: tmp, githubRepo: 'test/fixture' }, github: { sync: false }, pm: { enabled: false } }));
process.env.SIGMADESK_CONFIG = cfg;
const envNames = ['PERPLEXITY_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY'];
for (const k of envNames) delete process.env[k];
let store, advisors, config, sched;
const realFetch = globalThis.fetch;
before(async () => {
  ({ config } = await import('../src/config.js')); config.root = tmp;
  store = await import('../src/db.js'); store.openDb(':memory:');
  advisors = await import('../src/advisors.js'); sched = await import('../src/scheduler.js');
});
after(() => { globalThis.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });
const fixture = () => store.createTicket({ title: 'Review recovery', description: 'Design a durable queue. API_KEY=super-private-secret', status: 'todo', area: 'backend', complexity: 'M' });
const reset = () => { store.openDb(':memory:'); store.setSetting('paused', 'false'); store.setSetting('daily_budget_usd', '100'); for (const k of envNames) delete process.env[k]; config.advisors.keyFile = ''; };

test('Architecture Review Board keeps briefs bounded and challenges independent; desktop import never grants QA', () => {
  reset(); const t = fixture();
  assert.throws(() => advisors.createBrief(t.key, { reviewer: 'made-up' }), /Unknown/);
  assert.throws(() => advisors.createBrief(t.key, { reviewer: 'google/gemini-3.8-flash', challenger: 'google/gemini-3.1-pro-preview' }), /different model family/);
  const r = advisors.createBrief(t.key, { question: 'Find races' });
  assert.ok(r.brief.includes('untrusted="true"')); assert.ok(!r.brief.includes('super-private-secret'));
  assert.throws(() => advisors.assertCanRun(r.id), /API key/);
  const done = advisors.importReport(r.id, 'Check atomicity. TOKEN=hide-this-value');
  assert.equal(done.status, 'complete'); assert.ok(!done.result.includes('hide-this-value'));
  assert.equal(store.getTicket(t.key).status, 'todo'); assert.equal(store.listComments(t.key).length, 1);
  assert.throws(() => advisors.importReport(r.id, 'twice'), /already completed/);
});

test('Advisor credentials use fixed provider endpoints and never appear in status', async () => {
  reset(); process.env.PERPLEXITY_API_KEY = 'perplexity-test'; process.env.GEMINI_API_KEY = 'gemini-test'; process.env.XAI_API_KEY = 'xai-test';
  const requests = [];
  globalThis.fetch = async (url, opts) => {
    requests.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    if (url.includes('googleapis')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Systems findings' }] } }] });
    if (url.includes('x.ai')) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Reliability findings' } }] });
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Architecture findings' }] }] });
  };
  assert.equal((await advisors.requestModel('google/gemini-3.8-flash', 'brief')).text, 'Systems findings');
  assert.equal((await advisors.requestModel('xai/grok-4.7', 'brief')).text, 'Reliability findings');
  assert.equal((await advisors.requestModel('perplexity/kimi-k3', 'brief')).text, 'Architecture findings');
  assert.equal(requests[0].headers['x-goog-api-key'], 'gemini-test');
  assert.equal(requests[1].body.model, 'grok-4.7'); assert.equal(requests[2].body.model, 'perplexity/kimi-k3');
  assert.equal(requests[2].body.max_output_tokens, config.advisors.maxOutputTokens);
  assert.ok(!JSON.stringify(advisors.status()).includes('gemini-test'));
  delete process.env.GEMINI_API_KEY;
  assert.equal(advisors.routeModel('google/gemini-3.8-flash').provider, 'perplexity');
});

test('API debate reserves budget before calls, occupies capacity and attaches findings without moving the ticket', async () => {
  reset(); process.env.PERPLEXITY_API_KEY = 'test'; const t = fixture();
  const r = advisors.createBrief(t.key, { challenger: 'xai/grok-4.7' });
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++; assert.equal(advisors.runningCount(), 1); assert.equal(sched.workCount(), 1);
    assert.equal(store.unfinishedRuns()[0].reserve_usd, 2 * config.advisors.reserveUsd);
    assert.equal(sched.budgetHeadroom(), 100 - 2 * config.advisors.reserveUsd);
    const body = JSON.parse(opts.body);
    if (calls === 2) assert.ok(body.input.includes('First findings'));
    return Response.json({ status: 'completed', output_text: calls === 1 ? 'First findings' : 'Independent challenge', usage: { input_tokens: 10, output_tokens: 20 } });
  };
  const done = await advisors.runReview(r.id);
  assert.equal(calls, 2); assert.equal(done.status, 'complete'); assert.equal(advisors.runningCount(), 0);
  assert.equal(store.getTicket(t.key).status, 'todo'); assert.equal(store.getRun(done.run_id).cost_estimated, 1);
  assert.ok(store.listComments(t.key)[0].body.includes('does not satisfy QA'));
  assert.equal(store.unfinishedRuns().length, 0);
});

test('Peer API runs respect pause, spend and capacity; failed/truncated responses finalize reservations', async () => {
  reset(); process.env.GEMINI_API_KEY = 'test'; const t = fixture();
  const r = advisors.createBrief(t.key, { reviewer: 'google/gemini-3.8-flash' });
  store.setSetting('paused', 'true'); assert.throws(() => advisors.assertCanRun(r.id), /Open the desk/);
  store.setSetting('paused', 'false'); store.setSetting('daily_budget_usd', '0'); assert.throws(() => advisors.assertCanRun(r.id), /risk limit/);
  store.setSetting('daily_budget_usd', '100'); store.setSetting('max_concurrent', '1'); store.updateAgent('qa', { status: 'working' });
  assert.throws(() => advisors.assertCanRun(r.id), /capacity/); store.updateAgent('qa', { status: 'idle' });
  globalThis.fetch = async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'unfinished' }] } }] });
  const failed = await advisors.runReview(r.id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /incomplete/);
  assert.equal(store.unfinishedRuns().length, 0); assert.equal(advisors.runningCount(), 0); assert.equal(store.listComments(t.key).length, 0);
});

test('Circuit breaker aborts API reviews; restart marks orphaned reviews failed', async () => {
  reset(); process.env.PERPLEXITY_API_KEY = 'test'; const t = fixture();
  const r = advisors.createBrief(t.key);
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (url, { signal }) => { entered(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); };
  const task = advisors.runReview(r.id); await ready; advisors.cancelAll();
  assert.equal((await task).status, 'failed'); assert.equal(store.unfinishedRuns().length, 0);
  const orphan = advisors.createBrief(t.key); store.updateArchitectureReview(orphan.id, { status: 'running' });
  advisors.recoverOrphans(); assert.equal(store.getArchitectureReview(orphan.id).status, 'failed');
});
