// SigmaDesk v2 — "Inbox first". One snapshot, then a live SSE stream of deltas. No framework, no innerHTML for data.
// Every count and lane comes from attention.board(); this file never recounts ticket statuses itself.
import * as prsUi from './prs.js';
import { nameOf, linkKeys } from './names.js';
import { portrait, presenceOf } from './avatars.js';
import { board, deskStatus, humanReason } from './attention.js';
import { runCard } from './runcard.js';
import { conversationItems, nearLatest } from './conversation.js';

const VIEWS = ['inbox', 'work', 'team'];
const STAGE_LABEL = { triage: 'Intake', proposed: 'Proposed', todo: 'To do', in_progress: 'Building', qa: 'QA', review: 'Acceptance', needs_human: 'Needs you', ready_for_human: 'Ready for review', done: 'Shipped', wontdo: 'Closed' };
const BUCKET_LABEL = { needs_you: 'Needs you', blocked: 'Blocked', working: 'Working', queued: 'Queued', shipped: 'Shipped', closed: 'Closed' };
const KIND_LABEL = { product: 'Product review', question: 'Question', guard: 'Publish guard', merge: 'Ready to merge', publish: 'Ready to publish', design: 'Design decision', council: 'Council verdict', page: 'Production errors', research: 'Research proposal' };

const S = {
  agents: [], tickets: [], events: [], runs: [], settings: {}, meta: {}, incidents: [],
  view: VIEWS.includes(localStorage.getItem('sd2.view')) ? localStorage.getItem('sd2.view') : 'inbox',
  sheet: null, connected: false, loadError: null, loaded: false,
  filter: { open: false, q: '', assignee: '', closed: false },
  shippedAll: false, open: {}, // disclosure state survives re-renders
  seen: new Set(), painted: false, // needs-you keys already shown (new ones slide in once)
  questions: {}, // key → { at: updated_at, text } (the ❓ comment shown on Inbox cards)
  prs: null, prsAt: 0, prsLoading: false,
  councils: {}, // council id → report (inline council decisions)
  drafts: (() => { try { return JSON.parse(localStorage.getItem('sd2.drafts') || '{}'); } catch { return {}; } })(), // ticket:decision → text
};
const draftKey = (key, decisionId) => `${key}:${decisionId || 'msg'}`;
const saveDrafts = () => { try { localStorage.setItem('sd2.drafts', JSON.stringify(S.drafts)); } catch { /* private mode */ } };
let B = board(S); // the attention board for the current render

// ---------------- tiny DOM helper ----------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const agentMap = () => Object.fromEntries(S.agents.map((a) => [a.id, a]));
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const firstName = (id) => (agentMap()[id]?.name || '').split(/\s+/)[0] || 'The engineer';
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const waited = (iso) => {
  if (!iso) return '';
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'waiting under a minute' : m < 60 ? `waiting ${Math.round(m)} min` : m < 1440 ? `waiting ${Math.round(m / 60)} h` : `waiting ${Math.round(m / 1440)} d`;
};
const mins = (n) => (n == null ? '' : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60} min`);
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const ticketByKey = (k) => S.tickets.find((x) => x.key === k);
const tname = (k) => nameOf(ticketByKey(k) || { title: k });
const named = (text) => linkKeys(text, ticketByKey).map((p) => (typeof p === 'string' ? p
  : h('button', { class: 'kchip', type: 'button', title: p.key, onclick: (e) => { e.stopPropagation(); openTicket(p.key); } }, p.name)));
const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clean = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '');

const PX = { sm: 24, md: 32, lg: 44, xl: 64 };
function avatar(agentId, size = 'sm') {
  const a = agentMap()[agentId];
  if (!a) return h('span', { class: `av ${size}`, title: agentId === 'owner' ? 'You' : agentId || 'Desk' }, agentId === 'owner' ? 'You' : '·');
  const pr = presenceOf(a);
  return h('span', { class: `pav ${size} ${pr.key}`, title: `${a.name} · ${a.role} · ${pr.text}` }, portrait(a, { size: PX[size] || 24, presence: pr.key }));
}

/** A <details> whose open state survives re-renders (streaming updates must not collapse what you opened). */
function disclose(id, summary, content, { cls = '', open = false } = {}) {
  const d = h('details', { class: `disc ${cls}`, 'data-k': id }, h('summary', {}, summary), h('div', { class: 'disc-b' }, content));
  d.open = S.open[id] ?? open;
  d.addEventListener('toggle', () => { S.open[id] = d.open; });
  return d;
}

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${err ? 'err' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3600);
}

async function api(method, url, body, timeoutMs = 20000) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${res.status}`), { status: res.status, code: j.error });
  return j;
}
const act = (fn, ok) => async (...a) => {
  const button = a[0]?.currentTarget;
  if (button?.disabled) return;
  if (button?.tagName === 'BUTTON') button.disabled = true;
  try { const result = await fn(...a); if (ok && result !== false) toast(typeof ok === 'function' ? ok(result) : ok); } catch (e) { toast(e.message, true); }
  finally { if (button?.tagName === 'BUTTON' && button.isConnected) button.disabled = false; }
};

// ---------------- data sync (same contract as the classic client) ----------------
let es, reconnectTimer, syncing = false, snapshotSeq = 0;
const pendingDeltas = [];
async function loadSnapshot() {
  syncing = true;
  const seq = ++snapshotSeq;
  try {
    const snap = await api('GET', '/api/state');
    if (seq !== snapshotSeq) return;
    Object.assign(S, snap);
    S.loadError = null; S.loaded = true;
    for (const m of pendingDeltas.splice(0)) apply(m);
    render();
  } catch (e) {
    if (seq === snapshotSeq) { S.loadError = e.message; for (const m of pendingDeltas.splice(0)) apply(m); renderTop(); }
    throw e;
  } finally { if (seq === snapshotSeq) syncing = false; }
}
function connect() {
  clearTimeout(reconnectTimer);
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => { S.connected = true; syncing = true; loadSnapshot().then(() => {
    if (S.sheet?.type === 'ticket') return loadDetail(S.sheet);
  }).catch(() => {}); };
  es.onerror = () => {
    S.connected = false; renderTop(); renderSheet();
    // Some failed HTTP responses close EventSource permanently instead of retrying.
    if (es.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connect, 3000);
  };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (syncing) pendingDeltas.push(m); else apply(m);
  };
}
function upsert(list, item, key = 'id') {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i >= 0) list[i] = { ...list[i], ...item }; else list.unshift(item);
}
let raf = 0;
const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
let metaTimer = 0;
const refreshMeta = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => loadSnapshot().catch(() => {}), 800); };

function apply(m) {
  const sh = S.sheet;
  const mine = (k) => sh?.type === 'ticket' && sh.key === k;
  // A detail fetch may be in flight: park live items so the response can be merged with them by id.
  const into = (field, item) => { if (!mine(item.ticket_key)) return; const list = sh.detail ? (sh.detail[field] ||= []) : sh.pending[field]; upsert(list, item); };
  switch (m.type) {
    case 'ticket': upsert(S.tickets, m.data, 'key'); break;
    case 'agent': { const a = S.agents.find((x) => x.id === m.data.id); if (a) Object.assign(a, m.data); break; }
    case 'run': upsert(S.runs, m.data); if (m.data.status !== 'running') refreshMeta(); break;
    case 'settings': { const teamChanged=S.settings.team!==m.data.team; S.settings = m.data; if(teamChanged)refreshMeta(); break; }
    case 'incident': upsert(S.incidents, m.data); break;
    case 'quota': refreshMeta(); break;
    case 'discussion': into('discussions', m.data); refreshMeta(); break;
    case 'branch-refresh': if (mine(m.data.ticket_key) && sh.detail) sh.detail.refresh = m.data; break;
    case 'product-review': if (mine(m.data.ticket_key) && sh.detail) upsert(sh.detail.product_reviews ||= [], m.data, 'phase'); refreshMeta(); break;
    case 'research-review': if (mine(m.data.ticket_key) && sh.detail) upsert(sh.detail.research_reviews ||= [], m.data); refreshMeta(); break;
    case 'connector': refreshMeta(); if (sh?.type === 'research') reloadResearch(sh).catch(() => {}); break;
    case 'council': delete S.councils[m.data.id]; refreshMeta(); break;
    case 'event':
      if (!S.events.some((e) => e.id === m.data.id)) S.events.push(m.data);
      if (S.events.length > 600) S.events.splice(0, S.events.length - 600);
      into('events', m.data);
      if (sh?.type === 'seat' && sh.id === m.data.agent_id) sh.events?.push(m.data);
      break;
    case 'comment':
      into('comments', m.data);
      if (String(m.data.body || '').startsWith('❓')) delete S.questions[m.data.ticket_key];
      break;
    default: break;
  }
  schedule();
}

// Questions on Inbox cards come from the ❓ comment, fetched once per ticket version.
const questionText = (body) => String(body || '').replace(/^❓\s*(\*\*Question for the owner:\*\*)?\s*/, '').trim();
function questionFor(t) {
  const q = S.questions[t.key];
  if (q && q.at === t.updated_at) return q.text;
  if (!q?.loading) {
    S.questions[t.key] = { ...(q || {}), loading: true };
    api('GET', `/api/tickets/${t.key}`).then((d) => {
      const c = d.comments.filter((x) => String(x.body).startsWith('❓')).at(-1);
      S.questions[t.key] = { at: t.updated_at, text: c ? questionText(c.body) : null };
      schedule();
    }).catch(() => { S.questions[t.key] = { at: t.updated_at, text: null }; });
  }
  return q?.text ?? null;
}

// Linked PR facts (CI, conflicts) for merge rows and ticket sheets; the console itself lives in prs.js.
function loadPrs(force = false) {
  if (S.prsLoading || (!force && S.prs && Date.now() - S.prsAt < 60_000)) return;
  S.prsLoading = true;
  api('GET', '/api/prs').then((r) => { S.prs = r; }).catch((e) => { S.prs = { prs: [], error: e.message }; })
    .finally(() => { S.prsAt = Date.now(); S.prsLoading = false; schedule(); });
}
const prFor = (t) => S.prs?.prs?.find((p) => p.number === prNumber(t?.pr_url)) || null;
function ciChip(t) {
  const pr = prFor(t);
  if (!pr) return chip(S.prsLoading ? 'CI loading' : 'CI unknown');
  const tone = { passing: 'green', failing: 'red', pending: 'amber' }[pr.checks] || '';
  return [chip(`CI ${pr.checks === 'none' ? 'not run' : pr.checks}`, tone), pr.mergeable === 'CONFLICTING' ? chip('Conflicts', 'red') : null];
}

// Council reports for inline council decisions.
function councilFor(id) {
  const c = S.councils[id];
  if (c && !c.loading) return c;
  if (!c) {
    S.councils[id] = { loading: true };
    api('GET', `/api/councils/${id}`).then((x) => { S.councils[id] = x; schedule(); }).catch((e) => { S.councils[id] = { error: e.message }; schedule(); });
  }
  return null;
}

// PR reviews (two-reviewer state from the review branch). Tolerates absence and shape drift.
const prReviewsOf = (t, d) => d?.pr_reviews || d?.ticket?.pr_reviews || t?.pr_reviews || null;
const VERDICT = (v) => (/approv|pass|lgtm/i.test(v || '') ? ['✓', 'approved', 'green'] : /chang|fail|reject|request|block/i.test(v || '') ? ['✎', 'changes requested', 'amber'] : ['…', 'pending', '']);
function reviewsView(raw, { compact = false } = {}) {
  let rv = raw;
  if (typeof rv === 'string') { try { rv = JSON.parse(rv); } catch { return null; } }
  if (!rv || typeof rv !== 'object') return null;
  const list = Array.isArray(rv) ? rv : Array.isArray(rv.reviewers) ? rv.reviewers : Array.isArray(rv.reviews) ? rv.reviews : [];
  if (!list.length) return null;
  const round = rv.round ?? (Math.max(0, ...list.map((x) => Number(x.round) || 0)) || null);
  const findingsOf = (x) => (Array.isArray(x.findings) ? x.findings : []);
  const findings = list.reduce((n, x) => n + (Array.isArray(x.findings) ? x.findings.length : Number(x.findings) || 0), 0);
  const auto = rv.auto_merge?.status || rv.auto_merge_status || (typeof rv.auto_merge === 'string' ? rv.auto_merge : null);
  const who = (x) => agentMap()[x.seat]?.name || x.name || x.seat || 'Reviewer';
  const people = list.map((x) => {
    const [g, word, tone] = VERDICT(x.verdict || x.state || x.status);
    const label = `${who(x)}${x.role ? `, ${x.role}` : ''}${x.context ? ` (${x.context})` : ''}: ${word}${x.sha ? ` at ${String(x.sha).slice(0, 8)}` : ''}`;
    return h('span', { class: `rv ${tone}`, title: label, 'aria-label': label }, agentMap()[x.seat] ? avatar(x.seat) : h('span', { class: 'av' }, who(x)[0]),
      h('span', { class: 'rv-g', 'aria-hidden': 'true' }, g), compact ? null : h('span', {}, `${who(x)} · ${word}`));
  });
  const facts = [round ? `round ${round}` : null, findings ? `${findings} finding${findings === 1 ? '' : 's'}` : null, auto ? `auto-merge ${auto}` : null].filter(Boolean).join(' · ');
  if (compact) return h('span', { class: 'reviews compact' }, people, facts ? h('span', { class: 'muted small' }, facts) : null);
  const all = list.flatMap((x) => findingsOf(x).map((f) => ({ f, by: who(x) })));
  return h('section', { class: 'reviews-block', 'aria-label': 'Reviews' }, h('h3', {}, 'Reviews'), h('div', { class: 'reviews' }, people),
    facts ? h('p', { class: 'muted small' }, facts) : null,
    all.length ? disclose('review-findings', `Findings · ${all.length}`, h('ul', { class: 'findings' }, all.map(({ f, by }) => {
      const text = typeof f === 'string' ? f : f.text || f.title || f.body || f.issue || JSON.stringify(f);
      const resp = typeof f === 'object' ? f.response || f.responses?.map?.((r) => r.text || r.body || r).join(' · ') : null;
      return h('li', {}, h('p', {}, `${f.severity ? `${f.severity} · ` : ''}${clean(text)}`), h('p', { class: 'muted small' }, `from ${by}${resp ? ` · response: ${clean(resp)}` : ''}`));
    }))) : null);
}

// ---------------- header ----------------
function renderTop() {
  $('project').textContent = S.meta.project || '';
  const c = B.counts;
  const spend = Number(S.meta.spend_today) || 0;
  const limit = Number(S.settings.daily_budget_usd) || 0;
  const desk = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting' } : deskStatus(S);
  const inst = (cls, label, value, onclick, title) => h('button', { class: `inst ${cls}`, type: 'button', onclick, title, 'aria-label': title }, h('span', { class: 'inst-v' }, value), h('span', { class: 'inst-l' }, label));
  $('instruments').replaceChildren(
    inst(c.needs_you ? 'amber' : '', 'Needs you', String(c.needs_you), () => goInbox('sec-needs'), `${c.needs_you} decision${c.needs_you === 1 ? '' : 's'} waiting for you`),
    inst(c.blocked ? 'red' : '', 'Blocked', String(c.blocked), () => goInbox('sec-blocked'), `${c.blocked} blocked`),
    inst(`money ${limit && spend / limit > 0.9 ? 'amber' : ''}`, limit ? h('span', {}, `of $${limit.toFixed(0)}`, h('span', { class: 'wide-only' }, ' today')) : 'spent today', h('span', { class: 'mono' }, money(spend)), openMoney, `${money(spend)} spent of a ${money(limit)} daily limit. Open spend and provider quota`),
    inst(`desk tone-${desk.tone}`, 'Desk', h('span', {}, h('i', { class: 'dot', 'aria-hidden': 'true' }), desk.label), openDesk, `Desk ${desk.label}: ${desk.detail}`),
  );
  const n = $('tab-inbox-n');
  n.hidden = !c.needs_you;
  n.textContent = String(c.needs_you);
  const held = (S.meta.providers || []).filter((p) => p.available && !p.ready);
  const msg = S.loadError ? `Can't load the desk: ${S.loadError}` : !S.connected && S.loaded ? 'Reconnecting. Updates resume automatically.'
    : S.meta.preview ? 'Local preview — execution is disabled here.'
      : held.length ? held.map((p) => `${p.label}: ${p.reason || 'on hold'}`).join(' · ') : '';
  $('banner').hidden = !msg;
  $('banner').textContent = msg;
  $('banner').className = `banner ${S.loadError || (!S.connected && S.loaded) ? 'bad' : ''}`;
}
function goInbox(anchor) {
  setView('inbox');
  requestAnimationFrame(() => {
    const el = anchor ? $(anchor) : null;
    if (el) el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); // scroll-margin clears the sticky header
    else window.scrollTo(0, 0);
  });
}
function setView(v) {
  if (S.view !== v) window.scrollTo(0, 0);
  S.view = v; localStorage.setItem('sd2.view', v); render();
}

// ---------------- shared pieces ----------------
const chip = (text, tone = '') => h('span', { class: `chip ${tone}` }, text);
const keyTag = (k) => h('span', { class: 'key mono' }, k);
const BUCKET_TONE = { needs_you: 'amber', blocked: 'red', shipped: 'green' };

function nowLine(card, { compact = false } = {}) {
  if (!card) return null;
  const out = [];
  const text = compact && card.now && card.now.text.length > 110 ? `${card.now.text.slice(0, 109)}…` : card.now?.text;
  if (card.now) out.push(h('p', { class: `now ${card.now.error ? 'err' : ''}`, title: card.now.text }, card.now.error ? h('span', { class: 'now-l' }, 'Failed: ') : null, named(text)));
  if (card.issue) out.push(h('p', { class: 'issue' }, h('span', { class: 'issue-l' }, 'Last check: '), card.issue.text));
  if (card.stale) out.push(h('p', { class: `stale ${card.stale.severe ? 'severe' : ''}` }, `No update for ${card.stale.minutes} min`));
  if (compact) {
    if (card.live && card.run?.model) {
      const [provider, ...model] = card.run.model.split(':');
      out.push(h('p', { class: 'facts' }, `Running on ${{ codex: 'Codex', claude: 'Claude', perplexity: 'Perplexity' }[provider] || provider}${model.length ? ` · ${model.join(':')}` : ''}`));
    }
    const bits = [card.plan ? `Plan ${card.plan.done} of ${card.plan.total}` : null, card.elapsedMin != null && card.live ? `${mins(card.elapsedMin)} elapsed` : null,
      card.cost ? (card.cost.running ? `${money(card.cost.reserve)} cap reserved` : card.cost.label) : null].filter(Boolean);
    if (bits.length) out.push(h('p', { class: 'facts mono' }, bits.join(' · ')));
  }
  return out;
}

function evidenceList(ev) {
  if (!ev?.length) return h('p', { class: 'muted' }, 'No evidence posted yet.');
  const src = { verified: 'Verified', claimed: 'Engineer says', pending: 'Pending', earlier: 'Earlier commit' };
  return h('ul', { class: 'evidence' }, ev.map((e) => {
    const href = e.url ? prsUi.safeGithubUrl(e.url) : null;
    return h('li', { class: `ev-${e.tone}` },
      h('span', { class: 'ev-l' }, href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, e.label) : e.label, e.detail ? h('span', { class: 'ev-d' }, ` ${e.kind === 'files' ? '· ' : ''}${e.detail}`) : null),
      h('span', { class: `ev-s ${e.source}` }, src[e.source] || e.source));
  }));
}

function cardFor(t, comments) {
  const sh = S.sheet;
  const events = sh?.type === 'ticket' && sh.key === t.key && sh.detail ? mergeEvents(S.events, sh.detail.events) : S.events;
  return runCard({ ticket: t, events, runs: S.runs, agents: S.agents, comments: comments || [] });
}
const mergeEvents = (a, b) => { const m = new Map(); for (const e of [...b, ...a]) m.set(e.id, e); return [...m.values()].sort((x, y) => x.id - y.id); };

// ---------------- Inbox ----------------
// Merge decisions are compact rows (title, who, CI, reviews, age, Review); everything else is a full card.
function mergeRow(it) {
  const t = it.ticket;
  const fresh = S.painted && !S.seen.has(it.id) && !reduced();
  return h('article', { class: `mrow ${fresh ? 'enter' : ''}`, 'data-key': it.id },
    h('div', { class: 'mrow-main' },
      h('button', { class: 'title-btn', type: 'button', onclick: () => openTicket(t.key, { decision: it.id }) }, it.name),
      h('div', { class: 'mrow-meta' }, t.assignee ? h('span', { class: 'who small' }, avatar(t.assignee), firstName(t.assignee)) : null,
        ciChip(t), reviewsView(prReviewsOf(t), { compact: true }), h('span', { class: 'muted small' }, ago(t.updated_at)))),
    h('button', { class: 'btn primary', type: 'button', 'aria-label': `Review merge of ${it.name}`, onclick: decisionAction(it) }, 'Review'));
}

function decisionCard(it) {
  const t = it.ticket;
  const fresh = S.painted && !S.seen.has(it.id) && !reduced();
  let reason = it.reason;
  if (it.kind === 'question' && t) reason = questionFor(t) || it.reason;
  const open = () => openTicket(t.key, { decision: it.id });
  const primary = h('button', { class: 'btn primary', type: 'button', onclick: decisionAction(it) }, it.action);
  return h('article', { class: `dcard kind-${it.kind} ${fresh ? 'enter' : ''}`, 'data-key': it.id },
    h('div', { class: 'dcard-top' }, chip(KIND_LABEL[it.kind] || 'Needs you', 'amber'), it.proposal_id ? chip(`Proposal #${it.proposal_id}`) : null,
      it.council_id ? chip(`Council #${it.council_id}`) : null, t ? keyTag(t.key) : null, h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, waited(t?.updated_at || it.incident?.last_seen))),
    h('h3', {}, t ? h('button', { class: 'title-btn', type: 'button', onclick: open }, it.verb) : it.verb),
    clamp(`reason-${it.id}`, clean(reason), 300),
    h('div', { class: 'dcard-f' }, t?.assignee ? h('span', { class: 'who' }, avatar(t.assignee), agentMap()[t.assignee]?.name || '') : null,
      h('span', { class: 'spacer' }), t ? h('button', { class: 'btn ghost', type: 'button', 'aria-label': `Details for ${it.verb}`, onclick: open }, 'Details') : null, primary));
}

/** Long text: the first ~N characters, then "Show all" (expanded state survives re-renders). */
function clamp(id, text, n) {
  if (text.length <= n + 40) return h('p', { class: 'reason' }, named(text));
  const cut = text.slice(0, n).replace(/\s+\S*$/, '');
  return disclose(id, h('span', { class: 'reason' }, named(`${cut}…`), h('span', { class: 'more' }, ' Show all')), h('p', { class: 'reason' }, named(text)), { cls: 'long' });
}

/** What the one primary button on a decision does. Publishing confirms first; merges open the PR console. */
function decisionAction(it) {
  const t = it.ticket;
  switch (it.kind) {
    case 'question': return () => openTicket(t.key, { decision: it.id, focus: true });
    case 'design': case 'council': return () => openTicket(t.key, { decision: it.id });
    case 'merge': return () => { const n = prNumber(t.pr_url); if (n) prsUi.openActions(prsCtx(), n); else openTicket(t.key, { decision: it.id }); };
    case 'page': return openDesk;
    case 'guard': case 'publish': return act(async () => {
      const msg = it.kind === 'guard'
        ? `Lift the publish guard on ${it.name}?\n\nThe change touches protected paths or is unusually large. Approving pushes the branch and opens a draft PR. You still merge.`
        : `Publish ${it.name}?\n\nApproving pushes the branch and opens a draft PR. Nothing merges until you merge it.`;
      if (!confirm(msg)) return false;
      await api('POST', `/api/tickets/${t.key}/decision`, { decision: 'approve', message: '', expected_updated_at: t.updated_at });
    }, it.kind === 'guard' ? 'Guard lifted — pushing the branch and opening a draft PR' : 'Approved — opening a draft PR');
    default: return () => openTicket(t.key);
  }
}

function blockedCard(it) {
  const t = it.ticket;
  return h('article', { class: 'bcard', 'data-key': it.id },
    h('div', { class: 'dcard-top' }, chip('Blocked', 'red'), t ? keyTag(t.key) : null, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, ago(t?.updated_at))),
    h('h3', {}, h('button', { class: 'title-btn', type: 'button', onclick: () => openTicket(t.key) }, it.verb)),
    h('p', { class: 'reason' }, named(humanReason(clean(it.reason), S.tickets))));
}

function workingCard(it) {
  const t = it.ticket;
  const card = cardFor(t);
  const w = it.worker || card?.worker;
  return h('button', { class: 'wcard', type: 'button', 'data-key': it.id, onclick: () => openTicket(t.key) },
    h('div', { class: 'wcard-h' }, w ? avatar(w, 'md') : null,
      h('div', { class: 'wcard-t' }, h('b', {}, it.name), h('span', { class: 'muted small' }, w ? `${agentMap()[w]?.name || ''} · ${it.stage || 'Working'}` : it.stage || '')),
      it.stage ? chip(it.stage) : null),
    nowLine(card, { compact: true }));
}

function renderInbox() {
  const c = B.counts;
  if (B.needs_you.some((x) => x.kind === 'merge')) loadPrs();
  const shortcut = (id, label, n, tone) => h('button', { class: `jump ${n ? tone : ''}`, type: 'button', onclick: () => goInbox(id), 'aria-label': `Jump to ${label}: ${n}` }, label, h('b', {}, n));
  const groups = [];
  for (const it of B.needs_you) {
    if (it.kind === 'merge') { const last = groups.at(-1); if (last?.merge) last.items.push(it); else groups.push({ merge: true, items: [it] }); }
    else groups.push({ merge: false, items: [it] });
  }
  return [
    h('nav', { class: 'jumps', 'aria-label': 'Inbox sections' }, shortcut('sec-needs', 'Needs you', c.needs_you, 'amber'), shortcut('sec-blocked', 'Blocked', c.blocked, 'red'), shortcut('sec-working', 'Working', c.working, '')),
    h('section', { class: 'sec', id: 'sec-needs', 'aria-labelledby': 'h-needs' },
      h('h2', { id: 'h-needs' }, 'Needs you', c.needs_you ? h('span', { class: 'count amber' }, c.needs_you) : null),
      c.needs_you ? h('div', { class: 'stack' }, groups.map((g) => (g.merge ? h('div', { class: 'mrows' }, g.items.map(mergeRow)) : decisionCard(g.items[0]))))
        : h('div', { class: 'empty-state' }, h('p', { class: 'big' }, 'Nothing needs you.'), h('p', { class: 'muted' }, `${c.working} working, ${c.queued} queued.`))),
    h('section', { class: 'sec', id: 'sec-blocked', 'aria-labelledby': 'h-blocked' }, h('h2', { id: 'h-blocked' }, 'Blocked', h('span', { class: `count ${c.blocked ? 'red' : ''}` }, c.blocked)),
      c.blocked ? h('div', { class: 'stack' }, B.blocked.map(blockedCard)) : h('p', { class: 'muted pad' }, 'Nothing is blocked.')),
    h('section', { class: 'sec', id: 'sec-working', 'aria-labelledby': 'h-working' }, h('h2', { id: 'h-working' }, 'Working', h('span', { class: 'count' }, c.working)),
      c.working ? h('div', { class: 'grid-cards' }, B.working.map(workingCard)) : h('p', { class: 'muted pad' }, S.settings.paused === 'true' ? 'The desk is halted. Resume it from the Desk instrument.' : 'No seat is running right now.')),
  ];
}

// ---------------- Work ----------------
function matches(it) {
  const f = S.filter, t = it.ticket;
  if (!t) return !f.q && !f.assignee;
  if (f.assignee && t.assignee !== f.assignee) return false;
  const q = f.q.trim().toLowerCase();
  return !q || `${t.key} ${it.name} ${t.title}`.toLowerCase().includes(q);
}

function workCard(it) {
  const t = it.ticket;
  if (!t) return h('article', { class: 'kcard' }, h('div', { class: 'kcard-top' }, chip(KIND_LABEL[it.kind] || 'Needs you', 'amber')), h('b', {}, it.verb), h('p', { class: 'reason small' }, it.reason), h('button', { class: 'btn small', type: 'button', onclick: openDesk }, it.action));
  const card = it.bucket === 'working' ? cardFor(t) : null;
  const kids = it.epic ? S.tickets.filter((k) => k.parent_key === t.key) : [];
  const line = it.bucket === 'needs_you' ? (it.kind === 'question' ? questionFor(t) || it.reason : null) : it.bucket === 'working' && !it.epic ? null : humanReason(it.reason, S.tickets);
  return h('article', { class: `kcard b-${it.bucket}`, 'data-key': it.id },
    h('button', { class: 'kcard-main', type: 'button', onclick: () => openTicket(t.key, it.bucket === 'needs_you' ? { decision: it.id } : {}) },
      h('div', { class: 'kcard-top' }, it.bucket === 'blocked' ? chip('Blocked', 'red') : it.bucket === 'needs_you' ? chip(KIND_LABEL[it.kind] || 'Needs you', 'amber') : null,
        it.bucket === 'epic' ? chip(it.live ? 'Epic · a slice is running' : 'Epic') : it.stage && it.bucket !== 'shipped' ? chip(it.stage) : null, h('span', { class: 'spacer' }), keyTag(t.key)),
      h('b', { class: 'kcard-t' }, it.name),
      line ? h('p', { class: 'reason small' }, line.length > 170 ? `${line.slice(0, 169).replace(/\s+\S*$/, '')}…` : line) : null,
      card ? nowLine(card, { compact: true }) : null,
      h('div', { class: 'kcard-f' }, t.assignee ? h('span', { class: 'who small' }, avatar(it.worker || t.assignee), firstName(it.worker || t.assignee)) : null,
        h('span', { class: 'spacer' }), it.bucket === 'shipped' ? h('span', { class: 'muted small' }, ago(t.updated_at)) : null)),
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => openTicket(t.key) }, it.bucket === 'working' ? 'View live conversation' : 'View conversation'),
    kids.length ? disclose(`epic-${t.key}`, `${kids.length} slice${kids.length === 1 ? '' : 's'}`, h('ul', { class: 'slices' }, kids.map((k) => h('li', {},
      h('button', { class: 'linkish', type: 'button', onclick: () => openTicket(k.key) }, nameOf(k)), chip(STAGE_LABEL[k.status] || k.status, k.status === 'done' ? 'green' : ['needs_human', 'ready_for_human'].includes(k.status) ? 'amber' : ''))))) : null);
}

function renderWork() {
  const f = S.filter;
  const filtering = Boolean(f.q.trim() || f.assignee);
  const eng = S.agents.filter((a) => (S.meta.engineers || []).includes(a.id));
  const lanes = [
    ['wait', 'Waiting on you', B.needs_you, B.counts.needs_you, 'amber'],
    ['working', 'Working', B.working, B.counts.working, ''],
    ['queued', 'Queued', [...B.blocked, ...B.queued], B.counts.blocked + B.counts.queued, ''],
    ['shipped', 'Shipped', B.shipped, B.counts.shipped, 'green'],
  ];
  const toolbar = h('div', { class: 'toolbar' },
    h('h1', { class: 'page-h' }, 'Work'), h('span', { class: 'spacer' }),
    h('button', { class: 'btn', type: 'button', onclick: openPrConsole }, 'Pull requests'),
    h('button', { class: `btn ${filtering ? 'on' : ''}`, type: 'button', 'aria-expanded': String(f.open), 'aria-controls': 'filters', onclick: () => { f.open = !f.open; render(); } }, filtering ? 'Filter · on' : 'Filter'));
  const panel = f.open ? h('div', { class: 'filters', id: 'filters' },
    h('input', { id: 'work-q', type: 'search', placeholder: 'Search by name or key', 'aria-label': 'Search tickets', value: f.q, oninput: (e) => { f.q = e.target.value; render(); } }),
    h('select', { id: 'work-assignee', 'aria-label': 'Assignee', onchange: (e) => { f.assignee = e.target.value; render(); } },
      h('option', { value: '', selected: !f.assignee }, 'Anyone'), eng.map((a) => h('option', { value: a.id, selected: f.assignee === a.id }, a.name))),
    h('label', { class: 'check' }, h('input', { id: 'work-closed', type: 'checkbox', checked: f.closed, onchange: (e) => { f.closed = e.target.checked; render(); } }), `Show closed (${B.counts.closed})`),
    filtering ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { f.q = ''; f.assignee = ''; render(); } }, 'Clear') : null) : null;
  const laneEls = lanes.map(([id, title, items, count, tone]) => {
    let list = items.filter(matches);
    const more = id === 'shipped' && !S.shippedAll && !filtering && list.length > 5 ? list.length - 5 : 0;
    if (more) list = list.slice(0, 5);
    return h('section', { class: `lane lane-${id}`, 'aria-labelledby': `lane-${id}` },
      h('h2', { id: `lane-${id}` }, title, h('span', { class: `count ${count ? tone : ''}` }, filtering ? `${list.length} of ${count}` : count)),
      h('div', { class: 'lane-b' }, list.length ? list.map(workCard) : h('p', { class: 'muted pad' }, filtering ? 'No matches.' : id === 'wait' ? 'Nothing waiting on you.' : id === 'working' ? 'No seat is running.' : id === 'queued' ? 'Queue is empty.' : 'Nothing shipped yet.'),
        more ? h('button', { class: 'btn ghost wide', type: 'button', onclick: () => { S.shippedAll = true; render(); } }, `View all ${count}`) : null,
        id === 'shipped' && S.shippedAll && !filtering && count > 5 ? h('button', { class: 'btn ghost wide', type: 'button', onclick: () => { S.shippedAll = false; render(); } }, 'Show latest 5') : null,
        id === 'shipped' && f.closed ? [h('h3', { class: 'sub-h' }, `Closed (${B.counts.closed})`), B.closed.filter(matches).map(workCard)] : null));
  });
  const epics = B.epics.filter(matches);
  return [toolbar, panel, h('div', { class: 'lanes' }, laneEls),
    // Epics summarize their slices; the slices carry the lane counts, so epics sit apart.
    B.epics.length ? h('section', { class: 'sec epics', 'aria-labelledby': 'h-epics' }, h('h2', { id: 'h-epics' }, 'Epics', h('span', { class: 'count' }, filtering ? `${epics.length} of ${B.epics.length}` : B.epics.length)),
      h('div', { class: 'grid-cards' }, epics.map(workCard))) : null];
}

// ---------------- Team ----------------
function renderTeam() {
  const active = S.agents.filter(a=>a.status==='working');
  return [
    h('div',{class:'toolbar'},h('h1',{class:'page-h'},'Team'),h('span',{class:'spacer'}),
      h('button',{class:'btn',type:'button',onclick:act(async()=>{await api('POST','/api/settings',{key:'auto_fallback',value:S.settings.auto_fallback==='true'?'false':'true'});await loadSnapshot();},'Fallback policy updated')},`Automatic fallback: ${S.settings.auto_fallback==='true'?'on':'off'}`),h('span',{class:'muted'},`${active.length} working`)),
    h('div',{class:'grid-cards'},[...active,...S.agents.filter(a=>a.status!=='working')].map(a=>{
      const route=S.meta.routing?.[a.id] || {}, run=S.runs.find(r=>r.id===a.current_run);
      return h('article',{class:'kcard team-model'},
        h('div',{class:'row'},avatar(a.id,'md'),h('button',{class:'title-btn',type:'button',onclick:()=>openSeat(a.id)},a.name),h('span',{class:'spacer'}),chip(a.enabled===false?'Off':a.status==='working'?'Working':'Available')),
        h('p',{class:'muted small'},a.role),h('p',{class:'small wrap'},`Preferred: ${a.engine} · ${a.model || 'Account default'}`),
        h('p',{class:'small wrap'},run?`Running: ${run.model}`:`Next run: ${route.engine || 'Waiting'} · ${route.model || route.reason || ''}`),
        h('p',{class:'muted small wrap'},`Fallback: ${a.fallbacks===undefined?'automatic compatible provider':a.fallbacks.length?a.fallbacks.map(p=>`${p.engine}/${p.model || 'default'}`).join(' → '):'wait for preferred provider'}`),
        route.fallback?h('p',{class:'muted small'},route.reason):null,
        a.current_ticket?h('button',{class:'btn ghost small',type:'button',onclick:()=>openTicket(a.current_ticket)},'View live conversation'):null,
        h('button',{class:'btn',type:'button',onclick:()=>openModelSettings(a.id)},'Edit models & fallback'));
    })),
  ];
}

// ---------------- sheets ----------------
let returnFocus = null; // { el, key }: restored on close even if a live re-render replaced the element
const BACKGROUND = () => [document.querySelector('.hdr'), $('banner'), $('view'), document.querySelector('.skip')].filter(Boolean);
function closeSheet() {
  S.sheet = null;
  $('sheet').hidden = true;
  $('sheet').replaceChildren();
  document.body.classList.remove('dialog-open');
  for (const el of BACKGROUND()) el.inert = false;
  const rf = returnFocus;
  returnFocus = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  const target = rf?.el?.isConnected ? rf.el : rf?.key ? document.querySelector(`[data-key="${CSS.escape(rf.key)}"] button, button[data-key="${CSS.escape(rf.key)}"]`) : null;
  (target || $('view'))?.focus?.();
}
const closeBtn = () => h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '×');

/**
 * Render a sheet. Streaming updates re-render often, so: keep body scroll, keep disclosure state, and while the owner
 * types in the footer keep the footer itself — unless its action context (`sig`) changed, in which case the footer is
 * rebuilt with the draft and caret restored, so a stale button can never act on a decision that is gone.
 */
function sheetShell(head, body, footer = null, sig = '') {
  const sheet = $('sheet');
  const id = S.sheet ? `${S.sheet.type}:${S.sheet.key || S.sheet.id || S.sheet.number || ''}` : '';
  const old = sheet.firstElementChild;
  const same = old && old.dataset.id === id;
  const prevScroll = same ? old.querySelector('.sheet-b')?.scrollTop : 0;
  const active = document.activeElement;
  const editing = (el) => el && ['TEXTAREA', 'INPUT', 'SELECT'].includes(el.tagName);
  const typingInFooter = same && old.querySelector('.sheet-f')?.contains(active) && editing(active);
  const typingInBody = same && old.querySelector('.sheet-b')?.contains(active) && editing(active);
  // A field mid-edit in the body: ticket/seat/desk sheets wait; the PR console and PR sheet re-render (their drafts are kept).
  if (typingInBody && active.getAttribute('aria-label') !== 'Conversation participant' && !['prs', 'pr', 'models'].includes(S.sheet.type)) return;
  const caret = editing(active) ? { id: active.id, label: active.getAttribute('aria-label'), sel: active.selectionStart } : null;
  const headEl = h('div', { class: 'sheet-h' }, head);
  const bodyEl = h('div', { class: 'sheet-b' }, body);
  if (typingInFooter && old.dataset.sig === sig) {
    old.querySelector('.sheet-h').replaceWith(headEl);
    old.querySelector('.sheet-b').replaceWith(bodyEl);
    bodyEl.scrollTop = prevScroll;
    restoreConversation(bodyEl);
    return;
  }
  const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true', 'data-id': id, 'data-sig': sig }, headEl, bodyEl, footer ? h('div', { class: 'sheet-f' }, footer) : null);
  const firstOpen = sheet.hidden;
  if (firstOpen) returnFocus = { el: active, key: active?.closest?.('[data-key]')?.dataset.key || null };
  sheet.replaceChildren(panel);
  sheet.hidden = false;
  document.body.classList.add('dialog-open');
  for (const el of BACKGROUND()) el.inert = true;
  panel.setAttribute('aria-label', panel.querySelector('h2')?.textContent || 'Details');
  if (same) bodyEl.scrollTop = prevScroll;
  restoreConversation(bodyEl);
  if (same && caret) {
    const n = (caret.id && $(caret.id)) || [...panel.querySelectorAll('input, select, textarea')].find((x) => x.getAttribute('aria-label') === caret.label);
    if (n) { n.focus(); if (caret.sel != null && ['text', 'search', 'textarea'].includes(n.type)) try { n.setSelectionRange(caret.sel, caret.sel); } catch { /* not text */ } return; }
  }
  if (firstOpen || !same) (panel.querySelector('[data-autofocus]') || panel.querySelector('.close'))?.focus();
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
}

function renderSheet() {
  const sh = S.sheet;
  if (!sh) return;
  if (sh.type === 'ticket') return renderTicketSheet();
  if (sh.type === 'models') return renderModelSettings();
  if (sh.type === 'seat') return renderSeatSheet();
  if (sh.type === 'new') return renderNewSheet();
  if (sh.type === 'desk') return renderDeskSheet();
  if (sh.type === 'money') return renderMoneySheet();
  if (sh.type === 'settings') return renderSettingsSheet();
  if (sh.type === 'research') return renderResearchSheet();
  if (sh.type === 'prs') return sheetShell([h('div', { class: 'row' }, h('h2', {}, 'Pull requests'), closeBtn())], prsUi.renderPage(prsCtx()));
  if (sh.type === 'pr') return prsUi.renderSheet(prsCtx());
}
const prsCtx = () => ({ h, api, act, avatar, toast, sheetShell, closeSheet, openTicket, S, nameOf: tname,
  render: () => { if (S.sheet?.type === 'prs') renderSheet(); } });
function openPrConsole() { S.sheet = { type: 'prs' }; renderSheet(); }

// ---- ticket sheet ----
async function openTicket(key, opts = {}) {
  const sh = { type: 'ticket', key, detail: null, conversation: { agent: '', follow: true, top: 0 }, mode: null, compose: false, decisionId: opts.decision || null, focus: !!opts.focus, pending: { comments: [], events: [], discussions: [] } };
  S.sheet = sh;
  history.replaceState(null, '', `#${key}`);
  renderSheet();
  if (ticketByKey(key)?.pr_url) loadPrs();
  await loadDetail(sh);
  if (sh.focus && S.sheet === sh) { $('reply')?.focus(); sh.focus = false; }
}
const byId = (...lists) => { const m = new Map(); for (const l of lists) for (const x of l || []) m.set(x.id, { ...(m.get(x.id) || {}), ...x }); return [...m.values()].sort((a, b) => (a.id > b.id ? 1 : -1)); };
/** Load ticket detail and merge it by id with whatever live updates arrived meanwhile (SSE items are never dropped). */
async function loadDetail(sh) {
  try {
    const d = await api('GET', `/api/tickets/${sh.key}`);
    if (S.sheet !== sh) return;
    const prev = sh.detail || {};
    sh.detail = { ...d, comments: byId(d.comments, prev.comments, sh.pending.comments), events: byId(d.events, prev.events, sh.pending.events),
      discussions: byId(d.discussions, sh.pending.discussions) };
    sh.pending = { comments: [], events: [], discussions: [] };
    renderSheet();
  } catch (e) { if (S.sheet === sh) { sh.error = e.message; renderSheet(); } }
}

function restoreConversation(body) {
  const log = body.querySelector('.conversation-log');
  const state = S.sheet?.conversation;
  if (!log || !state) return;
  log.scrollTop = state.follow ? log.scrollHeight : state.top;
}

function threadView(d, card) {
  const sh = S.sheet, state = sh.conversation;
  const amap = agentMap();
  const items = conversationItems({ ...d, agent: state.agent });
  const all = conversationItems(d);
  const participants = [...new Set(all.map((i) => i.who))];
  const whoName = (id) => amap[id]?.name || ({ owner: 'You', system: 'Desk', github: 'GitHub' }[id]) || id;
  const label = !S.connected ? 'Reconnecting…' : card.live ? 'Live updates' : 'Up to date';
  const follow = h('button', { class: 'btn small', type: 'button', disabled: state.follow, onclick: () => {
    state.follow = true; renderSheet();
  } }, state.follow ? 'Following latest' : 'Jump to latest');
  const log = h('div', { class: 'thread conversation-log', role: 'region', 'aria-label': 'Task conversation', tabindex: '0', onscroll: (e) => {
    if (!e.currentTarget.isConnected) return;
    state.top = e.currentTarget.scrollTop;
    state.follow = nearLatest(e.currentTarget);
    follow.disabled = state.follow;
    follow.textContent = state.follow ? 'Following latest' : 'Jump to latest';
  } }, items.length ? items.map((it) => {
    const mine = it.who === 'owner';
    const ask = String(it.text).startsWith('❓');
    const who = whoName(it.who);
    const run = S.runs.find((r) => r.id === it.runId);
    const meta = [amap[it.who]?.role, run?.model?.replace(':', ' · ')].filter(Boolean).join(' · ');
    if (it.kind === 'technical') return h('div', { class: 'conversation-steps' }, disclose(`steps-${sh.key}-${it.id}`,
      `${who} · ${it.steps.length} execution step${it.steps.length === 1 ? '' : 's'}`,
      h('div', { class: 'log mono' }, it.steps.map((e) => h('div', {}, h('time', { datetime: e.ts }, hhmm(e.ts)), ' ', e.raw)))));
    const text = ask ? questionText(it.text) : clean(it.text);
    const textEl = text.length > 1200 ? disclose(`msg-${it.id}`, h('span', {}, named(`${text.slice(0, 800).trim()}…`), h('span', { class: 'more' }, ' Show all')), h('div', { class: 'msg-t' }, named(text)), { cls: 'long' })
      : h('div', { class: 'msg-t' }, named(text));
    const update = !['comment', 'say'].includes(it.kind);
    return h('article', { class: `msg ${mine ? 'mine' : ''} ${ask ? 'ask' : ''} ${update ? 'update' : ''}`, 'data-message': it.id },
      mine ? null : avatar(it.who, 'md'),
      h('div', { class: 'msg-b' }, h('div', { class: 'msg-h' }, h('b', {}, ask ? `${who} asks you` : who),
        h('time', { class: 'muted small', datetime: it.ts, title: new Date(it.ts).toLocaleString() }, hhmm(it.ts))),
      meta ? h('p', { class: 'muted small msg-meta' }, meta) : null, textEl));
  }) : h('p', { class: 'muted' }, 'No recorded updates yet. Messages will appear here as the team works.'));
  return h('section', { class: 'conversation', 'aria-label': 'Conversation' },
    h('div', { class: 'conversation-h' }, h('h3', {}, 'Conversation'), h('span', { class: 'muted small', role: 'status' }, label), h('span', { class: 'spacer' }), follow),
    h('div', { class: 'conversation-h' }, h('label', { class: 'small' }, 'Show ', h('select', { 'aria-label': 'Conversation participant', onchange: (e) => {
      state.agent = e.target.value; state.follow = true; state.top = 0; renderSheet();
    } }, h('option', { value: '', selected: !state.agent }, 'Everyone'), participants.map((id) => h('option', { value: id, selected: state.agent === id }, whoName(id)))))),
    log, h('p', { class: 'muted small' }, 'Recorded messages and progress updates · latest 600 activity events. Expand execution steps for technical details.'));
}

function runCardView(card, { withEvidence = true } = {}) {
  if (!card) return null;
  const parts = [];
  parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, card.live ? 'Now' : 'Last step'), h('div', { class: 'rc-v' },
    card.now ? nowLine(card) : h('p', { class: 'muted' }, card.live ? 'Starting' : card.result ? 'Not running' : 'Not started'))));
  parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, 'Plan'), h('div', { class: 'rc-v' }, card.plan
    ? [h('p', {}, `${card.plan.done} of ${card.plan.total} milestones`), h('ol', { class: 'plan' }, card.plan.items.map((i) => h('li', { class: `p-${i.state}` }, h('span', { class: 'p-m', 'aria-hidden': 'true' }, i.state === 'done' ? '✓' : i.state === 'now' ? '▸' : '·'), h('span', { class: 'sr' }, i.state === 'done' ? 'Done: ' : i.state === 'now' ? 'In progress: ' : 'Pending: '), i.text)))]
    : h('p', { class: 'muted' }, 'No plan posted'))));
  if (withEvidence) parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, 'Evidence'), h('div', { class: 'rc-v' }, evidenceList(card.evidence))));
  if (card.result) parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, 'Result'), h('div', { class: 'rc-v' },
    card.result.summary ? h('p', {}, named(clean(card.result.summary))) : null, h('p', { class: 'muted small' }, card.result.text), card.result.next ? h('p', {}, h('span', { class: 'muted' }, 'Next: '), card.result.next) : null)));
  if (card.cost) parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, 'Cost'), h('div', { class: 'rc-v' }, h('p', { class: 'mono' }, card.cost.label), card.run ? h('p', { class: 'muted small' }, `${card.run.kind} run on ${card.run.model}${card.elapsedMin != null ? ` · ${mins(card.elapsedMin)}` : ''}`) : null)));
  if (card.says.length) parts.push(h('div', { class: 'rc-row' }, h('span', { class: 'rc-k' }, 'Notes'), h('div', { class: 'rc-v' },
    card.sayCount > 2 ? disclose(`says-${card.key}`, `Earlier updates · ${card.sayCount - 2}`, card.allSays.slice(0, -2).map((s) => h('p', { class: 'say' }, named(clean(s.text))))) : null,
    card.says.map((s) => h('p', { class: 'say' }, named(clean(s.text)))))));
  if (card.toolCount) parts.push(disclose(`tools-${card.key}`, `Execution details · ${card.toolCount} step${card.toolCount > 1 ? 's' : ''}`, h('div', { class: 'log mono' }, card.tools.map((e) => h('div', {}, h('span', { class: 't' }, hhmm(e.ts)), ' ', e.text)))));
  return h('section', { class: 'runcard', 'aria-label': 'Run card' }, h('h3', {}, card.live ? 'Current run' : 'Last run'), parts);
}

/** "a/b/c/file.py" → "file.py"; first two sentences; enough to decide, not a wall of paths. */
function outcome(text, max = 260) {
  const t = clean(text).replace(/[\w.-]+(?:\/[\w.-]+){2,}/g, (p) => p.split('/').pop()).replace(/\s+/g, ' ').trim();
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
  const two = sentences.slice(0, 2).join('').trim();
  return two.length > max ? `${two.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : two;
}

function councilView(c) {
  if (!c) return h('p', { class: 'muted' }, 'Loading the council report…');
  if (c.error) return h('p', { class: 'red-t' }, `Couldn't load the council: ${c.error}`);
  let r = null;
  try { r = JSON.parse(c.result || 'null'); } catch { r = null; }
  return h('div', { class: 'council' },
    c.stale ? h('p', { class: 'red-t' }, 'Ticket evidence changed since this council ran. Start a fresh council in Classic view before deciding.') : null,
    r ? [h('p', {}, chip(`Verdict: ${r.verdict}`, r.verdict === 'approve' ? 'green' : 'amber'), ' ', named(clean(r.recommendation))),
      r.dissent?.length ? h('div', {}, h('p', { class: 'muted small' }, 'Dissent'), h('ul', {}, r.dissent.map((x) => h('li', {}, clean(x))))) : h('p', { class: 'muted small' }, 'No dissent recorded.'),
      r.conditions?.length ? h('div', {}, h('p', { class: 'muted small' }, 'Required validation'), h('ul', {}, r.conditions.map((x) => h('li', {}, clean(x))))) : null,
      r.findings?.length ? disclose(`council-f-${c.id}`, `Findings · ${r.findings.length}`, h('ul', { class: 'findings' }, r.findings.map((f) => h('li', {}, h('p', {}, `${f.severity} · ${clean(f.issue)}`), h('p', { class: 'muted small' }, clean(f.evidence)))))) : null]
      : c.result ? h('p', { class: 'prose' }, clean(c.result)) : h('p', { class: 'muted' }, `Council ${c.status}.`));
}

function briefView(dec, t, d, card) {
  const comments = d?.comments || [];
  const submit = [...comments].reverse().find((c) => /^🚀/.test(c.body) || /^Implementation note/i.test(c.body));
  const proposal = dec.kind === 'design' ? (d?.discussions || []).find((x) => x.id === dec.proposal_id) : null;
  const q = dec.kind === 'question' ? comments.filter((c) => String(c.body).startsWith('❓')).at(-1) : null;
  const strip = (x) => String(x).replace(new RegExp(`^\\s*${t.key}[a-z]?\\s*[:—-]\\s*`), '');
  const changed = dec.kind === 'question' ? outcome(card?.result?.summary || 'The engineer stopped to ask before going further.')
    : dec.kind === 'design' ? 'The manager finished a design recommendation for this ticket.'
      : dec.kind === 'research' ? 'The independent second reviewer did not pass this research proposal; the author\'s revision allowance is used up or the reviewer rejected it.'
      : dec.kind === 'council' ? 'The architecture council finished its review.'
        : outcome(strip(submit ? submit.body.split('\n').slice(1).join(' ').trim() || submit.body : card?.result?.summary || t.progress_msg || 'No change summary posted.'));
  const pr = prFor(t);
  const risk = {
    merge: [pr ? `CI ${pr.checks}${pr.mergeable === 'CONFLICTING' ? ' · conflicts with the base branch' : ''}.` : 'CI status not loaded yet.', 'Merging deploys production.'],
    publish: ['Approving pushes the branch and opens a draft PR. Nothing merges until you merge it.'],
    guard: ['The change touches protected paths or is unusually large. Approving pushes it and opens a draft PR.'],
    question: [`${firstName(t.assignee)} is paused until you answer.`],
    design: ['Approving records the design. Implementation, QA and merge keep their own gates.'],
    council: ['A council verdict records a design decision; implementation, QA and merge keep their own gates.'],
    research: ['Approving waives the second review (recorded as your verdict) and lets the manager groom it. Send back gives the author one more revision with your notes. Reject closes the proposal.'],
  }[dec.kind] || [];
  const row = (k, ...v) => h('div', { class: 'brief-row' }, h('span', { class: 'rc-k' }, k), h('div', { class: 'rc-v' }, v));
  return h('section', { class: 'brief', id: 'brief', 'aria-label': 'Decision brief' },
    h('h3', {}, 'Decision brief'),
    row('Your decision', h('p', { class: 'strong' }, dec.verb), q ? h('p', { class: 'question' }, named(clean(questionText(q.body)))) : null,
      dec.kind === 'design' ? (proposal ? disclose(`proposal-${proposal.id}`, `Recommendation #${proposal.id}`, h('div', { class: 'prose' }, named(clean(proposal.response))), { open: true })
        : h('p', { class: 'muted' }, `Loading recommendation #${dec.proposal_id}…`)) : null,
      dec.kind === 'council' ? councilView(councilFor(dec.council_id)) : null,
      !q && !['design', 'council'].includes(dec.kind) ? h('p', {}, named(clean(dec.reason))) : null),
    row('Outcome', h('p', {}, named(changed))),
    ['design', 'council'].includes(dec.kind) ? null : row('Evidence', evidenceList(card?.evidence)),
    row('Remaining risk', risk.map((r) => h('p', {}, r))));
}

function prSummary(t, dec) {
  const n = prNumber(t.pr_url);
  const href = prsUi.safeGithubUrl(t.pr_url);
  if (!n) {
    if (dec?.kind !== 'guard' && dec?.kind !== 'publish') return null;
    const files = (cardFor(t)?.evidence || []).find((e) => e.kind === 'files');
    return h('section', { class: 'prsum', 'aria-label': 'Change' }, h('h3', {}, 'Change'),
      h('p', {}, 'No PR yet, so the desk cannot show the diff. ', t.branch ? ['Branch ', h('span', { class: 'mono wrap' }, t.branch), '.'] : null),
      files ? h('p', { class: 'muted small' }, `Engineer lists ${files.files.length} file${files.files.length === 1 ? '' : 's'}: ${files.files.map((f) => f.split('/').pop()).join(', ')}`) : null);
  }
  const pr = prFor(t);
  const r = S.sheet?.detail?.refresh;
  const refreshable = t.head_sha && ['needs_human', 'ready_for_human', 'todo'].includes(t.status) && (!r || ['rebased', 'published'].includes(r.status));
  return h('section', { class: 'prsum', 'aria-label': 'Pull request' },
    h('h3', {}, `Pull request #${n}`),
    pr ? h('p', {}, ciChip(t), ` +${pr.additions} −${pr.deletions} in ${pr.files} files`)
      : h('p', { class: 'muted' }, S.prsLoading ? 'Loading CI status from GitHub…' : S.prs?.error ? `GitHub status unavailable: ${S.prs.error}` : 'CI status not loaded.'),
    h('p', { class: 'muted small' }, `Merging into ${S.prs?.base || 'main'} deploys production.`),
    r ? h('p', { class: 'muted small', role: 'status' }, `Branch refresh: ${r.status === 'conflicts' ? 'engineer resolving conflicts' : r.status === 'rebased' ? 'rebased — fresh validation in progress' : r.status === 'published' ? 'published after fresh QA' : 'preparing'} · base ${r.base?.slice(0, 10) || 'pending'}`) : null,
    h('div', { class: 'row-actions' }, dec?.kind === 'merge' ? null : h('button', { class: 'btn', type: 'button', onclick: () => prsUi.openActions(prsCtx(), n) }, 'PR actions'),
      refreshable ? h('button', { class: 'btn', type: 'button', disabled: !!t.active_run, onclick: act(async () => {
        const sh = S.sheet;
        await api('POST', `/api/tickets/${t.key}/refresh-base`, { expected_updated_at: sh.version }, 300000);
        await loadSnapshot(); if (S.sheet === sh) loadDetail(sh);
      }, 'Branch refreshed — engineer and fresh QA queued') }, 'Refresh branch & resume') : null,
      href ? h('a', { class: 'btn ghost', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub') : null));
}

function moreView(t, d) {
  const amap = agentMap();
  const sel = (label, field, options, value, ok) => h('label', { class: 'kv-row' }, h('span', {}, label), h('select', { 'aria-label': label, onchange: act((e) => api('PATCH', `/api/tickets/${t.key}`, { [field]: e.target.value }), ok) },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
  const worker = S.agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const run = worker ? S.runs.find((r) => r.id === worker.current_run) : null;
  const kids = S.tickets.filter((x) => x.parent_key === t.key);
  return disclose(`more-${t.key}`, 'More', [
    h('div', { class: 'prose desc' }, t.description || 'No description provided.'),
    h('div', { class: 'kv' },
      // Done is never a manual stage: a merge ships a ticket.
      sel('Stage', 'status', Object.entries(STAGE_LABEL).filter(([k]) => k !== 'done' || t.status === 'done'), t.status, 'Stage changed'),
      sel('Assignee', 'assignee', [['', 'Auto (by size)'], ...(S.meta.engineers || []).map((id) => [id, `${amap[id]?.name} · ${amap[id]?.role}`])], t.assignee || '', 'Reassigned'),
      sel('Priority', 'priority', ['P0', 'P1', 'P2', 'P3'].map((p) => [p, p]), t.priority, 'Priority saved'),
      h('div', { class: 'kv-row' }, h('span', {}, 'Area · size'), `${t.area || '—'} · ${t.complexity || '—'}`),
      h('div', { class: 'kv-row' }, h('span', {}, 'Branch'), h('span', { class: 'mono wrap' }, t.branch || '—')),
      h('div', { class: 'kv-row' }, h('span', {}, 'Requested by'), amap[t.reporter]?.name || (t.reporter === 'owner' ? 'You' : t.reporter) || '—'),
      t.parent_key ? h('div', { class: 'kv-row' }, h('span', {}, 'Part of'), h('button', { class: 'linkish', type: 'button', onclick: () => openTicket(t.parent_key) }, tname(t.parent_key))) : null,
      t.issue_number && S.meta.repo ? h('div', { class: 'kv-row' }, h('span', {}, 'GitHub issue'), h('a', { href: `https://github.com/${S.meta.repo}/issues/${t.issue_number}`, target: '_blank', rel: 'noopener noreferrer' }, `#${t.issue_number}`)) : null,
      h('div', { class: 'kv-row' }, h('span', {}, 'Review rounds'), String(t.qa_loops || 0))),
    kids.length ? [h('h4', {}, 'Slices'), h('ul', { class: 'slices' }, kids.map((k) => h('li', {}, h('button', { class: 'linkish', type: 'button', onclick: () => openTicket(k.key) }, nameOf(k)), chip(STAGE_LABEL[k.status] || k.status, k.status === 'done' ? 'green' : ''))))] : null,
    (d?.discussions || []).length ? [h('h4', {}, 'Design discussions'), d.discussions.slice(0, 4).map((x) => h('p', { class: 'small' }, `#${x.id} · ${x.status.replaceAll('_', ' ')}${x.error ? ` · ${x.error}` : ''}`))] : null,
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: act(async () => {
        const v = prompt('Short name for this ticket (2–5 words):', nameOf(t));
        if (v == null) return false;
        await api('POST', `/api/tickets/${t.key}/name`, { name: v });
        await loadSnapshot();
      }, 'Renamed') }, 'Rename'),
      h('a', { class: 'btn', href: `/classic.html#${t.key}` }, 'Architecture review & council (Classic)'),
      run ? h('button', { class: 'btn danger', type: 'button', onclick: act(async () => { if (!confirm(`Stop ${worker.name}'s run on ${nameOf(t)}?`)) return false; await api('POST', `/api/runs/${run.id}/kill`, {}); }, 'Stopping the run') }, 'Stop run') : null),
  ]);
}

/** Footer: one primary action named for its effect; Request changes reveals its required note; Reject in overflow.
 *  Handlers read the sheet's state at click time (sh.version = what the owner was shown), never a stale closure. */
function ticketFooter(t, dec, sh) {
  const running = !!t.active_run && !['design', 'council'].includes(dec?.kind);
  const proposal = dec?.kind === 'design' ? (sh.detail?.discussions || []).find((x) => x.id === dec.proposal_id) : null;
  const council = dec?.kind === 'council' ? councilFor(dec.council_id) : null;
  const who = firstName(t.assignee);
  const dk = draftKey(t.key, dec?.id);
  const draft = () => (S.drafts[dk] || '').trim();
  const done = () => { delete S.drafts[dk]; saveDrafts(); sh.mode = null; sh.decisionId = null; sh.compose = false; };
  const decide = (value, okMsg) => act(async () => {
    const msg = draft();
    if (value === 'correction' && !msg) { sh.mode = 'changes'; renderSheet(); $('reply')?.focus(); throw new Error('Describe the changes so the engineer can act on them.'); }
    if (value === 'reject' && !confirm(`Reject ${dec.kind === 'design' ? `design proposal #${dec.proposal_id}` : dec.kind === 'council' ? `council #${dec.council_id}` : nameOf(t)}?\n\n${['design', 'council'].includes(dec.kind) ? 'The ticket stays open; only this recommendation is rejected.' : 'The ticket closes. Local work is kept, so the decision is reversible.'}`)) return false;
    try {
      if (dec.kind === 'council') {
        await api('POST', `/api/councils/${dec.council_id}/decision`, { decision: value, message: msg });
        delete S.councils[dec.council_id];
      } else {
        const r = await api('POST', `/api/tickets/${t.key}/decision`, { decision: value, message: msg, expected_updated_at: sh.version,
          discussion_id: dec.kind === 'design' ? dec.proposal_id : undefined });
        if (value === 'approve' && r?.pr_next) { done(); prsUi.openActions(prsCtx(), r.pr_next, r.already ? { mode: 'already' } : (r.github_approval || {})); return; }
      }
      done();
      await loadSnapshot().catch(() => {});
      if (S.sheet === sh) loadDetail(sh);
    } catch (e) {
      if (e.status === 409) { await loadSnapshot().catch(() => {}); if (S.sheet === sh) loadDetail(sh); }
      throw e;
    }
  }, okMsg);
  const replyBox = (placeholder, label) => {
    const ta = h('textarea', { id: 'reply', rows: '2', 'aria-label': label, placeholder, maxlength: '8000', oninput: (e) => {
      S.drafts[dk] = e.target.value; saveDrafts();
      const b = $('send-changes'); if (b) b.disabled = !e.target.value.trim();
    } });
    ta.value = S.drafts[dk] || '';
    return ta;
  };
  const overflow = (items) => h('details', { class: 'overflow' }, h('summary', { class: 'btn ghost', 'aria-label': 'More actions' }, 'More actions'), h('div', { class: 'menu' }, items));
  const send = (mode, okMsg) => act(async () => {
    const body = draft();
    if (!body) { $('reply')?.focus(); throw new Error(mode === 'answer' ? 'Type your answer first.' : 'Type a message first.'); }
    try {
      const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode, expected_updated_at: mode === 'answer' ? sh.version : undefined });
      done();
      if (S.sheet === sh) { renderSheet(); loadDetail(sh); }
      return r;
    } catch (e) {
      if (e.status === 409) { await loadSnapshot().catch(() => {}); if (S.sheet === sh) loadDetail(sh); }
      throw e;
    }
  }, okMsg);
  if (dec?.kind === 'product') return h('p',{class:'muted small'},'Resolve the objections in Product & design review.');
  const note = running ? h('p', { class: 'muted small' }, 'The worker is finishing; decisions unlock when its run settles.') : null;

  if (dec?.kind === 'question') {
    return [replyBox(`Your answer to ${who}…`, 'Your answer'),
      h('div', { class: 'f-actions' }, overflow([
        h('button', { class: 'menu-i', type: 'button', disabled: running, onclick: decide('approve', `Approved — ${who} resumes`) }, 'Approve as asked (no message)'),
        h('button', { class: 'menu-i danger', type: 'button', disabled: running, onclick: decide('reject', 'Rejected — ticket closed, local work kept') }, 'Reject ticket…')]),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary big', type: 'button', disabled: running, onclick: send('answer', () => `Answer delivered — ${who} resumes`) }, 'Answer and continue')), note];
  }
  if (dec && dec.kind !== 'page') {
    const target = dec.kind === 'design' ? ` #${dec.proposal_id}` : dec.kind === 'council' ? ` #${dec.council_id}` : '';
    const primaryLabel = dec.kind === 'merge' ? 'Review merge' : dec.kind === 'design' ? `Approve design${target}` : dec.kind === 'council' ? `Approve council${target}` : dec.kind === 'research' ? 'Approve for grooming' : 'Approve publication';
    const cantApprove = running || (dec.kind === 'design' && !proposal) || (dec.kind === 'council' && (!council || council.stale || council.status === 'partial'));
    const primary = dec.kind === 'merge'
      ? h('button', { class: 'btn primary big', type: 'button', onclick: () => { const n = prNumber(t.pr_url); if (n) prsUi.openActions(prsCtx(), n); } }, primaryLabel)
      : h('button', { class: 'btn primary big', type: 'button', disabled: cantApprove, onclick: decide('approve',
        dec.kind === 'design' ? `Design #${dec.proposal_id} approved — recorded for planning` : dec.kind === 'council' ? 'Council decision recorded'
          : dec.kind === 'research' ? 'Second review waived — the manager can groom it'
          : dec.kind === 'guard' ? 'Guard lifted — pushing the branch and opening a draft PR' : 'Approved — opening a draft PR') }, primaryLabel);
    const changes = sh.mode === 'changes';
    const blockedAll = running || (dec.kind === 'council' && (!council || council.stale));
    return [changes ? replyBox('What should change? (required)', 'Requested changes') : null,
      h('div', { class: 'f-actions' },
        overflow([h('button', { class: 'menu-i danger', type: 'button', disabled: blockedAll, onclick: decide('reject', ['design', 'council'].includes(dec.kind) ? 'Recommendation rejected' : 'Rejected — ticket closed, local work kept') },
          dec.kind === 'design' ? `Reject design${target}…` : dec.kind === 'council' ? `Reject council${target}…` : dec.kind === 'research' ? 'Reject proposal…' : 'Reject ticket…')]),
        h('span', { class: 'spacer' }),
        changes ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { sh.mode = null; renderSheet(); } }, 'Cancel')
          : h('button', { class: 'btn', type: 'button', disabled: blockedAll, onclick: () => { sh.mode = 'changes'; renderSheet(); requestAnimationFrame(() => $('reply')?.focus()); } }, 'Request changes'),
        changes ? h('button', { id: 'send-changes', class: 'btn primary big', type: 'button', disabled: blockedAll || !draft(), onclick: decide('correction',
          ['design', 'council'].includes(dec.kind) ? 'Corrections sent to the manager' : dec.kind === 'research' ? 'Sent back to the author with your notes' : `Changes requested — ${who} picks it back up`) }, dec.kind === 'research' ? 'Send back' : 'Send changes') : primary), note];
  }
  // No decision: the composer is collapsed behind the header's Message button.
  if (!sh.compose) return null;
  return [replyBox('Message the manager about this ticket…', 'Message'),
    h('div', { class: 'f-actions' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => { sh.compose = false; renderSheet(); } }, 'Cancel'),
      h('button', { class: 'btn ghost', type: 'button', onclick: send('comment', 'Comment saved to the thread') }, 'Comment only'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary big', type: 'button', onclick: send('discussion', 'Sent to the manager — the ticket keeps its place') }, 'Send to manager'))];
}

function renderTicketSheet() {
  const sh = S.sheet;
  const t = ticketByKey(sh.key) || sh.detail?.ticket;
  if (!t) return sheetShell([h('div', { class: 'row' }, h('h2', {}, sh.error || 'Loading ticket…'), closeBtn())], null);
  sh.version = t.updated_at; // what the owner is shown is what a decision applies to
  const it = B.byKey[t.key];
  const decisions = B.needs_you.filter((x) => x.key === t.key);
  // Never silently switch to another decision: if the chosen one is gone, say so.
  let dec = sh.decisionId ? decisions.find((x) => x.id === sh.decisionId) || null : decisions[0] || null;
  const gone = sh.decisionId && !dec;
  if (dec && !sh.decisionId) sh.decisionId = dec.id;
  if (dec?.kind === 'council') councilFor(dec.council_id);
  const d = sh.detail;
  const card = cardFor(t, d?.comments);
  const pick = (x) => () => { sh.decisionId = x.id; sh.mode = null; renderSheet(); };
  const label = (x) => (x.proposal_id ? `Design #${x.proposal_id}` : x.council_id ? `Council #${x.council_id}` : KIND_LABEL[x.kind] || x.kind);
  const head = [
    h('div', { class: 'row' }, dec ? chip(KIND_LABEL[dec.kind] || 'Needs you', 'amber') : it ? chip(BUCKET_LABEL[it.bucket] || (it.bucket === 'epic' ? 'Epic' : it.bucket), BUCKET_TONE[it.bucket] || '') : null,
      it?.stage ? chip(it.stage) : null, keyTag(t.key), h('span', { class: 'spacer' }),
      !dec ? h('button', { class: 'btn small', type: 'button', 'aria-expanded': String(sh.compose), onclick: () => { sh.compose = !sh.compose; renderSheet(); if (sh.compose) requestAnimationFrame(() => $('reply')?.focus()); } }, 'Message') : null,
      closeBtn()),
    h('h2', {}, nameOf(t)),
    nameOf(t) !== t.title ? h('p', { class: 'sub' }, t.title) : null,
    decisions.length > 1 || gone ? h('div', { class: 'dec-tabs', role: 'group', 'aria-label': 'Decisions on this ticket' },
      decisions.map((x) => h('button', { class: 'pill', type: 'button', 'aria-pressed': String(dec?.id === x.id), onclick: pick(x) }, label(x)))) : null,
  ];
  const hist = [
    disclose(`hist-run-${t.key}`, card.live ? 'Current run' : 'Execution history', runCardView(card, { withEvidence: true }), { cls: 'hist' }),

  ];
  const body = dec ? [
    dec.kind === 'product' ? productReviewView(t,d) : briefView(dec, t, d, card),
    prSummary(t, dec),
    reviewsView(prReviewsOf(t, d)),
    d ? threadView(d, card) : h('p', { class: 'muted' }, sh.error || 'Loading conversation…'),
    hist,
    dec.kind === 'product' ? null : productReviewView(t,d),
    researchReviewView(t, d),
    moreView(t, d),
  ] : [
    gone ? h('p', { class: 'status-line blocked' }, 'That decision was resolved or changed while you were reading. Nothing was submitted.') : null,
    it && ['blocked', 'queued', 'epic'].includes(it.bucket) ? h('p', { class: `status-line ${it.bucket}` }, named(humanReason(clean(it.reason), S.tickets))) : null,
    d ? threadView(d, card) : h('p', { class: 'muted' }, sh.error || 'Loading conversation…'),
    disclose(`hist-run-${t.key}`, card.live ? 'Current run details' : 'Execution history', runCardView(card, { withEvidence: true })),
    prSummary(t, null),
    reviewsView(prReviewsOf(t, d)),
    productReviewView(t,d),
    researchReviewView(t, d),
    moreView(t, d),
  ];
  const sig = `${dec?.id || 'none'}|${sh.mode || ''}|${!!t.active_run}|${sh.compose}|${dec?.kind === 'design' ? !!(d?.discussions || []).find((x) => x.id === dec.proposal_id) : ''}|${dec?.kind === 'council' ? `${councilFor(dec.council_id)?.status}${councilFor(dec.council_id)?.stale}` : ''}`;
  sheetShell(head, body, ticketFooter(t, dec, sh), sig);
}

// ---- seat sheet ----
async function openSeat(id) {
  const sh = { type: 'seat', id, events: null };
  S.sheet = sh;
  renderSheet();
  try {
    const r = await api('GET', `/api/agents/${id}`);
    if (S.sheet === sh) { Object.assign(sh, { events: r.events, stats: r.stats }); renderSheet(); }
  } catch (e) { toast(e.message, true); }
}
function renderSeatSheet() {
  const sh = S.sheet;
  const a = agentMap()[sh.id];
  if (!a) return;
  const pr = presenceOf(a);
  const run = a.current_run ? S.runs.find((r) => r.id === a.current_run) : null;
  const route = S.meta.routing?.[a.id] || {};
  const st = sh.stats;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const tile = (label, v) => h('div', { class: 'tile' }, h('span', { class: 'muted small' }, label), h('b', { class: 'mono' }, v));
  const log = sh.events ? h('div', { class: 'log mono seat-log' }, sh.events.slice(-200).map((e) => h('div', { class: `l-${e.kind}` }, h('span', { class: 't' }, hhmm(e.ts)), ' ',
    e.ticket_key ? h('span', { class: 'lk' }, `${tname(e.ticket_key)} `) : null, e.text))) : h('p', { class: 'muted' }, 'Loading…');
  sheetShell([
    h('div', { class: 'row' }, avatar(a.id, 'xl'), h('div', { class: 'seat-who' }, h('h2', {}, a.name), h('span', { class: 'muted' }, a.role), h('span', { class: 'small' }, pr.text)), h('span', { class: 'spacer' }), closeBtn()),
  ], [
    a.current_ticket ? h('button', { class: 'seat-ticket', type: 'button', onclick: () => openTicket(a.current_ticket) }, h('span', {}, tname(a.current_ticket)), keyTag(a.current_ticket)) : null,
    h('p', { class: 'muted small' }, `Runs on ${route.engine || a.engine}${(route.model ?? a.model) ? ` · ${route.model ?? a.model}` : ''}${route.effort || a.effort ? ` · effort ${route.effort || a.effort}` : ''}${route.fallback ? ` · fallback: ${route.reason}` : ''}`),
    run ? h('div', { class: 'row-actions' }, h('span', { class: 'mono small' }, `${run.kind} run · ${money(run.reserve_usd)} reserved`), h('span', { class: 'spacer' }),
      h('button', { class: 'btn danger', type: 'button', onclick: act(async () => { if (!confirm(`Stop ${a.name}'s current run?`)) return false; await api('POST', `/api/runs/${run.id}/kill`, {}); }, 'Stopping the run') }, 'Stop run')) : null,
    st ? h('div', { class: 'tiles' }, tile('Shipped', String(st.shipped)), tile('First-pass QA', pct(st.first_pass_rate)), tile('Runs', String(st.runs)), tile('Spend 7 d', money(st.cost_7d)), tile('Cost per shipped', st.cost_per_shipped == null ? '—' : money(st.cost_per_shipped)), tile('Today', money(a.spend_today))) : null,
    h('button',{class:'btn',type:'button',onclick:()=>openModelSettings(a.id)},'Edit models & fallback'),
    h('h3', {}, 'Recent log'),
    log,
  ]);
  const l = $('sheet').querySelector('.seat-log');
  if (l && !sh.scrolled) { l.scrollTop = l.scrollHeight; sh.scrolled = !!sh.events; }
}

// ---- desk (status, halt/resume, breaker, incidents) ----
function openDesk() { S.sheet = { type: 'desk' }; renderSheet(); }
const INC = { watching: 'Watching', investigating: 'Investigating', ticketed: 'Ticketed', paged: 'Paged you', foreign: 'Other project', muted: 'Muted', resolved: 'Resolved' };
function renderDeskSheet() {
  const ds = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting to the desk' } : deskStatus(S);
  const paused = S.settings.paused === 'true';
  const sc = S.meta.scheduler || {};
  const live = S.incidents.filter((i) => ['paged', 'investigating', 'watching'].includes(i.status));
  const quiet = S.incidents.filter((i) => !['paged', 'investigating', 'watching'].includes(i.status));
  const incBtn = (i, label, action, cls = '') => h('button', { class: `btn small ${cls}`, type: 'button', onclick: act(() => api('POST', `/api/incidents/${i.id}`, { action }), `${label} — done`) }, label);
  const incident = (i) => h('article', { class: `inc s-${i.status}` },
    h('div', { class: 'dcard-top' }, chip(INC[i.status] || i.status, i.status === 'paged' ? 'amber' : i.status === 'investigating' ? '' : ''), h('b', {}, i.label), h('span', { class: 'spacer' }), h('span', { class: 'mono small' }, `${i.count}×`)),
    h('p', { class: 'mono small wrap' }, i.normalized),
    h('p', { class: 'muted small' }, `Last seen ${ago(i.last_seen)}`, i.ticket_key ? [' · ', h('button', { class: 'linkish', type: 'button', onclick: () => openTicket(i.ticket_key) }, tname(i.ticket_key))] : null),
    h('div', { class: 'row-actions' }, i.status === 'watching' ? incBtn(i, 'Investigate now', 'investigate') : null,
      ['watching', 'paged', 'foreign'].includes(i.status) ? incBtn(i, 'Mute', 'mute') : null, i.status === 'muted' ? incBtn(i, 'Unmute', 'unmute') : null));
  sheetShell([h('div', { class: 'row' }, h('h2', {}, 'Desk'), h('span', { class: 'spacer' }), closeBtn())], [
    h('section', { class: `desk-status tone-${ds.tone}` }, h('p', { class: 'big' }, h('i', { class: 'dot', 'aria-hidden': 'true' }), ds.label), h('p', { class: 'muted' }, ds.detail)),
    h('div', { class: 'row-actions' },
      paused ? h('button', { class: 'btn primary', type: 'button', 'data-autofocus': true, onclick: act(async () => {
        try { await api('POST', '/api/control/start', {}); } catch (e) {
          if (e.code === 'confirm_team') { toast('Confirm each seat\'s engine and model in Classic view first.', true); location.href = '/classic.html'; return false; }
          throw e;
        }
      }, 'Desk resumed — seats pick up work') }, 'Resume desk')
        : h('button', { class: 'btn', type: 'button', onclick: act(async () => { if (!confirm('Halt the desk?\n\nRunning work finishes; nothing new starts.')) return false; await api('POST', '/api/control/pause', {}); }, 'Desk halted — running work finishes') }, 'Halt desk'),
      h('button', { class: 'btn danger', type: 'button', onclick: act(async () => { if (!confirm('Circuit breaker: halt the desk and stop every running seat now?')) return false; await api('POST', '/api/control/stop-all', {}); }, 'Breaker tripped — every run stopped') }, 'Trip breaker')),
    h('p', { class: 'muted small' }, 'Halt lets running work finish. The breaker stops every running seat immediately.'),
    h('h3', {}, 'Scheduler'),
    h('div', { class: 'kv' },
      h('div', { class: 'kv-row' }, h('span', {}, 'Last tick'), sc.last_tick ? ago(sc.last_tick) : 'not yet'),
      h('div', { class: 'kv-row' }, h('span', {}, 'Running'), `${S.meta.running || 0} of ${S.meta.capacity ?? '—'} seats${S.meta.busy_window ? ' · market-hours limit' : ''}`),
      h('div', { class: 'kv-row' }, h('span', {}, 'Queued'), String(sc.queued ?? '—')),
      h('div', { class: 'kv-row' }, h('span', {}, 'Budget headroom'), h('span', { class: 'mono' }, money(Math.max(0, sc.budget_headroom || 0)))),
      sc.last_error ? h('div', { class: 'kv-row' }, h('span', {}, 'Last error'), h('span', { class: 'red-t' }, `${sc.last_error.seat || ''} ${sc.last_error.message || sc.last_error}`)) : null),
    h('h3', {}, `Production errors${live.length ? ` · ${live.length} active` : ''}`),
    S.meta.watch?.enabled === false ? h('p', { class: 'muted' }, 'Log watching is off for this desk.') : null,
    (S.meta.watch?.sources || []).filter((s) => !s.ok || s.stale).map((s) => h('p', { class: 'red-t small' }, `${s.type} · ${s.project}: ${s.stale ? 'poll overdue' : s.error}`)),
    live.length ? h('div', { class: 'stack' }, live.map(incident)) : S.meta.watch?.enabled === false ? null : h('p', { class: 'muted' }, 'No active error signatures.'),
    quiet.length ? disclose('quiet-incidents', `${quiet.length} handled or muted`, h('div', { class: 'stack' }, quiet.map(incident))) : null,
  ]);
}

// ---- money (spend, limits, provider quota) ----
function openMoney() { S.sheet = { type: 'money' }; renderSheet(); }
function quotaText(p) {
  const q = p.quota;
  if (!q) return ['Usage not reported. Unknown is not zero.'];
  const windows = q.windows || [['five_hour', 300], ['seven_day', 10080]].filter(([k]) => q[k] != null)
    .map(([k, dur]) => ({ remaining_percent: 100 - q[k] * 100, duration_minutes: dur, resets_at: q[`${k}_resets_at`] || (k === 'five_hour' ? q.resets_at : null) }));
  return windows.map((w) => `${w.duration_minutes === 10080 ? 'Weekly' : w.duration_minutes === 300 ? '5-hour' : `${Math.round((w.duration_minutes || 0) / 60)} h`} window: ${Math.round(w.remaining_percent)}% left${w.resets_at ? ` · resets ${new Date(w.resets_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`);
}
function renderMoneySheet() {
  const spend = Number(S.meta.spend_today) || 0, limit = Number(S.settings.daily_budget_usd) || 0;
  const seats = S.agents.filter((a) => a.spend_today > 0).sort((a, b) => b.spend_today - a.spend_today);
  sheetShell([h('div', { class: 'row' }, h('h2', {}, 'Spend and quota'), h('span', { class: 'spacer' }), closeBtn())], [
    h('p', { class: 'big mono' }, money(spend), h('span', { class: 'muted' }, ` of ${money(limit)} today`)),
    h('p', { class: 'muted small' }, `${limit ? Math.round((spend / limit) * 100) : 0}% of the daily limit. Each running seat reserves its per-run cap. Change the limit in Settings.`),
    seats.length ? [h('h3', {}, 'By seat today'), h('div', { class: 'kv' }, seats.map((a) => h('div', { class: 'kv-row' }, h('span', { class: 'who' }, avatar(a.id), a.name), h('span', { class: 'mono' }, money(a.spend_today)))))] : null,
    h('h3', {}, 'Providers'),
    (S.meta.providers || []).map((p) => h('article', { class: 'prov' }, h('div', { class: 'dcard-top' }, h('b', {}, p.label), h('span', { class: 'spacer' }), chip(p.ready ? 'Ready' : p.available ? 'On hold' : 'Unavailable', p.ready ? 'green' : p.available ? 'amber' : 'red')),
      p.reason ? h('p', { class: 'small' }, p.reason) : null, quotaText(p).map((x) => h('p', { class: 'small mono' }, x)), p.quota?.at ? h('p', { class: 'muted small' }, `Reported ${ago(p.quota.at)}`) : null)),
    S.meta.usage?.perplexity_desktop ? h('p', { class: 'small' }, `Perplexity desktop: ${Math.floor(S.meta.usage.perplexity_desktop.credits_remaining).toLocaleString()} credits (observed ${ago(S.meta.usage.perplexity_desktop.at)})`) : null,
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: act(async () => { await api('POST', '/api/providers/refresh', {}); await loadSnapshot(); }, 'Provider usage refreshed') }, 'Refresh provider usage')),
  ]);
}

// ---- settings (gear) ----
function openSettings() { S.sheet = { type: 'settings' }; renderSheet(); }
function renderSettingsSheet() {
  const num = (key, label, help, step = 1) => h('label', { class: 'set' }, h('span', { class: 'set-l' }, h('b', {}, label), h('span', { class: 'muted small' }, help)),
    h('input', { id: `set-${key}`, type: 'number', inputmode: 'decimal', min: key === 'daily_budget_usd' ? '0' : '1', step: String(step), value: S.settings[key] ?? '', onchange: act((e) => api('POST', '/api/settings', { key, value: e.target.value }), 'Saved') }));
  const bool = (key, label, help) => h('label', { class: 'set' }, h('span', { class: 'set-l' }, h('b', {}, label), h('span', { class: 'muted small' }, help)),
    h('input', { id: `set-${key}`, type: 'checkbox', class: 'switch', checked: S.settings[key] === 'true', onchange: act((e) => api('POST', '/api/settings', { key, value: String(e.target.checked) }), 'Saved') }));
  sheetShell([h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), closeBtn())], [
    h('h3', {}, 'Limits'),
    num('daily_budget_usd', 'Daily spend limit (USD)', 'Notional model spend per day.', 5),
    num('max_concurrent', 'Seats at once', 'A market-hours window in the config can lower this.'),
    bool('auto_fallback', 'Provider fallback', 'When one provider is low or down, seats use the other. Limits and gates still apply.'),
    h('h3', {}, 'Research and GitHub'),
    h('div', { class: 'set' }, h('span', { class: 'set-l' }, h('b', {}, 'Research programs'), h('span', { class: 'muted small' }, `${(S.meta.research?.programs || []).length} program(s) · every research proposal gets an independent second review · connectors need a case, an assessment and your approval`)),
      h('button', { class: 'btn', type: 'button', onclick: openResearch }, 'Open')),
    bool('github_sync', 'Sync GitHub issues', `Mirror tickets and comments to ${S.meta.repo || 'GitHub'}.`),
    bool('open_draft_prs', 'Open draft PRs', 'After QA, push the branch and open a draft PR. Nothing merges automatically.'),
    h('p', { class: 'muted small' }, 'Halt, resume and the breaker live under the Desk instrument in the header.'),
    h('h3', {}, 'Team'),
    h('ul', { class: 'seat-list' }, S.agents.map((a) => { const r = S.meta.routing?.[a.id] || {}; return h('li', { class: 'idle-row' }, avatar(a.id, 'md'), h('span', { class: 'seat-who' }, h('b', {}, a.name), h('span', { class: 'muted small' }, a.role)), h('span', { class: 'spacer' }),
      h('span', { class: 'mono small' }, a.enabled === false ? 'off' : `${r.engine || a.engine}${(r.model ?? a.model) ? ` · ${r.model ?? a.model}` : ''}`)); })),
    h('div',{class:'row-actions'},S.agents.map(a=>h('button',{class:'btn small',type:'button',onclick:()=>openModelSettings(a.id)},`${a.name} · Edit models`))),
    h('div', { class: 'row-actions' }, h('a', { class: 'btn', href: '/classic.html' }, 'Open Classic view'), h('button', { class: 'btn', type: 'button', onclick: openPrConsole }, 'Pull requests')),
  ]);
}

// ---- per-seat model controls ----
async function openModelSettings(id) {
  const a = agentMap()[id];
  const sh = { type: 'models', id, draft: { engine:a.engine, model:a.model || '', effort:a.effort, enabled:a.enabled !== false,
    mode:a.fallbacks === undefined ? 'automatic' : a.fallbacks.length ? 'custom' : 'off', fallbacks:structuredClone(a.fallbacks || []) } };
  S.sheet=sh; renderSheet();
  try { sh.catalog=await api('GET','/api/engines'); } catch(e) { sh.error=e.message; }
  if(S.sheet===sh) renderSheet();
}
function renderModelSettings() {
  const sh=S.sheet, a=agentMap()[sh.id], d=sh.draft, catalog=sh.catalog;
  const form = (p, title) => {
    const allowed=catalog.seats.find(s=>s.id===a.id)?.supported_engines || ['claude','codex'];
    const engines=catalog.engines.filter(e=>allowed.includes(e.id));
    const engine=engines.find(e=>e.id===p.engine);
    const models=engine?.models || [];
    const health=(S.meta.providers || []).find(x=>x.id===p.engine);
    const relayHeld=p.engine==='perplexity' && !(S.meta.providers || []).find(x=>x.id==='claude')?.ready;
    const efforts=models.find(m=>m.id===p.model)?.efforts || engine?.efforts || [];
    const field=(label,values,value,change)=>h('label',{class:'field'},h('span',{},label),h('select',{'aria-label':label,onchange:e=>{change(e.target.value);renderSheet();}}, values.map(([v,l])=>h('option',{value:v,selected:v===value},l))));
    return h('fieldset',{class:'model-profile'},h('legend',{},title),
      field(`${title} provider`,engines.map(e=>[e.id,`${e.label}${e.available?'':' · unavailable'}`]),p.engine,v=>{p.engine=v;Object.assign(p,catalog.seats.find(s=>s.id===a.id)?.suggestions[v] || {model:catalog.engines.find(e=>e.id===v)?.models[0]?.id || '',effort:'medium'});}),
      field(`${title} model`,models.map(m=>[m.id,m.label || m.id || m.note || 'Account default']),p.model,v=>{p.model=v;const e=models.find(m=>m.id===v)?.efforts || engine.efforts;if(!e.includes(p.effort))p.effort=e.includes('high')?'high':e[0];}),
      field(`${title} reasoning`,efforts.map(e=>[e,e]),p.effort,v=>p.effort=v),
      h('p',{class:'small',role:'status'},health?.ready?(relayHeld?'Connected; waiting for an available Claude relay':'Provider ready'):health?.reason || 'Provider status unavailable'),
      h('p',{class:'muted small'},models.find(m=>m.id===p.model)?.note || engine?.costs || ''),
      p.engine==='perplexity'?h('p',{class:'muted small'},'Thinking roles only. Uses Perplexity credits plus a local Claude relay; both must be available.'):null);
  };
  const running=S.runs.find(r=>r.id===a.current_run);
  sheetShell([h('div',{class:'row'},h('h2',{},`${a.name} · Models`),h('span',{class:'spacer'}),closeBtn()),h('p',{class:'muted'},a.role)],
    !catalog?h('p',{class:'muted'},sh.error || 'Loading installed providers and model catalogs…'):[
      h('p',{},running?`Current run: ${running.model}. Saved changes apply to the next run.`:'Changes apply to the next run.'),
      h('label',{class:'check'},h('input',{type:'checkbox',checked:d.enabled,onchange:e=>d.enabled=e.target.checked}),'Seat enabled'),
      form(d,'Preferred'),
      h('label',{class:'field'},h('span',{},'Fallback policy'),h('select',{'aria-label':'Fallback policy',onchange:e=>{d.mode=e.target.value;if(d.mode==='custom'&&!d.fallbacks.length){const alt=catalog.engines.find(e=>e.id!==d.engine&&e.id!=='perplexity');if(alt)d.fallbacks.push({engine:alt.id,...catalog.seats.find(s=>s.id===a.id)?.suggestions[alt.id]});}renderSheet();}},
        [['automatic','Automatic compatible provider'],['custom','My fallback order'],['off','Wait for preferred provider']].map(([v,l])=>h('option',{value:v,selected:v===d.mode},l)))),
      d.mode==='custom'?d.fallbacks.map((p,i)=>h('div',{},form(p,`Fallback ${i+1}`),h('button',{class:'btn ghost small',type:'button',onclick:()=>{d.fallbacks.splice(i,1);renderSheet();}},'Remove fallback'))):null,
      d.mode==='custom'&&d.fallbacks.length<3?h('button',{class:'btn',type:'button',onclick:()=>{d.fallbacks.push({engine:'codex',model:'',effort:'medium'});renderSheet();}},'Add fallback'):null,
      h('p',{class:'muted small'},'Provider quota holds apply to all its models. If every compatible provider is unavailable, work waits and keeps its state.'),
      S.settings.auto_fallback!=='true'?h('p',{class:'amber-t'},'Automatic fallback is globally off. Enable it from Team to use these backups.'):null,
    ],catalog?h('div',{class:'f-actions'},h('button',{class:'btn primary',type:'button',onclick:act(async()=>{
      if(d.mode==='custom'&&!d.fallbacks.length)throw new Error('Add a fallback or choose another policy.');
      await api('POST','/api/team',{seats:{[a.id]:{engine:d.engine,model:d.model,effort:d.effort,enabled:d.enabled,fallback_mode:d.mode,
        ...(d.mode==='automatic'?{}:{fallbacks:d.mode==='off'?[]:d.fallbacks})}}});
      await loadSnapshot();openSeat(a.id);
    },'Model preferences saved for the next run')},'Save models')):null);
}

function productReviewView(t,d) {
  const reviews=d?.product_reviews || (S.meta.product_reviews || []).filter(r=>r.ticket_key===t.key);
  const sh=S.sheet;
  const action=(r,type)=>act(async()=>{
    await api('POST',`/api/tickets/${t.key}/product-review`,{phase:r.phase,revision:r.revision,action:type,message:sh.reviewMessage || ''});
    sh.reviewMessage='';sh.decisionId=null;sh.mode=null;await loadSnapshot();if(S.sheet===sh)await loadDetail(sh);
  },'Review updated');
  return h('section',{class:'product-review','aria-label':'Product and design review'},h('h3',{},'Product & design review'),
    t.parent_key && (S.meta.product_reviews || []).some(r=>r.ticket_key===t.parent_key)?h('button',{class:'btn small',type:'button',onclick:()=>openTicket(t.parent_key)},'View parent feature review'):null,
    reviews.length?reviews.map(r=>h('div',{class:'review-round'},
      h('p',{},h('b',{},r.phase==='plan'?'Before implementation':'User feedback'),` · ${r.stale?'Stale':r.status} · revision ${r.revision}`),
      h('p',{class:'muted small'},r.status==='reviewing'?'Independent perspectives, one bounded challenge round, then engineering manager synthesis.':'Every required perspective must support the plan. Objections remain visible.'),
      r.members.map(m=>disclose(`product-${t.key}-${r.phase}-${r.revision}-${m.agent_id}`,
        `${agentMap()[m.agent_id]?.name || m.agent_id} · ${agentMap()[m.agent_id]?.role || m.stage} · ${m.report?.verdict || m.status}`,
        m.report?[m.initial_report?h('p',{class:'muted small'},`Initial ${m.initial_report.verdict}: ${m.initial_report.recommendation}`):null,h('p',{},m.report.recommendation),...['users','benefits','drawbacks','alternatives','evidence','conditions'].map(k=>h('div',{},h('b',{},k[0].toUpperCase()+k.slice(1)),h('ul',{},m.report[k].map(x=>h('li',{},x))))) ,
          ...['architecture','rollout','success_metric'].map(k=>h('p',{},h('b',{},`${k.replace('_',' ')}: `),m.report[k])),h('p',{class:'muted small'},m.model || '')]
          :h('p',{class:'muted'},m.error || (m.status==='pending'?'Waiting for capacity, provider availability, and preceding reviews.':'Review in progress.')))),
      r.status!=='reviewing'?[h('textarea',{rows:2,'aria-label':`${r.phase} review correction`,placeholder:'Correction or new evidence…',value:sh.reviewMessage || '',oninput:e=>{sh.reviewMessage=e.target.value;}}),
        h('div',{class:'row-actions'},h('button',{class:'btn',type:'button',onclick:action(r,'revise')},'Revise & review'),
          r.status==='failed'&&!r.stale?h('button',{class:'btn',type:'button',onclick:action(r,'retry')},'Retry failed reviews'):null,
          h('button',{class:'btn ghost',type:'button',onclick:action(r,'defer')},'Defer plan'),h('button',{class:'btn danger',type:'button',onclick:action(r,'reject')},'Reject plan'))]:null))
      :h('p',{class:'muted small'},'New root feature plans receive independent product and architecture review before implementation. You can request a review for this task.'),
    h('div',{class:'row-actions'},!reviews.some(r=>r.phase==='plan')&&!t.head_sha?h('button',{class:'btn',type:'button',disabled:!!t.active_run,onclick:act(async()=>{await api('POST',`/api/tickets/${t.key}/product-review`,{phase:'plan'});await loadDetail(sh);},'Product review queued')},'Review this plan'):null,
      !reviews.some(r=>r.phase==='feedback')&&t.head_sha?h('button',{class:'btn',type:'button',disabled:!!t.active_run,onclick:act(async()=>{await api('POST',`/api/tickets/${t.key}/product-review`,{phase:'feedback'});await loadDetail(sh);},'User feedback queued')},'Request user feedback'):null));
}

// ---- new ticket ----
function renderNewSheet() {
  const draft = S.sheet.draft ||= { title: '', description: '', type: 'feature', priority: 'P2' };
  const up = (f) => (e) => { draft[f] = e.target.value; };
  const title = h('input', { id: 'new-title', type: 'text', value: draft.title, oninput: up('title'), placeholder: 'What do you need?', maxlength: '200', 'data-autofocus': true });
  const desc = h('textarea', { id: 'new-description', rows: '7', oninput: up('description'), placeholder: 'Context, links, acceptance criteria. Support triages and routes it.' });
  desc.value = draft.description;
  sheetShell([h('div', { class: 'row' }, h('h2', {}, 'New ticket'), h('span', { class: 'spacer' }), closeBtn())], [
    h('label', { class: 'field', for: 'new-title' }, h('span', {}, 'Title'), title),
    h('label', { class: 'field', for: 'new-description' }, h('span', {}, 'Description'), desc),
    h('div', { class: 'two' },
      h('label', { class: 'field' }, h('span', {}, 'Type'), h('select', { id: 'new-type', onchange: up('type') }, ['feature', 'bug', 'task', 'research'].map((v) => h('option', { value: v, selected: v === draft.type }, v[0].toUpperCase() + v.slice(1))))),
      h('label', { class: 'field' }, h('span', {}, 'Priority'), h('select', { id: 'new-priority', onchange: up('priority') }, ['P0', 'P1', 'P2', 'P3'].map((v) => h('option', { value: v, selected: v === draft.priority }, v))))),
  ], h('div', { class: 'f-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary big', type: 'button', onclick: act(async () => {
    if (!draft.title.trim()) throw new Error('A title is required.');
    const t = await api('POST', '/api/tickets', draft);
    closeSheet();
    openTicket(t.key);
  }, 'Ticket created — support will triage it') }, 'Create ticket')));
}

// ---------------- render loop ----------------
function render() {
  B = board(S);
  B.byKey = {}; // ticket key → its primary item (first decision, or its bucket item)
  for (const it of Object.values(B).filter(Array.isArray).flat()) if (!B.byKey[it.key]) B.byKey[it.key] = it;
  document.documentElement.style.setProperty('--hdr-h', `${document.querySelector('.hdr')?.offsetHeight || 0}px`);
  renderTop();
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false');
  const view = $('view');
  const active = document.activeElement;
  const keepId = view.contains(active) ? active.id : null;
  const sel = keepId ? active.selectionStart : null;
  const busy = view.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName) && !keepId;
  if (!busy) {
    const content = !S.loaded && !S.loadError ? [h('p', { class: 'muted pad' }, 'Loading the desk…')] : S.view === 'work' ? renderWork() : S.view === 'team' ? renderTeam() : renderInbox();
    view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    view.dataset.view = S.view;
    if (keepId && $(keepId)) { const n = $(keepId); n.focus(); if (sel != null && n.setSelectionRange && n.type !== 'checkbox') try { n.setSelectionRange(sel, sel); } catch { /* not a text field */ } }
  }
  if (S.loaded) { for (const it of B.needs_you) S.seen.add(it.id); S.painted = true; }
  if (S.sheet && !['new', 'prs', 'pr', 'settings'].includes(S.sheet.type)) renderSheet();
}

// ---------------- wiring ----------------
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => setView(b.dataset.view));
$('btn-new').addEventListener('click', () => { S.sheet = { type: 'new' }; renderSheet(); });
$('btn-gear').addEventListener('click', openSettings);
document.addEventListener('keydown', (e) => {
  if (!S.sheet) return;
  if (e.key === 'Escape') { const o = $('sheet').querySelector('details.overflow[open]'); if (o) o.open = false; else closeSheet(); }
  if (e.key === 'Tab') {
    const focusable = [...$('sheet').querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select, a[href], summary')].filter((el) => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
document.addEventListener('click', (e) => { for (const o of document.querySelectorAll('details.overflow[open]')) if (!o.contains(e.target)) o.open = false; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') connect(); });
setInterval(() => { if (document.visibilityState === 'visible' && S.connected) loadSnapshot().catch(() => {}); }, 15_000);
setInterval(() => { if (document.visibilityState === 'visible') schedule(); }, 30_000); // "waiting N min" / "no update" clocks

render();
connect();
const openFromHash = () => { const k = decodeURIComponent(location.hash.slice(1)); if (/^[A-Z][A-Z0-9]*-\d+$/.test(k) && !(S.sheet?.type === 'ticket' && S.sheet.key === k)) openTicket(k); };
window.addEventListener('hashchange', openFromHash);
openFromHash();


// ---- research programs, second-person review and governed connectors ----
function researchReviewView(t, d) {
  if (t.source !== 'research' || !t.research_review) return null;
  const sum = (S.meta.research_reviews || []).find((r) => r.ticket_key === t.key);
  const rows = (d?.research_reviews || []).slice().sort((a, b) => a.id - b.id);
  const label = { pending: 'Awaiting second review', passed: 'Passed', changes: 'Changes requested', held: 'Held for you', waived: 'Waived by you' }[t.research_review] || t.research_review;
  const tone = { passed: 'green', waived: 'green', held: 'amber', changes: 'amber' }[t.research_review] || '';
  const blocks = ['pending', 'changes', 'held'].includes(t.research_review);
  return h('section', { class: 'product-review', 'aria-label': 'Independent research review' }, h('h3', {}, 'Independent research review'),
    h('p', {}, chip(label, tone), ` · program ${t.research_program || '—'} · generation ${t.research_generation || 1}${sum && t.research_review === 'pending' ? ` · ${sum.needed} more pass${sum.needed === 1 ? '' : 'es'} needed` : ''}`),
    sum?.reason ? h('p', { class: 'muted small' }, sum.reason) : null,
    rows.length ? h('ul', { class: 'slices' }, rows.map((r) => h('li', {}, `${r.reviewer === 'owner' ? 'You' : agentMap()[r.reviewer]?.name || r.reviewer} · generation ${r.generation} · ${r.verdict || r.status}${r.report?.summary ? ` — ${r.report.summary}` : ''}${r.report?.conditions?.length ? ` Conditions: ${r.report.conditions.join('; ')}` : ''}${r.error ? ` — ${r.error}` : ''}`)))
      : h('p', { class: 'muted small' }, 'No reviewer has reported yet.'),
    blocks && t.status !== 'needs_human' ? h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: act(async () => {
      const note = prompt('Waive the independent second review? This is recorded as your verdict. Optional note:', '');
      if (note == null) return false;
      await api('POST', `/api/tickets/${t.key}/research-review/waive`, { note });
      await loadSnapshot(); if (S.sheet?.type === 'ticket' && S.sheet.key === t.key) loadDetail(S.sheet);
    }, 'Review waived — the manager can groom it') }, 'Waive review')) : null);
}

const programDraft = (p) => ({ id: p.id, label: p.label, seat: p.seat, enabled: p.enabled, intervalMinutes: p.intervalMinutes, window: p.window, focus: p.focus || '', sources: [...(p.sources || [])],
  tools: { web: !!p.tools?.web, connectors: [...(p.tools?.connectors || [])] }, maxProposals: p.maxProposals, review: { minReviewers: p.review?.minReviewers || 1, reviewers: [...(p.review?.reviewers || [])] } });
async function reloadResearch(sh) {
  const [data, conns] = await Promise.all([api('GET', '/api/research'), api('GET', '/api/connectors')]);
  data.connectors = conns.connectors;
  sh.data = data; sh.draft = data.programs.map(programDraft); sh.error = null;
  if (S.sheet === sh) renderSheet();
}
async function openResearch() {
  const sh = { type: 'research', data: null, draft: null, error: null, connForm: null, approve: {} };
  S.sheet = sh; renderSheet();
  try { await reloadResearch(sh); } catch (e) { sh.error = e.message; if (S.sheet === sh) renderSheet(); }
}
function renderResearchSheet() {
  const sh = S.sheet, data = sh.data;
  if (!data) return sheetShell([h('div', { class: 'row' }, h('h2', {}, sh.error || 'Loading research…'), h('span', { class: 'spacer' }), closeBtn())], null);
  const approved = (data.connectors || []).filter((c) => c.status === 'approved').map((c) => c.name);
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const num = (obj, k, min, max) => h('input', { type: 'number', min: String(min), max: String(max), value: String(obj[k]), onchange: (e) => { obj[k] = Number(e.target.value); } });
  const text = (obj, k, placeholder) => h('input', { type: 'text', value: obj[k] || '', placeholder, onchange: (e) => { obj[k] = e.target.value; } });
  const check = (obj, k, label) => h('label', { class: 'council-check' }, h('input', { type: 'checkbox', checked: !!obj[k], onchange: (e) => { obj[k] = e.target.checked; } }), label);
  const toggleIn = (arr, v, on) => (on ? [...new Set([...arr, v])] : arr.filter((x) => x !== v));
  const programCard = (p, i) => {
    const live = data.programs.find((x) => x.id === p.id);
    return h('article', { class: 'prov' },
      h('div', { class: 'dcard-top' }, h('b', {}, p.label || p.id), h('span', { class: 'spacer' }),
        live ? chip(live.ok ? 'Due' : live.code === 'cadence' ? 'Scheduled' : live.code === 'disabled' ? 'Off' : live.code, live.ok ? 'green' : live.code === 'disabled' ? '' : 'amber') : chip('Unsaved')),
      live ? h('p', { class: 'muted small' }, `${live.reason}${live.last_run_at ? ` · last session ${ago(live.last_run_at)}` : ' · never run'}`) : null,
      h('div', { class: 'kv' },
        field('Id', text(p, 'id', 'kebab-case')), field('Label', text(p, 'label', 'Name')),
        field('Seat', h('select', { onchange: (e) => { p.seat = e.target.value; p.review.reviewers = p.review.reviewers.filter((x) => x !== p.seat); renderSheet(); } }, S.agents.map((a) => h('option', { value: a.id, selected: a.id === p.seat }, `${a.name} · ${a.role}`)))),
        field('Every (minutes)', num(p, 'intervalMinutes', 15, 525600)),
        field('Window', h('select', { onchange: (e) => { p.window = e.target.value; } }, (data.windows || ['any', 'market', 'off-market']).map((w) => h('option', { value: w, selected: w === p.window }, w === 'market' ? 'market hours only' : w === 'off-market' ? 'outside market hours' : 'any time')))),
        field('Proposals per session', num(p, 'maxProposals', 1, 10)),
        field('Reviewers needed', num(p.review, 'minReviewers', 1, 3)),
        field('Standing focus', text(p, 'focus', 'e.g. alerts that matter to 0DTE traders')),
        field('Approved sources (comma separated)', h('input', { type: 'text', value: p.sources.join(', '), placeholder: 'arxiv.org, ssrn.com, docs.alpaca.markets', onchange: (e) => { p.sources = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); } }))),
      h('div', { class: 'row-actions' }, check(p, 'enabled', 'Enabled'), check(p.tools, 'web', 'Web search / fetch (runs outside the sandbox)')),
      h('p', { class: 'small' }, h('b', {}, 'Reviewer pool (never the researching seat): '), ...S.agents.filter((a) => a.id !== p.seat).map((a) => h('label', { class: 'council-check' },
        h('input', { type: 'checkbox', checked: p.review.reviewers.includes(a.id), onchange: (e) => { p.review.reviewers = toggleIn(p.review.reviewers, a.id, e.target.checked); } }), a.name))),
      h('p', { class: 'small' }, h('b', {}, 'Approved connectors: '), approved.length ? approved.map((c) => h('label', { class: 'council-check' },
        h('input', { type: 'checkbox', checked: p.tools.connectors.includes(c), onchange: (e) => { p.tools.connectors = toggleIn(p.tools.connectors, c, e.target.checked); } }), c)) : 'none approved yet (see Connectors below)'),
      h('div', { class: 'row-actions' },
        live ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { const focus = prompt(`One-off focus for "${p.label}" (optional):`, ''); if (focus == null) return false; await api('POST', `/api/research/programs/${p.id}/run`, { focus }); }, `${p.label} started`) }, 'Run now') : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { sh.draft.splice(i, 1); renderSheet(); } }, 'Remove')));
  };
  const mh = data.market_hours || {};
  return sheetShell([h('div', { class: 'row' }, h('h2', {}, 'Research'), h('span', { class: 'spacer' }), closeBtn())], [
    h('p', { class: 'muted small' }, `Market hours: ${mh.timezone} ${mh.start}–${mh.end} (${mh.open_now ? 'open now' : 'closed now'}). ${data.configured ? 'Saved programs are in effect.' : 'Programs derive from the config and the legacy PM settings until you save.'} Every proposal filed by a program is reviewed by another seat before the manager grooms it.`),
    data.problems?.length ? h('p', { class: 'amber-t' }, data.problems.join(' · ')) : null,
    h('h3', {}, 'Programs'),
    ...sh.draft.map(programCard),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => { const dr = data.default_review || { minReviewers: 1, reviewers: [] }; sh.draft.push({ id: `program-${sh.draft.length + 1}`, label: 'New program', seat: 'pm', enabled: false, intervalMinutes: 1440, window: 'any', focus: '', sources: [], tools: { web: true, connectors: [] }, maxProposals: 2, review: { minReviewers: dr.minReviewers, reviewers: [...dr.reviewers] } }); renderSheet(); } }, 'Add program'),
      h('button', { class: 'btn ghost', type: 'button', onclick: act(async () => { if (!confirm('Discard saved programs and return to the configuration defaults?')) return false; await api('POST', '/api/research/programs/reset', {}); await reloadResearch(sh); await loadSnapshot(); }, 'Programs reset to config') }, 'Reset to config'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', type: 'button', onclick: act(async () => { await api('PUT', '/api/research/programs', { programs: sh.draft }); await reloadResearch(sh); await loadSnapshot(); }, 'Programs saved (all or nothing)') }, 'Save programs')),
    h('h3', {}, 'Connectors'),
    ...renderConnectors(sh, data),
  ]);
}
function renderConnectors(sh, data) {
  const list = data.connectors || [];
  const tone = { approved: 'green', assessed: 'amber', assessing: 'amber', proposed: '', rejected: 'red', retired: '' };
  const refresh = async () => { await reloadResearch(sh); await loadSnapshot(); };
  const approveForm = (c) => {
    const d = sh.approve[c.name] ||= { type: c.binding?.type || 'http', url: c.binding?.url || '', command: c.binding?.command || '', args: (c.binding?.args || []).join(' '), tools: (c.tools || []).join(', '), days: 30, note: '' };
    return h('div', { class: 'kv' },
      h('label', { class: 'field' }, h('span', {}, 'Binding type'), h('select', { onchange: (e) => { d.type = e.target.value; renderSheet(); } }, ['http', 'stdio'].map((v) => h('option', { value: v, selected: v === d.type }, v)))),
      d.type === 'http' ? h('label', { class: 'field' }, h('span', {}, 'https URL'), h('input', { type: 'text', value: d.url, onchange: (e) => { d.url = e.target.value; } }))
        : [h('label', { class: 'field' }, h('span', {}, 'Command (absolute path on this machine)'), h('input', { type: 'text', value: d.command, onchange: (e) => { d.command = e.target.value; } })),
          h('label', { class: 'field' }, h('span', {}, 'Arguments (space separated)'), h('input', { type: 'text', value: d.args, onchange: (e) => { d.args = e.target.value; } }))],
      h('label', { class: 'field' }, h('span', {}, 'Allowed tools (comma separated, exact names)'), h('input', { type: 'text', value: d.tools, onchange: (e) => { d.tools = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Re-evaluate after (days)'), h('input', { type: 'number', min: '7', max: '365', value: String(d.days), onchange: (e) => { d.days = Number(e.target.value); } })),
      h('label', { class: 'field' }, h('span', {}, 'Approval note'), h('input', { type: 'text', value: d.note, onchange: (e) => { d.note = e.target.value; } })),
      d.type === 'stdio' ? h('p', { class: 'amber-t' }, 'A stdio connector runs outside the OS sandbox with your user\'s file access. The desk strips its own credentials and allows only the listed tools; it cannot confine the process. Bindings carry no credentials.') : null,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => {
        const binding = d.type === 'http' ? { type: 'http', url: d.url.trim() } : { type: 'stdio', command: d.command.trim(), args: d.args.trim() ? d.args.trim().split(/\s+/) : [] };
        await api('POST', `/api/connectors/${c.name}/approve`, { binding, tools: d.tools.split(',').map((x) => x.trim()).filter(Boolean), review_after_days: d.days, note: d.note });
        await refresh();
      }, `${c.name} approved`) }, 'Approve with this binding')));
  };
  const card = (c) => h('article', { class: 'prov' },
    h('div', { class: 'dcard-top' }, h('b', {}, c.name), h('span', { class: 'spacer' }), chip(c.status, tone[c.status] || ''), c.due_for_review ? chip('re-evaluate', 'amber') : null),
    h('p', { class: 'small' }, c.purpose || 'No purpose recorded'),
    h('p', { class: 'muted small' }, `proposed by ${c.proposed_by === 'owner' ? 'you' : agentMap()[c.proposed_by]?.name || c.proposed_by}${c.assessed_by ? ` · assessed by ${agentMap()[c.assessed_by]?.name || c.assessed_by}` : ''}${c.approved_at ? ` · approved ${ago(c.approved_at)} · re-evaluate ${String(c.review_after).slice(0, 10)}` : ''}${c.binding ? ` · ${c.binding.type}` : ''}${c.tools?.length ? ` · tools: ${c.tools.join(', ')}` : ''}`),
    c.assessment ? h('p', { class: 'small' }, h('b', {}, `Assessment: ${c.assessment.verdict}`), ` · benefit ${c.assessment.benefit_score}/5 · ${c.assessment.sdlc_stage} · risk ${c.assessment.risk} · cost ${c.assessment.cost_estimate} · time ${c.assessment.time_estimate} · data leaving: ${c.assessment.data_leaving}. ${c.assessment.rationale}${c.assessment.conditions?.length ? ` Conditions: ${c.assessment.conditions.join('; ')}` : ''}`) : null,
    c.usage?.runs ? h('p', { class: 'muted small' }, `${c.usage.runs} run(s) · $${c.usage.cost_usd} · ${c.usage.proposals} proposal(s), ${c.usage.passed_review} passed the second review · last used ${ago(c.usage.last_used_at)}`) : null,
    c.decision_note ? h('p', { class: 'muted small' }, c.decision_note) : null,
    c.case_md ? disclose(`case-${c.name}`, 'Case', h('pre', { class: 'prose wrap' }, c.case_md)) : h('p', { class: 'amber-t' }, 'No case written yet; write one before requesting an assessment.'),
    c.status === 'assessed' ? approveForm(c) : null,
    h('div', { class: 'row-actions' },
      ['proposed', 'assessed', 'rejected'].includes(c.status) && c.case_md ? h('button', { class: 'btn', type: 'button', onclick: act(async () => { await api('POST', `/api/connectors/${c.name}/assess`, {}); await refresh(); }, 'Assessment requested — a seat other than the proposer reviews the case') }, c.status === 'proposed' ? 'Request assessment' : 'Assess again') : null,
      c.status === 'assessing' ? h('span', { class: 'muted small' }, 'Assessment in progress…') : null,
      ['proposed', 'assessing', 'assessed'].includes(c.status) ? h('button', { class: 'btn ghost', type: 'button', onclick: act(async () => { const reason = prompt(`Reject ${c.name}? Reason for the record:`, ''); if (reason == null) return false; await api('POST', `/api/connectors/${c.name}/reject`, { reason }); await refresh(); }, `${c.name} rejected`) }, 'Reject') : null,
      c.status === 'approved' ? h('button', { class: 'btn danger', type: 'button', onclick: act(async () => { const reason = prompt(`Retire ${c.name}? Programs that use it must drop it before they can be saved again. Reason:`, ''); if (reason == null) return false; await api('POST', `/api/connectors/${c.name}/retire`, { reason }); await refresh(); }, `${c.name} retired`) }, 'Retire') : null));
  const f = sh.connForm ||= { name: '', purpose: '', case_md: (data.case_sections || []).map((x) => `## ${x}\n\n`).join('') };
  const caseBox = h('textarea', { rows: '16', 'aria-label': 'Connector case', oninput: (e) => { f.case_md = e.target.value; } }); caseBox.value = f.case_md;
  return [
    h('p', { class: 'muted small' }, 'Adding a connector is a decision, not a config edit: a written case (benefit, how it is used, SDLC stage, cost, time, data leaving the machine, risks, success measure), an independent assessment by another seat, then your approval with the exact binding and tools. Only approved connectors can be selected by a program; usage and review outcomes are tracked for the re-evaluation.'),
    ...(list.length ? list.map(card) : [h('p', { class: 'muted' }, 'No connectors proposed yet.')]),
    disclose('propose-connector', 'Propose a connector', h('div', { class: 'kv' },
      h('label', { class: 'field' }, h('span', {}, 'Name (kebab-case)'), h('input', { type: 'text', value: f.name, placeholder: 'paper-search', onchange: (e) => { f.name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Purpose (one line)'), h('input', { type: 'text', value: f.purpose, onchange: (e) => { f.purpose = e.target.value; } })),
      h('label', { class: 'field' }, h('span', {}, 'Case (keep every section)'), caseBox),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => { await api('POST', '/api/connectors', { name: f.name.trim(), purpose: f.purpose, case_md: f.case_md }); sh.connForm = null; await refresh(); }, 'Connector proposed — request its assessment next') }, 'Propose')))),
  ];
}
