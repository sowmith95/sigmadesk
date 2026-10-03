// Explicit real-provider check in a disposable repository. Never uses production tickets or publishing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'local'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, 'local', 'seat-smoke-'));
const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
fs.writeFileSync(path.join(repo, 'README.md'), 'Disposable seat smoke test\n');
execFileSync('git', ['-C', repo, 'add', '.']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-qm', 'fixture']);
const cfg = path.join(tmp, 'config.json');
fs.writeFileSync(cfg, JSON.stringify({ server: { port: 8792, hosts: ['127.0.0.1'], preventIdleSleep: false }, project: { name: 'Seat smoke', repoPath: repo, githubRepo: 'test/fixture', playbook: path.join(root, 'playbooks/default.md') },
  github: { sync: false, openDraftPrs: false }, pm: { enabled: false }, watch: { enabled: false }, limits: { runTimeoutMin: { triage: 3 } } }));
process.env.SIGMADESK_CONFIG = cfg; process.env.SIGMADESK_DB = path.join(tmp, 'state.db'); process.env.SIGMADESK_SOCKET = `/tmp/sd-smoke-${process.pid}/agent.sock`; process.env.SIGMADESK_WORKSPACES = path.join(tmp, 'workspaces');
const { config } = await import('../src/config.js'); config.root = tmp;
fs.symlinkSync(path.join(root, 'public'), path.join(tmp, 'public')); fs.mkdirSync(path.join(tmp, 'bin')); fs.copyFileSync(path.join(root, 'bin', 'desk'), path.join(tmp, 'bin', 'desk')); fs.chmodSync(path.join(tmp, 'bin', 'desk'), 0o755);
const server = await import('../src/server.js'); const store = await import('../src/db.js'); const runner = await import('../src/runner.js');
await server.main();
store.kvSet('quota:claude', JSON.stringify({ five_hour: .99, at: store.now(), resets_at: new Date(Date.now() + 3600000).toISOString() }));
const cwd = await runner.ensureReadonlyWorkspace('support');
const outside = path.join(tmp, 'private-probe.txt'); fs.writeFileSync(outside, 'unchanged');
fs.writeFileSync(path.join(cwd, 'smoke-probe.mjs'), `import fs from 'node:fs'; import net from 'node:net';
const result = {};
try { fs.readFileSync(${JSON.stringify(outside)},'utf8'); result.read_denied=false; } catch { result.read_denied=true; }
try { fs.writeFileSync(${JSON.stringify(outside)},'changed'); result.write_denied=false; } catch { result.write_denied=true; }
result.network_denied = await new Promise(resolve=>{const s=net.connect(8792,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(false)});s.once('error',()=>resolve(true));s.setTimeout(1000,()=>{s.destroy();resolve(true)});});
fs.writeFileSync('smoke-result.json',JSON.stringify(result)); console.log(JSON.stringify(result));
`);
console.log(`Smoke fixture: ${tmp}`);
const stream = path.join(tmp, 'stream.jsonl');
const { run } = await runner.startRun({ agentId: 'support', kind: 'triage', cwd, onStreamLine: (line) => fs.appendFileSync(stream, line + '\n', { mode: 0o600 }), prompt: 'This is a bounded local transport and sandbox smoke test, not a ticket. Run exactly these shell commands: desk list; node smoke-probe.mjs. Do not edit any file or call any other desk action. Wait until each command completes. Report the results and finish.' });
let probes; try { probes = JSON.parse(fs.readFileSync(path.join(cwd, 'smoke-result.json'), 'utf8')); } catch { probes = {}; }
const deskWorked = runner.evidenceFor(run.id).some((e) => /desk list/.test(e.cmd) && e.ok);
const okay = run.status === 'success' && run.model.startsWith('codex:') && deskWorked && probes.read_denied && probes.write_denied && probes.network_denied && fs.readFileSync(outside, 'utf8') === 'unchanged';
console.log(JSON.stringify({ success: !!okay, model: run.model, status: run.status, mailbox: deskWorked, probes, usage: JSON.parse(run.usage_json || 'null'), charged_cap_usd: run.cost_usd, result: run.result_text }, null, 2));
await runner.shutdownAll('smoke complete');
if (okay) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`Diagnostics retained: ${tmp}`);
fs.rmSync(path.dirname(config.socketPath), { recursive: true, force: true });
process.exit(okay ? 0 : 1);
