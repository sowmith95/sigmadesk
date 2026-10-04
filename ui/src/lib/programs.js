// Research program drafts for the setup screen. Pure: no DOM, no React, no fetch, so node:test covers it and the
// payload it produces is checked against the server's own validator (src/research.js validatePrograms).

export const FREQUENCIES = [
  { minutes: 60, label: 'Hourly', phrase: 'every hour' },
  { minutes: 180, label: 'Every 3 h', phrase: 'every 3 hours' },
  { minutes: 360, label: 'Every 6 h', phrase: 'every 6 hours' },
  { minutes: 720, label: 'Twice a day', phrase: 'twice a day' },
  { minutes: 1440, label: 'Daily', phrase: 'once a day' },
  { minutes: 10080, label: 'Weekly', phrase: 'once a week' },
];
export const WINDOWS = [
  { id: 'any', label: 'Any time', phrase: 'at any time' },
  { id: 'market', label: 'Market hours', phrase: 'during market hours' },
  { id: 'off-market', label: 'After hours', phrase: 'outside market hours' },
];
export const MIN_INTERVAL = 15;
export const MAX_INTERVAL = 525600;

export function frequencyPhrase(minutes) {
  const preset = FREQUENCIES.find((f) => f.minutes === minutes);
  if (preset) return preset.phrase;
  if (minutes % 1440 === 0) return `every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  return `every ${minutes} minutes`;
}
export const frequencyLabel = (minutes) => FREQUENCIES.find((f) => f.minutes === minutes)?.label || frequencyPhrase(minutes).replace(/^every /, 'Every ');
export const windowPhrase = (id) => WINDOWS.find((w) => w.id === id)?.phrase || id;

/** Custom interval input → minutes. Accepts "90", "90m", "4h", "2d", "1w". Returns null when invalid or out of range. */
export function parseInterval(text) {
  const m = String(text || '').trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?$/);
  if (!m) return null;
  const unit = (m[2] || 'm')[0];
  const minutes = Math.round(Number(m[1]) * ({ m: 1, h: 60, d: 1440, w: 10080 }[unit]));
  return minutes >= MIN_INTERVAL && minutes <= MAX_INTERVAL ? minutes : null;
}

export function slugify(label) {
  const s = String(label || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/[_\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const cut = s.slice(0, 40).replace(/-$/, '');
  return /^[a-z0-9]/.test(cut) ? cut : `program${cut ? `-${cut}` : ''}`.slice(0, 40);
}
export function uniqueId(label, taken) {
  const base = slugify(label) || 'program';
  if (!taken.includes(base)) return base;
  for (let i = 2; i < 100; i++) { const id = `${base.slice(0, 37)}-${i}`; if (!taken.includes(id)) return id; }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

export const SOURCE_SUGGESTIONS = ['arxiv.org', 'ssrn.com', 'nber.org', 'sec.gov', 'cboe.com', 'cmegroup.com', 'federalreserve.gov', 'github.com', 'news.ycombinator.com', 'reddit.com/r/options'];
export function normalizeSource(s) {
  const v = String(s || '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return v.length && v.length <= 200 ? v : null;
}

/** Starting points that fill every field; the owner adjusts and saves. */
export const TEMPLATES = [
  { id: 'competitor-scan', label: 'Competitor scan', seat: 'pm', intervalMinutes: 720, window: 'any', focus: '',
    sources: [], web: true, maxProposals: 3, blurb: 'What rival trading tools ship that our users would miss' },
  { id: 'quant-papers', label: 'Quant papers', seat: 'quant-research', intervalMinutes: 1440, window: 'off-market',
    focus: 'volatility, options pricing and execution papers that could change how the product measures or shows risk',
    sources: ['arxiv.org', 'ssrn.com', 'nber.org'], web: true, maxProposals: 2, blurb: 'Papers worth turning into features, cited' },
  { id: 'workflow-review', label: 'Trading workflow', seat: 'trading-advisor', intervalMinutes: 1440, window: 'off-market',
    focus: 'where the dashboard slows a trader down during the session: extra clicks, unclear risk, noisy alerts',
    sources: [], web: false, maxProposals: 2, blurb: 'Friction in the screens traders use live' },
  { id: 'reliability-watch', label: 'Reliability watch', seat: 'sre', intervalMinutes: 1440, window: 'off-market',
    focus: 'recurring errors, slow paths and missing alerts that the on-call SRE keeps seeing',
    sources: [], web: false, maxProposals: 2, blurb: 'Fixes that prevent the next incident' },
];

export function fromProgram(p) {
  return { id: p.id, label: p.label, seat: p.seat, enabled: p.enabled, intervalMinutes: p.intervalMinutes, window: p.window,
    mode: p.focus ? 'directed' : 'own', focus: p.focus || '', sources: [...(p.sources || [])], web: !!p.tools?.web,
    connectors: [...(p.tools?.connectors || [])], maxProposals: p.maxProposals,
    minReviewers: p.review?.minReviewers || 1, reviewers: [...(p.review?.reviewers || [])], isNew: false };
}
/** @param {any} tpl @param {{ takenIds?: string[], defaultReview?: { minReviewers: number, reviewers: string[] }, seats?: string[] }} [opts] */
export function fromTemplate(tpl, { takenIds = [], defaultReview = { minReviewers: 1, reviewers: [] }, seats = [] } = {}) {
  const seat = seats.includes(tpl.seat) ? tpl.seat : seats[0] || tpl.seat;
  const reviewers = (defaultReview.reviewers || []).filter((r) => r !== seat);
  return { id: uniqueId(tpl.label, takenIds), label: tpl.label, seat, enabled: true, intervalMinutes: tpl.intervalMinutes, window: tpl.window,
    mode: tpl.focus ? 'directed' : 'own', focus: tpl.focus, sources: [...tpl.sources], web: tpl.web, connectors: [],
    maxProposals: tpl.maxProposals, minReviewers: Math.min(defaultReview.minReviewers || 1, Math.max(1, reviewers.length)), reviewers, isNew: true };
}
/** @param {{ takenIds?: string[], defaultReview?: { minReviewers: number, reviewers: string[] }, seats?: string[] }} [opts] */
export const blankDraft = (opts) => fromTemplate({ id: 'blank', label: 'New research', seat: 'pm', intervalMinutes: 1440, window: 'any', focus: '', sources: [], web: true, maxProposals: 2 }, opts);

/** Changing the researcher removes them from their own reviewer list. The required count stays; if too few reviewers
 *  remain, validation asks for another instead of quietly lowering the bar. */
export function withSeat(d, seat) {
  return { ...d, seat, reviewers: d.reviewers.filter((r) => r !== seat) };
}
export function toProgram(d) {
  return { id: d.id, label: d.label.trim(), seat: d.seat, enabled: d.enabled, intervalMinutes: d.intervalMinutes, window: d.window,
    focus: d.mode === 'directed' ? d.focus.trim() : '', sources: d.sources, tools: { web: d.web, connectors: d.connectors },
    maxProposals: d.maxProposals, review: { minReviewers: d.minReviewers, reviewers: d.reviewers } };
}
/** The full list to PUT: every saved program as it is, with this draft inserted or replaced. */
export function listWith(saved, draft) {
  const p = toProgram(draft);
  const i = saved.findIndex((x) => x.id === draft.id);
  const strip = (x) => ({ id: x.id, label: x.label, seat: x.seat, enabled: x.enabled, intervalMinutes: x.intervalMinutes, window: x.window, focus: x.focus || '',
    sources: x.sources || [], tools: { web: !!x.tools?.web, connectors: x.tools?.connectors || [] }, maxProposals: x.maxProposals, review: { minReviewers: x.review.minReviewers, reviewers: x.review.reviewers } });
  const out = saved.map(strip);
  if (i >= 0) out[i] = p; else out.push(p);
  return out;
}
export const listWithout = (saved, id) => saved.filter((x) => x.id !== id).map((x) => listWith([x], fromProgram(x))[0]);

/** Same rules the server enforces, phrased for the person filling the form. Empty array = ready to save. */
/** @param {any} d @param {{ approvedConnectors?: string[], seatEngine?: string }} [opts] @returns {string[]} */
export function problems(d, { approvedConnectors = [], seatEngine = 'claude' } = {}) {
  const out = [];
  if (!d.label.trim()) out.push('Give the program a name.');
  if (d.label.length > 60) out.push('Keep the name under 60 characters.');
  if (!(Number.isInteger(d.intervalMinutes) && d.intervalMinutes >= MIN_INTERVAL && d.intervalMinutes <= MAX_INTERVAL)) out.push('Pick how often it runs (at least every 15 minutes, at most once a year).');
  if (d.mode === 'directed' && !d.focus.trim()) out.push('Write the topic, or switch to "On their own".');
  if (d.focus.length > 2000) out.push('Keep the topic under 2000 characters.');
  if (d.reviewers.includes(d.seat)) out.push('The researcher cannot check their own work.');
  if (d.reviewers.length < d.minReviewers) out.push(`Choose at least ${d.minReviewers} reviewer${d.minReviewers === 1 ? '' : 's'}.`);
  if (!(d.maxProposals >= 1 && d.maxProposals <= 10)) out.push('Proposals per session must be 1 to 10.');
  for (const c of d.connectors) if (!approvedConnectors.includes(c)) out.push(`${c} is not approved yet.`);
  if (d.web && seatEngine === 'codex') out.push('This seat runs on Codex, which has no web search. Turn web off or pick another researcher.');
  if (d.connectors.length && seatEngine !== 'claude') out.push('Connectors work only for seats that run on Claude Code.');
  return out;
}

/** Sentence parts for the program card: text runs and editable slots. */
export function sentence(d, agents) {
  const name = (id) => agents.find((a) => a.id === id)?.name || id;
  const who = d.reviewers.slice(0, 3).map(name);
  const reviewers = who.length ? (d.minReviewers >= who.length ? who.join(' and ') : `${d.minReviewers} of ${who.join(', ')}`) : 'nobody yet';
  return [
    { slot: 'seat', text: name(d.seat) },
    { text: ' researches ' },
    { slot: 'topic', text: d.mode === 'directed' && d.focus.trim() ? truncateWords(d.focus, 9) : 'on their own judgment' },
    { text: ' ' },
    { slot: 'frequency', text: frequencyPhrase(d.intervalMinutes) },
    { text: ', ' },
    { slot: 'window', text: windowPhrase(d.window) },
    { text: '. Checked by ' },
    { slot: 'reviewers', text: reviewers },
    { text: '.' },
  ];
}
function truncateWords(s, n) {
  const words = String(s).trim().replace(/[.]+$/, '').split(/\s+/);
  const text = words.length > n ? `${words.slice(0, n).join(' ').replace(/[,:;]$/, '')}…` : words.join(' ');
  // The topic follows "researches", so "Volatility papers" reads as "volatility papers"; acronyms (SEC, UI) keep their case.
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}
