import { S, currentBoard, agentMap, openTicket, questionFor, loadPrs } from '@/store.js';
import { ago, clean, waited } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Tag, Key, SeatAvatar, Empty, Section } from '@/components/desk/Bits';
import { KIND_LABEL, CiTag, Reviews, prReviewsOf, NowLine, cardFor, Clamp, DecisionButton, firstName, reasonText, WorkerLine } from '@/components/desk/Work';
import { cn } from '@/lib/utils';
import type { Board, BoardItem } from '@/types';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const fresh = (it: BoardItem) => S.painted && !S.seen.has(it.id) && !reduced();

function DecisionCard({ it }: { it: BoardItem }) {
  const t = it.ticket;
  const reason = it.kind === 'question' && t ? questionFor(t) || it.reason : it.reason;
  const open = () => t && openTicket(t.key, { decision: it.id });
  return (
    <article data-key={it.id} data-kind={it.kind} data-ticket={t?.key} className={cn('grid gap-3 rounded-lg border border-l-[3px] border-l-needs bg-card p-4', fresh(it) && 'animate-in fade-in slide-in-from-top-2 duration-300')}>
      <div className="flex flex-wrap items-center gap-2"><Tag tone="needs">{KIND_LABEL[it.kind || ''] || 'Needs you'}</Tag>
        {it.proposal_id && <Tag>Proposal #{it.proposal_id}</Tag>}{it.council_id && <Tag>Council #{it.council_id}</Tag>}{t && <Key k={t.key} />}
        <span className="flex-1" /><span className="text-[13px] text-muted-foreground">{waited(t?.updated_at || it.incident?.last_seen)}</span></div>
      <h3 className="text-[17px] font-semibold leading-snug">{t ? <button type="button" className="text-left hover:underline" onClick={open}>{it.verb}</button> : it.verb}</h3>
      <div className="max-w-[68ch]"><Clamp id={`reason-${it.id}`} text={clean(reason)} /></div>
      <div className="flex flex-wrap items-center gap-2">
        {t?.assignee && <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><SeatAvatar id={t.assignee} />{agentMap()[t.assignee]?.name || ''}</span>}
        <span className="flex-1" />
        {t && <Button variant="ghost" aria-label={`Details for ${it.verb}`} onClick={open}>Details</Button>}
        <DecisionButton it={it} className="max-md:flex-1" />
      </div>
    </article>
  );
}

function MergeList({ items }: { items: BoardItem[] }) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border border-l-[3px] border-l-needs bg-card">
      {items.map((it) => { const t = it.ticket!; return (
        <article key={it.id} data-key={it.id} className="flex items-center gap-3 px-4 py-3">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <button type="button" className="text-left font-semibold hover:underline [overflow-wrap:anywhere]" onClick={() => openTicket(t.key, { decision: it.id })}>{it.name}</button>
            <div className="flex flex-wrap items-center gap-2 text-sm">{t.assignee && <span className="inline-flex items-center gap-1.5 text-muted-foreground"><SeatAvatar id={t.assignee} />{firstName(t.assignee)}</span>}
              <CiTag t={t} /><Reviews raw={prReviewsOf(t)} compact /><span className="text-muted-foreground">{ago(t.updated_at)}</span></div>
          </div>
          <DecisionButton it={it} label="Review" />
        </article>); })}
    </div>
  );
}

export function WorkingRow({ it }: { it: BoardItem }) {
  const t = it.ticket!;
  const card = cardFor(t);
  return (
    <button type="button" data-key={it.id} onClick={() => openTicket(t.key)} className="grid w-full gap-1.5 rounded-lg border bg-card p-3 text-left hover:bg-secondary">
      <div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate">{it.name}</b>{it.stage && <Tag>{it.stage}</Tag>}</div>
      <WorkerLine it={it} card={card} />
      <NowLine card={card} compact />
    </button>
  );
}

export function InboxPage() {
  const B = currentBoard() as Board;
  const c = B.counts;
  if (B.needs_you.some((x) => x.kind === 'merge')) loadPrs();
  const groups: { merge: boolean; items: BoardItem[] }[] = [];
  for (const it of B.needs_you) {
    if (it.kind === 'merge') { const last = groups.at(-1); if (last?.merge) last.items.push(it); else groups.push({ merge: true, items: [it] }); }
    else groups.push({ merge: false, items: [it] });
  }
  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
      <Section id="needs" title="Needs you" count={c.needs_you} tone="needs">
        {c.needs_you ? <div className="grid gap-3">{groups.map((g) => (g.merge ? <MergeList key={`m-${g.items[0].id}`} items={g.items} /> : <DecisionCard key={g.items[0].id} it={g.items[0]} />))}</div>
          : <Empty title="Nothing needs you.">{c.working} working, {c.queued} queued.</Empty>}
      </Section>
      <div className="grid gap-8 xl:sticky xl:top-32">
        <Section id="working" title="Working now" count={c.working}>
          {c.working ? <div className="grid gap-2">{B.working.map((it) => <WorkingRow key={it.id} it={it} />)}</div>
            : <p className="text-muted-foreground">{S.settings.paused === 'true' ? 'The desk is halted. Resume it from Desk.' : 'No seat is running right now.'}</p>}
        </Section>
        <Section id="blocked" title="Blocked" count={c.blocked} tone="blocked">
          {c.blocked ? <div className="grid gap-2">{B.blocked.map((it) => (
            <button key={it.id} type="button" data-key={it.id} onClick={() => openTicket(it.ticket!.key)} className="grid gap-1 rounded-lg border border-l-[3px] border-l-blocked bg-card p-3 text-left hover:bg-secondary">
              <b>{it.verb}</b><span className="text-sm text-muted-foreground">{reasonText(it.reason)}</span></button>))}</div>
            : <p className="text-muted-foreground">Nothing is blocked.</p>}
        </Section>
      </div>
    </div>
  );
}
