// Research programs: who on the team researches, how often, in which market window, with which sources, web access and
// approved connectors, how many proposals a session may file, and who must review a proposal before grooming.
// The default "product-discovery" program is derived from config.pm and the legacy pm_* settings until the owner saves
// programs in the UI; the saved JSON then wins as a whole. Eligibility here is a pure calculation; admission (seat,
// capacity, budget, proposal allowance) happens in the scheduler's single launch path.
import { config } from './config.js';
import * as store from './db.js';
import { agentById } from './team.js';
import { ENGINES } from './engines/index.js';
import * as connectors from './connectors.js';

export const DEFAULT_PROGRAM = 'product-discovery';
export const WINDOWS = ['any', 'market', 'off-market'];
export const KINDS = ['research', 'research_revision', 'research_review', 'connector_assessment'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// ---------------- windows (launch-time only: a run that starts before the close may finish after it) ----------------
export function localParts(d, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), mins: Number(parts.hour) * 60 + Number(parts.minute) };
}
export const toMins = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
export function inWindow(d, w) {
  if (!w) return false;
  const { day, mins } = localParts(d, w.timezone);
  return w.days.includes(day) && mins >= toMins(w.start) && mins < toMins(w.end);
}
export function windowSatisfied(window, d = new Date(), market = config.research.marketHours) {
  if (window === 'any') return true;
  const open = inWindow(d, market);
  return window === 'market' ? open : !open;
}

// ---------------- programs ----------------
function defaultProgram(settings) {
  return { id: DEFAULT_PROGRAM, label: 'Product discovery', seat: 'pm', enabled: settings.pm_enabled === 'true',
    intervalMinutes: Number(settings.pm_interval_min) || config.pm.intervalMinutes, window: 'any', focus: '',
    sources: [], tools: { web: true, connectors: [] }, maxProposals: 3, review: { ...config.research.review, reviewers: [...config.research.review.reviewers] } };
}
const str = (v, max, what) => { if (typeof v !== 'string' || v.length > max) fail(`${what} must be text of at most ${max} characters`); return v; };
export function normalize(p, { agents = agentById, approved = connectors.isApproved } = {}) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('each program must be an object');
  if (!ID_RE.test(String(p.id || ''))) fail('program id must be kebab-case (max 40)');
  const who = `program ${p.id}`;
  const label = str(p.label ?? p.id, 60, `${who} label`);
  const seat = agents[p.seat];
  if (!seat) fail(`${who}: unknown seat ${p.seat}`);
  if (typeof p.enabled !== 'boolean') fail(`${who}: enabled must be true or false`);
  const interval = Number(p.intervalMinutes);
  if (!Number.isInteger(interval) || interval < 15 || interval > 525600) fail(`${who}: intervalMinutes must be an integer from 15 to 525600`);
  if (!WINDOWS.includes(p.window)) fail(`${who}: window must be ${WINDOWS.join('|')}`);
  const focus = str(p.focus ?? '', 2000, `${who} focus`);
  const sources = p.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 40 || !sources.every((s) => typeof s === 'string' && s.trim() && s.length <= 200)) fail(`${who}: sources must list up to 40 short source names, domains or ids`);
  const tools = p.tools ?? {};
  if (typeof tools !== 'object' || typeof tools.web !== 'boolean') fail(`${who}: tools.web must be true or false`);
  const conns = tools.connectors ?? [];
  if (!Array.isArray(conns) || conns.length > 8 || !conns.every((c) => typeof c === 'string' && connectors.NAME_RE.test(c)) || new Set(conns).size !== conns.length) fail(`${who}: tools.connectors must list up to 8 distinct connector names`);
  for (const c of conns) if (!approved(c)) fail(`${who}: connector ${c} is not approved (Settings → Research → Connectors)`);
  const maxProposals = Number(p.maxProposals);
  if (!Number.isInteger(maxProposals) || maxProposals < 1 || maxProposals > 10) fail(`${who}: maxProposals must be 1-10`);
  const review = p.review ?? {};
  const minReviewers = Number(review.minReviewers);
  if (!Number.isInteger(minReviewers) || minReviewers < 1 || minReviewers > 3) fail(`${who}: review.minReviewers must be 1-3`);
  const reviewers = review.reviewers ?? [];
  if (!Array.isArray(reviewers) || !reviewers.every((r) => agents[r]) || new Set(reviewers).size !== reviewers.length) fail(`${who}: review.reviewers must list distinct existing seats`);
  if (reviewers.includes(p.seat)) fail(`${who}: the researching seat cannot review its own proposals`);
  if (reviewers.length < minReviewers) fail(`${who}: review needs at least ${minReviewers} reviewer seat(s)`);
  // Engine fit: the seat's preferred engine must be able to carry the job. Fallback at run time is checked again.
  const engine = ENGINES[seat.engine || 'claude'];
  if (engine?.supports && !engine.supports('research')) fail(`${who}: ${engine.label} cannot run research for seat ${p.seat}`);
  if (tools.web && seat.engine === 'codex') fail(`${who}: Codex seats have web search disabled; use a Claude or Perplexity seat for web research`);
  if (conns.length && (seat.engine || 'claude') !== 'claude') fail(`${who}: connectors are carried by Claude Code seats only (the Perplexity relay keeps a single server; Codex has none)`);
  return { id: p.id, label, seat: p.seat, enabled: p.enabled, intervalMinutes: interval, window: p.window, focus, sources: [...sources], tools: { web: tools.web, connectors: [...conns] }, maxProposals, review: { minReviewers, reviewers: [...reviewers] } };
}
export function validatePrograms(list, opts) {
  if (!Array.isArray(list) || !list.length || list.length > 12) fail('provide 1-12 research programs');
  const out = list.map((p) => normalize(p, opts));
  if (new Set(out.map((p) => p.id)).size !== out.length) fail('program ids must be unique');
  return out;
}

let lastProblems = [];
export const problems = () => lastProblems;
export function programs(settings = store.getSettings()) {
  const raw = settings.research_programs;
  const found = [];
  if (raw) {
    try { lastProblems = []; return validatePrograms(JSON.parse(raw)); }
    catch (e) { found.push(`saved research programs ignored: ${e.message}`); }
  }
  const base = [defaultProgram(settings)];
  for (const p of config.research.programs || []) {
    const i = base.findIndex((x) => x.id === p.id);
    try {
      const merged = normalize({ ...(i >= 0 ? base[i] : {}), ...p, tools: { ...(i >= 0 ? base[i].tools : {}), ...(p.tools || {}) }, review: { ...(i >= 0 ? base[i].review : config.research.review), ...(p.review || {}) } });
      if (i >= 0) base[i] = merged; else base.push(merged);
    } catch (e) { found.push(`config research.programs ${p?.id || '?'} skipped: ${e.message}`); }
  }
  lastProblems = found;
  return base;
}
export const get = (id, settings) => programs(settings).find((p) => p.id === id) || null;
export const configured = (settings = store.getSettings()) => !!settings.research_programs;
export function save(list) {
  const normalized = validatePrograms(list);
  store.writeSetting('research_programs', JSON.stringify(normalized));
  const d = normalized.find((p) => p.id === DEFAULT_PROGRAM);
  if (d) { store.writeSetting('pm_enabled', String(d.enabled)); store.writeSetting('pm_interval_min', String(d.intervalMinutes)); }
  store.logEvent({ kind: 'system', agent_id: 'owner', text: `research programs saved: ${normalized.map((p) => `${p.id} (${p.seat}, every ${p.intervalMinutes} min, ${p.window}${p.enabled ? '' : ', off'})`).join('; ')}` });
  return normalized;
}
export function reset() {
  store.writeSetting('research_programs', '');
  store.writeSetting('pm_enabled', String(config.pm.enabled)); store.writeSetting('pm_interval_min', String(config.pm.intervalMinutes));
  store.logEvent({ kind: 'system', agent_id: 'owner', text: 'research programs reset to the configuration defaults' });
  return programs();
}

// ---------------- eligibility ----------------
export const requirements = (p) => ({ web: !!p.tools.web, connectors: [...p.tools.connectors] });
export function lastRunAt(p) { return store.lastResearchRun(p.id, { untagged: p.id === DEFAULT_PROGRAM })?.started_at || null; }
export function eligibility(p, { now = new Date(), settings = store.getSettings() } = {}) {
  const last = lastRunAt(p);
  const next = last ? new Date(Date.parse(last) + p.intervalMinutes * 60_000).toISOString() : null;
  const base = { last_run_at: last, next_eligible_at: next };
  if (!p.enabled) return { ...base, ok: false, code: 'disabled', reason: 'Program is off' };
  if (agentById[p.seat]?.enabled === false) return { ...base, ok: false, code: 'seat_disabled', reason: `${agentById[p.seat].name} is disabled` };
  if (!windowSatisfied(p.window, now)) return { ...base, ok: false, code: 'window', reason: p.window === 'market' ? 'Runs during market hours only' : 'Runs outside market hours only' };
  if (next && Date.parse(next) > now.getTime()) return { ...base, ok: false, code: 'cadence', reason: `Next session after ${next}` };
  const room = Number(settings.max_open_proposals) - store.ticketsByStatus('proposed').length;
  if (room <= 0) return { ...base, ok: false, code: 'funnel', reason: 'Enough proposals are waiting for grooming' };
  return { ...base, ok: true, code: 'due', reason: 'Due', room };
}
// Due programs, oldest last run first, so list order cannot starve a program.
export function due(settings = store.getSettings(), now = new Date()) {
  return programs(settings).map((p) => ({ p, e: eligibility(p, { now, settings }) })).filter((x) => x.e.ok)
    .sort((a, b) => (Date.parse(a.e.last_run_at) || 0) - (Date.parse(b.e.last_run_at) || 0)).map((x) => ({ ...x.p, room: x.e.room }));
}
// Server-owned job metadata carried by the run: allowances and capabilities the desk enforces on every desk command.
export function job(p, { focus = '', room = p.maxProposals } = {}) {
  return { program: p.id, seat: p.seat, maxProposals: Math.max(0, Math.min(p.maxProposals, room)), proposals: 0, web: p.tools.web,
    connectors: connectors.approvedFor(p.tools.connectors), sources: [...p.sources], focus: [p.focus, String(focus || '').slice(0, 500)].filter(Boolean).join(' '), review: { ...p.review } };
}
export function status(settings = store.getSettings(), now = new Date()) {
  const market = config.research.marketHours;
  return { configured: configured(settings), programs: programs(settings).map((p) => ({ ...p, ...eligibility(p, { now, settings }) })), windows: WINDOWS,
    market_hours: { ...market, open_now: inWindow(now, market) }, problems: lastProblems, seats: Object.keys(agentById), connectors: connectors.summary(),
    case_sections: connectors.CASE_SECTIONS, sdlc_stages: connectors.SDLC_STAGES, default_review: config.research.review };
}
