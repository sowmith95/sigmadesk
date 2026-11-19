// Drain dispatch before restart, then restore the previous open/paused state.
import { execFileSync } from 'node:child_process';
// A project desk: `--home <project home>` (or SIGMADESK_HOME) so the right config, token and port are loaded.
const argv = process.argv.slice(2);
const hi = argv.indexOf('--home');
if (hi >= 0) { process.env.SIGMADESK_HOME = argv[hi + 1]; argv.splice(hi, 2); }
const { config } = await import('../src/config.js');
const [name = 'default', port = String(config.server.port), maxMinutes = '240'] = argv;
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !Number.isFinite(Number(maxMinutes)) || Number(maxMinutes) <= 0) throw new Error('Invalid service name, port or timeout');
const endpoint = `http://127.0.0.1:${port}`;
// A long-running desk can be slow to answer: after 15 days up, largely swapped out, it took ~12 s a request
// (2026-11-19), and a 5 s limit timed this script out after it had paused dispatch. Calls wait up to 90 s
// (SIGMADESK_RESTART_API_TIMEOUT_MS overrides); readiness probes after the restart use a shorter per-try limit.
const API_TIMEOUT_MS = Number(process.env.SIGMADESK_RESTART_API_TIMEOUT_MS) || 90_000;
const READY_TRY_MS = Math.min(API_TIMEOUT_MS, 15_000), READY_WITHIN_MS = 5 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, method = 'GET', ms = API_TIMEOUT_MS) => {
  const res = await fetch(endpoint + p, { method, headers: { 'Content-Type': 'application/json', 'X-SigmaDesk-Token': config.server.ownerToken }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`Desk HTTP ${res.status}`); return res.json();
};
// Re-open dispatch and confirm it took (a timed-out POST may or may not have landed). Never throws: a failure here
// must not replace the error that ended the run; it is reported loudly and fails the exit code instead.
async function reopen() {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api('/api/control/start', 'POST');
      if ((await api('/api/state')).settings.paused !== 'true') { console.log('Previous open state restored.'); return; }
      last = new Error('the desk still reports paused');
    } catch (e) { last = e; }
    await sleep(2000);
  }
  console.error(`DISPATCH IS STILL PAUSED: re-opening failed (${last?.message}). Press Start on the desk, or POST /api/control/start.`);
  process.exitCode = 1;
}
const initial = await api('/api/state'); const wasOpen = initial.settings.paused !== 'true';
await api('/api/control/pause', 'POST');
console.log('Dispatch drained; waiting for current work to finish.');
const deadline = Date.now() + Number(maxMinutes) * 60000;
let restarted = false;
try {
  let idle = 0;
  while (Date.now() < deadline) {
    const s = await api('/api/state');
    idle = !s.meta.running && !s.agents.some((a) => a.status === 'working') ? idle + 1 : 0;
    if (idle >= 2) {
      if (process.platform === 'darwin') execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.sigmadesk.${name}`]);
      else if (process.platform === 'linux') execFileSync('systemctl', ['--user', 'restart', `sigmadesk-${name}.service`]);
      else throw new Error('Unsupported service platform');
      const readyBy = Date.now() + READY_WITHIN_MS;
      while (!restarted && Date.now() < readyBy) {
        try { await api('/api/state', 'GET', READY_TRY_MS); restarted = true; } catch { await sleep(1000); }
      }
      if (!restarted) throw new Error('Service did not become ready after restart');
      console.log('Service restarted between runs.'); break;
    }
    await sleep(2000);
  }
  if (!restarted) throw new Error('Timed out waiting for the desk to become idle');
} finally {
  if (wasOpen) await reopen();
}
