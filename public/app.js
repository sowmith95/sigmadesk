// SigmaDesk client: one snapshot, then a live SSE stream of deltas. No framework, no innerHTML for data.
import * as prsUi from './prs.js';
import { nameOf, linkKeys } from './names.js';
import { portrait, presenceOf } from './avatars.js';

const COLUMNS = [
  { id: 'triage', title: 'Intake', sub: 'Support triages new tickets' },
  { id: 'proposed', title: 'Backlog', sub: 'Manager scopes and assigns' },
  { id: 'todo', title: 'Ready', sub: 'Scoped and waiting for a seat' },
  { id: 'in_progress', title: 'In progress', sub: 'Design and implementation' },
  { id: 'qa', title: 'QA', sub: 'Independent tests and review' },
  { id: 'review', title: 'Acceptance', sub: 'Requester confirms intent' },
  { id: 'needs_human', title: 'Needs you', sub: 'A decision or answer is needed', alert: true },
  { id: 'ready_for_human', title: 'Ready to merge', sub: 'Draft PR for your review' },
  { id: 'done', title: 'Done', sub: 'Merged' },
  { id: 'wontdo', title: 'Cancelled', sub: 'Rejected or closed' },
];
const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.title]));

const S = {
  agents: [], tickets: [], events: [], runs: [], settings: {}, meta: {}, incidents: [],
  view: localStorage.getItem('sd.view') || 'board',
  mobileCol: localStorage.getItem('sd.col') || 'in_progress',
  tapeFilter: 'all',
  sheet: null, // { type: 'ticket', key, detail } | { type: 'seat', id, events } | { type: 'new' }
  connected: false,
  search: '', assigneeFilter: '', stageFilter: 'all', showClosed: false, showEmpty: false, loadError: null,
};

// ---------------- tiny DOM helper ----------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
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
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const PX = { '': 24, md: 32, lg: 44, xl: 72 };
function avatar(agentId, size = '') {
  const a = agentMap()[agentId];
  if (!a) {
    const label = agentId === 'owner' ? 'YOU' : agentId === 'github' ? 'GH' : agentId === 'system' ? 'SYS' : '··';
    return h('span', { class: `av ${size}`, style: `--c:${agentId === 'owner' ? '#a3e635' : '#556070'}`, title: agentId || 'desk' }, label);
  }
  const pr = presenceOf(a);
  const wrap = h('span', { class: `pav ${size} ${pr.key}`, title: `${a.name} · ${a.role} · ${pr.text}` });
  wrap.append(portrait(a, { size: PX[size] ?? 24, presence: pr.key }));
  return wrap;
}
const modelTag = (m) => h('span', { class: `model ${m}` }, m);
const seatModel = (a) => {
  const active = S.runs.find((r) => r.id === a.current_run);
  const route = S.meta.routing?.[a.id];
  const engine = active ? active.model.split(':')[0] : route?.engine || a.engine;
  const model = active ? active.model.split(':').slice(1).join(':') : route?.model ?? a.model;
  return h('span', { class: `model ${engine === 'codex' ? 'codex' : model}`, title: route?.fallback ? `Fallback from ${a.engine}: ${route.reason}` : 'Seat model' }, engine === 'codex' ? `Codex · ${model && model !== 'default' ? model : 'default'}` : model);
};
function quotaWindows(q) {
  if (!q) return [];
  if (q.windows) return q.windows;
  return [['five_hour', 300], ['seven_day', 10080]].filter(([key]) => q[key] != null).map(([key, duration]) => ({
    used_percent: Math.max(0, Math.min(100, q[key] * 100)), remaining_percent: Math.max(0, 100 - q[key] * 100), duration_minutes: duration,
    resets_at: q[`${key}_resets_at`] || (key === 'five_hour' ? q.resets_at : null), bucket: q.engine || 'claude',
  }));
}
const windowLabel = (w) => w.duration_minutes === 10080 ? 'Weekly' : w.duration_minutes === 300 ? '5-hour' : w.duration_minutes ? `${w.duration_minutes / 60}h window` : w.name || 'Usage';
function quotaSummary(p) {
  const windows = quotaWindows(p.quota).filter((w) => (!p.quota?.active_bucket || w.bucket === p.quota.active_bucket) && (!w.resets_at || Date.parse(w.resets_at) > Date.now()));
  return windows.length ? `${Math.round(Math.min(...windows.map((w) => w.remaining_percent)))}% left` : 'usage unknown';
}

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${err ? 'err' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(15000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ---------------- team: engine / model / effort per seat ----------------
async function openTeam(firstRun = false) {
  S.sheet = { type: 'team', firstRun, data: null, draft: {} };
  renderSheet();
  try {
    const data = await api('GET', '/api/engines');
    if (S.sheet?.type !== 'team') return;
    S.sheet.data = data;
    for (const seat of data.seats) S.sheet.draft[seat.id] = { engine: seat.engine, model: seat.model || '', effort: seat.effort || '', enabled: seat.enabled !== false };
    renderSheet();
  } catch (e) { toast(e.message, true); }
}

function renderTeamSheet() {
  const sh = S.sheet;
  const d = sh.data;
  const head = [h('div', { class: 'row' }, h('h2', {}, sh.firstRun ? 'Staff your desk' : 'Team'), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
    h('p', { class: 'bio' }, sh.firstRun ? 'Before the desk opens, confirm which engine and model each seat runs on. Suggestions follow each seat\'s tier: frontier for principals and the PM, fast and cheap for triage.' : 'Change any seat\'s engine, model or effort. Takes effect on its next run.')];
  if (!d) return sheetShell(head, h('div', { class: 'empty' }, 'Detecting installed engines…'));
  const engines = Object.fromEntries(d.engines.map((e) => [e.id, e]));
  const avail = d.engines.filter((e) => e.available);
  const applyPreset = (pr) => { for (const [id, v] of Object.entries(pr.seats)) Object.assign(sh.draft[id], { engine: v.engine, model: v.model || '', effort: v.effort || '' }); renderSheet(); };
  const body = [
    h('div', { class: 'engines' }, d.engines.map((e) => h('div', { class: `eng ${e.available ? '' : 'off'}` },
      h('b', {}, e.label), h('span', { class: 'mono' }, e.available ? e.version : 'not installed'),
      h('div', { class: 'iso' }, `reads ${e.isolation.reads} · writes ${e.isolation.writes} · network ${e.isolation.network}`),
      e.isolation.reads !== 'restricted' ? h('div', { class: 'warn' }, `⚠ ${e.isolation.note}`) : null,
      h('div', { class: 'iso' }, e.costs)))),
    d.presets.length ? [h('div', { class: 'section-title' }, 'Presets'), h('div', { class: 'presets' }, d.presets.map((pr) => h('button', { class: 'preset', type: 'button', onclick: () => applyPreset(pr) }, h('b', {}, pr.label), h('span', {}, pr.note))))] : null,
    h('div', { class: 'section-title' }, 'Seats'),
    h('div', { class: 'seats' }, d.seats.map((seat) => {
      const dr = sh.draft[seat.id];
      const eng = engines[dr.engine] || avail[0];
      const sug = seat.suggestions[dr.engine];
      const models = eng?.models || [];
      const modelOpts = models.some((m) => m.id === dr.model) ? models : [...models, { id: dr.model, note: 'custom' }];
      const set = (k) => (e) => { dr[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; if (k === 'engine') { const s2 = seat.suggestions[dr.engine]; if (s2) Object.assign(dr, { model: s2.model, effort: s2.effort }); } renderSheet(); };
      const en = h('input', { id: `team-${seat.id}-enabled`, type: 'checkbox', class: 'switch', onchange: set('enabled'), 'aria-label': `${seat.name} enabled` });
      en.checked = dr.enabled;
      return h('div', { class: `seatrow ${dr.enabled ? '' : 'off'}` },
        avatar(seat.id, 'md'),
        h('div', { class: 'sr-who' }, h('b', {}, seat.name), h('span', {}, seat.role), h('small', {}, `${seat.tier} · ${d.tiers[seat.tier] || ''}`)),
        h('div', { class: 'sr-ctl' },
          h('select', { id: `team-${seat.id}-engine`, 'aria-label': `${seat.name} engine`, onchange: set('engine') }, d.engines.map((e) => {
            // Perplexity can only think (no local file edits): not offered to seats that build or test.
            const kinds = agentMap()[seat.id]?.kinds || [];
            const unfit = Array.isArray(e.supports) && !kinds.every((k) => e.supports.includes(k));
            return h('option', { value: e.id, selected: e.id === dr.engine, disabled: !e.available || unfit, title: unfit ? `${e.label} can only run thinking seats` : '' },
              `${e.label}${unfit ? ' (thinking seats only)' : !e.available ? ' (not connected)' : ''}`);
          })),
          h('select', { id: `team-${seat.id}-model`, 'aria-label': `${seat.name} model`, onchange: set('model') }, modelOpts.map((m) => h('option', { value: m.id, selected: m.id === dr.model }, `${m.id || 'default'}${m.note ? ` — ${m.note}` : ''}`))),
          h('select', { id: `team-${seat.id}-effort`, 'aria-label': `${seat.name} effort`, onchange: set('effort') }, (eng?.efforts || []).map((x) => h('option', { value: x, selected: x === dr.effort }, `effort ${x}`))),
          en),
        sug && (sug.model !== dr.model || sug.effort !== dr.effort) ? h('button', { class: 'linkish sr-sug', type: 'button', onclick: () => { Object.assign(dr, { model: sug.model, effort: sug.effort }); renderSheet(); } }, `suggested: ${sug.model || 'default'} · ${sug.effort}`) : null);
    })),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'button', onclick: act(async () => {
        await api('POST', '/api/team', { seats: sh.draft, confirm: true });
        if (sh.firstRun) await api('POST', '/api/control/start', {});
        closeSheet();
        loadSnapshot();
      }, sh.firstRun ? 'team confirmed — desk open' : 'team saved') }, sh.firstRun ? 'Confirm team & open desk' : 'Save team')),
  ];
  sheetShell(head, body);
}
const prsCtx = () => ({ h, api, act, avatar, toast, sheetShell, closeSheet, openTicket, S, render, nameOf: tname });
// Human names: "Eastern session helpers" instead of "SD-5". Ticket mentions in text become named, tappable chips.
const ticketByKey = (k) => S.tickets.find((x) => x.key === k);
const tname = (k) => nameOf(typeof k === 'string' ? ticketByKey(k) || { title: k } : k);
const named = (text) => linkKeys(text, ticketByKey).map((p) => (typeof p === 'string' ? p
  : h('button', { class: 'kchip', type: 'button', title: p.key, onclick: (e) => { e.stopPropagation(); openTicket(p.key); } }, p.name)));
const act = (fn, ok) => async (...a) => {
  const button = a[0]?.currentTarget;
  if (button?.disabled) return;
  if (button?.tagName === 'BUTTON') button.disabled = true;
  try { const result = await fn(...a); if (ok && result !== false) toast(ok); } catch (e) { toast(e.message, true); }
  finally { if (button?.tagName === 'BUTTON') button.disabled = false; }
};

// ---------------- data sync ----------------
async function loadSnapshot() {
  syncing = true;
  const seq = ++snapshotSeq;
  try {
    const snap = await api('GET', '/api/state');
    if (seq !== snapshotSeq) return;
    Object.assign(S, snap);
    S.loadError = null;
    const queued = pendingDeltas.splice(0);
    for (const m of queued) apply(m);
    render();
  } catch (e) {
    if (seq === snapshotSeq) { S.loadError = e.message; for (const m of pendingDeltas.splice(0)) apply(m); renderTop(); }
    throw e;
  }
  finally { if (seq === snapshotSeq) syncing = false; }
}

let es;
let syncing = false, snapshotSeq = 0;
const pendingDeltas = [];
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => { S.connected = true; syncing = true; loadSnapshot().catch(() => {}); };
  es.onerror = () => { S.connected = false; renderTop(); };
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
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; render(); });
}

function apply(m) {
  switch (m.type) {
    case 'discussion':
      if (S.sheet?.type === 'ticket' && S.sheet.key === m.data.ticket_key && S.sheet.detail) {
        S.sheet.detail.discussions ||= []; upsert(S.sheet.detail.discussions, m.data);
      }
      refreshMeta(); break;
    case 'council': {
      if (S.meta.council) upsert(S.meta.council.councils, { id: m.data.id, ticket_key: m.data.ticket_key, status: m.data.status, decision: m.data.decision });
      const sh = S.sheet;
      if (sh?.type === 'architecture') {
        if (sh.councilModels) upsert(sh.councilModels.councils, { id: m.data.id, ticket_key: m.data.ticket_key, status: m.data.status, decision: m.data.decision });
        if (sh.council?.id === m.data.id) api('GET', `/api/councils/${m.data.id}`).then((c) => { if (S.sheet === sh && sh.council?.id === c.id) { sh.council = c; renderArchitectureSheet(); } }).catch(() => {});
      }
      refreshMeta(); break;
    }
    case 'architecture-review':
      if (S.sheet?.type === 'architecture' && S.sheet.review?.id === m.data.id) {
        S.sheet.review = m.data;
        if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) renderArchitectureSheet();
      }
      break;
    case 'ticket': upsert(S.tickets, m.data, 'key'); break;
    case 'agent': {
      const a = S.agents.find((x) => x.id === m.data.id);
      if (a) Object.assign(a, m.data);
      break;
    }
    case 'run': upsert(S.runs, m.data); if (m.data.status !== 'running') refreshMeta(); break;
    case 'settings': S.settings = m.data; break;
    case 'incident': upsert(S.incidents, m.data); break;
    case 'quota': if (m.data.engine === 'claude') S.meta.quota = m.data; refreshMeta(); break;
    case 'event':
      if (!S.events.some((e) => e.id === m.data.id)) S.events.push(m.data);
      if (S.events.length > 600) S.events.splice(0, S.events.length - 600);
      if (S.sheet?.type === 'ticket' && S.sheet.key === m.data.ticket_key && S.sheet.detail && !S.sheet.detail.events.some((e) => e.id === m.data.id)) S.sheet.detail.events.push(m.data);
      if (S.sheet?.type === 'seat' && S.sheet.id === m.data.agent_id) S.sheet.events?.push(m.data);
      break;
    case 'comment':
      if (S.sheet?.type === 'ticket' && S.sheet.key === m.data.ticket_key && S.sheet.detail && !S.sheet.detail.comments.some((c) => c.id === m.data.id)) S.sheet.detail.comments.push(m.data);
      break;
    default: break;
  }
  schedule();
}

let metaTimer = 0;
function refreshMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => loadSnapshot().catch(() => {}), 800);
}

// ---------------- top bar ----------------
function renderTop() {
  const open = S.settings.paused !== 'true';
  $('project').textContent = S.meta.project || '';
  const spend = S.meta.spend_today || 0;
  const limit = Number(S.settings.daily_budget_usd) || 1;
  const pct = Math.min(100, (spend / limit) * 100);
  const working = S.agents.filter((a) => a.status === 'working').length;
  $('ticker').replaceChildren(...[
    h('span', { class: 'tk' }, h('span', { class: `state ${open ? 'open' : 'halted'}` }, open ? 'OPEN' : 'HALTED')),
    h('span', { class: 'tk' }, 'SEATS', h('b', {}, `${working}/${S.meta.capacity ?? '-'}`), S.meta.busy_window ? h('span', { title: 'busy window: reduced concurrency' }, '◐') : null),
    h('span', { class: 'tk' }, 'BURN', h('b', {}, money(spend)), h('span', { class: 'meter', title: `${pct.toFixed(0)}% of daily risk limit` }, h('i', { class: pct > 90 ? 'over' : pct > 65 ? 'hot' : '', style: `width:${pct}%` })), h('span', {}, `/ ${money(limit)}`)),
    (S.meta.providers || []).map((p) => h('button', { class: 'tk quota-link', type: 'button', title: 'View provider usage, reset times and routing', onclick: () => { S.view = 'watch'; localStorage.setItem('sd.view', 'watch'); render(); } }, p.id === 'codex' ? 'CODEX' : 'CLAUDE', h('b', { style: p.ready ? '' : 'color:var(--warn)' }, quotaSummary(p)))),
    S.meta.usage?.perplexity_desktop ? h('span', { class: 'tk', title: 'Observed Perplexity desktop credits; separate from API credits' }, 'PERPLEXITY', h('b', {}, `${Math.floor(S.meta.usage.perplexity_desktop.credits_remaining).toLocaleString()} credits`)) : null,
    h('span', { class: 'tk' }, 'WIP', h('b', {}, S.tickets.filter((t) => ['in_progress', 'qa'].includes(t.status)).length)),
    h('span', { class: 'tk' }, 'CALLS', h('b', { style: S.tickets.some((t) => t.status === 'needs_human') ? 'color:var(--warn)' : '' }, S.tickets.filter((t) => t.status === 'needs_human').length)),
    h('span', { class: 'tk', title: S.connected ? 'live' : 'reconnecting' }, h('span', { class: `status-dot ${S.connected ? 'on' : ''}` }), S.connected ? 'LIVE' : 'OFFLINE'),
  ].flat(Infinity).filter(Boolean));
  const tb = $('btn-toggle');
  tb.textContent = open ? '⏸ Pause' : '▶ Open desk';
  tb.className = `btn ${open ? '' : 'go'}`;
  tb.disabled = !S.connected || !!S.loadError;
  const banner = $('health-banner');
  const held = (S.meta.providers || []).filter((p) => p.available && !p.ready);
  const switching = Object.values(S.meta.routing || {}).some((r) => r.fallback);
  const badSources = (S.meta.watch?.sources || []).filter((s) => !s.ok || s.stale);
  const message = S.loadError ? `Unable to load desk: ${S.loadError}` : !S.connected ? 'Reconnecting to the desk. Updates will resume automatically.'
    : S.meta.preview ? 'Isolated local preview: execution seats are disabled. The live desk runs on port 8790.'
    : held.length ? `${held.map((p) => `${p.label}: ${p.reason}`).join(' · ')}. ${switching ? 'Available seats will continue on the fallback provider.' : 'Work waits until a provider is available.'}`
    : badSources.length ? `${badSources.length} log source${badSources.length > 1 ? 's' : ''} need attention. Check Reliability for details.` : '';
  banner.hidden = !message;
  banner.textContent = message;
  banner.classList.toggle('info', switching && !S.loadError);
}

// ---------------- board ----------------
function ticketCard(t) {
  const amap = agentMap();
  const live = t.active_run && amap[t.assignee]?.status === 'working' || S.agents.some((a) => a.current_ticket === t.key && a.status === 'working');
  const worker = S.agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const showProg = ['in_progress', 'qa', 'ready_for_human'].includes(t.status) || t.progress > 0;
  return h('button', { class: `card ${live ? 'live' : ''}`, type: 'button', onclick: () => openTicket(t.key) },
    h('div', { class: 'card-top' }, h('span', { class: `pri ${t.priority}` }, t.priority), h('span', {}, t.type),
      h('span', { class: 'spacer' }), t.issue_number ? h('span', { title: 'GitHub issue' }, `#${t.issue_number}`) : null, t.pr_url ? h('span', { title: 'draft PR' }, '⇡PR') : null,
      h('span', { class: 'key' }, t.key)),
    h('div', { class: 'card-title' }, nameOf(t)),
    nameOf(t) !== t.title ? h('div', { class: 'card-sub' }, t.title) : null,
    (() => {
      const kids = S.tickets.filter((x) => x.parent_key === t.key);
      if (kids.length) return h('div', { class: 'epic' }, `🧭 ${kids.length} slice${kids.length > 1 ? 's' : ''} · ${kids.filter((k) => k.status === 'done').length} merged`);
      if (t.parent_key) return h('div', { class: 'slice' }, `↳ part of ${tname(t.parent_key)}${t.after_key ? ` · after ${tname(t.after_key)}` : ''}`);
      return null;
    })(),
    h('div', { class: 'card-meta' },
      t.area ? h('span', { class: 'tag' }, t.area) : null,
      t.complexity ? h('span', { class: 'tag' }, t.complexity) : null,
      h('span', { class: 'spacer' }),
      worker && worker.id !== t.assignee ? avatar(worker.id) : null,
      t.assignee ? avatar(t.assignee) : null),
    showProg ? h('div', { class: 'prog', title: `${t.progress}% (agent estimate)` }, h('i', { style: `width:${t.progress || 0}%` })) : null,
    (live && worker?.last_action) || t.progress_msg ? h('div', { class: 'prog-msg', title: live && worker?.last_action ? worker.last_action : t.progress_msg }, live && worker?.last_action ? `▸ ${worker.last_action}` : named(t.progress_msg)) : null,
    !live && S.meta.scheduler?.waiting?.find((w) => w.key === t.key) ? h('div', { class: 'queue-reason' }, S.meta.scheduler.waiting.find((w) => w.key === t.key).reason) : null,
  );
}

function renderBoard() {
  const byStatus = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  const query = S.search.trim().toLowerCase();
  const tickets = S.tickets.filter((t) => (!query || `${t.key} ${t.title} ${t.description}`.toLowerCase().includes(query)) && (!S.assigneeFilter || t.assignee === S.assigneeFilter));
  for (const t of tickets) (byStatus[t.status] || (byStatus[t.status] = [])).push(t);
  const search = h('input', { id: 'board-search', type: 'search', placeholder: 'Search tickets…', 'aria-label': 'Search tickets', value: S.search,
    oninput: (e) => { S.search = e.target.value; render(); } });
  const assignees = h('select', { id: 'board-assignee', 'aria-label': 'Filter assignee', onchange: (e) => { S.assigneeFilter = e.target.value; render(); } },
    h('option', { value: '', selected: !S.assigneeFilter }, 'All engineers'), S.agents.filter((a) => (S.meta.engineers || []).includes(a.id)).map((a) => h('option', { value: a.id, selected: S.assigneeFilter === a.id }, a.name)));
  const toolbar = h('div', { class: 'board-toolbar' }, search, assignees,
    h('button', { class: 'pill', type: 'button', 'aria-pressed': String(S.showEmpty), onclick: () => { S.showEmpty = !S.showEmpty; render(); } }, 'Show empty stages'),
    h('button', { class: 'pill', type: 'button', 'aria-pressed': String(S.showClosed), onclick: () => { S.showClosed = !S.showClosed; S.stageFilter = 'all'; render(); } }, 'Show closed'));
  const stages = COLUMNS.filter((c) => S.showClosed || !['done', 'wontdo'].includes(c.id));
  const chips = h('div', { class: 'chips', 'aria-label': 'Filter stage' }, h('button', { class: 'chip', type: 'button', 'aria-pressed': String(S.stageFilter === 'all'), onclick: () => { S.stageFilter = 'all'; render(); } }, 'All active'), stages.map((c) => h('button', {
    class: `chip ${c.alert && byStatus[c.id].length ? 'alert' : ''}`, type: 'button', 'aria-pressed': String(S.stageFilter === c.id),
    onclick: () => { S.stageFilter = c.id; render(); },
  }, c.title, h('b', {}, byStatus[c.id].length))));
  const cols = stages.filter((c) => (S.stageFilter === 'all' || S.stageFilter === c.id) && (S.showEmpty || byStatus[c.id].length || S.stageFilter === c.id)).map((c) => h('section', { class: `col ${c.alert ? 'alert' : ''} sel` },
    h('div', { class: 'col-h' }, h('h3', {}, c.title, h('small', {}, c.sub)), h('span', { class: 'count' }, byStatus[c.id].length)),
    h('div', { class: 'col-b' }, byStatus[c.id].length ? byStatus[c.id].map(ticketCard) : h('div', { class: 'empty' }, 'No tickets in this stage.'))));
  return [h('div', { class: 'page-heading' }, h('div', {}, h('h1', {}, 'Engineering board'), h('p', {}, `${S.tickets.filter((t) => !['done', 'wontdo'].includes(t.status)).length} active tickets · ${S.agents.filter((a) => a.status === 'working').length} seats working · ${S.tickets.filter((t) => t.status === 'ready_for_human').length} ready for review`)), h('button', { class: 'btn', type: 'button', onclick: () => openTeam(false) }, 'Manage team')),
    toolbar, chips, cols.length ? h('div', { class: 'board' }, cols) : h('div', { class: 'board-empty' }, h('h2', {}, query || S.assigneeFilter ? 'No matching tickets' : 'Your board is clear'), h('p', {}, query || S.assigneeFilter ? 'Try another search or engineer.' : 'Create a ticket to give the team work.'))];
}

// ---------------- floor (team) ----------------
const lastSay = (id) => [...S.events].reverse().find((e) => e.agent_id === id && e.kind === 'say');

function deskCard(a) {
  const pr = presenceOf(a);
  const working = a.status === 'working';
  const say = lastSay(a.id);
  const fresh = say && Date.now() - Date.parse(say.ts) < 3 * 60_000;
  const mate = a.meeting ? agentMap()[a.meeting] : null;
  const lines = S.events.filter((e) => e.agent_id === a.id && ['tool', 'action', 'pickup', 'done', 'error', 'run'].includes(e.kind)).slice(-4);
  return h('button', { class: `deskc ${pr.key}`, type: 'button', onclick: () => openSeat(a.id) },
    fresh ? h('div', { class: 'bubble' }, say.text.length > 160 ? `${say.text.slice(0, 159)}…` : say.text) : null,
    h('div', { class: 'deskc-h' }, avatar(a.id, 'lg'),
      h('div', { class: 'who' }, h('b', {}, a.name), h('span', {}, a.role)),
      seatModel(a)),
    h('div', { class: 'presence' }, h('span', { class: `pdot ${pr.key}` }), h('span', {}, pr.text),
      mate ? h('span', { class: 'meet' }, avatar(mate.id), `with ${mate.name}`) : null,
      working && a.current_ticket ? h('span', { class: 'on-k mono' }, a.current_ticket) : null,
      h('span', { class: 'spacer' }), h('span', { class: 'ago' }, a.last_action_at ? ago(a.last_action_at) : '')),
    h('div', { class: `monitor ${working ? 'on' : ''}` }, lines.length
      ? lines.map((e) => h('div', { class: `ml ${e.kind}` }, h('span', { class: 't' }, hhmm(e.ts).slice(0, 5)), ` ${e.text}`))
      : h('div', { class: 'ml idle' }, working ? 'starting…' : 'screen asleep'), working ? h('span', { class: 'cursor' }, '▍') : null),
    h('div', { class: 'deskc-f' }, h('span', {}, a.bio || ''), h('span', { class: 'mono burn' }, money(a.spend_today))));
}

function renderFloor() {
  const amap = agentMap();
  const working = S.agents.filter((a) => a.status === 'working');
  const pods = [
    ['Product & management', 'The ideas pit', ['pm', 'manager']],
    ['Engineering', 'Execution desk', ['principal-be', 'principal-fe', 'senior-be', 'senior-fe', 'dba', 'junior']],
    ['Quality, reliability & support', 'Risk, on-call & client desk', ['qa', 'sre', 'support']],
  ];
  return [
    h('div', { class: 'floor-h' },
      h('div', {}, h('b', {}, working.length ? `${working.length} on the floor` : 'Floor is quiet'),
        h('span', {}, working.length ? ` · ${working.map((a) => a.name).join(', ')}` : S.settings.paused === 'true' ? ' · desk halted — press Open desk' : ' · waiting for orders')),
      h('div', { class: 'flow' }, ['Intake', 'Research', 'Groom + huddle', 'Execute', 'Risk check', 'Confirmation', 'Draft PR', 'You merge']
        .flatMap((x, i) => (i ? [h('span', {}, '›'), h('span', { class: 'step' }, x)] : [h('span', { class: 'step' }, x)])))),
    pods.map(([title, sub, ids]) => [h('div', { class: 'section-title' }, title, h('span', {}, ` · ${sub}`)),
      h('div', { class: 'floor' }, ids.filter((id) => amap[id]).map((id) => deskCard(amap[id])))]),
  ];
}

// ---------------- tape ----------------
const TAPE_FILTERS = { all: () => true, watch: (e) => e.agent_id === 'sre', work: (e) => ['action', 'pickup', 'done', 'github', 'created'].includes(e.kind), talk: (e) => ['say', 'plan'].includes(e.kind), tools: (e) => e.kind === 'tool', errors: (e) => e.kind === 'error' };
let lastSeenEvent = 0;

function evRow(e, compact = false) {
  const fresh = e.id > lastSeenEvent;
  return h('div', { class: `ev ${e.kind} ${fresh ? 'fresh' : ''}` },
    h('span', { class: 't' }, hhmm(e.ts)),
    e.agent_id ? avatar(e.agent_id) : h('span', {}),
    compact ? null : h('span', { class: 'kcol' }, e.ticket_key ? h('button', { class: 'k', type: 'button', title: e.ticket_key, onclick: () => openTicket(e.ticket_key) }, tname(e.ticket_key)) : ''),
    h('span', { class: 'x' }, e.text));
}

function renderTape() {
  const evs = S.events.filter(TAPE_FILTERS[S.tapeFilter]).slice(-300).reverse();
  const out = [
    h('div', { class: 'tape-filters' }, Object.keys(TAPE_FILTERS).map((f) => h('button', { class: 'pill', type: 'button', 'aria-pressed': String(S.tapeFilter === f), onclick: () => { S.tapeFilter = f; render(); } }, f))),
    h('div', { class: 'tape' }, evs.length ? evs.map((e) => evRow(e)) : h('div', { class: 'empty' }, 'The tape is quiet.')),
  ];
  return out;
}

// ---------------- watch (incidents) ----------------
const INC_STATUS = { watching: 'Watching', investigating: 'Investigating', ticketed: 'Ticketed', paged: 'Paged you', foreign: 'Other project', muted: 'Muted', resolved: 'Resolved' };

function incidentCard(i) {
  const samples = JSON.parse(i.samples || '[]');
  const ticket = i.ticket_key ? h('button', { class: 'linkish mono', type: 'button', onclick: () => openTicket(i.ticket_key) }, i.ticket_key) : null;
  const btn = (label, action, cls = '') => h('button', { class: `btn small ${cls}`, type: 'button', onclick: act(() => api('POST', `/api/incidents/${i.id}`, { action }), label.toLowerCase()) }, label);
  return h('div', { class: `inc ${i.status}` },
    h('div', { class: 'inc-h' }, h('span', { class: `inc-s ${i.status}` }, INC_STATUS[i.status] || i.status), h('span', { class: 'mono lbl' }, i.label),
      i.project !== S.meta.project ? h('span', { class: 'tag' }, i.project) : null, h('span', { class: 'spacer' }),
      h('span', { class: 'mono cnt', title: `${i.window_count ?? 0} in the last ${S.meta.watch?.window_minutes} min` }, `${i.window_count ?? 0}/w · ${i.count}×`)),
    h('div', { class: 'inc-m mono' }, i.normalized),
    h('div', { class: 'inc-f' }, h('span', {}, `last ${ago(i.last_seen)} · first ${ago(i.first_seen)}`), ticket, i.note ? h('span', { class: 'note' }, `· ${i.note}`) : null),
    samples.length ? h('details', { class: 'work' }, h('summary', {}, `${samples.length} sample line${samples.length > 1 ? 's' : ''}`), h('div', { class: 'work-l' }, samples.map((x) => h('div', {}, `${hhmm(x.ts)} ${x.line}`)))) : null,
    h('div', { class: 'row-actions' },
      ['watching'].includes(i.status) ? btn('Investigate now', 'investigate') : null,
      ['watching', 'paged', 'foreign'].includes(i.status) ? btn('Mute', 'mute', 'danger') : null,
      i.status === 'muted' ? btn('Unmute', 'unmute') : null));
}

function renderWatch() {
  const w = S.meta.watch || {};
  const runtime = renderRuntime();
  if (!w.enabled) {
    return [runtime, h('div', { class: 'settings' }, h('div', { class: 'set', style: 'flex-direction:column;align-items:stretch' },
      h('label', {}, 'The watch desk is off'),
      h('p', {}, 'Enable "watch" in sigmadesk.config.json with a Loki, docker or file source. A deterministic watcher fingerprints errors and wakes the SRE seat only for new, recurring signatures.')))];
  }
  const groups = [['Needs attention', ['investigating', 'watching', 'paged']], ['Handed to the team', ['ticketed', 'foreign']], ['Quiet', ['muted', 'resolved']]];
  const sre = agentMap().sre;
  return [
    runtime,
    h('div', { class: 'section-title' }, 'Production log monitoring'),
    h('div', { class: 'watch-h' },
      sre ? h('div', { class: 'oncall' }, avatar('sre', 'lg'), h('div', {}, h('b', {}, `${sre.name} is on call`), h('div', { class: 'presence' }, h('span', { class: `pdot ${presenceOf(sre).key}` }), presenceOf(sre).text))) : null,
      h('div', { class: 'sources' }, (w.sources || []).map((src) => h('span', { class: `src ${src.ok && !src.stale ? 'ok' : 'bad'}`, title: src.error || '' },
        h('span', { class: `pdot ${src.ok && !src.stale ? 'working' : 'reviewing'}` }), `${src.type} · ${src.project}`, h('span', { class: 'mono' }, src.stale ? ' Poll overdue' : src.ok ? ` ${src.lines} lines · ${ago(src.lastPoll)}` : ` ${src.error}`))),
        !w.sources?.length ? h('span', { class: 'src bad' }, 'No log sources configured') : null,
        h('span', { class: 'hint' }, `New signature → SRE after ${w.min_count}+ hits in ${w.window_minutes} min`))),
    groups.map(([title, sts]) => {
      const items = S.incidents.filter((i) => sts.includes(i.status));
      return [h('div', { class: 'section-title' }, `${title} (${items.length})`),
        items.length ? h('div', { class: 'incs' }, items.map(incidentCard)) : h('div', { class: 'empty' }, title === 'Needs attention' ? 'No error signatures right now.' : '—')];
    }),
  ];
}

function renderRuntime() {
  const s = S.meta.scheduler || {};
  return [h('div', { class: 'page-heading' }, h('div', {}, h('h1', {}, 'Reliability desk'), h('p', {}, 'Provider availability, queue health and production incidents'))),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: act(async () => { await api('POST', '/api/providers/refresh', {}); await loadSnapshot(); }, 'provider usage refreshed') }, 'Refresh provider usage')),
    h('div', { class: 'runtime-grid' },
      h('div', { class: 'runtime-card' }, h('span', { class: 'eyebrow' }, 'Scheduler'), h('h2', {}, s.paused ? 'Paused' : 'Running'), h('p', {}, s.last_tick ? `Last tick ${ago(s.last_tick)} · ${s.queued || 0} queued` : 'Waiting for the first tick'), h('p', {}, `${money(Math.max(0, s.budget_headroom || 0))} budget headroom`)),
      (S.meta.providers || []).map((p) => h('div', { class: `runtime-card ${p.ready ? 'healthy' : 'held'}` }, h('span', { class: 'eyebrow' }, p.label), h('h2', {}, p.ready ? 'Ready' : p.available ? 'On hold' : 'Unavailable'), h('p', {}, p.reason || p.version),
        quotaWindows(p.quota).map((w) => h('div', { class: 'usage-window' }, h('div', { class: 'usage-row' }, h('b', {}, windowLabel(w)), h('b', {}, w.resets_at && Date.parse(w.resets_at) <= Date.now() ? 'Reset passed' : `${Math.round(w.remaining_percent)}% remaining`)),
          h('div', { class: 'usage-meter' }, h('i', { style: `width:${w.remaining_percent}%` })), h('small', {}, `${Math.round(w.used_percent)}% used${w.resets_at ? ` · resets ${new Date(w.resets_at).toLocaleString()}` : ' · reset time not reported'}`))),
        !quotaWindows(p.quota).length ? h('p', {}, 'Usage has not been reported. Unknown does not mean zero.') : null,
        h('small', {}, p.quota?.at ? `${p.quota.source || 'CLI report'} · ${ago(p.quota.at)}` : 'Awaiting account usage'),
        p.id === 'codex' && S.meta.usage?.codex?.ok === false ? h('p', { class: 'warn' }, `Usage refresh failed: ${S.meta.usage.codex.error}`) : null,
        p.retry_at ? h('p', {}, `Retry after ${new Date(p.retry_at).toLocaleString()}`) : null)),
      h('div', { class: 'runtime-card' }, h('span', { class: 'eyebrow' }, 'Perplexity desktop'),
        h('h2', {}, S.meta.usage?.perplexity_desktop ? `${Math.floor(S.meta.usage.perplexity_desktop.credits_remaining).toLocaleString()} credits` : 'Balance unknown'),
        h('p', {}, 'Desktop reviews use your signed-in subscription. API credentials and API credit balance are separate.'),
        h('small', {}, S.meta.usage?.perplexity_desktop ? `Observed snapshot · ${ago(S.meta.usage.perplexity_desktop.at)} · reset time unknown` : 'Check Usage & Billing in the Perplexity app.')),
      ['perplexity', 'gemini', 'xai'].map((id) => h('div', { class: 'runtime-card' }, h('span', { class: 'eyebrow' }, `${id === 'xai' ? 'xAI' : id[0].toUpperCase() + id.slice(1)} API · advisory`),
        h('h2', {}, S.meta.advisors?.api_configured?.[id] ? 'Key configured' : 'Key required'), h('p', {}, 'Remaining API balance is not reported. Bounded reviews count against the desk budget.'),
        S.meta.advisors?.provider_errors?.[id] ? h('p', { class: 'warn' }, S.meta.advisors.provider_errors[id]) : null))),
    h('p', { class: 'runtime-note' }, S.meta.usage?.policy || 'Automatic provider selection retains the seat role, budget and QA requirements.'),
    h('div', { class: 'runtime-note' }, h('span', {}, `Automatic provider fallback ${S.settings.auto_fallback === 'true' ? 'enabled' : 'disabled'} · saved team preferences are retained`), h('button', { class: 'linkish', type: 'button', onclick: () => openTeam(false) }, 'Manage team')),
    h('div', { class: 'section-title' }, 'Engineer routing'),
    h('p', { class: 'bio' }, 'The scheduler checks provider usage, availability and budget before each job. These are the routes for the next job; running jobs retain their current model.'),
    h('div', { class: 'routing-table' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Engineer / role', 'Preferred', 'Next job', 'Selection reason'].map((label) => h('th', { scope: 'col' }, label)))),
      h('tbody', {}, S.agents.map((a) => { const r = S.meta.routing?.[a.id] || {}; return h('tr', {},
        h('th', { scope: 'row' }, a.name, h('small', {}, a.role)), h('td', {}, `${a.engine} · ${a.model || 'account default'}`),
        h('td', {}, r.engine ? `${r.engine} · ${r.model || 'account default'}` : 'Waiting', h('small', {}, r.engine ? `${r.tier || 'strong'} tier · ${r.effort || 'default'} effort` : '')),
        h('td', {}, r.fallback ? `Fallback: ${r.reason}` : r.reason || 'Saved team preference')); })))),
    s.last_error ? h('div', { class: 'runtime-note warn' }, `Last scheduler error: ${s.last_error.seat} · ${s.last_error.message} · ${ago(s.last_error.at)}`) : null];
}

// ---------------- settings / limits ----------------
function setRow(label, help, control) { return h('div', { class: 'set' }, h('div', {}, h('label', {}, label), h('p', {}, help)), control); }
function numSetting(key, step = 1) {
  return h('input', { type: 'number', 'aria-label': key.replaceAll('_', ' '), min: key === 'daily_budget_usd' ? '0' : '1', step: String(step), value: S.settings[key], onchange: act((e) => api('POST', '/api/settings', { key, value: e.target.value }), 'saved') });
}
function boolSetting(key) {
  const el = h('input', { type: 'checkbox', class: 'switch', 'aria-label': key.replaceAll('_', ' '), onchange: act((e) => api('POST', '/api/settings', { key, value: String(e.target.checked) }), 'saved') });
  el.checked = S.settings[key] === 'true';
  return el;
}

function renderSettings() {
  const focus = h('input', { type: 'text', placeholder: 'optional focus, e.g. "0DTE risk visibility"', style: 'width:100%' });
  const amap = agentMap();
  return h('div', { class: 'settings' },
    h('div', { class: 'section-title' }, 'Team'),
    h('div', { class: 'set', style: 'flex-direction:column;align-items:stretch' },
      h('div', { class: 'team-strip' }, S.agents.map((a) => h('span', { class: 'ts', title: `${a.name} · ${a.role}` }, avatar(a.id), h('span', { class: 'mono' }, `${a.engine === 'codex' ? 'codex' : a.model}${a.engine === 'codex' && a.model ? `/${a.model}` : ''}·${a.effort || ''}`)))),
      h('div', { class: 'row-actions' }, h('span', { style: 'flex:1;color:var(--muted);font-size:12px' }, S.settings.team_confirmed === 'true' ? 'Each seat runs on its own engine, model and effort.' : 'Not confirmed yet — the desk asks before it first opens.'),
        h('button', { class: 'btn', type: 'button', onclick: () => openTeam(false) }, 'Edit team'))),
    h('div', { class: 'section-title' }, 'Risk limits'),
    setRow('Automatic provider fallback', 'When credits run low or a provider is unavailable, seats use the other installed provider. Daily budget, concurrency and review gates still apply.', boolSetting('auto_fallback')),
    setRow('Max concurrent seats', 'How many agents may run at once (a busy window in the config can lower this).', numSetting('max_concurrent')),
    setRow('Daily risk limit (USD)', 'Notional model spend per day. Each running seat reserves its per-run cap.', numSetting('daily_budget_usd', 5)),
    h('div', { class: 'section-title' }, 'Architecture Review Board'),
    h('p', { class: 'bio' }, 'On-demand specialist reviewers challenge an RFC. The design owner records the decision in an ADR; engineers implement it and QA verifies it.'),
    h('div', { class: 'advisor-grid' }, (S.meta.advisors?.roster || []).map((a) => h('div', { class: 'advisor-card' },
      h('b', {}, `${a.name} · ${a.role}`), h('span', { class: 'tag' }, S.meta.advisors.models.find((m) => m.id === a.model)?.label || a.model),
      h('p', {}, a.charter), h('small', {}, a.api_configured ? 'API credentials configured · authentication checked on use' : 'Use Perplexity desktop · API credentials needed for unattended reviews')))),
    h('p', { class: 'bio' }, S.meta.advisors?.note || 'Open a ticket to create an architecture review brief.'),
    h('div', { class: 'section-title' }, 'Background operation'),
    h('div', { class: 'set' }, h('div', {}, h('label', {}, 'Works while the screen is locked'), h('p', {}, S.meta.background?.desktop_reviews || 'CLI engineers and the watcher run independently of desktop controls.'),
      h('p', {}, S.meta.background?.idle_sleep_inhibited ? 'Idle system sleep is inhibited while the desk is running.' : 'The computer must remain awake for background work.'), h('small', {}, S.meta.background?.limits || ''))),
    h('div', { class: 'section-title' }, 'Product research'),
    setRow('PM research enabled', 'The Principal PM proposes features on a cadence while the funnel is thin.', boolSetting('pm_enabled')),
    setRow('Research cadence (minutes)', 'Minimum gap between PM research sessions.', numSetting('pm_interval_min', 30)),
    setRow('Max open proposals', 'PM stops proposing while this many ideas await grooming.', numSetting('max_open_proposals')),
    h('div', { class: 'set', style: 'flex-direction:column;align-items:stretch' },
      h('div', {}, h('label', {}, 'Ask the PM for research now'), h('p', {}, 'Starts a research session immediately (counts against limits).')), focus,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: act(() => api('POST', '/api/control/research', { focus: focus.value }), 'PM is researching') }, 'Start research'))),
    h('div', { class: 'section-title' }, 'GitHub'),
    setRow('Sync issues', `Mirror tickets, status labels and comments to ${S.meta.repo || 'GitHub'}.`, boolSetting('github_sync')),
    setRow('Open draft PRs', 'After QA passes, push the branch and open a draft PR for your review. Nothing is ever merged automatically.', boolSetting('open_draft_prs')),
  );
}

// ---------------- sheets ----------------
async function openArchitecture(key) {
  const sh = { type: 'architecture', key, mode: 'council', council: null, ownerNote: '', councilModels: S.meta.council, councilDraft: structuredClone(S.meta.council?.defaults || {}), review: null, imported: '', draft: { reviewer: 'perplexity/kimi-k3', challenger: 'xai/grok-4.7', question: '' } };
  S.sheet = sh;
  renderSheet();
  try {
    [sh.models, sh.councilModels] = await Promise.all([api('GET', '/api/advisors'), api('GET', '/api/councils')]);
    if (!sh.councilDraft.members) sh.councilDraft = structuredClone(sh.councilModels.defaults);
    if (S.sheet === sh) renderSheet();
  } catch (e) { toast(e.message, true); }
}

function renderDesktopReviewSheet() {
  const sh = S.sheet;
  if (sh?.type !== 'architecture') return;
  const r = sh.review, d = sh.models || S.meta.advisors;
  const head = [h('div', { class: 'row' }, h('h2', {}, `Architecture review · ${sh.key}`), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
    h('p', { class: 'bio' }, 'Desktop imports and sequential API challenges. Use the council for parallel independent reviews.'), reviewModes(sh)];
  if (!d?.models) return sheetShell(head, h('p', {}, 'Loading specialist models…'));
  const select = (field, label, optional = false) => h('div', { class: 'field' }, h('label', { for: `review-${field}` }, label),
    h('select', { id: `review-${field}`, 'aria-label': label, onchange: (e) => { sh.draft[field] = e.target.value; if (field === 'reviewer' && $('review-fit')) $('review-fit').textContent = d.models.find((m) => m.id === e.target.value)?.fit || ''; } },
      optional ? h('option', { value: '', selected: !sh.draft[field] }, 'Single reviewer') : null,
      d.models.map((m) => h('option', { value: m.id, selected: m.id === sh.draft[field] }, `${m.label} · ${m.api_configured ? 'API configured' : m.desktop_verified ? 'desktop verified' : 'API key needed'}`))));
  const refresh = async () => { if (!r) return; const next = await api('GET', `/api/architecture-reviews/${r.id}`); if (S.sheet === sh) { sh.review = next; renderSheet(); } };
  const modelName = (id) => d.models.find((m) => m.id === id)?.label || id;
  const body = r ? [
    h('div', { class: 'review-status' }, h('b', {}, `${modelName(r.reviewer)}${r.challenger ? ` → ${modelName(r.challenger)}` : ''}`), h('span', { class: 'tag' }, r.status.replaceAll('_', ' '))),
    r.error ? h('p', { class: 'warn' }, r.error) : null,
    r.result ? h('pre', { class: 'review-text' }, r.result) : null,
    h('details', {}, h('summary', {}, 'Review brief'), h('pre', { class: 'review-text' }, r.brief)),
    r.status === 'awaiting_result' ? [
      h('p', { class: 'bio' }, 'Perplexity desktop: click the model pill below the composer to switch models. Paste this brief. To debate, switch to the challenger and ask it to critique the first response. Paste the final report below.'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: act(() => navigator.clipboard.writeText(r.brief), 'brief copied') }, 'Copy brief for Perplexity'),
        h('button', { class: 'btn primary', type: 'button', disabled: S.settings.paused === 'true' || [r.reviewer, r.challenger].filter(Boolean).some((id) => !d.models.find((m) => m.id === id)?.api_configured), onclick: act(async () => {
          await api('POST', `/api/architecture-reviews/${r.id}/run`, {}); await refresh();
        }, 'API review started') }, 'Run via API')),
      h('small', {}, `API reviews reserve ${money((r.challenger ? 2 : 1) * d.reserve_per_model_usd)} from the daily risk limit. ${S.settings.paused === 'true' ? 'Open the desk to enable API execution.' : 'Configured keys are checked on use.'}`),
      (() => { const input = h('textarea', { 'aria-label': 'Peer review result', placeholder: 'Paste the review and independent challenge…', rows: '6', oninput: (e) => { sh.imported = e.target.value; } }); input.value = sh.imported; return input; })(),
      h('button', { class: 'btn', type: 'button', onclick: act(async () => { sh.review = await api('POST', `/api/architecture-reviews/${r.id}/import`, { result: sh.imported }); renderSheet(); }, 'peer review attached to ticket') }, 'Attach desktop review'),
    ] : null,
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: act(refresh) }, 'Refresh status'),
      r.status !== 'running' ? h('button', { class: 'btn', type: 'button', onclick: () => { sh.review = null; sh.imported = ''; renderSheet(); } }, 'New review') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => openTicket(sh.key) }, 'Back to ticket')),
  ] : [select('reviewer', 'Design reviewer'), select('challenger', 'Independent challenger', true),
    h('p', { class: 'bio', id: 'review-fit' }, d.models.find((m) => m.id === sh.draft.reviewer)?.fit || 'Choose a specialist for this question.'),
    (() => { const q = h('textarea', { 'aria-label': 'Review question', placeholder: 'What assumptions or tradeoffs should the reviewers challenge?', rows: '4', oninput: (e) => { sh.draft.question = e.target.value; } }); q.value = sh.draft.question; return q; })(),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => { sh.review = await api('POST', `/api/tickets/${sh.key}/architecture-reviews`, sh.draft); renderSheet(); }, 'review brief created') }, 'Create review brief'),
      h('button', { class: 'btn', type: 'button', onclick: () => openTicket(sh.key) }, 'Back to ticket')),
    (d.reviews || []).filter((x) => x.ticket_key === sh.key).length ? h('div', { class: 'mini-list' }, d.reviews.filter((x) => x.ticket_key === sh.key).map((x) => h('button', { class: 'mini-t', type: 'button', onclick: act(async () => { sh.review = await api('GET', `/api/architecture-reviews/${x.id}`); renderSheet(); }) }, `Review #${x.id} · ${modelName(x.reviewer)} · ${x.status}`))) : null,
  ];
  sheetShell(head, body);
}

function reviewModes(sh) {
  return h('div', { class: 'row-actions review-modes', 'aria-label': 'Review mode' },
    ['council', 'legacy'].map((mode) => h('button', { class: `btn ${sh.mode === mode ? 'primary' : ''}`, type: 'button', 'aria-pressed': sh.mode === mode ? 'true' : 'false', onclick: () => { sh.mode = mode; renderSheet(); } }, mode === 'council' ? 'Model council' : 'Desktop / API review')));
}
function councilReport(text) {
  let r; try { r = JSON.parse(text); } catch { return h('pre', { class: 'review-text' }, text); }
  return h('div', { class: 'council-report' },
    h('div', { class: 'review-status' }, h('b', {}, 'Recommendation'), h('span', { class: 'tag' }, r.verdict)),
    h('p', {}, r.recommendation),
    (r.findings || []).map((f) => h('div', { class: 'council-finding' }, h('b', {}, `${f.severity} · ${f.issue}`), h('p', { class: 'bio' }, f.evidence), h('p', {}, `Test: ${f.test}`))),
    ['alternatives', 'dissent', 'conditions'].filter((k) => r[k]?.length).map((k) => h('div', {}, h('b', {}, k === 'dissent' ? 'Unresolved dissent' : k === 'conditions' ? 'Required validation' : 'Alternatives'), h('ul', {}, r[k].map((v) => h('li', {}, v))))));
}
function renderArchitectureSheet() {
  const sh = S.sheet;
  if (sh?.type !== 'architecture') return;
  if (sh.mode === 'legacy') return renderDesktopReviewSheet();
  const d = sh.councilModels || S.meta.council, c = sh.council, draft = sh.councilDraft;
  const head = [h('div', { class: 'row' }, h('h2', {}, `Engineering council · ${sh.key}`), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
    h('p', { class: 'bio' }, 'Independent reviews run in parallel. A principal weighs evidence, alternatives and dissent. You decide what happens next.'), reviewModes(sh)];
  if (!d?.models || !draft.members) return sheetShell(head, h('p', {}, 'Loading approved models…'));
  const label = (id) => d.models.find((m) => m.id === id)?.label || id;
  const ready = c?.members.every((m) => m.status !== 'pending' || d.models.find((x) => x.id === m.model)?.ready);
  const load = async (id) => { const next = await api('GET', `/api/councils/${id}`); if (S.sheet === sh) { sh.council = next; renderSheet(); } };
  const action = (name) => act(async () => { sh.council = await api('POST', `/api/councils/${c.id}/${name}`, {}); if (S.sheet === sh) renderSheet(); }, name === 'run' ? 'council queued' : name === 'retry' ? 'failed calls queued; completed reviews reused' : 'council cancelled');
  const modelSelect = (id, value, change) => h('select', { id, 'aria-label': id.startsWith('council-reviewer') ? `Reviewer ${id.slice(-1)} model` : 'Synthesis model', onchange: (e) => { change(e.target.value); renderSheet(); } }, d.models.map((m) => h('option', { value: m.id, selected: m.id === value }, `${m.label} · ${m.ready ? 'ready' : m.reason || 'connection required'}`)));
  const rows = draft.members.map((m, i) => h('div', { class: 'council-selection' }, h('label', { for: `council-reviewer-${i + 1}` }, `Reviewer ${i + 1}`), modelSelect(`council-reviewer-${i + 1}`, m.model, (v) => { m.model = v; }),
    h('label', { for: `council-lens-${i}` }, 'Review lens'), h('select', { id: `council-lens-${i}`, 'aria-label': `Reviewer ${i + 1} lens`, onchange: (e) => { m.lens = e.target.value; } }, Object.keys(d.lenses).map((l) => h('option', { value: l, selected: l === m.lens }, l)))));
  const reserve = draft.members.reduce((n, m) => n + (d.models.find((x) => x.id === m.model)?.reserve_usd || 0), 0) * (draft.challenge ? 2 : 1) + (d.models.find((m) => m.id === draft.synthesizer)?.reserve_usd || 0);
  const body = c ? [
    h('div', { class: 'review-status' }, h('b', {}, `Council #${c.id}`), h('span', { class: 'tag' }, c.status), c.decision ? h('span', { class: 'tag' }, `Owner: ${c.decision}`) : null),
    h('p', { class: 'bio' }, `Chair: ${agentMap()[c.chair]?.name || c.chair} · ${c.strategy} · input ${c.input_hash.slice(0, 10)} · ${money(c.members.reduce((n, m) => n + m.reserve_usd, 0))} maximum reservation`),
    c.stale ? h('p', { class: 'warn' }, 'Ticket evidence changed. Create a fresh council before making a decision.') : null,
    c.error ? h('p', { class: 'warn' }, c.error) : null,
    ['queued','running'].includes(c.status) ? h('p', { class: 'bio', role: 'status' }, S.settings.paused === 'true' ? 'Queued until the desk opens.' : 'Up to two calls run at once; one slot stays available for QA or SRE. Each planned call is reserved.') : null,
    c.result ? councilReport(c.result) : null,
    h('div', { class: 'council-members' }, c.members.map((m) => h('details', {}, h('summary', {}, `${m.stage === 'synthesis' ? 'Principal synthesis' : `${m.stage === 'challenge' ? 'Challenge' : 'Reviewer'} ${m.ordinal + 1}`} · ${m.lens} · ${label(m.model)} · ${m.status === 'preparing' && m.run_id ? 'running' : m.status}`),
      h('p', { class: 'bio' }, m.run ? `${m.run.model} · ${m.run.status} · ${m.run.ended_at ? `${money(m.run.cost_usd)}${m.run.cost_estimated ? ' estimated' : ' reported'}` : `${money(m.reserve_usd)} reserved`}` : `${money(m.reserve_usd)} per-call reservation`),
      m.error ? h('p', { class: 'warn' }, m.error) : null, m.result ? councilReport(m.result) : null))),
    h('details', {}, h('summary', {}, 'Frozen review brief'), h('pre', { class: 'review-text' }, c.brief)),
    h('div', { class: 'row-actions' }, c.status === 'draft' ? h('button', { class: 'btn primary', type: 'button', disabled: !ready || c.stale, onclick: action('run') }, S.settings.paused === 'true' ? 'Queue council' : 'Start council') : null,
      ['draft','queued','running'].includes(c.status) ? h('button', { class: 'btn danger', type: 'button', onclick: action('cancel') }, 'Cancel council') : null,
      ['partial','failed','cancelled'].includes(c.status) && !c.stale ? h('button', { class: 'btn', type: 'button', onclick: action('retry') }, 'Retry failed calls') : null,
      h('button', { class: 'btn', type: 'button', onclick: act(() => load(c.id)) }, 'Refresh'),
      !['running','queued'].includes(c.status) ? h('button', { class: 'btn', type: 'button', onclick: () => { sh.council = null; sh.ownerNote = ''; renderSheet(); } }, 'New council') : null),
    c.status === 'draft' && !ready ? h('p', { class: 'warn' }, 'Choose ready models to run automatically. Perplexity desktop OAuth and API keys are separate connections; use Desktop / API review for a manual brief.') : null,
  ] : [h('div', { class: 'council-grid' }, rows),
    h('div', { class: 'field' }, h('label', { for: 'council-synthesizer' }, 'Principal synthesis model'), modelSelect('council-synthesizer', draft.synthesizer, (v) => { draft.synthesizer = v; })),
    (() => { const q = h('textarea', { id: 'council-question', 'aria-label': 'Council question', placeholder: 'What decision should the council assess? Include constraints or evidence.', rows: '3', maxlength: '2000', oninput: (e) => { draft.question = e.target.value; } }); q.value = draft.question || ''; return q; })(),
    h('label', { class: 'council-check' }, h('input', { type: 'checkbox', checked: !!draft.challenge, onchange: (e) => { draft.challenge = e.target.checked; renderSheet(); } }), 'One blinded challenge if reviewers disagree'),
    h('p', { class: 'bio' }, `Maximum ${money(reserve)} reserved for all reviewers, any challenge and synthesis. Reservations limit local scheduling; providers may bill differently. Automatic triggers are off.`),
    h('p', { class: 'bio' }, d.computer?.enabled
      ? `Perplexity Computer councils: ${d.computer.connected ? 'enabled; Perplexity models are listed above by model family and bill your account credits per task. ' : `enabled but unavailable (${d.computer.reason}). `}`
      : 'Perplexity Computer councils: verification pending (engines.perplexity.councilEnabled is off). Thinking-seat relay connectivity is shown under providers; desktop credit snapshots do not verify council execution. ',
      h('a', { href: d.computer?.guide_url, target: '_blank', rel: 'noopener noreferrer' }, 'Official connection guide')),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => { sh.council = await api('POST', `/api/tickets/${sh.key}/councils`, draft); renderSheet(); }, 'frozen council brief created') }, 'Create council'),
      h('button', { class: 'btn', type: 'button', onclick: () => { if (draft.members.length < 3) draft.members.push({ model: d.models.find((m) => m.ready && !draft.members.some((p) => d.models.find((x) => x.id === p.model)?.family === m.family))?.id || d.models.find((m) => !draft.members.some((p) => d.models.find((x) => x.id === p.model)?.family === m.family))?.id || draft.members[0].model, lens: 'delivery' }); else draft.members.pop(); renderSheet(); } }, draft.members.length === 3 ? 'Remove third reviewer' : 'Add third reviewer')),
    h('div', { class: 'mini-list' }, (d.councils || []).filter((x) => x.ticket_key === sh.key).map((x) => h('button', { class: 'mini-t', type: 'button', onclick: act(() => load(x.id)) }, `Council #${x.id} · ${x.status}${x.decision ? ` · ${x.decision}` : ''}`))),
  ];
  const decision = (value) => act(async () => { const next = await api('POST', `/api/councils/${c.id}/decision`, { decision: value, message: sh.ownerNote }); sh.council = next.followup || next.council; sh.ownerNote = ''; renderSheet(); }, value === 'correction' ? 'corrections queued for a fresh council' : 'design decision recorded');
  const footer = c && ['complete','partial'].includes(c.status) && !c.decision ? h('div', { class: 'ticket-footer council-footer' },
    (() => { const note = h('textarea', { id: 'council-owner-note', 'aria-label': 'Council decision message', placeholder: 'Add a note, or describe the correction…', rows: '2', maxlength: '2000', oninput: (e) => { sh.ownerNote = e.target.value; if ($('council-correction')) $('council-correction').disabled = c.stale || !sh.ownerNote.trim(); } }); note.value = sh.ownerNote; return note; })(),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', disabled: c.stale || c.status === 'partial', onclick: decision('approve') }, 'Approve'),
      h('button', { class: 'btn', id: 'council-correction', type: 'button', disabled: c.stale || !sh.ownerNote.trim(), onclick: decision('correction') }, 'Needs correction'),
      h('button', { class: 'btn danger', type: 'button', disabled: c.stale, onclick: decision('reject') }, 'Reject')),
    h('small', {}, 'Records a design decision. Implementation, QA and final merge keep their existing approvals.')) : null;
  sheetShell(head, body, footer);
}

let returnFocus = null;
function closeSheet() {
  S.sheet = null;
  $('sheet').hidden = true;
  $('sheet').replaceChildren();
  document.body.classList.remove('dialog-open');
  returnFocus?.focus();
  returnFocus = null;
  history.replaceState(null, '', location.pathname);
}

async function openTicket(key) {
  const sh = { type: 'ticket', key, detail: null, reply: '' };
  S.sheet = sh;
  history.replaceState(null, '', `#${key}`);
  renderSheet();
  try {
    const detail = await api('GET', `/api/tickets/${key}`);
    if (S.sheet === sh) sh.detail = detail;
  } catch (e) { if (S.sheet === sh) sh.error = e.message; toast(e.message, true); }
  if (S.sheet?.key === key) renderSheet();
}

async function openSeat(id) {
  S.sheet = { type: 'seat', id, events: null };
  renderSheet();
  loadSeat(id);
}

function sheetShell(head, body, footer = null) {
  const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'sheet-h' }, head), h('div', { class: 'sheet-b' }, body), footer);
  const sheet = $('sheet');
  const firstOpen = sheet.hidden;
  const focusedId = sheet.contains(document.activeElement) ? document.activeElement.id : null;
  const focusedSelection = focusedId ? document.activeElement.selectionStart : null;
  if (firstOpen) returnFocus = document.activeElement;
  const opened = [...sheet.querySelectorAll('details')].map((d) => d.open);
  const prevScroll = sheet.querySelector('.sheet-b')?.scrollTop;
  const logEl = sheet.querySelector('.log');
  const atBottom = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  sheet.replaceChildren(panel);
  sheet.hidden = false;
  document.body.classList.add('dialog-open');
  panel.setAttribute('aria-label', panel.querySelector('h2')?.textContent || 'Ticket details');
  [...panel.querySelectorAll('details')].forEach((d, i) => { if (i < opened.length) d.open = opened[i]; });
  if (firstOpen) panel.querySelector('button, input, textarea, select')?.focus();
  else if (focusedId) {
    const next = $(focusedId); next?.focus();
    if (focusedSelection != null && next?.setSelectionRange && ['text', 'search', 'textarea'].includes(next.type)) next.setSelectionRange(focusedSelection, focusedSelection);
  }
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  if (prevScroll) panel.querySelector('.sheet-b').scrollTop = prevScroll;
  const newLog = panel.querySelector('.log');
  if (newLog && atBottom) newLog.scrollTop = newLog.scrollHeight;
}

// Chat-style thread: comments + narration as bubbles; bursts of tool calls fold into one "work log" line.
function threadItems(d) {
  const items = [
    ...d.comments.map((c) => ({ ts: c.ts, kind: 'comment', who: c.author, text: c.body })),
    ...d.events.filter((e) => ['say', 'tool', 'plan', 'pickup', 'action', 'done', 'error', 'github', 'created', 'system', 'run'].includes(e.kind))
      .map((e) => ({ ts: e.ts, kind: e.kind, who: e.agent_id, text: e.text, id: e.id })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  const out = [];
  for (const it of items) {
    // A consult answer is posted both as an event and a comment; keep the comment.
    if (it.kind === 'say' && it.text.startsWith('→ Engineering Manager:')) continue;
    if (it.kind === 'action' && /^commented:/.test(it.text)) continue;
    const prev = out[out.length - 1];
    if (['tool', 'plan', 'error'].includes(it.kind)) {
      if (prev?.kind === 'work' && prev.who === it.who) { prev.lines.push(it); continue; }
      out.push({ kind: 'work', who: it.who, ts: it.ts, lines: [it] });
      continue;
    }
    out.push(it);
  }
  return out;
}

function bubble(it) {
  const amap = agentMap();
  const a = amap[it.who];
  const name = a?.name || (it.who === 'owner' ? 'You' : it.who === 'github' ? 'GitHub' : it.who || 'Desk');
  if (it.kind === 'work') {
    const errs = it.lines.filter((l) => l.kind === 'error').length;
    return h('details', { class: 'work' }, h('summary', {}, avatar(it.who), h('span', {}, `${name} · ${it.lines.length} step${it.lines.length > 1 ? 's' : ''}`),
      errs ? h('span', { class: 'err' }, ` · ${errs} blocked`) : null, h('span', { class: 'spacer' }), h('span', { class: 't' }, hhmm(it.ts).slice(0, 5))),
      h('div', { class: 'work-l' }, it.lines.map((l) => h('div', { class: l.kind }, l.text))));
  }
  if (['pickup', 'action', 'done', 'github', 'created', 'system', 'run'].includes(it.kind)) {
    return h('div', { class: `sys ${it.kind}` }, h('span', { class: 't' }, hhmm(it.ts).slice(0, 5)), ' ', named(it.text));
  }
  const mine = it.who === 'owner';
  const ask = it.text.startsWith('❓');
  return h('div', { class: `msg ${mine ? 'mine' : ''} ${ask ? 'ask' : ''} ${it.kind === 'say' ? 'say' : ''}` },
    mine ? null : avatar(it.who, 'md'),
    h('div', { class: 'msg-b' }, h('div', { class: 'msg-h' }, h('b', {}, name), a ? h('span', {}, a.role) : null, h('span', { class: 't' }, ago(it.ts))),
      h('div', { class: 'msg-t' }, named(it.text))));
}

function renderSheet() {
  const sh = S.sheet;
  if (!sh) return;
  if (sh.type === 'new') return renderNewSheet();
  if (sh.type === 'team') return renderTeamSheet();
  if (sh.type === 'pr') return prsUi.renderSheet(prsCtx());
  if (sh.type === 'architecture') return renderArchitectureSheet();
  if (sh.type === 'seat') return renderSeatSheet();
  const t = S.tickets.find((x) => x.key === sh.key) || sh.detail?.ticket;
  if (!t) return sheetShell([h('h2', {}, sh.error || 'Loading ticket…'), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')], null);
  const d = sh.detail;
  const amap = agentMap();
  const worker = S.agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const run = worker ? S.runs.find((r) => r.id === worker.current_run) : null;
  const sel = (label, field, options, value, ok) => h('select', { 'aria-label': label, onchange: act((e) => api('PATCH', `/api/tickets/${t.key}`, { [field]: e.target.value }), ok) },
    options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const repo = S.meta.repo;

  const head = [
    h('div', { class: 'row' }, h('span', { class: 'mono' }, t.key), h('span', { class: `pri ${t.priority}` }, t.priority), h('span', { class: 'tag' }, STATUS_LABEL[t.status] || t.status),
      worker ? h('span', { class: 'live-tag' }, avatar(worker.id), h('span', { class: 'typing' }), ` ${worker.name} is ${presenceOf(worker).text.toLowerCase()}`) : null,
      h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
    h('h2', {}, nameOf(t), h('button', { class: 'linkish rename', type: 'button', title: 'Rename', 'aria-label': 'Rename ticket', onclick: act(async () => {
      const v = prompt('Short name for this ticket (2–5 words):', nameOf(t));
      if (v == null) return false;
      await api('POST', `/api/tickets/${t.key}/name`, { name: v });
      await loadSnapshot();
    }, 'renamed') }, '✎')),
    nameOf(t) !== t.title ? h('div', { class: 'sheet-sub' }, t.title) : null,
    t.progress ? h('div', { class: 'prog', title: 'agent-reported estimate' }, h('i', { style: `width:${t.progress}%` })) : null,
    t.progress_msg ? h('div', { class: 'prog-msg' }, `${t.progress}% · ${t.progress_msg}`) : null,
  ];

  const reply = h('textarea', { id: 'ticket-reply', 'aria-label': 'Reply to ticket', placeholder: 'Message or requested corrections…', rows: '2', oninput: (e) => { sh.reply = e.target.value; } });
  reply.value = sh.reply || '';
  const destination = h('select', { id: 'message-mode', 'aria-label': 'Message destination', onchange: (e) => { sh.messageMode = e.target.value; } },
    [['auto', 'Auto route'], ['discussion', 'Discuss with manager'], ['answer', 'Answer and continue'], ['comment', 'Comment only']].map(([value, label]) => h('option', { value, selected: (sh.messageMode || 'auto') === value }, label)));
  const send = act(async () => { if (!reply.value.trim()) return false; const result = await api('POST', `/api/tickets/${t.key}/reply`, { body: reply.value, mode: sh.messageMode || 'auto' });
    sh.reply = ''; toast(result.message_route === 'discussion' ? 'Routed to manager · ticket blocker preserved' : result.message_route === 'comment' ? 'Comment saved' : 'Answer received · task can continue'); if (S.sheet === sh) openTicket(t.key); });
  const decide = (decision) => act(async () => {
    const result = await api('POST', `/api/tickets/${t.key}/decision`, { decision, message: reply.value, expected_updated_at: t.updated_at, discussion_id: decisionTarget === 'ticket' ? undefined : Number(decisionTarget) });
    sh.reply = '';
    // An approval on a ticket with a PR is mirrored to GitHub; then ask what to do with the PR.
    if (decision === 'approve' && result?.pr_next) { prsUi.openActions(prsCtx(), result.pr_next, result.already ? { mode: 'already' } : (result.github_approval || {})); return; }
    if (S.sheet === sh) openTicket(t.key);
  }, decision === 'approve' ? 'Approved' : decision === 'correction' ? 'Corrections sent' : 'Rejected · local work retained');
  const taskDecision = ['needs_human', 'ready_for_human'].includes(t.status);
  const proposals = (d?.discussions || []).filter((x) => x.status === 'complete');
  const options = [...(taskDecision ? [['ticket', 'Current task']] : []), ...proposals.map((x) => [String(x.id), `Design proposal #${x.id}`])];
  const decisionTarget = options.find(([id]) => id === sh.decisionTarget)?.[0] || (taskDecision ? 'ticket' : proposals[0] ? String(proposals[0].id) : 'ticket');
  sh.decisionTarget = decisionTarget; // Streamed status changes must not silently switch an in-progress decision.
  const designDecision = decisionTarget !== 'ticket';
  const needsDecision = taskDecision || proposals.length;
  const targetSelect = options.length > 1 ? h('select', { id: 'decision-target', 'aria-label': 'Decision applies to', onchange: (e) => { sh.decisionTarget = e.target.value; renderSheet(); } }, options.map(([value, label]) => h('option', { value, selected: value === decisionTarget }, label))) : null;
  const question = /publish guard/.test(t.progress_msg || '') ? t.progress_msg : d?.comments?.filter((c) => c.body.startsWith('❓')).at(-1)?.body.replace(/^❓\s*\*\*Question for the owner:\*\*\s*/, '');
  const refreshable = t.pr_url && t.head_sha && ['needs_human', 'ready_for_human', 'todo'].includes(t.status) && (!d?.refresh || ['rebased', 'published'].includes(d.refresh.status));
  const branchRefresh = refreshable || d?.refresh ? h('div', { class: 'discussion-status' },
    h('p', {}, d?.refresh ? `Branch refresh · ${d.refresh.status}${d.refresh.base ? ` · base ${d.refresh.base.slice(0, 10)}` : ''}` : 'PR conflict or stale base? The desk can refresh it and return it to the engineer.'),
    refreshable ? h('button', { class: 'btn', type: 'button', disabled: !!t.active_run, onclick: act(async () => {
      await api('POST', `/api/tickets/${t.key}/refresh-base`, { expected_updated_at: t.updated_at });
      if (S.sheet === sh) openTicket(t.key);
    }, 'Branch refreshed · engineer and fresh QA queued') }, 'Refresh branch & resume') : null) : null;
  const decisionCard = needsDecision ? h('div', { class: 'decision-card' }, h('div', { class: 'row' }, h('b', {}, targetSelect ? 'Your decision' : designDecision ? `Design proposal #${decisionTarget}` : t.status === 'needs_human' ? 'Your decision is needed' : 'Ready for your review'), targetSelect),
      h('p', {}, designDecision ? 'Review the recommendation above. Approval records the design; corrections return it to the manager.' : t.status === 'needs_human' ? question || t.progress_msg || 'The engineer is waiting for your direction.' : t.pr_url ? 'Approval records your review. Open the draft PR for the final merge, or request changes below.' : 'Approve draft publication or request changes. You control the final merge.'),
      !designDecision && /publish guard/.test(t.progress_msg || '') ? h('p', { class: 'warn' }, 'Approval pushes the guarded commit and opens a draft PR. Review its diff first.') : null,
      h('small', {}, designDecision ? 'Task decisions and merges stay separate.' : 'Corrections need a message. Rejection retains local work.'),
      reply,
      h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', disabled: !designDecision && !!t.active_run, onclick: decide('approve') }, !designDecision && /publish guard/.test(t.progress_msg || '') ? 'Approve publish' : 'Approve'),
        h('button', { class: 'btn', type: 'button', disabled: !designDecision && !!t.active_run, onclick: decide('correction') }, 'Needs correction'),
        h('button', { class: 'btn danger', type: 'button', disabled: !designDecision && !!t.active_run, onclick: decide('reject') }, 'Reject'),
        !designDecision && t.pr_url ? h('a', { class: 'btn', href: t.pr_url, target: '_blank', rel: 'noopener' }, 'Review draft PR') : null)) : null;
  const body = [
    h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => openArchitecture(t.key) }, 'Architecture review'),
      h('small', { class: 'muted' }, `${(S.meta.council?.councils || []).filter((c) => c.ticket_key === t.key).length} councils · ${d?.reviews?.length || 0} peer reviews · advisory only`)),
    h('details', { class: 'ticket-description' }, h('summary', {}, 'Task brief and acceptance criteria'), h('div', { class: 'desc' }, t.description || 'No description provided.')),
    h('details', { class: 'meta' }, h('summary', {}, 'Details', h('span', { class: 'meta-s' }, `${t.area || '—'} · ${t.complexity || '—'} · ${t.assignee ? amap[t.assignee]?.name : 'unassigned'}${t.issue_number ? ` · #${t.issue_number}` : ''}`)),
      h('div', { class: 'kv' },
        h('div', {}, h('span', {}, 'Status'), sel('status', 'status', COLUMNS.map((c) => [c.id, c.title]), t.status, 'moved')),
        h('div', {}, h('span', {}, 'Assignee'), sel('assignee', 'assignee', [['', '— auto (by complexity)'], ...(S.meta.engineers || []).map((id) => [id, `${amap[id]?.name} · ${amap[id]?.role}`])], t.assignee || '', 'reassigned')),
        h('div', {}, h('span', {}, 'Priority'), sel('priority', 'priority', ['P0', 'P1', 'P2', 'P3'].map((p) => [p, p]), t.priority, 'saved')),
        h('div', {}, h('span', {}, 'Area / size'), `${t.area || '—'} / ${t.complexity || '—'}`),
        h('div', {}, h('span', {}, 'GitHub'), t.issue_number && repo ? h('a', { href: `https://github.com/${repo}/issues/${t.issue_number}`, target: '_blank', rel: 'noopener' }, `issue #${t.issue_number}`) : '—',
          t.pr_url ? [' · ', h('a', { href: t.pr_url, target: '_blank', rel: 'noopener' }, 'draft PR')] : null),
        h('div', {}, h('span', {}, 'Branch'), h('span', { class: 'mono', style: 'word-break:break-all' }, t.branch || '—')),
        h('div', {}, h('span', {}, 'Requested by'), amap[t.reporter]?.name || t.reporter || '—'),
        h('div', {}, h('span', {}, 'Review rounds'), String(t.qa_loops || 0))),
      (() => {
        const kids = S.tickets.filter((x) => x.parent_key === t.key);
        return kids.length ? h('div', { class: 'mini-list' }, kids.map((k) => h('button', { class: 'mini-t', type: 'button', onclick: () => openTicket(k.key) },
          h('span', { class: 'mono' }, k.key), avatar(k.assignee), h('span', { class: 'tag' }, STATUS_LABEL[k.status] || k.status), h('span', { class: 'tt' }, `${k.complexity || ''} · ${k.title}`)))) : null;
      })(),
      run ? h('div', { class: 'row-actions' }, h('span', { style: 'flex:1;color:var(--muted);font-size:12px' }, `run #${run.id} · ${run.kind} · ${run.model}`),
        h('button', { class: 'btn small danger', type: 'button', onclick: act(() => api('POST', `/api/runs/${run.id}/kill`, {}), 'stopping run') }, 'Stop run')) : null),
    d?.discussions?.length ? h('div', { class: 'discussion-status' }, d.discussions.slice(0, 3).map((x) => h('p', {}, `Design discussion #${x.id} · ${{ queued: 'Waiting for manager', running: 'Manager reviewing', complete: 'Awaiting your design decision', approved: 'Design approved', rejected: 'Proposal rejected', changes_requested: 'Corrections sent to manager', failed: 'Failed' }[x.status] || x.status}${x.error ? ` · ${x.error}` : ''}`))) : null,
    designDecision ? h('details', { class: 'ticket-description' }, h('summary', {}, `Read design recommendation #${decisionTarget}`),
      h('div', { class: 'desc' }, proposals.find((x) => String(x.id) === decisionTarget)?.response || 'Loading recommendation…')) : null,
    d ? h('div', { class: 'thread' }, threadItems(d).map(bubble)) : h('div', { class: 'empty' }, 'Loading…'),
    worker ? h('div', { class: 'msg typing-row' }, avatar(worker.id, 'md'), h('div', { class: 'msg-b' }, h('div', { class: 'msg-t dots' }, h('i'), h('i'), h('i'),
      h('span', {}, worker.last_action ? ` ${worker.last_action}` : '')))) : null,
  ];
  const footer = h('div', { class: 'ticket-footer' }, branchRefresh, decisionCard || h('div', { class: 'composer' }, reply),
    h('div', { class: 'message-actions' }, destination, h('button', { class: 'btn', type: 'button', onclick: send }, 'Send message')),
    h('small', { class: 'composer-help' }, 'Discussion → manager · Answer → task · Comment → thread'));
  sheetShell(head, body, footer);
}

async function loadSeat(id) {
  try {
    const r = await api('GET', `/api/agents/${id}`);
    if (S.sheet?.id === id) { S.sheet.events = r.events; S.sheet.stats = r.stats; S.sheet.tickets = r.tickets; renderSheet(); }
  } catch (e) { toast(e.message, true); }
}

function renderSeatSheet() {
  const a = agentMap()[S.sheet.id];
  if (!a) return;
  const { events: evs, stats: st, tickets } = S.sheet;
  const pr = presenceOf(a);
  const run = a.current_run ? S.runs.find((r) => r.id === a.current_run) : null;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const tile = (label, value, hint) => h('div', { class: 'tile', title: hint || '' }, h('span', {}, label), h('b', { class: 'mono' }, value));
  sheetShell([
    h('div', { class: 'row' }, avatar(a.id, 'xl'), h('div', { class: 'prof' }, h('h2', {}, a.name), h('div', { class: 'role' }, a.role),
      h('div', { class: 'presence' }, h('span', { class: `pdot ${pr.key}` }), pr.text, a.current_ticket ? [' · ', h('button', { class: 'linkish mono', type: 'button', onclick: () => openTicket(a.current_ticket) }, a.current_ticket)] : null)),
      h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
    h('p', { class: 'bio' }, a.bio || ''),
    h('div', { class: 'row' }, h('span', { class: 'brain' }, 'Runs on ', seatModel(a), a.effort ? h('span', { class: 'tag' }, `effort ${a.effort}`) : null), h('span', { class: 'tag' }, (a.kinds || []).join(' · ')),
      h('span', { class: 'spacer' }), run ? h('button', { class: 'btn small danger', type: 'button', onclick: act(() => api('POST', `/api/runs/${run.id}/kill`, {}), 'stopping run') }, 'Stop current run') : null),
  ], [
    h('div', { class: 'section-title' }, 'Scorecard'),
    st ? h('div', { class: 'tiles' },
      tile('Shipped', String(st.shipped), 'QA-passed tickets assigned to this seat'),
      tile('Merged', String(st.merged)),
      tile('First-pass QA', pct(st.first_pass_rate), 'shipped without a QA/requester bounce'),
      tile('Runs', String(st.runs)),
      tile('Run success', pct(st.run_success_rate)),
      tile('Burn 7d', money(st.cost_7d)),
      tile('Burn total', money(st.cost_total)),
      tile('Cost / shipped', st.cost_per_shipped == null ? '—' : money(st.cost_per_shipped)),
      tile('Requested', String(st.reported), 'tickets this seat filed'),
      tile('Merge rate', pct(st.merge_rate), 'merged ÷ (merged + closed without merging)'),
      tile('Cost / merged', st.cost_per_merged == null ? '—' : money(st.cost_per_merged))) : h('div', { class: 'empty' }, 'Loading…'),
    st?.versions?.length > 1 ? [h('div', { class: 'section-title' }, 'By version (charter · model · engine)'), h('div', { class: 'mini-list' }, st.versions.map((v) => h('div', { class: 'mini-t' },
      h('span', { class: 'mono' }, v.provenance), h('span', { class: 'tag' }, `${v.n} runs`), h('span', { class: 'tt' }, `${Math.round((v.ok / v.n) * 100)}% ok · ${money(v.cost)}`))))] : null,
    tickets?.length ? [h('div', { class: 'section-title' }, 'Tickets'), h('div', { class: 'mini-list' }, tickets.map((t) => h('button', { class: 'mini-t', type: 'button', onclick: () => openTicket(t.key) },
      h('span', { class: 'mono' }, t.key), h('span', { class: 'tag' }, STATUS_LABEL[t.status] || t.status), h('span', { class: 'tt' }, t.title))))] : null,
    h('div', { class: 'section-title' }, 'Live log'),
    evs ? h('div', { class: 'log', style: 'max-height:none' }, evs.length ? evs.slice(-300).map((e) => evRow(e, true)) : h('div', { class: 'empty' }, 'No activity yet.')) : h('div', { class: 'empty' }, 'Loading…'),
  ]);
}

function renderNewSheet() {
  const draft = S.sheet.draft ||= { title: '', description: '', type: 'feature', priority: 'P2' };
  const update = (field) => (e) => { draft[field] = e.target.value; };
  const title = h('input', { id: 'new-title', 'aria-label': 'Title', type: 'text', value: draft.title, oninput: update('title'), placeholder: 'What do you need?', maxlength: '200', required: true });
  const desc = h('textarea', { id: 'new-description', 'aria-label': 'Description', oninput: update('description'), placeholder: 'Context, links, acceptance criteria. Support triages and routes the ticket.', rows: '8' });
  desc.value = draft.description;
  const type = h('select', { 'aria-label': 'Ticket type', onchange: update('type') }, ['feature', 'bug', 'task', 'research'].map((v) => h('option', { value: v, selected: v === draft.type }, v)));
  const pri = h('select', { 'aria-label': 'Ticket priority', onchange: update('priority') }, ['P2', 'P1', 'P0', 'P3'].map((v) => h('option', { value: v, selected: v === draft.priority }, v)));
  sheetShell([
    h('div', { class: 'row' }, h('h2', {}, 'New ticket'), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
  ], [
    h('div', { class: 'field' }, h('label', { for: 'new-title' }, 'Title'), title),
    h('div', { class: 'field' }, h('label', { for: 'new-description' }, 'Description'), desc),
    h('div', { class: 'kv' }, h('div', {}, h('span', {}, 'Type'), type), h('div', {}, h('span', {}, 'Priority'), pri)),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => {
      if (!title.value.trim()) throw new Error('title required');
      const t = await api('POST', '/api/tickets', { title: title.value, description: desc.value, type: type.value, priority: pri.value });
      closeSheet();
      openTicket(t.key);
    }, 'ticket created — support will triage it') }, 'Create ticket')),
  ]);
  setTimeout(() => title.focus(), 50);
}

// ---------------- render loop ----------------
function render() {
  renderTop();
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false');
  const view = $('view');
  const activeId = document.activeElement?.id;
  const selection = document.activeElement?.selectionStart;
  const keepX = view.querySelector('.board')?.scrollLeft;
  const content = S.view === 'board' ? renderBoard() : S.view === 'desk' ? renderFloor() : S.view === 'tape' ? renderTape() : S.view === 'watch' ? renderWatch() : S.view === 'prs' ? prsUi.renderPage(prsCtx()) : renderSettings();
  const hot = S.incidents.filter((i) => ['investigating', 'paged'].includes(i.status) || (i.status === 'watching' && (i.window_count || 0) >= (S.meta.watch?.min_count || 3))).length;
  const badge = $('watch-badge');
  badge.hidden = !hot;
  badge.textContent = String(hot);
  // Don't clobber a settings field mid-edit.
  if (!(S.view === 'settings' && view.contains(document.activeElement) && view.dataset.view === 'settings')) {
    view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    view.dataset.view = S.view;
    if (activeId?.startsWith('board-')) {
      const next = $(activeId);
      next?.focus();
      if (next?.type === 'search' && selection != null) next.setSelectionRange(selection, selection);
    }
  }
  if (keepX) { const b = view.querySelector('.board'); if (b) b.scrollLeft = keepX; }
  const sheetBusy = $('sheet').contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (S.sheet && !sheetBusy && !['new', 'team', 'architecture', 'pr'].includes(S.sheet.type)) renderSheet();
  lastSeenEvent = S.events.length ? S.events[S.events.length - 1].id : lastSeenEvent;
}

// ---------------- wiring ----------------
for (const b of document.querySelectorAll('#tabs button')) {
  b.addEventListener('click', () => { S.view = b.dataset.view; localStorage.setItem('sd.view', S.view); render(); window.scrollTo(0, 0); });
}
$('btn-toggle').addEventListener('click', async () => {
  try {
    await api('POST', S.settings.paused === 'true' ? '/api/control/start' : '/api/control/pause', {});
  } catch (e) {
    if (e.message === 'confirm_team' || /Choose which engine/.test(e.message)) openTeam(true);
    else toast(e.message, true);
  }
});
$('btn-breaker').addEventListener('click', act(async () => {
  if (!confirm('Circuit breaker: halt the desk and stop every running seat now?')) return;
  await api('POST', '/api/control/stop-all', {});
}, 'breaker tripped'));
$('btn-new').addEventListener('click', () => { S.sheet = { type: 'new' }; renderSheet(); });
document.addEventListener('keydown', (e) => {
  if (!S.sheet) return;
  if (e.key === 'Escape') closeSheet();
  if (e.key === 'Tab') {
    const focusable = [...$('sheet').querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select, a[href], summary')].filter((el) => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
// Phones suspend tabs: on return, re-sync from a fresh snapshot instead of trusting a stale stream.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { connect(); } });
setInterval(() => { if (document.visibilityState === 'visible' && S.connected) loadSnapshot().catch(() => {}); }, 15_000);

connect();
if (location.hash.length > 1) openTicket(location.hash.slice(1));
