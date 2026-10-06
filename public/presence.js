// Who is writing on a ticket, like a messaging app — but only from real activity. Pure (no DOM) so it is unit-tested.
//   writing — a seat's run on this ticket is active and posted a step (say / action / tool / plan) in the last 45 s
//   quiet   — the run is active, its last step is older than that (or it has not posted one yet)
//   stalled — the run is active and nothing at all arrived for longer than the run card's "No update" threshold
//   next    — the scheduler is holding this ticket for a seat (it acts once the seat is free / at the next tick)
//   draft   — the owner has an unsent draft for this ticket (local to this browser, never sent anywhere)
// Only runs that are active right now count: a finished run's events never make anyone "writing".
import { humanizeStep, parsePlan, STALE_MS } from './runcard.js';

export const WRITING_MS = 45_000;
export { STALE_MS };
const SIGNAL = new Set(['say', 'action', 'tool', 'plan']);
const ts = (iso) => Date.parse(iso || '') || 0;
const lower = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const cut = (s, n = 64) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);

/** The latest step as a short lowercase phrase: "reading TicketSheet.tsx", "running npm test", "writing a message". */
export function stepLabel(e) {
  if (!e) return '';
  const text = String(e.text || '').trim();
  if (e.kind === 'say') return 'writing a message';
  if (e.kind === 'plan') { const now = parsePlan(text)?.items.find((i) => i.state === 'now'); return now ? cut(lower(now.text)) : 'updating the plan'; }
  if (e.kind === 'tool' && /^\$\s+/.test(text)) return `running ${cut(text.replace(/^\$\s+/, '').split('\n')[0], 48)}`;
  // Paths shrink to the file name: "Reading ui/src/ticket/TicketSheet.tsx" → "reading TicketSheet.tsx".
  return cut(lower(humanizeStep(text.split('\n')[0]).replace(/(?:[\w.-]+\/)+([\w.-]+)/g, '$1')));
}

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const plainAge = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s ago` : `${minutes(ms)} min ago`);

/**
 * Presence for one ticket.
 * input: { key, agents, runs, events, waiting (meta.scheduler.waiting), drafts (S.drafts), now }
 * output: { writers: [{ seat, name, state, label, ageMs, runId, text }], next: [{ seat, name, text, held }], draft: { id } | null }
 * writers are ordered writing → quiet → stalled, then by most recent activity.
 * @param {{ key?: string, agents?: any[], runs?: any[], events?: any[], waiting?: any[], drafts?: Record<string, string>, now?: number }} [o]
 */
export function presenceFor({ key, agents = [], runs = [], events = [], waiting = [], drafts = {}, now = Date.now() } = {}) {
  if (!key) return { writers: [], next: [], draft: null };
  const nameOf = (id) => String(agents.find((a) => a.id === id)?.name || id || '').split(/\s+/)[0];
  // Active runs on this ticket, one per seat: a working seat's current run, plus any run the server reports running.
  const active = new Map();
  for (const a of agents) if (a.status === 'working' && a.current_ticket === key) active.set(a.id, { seat: a.id, runId: a.current_run || null, kind: a.current_kind || null, started: null });
  for (const r of runs) {
    if (r.ticket_key !== key || r.status !== 'running') continue;
    const cur = active.get(r.agent_id);
    if (!cur) active.set(r.agent_id, { seat: r.agent_id, runId: r.id, kind: r.kind, started: r.started_at });
    else if (!cur.runId || cur.runId === r.id) Object.assign(cur, { runId: r.id, kind: cur.kind || r.kind, started: r.started_at });
  }
  const writers = [];
  for (const w of active.values()) {
    const evs = w.runId ? events.filter((e) => e.run_id === w.runId && e.ticket_key === key) : [];
    let lastAny = 0, lastSig = null;
    for (const e of evs) { const t = ts(e.ts); if (t > lastAny) lastAny = t; if (SIGNAL.has(e.kind) && (!lastSig || t >= ts(lastSig.ts))) lastSig = e; }
    const activity = Math.max(lastAny, ts(w.started));
    const sigAge = lastSig ? Math.max(0, now - ts(lastSig.ts)) : null;
    const idle = activity ? Math.max(0, now - activity) : null;
    const name = nameOf(w.seat);
    let state, label, ageMs, text;
    if (sigAge != null && sigAge < WRITING_MS) {
      state = 'writing'; label = stepLabel(lastSig); ageMs = sigAge;
      text = `${name} is writing…`;
    } else if (idle != null && idle > STALE_MS) {
      state = 'stalled'; ageMs = idle; label = lastSig ? stepLabel(lastSig) : '';
      text = `${name} · no update for ${minutes(idle)} min`;
    } else {
      state = 'quiet'; ageMs = sigAge ?? idle ?? 0; label = lastSig ? stepLabel(lastSig) : w.runId ? `starting ${w.kind || 'work'}` : 'getting ready';
      text = sigAge != null ? `${name} · working quietly for ${minutes(sigAge)} min` : `${name} · ${label}`;
    }
    writers.push({ seat: w.seat, name, state, label, ageMs, runId: w.runId, text, at: activity });
  }
  const RANK = { writing: 0, quiet: 1, stalled: 2 };
  writers.sort((a, b) => RANK[a.state] - RANK[b.state] || b.at - a.at || a.seat.localeCompare(b.seat));
  for (const w of writers) delete w.at;

  // Up next: the scheduler's own waiting entry. Owner tasks and prerequisites are not a seat about to write.
  const busy = new Set(writers.map((w) => w.seat));
  const HELD = { paused: 'desk paused', budget: 'daily budget reached', provider_hold: 'no engine available', setup_retry: 'setup retry pending' };
  const next = [];
  for (const x of waiting) {
    if (x.key !== key || !x.seat || busy.has(x.seat) || next.some((n) => n.seat === x.seat)) continue;
    if (!['tick', 'seat_busy', ...Object.keys(HELD)].includes(x.code)) continue;
    const name = nameOf(x.seat);
    next.push({ seat: x.seat, name, held: HELD[x.code] || null,
      text: x.code === 'tick' ? `${name} is up next` : x.code === 'seat_busy' ? `${name} is up next, after their current work` : `${name} is next · ${HELD[x.code]}` });
  }

  // The owner's own unsent text for this ticket (any decision on it, or a plain message).
  const dk = Object.keys(drafts).find((k) => k.startsWith(`${key}:`) && String(drafts[k] || '').trim());
  const draft = dk ? { id: dk.slice(key.length + 1) } : null;
  return { writers, next, draft };
}

/** "Rowan is writing…", "Rowan and Morgan are writing…", "Rowan, Morgan and Quinn are…", "Rowan, Morgan and 2 others are…". */
/** @param {string[]} names */
export function writingSentence(names) {
  const n = names.length;
  if (!n) return '';
  if (n === 1) return `${names[0]} is writing…`;
  if (n === 2) return `${names[0]} and ${names[1]} are writing…`;
  if (n === 3) return `${names[0]}, ${names[1]} and ${names[2]} are writing…`;
  return `${names[0]}, ${names[1]} and ${n - 2} others are writing…`;
}

/** Detail under a single writer: "reading TicketSheet.tsx · 12s ago". */
export function writingDetail(w) {
  return [w.label, plainAge(w.ageMs)].filter(Boolean).join(' · ');
}

/**
 * One sentence for screen readers. Names and states only (never the step or the age), so it changes when someone
 * starts or stops writing, not with every tool call.
 */
export function presenceAnnouncement(p) {
  const writing = p.writers.filter((w) => w.state === 'writing').map((w) => w.name);
  const parts = [writingSentence(writing).replace('…', '')];
  for (const w of p.writers) if (w.state === 'stalled') parts.push(`${w.name} has not posted an update for a while`);
  return parts.filter(Boolean).join('. ');
}

/** Board cards: the names of seats writing on this ticket right now (empty when nobody is). */
export const writingNames = (p) => p.writers.filter((w) => w.state === 'writing').map((w) => w.name);
