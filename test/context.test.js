import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The owner's repository (trusted) and a seat's clone (untrusted: its config, refs and files are agent-writable).
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-ctx-')));
const owner = path.join(tmp, 'owner');
const clone = path.join(tmp, 'clone');
const data = path.join(tmp, 'data');
const outside = path.join(tmp, 'outside');
const MARKER = path.join(tmp, 'PWNED');
fs.mkdirSync(owner);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-THE-CLONE-DO-NOT-SEND\n');
const evil = path.join(tmp, 'evil.sh');
fs.writeFileSync(evil, `#!/bin/sh\ntouch ${MARKER}\nexit 1\n`, { mode: 0o755 });
const SECRET = 'sk-ant-TESTSECRETVALUE0123456789';
const gitIn = (dir) => (...args) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const go = gitIn(owner);
const writeIn = (dir) => (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
const w = writeIn(owner);

execFileSync('git', ['init', '-q', '-b', 'main', owner]);
w('README.md', '# Demo\nA tiny trading helper.\n');
w('src/engine.js', `${Array.from({ length: 30 }, (_, i) => `// filler ${i}`).join('\n')}\nexport function computeEdge(iv, rv) {\n  return iv - rv;\n}\nexport const RATE_LIMIT = 200;\n`);
w('src/caller.js', "import { computeEdge } from './engine.js';\nexport const edge = computeEdge(0.3, 0.2);\n");
w('test/engine.test.js', "import { computeEdge } from '../src/engine.js';\n// computeEdge(1, 0) === 1\n");
w('old_name.js', 'export const legacy = 1;\n');
w('remove_me.js', 'export const doomed = true;\n');
w('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
w('.env.local', `ANTHROPIC_API_KEY=${SECRET}\n`);
w('.env.prod', `DB_URL=postgres://app:prodpass@db/x\n`);
w('src/big.js', `${Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
w('src/giant.js', `${Array.from({ length: 1500 }, (_, i) => `export const g${i} = ${i};`).join('\n')}\n`);
w('config/app.json', '{"name":"demo"}\n');
fs.symlinkSync('../outside/secret.txt', path.join(owner, 'link.js'));
go('add', '-A');
go('commit', '-qm', 'init');
// The owner's tip carries a (fake) signature: a git that verified signatures would run gpg.program on it.
const raw = go('cat-file', 'commit', 'HEAD').replace(/^(committer .*)$/m, '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----');
const mainSha = execFileSync('git', ['-C', owner, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: `${raw}\n`, encoding: 'utf8' }).trim();
go('update-ref', 'refs/heads/main', mainSha);
go('reset', '-q', '--hard', mainSha);

execFileSync('git', ['clone', '-q', owner, clone]);
const gc = gitIn(clone);
const wc = writeIn(clone);
gc('checkout', '-qb', 'feature');
wc('src/engine.js', fs.readFileSync(path.join(clone, 'src/engine.js'), 'utf8').replace('return iv - rv;', 'if (rv <= 0) return 0;\n  return iv - rv;'));
gc('mv', 'old_name.js', 'new_name.js');
gc('mv', '.env.prod', 'public.js');
gc('rm', '-q', 'remove_me.js');
wc('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 9, 9]));
wc('.env.local', `ANTHROPIC_API_KEY=${SECRET}\nOTHER=1\n`);
wc('config/app.json', '{"name":"demo","password":"fixture-password","db":{"api_key": "fixture-api-key"}}\n');
gc('add', '-A');
gc('commit', '-qm', 'feature: guard computeEdge');
const featureSha = gc('rev-parse', 'HEAD');
gc('checkout', '-q', '-b', 'huge', mainSha);
wc('src/big.js', `${Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i % 10 === 0 ? i * 1000 : i};`).join('\n')}\n`);
wc('src/engine.js', fs.readFileSync(path.join(clone, 'src/engine.js'), 'utf8').replace('return iv - rv;', 'return iv - rv; // edge'));
gc('commit', '-qam', 'rewrite big');
const hugeSha = gc('rev-parse', 'HEAD');
gc('checkout', '-q', '-b', 'giant', mainSha);
wc('src/giant.js', `${Array.from({ length: 1500 }, (_, i) => `export const g${i} = ${i * 7};`).join('\n')}\n`);
gc('commit', '-qam', 'rewrite giant');
const giantSha = gc('rev-parse', 'HEAD');
// The seat poisons its clone: config that would run programs, and a moved base ref.
for (const [k, v] of [['gpg.program', evil], ['log.showSignature', 'true'], ['core.fsmonitor', evil], ['core.pager', evil], ['diff.external', evil], ['core.hooksPath', tmp]]) gc('config', k, v);
fs.writeFileSync(path.join(tmp, 'post-checkout'), `#!/bin/sh\ntouch ${MARKER}\n`, { mode: 0o755 });
gc('update-ref', 'refs/remotes/origin/main', featureSha);
gc('update-ref', 'refs/heads/main', featureSha);
fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
fs.symlinkSync(outside, path.join(clone, '.git', 'sigmadesk'));

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ project: { name: 'demo', repoPath: owner, githubRepo: '', ticketPrefix: 'C' }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = path.join(tmp, 'config.json');
process.env.SIGMADESK_DB = ':memory:';
process.env.SIGMADESK_DATA = data;

let ctx; let store; let sched; let pplx; let runner; let config;
before(async () => {
  ({ config } = await import('../src/config.js'));
  store = await import('../src/db.js');
  ctx = await import('../src/context.js');
  runner = await import('../src/runner.js');
  sched = await import('../src/scheduler.js');
  pplx = await import('../src/engines/perplexity.js');
  store.openDb(':memory:');
});

const DESCRIPTION = `Guard \`computeEdge\` in src/engine.js:31 against zero realized vol.
Also look at link.js, ../outside/secret.txt, .env.local and public.js.

## Acceptance criteria
- computeEdge returns 0 when rv <= 0
- existing callers keep working

## Notes
nothing else`;
const ticketFor = ({ head_sha, ...extra } = {}) => {
  const t = store.createTicket({ title: 'Guard computeEdge', description: DESCRIPTION, reporter: 'pm', status: 'proposed', ...extra });
  return head_sha ? store.updateTicket(t.key, { head_sha }) : t;
};
const small = (packChars) => ({ ...ctx.packSettings(), packChars, pageChars: packChars - 1500 });
async function packFor(kind, ticket, { settings, incidentId = null, secrets = [], nonce = null } = {}) {
  const run = store.createRun({ agent_id: 'pm', kind, ticket_key: ticket?.key ?? null, token: `tok-${Math.random()}`, nonce, model: 'perplexity:pplx_asi_kimi_k3', cwd: clone, incident_id: incidentId });
  const pack = await ctx.prepareRun({ runId: run.id, kind, cwd: clone, ticketKey: ticket?.key ?? null, incidentId, secrets, settings });
  return { run, pack, live: ctx.liveFor(run.id) };
}
const assertNoLeaks = (text) => {
  for (const s of [SECRET, 'OUTSIDE-THE-CLONE', 'fixture-password', 'fixture-api-key', 'prodpass']) assert.ok(!text.includes(s), `leaked ${s}`);
};
let uid = 0;
const id = () => `tu${++uid}`;
// One relay call: tool_use then its tool_result.
function call(live, input, { text = '{"thread_id":"thread-A-0001","status":"running"}', isError = false } = {}) {
  const t = id();
  const sent = ctx.recordSend(live, t, 'call', input);
  return [...sent, ...ctx.recordResult(live, t, { isError, text })];
}
function read(live, thread, text) {
  const t = id();
  ctx.recordSend(live, t, 'read', { thread_id: thread });
  return ctx.recordResult(live, t, { text });
}

test('groom pack: base frozen from the owner, ticket, acceptance, excerpts, search references; escapes rejected', async () => {
  const t = ticketFor();
  store.addComment(t.key, 'manager', '🗣 **Asked Ada (Principal):** is src/caller.js affected?');
  const { pack } = await packFor('groom', t);
  const x = pack.text;
  assert.match(x, /^<sigmadesk-context kind="groom" sha256="[0-9a-f]{64}">/);
  assert.match(x, new RegExp(`base branch: main @ ${mainSha} \\(frozen from the owner's repository\\)`));
  assert.match(x, /#### Acceptance criteria\n## Acceptance criteria\n- computeEdge returns 0 when rv <= 0/);
  assert.match(x, /Decision history[\s\S]*Asked Ada/);
  assert.match(x, /### src\/engine\.js:1-\d+ \(of \d+ lines\)/);
  assert.match(x, /src\/caller\.js:1: import \{ computeEdge \}/);
  assert.match(x, /tests that mention it: test\/engine\.test\.js/);
  assert.match(x, /link\.js — rejected: symlink \(not followed\)/);
  assert.match(x, /\.\.\/outside\/secret\.txt — rejected: path traversal/);
  assert.match(x, /\.env\.local — rejected: secret path/);
  assert.ok(x.length <= ctx.packSettings().packChars);
  assertNoLeaks(x);
  assert.equal((await packFor('groom', t)).pack.hash, pack.hash, 'deterministic');
});

test('review pack: frozen head, rename/delete/binary, JSON credentials scrubbed, secret rename withheld; stored in desk storage', async () => {
  const t = ticketFor({ status: 'review', head_sha: featureSha });
  const { pack } = await packFor('review', t);
  const x = pack.text;
  assert.match(x, new RegExp(`head: ${featureSha}`));
  assert.match(x, /R old_name\.js -> new_name\.js/);
  assert.match(x, /R \.env\.prod -> public\.js .*\[secret path: content withheld\]/);
  assert.match(x, /D remove_me\.js/);
  assert.match(x, /M img\.png {2}\(binary\)/);
  assert.match(x, /\+ {2}if \(rv <= 0\) return 0;/);
  assert.match(x, /deleted file mode[\s\S]*-export const doomed = true;/);
  assert.match(x, /Binary files a\/img\.png and b\/img\.png differ/);
  assert.match(x, /"password":"\[redacted\]"/);
  assert.match(x, /"api_key": "\[redacted\]"/);
  assert.ok(!x.includes('diff --git a/.env.local') && !x.includes('diff --git a/.env.prod'), 'secret diffs never included');
  assert.match(x, /public\.js — rejected: withheld: renamed from or to a secret path/);
  assert.deepEqual(pack.meta.omittedChanged, []);
  assertNoLeaks(x);
  // Desk-owned storage, private; nothing written through the clone's planted .git/sigmadesk symlink.
  assert.ok(pack.meta.file.startsWith(fs.realpathSync(path.join(data, 'context'))));
  assert.equal(fs.statSync(pack.meta.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
});

test('a moved origin/main in the clone changes nothing; an unresolvable base fails closed', async () => {
  assert.equal(gc('rev-parse', 'refs/remotes/origin/main'), featureSha, 'the clone lies about its base');
  const t = ticketFor({ status: 'review', head_sha: featureSha });
  const { pack } = await packFor('review', t);
  assert.equal(pack.meta.baseSha, mainSha);
  assert.ok(pack.meta.changed.includes('src/engine.js'), 'the review is not empty');
  const base = config.project.baseBranch;
  config.project.baseBranch = 'no-such-branch';
  try { await assert.rejects(packFor('groom', t), /cannot resolve the base branch/); } finally { config.project.baseBranch = base; }
  await assert.rejects(packFor('review', ticketFor({ status: 'review' })), /no desk-recorded head commit/);
  await assert.rejects(packFor('review', ticketFor({ status: 'review', head_sha: 'f'.repeat(40) })), /git fetch failed|does not match/);
});

test('malicious git config in the clone (gpg.program, showSignature, fsmonitor, pager, hooks) never runs', async () => {
  // Control: a git that honours that config on the signed owner commit really does run the program.
  try { execFileSync('git', ['-C', owner, '-c', `gpg.program=${evil}`, 'log', '--show-signature', '-1'], { stdio: 'ignore' }); } catch { /* gpg "fails" */ }
  assert.ok(fs.existsSync(MARKER), 'control: signature verification runs gpg.program');
  fs.rmSync(MARKER);
  const prev = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = `'log.showsignature'='true' 'gpg.program'='${evil}'`;
  try {
    const t = ticketFor({ status: 'review', head_sha: featureSha });
    const { run } = await packFor('review', t);
    await ctx.serveFile(run.id, 'src/engine.js');
    await packFor('research', null);
    await packFor('groom', t);
  } finally { if (prev === undefined) delete process.env.GIT_CONFIG_PARAMETERS; else process.env.GIT_CONFIG_PARAMETERS = prev; }
  assert.ok(!fs.existsSync(MARKER), 'no program from untrusted config ran');
});

test('pack storage refuses a symlinked context directory', async () => {
  const dir = path.join(data, 'context');
  const keep = `${dir}.bak`;
  fs.renameSync(dir, keep);
  fs.symlinkSync(outside, dir);
  try {
    await assert.rejects(packFor('groom', ticketFor()), /not a plain directory/);
    assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
  } finally { fs.unlinkSync(dir); fs.renameSync(keep, dir); }
});

test('scrub: quoted JSON/YAML credentials, PEM blocks, bearer tokens, URL credentials, known formats; idempotent', () => {
  const samples = [
    ['{"password":"fixture-password"}', 'fixture-password'],
    ["db:\n  password: 'hunter2'\n", 'hunter2'],
    ['client_secret = "abc123xyz"', 'abc123xyz'],
    ['PRIVATE_KEY=abcd1234efgh', 'abcd1234efgh'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'MIIEpAIBAAKCAQEA'],
    ['+-----BEGIN OPENSSH PRIVATE KEY-----\n+b3BlbnNzaC1rZXk', 'b3BlbnNzaC1rZXk'],
    ['Authorization: Bearer abcdefghijklmnop.qrstu', 'abcdefghijklmnop'],
    ['postgres://app:prodpass@db/x', 'prodpass'],
    ['key AIzaSyA1234567890abcdefghijklmnopqrstuv', 'AIzaSyA1234567890'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N', 'eyJhbGciOiJIUzI1NiJ9'],
  ];
  for (const [input, secret] of samples) {
    const out = ctx.scrub(input);
    assert.ok(!out.includes(secret), `${input} → ${out}`);
    assert.equal(ctx.scrub(out), out, `idempotent: ${out}`);
    assert.ok(ctx.hasSecret(input));
  }
  assert.ok(!ctx.hasSecret('export function computeEdge(iv, rv) { return iv - rv; }'));
});

test('context-file: secret renames and secret paths are withheld; extras capped; pack omissions always servable', async () => {
  const t = ticketFor({ status: 'review', head_sha: featureSha });
  const { run } = await packFor('review', t);
  await assert.rejects(ctx.serveFile(run.id, 'public.js'), /withheld: renamed from or to a secret path/);
  await assert.rejects(ctx.serveFile(run.id, '.env.prod'), /secret path/);
  await assert.rejects(ctx.serveFile(run.id, '.env.local'), /secret path/);
  await assert.rejects(ctx.serveFile(run.id, '../outside/secret.txt'), /traversal/);
  await assert.rejects(ctx.serveFile(run.id, 'link.js'), /symlink/);
  const diff = await ctx.serveFile(run.id, 'config/app.json');
  assert.match(diff, /<sigmadesk-file path="config\/app\.json" page="1" pages="1"/);
  assertNoLeaks(diff);
  const deleted = await ctx.serveFile(run.id, 'remove_me.js');
  assert.match(deleted, /-export const doomed = true;/);
  const extras = { ...ctx.packSettings(), maxServedFiles: 2 };
  await assert.rejects(ctx.serveFile(run.id, 'src/caller.js', 1, extras), /at most 2 extra files/);
});

test('delivery counts only on a successful, correlated result; pages count only on the pack thread; acceptance needs a finished answer', async () => {
  const t = ticketFor({ status: 'review', head_sha: hugeSha });
  const { run, pack, live } = await packFor('review', t, { settings: small(12000), secrets: ['nonce12345'], nonce: 'nonce12345' });
  assert.deepEqual(pack.meta.omittedChanged, ['src/big.js']);
  assert.ok(pack.text.length <= 12000);
  // SD-14: a head of the pack is not the pack.
  let ev = call(live, { message: `Review this.\n${pack.text.slice(0, 2000)}` });
  assert.ok(ev.some((e) => /did not receive the full context/.test(e.note)));
  // A failed MCP call carrying the full pack delivers nothing.
  ev = call(live, { message: `Review.\n${pack.text}` }, { isError: true, text: 'MCP error -32001: Request timed out' });
  assert.ok(ev.some((e) => /NOT delivered/.test(e.note)));
  assert.equal(live.meta.delivered, false);
  ev = call(live, { message: `You are the PM.\n\n${pack.text.replace(/\n/g, '  \r\n')}` }, { text: '{"thread_id":"thread-A-0001","status":"running"}' });
  assert.ok(ev.some((e) => /delivered to Perplexity verbatim/.test(e.note)));
  assert.equal(live.meta.packThread, 'thread-A-0001');
  assert.match(ctx.acceptBlockers(live.meta), /never fully sent.*src\/big\.js/);

  const r = { ...store.getRun(run.id) };
  await assert.rejects(sched.deskAction(r, 'accept', { verdict: 'pass', code: 'nonce12345', body: 'lgtm' }), /never fully sent/);
  assert.equal(store.getTicket(t.key).status, 'review');

  const block = await sched.deskAction(r, 'context-file', { path: 'src/big.js' });
  call(live, { message: block, thread_id: 'thread-B-0002' }, { text: '{"thread_id":"thread-B-0002"}' });
  assert.ok(!live.meta.fetched.includes('src/big.js'), 'another thread does not count');
  call(live, { message: `Here:\n${block}`, thread_id: 'thread-A-0001' }, { isError: true, text: 'boom' });
  assert.ok(!live.meta.fetched.includes('src/big.js'), 'a failed follow-up does not count');
  call(live, { message: `Here:\n${block}`, thread_id: 'thread-A-0001' });
  assert.deepEqual(live.meta.fetched, ['src/big.js']);
  assert.match(ctx.acceptBlockers(live.meta), /No completed Perplexity answer/);
  read(live, 'thread-B-0002', '{"web_state":{"steps":[{"status":"WORKFLOW_COMPLETED"}]}}');
  assert.match(ctx.acceptBlockers(live.meta), /No completed Perplexity answer/, 'another thread finishing does not count');
  read(live, 'thread-A-0001', '{"thread_status":"running"}');
  assert.equal(live.meta.remote.status, 'pending');
  read(live, 'thread-A-0001', '{"web_state":{"steps":[{"status":"WORKFLOW_COMPLETED"}]}}');
  assert.equal(ctx.acceptBlockers(live.meta), null);
  assert.equal(live.meta.remote.status, 'completed');
  ctx.release(run.id);
});

test('violations fail closed: token/nonce, secrets or an oversized message kill the run and invalidate it', async () => {
  const t = ticketFor();
  const { run, pack, live } = await packFor('groom', t, { secrets: ['nonce99999'] });
  let ev = ctx.recordSend(live, id(), 'call', { message: `${pack.text}\n--code nonce99999` });
  assert.ok(ev.some((e) => e.kill && /token or verdict code/.test(e.kill)));
  ev = ctx.recordSend(live, id(), 'call', { message: `${pack.text}\n## Relay additions\npassword: "hunter2hunter"` });
  assert.ok(ev.some((e) => e.kill && /secret-looking/.test(e.kill)));
  ev = ctx.recordSend(live, id(), 'call', { message: `${pack.text}\n${'x'.repeat(70000)}` });
  assert.ok(ev.some((e) => e.kill && /over the 60000-char cap/.test(e.kill)));
  assert.equal(ctx.recordSend(live, id(), 'call', { message: `Groom this.\n${pack.text}` }).filter((e) => e.kill).length, 0, 'the pack itself is clean');
  assert.match(ctx.acceptBlockers(live.meta), /invalid/);
  // The runner acts on the kill event at once.
  store.updateRun(run.id, { status: 'running' });
  runner.applyEvents(ev, { run, cwd: clone, state: { pack: live }, presence: false });
  assert.equal(store.getRun(run.id).status, 'killed');
  assert.match(store.getRun(run.id).result_text, /invalid Perplexity message/);
  ctx.release(run.id);
});

test('giant single hunk: paginated, every page within the cap, full coverage only after every page is sent', async () => {
  const t = ticketFor({ status: 'review', head_sha: giantSha });
  const settings = small(12000);
  const { pack, live, run } = await packFor('review', t, { settings });
  assert.deepEqual(pack.meta.omittedChanged, ['src/giant.js'], 'one hunk too big for the pack is omitted, not cut');
  assert.ok(!pack.text.includes('export const g1499 = 10493;'));
  call(live, { message: pack.text });
  const first = await ctx.serveFile(run.id, 'src/giant.js', 1, settings);
  const pages = Number(first.match(/pages="(\d+)"/)[1]);
  assert.ok(pages >= 3, `${pages} pages`);
  const blocks = [first];
  for (let p = 2; p <= pages; p++) blocks.push(await ctx.serveFile(run.id, 'src/giant.js', p, settings));
  await assert.rejects(ctx.serveFile(run.id, 'src/giant.js', pages + 1, settings), /has \d+ page/);
  for (const b of blocks) assert.ok(b.length <= settings.pageChars + 400, `page ${b.length} chars`);
  const all = blocks.join('\n');
  for (const n of [1, 700, 1499]) assert.ok(all.includes(`+export const g${n} = ${n * 7};`), `line ${n} present`);
  assert.match(first, /\[hunk part 1 of \d+\]/);
  for (const b of blocks.slice(0, -1)) call(live, { message: b, thread_id: 'thread-A-0001' });
  assert.ok(!live.meta.fetched.includes('src/giant.js'), 'not complete until the last page');
  call(live, { message: blocks.at(-1), thread_id: 'thread-A-0001' });
  assert.deepEqual(live.meta.fetched, ['src/giant.js']);
  ctx.release(run.id);
});

test('budget: required content that cannot fit refuses the pack; the deadline and cancellation stop preparation', async () => {
  await assert.rejects(packFor('review', ticketFor({ status: 'review', head_sha: featureSha }), { settings: small(4000) }), /required context .* needs \d+ chars/);
  await assert.rejects(packFor('groom', ticketFor(), { settings: { ...ctx.packSettings(), deadlineSeconds: 0.001 } }), /longer than|cancelled/);
  const run = store.createRun({ agent_id: 'pm', kind: 'groom', token: 'tok-abort', model: 'perplexity:x', cwd: clone });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(ctx.prepareRun({ runId: run.id, kind: 'groom', cwd: clone, signal: ac.signal }), /cancelled/);
});

test('retry identity: same job + task + seat contract + pack resumes; a different question or model does not', () => {
  const base = { provenance: 'p1', agentId: 'manager', kind: 'owner_discussion', ticketKey: 'C-1', prompt: 'Should we split the API? code abc123def456', packHash: 'h', secrets: ['abc123def456'] };
  const a = ctx.jobIdentity(base);
  assert.equal(ctx.jobIdentity({ ...base, prompt: 'Should we split the API? code 999888777666', secrets: ['999888777666'] }), a, 'a fresh verdict code is not a new task');
  assert.notEqual(ctx.jobIdentity({ ...base, prompt: 'Should we merge the API?' }), a);
  assert.notEqual(ctx.jobIdentity({ ...base, provenance: 'p2' }), a, 'model/effort/charter changes');
  assert.notEqual(ctx.jobIdentity({ ...base, packHash: 'h2' }), a);
  const r = store.createRun({ agent_id: 'manager', kind: 'owner_discussion', ticket_key: 'C-1', token: 'tok-retry', model: 'perplexity:x' });
  store.updateRun(r.id, { job_hash: a, thread_id: 'thread-1', status: 'killed', ended_at: store.now(), context_meta: JSON.stringify({ delivered: true, packThread: 'thread-1', remote: { status: 'pending' } }) });
  assert.equal(store.lastThreadRun({ job_hash: a }).id, r.id);
  assert.equal(store.lastThreadRun({ job_hash: ctx.jobIdentity({ ...base, prompt: 'other' }) }), null);
  assert.equal(ctx.metaFor(store.getRun(r.id)).remote.status, 'pending', 'remote state persists with the run');
});

test('ticketless research and incident packs', async () => {
  const { pack } = await packFor('research', null);
  assert.match(pack.text, /## Repository map \(\d+ tracked files\)\n[\s\S]*src\/ {2}\d+ files/);
  assert.match(pack.text, /## Recent commits\n[0-9a-f]+ \d{4}-\d{2}-\d{2} init/);
  assertNoLeaks(pack.text);
  const inc = store.recordIncident({ signature: 'sig-ctx', normalized: 'TypeError in computeEdge', source_index: 0, label: 'api', project: 'demo', line: `ERROR TypeError at src/engine.js:32 token=${SECRET}`, ts: store.now() });
  const i = await packFor('investigate', null, { incidentId: inc.id });
  assert.match(i.pack.text, /ERROR TypeError at src\/engine\.js:32 token=\[redacted\]/);
  assert.match(i.pack.text, /### src\/engine\.js:1-35/);
  assertNoLeaks(i.pack.text);
});

test('perplexity engine: owner discussions are thinking work; the parser correlates tool results', async () => {
  assert.ok(pplx.THINK_KINDS.includes('owner_discussion'));
  const { pack, live, run } = await packFor('groom', ticketFor());
  const state = { pack: live };
  const use = (tid, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: tid, name: 'mcp__perplexity-computer__call_perplexity_computer', input }] } });
  const res = (tid, text, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: tid, is_error: isError, content: [{ type: 'text', text }] }] } });
  let out = pplx.perplexity.parse(use('x1', { model: 'pplx_asi_glm_5_3', message: `Groom.\n${pack.text}` }), clone, state);
  assert.ok(out.some((e) => e.type === 'tool' && /Asked GLM 5\.3/.test(e.text)));
  assert.equal(live.meta.delivered, false, 'not before the result');
  out = pplx.perplexity.parse(res('x1', '{"thread_id":"7f1c2d3e-aaaa-bbbb-cccc-1234567890ab","status":"pending"}'), clone, state);
  assert.ok(out.some((e) => e.type === 'pplx' && e.threadId === '7f1c2d3e-aaaa-bbbb-cccc-1234567890ab'));
  assert.equal(live.meta.packThread, '7f1c2d3e-aaaa-bbbb-cccc-1234567890ab');
  const cmd = pplx.perplexity.command({ seat: { model: 'pplx_asi_kimi_k3', effort: 'high', id: 'manager' }, kind: 'owner_discussion', cwd: clone, perms: { tools: ['Read', 'Bash'], allow: [] }, denyRules: [], charter: 'C', settings: {} });
  const charter = cmd.args[cmd.args.indexOf('--append-system-prompt') + 1];
  assert.match(charter, /VERBATIM/);
  assert.match(charter, /WORKFLOW_COMPLETED/);
  assert.equal(cmd.env.MCP_TOOL_TIMEOUT, String(8 * 60_000));
  ctx.release(run.id);
});

test('runner: a pack that cannot be built refuses the run before spawning; a kill during preparation stops it', async () => {
  const dispatch = await import('../src/dispatch.js');
  const team = await import('../src/team.js');
  dispatch.setAvailability([{ id: 'perplexity', available: true }, { id: 'claude', available: true }, { id: 'codex', available: false }]);
  const seat = team.agentById.pm;
  const saved = { engine: seat.engine, model: seat.model };
  Object.assign(seat, { engine: 'perplexity', model: 'pplx_asi_kimi_k3' });
  try {
    const t = ticketFor({ status: 'review' }); // no head_sha: nothing trustworthy to review
    const out = await runner.startRun({ agentId: 'pm', kind: 'review', ticketKey: t.key, prompt: 'review it', cwd: clone, track: false, nonce: 'nonce-abcdef' });
    assert.equal(out.run.status, 'error');
    assert.match(out.run.result_text, /Run refused: the context pack could not be built — review has no desk-recorded head commit/);
    assert.equal(out.run.pid, null, 'nothing was spawned');
    const p = runner.startRun({ agentId: 'pm', kind: 'groom', ticketKey: ticketFor().key, prompt: 'groom it', cwd: clone, track: false });
    const running = store.recentRuns(1)[0];
    assert.ok(runner.killRun(running.id, 'owner stop'));
    const stopped = await p;
    assert.equal(stopped.run.status, 'killed');
    assert.equal(stopped.run.pid, null);
  } finally { Object.assign(seat, saved); }
});
