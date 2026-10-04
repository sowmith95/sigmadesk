// Recorded public updates only; command output stays available as evidence, not dialogue.
// The desk often writes the same thing twice: a persisted comment plus an activity event ("commented: …",
// "asked the owner: …", a consult's "🗣 planning discussion with …" / "→ Engineering Manager: …", or a discussion
// run's final narration that also became the design response). The thread shows each message once.
import { humanizeStep, humanizeError, isToolExit } from './runcard.js';

const ECHO_PREFIX = /^(commented|asked the owner):\s*|^→ [^:]{1,60}:\s*|^🗣 planning discussion with [^:]{1,60}:\s*/i;
const MARKER = /^(❓|💬|🗣|📐|🧭)\s*(\*\*[^*]{1,80}\*\*:?\s*)?/;
/** Comparable text: no echo prefixes, no leading markers or bold labels, no markdown emphasis, single spaces. */
export function comparable(s) {
  return String(s || '').replace(ECHO_PREFIX, '').replace(MARKER, '').replace(/\*\*|`/g, '').replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
const near = (a, b, ms) => Math.abs(Date.parse(a) - Date.parse(b)) <= ms;
function echoes(e, c) {
  const consult = /^🗣 planning discussion with /i.test(e.text) && /^🗣 \*\*Asked /.test(c.body);
  if (!consult && c.author !== e.agent_id) return false;
  // Narration can precede its comment by the length of a run's wrap-up; everything else is written together.
  if (!near(c.ts, e.ts, e.kind === 'say' ? 180_000 : 5_000)) return false;
  const ev = comparable(e.text), body = comparable(c.body);
  if (!ev) return false;
  return body === ev || (ev.length >= 24 && body.startsWith(ev.slice(0, 300)));
}

const DISCUSSION_STATE = { queued: 'Waiting for the manager', running: 'The manager is working on it', complete: 'Response ready',
  approved: 'You approved the response', rejected: 'You rejected the response', changes_requested: 'You asked for changes', failed: 'Failed', cancelled: 'Cancelled' };

export function conversationItems({ comments = [], events = [], discussions = [], status = '', agent = '' } = {}) {
  const items = new Map();
  const lastOwner = comments.filter((c) => c.author === 'owner').reduce((m, c) => (c.ts > m ? c.ts : m), '');
  const lastAsk = [...comments].filter((c) => String(c.body).startsWith('❓')).sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.id - b.id).at(-1);
  for (const c of comments) {
    const ask = String(c.body).startsWith('❓');
    items.set(`c${c.id}`, { id: `c${c.id}`, ts: c.ts, who: c.author, text: c.body, kind: 'comment', ask,
      open: ask && c === lastAsk && status === 'needs_human' && !(lastOwner > c.ts) });
  }
  for (const e of events) {
    if (comments.some((c) => echoes(e, c))) continue;
    const technical = ['tool', 'plan'].includes(e.kind) || (e.kind === 'error' && isToolExit(e.text));
    items.set(`e${e.id}`, { id: `e${e.id}`, ts: e.ts, who: e.agent_id || 'system', runId: e.run_id,
      kind: technical ? 'technical' : e.kind, raw: e.text,
      text: e.kind === 'action' ? humanizeStep(e.text) : e.kind === 'error' ? humanizeError(e.text) : e.text });
  }
  for (const d of discussions) {
    items.set(`d${d.id}`, { id: `d${d.id}`, ts: d.created_at, who: 'manager', kind: 'discussion', discussionId: d.id, status: d.status,
      text: `Design discussion #${d.id}: ${DISCUSSION_STATE[d.status] || d.status}`, error: d.error || null });
  }
  // Same-millisecond writes: narration and steps first, then dialogue, then status rows; within a kind, write order.
  const rank = (i) => (i.kind === 'say' || i.kind === 'technical' ? 0 : i.kind === 'comment' ? 1 : 2);
  const sorted = [...items.values()].filter((i) => i.text && (!agent || i.who === agent))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || rank(a) - rank(b) || a.id[0].localeCompare(b.id[0]) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const grouped = [];
  for (const item of sorted) {
    const last = grouped.at(-1);
    if (item.kind === 'technical' && last?.kind === 'technical' && last.who === item.who && last.runId === item.runId) last.steps.push(item);
    else grouped.push(item.kind === 'technical' ? { ...item, steps: [item] } : item);
  }
  return grouped;
}

/** Calendar day label for separators in threads that span several days. */
export function dayLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export const nearLatest = ({ scrollHeight, scrollTop, clientHeight }) => scrollHeight - scrollTop - clientHeight < 48;
