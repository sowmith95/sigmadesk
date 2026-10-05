// Where a request stands, at the top of its ticket, in as little height as possible: one line (step · what is
// happening · who has it), a thin progress bar with the step count (tap it for every step), and, when something needs
// you, the choices inline (they replace the separate decision row). Computed by public/stages.js from what the desk
// already knows; the decision itself stays in the Decision tab, the plan on the feature page.
import { useState } from 'react';
import { Check, ChevronDown, Circle, CircleDot } from 'lucide-react';
import { stageOf } from '../../../../public/stages.js';
import { S, agentMap, planFor, openFeature } from '@/store.js';
import * as flow from '../../../../public/flow.js';
import { SeatAvatar } from './Bits';
import { cn } from '@/lib/utils';
import type { Board, BoardItem, Ticket } from '@/types';

type Step = { id: string; label: string; state: 'done' | 'current' | 'todo' };
type Stage = { steps: Step[]; at: string | null; closed: boolean; done: boolean; who: string | null; why: string | null; line: string; epic: boolean;
  actions: { id: string; key: string; kind: string; text: string }[] };

export function stageFor(t: Ticket, B: Board, mergeState?: { state?: string } | null): Stage {
  const ix = flow.index(S.tickets);
  const tree = new Set([t.key, ...flow.descendants(t.key, ix).map((k: Ticket) => k.key)]);
  const names = Object.fromEntries(S.agents.map((a) => [a.id, a.name.split(/\s+/)[0]]));
  // Merge states for every ticket ready to merge come with the snapshot; this ticket's fresher detail wins.
  const merges = { ...(S.meta.merge_states || {}), ...(mergeState?.state ? { [t.key]: mergeState.state } : {}) };
  return stageOf(t, { kids: ix.kids.get(t.key) || [], plan: planFor(t.key), deploy: S.meta.deploy_lock || null, names, merges,
    decisions: (B.decisions || B.needs_you).filter((d) => tree.has(d.key)) }) as Stage;
}

export function Tracker({ t, B, mergeState, choices = [], selected, labelOf, onChoose, onDecision }: {
  t: Ticket; B: Board; mergeState?: { state?: string } | null;
  choices?: BoardItem[]; selected?: string | null; labelOf: (x: BoardItem) => string; onChoose: (id: string) => void; onDecision: (id: string, key: string) => void }) {
  const [open, setOpen] = useState(false);
  const st = stageFor(t, B, mergeState);
  const i = st.at ? st.steps.findIndex((s) => s.id === st.at) : -1;
  const current = st.closed ? 'Closed' : st.done ? 'Done' : st.steps[i]?.label || 'In progress';
  const who = st.who === 'you' ? 'You' : st.who ? agentMap()[st.who]?.name?.split(/\s+/)[0] : null;
  // This ticket's decisions are chosen here (they open in the Decision tab); a task's decision opens that task.
  const mine = new Set(choices.map((c) => c.id));
  const others = st.actions.filter((a) => a.key !== t.key && !mine.has(a.id));
  const needs = choices.length + others.length;
  return (
    <section aria-label="Where this request stands" data-tracker={t.key} className={cn('grid gap-2 rounded-lg border bg-card px-3 py-2.5', needs && 'border-l-[3px] border-l-needs')}>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-snug">
          <b className="text-[15px]">{current}</b>{st.line && st.line !== current && <span className="text-muted-foreground"> · {st.line}</span>}
        </p>
        {who && !st.done && !st.closed && <span className="flex shrink-0 items-center gap-1.5 text-sm">{st.who !== 'you' && <SeatAvatar id={st.who} size="sm" />}<b>{who}</b></span>}
        {st.at && !st.closed && <button type="button" aria-expanded={open} aria-controls={`steps-${t.key}`} onClick={() => setOpen(!open)}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground">
          <span className="tabular">{i + 1}/{st.steps.length}</span><span className="sr-only"> steps; show all</span><ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden /></button>}
      </div>
      {st.at && !st.closed && <div className="flex gap-1" aria-hidden>{st.steps.map((s) => <span key={s.id} className={cn('h-1 flex-1 rounded-full', s.state === 'done' ? 'bg-shipped' : s.state === 'current' ? 'bg-primary' : 'bg-secondary')} />)}</div>}
      {st.why && !st.done && !st.closed && open && <p className="text-[13px] text-muted-foreground">{st.why}</p>}
      {open && <ol id={`steps-${t.key}`} className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">{st.steps.map((s) => <li key={s.id} className={cn('flex items-center gap-1.5', s.state === 'todo' && 'text-muted-foreground')}>
        {s.state === 'done' ? <Check className="size-3.5 text-shipped" aria-hidden /> : s.state === 'current' ? <CircleDot className="size-3.5 text-primary" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
        <span className={s.state === 'current' ? 'font-medium text-foreground' : undefined}>{s.label}</span><span className="sr-only">{s.state}</span></li>)}</ol>}
      {needs > 0 && <div role="group" aria-label="Needs you" className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[13px] text-needs">Needs you</span>
        {choices.map((c) => <button key={c.id} type="button" aria-pressed={selected === c.id} onClick={() => onChoose(c.id)}
          className={cn('h-8 rounded-full border px-3 text-sm', selected === c.id ? 'border-primary bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent')}>{labelOf(c)}</button>)}
        {others.map((a) => <button key={a.id} type="button" onClick={() => (a.kind === 'plan' ? openFeature(a.key) : onDecision(a.id, a.key))}
          className="h-8 rounded-full border bg-secondary px-3 text-sm hover:bg-accent">{a.kind === 'plan' ? 'Review the plan' : a.text}</button>)}
      </div>}
    </section>
  );
}
