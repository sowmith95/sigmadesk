// @mentions in the ticket composer and thread. Pure (no DOM), so the picker's rules are unit-tested:
//   - typing "@" at the start of a word opens the picker; the text after it (no spaces) filters seats
//   - picking a seat writes "@Name " into the text; what the text shows as tags is exactly what is sent
//   - each tagged seat's delivery reads like messaging: Queued, Working, Replied, Blocked (why), Failed, Cancelled

const first = (s) => String(s || '').split(/\s+/)[0];

/** The handle a seat is written with: its first name, or its id when another seat shares that first name. */
export function handleOf(agent, agents = []) {
  const name = first(agent?.name);
  const clash = agents.some((a) => a.id !== agent.id && first(a.name).toLowerCase() === name.toLowerCase());
  return clash || !name ? agent.id : name;
}

/** An open "@query" ending at the caret (null when the caret is not in one). */
export function mentionQuery(text, caret = String(text || '').length) {
  const before = String(text || '').slice(0, caret);
  const m = before.match(/(^|[^\w@.])@([\w-]{0,40})$/);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

/** Live state of a seat for the picker: free, busy (and on what), or switched off. */
export function seatState(agent, ticketName = (k) => k) {
  if (!agent || agent.enabled === false) return { key: 'off', text: 'switched off' };
  if (agent.status === 'working') return { key: 'busy', text: agent.current_ticket ? `busy on ${ticketName(agent.current_ticket)}` : 'busy' };
  return { key: 'free', text: 'free' };
}

/** Seats matching a query: name, id or role prefix (then anywhere in the name/role); switched-off seats last. */
export function matchSeats(agents = [], query = '') {
  const q = String(query || '').toLowerCase();
  const score = (a) => {
    const name = String(a.name || '').toLowerCase(), id = String(a.id).toLowerCase(), role = String(a.role || '').toLowerCase();
    if (!q) return 1;
    if (name.startsWith(q) || id.startsWith(q)) return 0;
    if (role.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (name.includes(q) || role.includes(q)) return 2;
    return -1;
  };
  return agents.map((a, i) => ({ a, i, s: score(a) })).filter((x) => x.s >= 0)
    .sort((x, y) => Number(x.a.enabled === false) - Number(y.a.enabled === false) || x.s - y.s || x.i - y.i).map((x) => x.a);
}

/** Replace the open "@query" with "@Handle " and say where the caret goes. */
export function insertMention(text, q, handle) {
  const s = String(text || '');
  const end = q.start + 1 + q.query.length;
  const rest = s.slice(end);
  const insert = `@${handle}${/^\s/.test(rest) ? '' : ' '}`;
  return { text: `${s.slice(0, q.start)}${insert}${rest}`, caret: q.start + insert.length };
}

/** Text split into plain parts and seat tags: [{ text } | { text, seat }]. Unknown @handles stay plain text. */
export function tokensIn(text, agents = []) {
  const s = String(text || '');
  const out = [];
  let at = 0;
  for (const m of s.matchAll(/(^|[^\w@.])@([A-Za-z][\w-]{0,40})/g)) {
    const h = m[2].toLowerCase().replace(/[-_]+$/, '');
    const seat = agents.find((a) => a.id === h) || agents.find((a) => first(a.name).toLowerCase() === h);
    if (!seat) continue;
    const start = m.index + m[1].length;
    if (start > at) out.push({ text: s.slice(at, start) });
    out.push({ text: `@${m[2].replace(/[-_]+$/, '')}`, seat: seat.id });
    at = start + 1 + m[2].replace(/[-_]+$/, '').length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** The seats a message tags, in order, once each: exactly the tags the composer shows. */
export const taggedSeats = (text, agents = []) => [...new Set(tokensIn(text, agents).filter((p) => p.seat).map((p) => p.seat))];

/** Take every tag of this seat out of the text (and the space after it), leaving the rest as written. */
export function removeMention(text, seat, agents = []) {
  const parts = tokensIn(text, agents);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].seat !== seat) { out += parts[i].text; continue; }
    const next = parts[i + 1];
    if (next && !next.seat) parts[i + 1] = { text: out === '' || /\s$/.test(out) ? next.text.replace(/^[ \t]+/, '') : next.text };
  }
  return out;
}

/**
 * Make the text tag exactly `seats` (the people picker's "Tag N people"): tags of seats no longer chosen come out; new
 * ones go where the open "@query" is (replacing it), else at the caret, else in front. Returns { text, caret }.
 * @param {string} text @param {string[]} seats @param {any[]} [agents] @param {number|null} [caret]
 */
export function setMentions(text, seats, agents = [], caret = null) {
  let s = String(text || '');
  for (const id of taggedSeats(s, agents)) if (!seats.includes(id)) s = removeMention(s, id, agents);
  const have = taggedSeats(s, agents);
  const add = seats.filter((id) => !have.includes(id)).map((id) => agents.find((a) => a.id === id)).filter(Boolean);
  const at = caret == null ? null : Math.min(caret, s.length);
  const q = at == null ? null : mentionQuery(s, at);
  if (!add.length) {
    // Nothing new: a dangling "@" or "@query" the picker was opened from goes away.
    if (q) { const end = q.start + 1 + q.query.length; s = s.slice(0, q.start) + s.slice(end).replace(/^ /, ''); return { text: s, caret: q.start }; }
    return { text: s, caret: at ?? s.length };
  }
  const handles = add.map((a) => `@${handleOf(a, agents)}`).join(' ');
  if (q) { const end = q.start + 1 + q.query.length; const rest = s.slice(end); const ins = `${handles}${/^\s/.test(rest) ? '' : ' '}`; return { text: s.slice(0, q.start) + ins + rest, caret: q.start + ins.length }; }
  const pos = at ?? 0;
  const before = s.slice(0, pos), after = s.slice(pos);
  const ins = `${before && !/\s$/.test(before) ? ' ' : ''}${handles}${/^\s/.test(after) ? '' : ' '}`;
  return { text: before + ins + after, caret: before.length + ins.length };
}

const STATE = {
  queued: { label: 'Queued', tone: 'neutral' }, working: { label: 'Working', tone: 'action' }, replied: { label: 'Replied', tone: 'shipped' },
  blocked: { label: 'Blocked', tone: 'blocked' }, failed: { label: 'Failed', tone: 'blocked' }, cancelled: { label: 'Cancelled', tone: 'neutral' },
};
/**
 * One recipient's delivery, for the line under the owner's message.
 * output: { label, tone, detail, retry, cancel } — detail is the plain reason or what happened.
 */
export function deliveryView(m, { busy = false } = {}) {
  const s = STATE[m.status] || { label: m.status, tone: 'neutral' };
  const routed = String(m.routed || '');
  const detail = m.status === 'queued' ? (busy ? 'up next, after their current work' : m.reason && /restart|interrupt/.test(m.reason) ? m.reason : 'up next')
    : m.status === 'replied' ? (routed.startsWith('verify:') ? `sent the check to the SRE (${routed.slice(7)})` : routed.startsWith('task:') ? `filed ${routed.slice(5)}`
      : routed === 'implement' ? 'routed the change' : routed === 'design' ? 'took the design' : '')
      : ['blocked', 'failed'].includes(m.status) ? m.reason || '' : m.status === 'cancelled' ? m.reason || '' : '';
  return { ...s, detail, retry: ['failed', 'blocked', 'cancelled'].includes(m.status), cancel: ['queued', 'working'].includes(m.status) };
}
