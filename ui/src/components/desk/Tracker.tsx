// Where a request stands, at the top of its ticket: the current step in words, who has it and why, and what (if
// anything) needs you, with every step behind a disclosure. Computed by public/stages.js from what the desk already
// knows; the decision itself stays in the Decision tab, the plan on the feature page.
import { Check, Circle, CircleDot } from 'lucide-react';
import { stageOf } from '../../../../public/stages.js';
import { S, agentMap, planFor, openFeature } from '@/store.js';
import * as flow from '../../../../public/flow.js';
import { Button } from '@/components/ui/button';
import { SeatAvatar } from './Bits';
import { cn } from '@/lib/utils';
import type { Board, Ticket } from '@/types';

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

export function Tracker({ t, B, mergeState, onDecision }: { t: Ticket; B: Board; mergeState?: { state?: string } | null; onDecision: (id: string, key: string) => void }) {
  const st = stageFor(t, B, mergeState);
  const current = st.steps.find((s) => s.state === 'current') || (st.done ? st.steps.at(-1) : null);
  const who = st.who === 'you' ? 'You' : st.who ? agentMap()[st.who]?.name : null;
  const action = st.actions[0];
  return (
    <section aria-label="Where this request stands" data-tracker={t.key} className={cn('grid gap-2 rounded-lg border bg-card p-3', action && 'border-l-[3px] border-l-needs')}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <b className="text-[15px]">{st.closed ? 'Closed' : current?.label || 'In progress'}</b>
        {st.at && !st.closed && <span className="text-[13px] text-muted-foreground">step {st.steps.findIndex((s) => s.id === st.at) + 1} of {st.steps.length}</span>}
      </div>
      <p className="text-sm">{st.line}</p>
      {who && !st.done && !st.closed && <p className="flex items-center gap-2 text-[13px] text-muted-foreground">{st.who && st.who !== 'you' && <SeatAvatar id={st.who} />}<span><b className="text-foreground">{who}</b>{st.why ? `: ${st.why.replace(/^[^:]+:\s*/, '')}` : ''}</span></p>}
      {action && <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-needs">{st.actions.length > 1 ? `${st.actions.length} things need you` : 'Needs you'}</span>
        {action.kind === 'plan' ? <Button size="sm" onClick={() => openFeature(action.key)}>Review the plan</Button>
          : <Button size="sm" onClick={() => onDecision(action.id, action.key)}>{action.text}</Button>}
      </div>}
      {!st.closed && st.at && <details className="text-[13px]"><summary className="cursor-pointer text-muted-foreground">All steps</summary>
        <ol className="mt-2 grid gap-1">{st.steps.map((s) => <li key={s.id} className={cn('flex items-center gap-2', s.state === 'todo' && 'text-muted-foreground')}>
          {s.state === 'done' ? <Check className="size-4 text-shipped" aria-hidden /> : s.state === 'current' ? <CircleDot className="size-4 text-primary" aria-hidden /> : <Circle className="size-4" aria-hidden />}
          <span className={s.state === 'current' ? 'font-medium' : undefined}>{s.label}</span><span className="sr-only">{s.state}</span></li>)}</ol></details>}
    </section>
  );
}
