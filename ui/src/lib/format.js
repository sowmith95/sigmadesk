// Pure formatting helpers shared by every view (no DOM, no React) so node:test can cover them.
export const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function waited(iso, now = Date.now()) {
  if (!iso) return '';
  const m = Math.max(0, (now - Date.parse(iso)) / 60_000);
  return m < 1 ? 'waiting under a minute' : m < 60 ? `waiting ${Math.round(m)} min` : m < 1440 ? `waiting ${Math.round(m / 60)} h` : `waiting ${Math.round(m / 1440)} d`;
}
export function until(iso, now = Date.now()) {
  if (!iso) return '';
  const m = (Date.parse(iso) - now) / 60_000;
  if (m <= 1) return 'now';
  if (m < 60) return `in ${Math.round(m)} min`;
  if (m < 1440) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} d`;
}
export const mins = (n) => (n == null ? '' : n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60} min`);
export const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const clean = (s) => String(s || '').replace(/\*\*/g, '').replace(/`/g, '');
export const prNumber = (url) => Number(String(url || '').match(/\/pull\/(\d+)/)?.[1]) || null;
export const questionText = (body) => String(body || '').replace(/^❓\s*(\*\*Question for the owner:\*\*)?\s*/, '').trim();
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
/** "a/b/c/file.py" → "file.py"; first two sentences; enough to decide, not a wall of paths. */
export function outcome(text, max = 260) {
  const t = clean(text).replace(/[\w.-]+(?:\/[\w.-]+){2,}/g, (p) => p.split('/').pop()).replace(/\s+/g, ' ').trim();
  // Split only at sentence punctuation followed by whitespace, so "file.py" or "v1.2" never ends a sentence.
  const two = t.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
  return two.length > max ? `${two.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : two;
}
export const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
export const firstWord = (s) => String(s || '').split(/\s+/)[0] || '';
