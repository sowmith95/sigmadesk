// The program update: where the whole desk stands, in a few lines, computed from the board (no model, no cost).
// What shipped recently, what is stuck and why, and what needs the owner — the "TPM view" the owner reads first.
import { nameOf } from './names.js';

const H = 3600_000;
/** state: the desk snapshot; B: its board (attention.board). → { lines: [{ id, tone, text, keys }], shipped, stuck, needs } */
export function programUpdate(state, B, now = Date.now(), windowHours = 24) {
  const since = now - windowHours * H;
  // Shipped by when it shipped (done_at), never by a later edit of the ticket.
  const shipped = (B.shipped || []).map((x) => x.ticket).filter((t) => t && Date.parse(t.done_at || '') >= since);
  const stuck = [...(B.blocked || [])];
  const needs = B.needs_you || [];
  const first = needs.find((d) => d.id === B.do_first) || needs[0] || null;
  const lines = [];
  lines.push(shipped.length
    ? { id: 'shipped', tone: 'shipped', text: `Shipped in the last ${windowHours} h: ${shipped.slice(0, 3).map((t) => nameOf(t)).join(', ')}${shipped.length > 3 ? ` and ${shipped.length - 3} more` : ''}.`, keys: shipped.map((t) => t.key) }
    : { id: 'shipped', tone: 'muted', text: `Nothing shipped in the last ${windowHours} h.`, keys: [] });
  if (B.counts?.working) lines.push({ id: 'working', tone: 'muted', text: `${B.counts.working} being worked on now, ${B.counts.queued || 0} queued.`, keys: [] });
  if (stuck.length) lines.push({ id: 'stuck', tone: 'blocked', text: `Stuck without you: ${stuck.slice(0, 2).map((x) => `${x.name} (${String(x.reason || '').replace(/\.$/, '')})`).join('; ')}${stuck.length > 2 ? `; ${stuck.length - 2} more` : ''}.`, keys: stuck.map((x) => x.key) });
  if (needs.length) lines.push({ id: 'needs', tone: 'needs', text: `${needs.length} need${needs.length === 1 ? 's' : ''} you${first ? `; first: ${first.verb}` : ''}.${B.counts?.snoozed ? ` ${B.counts.snoozed} snoozed.` : ''}`, keys: first ? [first.key] : [] });
  else lines.push({ id: 'needs', tone: 'shipped', text: `Nothing needs you right now${B.counts?.snoozed ? ` (${B.counts.snoozed} snoozed)` : ''}.`, keys: [] });
  return { lines, shipped: shipped.length, stuck: stuck.length, needs: needs.length };
}
