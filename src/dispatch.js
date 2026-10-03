// Provider holds are separate from ticket failures: exhausted credits must not park good work.
import { config } from './config.js';
import { ENGINES, detectEngines, suggestFor } from './engines/index.js';
import { agentById } from './team.js';
import * as store from './db.js';

let availability = {};
export function setAvailability(engines) {
  availability = Object.fromEntries(engines.map((e) => [e.id, e]));
}
export async function refreshAvailability() {
  const engines = await detectEngines();
  setAvailability(engines);
  return engines;
}
function saved(key) {
  try { return JSON.parse(store.kvGet(key) || 'null'); } catch { return null; }
}
export function providerHealth(now = Date.now()) {
  return Object.values(ENGINES).map((e) => {
    const detected = availability[e.id];
    const quota = saved(`quota:${e.id}`);
    const hold = saved(`provider-hold:${e.id}`);
    const reset = Date.parse(quota?.resets_at);
    const expired = Number.isFinite(reset) && reset <= now;
    const windowReset = (name) => {
      const explicit = Date.parse(quota?.[`${name}_resets_at`]);
      const reported = Date.parse(quota?.at);
      return Number.isFinite(explicit) ? explicit : name === 'five_hour' && Number.isFinite(reset) ? reset
        : Number.isFinite(reported) ? reported + (name === 'five_hour' ? 5 : 168) * 3600000 : NaN;
    };
    const windowFull = (name) => {
      const at = windowReset(name);
      // Legacy aggregate reset applies to the five-hour window only. A weekly hold cannot clear early.
      const windowExpired = Number.isFinite(at) ? at <= now : name === 'five_hour' && expired;
      return !windowExpired && (quota?.[name] ?? 0) >= config.limits.planHoldAt;
    };
    const blockingWindows = (quota?.windows || []).filter((w) => w.bucket === (quota.active_bucket || e.id)
      && (!w.resets_at || Date.parse(w.resets_at) > now) && w.used_percent >= config.limits.planHoldAt * 100);
    const full = quota && (blockingWindows.length || windowFull('five_hour') || windowFull('seven_day')
      || (!expired && ['rejected', 'blocked'].includes(quota.status)));
    const cooling = hold && Date.parse(hold.until) > now;
    const available = detected?.available === true;
    return { id: e.id, label: e.label, available, version: detected?.version || '', default_model: detected?.defaultModel || '', quota,
      ready: available && !full && !cooling,
      reason: !detected ? 'Detecting CLI' : !available ? 'CLI unavailable' : cooling ? hold.reason : full ? 'Plan usage limit reached' : null,
      retry_at: cooling ? hold.until : full ? (() => {
        const times = ['five_hour', 'seven_day'].filter(windowFull).map(windowReset).filter(Number.isFinite);
        times.push(...blockingWindows.map((w) => Date.parse(w.resets_at)).filter(Number.isFinite));
        return times.length ? new Date(Math.max(...times)).toISOString() : quota.resets_at || null;
      })() : null };
  });
}
// Per-job choices stay inside the configured catalog and never rewrite a seat preference.
export function reviewSelection(agentId, profile) {
  const engine = ENGINES[profile?.engine];
  const health = providerHealth().find((p) => p.id === profile?.engine);
  if (!engine || !engine.models().some((m) => m.id === profile.model) || !engine.efforts.includes(profile.effort))
    throw Object.assign(new Error('Review model or effort is outside the approved catalog'), { status: 400 });
  if (!health?.ready) return { seat: null, reason: health?.reason || 'Provider unavailable' };
  return { seat: { ...agentById[agentId], engine: engine.id, model: profile.model || health.default_model, effort: profile.effort, role: 'Council Reviewer' }, fallback: false };
}
export function selectionFor(agentId, now = Date.now()) {
  const seat = agentById[agentId];
  if (!seat || seat.enabled === false) return { seat: null, reason: 'Seat disabled' };
  const preferred = seat.engine || 'claude';
  const health = providerHealth(now);
  const primary = health.find((e) => e.id === preferred);
  const resolveSeat = (s) => ({ ...s, model: s.engine === 'codex' && !s.model ? availability.codex?.defaultModel || '' : s.model });
  if (primary?.ready) return { seat: resolveSeat(seat), fallback: false };
  if (store.getSettings().auto_fallback === 'true') {
    const alt = health.find((e) => e.id !== preferred && e.ready && ENGINES[e.id]?.autoFallback !== false); // never fall back onto Perplexity
    if (alt) return { seat: resolveSeat({ ...seat, engine: alt.id, ...suggestFor(agentId, alt.id) }), fallback: true, reason: primary?.reason };
  }
  return { seat: null, reason: primary?.reason || 'Provider unavailable', retry_at: primary?.retry_at };
}
export function classifyProviderFailure(text) {
  const s = String(text || '');
  if (/insufficient_quota|usage_limit_reached|rate_limit_exceeded|credit balance.{0,40}(low|exhaust|insufficient)|out of credits|usage limit|rate.?limit|quota.{0,30}(exceed|exhaust)|you.{0,12}(hit|reached).{0,40}limit/i.test(s)) return 'quota';
  if (/authentication (failed|required)|not logged in|please (log|sign) in|invalid_api_key|unauthorized|401 Unauthorized/i.test(s)) return 'auth';
  return null;
}
export function holdProvider(id, failure, text, now = Date.now()) {
  const q = saved(`quota:${id}`);
  const reset = Date.parse(q?.resets_at);
  const until = failure === 'quota' && reset > now ? reset : now + config.engines.fallbackCooldownMinutes * 60_000;
  const hold = { reason: failure === 'quota' ? 'Credits or rate limit reached' : 'Authentication required',
    detail: store.redact(String(text)).slice(0, 240), until: new Date(until).toISOString(), at: new Date(now).toISOString() };
  store.kvSet(`provider-hold:${id}`, JSON.stringify(hold));
  store.logEvent({ kind: 'system', text: `${ENGINES[id].label}: ${hold.reason}; retry after ${hold.until}. Available fallback seats can continue.` });
  return hold;
}
