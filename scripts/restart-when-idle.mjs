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
const api = async (p, method = 'GET') => {
  const res = await fetch(endpoint + p, { method, headers: { 'Content-Type': 'application/json', 'X-SigmaDesk-Token': config.server.ownerToken }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Desk HTTP ${res.status}`); return res.json();
};
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
      for (let i = 0; i < 60; i++) {
        try { await api('/api/state'); restarted = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
      }
      if (!restarted) throw new Error('Service did not become ready after restart');
      console.log('Service restarted between runs.'); break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!restarted) throw new Error('Timed out waiting for the desk to become idle');
} finally {
  if (wasOpen) { await api('/api/control/start', 'POST'); console.log('Previous open state restored.'); }
}
