// Pull requests page and PR action panel. Same endpoints and guards as Classic: merges send the checked head SHA,
// method, market-hours override and review-override reason.
import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { safeGithubUrl, STATE_LABEL, stateOf, filterRows } from '../../../public/prs-model.js';
import { nameOf } from '../../../public/names.js';
import { S, api, emit, closeSheet, openTicket, openSheet, ticketByKey } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Panel } from '@/components/desk/Panel';
import { ChoiceChips } from '@/components/desk/Choices';
import { Tag, SeatAvatar, Empty } from '@/components/desk/Bits';
import { Lineage } from '@/components/desk/Epic';
import { cn } from '@/lib/utils';

type Pr = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const P: { rows: Pr[] | null; meta: Pr; loading: boolean; error: string; at: number } = { rows: null, meta: {}, loading: false, error: '', at: 0 };
const filters = (() => { try { return JSON.parse(localStorage.getItem('sd.prs.filters') || 'null') || { q: '', state: 'active', seat: '', requester: '', tag: '' }; } catch { return { q: '', state: 'active', seat: '', requester: '', tag: '' }; } })();
const drafts: Record<number, Record<string, string>> = {};
const ago = (iso?: string) => { if (!iso) return ''; const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };
const tname = (k: string) => nameOf(ticketByKey(k) || { title: k });
export async function loadPrRows(refresh = false) {
  if (P.loading) return;
  P.loading = true; emit();
  try { const r = await api('GET', `/api/prs${refresh ? '?refresh=1' : ''}`); P.rows = r.prs; P.meta = r; P.error = ''; P.at = Date.now(); }
  catch (e) { P.error = (e as Error).message; }
  P.loading = false; emit();
}
const STATE_TONE: Record<string, 'shipped' | 'neutral' | 'action'> = { merged: 'shipped', approved: 'shipped', closed: 'neutral', open: 'action', draft: 'neutral' };

export default function PrsPage() {
  const [f, setF] = useState({ ...filters });
  useEffect(() => { if (!P.rows || Date.now() - P.at > 60_000) loadPrRows(); }, []);
  const set = (patch: Record<string, string>) => { Object.assign(filters, patch); try { localStorage.setItem('sd.prs.filters', JSON.stringify(filters)); } catch { /* private */ } setF({ ...filters }); };
  const rows = P.rows || [];
  const names = Object.fromEntries(S.agents.map((a: { id: string; name: string }) => [a.id, a.name]));
  const count = (s: string) => rows.filter((p) => stateOf(p) === s).length;
  const seats = [...new Set(rows.map((p) => p.seat).filter(Boolean))] as string[];
  const tags = [...new Set(rows.flatMap((p) => p.tags))].sort() as string[];
  const list = filterRows(rows, f);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <ChoiceChips label="State" hideLabel size="sm" value={f.state} onChange={(state) => set({ state })}
          options={[{ value: 'active', label: 'Active' }, ...['draft', 'open', 'approved', 'merged', 'closed'].map((s) => ({ value: s, label: STATE_LABEL[s], hint: String(count(s)) })), { value: 'all', label: 'All' }]} />
        <span className="flex-1" />
        {P.meta.busy_window && <Tag tone="needs">Market hours: merges need an override</Tag>}
        <span className="text-sm text-muted-foreground">{P.meta.last_sync ? `Synced with GitHub ${ago(P.meta.last_sync)} ago` : ''}</span>
        <Button variant="secondary" disabled={P.loading} onClick={() => loadPrRows(true)}><RefreshCw className={cn('size-4', P.loading && 'animate-spin')} />{P.loading ? 'Syncing…' : 'Sync'}</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Input type="search" aria-label="Search pull requests" placeholder="Search number, ticket, title, branch or tag" value={f.q} onChange={(e) => set({ q: e.target.value })} className="max-w-sm" />
        <select aria-label="Built by" value={f.seat || ''} onChange={(e) => set({ seat: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2"><option value="">Built by anyone</option>{seats.map((s) => <option key={s} value={s}>{names[s] || s}</option>)}</select>
        <select aria-label="Tag" value={f.tag || ''} onChange={(e) => set({ tag: e.target.value })} className="h-9 rounded-md border border-input bg-background px-2"><option value="">Any tag</option>{tags.map((t) => <option key={t} value={t}>#{t}</option>)}</select>
      </div>
      {P.error && <p className="rounded-md bg-needs/15 px-3 py-2">Couldn't load pull requests: {P.error}</p>}
      {!P.rows ? <p className="text-muted-foreground">Loading pull requests from GitHub…</p> : list.length ? (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {list.map((p: Pr) => { const s = stateOf(p); return (
            <button key={p.number} type="button" onClick={() => openSheet({ type: 'pr', number: p.number })} className="grid w-full gap-1.5 px-4 py-3 text-left hover:bg-secondary md:grid-cols-[72px_96px_1fr_auto] md:items-center md:gap-4">
              <span className="font-mono text-sm text-muted-foreground">#{p.number}</span>
              <span><Tag tone={STATE_TONE[s]}>{STATE_LABEL[s]}</Tag></span>
              <span className="grid min-w-0 gap-0.5">{p.key && <Lineage t={ticketByKey(p.key)} link={false} />}{p.key && <b className="truncate">{tname(p.key)}</b>}<span className="truncate text-sm text-muted-foreground">{p.title}</span>
                {p.tags.length > 0 && <span className="flex flex-wrap gap-1">{p.tags.map((t: string) => <Tag key={t}>#{t}</Tag>)}</span>}</span>
              <span className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                {p.seat && <span className="inline-flex items-center gap-1.5"><SeatAvatar id={p.seat} />{names[p.seat] || p.seat}</span>}
                <Tag tone={p.checks === 'passing' ? 'shipped' : p.checks === 'failing' ? 'blocked' : p.checks === 'pending' ? 'needs' : 'neutral'}>CI {p.checks}</Tag>
                {p.mergeable === 'CONFLICTING' && <Tag tone="blocked">Conflict</Tag>}
                <span className="font-mono"><span className="text-shipped">+{p.additions}</span> <span className="text-blocked">−{p.deletions}</span></span>
                <span>{ago(p.merged_at || p.closed_at || p.updated_at)}</span>
              </span>
            </button>); })}
        </div>) : <Empty title="No pull requests match these filters." />}
    </div>
  );
}

export function PrPanel() {
  const sh = S.sheet!;
  const [, force] = useState(0);
  useEffect(() => { loadPrRows(!!P.rows); }, []);
  const p = (P.rows || []).find((x) => x.number === sh.number);
  const d = drafts[sh.number!] ||= { method: 'squash', override: '', close: '', reviewer: '', tag: '', reason: '' };
  const field = (k: string) => ({ value: d[k], onChange: (e: { target: { value: string } }) => { d[k] = e.target.value; force((n) => n + 1); } });
  const who = (id?: string) => { const a = S.agents.find((x: { id: string }) => x.id === id); return a ? `${a.name}, ${a.role}` : id || 'unknown'; };
  if (!p) return <Panel title={`Pull request #${sh.number}`} onClose={closeSheet}><p className="text-muted-foreground">{P.loading ? 'Loading…' : P.error || 'This pull request is not among the desk\'s pull requests.'}</p></Panel>;
  const s = stateOf(p);
  const href = safeGithubUrl(p.url);
  const dr = p.desk_review || {};
  const needsOverride = dr.required && !(dr.approvals_ok && !dr.unpublished);
  const verdict: Record<string, string> = { approve: 'approved', changes: 'changes requested', pending: 'reviewing' };
  const ms = p.merge_state;
  const mergeLabel = !ms ? null : ms.state === 'scheduled' ? `scheduled; merges automatically at ${ms.label}` : ms.state === 'conflict' ? `conflict in ${ms.files.join(', ') || 'unknown files'}; ${ms.resolver?.name || 'the builder'} is resolving`
    : ms.state === 'held' ? `on hold: ${ms.reason}` : ms.state === 'queued' ? `queued to merge (#${ms.position} in line)${ms.deploy_lock ? `, waiting for the deploy of ${ms.deploy_lock.key}` : ''}` : ms.state === 'owner' ? `waiting for you: ${ms.reason}` : ms.state;
  const deskReviews = dr.required ? [dr.context, dr.independent].filter(Boolean).map((r: Pr) => `${r.name} (${r.role}): ${verdict[r.verdict] || r.verdict}`).join('; ') || 'not started' : null;
  const blockers = [p.mergeable === 'CONFLICTING' && 'conflicts with base', p.checks === 'failing' && 'CI failing', p.checks === 'pending' && 'CI running'].filter(Boolean);
  const post = (path: string, body: unknown) => async () => { await api('POST', `/api/prs/${p.number}/${path}`, body || {}); await loadPrRows(true); };
  const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => <><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd></>;
  return (
    <Panel wide title={`#${p.number} ${p.title}`} head={<div className="flex items-center gap-2"><Tag tone={STATE_TONE[s]}>{STATE_LABEL[s]}</Tag>{p.key && <span className="font-mono text-[13px] text-muted-foreground">{p.key}</span>}</div>} onClose={closeSheet}>
      {sh.banner && <div className="grid gap-1 rounded-md bg-needs/15 px-3 py-2"><b>{sh.banner.error ? `Approved on the desk, but GitHub said: ${sh.banner.error}` : 'Approved'}</b>
        {sh.banner.mode === 'label' && <p>GitHub does not allow approving your own PR, so it is recorded as a comment and the owner-approved label.</p>}{sh.banner.mode === 'review' && <p>Recorded as a GitHub review approval.</p>}
        <p>What next: merge it, close it, or ask someone else to review?</p></div>}
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 rounded-lg border bg-card p-4 text-sm">
        <Fact k="CI">{p.checks}</Fact><Fact k="Mergeable">{p.mergeable || 'unknown'}</Fact><Fact k="Size"><span className="font-mono">+{p.additions} −{p.deletions}</span> in {p.files} files</Fact>
        <Fact k="Built by">{p.seat ? <span className="inline-flex items-center gap-1.5"><SeatAvatar id={p.seat} />{who(p.seat)}</span> : 'unknown'}</Fact><Fact k="Requested by">{who(p.requester)}</Fact>
        {p.key && ticketByKey(p.key)?.parent_key && <Fact k="Part of"><Lineage t={ticketByKey(p.key)} /></Fact>}
        <Fact k="Ticket">{p.key ? <button type="button" className="text-primary hover:underline" onClick={() => openTicket(p.key)}>{tname(p.key)}</button> : 'none'}</Fact>
        {deskReviews && <Fact k="Desk review">{deskReviews}</Fact>}{mergeLabel && <Fact k="Auto-merge">{mergeLabel}</Fact>}
        <Fact k="GitHub reviews">{[...p.reviews.map((r: Pr) => `${r.who}: ${r.state.toLowerCase()}`), ...p.reviewers.map((r: string) => `${r}: requested`)].join(', ') || 'none'}</Fact>
      </dl>
      {href && <Button variant="secondary" asChild className="justify-self-start"><a href={href} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-4" />Open on GitHub</a></Button>}
      <section className="grid gap-2"><h3 className="font-semibold">Tags</h3>
        <div className="flex flex-wrap items-center gap-1.5">{p.tags.map((t: string) => <span key={t} className="inline-flex items-center gap-1 rounded-full bg-secondary py-0.5 pl-3 pr-1 text-sm">#{t}
          <AsyncButton variant="ghost" size="icon" className="size-7 rounded-full" aria-label={`Remove ${t}`} run={post('tags', { remove: [t] })} ok="Tag removed">×</AsyncButton></span>)}
          <Input aria-label="Add tag" placeholder="Add tag" className="w-40" {...field('tag')} />
          <AsyncButton variant="secondary" size="sm" run={async () => { if (!d.tag.trim()) return false; await post('tags', { add: d.tag.split(',') })(); d.tag = ''; }} ok="Tagged">Add</AsyncButton></div>
      </section>
      {p.state === 'OPEN' ? <>
        <section className="grid gap-2"><h3 className="font-semibold">Decide</h3>
          <div className="flex flex-wrap gap-2">
            {!p.owner_approved && <AsyncButton run={post('approve', {})} ok="Approved on GitHub">Approve</AsyncButton>}
            {p.draft && <AsyncButton variant="secondary" run={post('ready', {})} ok="Marked ready">Mark ready for review</AsyncButton>}
            {p.key && ms && ['queued', 'scheduled', 'held'].includes(ms.state) && <AsyncButton variant="secondary" run={async () => { await api('POST', `/api/tickets/${p.key}/merge-hold`, { hold: ms.state !== 'held' }); await loadPrRows(true); }} ok={ms.state === 'held' ? 'Released' : 'Held'}>{ms.state === 'held' ? 'Release' : 'Hold'}</AsyncButton>}
          </div></section>
        <section className="grid gap-3 rounded-lg border border-blocked/40 p-4"><h3 className="font-semibold">Merge</h3>
          <p className="text-sm text-needs">Merging into {P.meta.base || 'main'} deploys production.{blockers.length ? ` Blocked: ${blockers.join(', ')}.` : ''}</p>
          {needsOverride && <p className="text-sm text-needs">Not approved by both desk reviewers at this commit. The merge is refused unless you give a reason, which is posted on the PR.</p>}
          <div className="flex flex-wrap gap-2">
            <select aria-label="Merge method" className="h-9 rounded-md border border-input bg-background px-2" {...field('method')}>{['squash', 'merge', 'rebase'].map((m) => <option key={m} value={m}>{m}</option>)}</select>
            {P.meta.busy_window && <Input aria-label="Market-hours override" placeholder={`Type: ${P.meta.override_phrase}`} className="min-w-56 flex-1" {...field('override')} />}
            {needsOverride && <Input aria-label="Review override reason" placeholder="Why merge without both reviewer approvals? (audited on the PR)" className="min-w-64 flex-1" {...field('reason')} />}
            <AsyncButton variant="destructive" disabled={blockers.length > 0} confirm={`Merge #${p.number} into ${P.meta.base || 'main'} (${d.method})? This deploys production.`}
              run={async () => { await api('POST', `/api/prs/${p.number}/merge`, { method: d.method, override: d.override || '', expected_sha: p.head_sha, override_reason: d.reason || '' }); d.override = ''; await loadPrRows(true); }} ok="Merged">Merge</AsyncButton>
          </div></section>
        <section className="grid gap-2"><h3 className="font-semibold">More</h3>
          <div className="flex flex-wrap gap-2"><Input aria-label="Reviewer" placeholder="GitHub login or org/team" className="min-w-56 flex-1" {...field('reviewer')} />
            <AsyncButton variant="secondary" run={async () => { if (!d.reviewer.trim()) return false; await post('reviewer', { login: d.reviewer.trim() })(); d.reviewer = ''; }} ok="Review requested">Add reviewer</AsyncButton></div>
          <div className="flex flex-wrap gap-2"><Input aria-label="Close comment" placeholder="Why close? (posted on the PR)" className="min-w-56 flex-1" {...field('close')} />
            <AsyncButton variant="ghost" className="text-destructive" confirm={`Close #${p.number} without merging?`} run={async () => { await post('close', { comment: d.close })(); d.close = ''; }} ok="Closed">Close PR</AsyncButton></div>
        </section>
      </> : <p className="text-muted-foreground">{s === 'merged' ? `Merged ${p.merged_at ? new Date(p.merged_at).toLocaleString() : ''}` : 'Closed without merging.'}</p>}
    </Panel>
  );
}
