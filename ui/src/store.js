// One external store for the whole desk UI. Same contract as the v2 client: a snapshot, then stream deltas (buffered
// while a snapshot is in flight), a debounced snapshot refresh after deltas that change derived server state, a resync
// every 15 s while visible, and a reconnect when the stream closes. Components subscribe with useDesk().
import { useSyncExternalStore } from 'react';
import { board } from '../../public/attention.js';
import { applyDelta, mergeDetail, emptyPending } from './lib/sync.js';
import { questionText } from './lib/format.js';

const VIEWS = ['inbox', 'work', 'team'];
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };

export const S = {
  agents: [], tickets: [], events: [], runs: [], settings: {}, meta: {}, incidents: [],
  connected: false, loadError: null, loaded: false,
  view: VIEWS.includes(localStorage.getItem('sd2.view')) ? localStorage.getItem('sd2.view') : 'inbox',
  sheet: null, // { type, ...params } — which sheet is open
  detail: null, // { key, data, pending, error } for the open ticket sheet
  seat: null, // { id, events, stats } for the open seat sheet
  questions: {}, prs: null, prsAt: 0, prsLoading: false, councils: {},
  research: null, // { data, connectors, error } for the research sheet
  open: {}, // disclosure state that survives re-renders
  seen: new Set(), painted: false,
  drafts: readJSON('sd2.drafts', {}),
  toasts: [],
};

// ---------------- subscription ----------------
let version = 0;
const listeners = new Set();
let queued = false;
export function emit() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; version++; for (const l of listeners) l(); });
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const getVersion = () => version;
let boardCache = { v: -1, b: null };
export function currentBoard() {
  if (boardCache.v !== version) {
    const b = board(S);
    b.byKey = {};
    for (const it of Object.values(b).filter(Array.isArray).flat()) if (!b.byKey[it.key]) b.byKey[it.key] = it;
    boardCache = { v: version, b };
  }
  return boardCache.b;
}
/** Re-render on any store change; read S and currentBoard() directly. */
export function useDesk() { useSyncExternalStore(subscribe, getVersion); return S; }
export const agentMap = () => Object.fromEntries(S.agents.map((a) => [a.id, a]));
export const ticketByKey = (k) => S.tickets.find((x) => x.key === k);

// ---------------- toasts ----------------
let toastSeq = 0;
export function toast(msg, err = false) {
  const id = ++toastSeq;
  S.toasts = [{ id, msg: String(msg), err }];
  emit();
  setTimeout(() => { if (S.toasts[0]?.id === id) { S.toasts = []; emit(); } }, err ? 6000 : 3600);
}

// ---------------- API ----------------
export async function api(method, url, body, timeoutMs = 20000) {
  const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${res.status}`), { status: res.status, code: j.error });
  return j;
}

// ---------------- sync ----------------
let es = null, reconnectTimer = 0, syncing = false, snapshotSeq = 0, metaTimer = 0;
const pending = [];
export async function loadSnapshot() {
  syncing = true;
  const seq = ++snapshotSeq;
  try {
    const snap = await api('GET', '/api/state');
    if (seq !== snapshotSeq) return;
    Object.assign(S, snap);
    S.loadError = null; S.loaded = true;
    for (const m of pending.splice(0)) applyDelta(S, m);
    emit();
  } catch (e) {
    if (seq === snapshotSeq) { S.loadError = e.message; for (const m of pending.splice(0)) applyDelta(S, m); emit(); }
    throw e;
  } finally { if (seq === snapshotSeq) syncing = false; }
}
export const refreshMeta = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => loadSnapshot().catch(() => {}), 800); };
export function connect() {
  clearTimeout(reconnectTimer);
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => {
    S.connected = true; syncing = true;
    loadSnapshot().then(() => (S.detail ? loadDetail() : null)).catch(() => {});
  };
  es.onerror = () => {
    S.connected = false; emit();
    // Some failed HTTP responses close EventSource permanently instead of retrying.
    if (es.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connect, 3000);
  };
  es.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (syncing) { pending.push(m); return; }
    const out = applyDelta(S, m);
    if (out.meta) refreshMeta();
    if (out.research && S.sheet?.type === 'research') loadResearch().catch(() => {});
    emit();
  };
}
export function start() {
  connect();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') connect(); });
  setInterval(() => { if (document.visibilityState === 'visible' && S.connected) loadSnapshot().catch(() => {}); }, 15_000);
  setInterval(() => { if (document.visibilityState === 'visible') emit(); }, 30_000); // "waiting N min" clocks
}

// ---------------- view + sheets ----------------
export function setView(v) {
  if (S.view !== v) window.scrollTo(0, 0);
  S.view = v; localStorage.setItem('sd2.view', v); emit();
}
export function openSheet(sheet) {
  S.sheet = sheet;
  if (sheet.type !== 'ticket') S.detail = null;
  if (sheet.type !== 'seat') S.seat = null;
  emit();
}
export function closeSheet() {
  S.sheet = null; S.detail = null; S.seat = null;
  if (location.hash) history.replaceState(null, '', location.pathname);
  emit();
}
export async function openTicket(key, opts = {}) {
  S.sheet = { type: 'ticket', key, decision: opts.decision || null, focus: !!opts.focus, nonce: Date.now() };
  S.detail = { key, data: null, pending: emptyPending(), error: null, seq: 0 };
  S.seat = null;
  history.replaceState(null, '', `#${key}`);
  emit();
  if (ticketByKey(key)?.pr_url) loadPrs();
  await loadDetail();
}
/** Load the open ticket's detail and merge it by id with whatever stream items arrived meanwhile. */
export async function loadDetail() {
  const d = S.detail;
  if (!d) return;
  const seq = ++d.seq; // overlapping loads: only the newest response is applied
  try {
    const fetched = await api('GET', `/api/tickets/${d.key}`);
    if (S.detail !== d || seq !== d.seq) return;
    d.data = mergeDetail(d.data, fetched, d.pending);
    d.pending = emptyPending();
    d.error = null;
  } catch (e) { if (S.detail === d && seq === d.seq) d.error = e.message; }
  emit();
}
export async function openSeat(id) {
  S.sheet = { type: 'seat', id };
  S.seat = { id, events: null, stats: null };
  S.detail = null;
  emit();
  try {
    const r = await api('GET', `/api/agents/${id}`);
    if (S.seat?.id === id) { S.seat.events = r.events; S.seat.stats = r.stats; emit(); }
  } catch (e) { toast(e.message, true); }
}

// ---------------- lazily fetched facts ----------------
/** The ❓ question on an Inbox card, fetched once per ticket version. */
export function questionFor(t) {
  const q = S.questions[t.key];
  if (q && q.at === t.updated_at) return q.text;
  if (!q?.loading) {
    S.questions[t.key] = { ...(q || {}), loading: true };
    api('GET', `/api/tickets/${t.key}`).then((d) => {
      const c = d.comments.filter((x) => String(x.body).startsWith('❓')).at(-1);
      S.questions[t.key] = { at: t.updated_at, text: c ? questionText(c.body) : null };
      emit();
    }).catch(() => { S.questions[t.key] = { at: t.updated_at, text: null }; });
  }
  return q?.text ?? null;
}
export function loadPrs(force = false) {
  if (S.prsLoading || (!force && S.prs && Date.now() - S.prsAt < 60_000)) return;
  S.prsLoading = true;
  api('GET', `/api/prs${force ? '?refresh=1' : ''}`).then((r) => { S.prs = r; }).catch((e) => { S.prs = { prs: [], error: e.message }; })
    .finally(() => { S.prsAt = Date.now(); S.prsLoading = false; emit(); });
}
export const prFor = (t) => S.prs?.prs?.find((p) => p.number === Number(String(t?.pr_url || '').match(/\/pull\/(\d+)/)?.[1])) || null;
export function councilFor(id) {
  const c = S.councils[id];
  if (c && !c.loading) return c;
  if (!c) {
    S.councils[id] = { loading: true };
    api('GET', `/api/councils/${id}`).then((x) => { S.councils[id] = x; emit(); }).catch((e) => { S.councils[id] = { error: e.message }; emit(); });
  }
  return null;
}
export async function loadResearch() {
  try {
    const [data, conns] = await Promise.all([api('GET', '/api/research'), api('GET', '/api/connectors')]);
    S.research = { data, connectors: conns.connectors, sections: conns.case_sections, stages: conns.sdlc_stages, error: null };
  } catch (e) { S.research = { ...(S.research || {}), error: e.message }; }
  emit();
}

// ---------------- drafts ----------------
export const draftKey = (key, decisionId) => `${key}:${decisionId || 'msg'}`;
export function setDraft(k, v) {
  if (v) S.drafts[k] = v; else delete S.drafts[k];
  try { localStorage.setItem('sd2.drafts', JSON.stringify(S.drafts)); } catch { /* private mode */ }
}
export function setOpen(id, open) { S.open[id] = open; }
