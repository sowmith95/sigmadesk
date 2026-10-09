// HTML → plain text for `desk fetch` (#8). One linear pass, no backtracking regular expressions: every search moves
// strictly forward (a `<` with no `>` after it ends tag parsing for the rest of the input), so the cost is O(n) in the
// input whatever it contains. Inputs are capped; the desk runs this in a worker thread with a time budget
// (htmlToTextBounded) so even a pathological page cannot stall the desk's event loop.
import { Worker } from 'node:worker_threads';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'head', 'form', 'button', 'select', 'textarea', 'math', 'canvas']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'li', 'ul', 'ol', 'table', 'tr', 'pre', 'blockquote', 'dd', 'dt', 'dl', 'figure', 'figcaption']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export const MAX_HTML_CHARS = 2_000_000;

const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45;
const lowerAscii = (s) => { let o = ''; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i]; } return o; };

/** Decode entities in a text run (bounded lookahead of at most 12 characters per `&`). */
function decode(s) {
  if (!s.includes('&')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '&') { out += s[i]; continue; }
    let end = -1;
    for (let k = i + 1; k < s.length && k <= i + 12; k++) if (s[k] === ';') { end = k; break; } // bounded: never a scan to the end
    if (end < 0) { out += '&'; continue; }
    const e = s.slice(i + 1, end);
    let rep = null;
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      if (Number.isInteger(n)) rep = n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : ' ';
    } else rep = ENTITIES[lowerAscii(e)] ?? null;
    if (rep === null) { out += '&'; continue; }
    out += rep; i = end;
  }
  return out;
}
const CONTROL = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x7f]);
function clean(s) {
  let o = '';
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c < 32 && c !== 10 && c !== 9) || CONTROL.has(c)) continue; o += c === 9 ? ' ' : s[i]; }
  return o;
}

/** Plain text from HTML: scripts, styles, forms and comments dropped, block elements become line breaks, tags removed. */
export function htmlToText(html, { maxChars = MAX_HTML_CHARS } = {}) {
  const src = String(html ?? '').slice(0, maxChars);
  const lower = lowerAscii(src); // once: every close-tag search below is a forward indexOf on it
  const parts = [];
  let i = 0;
  let noMoreTags = false;
  const n = src.length;
  while (i < n) {
    const lt = noMoreTags ? -1 : src.indexOf('<', i);
    if (lt < 0) { parts.push(decode(src.slice(i))); break; }
    if (lt > i) parts.push(decode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) break; i = e + 3; parts.push(' '); continue; }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) { noMoreTags = true; parts.push(decode(src.slice(lt))); break; }
    let j = lt + 1;
    const closing = src[j] === '/';
    if (closing) j++;
    const start = j;
    while (j < gt && isNameChar(src.charCodeAt(j))) j++;
    const name = lowerAscii(src.slice(start, j));
    i = gt + 1;
    if (!name) { parts.push(' '); continue; } // <!doctype>, <?xml?>, stray "< " …
    if (!closing && SKIP.has(name) && src[gt - 1] !== '/') {
      // Skip to the matching close tag (a forward search; none = drop the rest).
      const close = lower.indexOf(`</${name}`, i);
      if (close < 0) break;
      const e = src.indexOf('>', close);
      if (e < 0) break;
      i = e + 1; parts.push(' ');
      continue;
    }
    if (name === 'br' || name === 'hr') parts.push('\n');
    else if (!closing && name === 'li') parts.push('\n- ');
    else if (!closing && /^h[1-6]$/.test(name)) parts.push(`\n\n${'#'.repeat(Number(name[1]))} `);
    else if (closing && (BLOCK.has(name) || /^h[1-6]$/.test(name))) parts.push('\n');
    else if (closing && (name === 'td' || name === 'th')) parts.push(' ');
    else parts.push('');
  }
  const text = clean(parts.join(''));
  const lines = text.split('\n').map((l) => l.split(' ').filter(Boolean).join(' '));
  const out = [];
  let blank = 0;
  for (const l of lines) { if (!l) { if (++blank <= 1 && out.length) out.push(''); } else { blank = 0; out.push(l); } }
  while (out.length && !out.at(-1)) out.pop();
  return out.join('\n');
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then((m) => parentPort.postMessage({ text: m.htmlToText(workerData.html, { maxChars: workerData.maxChars }) }), (e) => parentPort.postMessage({ error: String(e.message) }));
`;
/** htmlToText in a worker thread, terminated after `timeoutMs`: the desk's event loop never runs the parser. */
export function htmlToTextBounded(html, { timeoutMs = 2000, maxChars = MAX_HTML_CHARS } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: { url: import.meta.url, html: String(html ?? '').slice(0, maxChars), maxChars }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { w.terminate(); reject(Object.assign(new Error(`the page took longer than ${timeoutMs} ms to convert`), { status: 422 })); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); if (m.error) reject(new Error(m.error)); else resolve(m.text); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
