// Pure PR helpers shared by Classic (prs.js) and the React desk. No DOM, no storage.
/** Only https links to github.com are rendered as PR links. */
export function safeGithubUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' && x.hostname === 'github.com' ? x.href : null; } catch { return null; }
}
/** @type {Record<string, string>} */
export const STATE_LABEL = { draft: 'Draft', open: 'Open', approved: 'Approved', merged: 'Merged', closed: 'Closed' };
export function stateOf(p) {
  if (p.state === 'MERGED') return 'merged';
  if (p.state === 'CLOSED') return 'closed';
  if (p.owner_approved || p.review === 'APPROVED') return 'approved';
  return p.draft ? 'draft' : 'open';
}
export function filterRows(rows, f) {
  const q = (f.q || '').toLowerCase();
  return rows.filter((p) => {
    const s = stateOf(p);
    if (f.state === 'active' && !['draft', 'open', 'approved'].includes(s)) return false;
    if (f.state && f.state !== 'active' && f.state !== 'all' && s !== f.state) return false;
    if (f.seat && p.seat !== f.seat) return false;
    if (f.requester && p.requester !== f.requester) return false;
    if (f.tag && !p.tags.includes(f.tag)) return false;
    if (q && !`${p.number} ${p.key || ''} ${p.title} ${p.branch} ${p.tags.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

