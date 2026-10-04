// Epics and their tasks, shown the same way everywhere: a task names the epic it belongs to (Lineage), an epic shows
// its tasks as a tree (EpicTree) with one progress figure counted over the real work (leaf tasks).
import { Fragment } from 'react';
import { ChevronRight, Layers } from 'lucide-react';
import { nameOf } from '../../../../public/names.js';
import { S, openTicket, openFeature } from '@/store.js';
import { Tag, SeatAvatar, type Tone } from './Bits';
import { STAGE_LABEL } from './Work';
import { OwnerTag } from './Flow';
import { cn } from '@/lib/utils';
import type { Ticket } from '@/types';

const byKey = (k?: string | null) => (k ? (S.tickets.find((x: Ticket) => x.key === k) as Ticket | undefined) : undefined);
const num = (k: string) => Number(k.split('-').pop()) || 0;
export const childrenOf = (key: string) => (S.tickets.filter((x: Ticket) => x.parent_key === key) as Ticket[]).sort((a, b) => num(a.key) - num(b.key));
export const isFeatureRoot = (t?: Ticket | null) => !!t && t.type === 'feature' && !t.parent_key;

/** Root → … → parent of a ticket (not the ticket itself). Cycle-safe. */
export function lineageOf(t?: Ticket | null): Ticket[] {
  const chain: Ticket[] = [];
  const seen = new Set<string>(t ? [t.key] : []);
  for (let p = byKey(t?.parent_key); p && !seen.has(p.key) && chain.length < 8; p = byKey(p.parent_key)) { seen.add(p.key); chain.unshift(p); }
  return chain;
}
/** Open an epic where it reads best: a feature on its page, any other epic on its Tasks tab. */
export function openEpic(t: Ticket) {
  if (isFeatureRoot(t)) openFeature(t.key); else openTicket(t.key, { tab: 'tasks' });
}

/** "Part of: Feature › Sub-epic" crumbs. `link={false}` inside another button (no nested buttons). */
export function Lineage({ t, link = true, className }: { t?: Ticket | null; link?: boolean; className?: string }) {
  const chain = lineageOf(t);
  if (!chain.length) return null;
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[13px] text-muted-foreground', className)} aria-label={`Part of ${chain.map((p) => nameOf(p)).join(', then ')}`}>
      <Layers className="size-3.5 shrink-0" aria-hidden />
      {chain.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />}
          {link ? <button type="button" title={`${p.key}: ${p.title}`} onClick={(e) => { e.stopPropagation(); openEpic(p); }} className="max-w-[24ch] truncate rounded hover:text-foreground hover:underline">{nameOf(p)}</button>
            : <span title={`${p.key}: ${p.title}`} className="max-w-[24ch] truncate">{nameOf(p)}</span>}
        </Fragment>
      ))}
    </div>
  );
}

/** Counts over leaf tasks under an epic (sub-epics are containers, their slices are the work). */
export function leafStats(key: string) {
  const out = { total: 0, done: 0, dropped: 0, needs: 0, working: 0 };
  const seen = new Set<string>();
  const walk = (k: string) => {
    for (const c of childrenOf(k)) {
      if (seen.has(c.key)) continue; seen.add(c.key);
      if (childrenOf(c.key).length) { walk(c.key); continue; }
      out.total++;
      if (c.status === 'done') out.done++; else if (c.status === 'wontdo') out.dropped++;
      else if (['needs_human', 'ready_for_human'].includes(c.status)) out.needs++;
      if (S.agents.some((a) => a.current_ticket === c.key && a.status === 'working')) out.working++;
    }
  };
  walk(key);
  return out;
}

export function EpicProgress({ epic, className }: { epic: string; className?: string }) {
  const s = leafStats(epic);
  if (!s.total) return null;
  const pct = Math.round(((s.done + s.dropped) / s.total) * 100);
  const bits = [`${s.done} of ${s.total} task${s.total === 1 ? '' : 's'} shipped`, s.working && `${s.working} in progress`, s.needs && `${s.needs} need${s.needs === 1 ? 's' : ''} you`, s.dropped && `${s.dropped} not doing`].filter(Boolean);
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tasks settled">
        <div className="h-full rounded-full bg-shipped" style={{ width: `${pct}%` }} /></div>
      <span className="text-[13px] text-muted-foreground">{bits.join(', ')}</span>
    </div>
  );
}

const toneOf = (t: Ticket): Tone => (t.status === 'done' ? 'shipped' : ['needs_human', 'ready_for_human'].includes(t.status) ? 'needs' : t.status === 'wontdo' ? 'neutral' : 'neutral');

/** An epic's tasks as a tree: status, name, who, and what each task waits for. Indents up to `max` levels. */
export function EpicTree({ root, depth = 0, max = 3, hideDone = false }: { root: string; depth?: number; max?: number; hideDone?: boolean }) {
  const kids = childrenOf(root).filter((k) => !hideDone || !['done', 'wontdo'].includes(k.status));
  if (!kids.length) return depth === 0 ? <p className="text-sm text-muted-foreground">No tasks yet.</p> : null;
  return (
    <ul className={cn('grid gap-1', depth > 0 && 'ml-2 border-l pl-3')} data-epic-tree={root}>
      {kids.map((k) => {
        const sub = childrenOf(k.key);
        const dep = byKey(k.after_key);
        const waiting = dep && dep.status !== 'done' && !['done', 'wontdo'].includes(k.status);
        const parentWait = !waiting && !['done', 'wontdo'].includes(k.status) ? lineageOf(k).map((a) => byKey(a.after_key)).find((d) => d && d.status !== 'done') : undefined;
        const live = S.agents.find((a) => a.current_ticket === k.key && a.status === 'working');
        return (
          <li key={k.key} className="grid gap-1" data-task={k.key}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 hover:bg-secondary/60">
              {sub.length ? <Layers className="size-4 shrink-0 text-muted-foreground" aria-label="Epic" /> : <span className={cn('size-2 shrink-0 rounded-full', live ? 'animate-pulse bg-primary' : k.status === 'done' ? 'bg-shipped' : ['needs_human', 'ready_for_human'].includes(k.status) ? 'bg-needs' : 'bg-muted-foreground/50')} aria-hidden />}
              <button type="button" onClick={() => openTicket(k.key, sub.length ? { tab: 'tasks' } : {})} title={`${k.key}: ${k.title}`}
                className={cn('min-w-0 flex-1 basis-48 truncate text-left hover:underline', k.status === 'wontdo' && 'text-muted-foreground line-through')}>{nameOf(k)}</button>
              {(live?.id || k.assignee) && <SeatAvatar id={live?.id || k.assignee} />}
              <OwnerTag t={k} />
              <Tag tone={toneOf(k)}>{live ? 'Working' : STAGE_LABEL[k.status] || k.status}</Tag>
              <span className="font-mono text-xs text-muted-foreground">{k.key}</span>
              {waiting && <span className="basis-full pl-4 text-xs text-muted-foreground">waits for {nameOf(dep!)} ({dep!.key})</span>}
              {parentWait && depth === 0 && <span className="basis-full pl-4 text-xs text-muted-foreground">waits for {nameOf(parentWait)} ({parentWait.key}), with its epic</span>}
            </div>
            {sub.length > 0 && (depth + 1 < max ? <EpicTree root={k.key} depth={depth + 1} max={max} hideDone={hideDone} />
              : <button type="button" className="ml-6 justify-self-start text-xs text-primary hover:underline" onClick={() => openTicket(k.key, { tab: 'tasks' })}>{sub.length} more task{sub.length === 1 ? '' : 's'}</button>)}
          </li>
        );
      })}
    </ul>
  );
}
