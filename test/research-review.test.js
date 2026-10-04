import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-rr-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]); fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { stdio: 'ignore' });
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ project: { name: 'demo', repoPath: repo, githubRepo: '', ticketPrefix: 'R' }, github: { sync: false }, pm: { enabled: true } }));
process.env.SIGMADESK_CONFIG = cfg;
let store, sched, rr, dispatch, team;
before(async () => {
  store = await import('../src/db.js'); team = await import('../src/team.js'); sched = await import('../src/scheduler.js'); rr = await import('../src/research-review.js'); dispatch = await import('../src/dispatch.js');
  store.openDb(':memory:'); store.setSetting('paused', 'false'); store.setSetting('max_open_proposals', '5');
  dispatch.setAvailability([{ id: 'claude', available: true }, { id: 'codex', available: true, defaultModel: 'fixture' }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fakeRun = (agent_id, kind, ticket_key = null, extra = {}) => store.createRun({ agent_id, kind, ticket_key, token: `tok-${Math.random()}`, model: 'x', ...extra });
const job = (over = {}) => ({ program: 'product-discovery', seat: 'pm', maxProposals: 3, proposals: 0, web: true, connectors: [], sources: ['arxiv.org'], focus: '', review: { minReviewers: 1, reviewers: ['trading-advisor', 'quant-research', 'principal-be'] }, ...over });
const BODY = '## Problem\nSlow reads\n## Evidence\nSee https://arxiv.org/abs/1234.5678 and https://example.com/x.\n## Proposal\nv1\n## Acceptance criteria\n- a\n## Success metric\nm';
async function propose(j = job(), title = 'Faster flow read') {
  const run = fakeRun('pm', 'research', null, { program: j.program, job: j });
  const out = await sched.deskAction(run, 'propose', { title, body: BODY, area: 'frontend', priority: 'P1' });
  return store.getTicket(out.match(/R-\d+/)[0]);
}
const report = (verdict, extra = {}) => ({ verdict, summary: `${verdict} summary`, evidence_checked: ['arxiv → ok'], findings: verdict === 'pass' ? [] : ['vague metric'], conditions: verdict === 'changes' ? ['measurable metric'] : [], ...extra });

test('a research proposal is gated, cites its sources, and the next reviewer is never the author and prefers another model family', async () => {
  const t = await propose();
  assert.ok(rr.gated(t) && rr.blocks(t) && !rr.held(t));
  assert.deepEqual(JSON.parse(t.research_sources), ['https://arxiv.org/abs/1234.5678', 'https://example.com/x']);
  assert.equal(rr.needed(t), 1);
  assert.equal(rr.policyOf(t).minReviewers, 1);
  team.agentById['trading-advisor'].engine = 'codex';
  try { assert.equal(rr.nextReviewer(t), 'trading-advisor', 'a different family goes first'); } finally { team.agentById['trading-advisor'].engine = 'claude'; }
  assert.equal(rr.nextReviewer(t), 'trading-advisor', 'configured order otherwise');
  assert.equal(rr.nextReviewer({ ...t, reporter: 'trading-advisor' }), 'quant-research', 'the author is skipped');
  const [a] = rr.nextAssignments().filter((x) => x.t.key === t.key); assert.equal(a.reviewer, 'trading-advisor');
  assert.match(sched.health().waiting.find((w) => w.key === t.key).reason, /Awaiting 1 independent review/);
  assert.equal(sched.health().waiting.find((w) => w.key === t.key).code, 'research_review');
});

test('pass with quorum one unblocks grooming; a stale verdict (edited proposal) never counts', async () => {
  const t = await propose(job(), 'Pass me');
  const a = rr.assign(t, 'trading-advisor');
  assert.ok(rr.inFlight(store.getTicket(t.key)));
  assert.deepEqual(rr.nextAssignments().filter((x) => x.t.key === t.key), [], 'one reviewer at a time');
  // The proposal text changes under the reviewer: its verdict is recorded for history but does not pass the gate.
  store.updateTicket(t.key, { description: `${BODY}\nedited` });
  rr.complete(a.id, { report: report('pass'), run_id: 1 });
  assert.equal(store.getTicket(t.key).research_review, 'pending'); assert.equal(store.getResearchReview(a.id).status, 'complete');
  const b = rr.assign(store.getTicket(t.key), 'trading-advisor');
  rr.complete(b.id, { report: report('pass'), run_id: 2 });
  const done = store.getTicket(t.key);
  assert.equal(done.research_review, 'passed'); assert.equal(rr.blocks(done), false);
  assert.ok(store.listComments(t.key).some((c) => /Research review · pass/.test(c.body)));
  const em = fakeRun('manager', 'groom', t.key);
  await sched.deskAction(em, 'groom', { key: t.key, complexity: 'M', area: 'frontend', body: 'spec' });
  assert.equal(store.getTicket(t.key).status, 'todo');
});

test('quorum two needs two distinct seats; a duplicate pass from the same seat is not assignable', async () => {
  const t = await propose(job({ review: { minReviewers: 2, reviewers: ['trading-advisor', 'quant-research'] } }), 'Two reviewers');
  const a = rr.assign(t, 'trading-advisor'); rr.complete(a.id, { report: report('pass'), run_id: 3 });
  const after1 = store.getTicket(t.key);
  assert.equal(after1.research_review, 'pending'); assert.equal(rr.needed(after1), 1);
  assert.equal(rr.nextReviewer(after1), 'quant-research', 'the seat that already reviewed is excluded');
  const b = rr.assign(after1, 'quant-research'); rr.complete(b.id, { report: report('pass'), run_id: 4 });
  assert.equal(store.getTicket(t.key).research_review, 'passed');
});

test('changes → one revision by the author via desk revise → fresh generation; a second changes verdict holds it for the owner', async () => {
  const t = await propose(job(), 'Needs work');
  const a = rr.assign(t, 'trading-advisor'); rr.complete(a.id, { report: report('changes'), run_id: 5 });
  let now = store.getTicket(t.key);
  assert.equal(now.research_review, 'changes'); assert.equal(rr.nextRevisions().some((x) => x.key === t.key), true);
  assert.match(rr.revisionNotes(now), /vague metric/);
  // Only the author's revision run for this ticket may revise, and only while changes are requested.
  await assert.rejects(sched.deskAction(fakeRun('trading-advisor', 'research_revision', t.key), 'revise', { key: t.key, body: BODY }), /your own revision run/);
  await assert.rejects(sched.deskAction(fakeRun('pm', 'research', null, { job: job() }), 'revise', { key: t.key, body: BODY }), /research runs read and file proposals/);
  const rev = fakeRun('pm', 'research_revision', t.key);
  await assert.rejects(sched.deskAction(rev, 'propose', { title: 'x', body: 'y' }), /only revise its own proposal/);
  await assert.rejects(sched.deskAction(rev, 'revise', { key: t.key, body: 'no sections' }), /keep the proposal sections/);
  await sched.deskAction(rev, 'revise', { key: t.key, title: 'Needs work (revised)', body: `${BODY}\nBetter metric: p95 latency.` });
  now = store.getTicket(t.key);
  assert.deepEqual([now.research_review, now.research_generation, now.research_revisions, now.title], ['pending', 2, 1, 'Needs work (revised)']);
  // The old generation's verdict is history: the gate still needs a pass for generation 2.
  assert.equal(rr.needed(now), 1);
  const b = rr.assign(now, 'quant-research'); rr.complete(b.id, { report: report('changes'), run_id: 6 });
  now = store.getTicket(t.key);
  assert.deepEqual([now.research_review, now.status, now.resume_status], ['held', 'needs_human', 'proposed']);
  assert.ok(rr.held(now));
  // Owner decision: approve = audited waiver back to proposed, groomable.
  const approved = rr.ownerDecide(now, 'approve', 'fine as is');
  assert.deepEqual([approved.research_review, approved.status], ['waived', 'proposed']);
  assert.ok(store.listResearchReviews(t.key).some((r) => r.reviewer === 'owner' && r.verdict === 'pass'));
  assert.equal(rr.blocks(approved), false);
});

test('reject holds for the owner; owner correction sends it back with notes, owner reject closes it; a reply to a held proposal is a correction', async () => {
  const t = await propose(job(), 'Rejectable');
  const a = rr.assign(t, 'trading-advisor'); rr.complete(a.id, { report: report('reject'), run_id: 7 });
  let now = store.getTicket(t.key);
  assert.deepEqual([now.research_review, now.status], ['held', 'needs_human']);
  assert.throws(() => rr.ownerDecide(now, 'correction', ''), /Describe the correction/);
  await sched.ownerDecision(t.key, { decision: 'correction', message: 'Add usage data from the dashboard' });
  now = store.getTicket(t.key);
  assert.deepEqual([now.research_review, now.status, now.research_revisions], ['changes', 'proposed', 0]);
  assert.equal(rr.revisionNotes(now), 'Add usage data from the dashboard', 'owner notes drive the revision');
  // Hold it again and reject via the owner decision path.
  store.updateTicket(t.key, { research_review: 'held', status: 'needs_human', resume_status: 'proposed' });
  await sched.ownerDecision(t.key, { decision: 'reject', message: 'not now' });
  assert.equal(store.getTicket(t.key).status, 'wontdo');
  const t2 = await propose(job(), 'Reply path');
  const b = rr.assign(t2, 'trading-advisor'); rr.complete(b.id, { report: report('reject'), run_id: 8 });
  sched.ownerReply(t2.key, 'Please cite the broker API docs');
  const after = store.getTicket(t2.key);
  assert.deepEqual([after.research_review, after.status], ['changes', 'proposed']);
});

test('the gate holds in every path: owner patch, manager groom, legacy proposals are exempt, waive is audited', async () => {
  const t = await propose(job(), 'Patched');
  assert.throws(() => sched.ownerPatch(t.key, { status: 'todo' }), /waiting on its second review/);
  const legacy = store.createTicket({ title: 'old pm proposal', status: 'proposed', source: 'pm', reporter: 'pm' });
  assert.equal(rr.blocks(legacy), false);
  const waived = rr.waive(t.key, 'owner read it');
  assert.equal(waived.research_review, 'waived');
  assert.throws(() => rr.waive(t.key), /not waiting on a research review/);
  sched.ownerPatch(t.key, { status: 'todo' }); assert.equal(store.getTicket(t.key).status, 'todo');
});

test('proposal allowance: per-run and global caps are enforced server-side; research allowance nets out running jobs', async () => {
  store.setSetting('max_open_proposals', '50');
  for (const r of store.unfinishedRuns()) store.updateRun(r.id, { status: 'success', ended_at: store.now() }); // earlier fixture runs held allowances
  const open = store.ticketsByStatus('proposed').length;
  const run = fakeRun('pm', 'research', null, { program: 'product-discovery', job: job({ maxProposals: 2 }) });
  assert.equal(sched.researchAllowance(), 50 - open - 2, 'running job holds its allowance');
  await sched.deskAction(run, 'propose', { title: 'a1', body: BODY }); await sched.deskAction(run, 'propose', { title: 'a2', body: BODY });
  await assert.rejects(sched.deskAction(run, 'propose', { title: 'a3', body: BODY }), /allowance/);
  store.updateRun(run.id, { status: 'success', ended_at: store.now() });
  assert.equal(sched.researchAllowance(), 50 - open - 2, 'two filed, allowance released');
  try {
    store.setSetting('max_open_proposals', String(store.ticketsByStatus('proposed').length));
    const run2 = fakeRun('pm', 'research', null, { program: 'product-discovery', job: job({ maxProposals: 2 }) });
    await assert.rejects(sched.deskAction(run2, 'propose', { title: 'a4', body: BODY }), /enough proposals are waiting/);
  } finally { store.setSetting('max_open_proposals', '50'); }
});

test('reviewer and assessor runs are read-only in permissions, sandbox and desk actions; reports are validated', async () => {
  const runner = await import('../src/runner.js');
  const p = team.permissionsFor('research_review', '/w', { web: true });
  assert.ok(p.tools.includes('WebFetch') && !p.allow.includes('Bash(*)') && p.allow.includes('Bash(desk *)'));
  assert.ok(!team.permissionsFor('connector_assessment', '/w').tools.includes('WebFetch'));
  const sb = runner.sandboxSettings('/w', [], 'research_review');
  assert.deepEqual(sb.sandbox.filesystem.allowWrite, []); assert.equal(sb.sandbox.autoAllowBashIfSandboxed, false); assert.ok(sb.sandbox.filesystem.denyWrite.includes('/w'));
  const rev = fakeRun('quant-research', 'research_review', null);
  await assert.rejects(sched.deskAction(rev, 'comment', { body: 'x' }), /reviewers are read-only/);
  await assert.rejects(sched.deskAction(fakeRun('principal-be', 'connector_assessment'), 'propose', { title: 'x', body: 'y' }), /reviewers are read-only/);
  assert.throws(() => rr.parseReport('{"verdict":"pass","summary":"s","evidence_checked":[],"findings":[],"conditions":["c"]}'), /a pass has no conditions/);
  assert.equal(rr.parseReport('```json\n{"verdict":"changes","summary":"s","evidence_checked":[],"findings":["f"],"conditions":["c"]}\n```').verdict, 'changes');
  // Research runs carry web and connector capabilities into the Claude command; reviewers get none of the connectors.
  const connectors = await import('../src/connectors.js');
  const job2 = job({ connectors: [{ name: 'paper-search', binding: { type: 'stdio', command: process.execPath, args: ['-e', '0'] }, tools: ['search_arxiv'] }] });
  const args = runner.buildArgs(team.agentById.pm, 'research', '/w', { job: job2 });
  const mcp = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers['paper-search'].command, '/usr/bin/env'); assert.ok(mcp.mcpServers['paper-search'].args.includes('DESK_RUN_TOKEN'));
  assert.ok(args.includes('mcp__paper-search__search_arxiv') && args.includes('WebSearch'));
  const noWeb = runner.buildArgs(team.agentById.pm, 'research', '/w', { job: job({ web: false }) });
  assert.ok(!noWeb.includes('WebSearch') && JSON.parse(noWeb[noWeb.indexOf('--mcp-config') + 1]).mcpServers && !Object.keys(JSON.parse(noWeb[noWeb.indexOf('--mcp-config') + 1]).mcpServers).length);
  const prompt = args[args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /Research program: product-discovery/); assert.match(prompt, /paper-search \(search_arxiv\)/); assert.match(prompt, /desk connector-propose/);
  assert.ok(connectors.allowRulesFor(job2.connectors).length === 1);
  // Provider selection honours job requirements: connectors need Claude; web cannot fall back to Codex.
  assert.equal(dispatch.meetsRequirements('codex', { web: true, connectors: [] }), false);
  assert.equal(dispatch.meetsRequirements('perplexity', { web: true, connectors: ['x'] }), false);
  assert.equal(dispatch.meetsRequirements('perplexity', { web: true, connectors: [] }), true);
  team.agentById.pm.engine = 'codex';
  try { assert.match(dispatch.selectionFor('pm', Date.now(), { web: true, connectors: [] }).reason, /Web research needs a Claude or Perplexity seat/); } finally { team.agentById.pm.engine = 'claude'; }
});

test('connector proposals from thinking runs are cases only; restart recovery cancels in-flight reviews', async () => {
  const run = fakeRun('pm', 'research', null, { program: 'product-discovery', job: job() });
  const CASE = '## Purpose\nx\n## Benefit to the application\nx\n## How it is used\nx\n## SDLC stage improved\ndiscovery\n## Cost\nx\n## Time\nx\n## Data leaving the machine\nx\n## Risks and fallback\nx\n## Success measure\nx';
  const out = await sched.deskAction(run, 'connector-propose', { name: 'sec-filings', body: CASE });
  assert.match(out, /owner must assess and approve/);
  await assert.rejects(sched.deskAction(fakeRun('junior', 'implement', null), 'connector-propose', { name: 'x', body: CASE }), /cannot run "connector-propose"/);
  const t = await propose(job(), 'Recover me');
  const a = rr.assign(t, 'trading-advisor'); store.updateResearchReview(a.id, { status: 'running', run_id: 99 });
  rr.recover();
  assert.equal(store.getResearchReview(a.id).status, 'cancelled'); assert.equal(store.getTicket(t.key).research_review, 'pending');
  assert.equal(rr.nextAssignments().some((x) => x.t.key === t.key), true, 'a fresh assignment follows');
  assert.ok(rr.summaries().some((s) => s.ticket_key === t.key && s.state === 'pending' && s.needed === 1));
});
