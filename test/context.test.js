import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A throwaway repo with the shapes a review has to survive: renames, deletes, binaries, secrets and an escaping symlink.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sigmadesk-ctx-')));
const repo = path.join(tmp, 'repo');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(repo);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-THE-CLONE-DO-NOT-SEND\n');
const SECRET = 'sk-ant-TESTSECRETVALUE0123456789';
const g = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };

execFileSync('git', ['init', '-q', '-b', 'main', repo]);
write('README.md', '# Demo\nA tiny trading helper.\n');
write('src/engine.js', `${Array.from({ length: 30 }, (_, i) => `// filler ${i}`).join('\n')}\nexport function computeEdge(iv, rv) {\n  return iv - rv;\n}\nexport const RATE_LIMIT = 200;\n`);
write('src/caller.js', "import { computeEdge } from './engine.js';\nexport const edge = computeEdge(0.3, 0.2);\n");
write('test/engine.test.js', "import { computeEdge } from '../src/engine.js';\n// computeEdge(1, 0) === 1\n");
write('old_name.js', 'export const legacy = 1;\n');
write('remove_me.js', 'export const doomed = true;\n');
write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
write('.env.local', `ANTHROPIC_API_KEY=${SECRET}\n`);
write('src/big.js', `${Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`);
fs.symlinkSync('../outside/secret.txt', path.join(repo, 'link.js'));
g('add', '-A');
g('commit', '-qm', 'init');
const mainSha = g('rev-parse', 'HEAD');

g('checkout', '-qb', 'feature');
write('src/engine.js', fs.readFileSync(path.join(repo, 'src/engine.js'), 'utf8').replace('return iv - rv;', 'if (rv <= 0) return 0;\n  return iv - rv;'));
g('mv', 'old_name.js', 'new_name.js');
g('rm', '-q', 'remove_me.js');
write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 9, 9, 9]));
write('.env.local', `ANTHROPIC_API_KEY=${SECRET}\nOTHER=1\n`);
g('add', '-A');
g('commit', '-qm', 'feature: guard computeEdge');
const featureSha = g('rev-parse', 'HEAD');
// A second branch whose diff is far over a small budget: every 10th line changes → many separate hunks.
g('checkout', '-qb', 'huge');
write('src/big.js', `${Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i % 10 === 0 ? i * 1000 : i};`).join('\n')}\n`);
g('commit', '-qam', 'rewrite big');
const hugeSha = g('rev-parse', 'HEAD');
g('checkout', '-q', 'main');

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ project: { name: 'demo', repoPath: repo, githubRepo: '', ticketPrefix: 'C' }, github: { sync: false } }));
process.env.SIGMADESK_CONFIG = path.join(tmp, 'config.json');
process.env.SIGMADESK_DB = ':memory:';

let ctx; let store; let sched; let pplx;
before(async () => {
  store = await import('../src/db.js');
  ctx = await import('../src/context.js');
  sched = await import('../src/scheduler.js');
  pplx = await import('../src/engines/perplexity.js');
  store.openDb(':memory:');
});

const DESCRIPTION = `Guard \`computeEdge\` in src/engine.js:31 against zero realized vol.
Also look at link.js, ../outside/secret.txt and .env.local.

## Acceptance criteria
- computeEdge returns 0 when rv <= 0
- existing callers keep working

## Notes
nothing else`;
const ticketFor = ({ head_sha, ...extra } = {}) => {
  const t = store.createTicket({ title: 'Guard computeEdge', description: DESCRIPTION, reporter: 'pm', status: 'proposed', ...extra });
  return head_sha ? store.updateTicket(t.key, { head_sha }) : t;
};
const assertNoLeaks = (text) => {
  assert.ok(!text.includes(SECRET), 'secret value never appears');
  assert.ok(!text.includes('OUTSIDE-THE-CLONE'), 'symlink target outside the clone never read');
};

test('groom pack: ticket, acceptance, rules, excerpts, search references; secrets and escapes rejected', () => {
  const t = ticketFor();
  store.addComment(t.key, 'manager', '🗣 **Asked Ada (Principal):** is src/caller.js affected?');
  const pack = ctx.buildPack({ kind: 'groom', cwd: repo, inputs: ctx.gatherInputs({ ticketKey: t.key }) });
  const x = pack.text;
  assert.match(x, /^<sigmadesk-context kind="groom" sha256="[0-9a-f]{64}">/);
  assert.match(x, new RegExp(`base branch: main @ ${mainSha}`));
  assert.match(x, /#### Acceptance criteria\n## Acceptance criteria\n- computeEdge returns 0 when rv <= 0/);
  assert.match(x, /## Project rules \(playbook\)/);
  assert.match(x, /## Protected paths/);
  assert.match(x, /Decision history[\s\S]*Asked Ada/);
  assert.match(x, /### src\/engine\.js:1-\d+ \(of \d+ lines\)/, 'excerpt around the named line');
  assert.match(x, /References found by search \(text matches, NOT proven callers or coverage\)/);
  assert.match(x, /src\/caller\.js:1: import \{ computeEdge \}/);
  assert.match(x, /tests that mention it: test\/engine\.test\.js/);
  assert.match(x, /link\.js: rejected: symlink \(not followed\)/);
  assert.match(x, /\.\.\/outside\/secret\.txt: rejected: path traversal/);
  assert.match(x, /\.env\.local: rejected: secret path/);
  assertNoLeaks(x);
  // Deterministic: the same inputs give the same pack.
  assert.equal(ctx.buildPack({ kind: 'groom', cwd: repo, inputs: ctx.gatherInputs({ ticketKey: t.key }) }).hash, pack.hash);
});

test('review pack: committed multi-file diff with rename, delete and binary; secret diff withheld; nothing silently cut', () => {
  const t = ticketFor({ status: 'review', head_sha: featureSha });
  const pack = ctx.buildPack({ kind: 'review', cwd: repo, inputs: ctx.gatherInputs({ ticketKey: t.key }) });
  const x = pack.text;
  assert.match(x, new RegExp(`head: ${featureSha}`));
  assert.match(x, /R old_name\.js -> new_name\.js/);
  assert.match(x, /D remove_me\.js/);
  assert.match(x, /M img\.png {2}\(binary\)/);
  assert.match(x, /M \.env\.local .*\[secret path: content withheld\]/);
  assert.match(x, /diff --git a\/src\/engine\.js b\/src\/engine\.js[\s\S]*\+ {2}if \(rv <= 0\) return 0;/);
  assert.match(x, /rename from old_name\.js\nrename to new_name\.js/);
  assert.match(x, /deleted file mode[\s\S]*-export const doomed = true;/);
  assert.match(x, /Binary files a\/img\.png and b\/img\.png differ/);
  assert.ok(!x.includes('diff --git a/.env.local'), 'secret file diff never included');
  assert.match(x, /\.env\.local: secret path: diff withheld by policy/);
  assert.deepEqual(pack.meta.omittedChanged, [], 'policy withholding is not a size omission');
  assertNoLeaks(x);
});

test('oversized diff: whole hunks only, explicit omission list, cap respected', () => {
  const t = ticketFor({ status: 'review', head_sha: hugeSha });
  const settings = { ...ctx.packSettings(), packChars: 12000 };
  const pack = ctx.buildPack({ kind: 'review', cwd: repo, inputs: ctx.gatherInputs({ ticketKey: t.key }), settings });
  assert.ok(pack.text.length <= 12000, `pack ${pack.text.length} chars`);
  assert.deepEqual(pack.meta.omittedChanged, ['src/big.js']);
  assert.match(pack.text, /src\/big\.js: diff over budget: hunks \d+-\d+ of \d+ not included/);
  assert.match(pack.text, /NEED FILES:/);
  const real = execFileSync('git', ['-C', repo, 'diff', `${mainSha}...${hugeSha}`, '--', 'src/big.js'], { encoding: 'utf8' });
  const { hunks } = ctx.splitHunks(real);
  const included = hunks.filter((h) => pack.text.includes(h));
  assert.ok(included.length > 0 && included.length < hunks.length, `${included.length}/${hunks.length} hunks included`);
  // Every hunk that made it in (any file) is complete: never cut in the middle.
  const all = execFileSync('git', ['-C', repo, 'diff', '-M', `${mainSha}...${hugeSha}`], { encoding: 'utf8' }).split(/^(?=diff --git )/m).flatMap((p) => ctx.splitHunks(p).hunks);
  const section = pack.text.slice(pack.text.indexOf('## Diff'), pack.text.indexOf('## References'));
  for (const header of section.match(/^@@ .*$/gm)) assert.ok(all.some((h) => h.startsWith(`${header}\n`) && section.includes(h)), `hunk ${header} complete`);
});

test('path policy: traversal, absolute paths, symlinks and secret names are rejected', () => {
  const tree = new Map([['src/a.js', '100644'], ['link.js', '120000'], ['config/secret_keys.json', '100644'], ['mod', '160000']]);
  assert.deepEqual(ctx.resolvePath('src/a.js', tree, repo), { path: 'src/a.js' });
  assert.deepEqual(ctx.resolvePath(`${repo}/src/a.js`, tree, repo), { path: 'src/a.js' });
  assert.equal(ctx.resolvePath('a.js', tree, repo).path, 'src/a.js', 'unique basename resolves');
  assert.match(ctx.resolvePath('src/../../etc/passwd', tree, repo).reason, /traversal/);
  assert.match(ctx.resolvePath('/etc/passwd', tree, repo).reason, /outside the clone/);
  assert.match(ctx.resolvePath('~/.ssh/id_rsa', tree, repo).reason, /outside the clone/);
  assert.match(ctx.resolvePath('link.js', tree, repo).reason, /symlink/);
  assert.match(ctx.resolvePath('config/secret_keys.json', tree, repo).reason, /secret/);
  assert.match(ctx.resolvePath('mod', tree, repo).reason, /submodule/);
  for (const p of ['.env', 'a/.env.prod', 'certs/server.pem', 'home/.ssh/config', 'aws_credentials.ini']) assert.ok(ctx.isSecretPath(p), p);
  assert.ok(!ctx.isSecretPath('src/engine.js'));
  assert.ok(ctx.isProtected('.github/workflows/ci.yml') && ctx.isProtected('deploy/run.sh') && !ctx.isProtected('src/run.js'));
});

test('ticketless research pack: bounded repo map and recent commits', () => {
  const pack = ctx.buildPack({ kind: 'research', cwd: repo, inputs: {} });
  assert.match(pack.text, /## Repository map \(\d+ tracked files\)\n[\s\S]*src\/ {2}\d+ files/);
  assert.match(pack.text, /## Recent commits\n[0-9a-f]+ \d{4}-\d{2}-\d{2} init/);
  assert.match(pack.text, /### README\.md:1-/);
  assertNoLeaks(pack.text);
});

test('delivery: the desk verifies the outgoing message carries the pack; requested files are tracked; accept gates on both', async () => {
  const t = ticketFor({ status: 'review', head_sha: hugeSha });
  const run = store.createRun({ agent_id: 'pm', kind: 'review', ticket_key: t.key, token: 'tok-ctx-1', nonce: 'nonce12345', model: 'perplexity:pplx_asi_kimi_k3', cwd: repo });
  const pack = ctx.prepareRun({ runId: run.id, kind: 'review', cwd: repo, ticketKey: t.key, secrets: ['nonce12345'], settings: { ...ctx.packSettings(), packChars: 12000 } });
  assert.ok(fs.existsSync(pack.meta.file) && pack.meta.file.startsWith(path.join(repo, '.git', 'sigmadesk')), 'pack written outside the work tree');
  assert.ok(!g('status', '--porcelain').includes('sigmadesk'));
  const live = ctx.liveFor(run.id);
  assert.ok(!pack.text.includes('nonce12345'));

  // A relay that pastes a head of the pack (the SD-14 failure) is caught.
  let ev = ctx.recordSend(live, { message: `Review this.\n${pack.text.slice(0, 2000)}`, model: 'pplx_asi_kimi_k3' });
  assert.ok(ev.some((e) => e.error && /did not receive the full context/.test(e.note)));
  assert.equal(live.meta.delivered, false);
  assert.match(ctx.acceptBlockers(live.meta), /did not receive the full context/);

  // Verbatim pack (whitespace at line ends and CRLF tolerated) + relay additions = delivered.
  ev = ctx.recordSend(live, { message: `You are the PM.\n\n${pack.text.replace(/\n/g, '  \r\n')}\n\n## Relay additions\nnone`, model: 'pplx_asi_kimi_k3' });
  assert.ok(ev.some((e) => /delivered to Perplexity verbatim/.test(e.note)));
  ctx.recordThread(live, 'thread-abc-123456');
  assert.match(ctx.acceptBlockers(live.meta), /omitted changed files that were never sent.*src\/big\.js/);

  const r = { ...store.getRun(run.id) };
  store.updateTicket(t.key, { status: 'review' });
  await assert.rejects(sched.deskAction(r, 'accept', { verdict: 'pass', code: 'nonce12345', body: 'lgtm' }), /omitted changed files/);
  assert.equal(store.getTicket(t.key).status, 'review', 'pass refused, ticket unchanged');

  // The model asks for the omitted file; the desk serves it and checks the follow-up carries it.
  const block = await sched.deskAction(r, 'context-file', { path: 'src/big.js' });
  assert.match(block, /^<sigmadesk-file path="src\/big\.js" sha256="[0-9a-f]{64}">/);
  ev = ctx.recordSend(live, { message: `Here you go:\n${block.slice(0, 500)}`, thread_id: 'thread-abc-123456' });
  assert.ok(!live.meta.fetched.includes('src/big.js'), 'a partial paste does not count');
  ev = ctx.recordSend(live, { message: `Here you go:\n${block}`, thread_id: 'thread-abc-123456' });
  assert.deepEqual(live.meta.fetched, ['src/big.js']);
  assert.equal(ctx.acceptBlockers(live.meta), null);
  ev = ctx.recordSend(live, { message: 'one more, plus nonce12345', thread_id: 'thread-abc-123456' });
  assert.ok(ev.some((e) => /follow-ups; the limit is 1/.test(e.note)));
  assert.ok(ev.some((e) => /run token or verdict code/.test(e.note)));
  await assert.rejects(sched.deskAction(r, 'context-file', { path: '.env.local' }), /secret path/);
  await assert.rejects(sched.deskAction(r, 'context-file', { path: '../outside/secret.txt' }), /traversal/);
  ctx.release(run.id);
});

test('perplexity engine: owner discussions are thinking work; the stream parser checks the payload and keeps the thread id', () => {
  assert.ok(pplx.THINK_KINDS.includes('owner_discussion'));
  assert.ok(pplx.perplexity.supports('owner_discussion'));
  const t = ticketFor();
  const run = store.createRun({ agent_id: 'manager', kind: 'groom', ticket_key: t.key, token: 'tok-ctx-2', model: 'perplexity:x', cwd: repo });
  const pack = ctx.prepareRun({ runId: run.id, kind: 'groom', cwd: repo, ticketKey: t.key });
  const state = { pack: ctx.liveFor(run.id) };
  const call = (id, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__perplexity-computer__call_perplexity_computer', input }] } });
  let out = pplx.perplexity.parse(call('tu1', { model: 'pplx_asi_glm_5_3', message: 'Groom this ticket. git diff | head -250' }), repo, state);
  assert.ok(out.some((e) => e.type === 'tool' && /Asked GLM 5\.3/.test(e.text)));
  assert.ok(out.some((e) => e.type === 'pplx' && e.error && /did not receive the full context/.test(e.note)));
  out = pplx.perplexity.parse(call('tu2', { model: 'pplx_asi_glm_5_3', message: `Groom.\n${pack.text}` }), repo, state);
  assert.ok(out.some((e) => e.type === 'pplx' && /delivered/.test(e.note)));
  out = pplx.perplexity.parse(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: '{"thread_id":"7f1c2d3e-aaaa-bbbb-cccc-1234567890ab","status":"pending"}' }] }] } }), repo, state);
  assert.ok(out.some((e) => e.type === 'pplx' && e.threadId === '7f1c2d3e-aaaa-bbbb-cccc-1234567890ab'));
  assert.equal(state.pack.meta.threadId, '7f1c2d3e-aaaa-bbbb-cccc-1234567890ab');
  // The relay charter carries the delivery and polling rules.
  const team = { model: 'pplx_asi_kimi_k3', effort: 'high', id: 'manager' };
  const cmd = pplx.perplexity.command({ seat: team, kind: 'owner_discussion', cwd: repo, perms: { tools: ['Read', 'Bash'], allow: [] }, denyRules: [], charter: 'C', settings: {} });
  const charter = cmd.args[cmd.args.indexOf('--append-system-prompt') + 1];
  assert.match(charter, /VERBATIM/);
  assert.match(charter, /poll read_thread .* up to 8 minutes/s);
  assert.equal(cmd.env.MCP_TOOL_TIMEOUT, String(8 * 60_000));
  ctx.release(run.id);
});

test('retries find the earlier thread for the same job', () => {
  const t = ticketFor();
  const a = store.createRun({ agent_id: 'manager', kind: 'groom', ticket_key: t.key, token: 'tok-ctx-3', model: 'perplexity:x' });
  store.updateRun(a.id, { thread_id: 'thread-1', context_hash: 'h', status: 'killed', ended_at: store.now() });
  assert.equal(store.lastThreadRun({ ticket_key: t.key, agent_id: 'manager', kind: 'groom' }).id, a.id);
  assert.equal(store.lastThreadRun({ ticket_key: t.key, agent_id: 'manager', kind: 'design' }), null);
  assert.equal(store.lastThreadRun({ ticket_key: null, agent_id: 'manager', kind: 'groom' }), null);
});

test('investigate pack: incident evidence redacted, stack-trace files excerpted around the line', () => {
  const inc = store.recordIncident({ signature: 'sig-ctx', normalized: 'TypeError in computeEdge', source_index: 0, label: 'api', project: 'demo',
    line: `ERROR TypeError at src/engine.js:32 token=${SECRET}`, ts: store.now() });
  const pack = ctx.buildPack({ kind: 'investigate', cwd: repo, inputs: ctx.gatherInputs({ incidentId: inc.id }) });
  assert.match(pack.text, /## Incident #\d+ \(api\)/);
  assert.match(pack.text, /ERROR TypeError at src\/engine\.js:32 token=\[redacted\]/);
  assert.match(pack.text, /### src\/engine\.js:1-35/);
  assert.ok(!pack.text.includes('## Repository map'));
  assertNoLeaks(pack.text);
});
