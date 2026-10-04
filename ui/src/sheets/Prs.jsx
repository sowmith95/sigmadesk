// PR console and PR actions, ported from public/prs.js (Classic keeps that file). Same endpoints and guards:
// merges send the checked head SHA, the method, the market-hours override and the review-override reason.
import { useEffect, useState } from 'react';
import { safeGithubUrl, STATE_LABEL, stateOf, filterRows } from '../../../public/prs-model.js';
import { nameOf } from '../../../public/names.js';
import { S, api, emit, closeSheet, openTicket, openSheet, ticketByKey } from '../store.js';
import { Sheet, SheetHead, Button, AsyncButton, Avatar } from '../kit/index.js';

const P = { rows: null, meta: {}, loading: false, error: '', at: 0 };
const filters = (() => { try { return JSON.parse(localStorage.getItem('sd.prs.filters') || 'null') || { q: '', state: 'active', seat: '', requester: '', tag: '' }; } catch { return { q: '', state: 'active', seat: '', requester: '', tag: '' }; } })();
const drafts = {};
const ago = (iso) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
const tname = (k) => nameOf(ticketByKey(k) || { title: k });
async function load(refresh = false) {
  if (P.loading) return;
  P.loading = true; emit();
  try { const r = await api('GET', `/api/prs${refresh ? '?refresh=1' : ''}`); P.rows = r.prs; P.meta = r; P.error = ''; P.at = Date.now(); }
  catch (e) { P.error = e.message; }
  P.loading = false; emit();
}

export function PrsSheet() {
  const [f, setF] = useState({ ...filters });
  useEffect(() => { if (!P.rows || Date.now() - P.at > 60_000) load(); }, []);
  const set = (patch) => { Object.assign(filters, patch); try { localStorage.setItem('sd.prs.filters', JSON.stringify(filters)); } catch { /* private */ } setF({ ...filters }); };
  const rows = P.rows || [];
  const names = Object.fromEntries(S.agents.map((a) => [a.id, a.name]));
  const count = (s) => rows.filter((p) => stateOf(p) === s).length;
  const seats = [...new Set(rows.map((p) => p.seat).filter(Boolean))], reqs = [...new Set(rows.map((p) => p.requester).filter(Boolean))], tags = [...new Set(rows.flatMap((p) => p.tags))].sort();
  const Sel = ({ k, label, opts }) => <select aria-label={label} value={f[k] || ''} onChange={(e) => set({ [k]: e.target.value })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  const list = filterRows(rows, f);
  return (
    <Sheet label="Pull requests" onClose={closeSheet} head={<SheetHead title="Pull requests" onClose={closeSheet} />}>
      <div className="prs-h">
        <div className="prs-sum">{['draft', 'open', 'approved', 'merged', 'closed'].map((s) => <button key={s} className={`pill ${s}`} type="button" aria-pressed={f.state === s} onClick={() => set({ state: f.state === s ? 'active' : s })}>{STATE_LABEL[s]} <b>{count(s)}</b></button>)}</div>
        <div className="prs-meta">{P.meta.busy_window && <span className="warn">Market-hours window: merges need an override</span>}<span>{P.meta.last_sync ? `GitHub synced ${ago(P.meta.last_sync)} ago` : ''}</span>
          <Button size="small" disabled={P.loading} onClick={() => load(true)}>{P.loading ? 'Syncing…' : 'Sync'}</Button></div>
      </div>
      <div className="prs-filters">
        <input type="search" placeholder="Search #, ticket, title, branch, tag…" value={f.q} aria-label="Search PRs" onChange={(e) => set({ q: e.target.value })} />
        <Sel k="state" label="State" opts={[['active', 'Active (draft/open/approved)'], ['all', 'All states'], ...Object.entries(STATE_LABEL)]} />
        <Sel k="seat" label="Built by" opts={[['', 'Built by: anyone'], ...seats.map((s) => [s, names[s] || s])]} />
        <Sel k="requester" label="Requested by" opts={[['', 'Requested by: anyone'], ...reqs.map((s) => [s, names[s] || s])]} />
        <Sel k="tag" label="Tag" opts={[['', 'Any tag'], ...tags.map((t) => [t, `#${t}`])]} />
      </div>
      {P.error && <div className="notice">Couldn't load PRs: {P.error}</div>}
      {!P.rows ? <div className="empty">Loading PRs from GitHub…</div> : list.length ? <div className="prs">{list.map((p) => {
        const s = stateOf(p);
        return (
          <button key={p.number} className={`pr-row ${s}`} type="button" onClick={() => openSheet({ type: 'pr', number: p.number })}>
            <span className="pr-n mono">#{p.number}</span><span className={`pr-state ${s}`}>{STATE_LABEL[s]}</span>
            <span className="pr-title">{p.key && <b>{tname(p.key)} </b>}<span className="pr-full">{p.title}</span>{p.tags.length > 0 && <span className="pr-tags">{p.tags.map((t) => <span key={t} className="chip-tag">#{t}</span>)}</span>}</span>
            <span className="pr-who">{p.seat ? <><Avatar id={p.seat} /> {names[p.seat] || p.seat}</> : p.author || ''}</span>
            <span className={`pr-checks ${p.checks}`} title={`CI ${p.checks}`}>{p.checks === 'passing' ? '● CI' : p.checks === 'failing' ? '✖ CI' : p.checks === 'pending' ? '◌ CI' : '– CI'}</span>
            <span className={p.mergeable === 'CONFLICTING' ? 'pr-conflict' : 'pr-noconflict'}>{p.mergeable === 'CONFLICTING' ? 'conflict' : ''}</span>
            <span className="pr-size mono"><i className="add">+{p.additions}</i> <i className="del">−{p.deletions}</i></span><span className="pr-age">{ago(p.merged_at || p.closed_at || p.updated_at)}</span>
          </button>
        );
      })}</div> : <div className="empty">No PRs match these filters.</div>}
    </Sheet>
  );
}

export function PrSheet() {
  const sh = S.sheet;
  useEffect(() => { load(!!P.rows); }, []);
  const p = (P.rows || []).find((x) => x.number === sh.number);
  const d = drafts[sh.number] ||= { method: 'squash', override: '', close: '', reviewer: '', tag: '', reason: '' };
  const [, force] = useState(0);
  const field = (k) => ({ value: d[k], onChange: (e) => { d[k] = e.target.value; force((n) => n + 1); } });
  const who = (id) => { const a = S.agents.find((x) => x.id === id); return a ? `${a.name} · ${a.role}` : id || '—'; };
  const head = <SheetHead title={p ? `#${p.number} ${p.title}` : `PR #${sh.number}`} onClose={closeSheet} />;
  if (!p) return <Sheet label={`PR #${sh.number}`} onClose={closeSheet} head={head}><div className="empty">{P.loading ? 'Loading…' : P.error || 'PR not found among desk PRs.'}</div></Sheet>;
  const s = stateOf(p);
  const href = safeGithubUrl(p.url);
  const dr = p.desk_review || {};
  const needsOverride = dr.required && !(dr.approvals_ok && !dr.unpublished);
  const verdict = { approve: 'approved', changes: 'changes requested', pending: 'reviewing' };
  const ms = p.merge_state;
  const mergeLabel = !ms ? null : ms.state === 'scheduled' ? `scheduled — merges automatically at ${ms.label}` : ms.state === 'conflict' ? `conflict in ${ms.files.join(', ') || '?'} — ${ms.resolver?.name || 'the builder'} is resolving`
    : ms.state === 'held' ? `on hold: ${ms.reason}` : ms.state === 'queued' ? `queued to merge (#${ms.position} in line)${ms.deploy_lock ? ` · waiting for the deploy of ${ms.deploy_lock.key}` : ''}` : ms.state === 'owner' ? `waiting for you: ${ms.reason}` : ms.state;
  const deskReviews = dr.required ? [dr.context, dr.independent].filter(Boolean).map((r) => `${r.name} (${r.role}): ${verdict[r.verdict] || r.verdict}`).join(' · ') || 'not started' : null;
  const blockers = [p.mergeable === 'CONFLICTING' && 'conflicts with base', p.checks === 'failing' && 'CI failing', p.checks === 'pending' && 'CI running'].filter(Boolean);
  const Row = ({ k, children }) => <div><span>{k}</span>{children}</div>;
  const runBtn = (path, body, ok, label, variant) => <AsyncButton variant={variant} run={async () => { await api('POST', `/api/prs/${p.number}/${path}`, body || {}); await load(true); }} ok={ok}>{label}</AsyncButton>;
  return (
    <Sheet label={`PR #${p.number}`} onClose={closeSheet} head={head}>
      {sh.banner && <div className="notice"><b>{sh.banner.error ? `Approved on the desk, but GitHub said: ${sh.banner.error}` : 'Approved'}</b>
        <div className="msg-t">{sh.banner.mode === 'label' ? 'GitHub does not allow approving your own PR, so it is recorded as a comment and the owner-approved label.' : sh.banner.mode === 'review' ? 'Recorded as a GitHub review approval.' : ''}</div>
        <div className="msg-t">What next: merge it, close it, or ask someone else to review?</div></div>}
      <div className="kv">
        <Row k="State"><b className={`pr-state ${s}`}>{STATE_LABEL[s]}</b></Row><Row k="CI">{p.checks}</Row><Row k="Mergeable">{p.mergeable || '—'}</Row>
        <Row k="Size">+{p.additions} −{p.deletions} · {p.files} files</Row>
        <Row k="Built by">{p.seat ? <span className="pr-who"><Avatar id={p.seat} /> {who(p.seat)}</span> : '—'}</Row><Row k="Requested by">{who(p.requester)}</Row>
        <Row k="Ticket">{p.key ? <button className="linkish" type="button" title={p.key} onClick={() => openTicket(p.key)}>{tname(p.key)} · {p.key}</button> : '—'}</Row>
        {deskReviews && <Row k="Desk review">{deskReviews}</Row>}{mergeLabel && <Row k="Auto-merge">{mergeLabel}</Row>}
        <Row k="Reviews">{[...p.reviews.map((r) => `${r.who}: ${r.state.toLowerCase()}`), ...p.reviewers.map((r) => `${r}: requested`)].join(', ') || '—'}</Row>
      </div>
      {href && <div className="row-actions"><a className="btn small" href={href} target="_blank" rel="noopener noreferrer">Open on GitHub</a></div>}
      <div className="section-title">Tags</div>
      <div className="tags-edit">{p.tags.map((t) => <span key={t} className="token">#{t}<AsyncButton aria-label={`Remove ${t}`} className="token-x" run={async () => { await api('POST', `/api/prs/${p.number}/tags`, { remove: [t] }); await load(true); }} ok="Tag removed">×</AsyncButton></span>)}
        <input type="text" placeholder="add tag…" aria-label="Add tag" {...field('tag')} />
        <AsyncButton size="small" run={async () => { if (!d.tag.trim()) return false; await api('POST', `/api/prs/${p.number}/tags`, { add: d.tag.split(',') }); d.tag = ''; await load(true); }} ok="Tagged">Add</AsyncButton></div>
      {p.state === 'OPEN' ? <>
        <div className="section-title">Decide</div>
        <div className="pr-actions">
          {!p.owner_approved && runBtn('approve', {}, 'Approved on GitHub', 'Approve', 'primary')}
          {p.draft && runBtn('ready', {}, 'Marked ready', 'Mark ready for review')}
          {p.key && ms && ['queued', 'scheduled', 'held'].includes(ms.state) && <AsyncButton run={async () => { await api('POST', `/api/tickets/${p.key}/merge-hold`, { hold: ms.state !== 'held' }); await load(true); }} ok={ms.state === 'held' ? 'Released' : 'Held'}>{ms.state === 'held' ? 'Release' : 'Hold'}</AsyncButton>}
        </div>
        <div className="pr-merge">
          <div className="warn">Merging into {P.meta.base || 'main'} deploys production.{blockers.length ? ` Blocked: ${blockers.join(', ')}.` : ''}</div>
          {needsOverride && <div className="warn">Not approved by both desk reviewers at this commit. The merge is refused unless you give a reason, which is posted on the PR.</div>}
          <div className="row-actions">
            <select aria-label="Merge method" {...field('method')}>{['squash', 'merge', 'rebase'].map((m) => <option key={m} value={m}>{m}</option>)}</select>
            {P.meta.busy_window && <input type="text" placeholder={`type: ${P.meta.override_phrase}`} aria-label="Market-hours override" {...field('override')} />}
            {needsOverride && <input type="text" placeholder="Merge without both reviewer approvals? Say why (audited on the PR)" aria-label="Review override reason" {...field('reason')} />}
            <AsyncButton variant="danger" disabled={blockers.length > 0} confirm={`Merge #${p.number} into ${P.meta.base || 'main'} (${d.method})? This deploys production.`}
              run={async () => { await api('POST', `/api/prs/${p.number}/merge`, { method: d.method, override: d.override || '', expected_sha: p.head_sha, override_reason: d.reason || '' }); d.override = ''; await load(true); }} ok="Merged">Merge</AsyncButton>
          </div>
        </div>
        <div className="row-actions"><input type="text" placeholder="GitHub login or org/team" aria-label="Reviewer" {...field('reviewer')} />
          <AsyncButton run={async () => { if (!d.reviewer.trim()) return false; await api('POST', `/api/prs/${p.number}/reviewer`, { login: d.reviewer.trim() }); d.reviewer = ''; await load(true); }} ok="Review requested">Add reviewer</AsyncButton></div>
        <div className="row-actions"><input type="text" placeholder="Why close? (posted on the PR)" aria-label="Close comment" {...field('close')} />
          <AsyncButton confirm={`Close #${p.number} without merging?`} run={async () => { await api('POST', `/api/prs/${p.number}/close`, { comment: d.close }); d.close = ''; await load(true); }} ok="Closed">Close PR</AsyncButton></div>
      </> : <div className="empty">{s === 'merged' ? `Merged ${p.merged_at ? new Date(p.merged_at).toLocaleString() : ''}` : 'Closed without merging.'}</div>}
    </Sheet>
  );
}
