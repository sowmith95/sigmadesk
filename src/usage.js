// Read account limits without starting a model turn. Desktop credits are explicitly observed snapshots.
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { codexHome, codexInvocation } from './engines/codex.js';
import * as store from './db.js';

export function normalizeCodex(data, at = store.now()) {
  const buckets = data.rateLimitsByLimitId || (data.rateLimits ? { codex: data.rateLimits } : {});
  const active = Object.entries(buckets).find(([id]) => id === 'codex') || Object.entries(buckets)[0];
  const selected = active?.[1];
  const windows = Object.entries(buckets).flatMap(([id, b]) => ['primary', 'secondary'].flatMap((name) => {
    const w = b?.[name];
    if (!w || w.usedPercent == null) return [];
    const used = Math.max(0, Math.min(100, Number(w.usedPercent)));
    if (!Number.isFinite(used)) return [];
    return [{ bucket: id, name, used_percent: used, remaining_percent: 100 - used, duration_minutes: w.windowDurationMins,
      resets_at: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }];
  }));
  const activeBucket = active?.[0] || 'codex';
  const primary = windows.filter((w) => w.bucket === activeBucket);
  const five = primary.find((w) => w.duration_minutes === 300), seven = primary.find((w) => w.duration_minutes === 10080);
  return { engine: 'codex', source: 'Codex account API', at, windows, active_bucket: activeBucket, plan: selected?.planType || null,
    status: selected?.spendControlReached || selected?.rateLimitReachedType || data.ordinaryUsageAllowed === false ? 'blocked' : 'allowed',
    five_hour: five ? five.used_percent / 100 : null, seven_day: seven ? seven.used_percent / 100 : null,
    five_hour_resets_at: five?.resets_at || null, seven_day_resets_at: seven?.resets_at || null,
    resets_at: primary.filter((w) => w.used_percent >= config.limits.planHoldAt * 100).sort((a, b) => Date.parse(b.resets_at) - Date.parse(a.resets_at))[0]?.resets_at || null,
    credits: selected?.credits ? { balance: selected.credits.balance, unlimited: selected.credits.unlimited, has_credits: selected.credits.hasCredits } : null };
}

export function readCodexLimits() {
  return new Promise((resolve, reject) => {
    const cli = codexInvocation();
    const child = spawn(cli.bin, [...cli.prefix, 'app-server', '--stdio'], { env: { ...process.env, CODEX_HOME: codexHome() }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', settled = false;
    const finish = (err, result) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill('SIGTERM');
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex account usage request timed out')), 12000);
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
    child.on('error', (err) => finish(err)); child.on('exit', () => { if (!settled) finish(new Error('Codex account service exited before reporting limits')); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 2 << 20) return finish(new Error('Codex usage response exceeded limit'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.error && [1, 2].includes(m.id)) return finish(new Error(store.redact(m.error.message || 'Codex usage unavailable')));
        if (m.id === 1) { send({ method: 'initialized', params: {} }); send({ method: 'account/rateLimits/read', id: 2 }); }
        if (m.id === 2) return finish(null, normalizeCodex(m.result || {}));
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'sigmadesk', title: 'SigmaDesk usage monitor', version: '0.1.0' } } });
  });
}
let refreshing = null;
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const q = await readCodexLimits();
      store.kvSet('quota:codex', JSON.stringify(q)); store.kvSet('quota-health:codex', JSON.stringify({ at: store.now(), ok: true }));
      const activeWindows = q.windows.filter((w) => w.bucket === q.active_bucket);
      if (q.status === 'allowed' && activeWindows.length && activeWindows.every((w) => w.used_percent < config.limits.planHoldAt * 100))
        store.kvSet('provider-hold:codex', 'null');
      store.bus.emit('msg', { type: 'quota', data: q });
    } catch (err) { store.kvSet('quota-health:codex', JSON.stringify({ at: store.now(), ok: false, error: store.redact(err.message).slice(0, 200) })); }
    return status();
  })().finally(() => { refreshing = null; });
  return refreshing;
}
const saved = (key) => { try { return JSON.parse(store.kvGet(key) || 'null'); } catch { return null; } };
export function status() {
  return { codex: saved('quota-health:codex'), perplexity_desktop: saved('quota:perplexity-desktop'),
    policy: `Use the saved execution seat first. At ${Math.round(config.limits.planHoldAt * 100)}% usage or a provider failure, select the other healthy CLI provider and its task-tier model/effort. Keep independent QA and budget gates. Perplexity API models serve advisory reviews; desktop credits require the signed-in app.`,
    automatic: store.getSettings().auto_fallback === 'true' };
}
export function recordDesktop({ remaining, used_month = null }) {
  const n = Number(remaining), used = used_month == null ? null : Number(used_month);
  if (remaining == null || remaining === '' || !Number.isFinite(n) || n < 0 || n > 1e9 || (used != null && (!Number.isFinite(used) || used < 0 || used > 1e9)))
    throw Object.assign(new Error('Valid nonnegative desktop credit values are required'), { status: 400 });
  const q = { credits_remaining: n, credits_used_month: used, at: store.now(), source: 'Observed desktop snapshot', reset_at: null };
  store.kvSet('quota:perplexity-desktop', JSON.stringify(q)); return q;
}
