// Work order inside an epic, for people: the one next step (and who acts), gates written only in text that the desk
// cannot enforce yet (one tap records them), the owner's own tasks, and the manager's epic review. The order itself is
// computed by public/flow.js, the same code the scheduler and the Inbox use.
import { useState } from 'react';
import { ArrowRight, Check, Loader2, Undo2, UserRound, Users } from 'lucide-react';
import * as flow from '../../../../public/flow.js';
import { nameOf } from '../../../../public/names.js';
import { S, api, openTicket, agentMap, draftKey, setDraft } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from './AsyncButton';
import { Tag, SeatAvatar } from './Bits';
import { Markdown } from './Markdown';
import { cn } from '@/lib/utils';
import type { Ticket } from '@/types';

const byKey = (k?: string | null) => (k ? (S.tickets.find((x: Ticket) => x.key === k) as Ticket | undefined) : undefined);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ASKS = new Set(['needs_human', 'ready_for_human']);

type Review = { key: string; round: number; status: string; error?: string | null; question_state?: string | null; close_state?: string | null;
  result?: { summary: string; next?: { key: string; why: string } | null; question?: { text: string; covers: string[] } | null; close: { key: string; why: string }[] };
  applied?: { applied: string[]; skipped: string[] } };
export const reviewFor = (key: string) => ((S.meta.epic_reviews || []) as Review[]).find((r) => r.key === key) || null;

function whatToDo(t: Ticket) {
  if (t.owner_task) return { who: 'You', line: 'Do this step yourself, then mark it done with what you did.', action: 'Open your task' };
  if (t.status === 'ready_for_human') return { who: 'You', line: 'It is waiting for your approval.', action: 'Review it' };
  if (t.status === 'needs_human') return { who: 'You', line: 'The team stopped here with a question for you.', action: 'Answer it' };
  const seat = t.assignee ? agentMap()[t.assignee]?.name?.split(/\s+/)[0] : null;
  const live = S.agents.some((a) => a.current_ticket === t.key && a.status === 'working');
  return { who: seat || 'The team', line: live ? 'Being worked on now.' : t.status === 'todo' ? 'Next in line for an engineer.' : 'In the pipeline.', action: 'Open it' };
}

/** The one task to unblock first in an epic, who must act, and how much waits on it. */
export function NextStep({ root, className }: { root: string; className?: string }) {
  const n = flow.nextStep(root, S.tickets);
  if (!n) return null;
  const t = n.task as Ticket;
  const d = whatToDo(t);
  const owner = n.who === 'owner';
  return (
    <section aria-label="Next step" data-next-step={t.key} className={cn('grid gap-2 rounded-lg border bg-card p-4', owner && 'border-l-[3px] border-l-needs', className)}>
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        {owner ? <UserRound className="size-4 text-needs" aria-hidden /> : <Users className="size-4" aria-hidden />}
        <span>Next step{n.waiting.length ? `: ${plural(n.waiting.length, 'task')} wait on it` : ''}</span>
      </div>
      <button type="button" onClick={() => openTicket(t.key)} className="text-left text-[17px] font-semibold leading-snug hover:underline">{nameOf(t)} <span className="font-mono text-xs font-normal text-muted-foreground">{t.key}</span></button>
      <p className="text-sm"><b className={owner ? 'text-needs' : undefined}>{d.who}:</b> {d.line}</p>
      {n.blockedEverywhere && <p className="text-sm text-muted-foreground">Every open task waits on something. This is the one that frees the most work.</p>}
      {n.waiting.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">What waits on it</summary>
        <ul className="mt-1.5 grid gap-1">{n.waiting.map((w: Ticket) => <li key={w.key}><button type="button" className="text-left hover:underline" onClick={() => openTicket(w.key)}>{nameOf(w)}</button> <span className="font-mono text-xs text-muted-foreground">{w.key}</span></li>)}</ul></details>}
      <Button size="sm" variant={owner ? 'default' : 'secondary'} className="justify-self-start" onClick={() => openTicket(t.key, owner && t.status !== 'todo' ? { focus: true } : {})}>{d.action}<ArrowRight className="size-4" aria-hidden /></Button>
    </section>
  );
}

/** Gates written in a task's text that nothing enforces yet. One tap records each as the task's dependency. */
export function GateSuggestions({ root }: { root: string }) {
  const list = flow.gateSuggestions(root, S.tickets) as { key: string; after: string; title: string }[];
  if (!list.length) return null;
  return (
    <section aria-label="Order written but not recorded" className="grid gap-2 rounded-lg border border-dashed p-4">
      <b className="text-sm">Order written but not recorded</b>
      <p className="text-[13px] text-muted-foreground">These tasks say in their text that they wait for another task, but the desk only enforces a recorded order. Record it so nobody starts them too early.</p>
      <ul className="grid gap-2">{list.map((g) => {
        const t = byKey(g.key), a = byKey(g.after);
        const replaces = t?.after_key && byKey(t.after_key)?.status !== 'done' ? byKey(t.after_key) : null;
        return (
          <li key={`${g.key}>${g.after}`} data-gate={`${g.key}>${g.after}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="min-w-0 flex-1 basis-60 text-sm"><button type="button" className="hover:underline" onClick={() => openTicket(g.key)}>{t ? nameOf(t) : g.key}</button> waits for <button type="button" className="hover:underline" onClick={() => openTicket(g.after)}>{a ? nameOf(a) : g.after}</button>
              {replaces && <span className="text-muted-foreground"> (it now waits for {nameOf(replaces)}; this replaces that)</span>}</span>
            <AsyncButton size="sm" variant="secondary" confirm={replaces ? `${g.key} can wait for only one task. Replace ${replaces.key} with ${g.after}?` : undefined}
              run={() => api('PATCH', `/api/tickets/${g.key}`, { after_key: g.after })} ok={`${g.key} now waits for ${g.after}`}>Make {g.key} wait for {g.after}</AsyncButton>
          </li>
        );
      })}</ul>
    </section>
  );
}

/** A task the owner does: mark it done with notes (the evidence the next tasks read) or hand it back to the team. */
export function OwnerTaskActions({ t }: { t: Ticket }) {
  const dk = draftKey(t.key, 'owner-done');
  const [notes, setNotes] = useState<string>(S.drafts[dk] || '');
  const closed = ['done', 'wontdo'].includes(t.status);
  if (closed) return null;
  if (!t.owner_task) {
    if (!['triage', 'proposed', 'todo', 'needs_human'].includes(t.status) || (t.active_run && t.active_run !== 0) || (S.tickets.some((x: Ticket) => x.parent_key === t.key))) return null;
    return <AsyncButton variant="ghost" size="sm" className="justify-self-start" confirm={`Take ${t.key} yourself? No engineer will pick it up; the tasks after it wait until you mark it done.`}
      run={() => api('POST', `/api/tickets/${t.key}/owner-task`, { owner_task: true })} ok="It is your task now">This is my task</AsyncButton>;
  }
  return (
    <section aria-label="Your task" data-owner-task={t.key} className="grid gap-2 rounded-lg border border-l-[3px] border-l-needs bg-card p-4">
      <b>Your task</b>
      <p className="text-sm text-muted-foreground">No seat on the team can do this step. Do it, then say what you did or found: the tasks after it read your notes.</p>
      <Textarea aria-label="What you did" rows={3} maxLength={8000} value={notes} placeholder="Ran the check on the production box: 0 rows affected, logs attached…" onChange={(e) => { setNotes(e.target.value); setDraft(dk, e.target.value); }} />
      <div className="flex flex-wrap gap-2">
        <AsyncButton run={async () => { if (notes.trim().length < 3) throw new Error('Say what you did first.'); await api('POST', `/api/tickets/${t.key}/owner-done`, { notes }); setDraft(dk, ''); setNotes(''); }} ok="Marked done; the next tasks can start"><Check className="size-4" aria-hidden />Mark done</AsyncButton>
        <AsyncButton variant="ghost" confirm={`Hand ${t.key} back to the team? An engineer picks it up.`} run={() => api('POST', `/api/tickets/${t.key}/owner-task`, { owner_task: false })} ok="Handed back to the team"><Undo2 className="size-4" aria-hidden />Hand back</AsyncButton>
      </div>
    </section>
  );
}

/** The manager's review of a stuck epic: start it, follow it, answer its one question, decide proposed closes. */
export function EpicReview({ root, className }: { root: string; className?: string }) {
  const r = reviewFor(root);
  const dk = draftKey(root, `epic-review-${r?.round || 0}`);
  const [text, setText] = useState<string>(S.drafts[dk] || '');
  const post = (body: Record<string, unknown>) => api('POST', `/api/epics/${root}/review`, { round: r?.round, ...body });
  const parked = flow.descendants(root, flow.index(S.tickets)).filter((t: Ticket) => ASKS.has(t.status) && !t.owner_task).length;
  const busy = r && ['queued', 'running'].includes(r.status);
  return (
    <section aria-label="Epic review" data-epic-review={root} className={cn('grid content-start gap-3 rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center gap-2"><SeatAvatar id="manager" size="md" /><div className="grid"><b>Review with the manager</b>
        <span className="text-[13px] text-muted-foreground">{agentMap().manager?.name || 'Morgan'} sets the order and priorities with a principal, and asks you one question.</span></div></div>
      {!r && <p className="text-sm text-muted-foreground">{parked ? `${plural(parked, 'task')} in this epic ${parked === 1 ? 'is' : 'are'} waiting on you.` : 'Use it when tasks are blocked or the order is unclear.'}</p>}
      {busy && <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin text-primary" aria-hidden />{r!.status === 'queued' ? 'Waiting for the manager.' : 'The manager is reviewing the epic.'}</p>}
      {r?.status === 'failed' && <p className="text-sm text-blocked">The review failed: {r.error || 'no reason recorded'}.</p>}
      {r?.status === 'ready' && r.result && <div className="grid gap-3 text-sm">
        <p className="text-[15px]">{r.result.summary}</p>
        {r.result.next && <p><span className="text-muted-foreground">Next: </span><button type="button" className="font-medium hover:underline" onClick={() => openTicket(r.result!.next!.key)}>{byKey(r.result.next.key) ? nameOf(byKey(r.result.next.key)!) : r.result.next.key}</button>. {r.result.next.why}</p>}
        {!!r.applied?.applied.length && <details open><summary className="cursor-pointer text-muted-foreground">Changed ({r.applied.applied.length})</summary><ul className="mt-1 grid gap-0.5 pl-4">{r.applied.applied.map((x, i) => <li key={i} className="list-disc">{x}</li>)}</ul></details>}
        {!!r.applied?.skipped.length && <details><summary className="cursor-pointer text-muted-foreground">Not changed ({r.applied.skipped.length})</summary><ul className="mt-1 grid gap-0.5 pl-4">{r.applied.skipped.map((x, i) => <li key={i} className="list-disc">{x}</li>)}</ul></details>}
        {r.question_state === 'open' && r.result.question && <div className="grid gap-2 rounded-md bg-needs/10 p-3">
          <b>One question for you</b><Markdown text={r.result.question.text} />
          {r.result.question.covers.length > 0 && <p className="text-[13px] text-muted-foreground">Your answer goes to {r.result.question.covers.join(', ')} and they continue.</p>}
          <Textarea aria-label="Your answer" rows={3} maxLength={8000} value={text} onChange={(e) => { setText(e.target.value); setDraft(dk, e.target.value); }} />
          <AsyncButton className="justify-self-start" run={async () => { if (!text.trim()) throw new Error('Write your answer first.'); await post({ action: 'answer', text }); setDraft(dk, ''); setText(''); }} ok="Answered; the tasks continue">Answer and continue</AsyncButton>
        </div>}
        {r.question_state === 'answered' && <p className="flex items-center gap-2 text-muted-foreground"><Check className="size-4 text-shipped" aria-hidden />You answered the question.</p>}
        {r.close_state === 'open' && r.result.close.length > 0 && <div className="grid gap-2 rounded-md bg-secondary p-3">
          <b>Close these tasks?</b>
          <ul className="grid gap-1">{r.result.close.map((c) => <li key={c.key}><button type="button" className="hover:underline" onClick={() => openTicket(c.key)}>{byKey(c.key) ? nameOf(byKey(c.key)!) : c.key}</button> <span className="text-muted-foreground">{c.why}</span></li>)}</ul>
          <div className="flex flex-wrap gap-2"><AsyncButton size="sm" variant="secondary" run={() => post({ action: 'close', approve: true })} ok="Closed">Close them</AsyncButton>
            <AsyncButton size="sm" variant="ghost" run={() => post({ action: 'close', approve: false })} ok="Kept">Keep them</AsyncButton></div>
        </div>}
      </div>}
      {!busy && <div className="flex flex-wrap gap-2">
        {r?.status === 'failed' ? <AsyncButton size="sm" variant="secondary" run={() => post({ action: 'retry' })} ok="Queued again">Retry the review</AsyncButton>
          : <AsyncButton size="sm" variant={r ? 'ghost' : 'secondary'} run={() => post({ action: 'start' })} ok="Queued; the manager reviews the epic">{r ? 'Review again' : 'Review this epic'}</AsyncButton>}
      </div>}
    </section>
  );
}

/** "Your task" marker for trees and lists. */
export const OwnerTag = ({ t }: { t: Ticket }) => (t.owner_task && !['done', 'wontdo'].includes(t.status) ? <Tag tone="needs">Your task</Tag> : null);
