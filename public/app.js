// SigmaDesk client: one snapshot, then a live SSE stream of deltas. No framework, no innerHTML for data.
import { portrait, presenceOf } from './avatars.js';

const COLUMNS = [
  { id: 'triage', title: 'Intake', sub: 'new orders · support triages' },
  { id: 'proposed', title: 'Research', sub: 'ideas · manager grooms' },
  { id: 'todo', title: 'Order book', sub: 'groomed · waiting for a seat' },
  { id: 'in_progress', title: 'Executing', sub: 'engineers at work' },
  { id: 'qa', title: 'Risk check', sub: 'independent QA' },
  { id: 'review', title: 'Confirmation', sub: 'requester checks intent' },
  { id: 'needs_human', title: 'Margin call', sub: 'needs you', alert: true },
  { id: 'ready_for_human', title: 'Settlement', sub: 'draft PR · your review' },
  { id: 'done', title: 'Filled', sub: 'merged' },
  { id: 'wontdo', title: 'Cancelled', sub: 'rejected / closed' },
];
const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.title]));

const S = {
  agents: [], tickets: [], events: [], runs: [], settings: {}, meta: {}, incidents: [],
  view: localStorage.getItem('sd.view') || 'board',
  mobileCol: localStorage.getItem('sd.col') || 'in_progress',
  tapeFilter: 'all',
  sheet: null, // { type: 'ticket', key, detail } | { type: 'seat', id, events } | { type: 'new' }
  connected: false,
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
const seatModel = (a) => (a.engine === 'codex' ? h('span', { class: 'model codex' }, `codex${a.model ? `·${a.model}` : ''}`) : h('span', { class: `model ${a.model}` }, a.model));

function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${err ? 'err' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
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
      const en = h('input', { type: 'checkbox', class: 'switch', onchange: set('enabled'), 'aria-label': 'seat enabled' });
      en.checked = dr.enabled;
      return h('div', { class: `seatrow ${dr.enabled ? '' : 'off'}` },
        avatar(seat.id, 'md'),
        h('div', { class: 'sr-who' }, h('b', {}, seat.name), h('span', {}, seat.role), h('small', {}, `${seat.tier} · ${d.tiers[seat.tier] || ''}`)),
        h('div', { class: 'sr-ctl' },
          h('select', { 'aria-label': 'engine', onchange: set('engine') }, d.engines.map((e) => h('option', { value: e.id, selected: e.id === dr.engine, disabled: !e.available }, e.label))),
          h('select', { 'aria-label': 'model', onchange: set('model') }, modelOpts.map((m) => h('option', { value: m.id, selected: m.id === dr.model }, `${m.id || 'default'}${m.note ? ` — ${m.note}` : ''}`))),
          h('select', { 'aria-label': 'effort', onchange: set('effort') }, (dr.engine === 'codex' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max']).map((x) => h('option', { value: x, selected: x === dr.effort }, `effort ${x}`))),
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
const act = (fn, ok) => async (...a) => {
  try { await fn(...a); if (ok) toast(ok); } catch (e) { toast(e.message, true); }
};

// ---------------- data sync ----------------
async function loadSnapshot() {
  const snap = await api('GET', '/api/state');
  Object.assign(S, snap);
  render();
}

let es;
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => { S.connected = true; loadSnapshot().catch(() => {}); };
  es.onerror = () => { S.connected = false; renderTop(); };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    apply(m);
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
    case 'ticket': upsert(S.tickets, m.data, 'key'); break;
    case 'agent': {
      const a = S.agents.find((x) => x.id === m.data.id);
      if (a) Object.assign(a, m.data);
      break;
    }
    case 'run': upsert(S.runs, m.data); if (m.data.status !== 'running') refreshMeta(); break;
    case 'settings': S.settings = m.data; break;
    case 'incident': upsert(S.incidents, m.data); break;
    case 'quota': S.meta.quota = m.data; break;
    case 'event':
      S.events.push(m.data);
      if (S.events.length > 600) S.events.splice(0, S.events.length - 600);
      if (S.sheet?.type === 'ticket' && S.sheet.key === m.data.ticket_key) S.sheet.detail?.events.push(m.data);
      if (S.sheet?.type === 'seat' && S.sheet.id === m.data.agent_id) S.sheet.events?.push(m.data);
      break;
    case 'comment':
      if (S.sheet?.type === 'ticket' && S.sheet.key === m.data.ticket_key) S.sheet.detail?.comments.push(m.data);
      break;
    default: break;
  }
  schedule();
}

let metaTimer = 0;
function refreshMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => api('GET', '/api/state').then((s) => { S.meta = s.meta; S.agents = s.agents; schedule(); }).catch(() => {}), 800);
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
    S.meta.quota ? h('span', { class: 'tk', title: `Claude plan usage · 5-hour window ${Math.round((S.meta.quota.five_hour || 0) * 100)}% · 7-day ${Math.round((S.meta.quota.seven_day || 0) * 100)}% · new runs hold at ${Math.round((S.meta.plan_hold_at || 0.9) * 100)}%` },
      'PLAN', h('b', { style: (S.meta.quota.five_hour || 0) >= (S.meta.plan_hold_at || 0.9) ? 'color:var(--down)' : '' }, `${Math.round((S.meta.quota.five_hour || 0) * 100)}%`), h('span', {}, `5h · ${Math.round((S.meta.quota.seven_day || 0) * 100)}% 7d`)) : null,
    h('span', { class: 'tk' }, 'WIP', h('b', {}, S.tickets.filter((t) => ['in_progress', 'qa'].includes(t.status)).length)),
    h('span', { class: 'tk' }, 'CALLS', h('b', { style: S.tickets.some((t) => t.status === 'needs_human') ? 'color:var(--warn)' : '' }, S.tickets.filter((t) => t.status === 'needs_human').length)),
    h('span', { class: 'tk', title: S.connected ? 'live' : 'reconnecting' }, h('span', { class: `status-dot ${S.connected ? 'on' : ''}` }), S.connected ? 'LIVE' : 'OFFLINE'),
  ].filter(Boolean));
  const tb = $('btn-toggle');
  tb.textContent = open ? '⏸ Halt' : '▶ Open desk';
  tb.className = `btn ${open ? '' : 'go'}`;
}

// ---------------- board ----------------
function ticketCard(t) {
  const amap = agentMap();
  const live = t.active_run && amap[t.assignee]?.status === 'working' || S.agents.some((a) => a.current_ticket === t.key && a.status === 'working');
  const worker = S.agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const showProg = ['in_progress', 'qa', 'ready_for_human'].includes(t.status) || t.progress > 0;
  return h('button', { class: `card ${live ? 'live' : ''}`, type: 'button', onclick: () => openTicket(t.key) },
    h('div', { class: 'card-top' }, h('span', { class: 'key' }, t.key), h('span', { class: `pri ${t.priority}` }, t.priority), h('span', {}, t.type),
      h('span', { class: 'spacer' }), t.issue_number ? h('span', { title: 'GitHub issue' }, `#${t.issue_number}`) : null, t.pr_url ? h('span', { title: 'draft PR' }, '⇡PR') : null),
    h('div', { class: 'card-title' }, t.title),
    h('div', { class: 'card-meta' },
      t.area ? h('span', { class: 'tag' }, t.area) : null,
      t.complexity ? h('span', { class: 'tag' }, t.complexity) : null,
      h('span', { class: 'spacer' }),
      worker && worker.id !== t.assignee ? avatar(worker.id) : null,
      t.assignee ? avatar(t.assignee) : null),
    showProg ? h('div', { class: 'prog', title: `${t.progress}% (agent estimate)` }, h('i', { style: `width:${t.progress || 0}%` })) : null,
    (live && worker?.last_action) || t.progress_msg ? h('div', { class: 'prog-msg' }, live && worker?.last_action ? `▸ ${worker.last_action}` : t.progress_msg) : null,
  );
}

function renderBoard() {
  const byStatus = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const t of S.tickets) (byStatus[t.status] || (byStatus[t.status] = [])).push(t);
  const chips = h('div', { class: 'chips', role: 'tablist' }, COLUMNS.map((c) => h('button', {
    class: `chip ${c.alert && byStatus[c.id].length ? 'alert' : ''}`, type: 'button', 'aria-pressed': String(S.mobileCol === c.id),
    onclick: () => { S.mobileCol = c.id; localStorage.setItem('sd.col', c.id); render(); },
  }, c.title, h('b', {}, byStatus[c.id].length))));
  const cols = COLUMNS.filter((c) => c.id !== 'wontdo' || byStatus.wontdo.length).map((c) => h('section', { class: `col ${c.alert ? 'alert' : ''} ${S.mobileCol === c.id ? 'sel' : ''}` },
    h('div', { class: 'col-h' }, h('h3', {}, c.title, h('small', {}, c.sub)), h('span', { class: 'count' }, byStatus[c.id].length)),
    h('div', { class: 'col-b' }, byStatus[c.id].length ? byStatus[c.id].map(ticketCard) : h('div', { class: 'empty' }, c.id === 'triage' ? 'Nothing incoming. Tap ＋ to place an order.' : '—'))));
  return [chips, h('div', { class: 'board' }, cols)];
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
    compact ? null : h('span', { class: 'kcol' }, e.ticket_key ? h('button', { class: 'k', type: 'button', onclick: () => openTicket(e.ticket_key) }, e.ticket_key) : ''),
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
  if (!w.enabled) {
    return h('div', { class: 'settings' }, h('div', { class: 'set', style: 'flex-direction:column;align-items:stretch' },
      h('label', {}, 'The watch desk is off'),
      h('p', {}, 'Enable "watch" in sigmadesk.config.json with a Loki, docker or file source. A deterministic watcher fingerprints errors and wakes the SRE seat only for new, recurring signatures.')));
  }
  const groups = [['Needs attention', ['investigating', 'watching', 'paged']], ['Handed to the team', ['ticketed', 'foreign']], ['Quiet', ['muted', 'resolved']]];
  const sre = agentMap().sre;
  return [
    h('div', { class: 'watch-h' },
      sre ? h('div', { class: 'oncall' }, avatar('sre', 'lg'), h('div', {}, h('b', {}, `${sre.name} is on call`), h('div', { class: 'presence' }, h('span', { class: `pdot ${presenceOf(sre).key}` }), presenceOf(sre).text))) : null,
      h('div', { class: 'sources' }, (w.sources || []).map((src) => h('span', { class: `src ${src.ok ? 'ok' : 'bad'}`, title: src.error || '' },
        h('span', { class: `pdot ${src.ok ? 'working' : 'reviewing'}` }), `${src.type} · ${src.project}`, h('span', { class: 'mono' }, src.ok ? ` ${src.lines} lines · ${ago(src.lastPoll)}` : ` ${src.error}`))),
        h('span', { class: 'hint' }, `New signature → SRE after ${w.min_count}+ hits in ${w.window_minutes} min`))),
    groups.map(([title, sts]) => {
      const items = S.incidents.filter((i) => sts.includes(i.status));
      return [h('div', { class: 'section-title' }, `${title} (${items.length})`),
        items.length ? h('div', { class: 'incs' }, items.map(incidentCard)) : h('div', { class: 'empty' }, title === 'Needs attention' ? 'No error signatures right now.' : '—')];
    }),
  ];
}

// ---------------- settings / limits ----------------
function setRow(label, help, control) { return h('div', { class: 'set' }, h('div', {}, h('label', {}, label), h('p', {}, help)), control); }
function numSetting(key, step = 1) {
  return h('input', { type: 'number', min: '0', step: String(step), value: S.settings[key], onchange: act((e) => api('POST', '/api/settings', { key, value: e.target.value }), 'saved') });
}
function boolSetting(key) {
  const el = h('input', { type: 'checkbox', class: 'switch', onchange: act((e) => api('POST', '/api/settings', { key, value: String(e.target.checked) }), 'saved') });
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
    setRow('Max concurrent seats', 'How many agents may run at once (a busy window in the config can lower this).', numSetting('max_concurrent')),
    setRow('Daily risk limit (USD)', 'Notional model spend per day. Each running seat reserves its per-run cap.', numSetting('daily_budget_usd', 5)),
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
function closeSheet() {
  S.sheet = null;
  $('sheet').hidden = true;
  $('sheet').replaceChildren();
  history.replaceState(null, '', location.pathname);
}

async function openTicket(key) {
  S.sheet = { type: 'ticket', key, detail: null };
  history.replaceState(null, '', `#${key}`);
  renderSheet();
  try {
    S.sheet.detail = await api('GET', `/api/tickets/${key}`);
  } catch (e) { toast(e.message, true); }
  if (S.sheet?.key === key) renderSheet();
}

async function openSeat(id) {
  S.sheet = { type: 'seat', id, events: null };
  renderSheet();
  loadSeat(id);
}

function sheetShell(head, body) {
  const panel = h('div', { class: 'sheet-panel', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'sheet-h' }, head), h('div', { class: 'sheet-b' }, body));
  const sheet = $('sheet');
  const prevScroll = sheet.querySelector('.sheet-b')?.scrollTop;
  const logEl = sheet.querySelector('.log');
  const atBottom = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  sheet.replaceChildren(panel);
  sheet.hidden = false;
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
    return h('div', { class: `sys ${it.kind}` }, h('span', { class: 't' }, hhmm(it.ts).slice(0, 5)), ' ', it.text);
  }
  const mine = it.who === 'owner';
  const ask = it.text.startsWith('❓');
  return h('div', { class: `msg ${mine ? 'mine' : ''} ${ask ? 'ask' : ''} ${it.kind === 'say' ? 'say' : ''}` },
    mine ? null : avatar(it.who, 'md'),
    h('div', { class: 'msg-b' }, h('div', { class: 'msg-h' }, h('b', {}, name), a ? h('span', {}, a.role) : null, h('span', { class: 't' }, ago(it.ts))),
      h('div', { class: 'msg-t' }, it.text)));
}

function renderSheet() {
  const sh = S.sheet;
  if (!sh) return;
  if (sh.type === 'new') return renderNewSheet();
  if (sh.type === 'team') return renderTeamSheet();
  if (sh.type === 'seat') return renderSeatSheet();
  const t = S.tickets.find((x) => x.key === sh.key) || sh.detail?.ticket;
  if (!t) return sheetShell(h('div', {}, 'Loading…'), null);
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
    h('h2', {}, t.title),
    t.progress ? h('div', { class: 'prog', title: 'agent-reported estimate' }, h('i', { style: `width:${t.progress}%` })) : null,
    t.progress_msg ? h('div', { class: 'prog-msg' }, `${t.progress}% · ${t.progress_msg}`) : null,
  ];

  const reply = h('textarea', { placeholder: t.status === 'needs_human' ? 'Answer — the ticket resumes automatically' : 'Message the team as the owner…', rows: '2' });
  const send = act(async () => { if (!reply.value.trim()) return; await api('POST', `/api/tickets/${t.key}/reply`, { body: reply.value }); reply.value = ''; openTicket(t.key); }, 'sent');
  const body = [
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
      h('div', { class: 'desc' }, t.description || '—'),
      run ? h('div', { class: 'row-actions' }, h('span', { style: 'flex:1;color:var(--muted);font-size:12px' }, `run #${run.id} · ${run.kind} · ${run.model}`),
        h('button', { class: 'btn small danger', type: 'button', onclick: act(() => api('POST', `/api/runs/${run.id}/kill`, {}), 'stopping run') }, 'Stop run')) : null),
    t.status === 'needs_human' && /publish guard/.test(t.progress_msg || '') ? h('div', { class: 'ask' }, h('b', {}, '🛑 Publish guard'),
      h('div', { class: 'msg-t' }, 'This branch touches protected paths (CI, containers, hooks, lockfiles…) or is unusually large, so it was not pushed. Review the clone locally, then approve if it is safe.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn danger', type: 'button', onclick: act(async () => {
        if (!confirm(`Push ${t.key} and open a draft PR even though it touches protected paths?`)) return;
        await api('POST', `/api/tickets/${t.key}/approve-publish`, {});
      }, 'publishing') }, 'Approve publish'))) : null,
    d ? h('div', { class: 'thread' }, threadItems(d).map(bubble)) : h('div', { class: 'empty' }, 'Loading…'),
    worker ? h('div', { class: 'msg typing-row' }, avatar(worker.id, 'md'), h('div', { class: 'msg-b' }, h('div', { class: 'msg-t dots' }, h('i'), h('i'), h('i'),
      h('span', {}, worker.last_action ? ` ${worker.last_action}` : '')))) : null,
    h('div', { class: 'composer' }, reply, h('button', { class: 'btn primary', type: 'button', onclick: send }, t.status === 'needs_human' ? 'Answer' : 'Send')),
  ];
  sheetShell(head, body);
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
      tile('Requested', String(st.reported), 'tickets this seat filed')) : h('div', { class: 'empty' }, 'Loading…'),
    tickets?.length ? [h('div', { class: 'section-title' }, 'Tickets'), h('div', { class: 'mini-list' }, tickets.map((t) => h('button', { class: 'mini-t', type: 'button', onclick: () => openTicket(t.key) },
      h('span', { class: 'mono' }, t.key), h('span', { class: 'tag' }, STATUS_LABEL[t.status] || t.status), h('span', { class: 'tt' }, t.title))))] : null,
    h('div', { class: 'section-title' }, 'Live log'),
    evs ? h('div', { class: 'log', style: 'max-height:none' }, evs.length ? evs.slice(-300).map((e) => evRow(e, true)) : h('div', { class: 'empty' }, 'No activity yet.')) : h('div', { class: 'empty' }, 'Loading…'),
  ]);
}

function renderNewSheet() {
  const title = h('input', { type: 'text', placeholder: 'What do you need?', maxlength: '200', required: true });
  const desc = h('textarea', { placeholder: 'Context, links, acceptance criteria. Support triages it and routes it to product, engineering, or back to you.', rows: '8' });
  const type = h('select', {}, ['feature', 'bug', 'task', 'research'].map((v) => h('option', { value: v }, v)));
  const pri = h('select', {}, ['P2', 'P1', 'P0', 'P3'].map((v) => h('option', { value: v }, v)));
  sheetShell([
    h('div', { class: 'row' }, h('h2', {}, 'New order'), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×')),
  ], [
    h('div', { class: 'field' }, h('label', {}, 'Title'), title),
    h('div', { class: 'field' }, h('label', {}, 'Description'), desc),
    h('div', { class: 'kv' }, h('div', {}, h('span', {}, 'Type'), type), h('div', {}, h('span', {}, 'Priority'), pri)),
    h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: act(async () => {
      if (!title.value.trim()) throw new Error('title required');
      const t = await api('POST', '/api/tickets', { title: title.value, description: desc.value, type: type.value, priority: pri.value });
      closeSheet();
      openTicket(t.key);
    }, 'order placed — support will triage it') }, 'Place order')),
  ]);
  setTimeout(() => title.focus(), 50);
}

// ---------------- render loop ----------------
function render() {
  renderTop();
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false');
  const view = $('view');
  const keepX = view.querySelector('.board')?.scrollLeft;
  const content = S.view === 'board' ? renderBoard() : S.view === 'desk' ? renderFloor() : S.view === 'tape' ? renderTape() : S.view === 'watch' ? renderWatch() : renderSettings();
  const hot = S.incidents.filter((i) => ['investigating', 'paged'].includes(i.status) || (i.status === 'watching' && (i.window_count || 0) >= (S.meta.watch?.min_count || 3))).length;
  const badge = $('watch-badge');
  badge.hidden = !hot;
  badge.textContent = String(hot);
  // Don't clobber a settings field mid-edit.
  if (!(S.view === 'settings' && view.contains(document.activeElement) && view.dataset.view === 'settings')) {
    view.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    view.dataset.view = S.view;
  }
  if (keepX) { const b = view.querySelector('.board'); if (b) b.scrollLeft = keepX; }
  const sheetBusy = $('sheet').contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
  if (S.sheet && !sheetBusy && !['new', 'team'].includes(S.sheet.type)) renderSheet();
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheet) closeSheet(); });
// Phones suspend tabs: on return, re-sync from a fresh snapshot instead of trusting a stale stream.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { connect(); } });
setInterval(() => { if (S.view === 'desk') schedule(); }, 15_000); // keep "x ago" labels fresh

connect();
if (location.hash.length > 1) openTicket(location.hash.slice(1));
