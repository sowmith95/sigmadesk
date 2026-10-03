// Human names for tickets: "Eastern session helpers" reads faster than "SD-5". Pure, so the browser and the server
// share it. An explicit name (set by the agent that filed the ticket, or renamed by the owner) always wins.

const LEAD_VERBS = new Set(['fix', 'fixes', 'add', 'adds', 'bound', 'preserve', 'track', 'honor', 'honour', 'make', 'implement',
  'use', 'show', 'update', 'remove', 'improve', 'support', 'ensure', 'handle', 'create', 'build', 'refactor', 'rework', 'migrate',
  'enable', 'disable', 'allow', 'prevent', 'stop', 'start', 'replace', 'rename', 'move', 'split', 'document', 'investigate', 'clarify']);
const DROP = new Set(['the', 'a', 'an', 'its', 'their', 'our', 'this', 'that', 'original', 'new', 'existing', 'my', 'me', 'i', 'we', 'you', 'please']);
// Leading filler in question-style titles ("Can the desk show my …?").
const LEAD_SKIP = new Set(['can', 'could', 'should', 'would', 'will', 'is', 'are', 'do', 'does', 'why', 'how', 'what', 'please',
  'desk', 'board', 'we', 'i', 'you', 'show', 'see', 'get', 'display', 'let', 'me', 'my', 'the', 'a', 'an']);
const STOP_AT = new Set(['and', 'using', 'with', 'in', 'for', 'by', 'so', 'to', 'via', 'when', 'from', 'on', 'into', 'without', 'while', 'that', 'which', 'per']);
// Dotted/path/expression tokens are noise in a name; plain identifiers (is_rth) are kept without "()".
const codeLike = (w) => /[./=<>]/.test(w) || /^\d+$/.test(w);
const clean = (w) => w.replace(/\(\)$/, '').replace(/[?!]+$/, '');

export function shortName(title, maxWords = 4) {
  let s = String(title || '').replace(/^\s*\[[^\]]+\]\s*/, '').replace(/^(bug|feature|task|chore|regression)\s*[:\-–]\s*/i, '').trim();
  // "Fix DST bug: helpers hardcode UTC-5" → the part before the colon usually is the name.
  const head = s.split(/\s*[:—–]\s+/)[0];
  if (head && head !== s && head.split(/\s+/).length >= 2 && head.split(/\s+/).length <= 6) s = head;
  const words = s.replace(/[,;]/g, ' , ').split(/\s+/).filter(Boolean).map(clean).filter(Boolean);
  const out = [];
  let leading = true;
  for (const [i, w] of words.entries()) {
    const lw = w.toLowerCase();
    if (leading && (LEAD_SKIP.has(lw) || (i === 0 && LEAD_VERBS.has(lw))) && i < words.length - 1) continue;
    leading = false;
    if (w === ',' || (STOP_AT.has(lw) && out.length >= 2)) break;
    if (DROP.has(lw) || codeLike(w)) continue;
    out.push(w);
    if (out.length >= maxWords) break;
  }
  while (out.length > 1 && /^(after|before|if|because|until|of|at|as|than|then|but|or|and)$/i.test(out[out.length - 1])) out.pop();
  const name = (out.length ? out : words.slice(0, maxWords)).join(' ').replace(/[:.]+$/, '');
  return name ? name[0].toUpperCase() + name.slice(1) : String(title || '').slice(0, 40);
}

/** Display name for a ticket: explicit alias first, else derived from the title. */
export function nameOf(t) {
  if (!t) return '';
  return (t.name && String(t.name).trim()) || shortName(t.title);
}

const KEY_RE = /\b([A-Z][A-Z0-9]{0,5}-\d+)\b/g;
/** Split text into [string | {key, name}] parts so UIs can render ticket mentions as named chips. */
export function linkKeys(text, lookup) {
  const out = [];
  let last = 0;
  for (const m of String(text ?? '').matchAll(KEY_RE)) {
    const t = lookup(m[1]);
    if (!t) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ key: m[1], name: nameOf(t) });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) out.push(String(text).slice(last));
  return out;
}
