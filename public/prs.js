// PR console: every PR the desk opened, live GitHub state, filters, tags, and owner actions.
// Receives the app's helpers (h, api, sheetShell, …) so it renders exactly like the rest of the UI.

const st = {
  rows: null, meta: {}, loading: false, error: '', loadedAt: 0,
  f: JSON.parse((typeof globalThis.localStorage?.getItem === 'function' && localStorage.getItem('sd.prs.filters')) || '{"q":"","state":"active","seat":"","requester":"","tag":""}'),
};
const saveFilters = () => typeof globalThis.localStorage?.setItem === 'function' && localStorage.setItem('sd.prs.filters', JSON.stringify(st.f));

const STATE_LABEL = { draft: 'Draft', open: 'Open', approved: 'Approved', merged: 'Merged', closed: 'Closed' };
export function stateOf(p) {
  if (p.state === 'MERGED') return 'merged';
  if (p.state === 'CLOSED') return 'closed';
  if (p.owner_approved || p.review === 'APPROVED') return 'approved';
  return p.draft ? 'draft' : 'open';
}
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

async function load(ctx, refresh = false) {
  if (st.loading) return;
  st.loading = true;
  try {
    const r = await ctx.api('GET', `/api/prs${refresh ? '?refresh=1' : ''}`);
    st.rows = r.prs;
    st.meta = r;
    st.error = '';
    st.loadedAt = Date.now();
  } catch (e) { st.error = e.message; }
  st.loading = false;
  ctx.render();
  if (ctx.S.sheet?.type === 'pr') renderSheet(ctx);
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

export function renderPage(ctx) {
  const { h, avatar, S } = ctx;
  if (!st.rows && !st.loading) load(ctx);
  if (st.rows && Date.now() - st.loadedAt > 60_000 && !st.loading) load(ctx);
  const rows = st.rows || [];
  const names = Object.fromEntries(S.agents.map((a) => [a.id, a.name]));
  const count = (s) => rows.filter((p) => stateOf(p) === s).length;
  const seats = [...new Set(rows.map((p) => p.seat).filter(Boolean))];
  const reqs = [...new Set(rows.map((p) => p.requester).filter(Boolean))];
  const tags = [...new Set(rows.flatMap((p) => p.tags))].sort();
  const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: (e) => { st.f[key] = e.target.value; saveFilters(); ctx.render(); } },
    opts.map(([v, l]) => h('option', { value: v, selected: (st.f[key] || '') === v }, l)));
  const list = filterRows(rows, st.f);
  return [
    h('div', { class: 'prs-h' },
      h('div', { class: 'prs-sum' }, ['draft', 'open', 'approved', 'merged', 'closed'].map((s) => h('button', {
        class: `pill ${s}`, type: 'button', 'aria-pressed': String(st.f.state === s), onclick: () => { st.f.state = st.f.state === s ? 'active' : s; saveFilters(); ctx.render(); },
      }, `${STATE_LABEL[s]} `, h('b', {}, count(s))))),
      h('div', { class: 'prs-meta' }, st.meta.busy_window ? h('span', { class: 'warn' }, '◐ market-hours window: merges need an override') : null,
        h('span', {}, st.meta.last_sync ? `GitHub synced ${ago(st.meta.last_sync)} ago` : ''),
        h('button', { class: 'btn small', type: 'button', disabled: st.loading, onclick: () => load(ctx, true) }, st.loading ? 'Syncing…' : '↻ Sync'))),
    h('div', { class: 'prs-filters' },
      h('input', { type: 'search', placeholder: 'Search #, ticket, title, branch, tag…', value: st.f.q, 'aria-label': 'Search PRs',
        oninput: (e) => { st.f.q = e.target.value; saveFilters(); clearTimeout(st.t); st.t = setTimeout(ctx.render, 200); } }),
      sel('state', 'State', [['active', 'Active (draft/open/approved)'], ['all', 'All states'], ...Object.entries(STATE_LABEL)]),
      sel('seat', 'Built by', [['', 'Built by: anyone'], ...seats.map((s) => [s, names[s] || s])]),
      sel('requester', 'Requested by', [['', 'Requested by: anyone'], ...reqs.map((s) => [s, names[s] || s])]),
      sel('tag', 'Tag', [['', 'Any tag'], ...tags.map((t) => [t, `#${t}`])])),
    st.error ? h('div', { class: 'ask' }, `Couldn't load PRs: ${st.error}`) : null,
    !st.rows ? h('div', { class: 'empty' }, 'Loading PRs from GitHub…')
      : list.length ? h('div', { class: 'prs' }, list.map((p) => {
        const s = stateOf(p);
        return h('button', { class: `pr-row ${s}`, type: 'button', onclick: () => openActions(ctx, p.number) },
          h('span', { class: 'pr-n mono' }, `#${p.number}`),
          h('span', { class: `pr-state ${s}` }, STATE_LABEL[s]),
          h('span', { class: 'pr-title' }, p.key ? h('b', {}, `${ctx.nameOf ? ctx.nameOf(p.key) : p.key} `) : null, h('span', { class: 'pr-full' }, p.title),
            p.tags.length ? h('span', { class: 'pr-tags' }, p.tags.map((t) => h('span', { class: 'chip-tag' }, `#${t}`))) : null),
          h('span', { class: 'pr-who' }, p.seat ? [avatar(p.seat), ` ${names[p.seat] || p.seat}`] : (p.author || '')),
          h('span', { class: `pr-checks ${p.checks}`, title: `CI ${p.checks}` }, p.checks === 'passing' ? '● CI' : p.checks === 'failing' ? '✖ CI' : p.checks === 'pending' ? '◌ CI' : '– CI'),
          h('span', { class: p.mergeable === 'CONFLICTING' ? 'pr-conflict' : 'pr-noconflict' }, p.mergeable === 'CONFLICTING' ? 'conflict' : ''),
          h('span', { class: 'pr-size mono' }, h('i', { class: 'add' }, `+${p.additions}`), ' ', h('i', { class: 'del' }, `−${p.deletions}`)),
          h('span', { class: 'pr-age' }, ago(p.merged_at || p.closed_at || p.updated_at)));
      })) : h('div', { class: 'empty' }, 'No PRs match these filters.'),
  ];
}

export function openActions(ctx, number, banner = null) {
  ctx.S.sheet = { type: 'pr', number, banner };
  if (!st.rows) load(ctx); else load(ctx, true);
  renderSheet(ctx);
}

export function renderSheet(ctx) {
  const { h, api, act, sheetShell, closeSheet, openTicket, S, avatar } = ctx;
  const sh = S.sheet;
  const nameOf = (id) => { const a = S.agents.find((x) => x.id === id); return a ? `${a.name} · ${a.role}` : id || '—'; };
  const p = (st.rows || []).find((x) => x.number === sh.number);
  const head = h('div', { class: 'row' }, h('h2', {}, p ? `#${p.number} ${p.title}` : `PR #${sh.number}`), h('button', { class: 'close', type: 'button', 'aria-label': 'close', onclick: closeSheet }, '×'));
  if (!p) return sheetShell(head, h('div', { class: 'empty' }, st.loading ? 'Loading…' : 'PR not found among desk PRs.'));
  const s = stateOf(p);
  const open = p.state === 'OPEN';
  const run = (path, body, ok) => act(async () => { await api('POST', `/api/prs/${p.number}/${path}`, body || {}); await load(ctx, true); }, ok);
  const method = h('select', { 'aria-label': 'Merge method' }, ['squash', 'merge', 'rebase'].map((m) => h('option', { value: m }, m)));
  const override = st.meta.busy_window ? h('input', { type: 'text', placeholder: `type: ${st.meta.override_phrase}`, 'aria-label': 'Market-hours override' }) : null;
  const closeNote = h('input', { type: 'text', placeholder: 'Why close? (posted on the PR)', 'aria-label': 'Close comment' });
  const reviewer = h('input', { type: 'text', placeholder: 'GitHub login or org/team', 'aria-label': 'Reviewer' });
  const tagIn = h('input', { type: 'text', placeholder: 'add tag…', 'aria-label': 'Add tag' });
  const blockers = [p.mergeable === 'CONFLICTING' && 'conflicts with base', p.checks === 'failing' && 'CI failing', p.checks === 'pending' && 'CI running'].filter(Boolean);
  const body = [
    sh.banner ? h('div', { class: 'ask' }, h('b', {}, sh.banner.error ? `Approved on the desk, but GitHub said: ${sh.banner.error}` : '👍 Approved'),
      h('div', { class: 'msg-t' }, sh.banner.mode === 'label' ? 'GitHub does not allow approving your own PR, so it is recorded as a comment and the owner-approved label.' : sh.banner.mode === 'review' ? 'Recorded as a GitHub review approval.' : ''),
      h('div', { class: 'msg-t' }, 'What next — merge it, close it, or ask someone else to review?')) : null,
    h('div', { class: 'kv' },
      h('div', {}, h('span', {}, 'State'), h('b', { class: `pr-state ${s}` }, STATE_LABEL[s])),
      h('div', {}, h('span', {}, 'CI'), p.checks),
      h('div', {}, h('span', {}, 'Mergeable'), p.mergeable || '—'),
      h('div', {}, h('span', {}, 'Size'), `+${p.additions} −${p.deletions} · ${p.files} files`),
      h('div', {}, h('span', {}, 'Built by'), p.seat ? h('span', { class: 'pr-who' }, avatar(p.seat), ` ${nameOf(p.seat)}`) : '—'),
      h('div', {}, h('span', {}, 'Requested by'), nameOf(p.requester)),
      h('div', {}, h('span', {}, 'Ticket'), p.key ? h('button', { class: 'linkish', type: 'button', title: p.key, onclick: () => openTicket(p.key) }, `${ctx.nameOf ? ctx.nameOf(p.key) : p.key} · ${p.key}`) : '—'),
      h('div', {}, h('span', {}, 'Reviews'), [...p.reviews.map((r) => `${r.who}: ${r.state.toLowerCase()}`), ...p.reviewers.map((r) => `${r}: requested`)].join(', ') || '—')),
    h('div', { class: 'row-actions' }, h('a', { class: 'btn small', href: p.url, target: '_blank', rel: 'noopener' }, 'Open on GitHub ↗')),
    h('div', { class: 'section-title' }, 'Tags'),
    h('div', { class: 'tags-edit' }, p.tags.map((t) => h('span', { class: 'chip-tag' }, `#${t} `, h('button', { class: 'linkish', type: 'button', 'aria-label': `remove ${t}`, onclick: run('tags', { remove: [t] }, 'tag removed') }, '×'))),
      tagIn, h('button', { class: 'btn small', type: 'button', onclick: act(async () => { if (!tagIn.value.trim()) return; await api('POST', `/api/prs/${p.number}/tags`, { add: tagIn.value.split(',') }); await load(ctx, true); }, 'tagged') }, 'Add')),
    open ? [
      h('div', { class: 'section-title' }, 'Decide'),
      h('div', { class: 'pr-actions' },
        !p.owner_approved ? h('button', { class: 'btn primary', type: 'button', onclick: run('approve', {}, 'approved on GitHub') }, '👍 Approve') : null,
        p.draft ? h('button', { class: 'btn', type: 'button', onclick: run('ready', {}, 'marked ready') }, 'Mark ready for review') : null),
      h('div', { class: 'pr-merge' },
        h('div', { class: 'warn' }, `⚠ Merging into ${st.meta.base || 'main'} deploys production.${blockers.length ? ` Blocked: ${blockers.join(', ')}.` : ''}`),
        h('div', { class: 'row-actions' }, method, override,
          h('button', { class: 'btn danger', type: 'button', disabled: blockers.length > 0, onclick: act(async () => {
            if (!confirm(`Merge #${p.number} into ${st.meta.base || 'main'} (${method.value})? This deploys production.`)) return;
            await api('POST', `/api/prs/${p.number}/merge`, { method: method.value, override: override?.value || '' });
            await load(ctx, true);
          }, 'merged') }, '🔀 Merge'))),
      h('div', { class: 'row-actions' }, reviewer, h('button', { class: 'btn', type: 'button', onclick: act(async () => { if (!reviewer.value.trim()) return; await api('POST', `/api/prs/${p.number}/reviewer`, { login: reviewer.value.trim() }); await load(ctx, true); }, 'review requested') }, '👥 Add reviewer')),
      h('div', { class: 'row-actions' }, closeNote, h('button', { class: 'btn', type: 'button', onclick: act(async () => {
        if (!confirm(`Close #${p.number} without merging?`)) return;
        await api('POST', `/api/prs/${p.number}/close`, { comment: closeNote.value });
        await load(ctx, true);
      }, 'closed') }, '🚫 Close PR')),
    ] : h('div', { class: 'empty' }, s === 'merged' ? `Merged ${p.merged_at ? new Date(p.merged_at).toLocaleString() : ''}` : 'Closed without merging.'),
  ];
  sheetShell(head, body);
}
