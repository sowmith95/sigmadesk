import { useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { S, currentBoard, openTicket, questionFor, setView } from '@/store.js';
import { ago } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChoiceChips } from '@/components/desk/Choices';
import { Tag, Key, SeatAvatar, Section } from '@/components/desk/Bits';
import { KIND_LABEL, NowLine, cardFor, firstName, reasonText, Disclose } from '@/components/desk/Work';
import { WritingMark } from '@/components/desk/Presence';
import { Lineage, EpicTree, EpicProgress, childrenOf, isFeatureRoot, openEpic, leafStats } from '@/components/desk/Epic';
import { cn } from '@/lib/utils';
import type { Board, BoardItem, Ticket } from '@/types';

const saved = { q: '', who: '', closed: false, shippedAll: false, group: (localStorage.getItem('sd2.workGroup') === 'epic' ? 'epic' : 'stage') as 'stage' | 'epic' };

function WorkRow({ it }: { it: BoardItem }) {
  const t = it.ticket;
  if (!t) return <div className="rounded-lg border bg-card p-3"><Tag tone="needs">{KIND_LABEL[it.kind || ''] || 'Needs you'}</Tag><p className="mt-1 font-semibold">{it.verb}</p></div>;
  const card = it.bucket === 'working' ? cardFor(t) : null;
  const kids = it.epic ? S.tickets.filter((k) => k.parent_key === t.key) : [];
  const line = it.bucket === 'needs_you' ? (it.kind === 'question' ? questionFor(t) || it.reason : null) : it.bucket === 'working' && !it.epic ? null : reasonText(it.reason);
  const edge = { needs_you: 'border-l-needs', blocked: 'border-l-blocked', shipped: 'border-l-shipped' }[it.bucket] || 'border-l-border';
  return (
    <article data-key={it.id} className={cn('rounded-lg border border-l-[3px] bg-card', edge)}>
      <Lineage t={t} className="px-3 pt-2.5" />
      <button type="button" className="grid w-full gap-1.5 p-3 text-left hover:bg-secondary/60" onClick={() => openTicket(t.key, it.bucket === 'needs_you' ? { decision: it.id } : {})}>
        <div className="flex flex-wrap items-center gap-1.5">
          {it.bucket === 'needs_you' && <Tag tone="needs">{KIND_LABEL[it.kind || ''] || 'Needs you'}</Tag>}{it.bucket === 'blocked' && <Tag tone="blocked">Blocked</Tag>}
          {it.bucket === 'epic' ? <Tag>{it.live ? 'Epic, a slice is running' : 'Epic'}</Tag> : it.stage && it.bucket !== 'shipped' ? <Tag>{it.stage}</Tag> : null}
          <span className="flex-1" /><Key k={t.key} />
        </div>
        <b className="[overflow-wrap:anywhere]">{it.name}</b>
        {line && <p className="text-sm text-muted-foreground">{line.length > 170 ? `${line.slice(0, 169).replace(/\s+\S*$/, '')}…` : line}</p>}
        {card && <NowLine card={card} compact />}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">{t.assignee && <><SeatAvatar id={it.worker || t.assignee} />{firstName(it.worker || t.assignee)}</>}<WritingMark tkey={t.key} /><span className="flex-1" />{it.bucket === 'shipped' && ago(t.updated_at)}</div>
      </button>
      {kids.length > 0 && <div className="grid gap-2 px-3 pb-3"><EpicProgress epic={t.key} /><Disclose id={`epic-${t.key}`} summary={`${kids.length} task${kids.length === 1 ? '' : 's'}`}><EpicTree root={t.key} /></Disclose></div>}
    </article>
  );
}

/** Work grouped by epic: one card per top-level epic with its whole task tree, then everything not in an epic. */
function EpicBoard({ B, matches, closed }: { B: Board; matches: (it: BoardItem) => boolean; closed: boolean }) {
  const descendants = (key: string): Ticket[] => childrenOf(key).flatMap((k) => [k, ...descendants(k.key)]);
  const hit = (t: Ticket) => matches({ ...(B.byKey[t.key] || { id: t.key, key: t.key, name: nameOf(t), bucket: 'queued' }), ticket: t } as BoardItem);
  const roots = (S.tickets as Ticket[]).filter((t) => !t.parent_key && childrenOf(t.key).length && (closed || !['done', 'wontdo'].includes(t.status)))
    .filter((t) => hit(t) || descendants(t.key).some(hit))
    .map((t) => ({ t, s: leafStats(t.key) }))
    .sort((a, b) => b.s.needs - a.s.needs || b.s.working - a.s.working || String(b.t.updated_at).localeCompare(String(a.t.updated_at)));
  const loose = [...(B.decisions || B.needs_you).filter((it, i, all) => all.findIndex((x) => x.key === it.key) === i), ...B.working, ...B.blocked, ...B.queued]
    .filter((it) => it.ticket && !it.ticket.parent_key && !childrenOf(it.ticket.key).length && matches(it));
  return (
    <div className="grid gap-6">
      {roots.length ? <div className="grid items-start gap-4 xl:grid-cols-2">
        {roots.map(({ t, s }) => (
          <article key={t.key} data-epic={t.key} className={cn('grid gap-3 rounded-lg border bg-card p-4', s.needs > 0 && 'border-l-[3px] border-l-needs')}>
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={isFeatureRoot(t) ? 'action' : 'neutral'}>{isFeatureRoot(t) ? 'Feature' : 'Epic'}</Tag>
              {['done', 'wontdo'].includes(t.status) && <Tag tone={t.status === 'done' ? 'shipped' : 'neutral'}>{t.status === 'done' ? 'Shipped' : 'Closed'}</Tag>}
              {s.needs > 0 && <Tag tone="needs">{s.needs} need{s.needs === 1 ? 's' : ''} you</Tag>}
              <span className="flex-1" /><Key k={t.key} />
            </div>
            <h3 className="text-[17px] font-semibold leading-snug"><button type="button" className="text-left hover:underline" onClick={() => openEpic(t)}>{t.title}</button></h3>
            <EpicProgress epic={t.key} />
            <EpicTree root={t.key} />
          </article>))}
      </div> : <p className="text-muted-foreground">No epics match.</p>}
      {loose.length > 0 && <Section id="loose" title="Not in an epic" count={loose.length}>
        <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">{loose.map((it) => <WorkRow key={it.id} it={it} />)}</div></Section>}
    </div>
  );
}

export function WorkPage() {
  const B = currentBoard() as Board;
  const [f, setF] = useState(saved);
  const set = (p: Partial<typeof saved>) => { Object.assign(saved, p); setF({ ...saved }); };
  const filtering = Boolean(f.q.trim() || f.who);
  const matches = (it: BoardItem) => {
    const t = it.ticket;
    if (!t) return !filtering;
    if (f.who && t.assignee !== f.who) return false;
    const q = f.q.trim().toLowerCase();
    return !q || `${t.key} ${it.name} ${t.title}`.toLowerCase().includes(q);
  };
  // Sub-epics (a principal's slices of a split task) live inside their top-level epic's tree, not as separate cards.
  const openParent = (t?: Ticket) => { const p = t?.parent_key && S.tickets.find((x: Ticket) => x.key === t.parent_key); return !!p && !['done', 'wontdo'].includes(p.status); };
  const topEpics = B.epics.filter((it) => !openParent(it.ticket));
  const engineers = S.agents.filter((a: { id: string }) => (S.meta.engineers || []).includes(a.id));
  const lanes: [string, string, BoardItem[], number, 'needs' | 'shipped' | undefined][] = [
    // Everything waiting on you, snoozed or folded included: Work is where you find any ticket.
    ['wait', 'Waiting on you', B.decisions || B.needs_you, (B.decisions || B.needs_you).length, 'needs'], ['working', 'Working', B.working, B.counts.working, undefined],
    ['queued', 'Queued', [...B.blocked, ...B.queued], B.counts.blocked + B.counts.queued, undefined], ['shipped', 'Shipped', B.shipped, B.counts.shipped, 'shipped'],
  ];
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <Input type="search" aria-label="Search tickets" placeholder="Search by name or key" value={f.q} onChange={(e) => set({ q: e.target.value })} className="max-w-xs" />
        <ChoiceChips label="Who" hideLabel size="sm" value={f.who || 'anyone'} onChange={(v) => set({ who: v === 'anyone' ? '' : v })}
          options={[{ value: 'anyone', label: 'Anyone' }, ...engineers.map((a: { id: string; name: string }) => ({ value: a.id, label: a.name, lead: <SeatAvatar id={a.id} /> }))]} />
        <ChoiceChips label="Group by" hideLabel size="sm" value={f.group} onChange={(v) => { localStorage.setItem('sd2.workGroup', v); set({ group: v }); }}
          options={[{ value: 'stage', label: 'By stage' }, { value: 'epic', label: 'By epic' }]} />
        <span className="flex-1" />
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" className="size-4 accent-[var(--primary)]" checked={f.closed} onChange={(e) => set({ closed: e.target.checked })} />Show closed ({B.counts.closed})</label>
        <Button variant="outline" onClick={() => setView('prs')}><GitPullRequest className="size-4" />Pull requests</Button>
      </div>
      {f.group === 'epic' ? <EpicBoard B={B} matches={matches} closed={f.closed} /> : <>
      <div className="grid items-start gap-6 md:grid-cols-2 2xl:grid-cols-4">
        {lanes.map(([id, title, items, count, tone]) => {
          let list = items.filter(matches);
          const more = id === 'shipped' && !f.shippedAll && !filtering && list.length > 5 ? list.length - 5 : 0;
          if (more) list = list.slice(0, 5);
          return (
            <Section key={id} id={`lane-${id}`} title={title} count={filtering ? `${list.length} of ${count}` : count} tone={tone}>
              <div className="grid gap-2">
                {list.length ? list.map((it) => <WorkRow key={it.id} it={it} />)
                  : <p className="text-muted-foreground">{filtering ? 'No matches.' : ({ wait: 'Nothing waiting on you.', working: 'No seat is running.', queued: 'Queue is empty.' } as Record<string, string>)[id] || 'Nothing shipped yet.'}</p>}
                {more > 0 && <Button variant="ghost" onClick={() => set({ shippedAll: true })}>View all {count}</Button>}
                {id === 'shipped' && f.shippedAll && !filtering && count > 5 && <Button variant="ghost" onClick={() => set({ shippedAll: false })}>Show latest 5</Button>}
                {id === 'shipped' && f.closed && <><h3 className="mt-2 text-sm text-muted-foreground">Closed ({B.counts.closed})</h3>{B.closed.filter(matches).map((it) => <WorkRow key={it.id} it={it} />)}</>}
              </div>
            </Section>
          );
        })}
      </div>
      {topEpics.length > 0 && <Section id="epics" title="Epics" count={topEpics.length} actions={<Button variant="ghost" size="sm" onClick={() => { localStorage.setItem('sd2.workGroup', 'epic'); set({ group: 'epic' }); }}>See work by epic</Button>}>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{topEpics.filter(matches).map((it) => <WorkRow key={it.id} it={it} />)}</div></Section>}
      </>}
    </div>
  );
}
