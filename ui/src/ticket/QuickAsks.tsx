// Quick asks above the message bar (sowmith95/sigmadesk#6): "What blocks this?", "What remains before merge?",
// "Verify in production". Each first shows the desk's own answer (GET /api/tickets/KEY/decision-brief: deterministic,
// free), then routes the question the existing way: a tagged message to the right seat (same access choice per person
// as the people picker), or, on a merged or closed ticket, ONE linked verify task (POST /verify-task) that never reopens
// it. What actually happened (sent, not delivered and why, filed, refused and why) is said in the card.
import { useState } from 'react';
import { X } from 'lucide-react';
import { setMentions } from '../../../public/mentions.js';
import { S, api, loadDetail, loadSnapshot, openTicket } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { cn } from '@/lib/utils';
import type { Agent, Ticket } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Kind = 'blocks' | 'remaining' | 'verify';
type Result = { tone: 'ok' | 'bad'; text: string; key?: string };
const ASKS: [Kind, string][] = [['blocks', 'What blocks this?'], ['remaining', 'What remains before merge?'], ['verify', 'Verify in production']];
const STEP: Record<string, [string, string]> = { done: ['✓', 'text-shipped'], now: ['▸', 'text-needs'], next: ['·', 'text-muted-foreground'], blocked: ['!', 'text-blocked'], unknown: ['?', 'text-muted-foreground'] };
const BLOCK_TONE: Record<string, string> = { blocked: 'text-blocked', yours: 'text-needs', waiting: 'text-muted-foreground', unknown: 'text-muted-foreground' };
const newId = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
const agent = (id: string) => (S.agents as Agent[]).find((a) => a.id === id);
const firstOf = (id: string) => String(agent(id)?.name || id).split(/\s+/)[0];
const toOwner = (why: string[]) => why.map((w) => w.replace(/the owner's decision/g, 'your decision').replace(/the (access )?policy/g, 'your access policy')).join('; ');

/** Who a quick ask goes to: the builder for "what blocks this" (if a seat that is on), else the manager; the SRE verifies. */
export function askTarget(kind: Kind, t: Ticket): string {
  if (kind === 'verify') return 'sre';
  if (kind === 'blocks' && t.assignee && agent(t.assignee) && agent(t.assignee)!.enabled !== false) return t.assignee;
  return 'manager';
}
const QUESTION: Record<Kind, (name: string) => string> = {
  blocks: () => 'What blocks this? Say what it is waiting for and who can move it.',
  remaining: () => 'What remains before merge? List the steps left and who owns each.',
  verify: (name) => `Verify in production: ${name}. Use the read-only probes and report what you observed (the probe, its result, and what it does not cover).`,
};

export function QuickAsks({ t, choice, setChoice, why }: { t: Ticket; choice: Record<string, boolean>; setChoice: (c: Record<string, boolean>) => void; why?: Record<string, string[]> }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const closed = ['done', 'wontdo'].includes(t.status);
  const choose = async (k: Kind) => {
    if (open === k) { setOpen(null); return; }
    setOpen(k); setResult(null); setError(''); setData(null);
    try { setData(await api('GET', `/api/tickets/${t.key}/decision-brief`)); } catch (e) { setError((e as Error).message); }
  };
  const seat = open ? askTarget(open, t) : '';
  const allow = (why?.[seat]?.length === 0) && choice[seat] !== false;
  // The routed question: a tagged message (the server's reply route), reporting each delivery's real state.
  const sendAsk = async () => {
    if (!open) return false;
    const body = `${setMentions('', [seat], S.agents as Agent[], 0).text}${QUESTION[open](t.name || t.title)}`;
    try {
      const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode: 'auto', mentions: [seat], request_id: newId(), ...(choice[seat] === false ? { no_access: [seat] } : {}) });
      const m = (r.mentions || [])[0];
      setResult(m?.status === 'blocked' ? { tone: 'bad', text: `Not delivered: ${m.reason}` } : { tone: 'ok', text: `Sent to ${firstOf(seat)}; the answer lands in this thread.` });
      await loadDetail();
    } catch (e) {
      const err = e as Error & { code?: string };
      setResult({ tone: 'bad', text: err.code === 'ticket_closed' ? `Not sent: ${t.key} is closed, and a quick ask never reopens it.` : `Not sent: ${err.message}` });
    }
    return false;
  };
  // On a merged or closed ticket: one linked verify task; the ticket keeps its state.
  const fileVerify = async () => {
    try {
      const r = await api('POST', `/api/tickets/${t.key}/verify-task`, {});
      setResult({ tone: 'ok', text: r.message, key: r.ticket?.key }); await loadSnapshot().catch(() => {}); await loadDetail();
    } catch (e) { setResult({ tone: 'bad', text: (e as Error).message }); }
    return false;
  };
  const d = data;
  return (
    <div className="grid min-w-0 gap-1.5" data-quick-asks>
      <div role="group" aria-label="Quick asks" className="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none]">
        {ASKS.map(([k, label]) => <button key={k} type="button" data-quick-ask={k} aria-pressed={open === k} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(k)}
          className={cn('h-8 shrink-0 whitespace-nowrap rounded-full border px-3 text-[13px]', open === k ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground')}>{label}</button>)}
      </div>
      {open && <section aria-label={ASKS.find(([k]) => k === open)![1]} data-quick-answer={open} className="grid max-h-[45dvh] gap-2 overflow-y-auto overscroll-contain rounded-lg border bg-card p-3 text-sm md:max-h-[50vh]">
        <div className="flex items-start gap-2"><b className="min-w-0 flex-1">{ASKS.find(([k]) => k === open)![1]}<span className="font-normal text-muted-foreground"> · the desk’s answer</span></b>
          <button type="button" aria-label="Close" className="-m-1 grid size-8 place-items-center rounded hover:bg-secondary" onClick={() => setOpen(null)}><X className="size-4" /></button></div>
        {error ? <p className="text-blocked">{error}</p> : !d ? <p className="text-muted-foreground">Checking…</p> : <>
          {open === 'blocks' && (d.closed ? <p>{t.status === 'done' ? 'Merged' : 'Closed'}: nothing blocks it.</p>
            : d.blocks?.length ? <ul className="grid gap-1" data-blocks>{d.blocks.map((b: any, i: number) => <li key={i} data-state={b.state}><b className={cn('font-medium', BLOCK_TONE[b.state])}>{b.label}</b> <span className="text-muted-foreground">{b.text}</span></li>)}</ul>
              : <p>Nothing blocks it right now.</p>)}
          {open === 'remaining' && (d.remaining?.closed ? <p>{d.remaining.text}</p> : <>
            <p>{d.remaining?.text}</p>
            <ol className="grid gap-1" data-remaining>{(d.remaining?.steps || []).map((s: any) => { const [g, tone] = STEP[s.state] || ['·', '']; return <li key={s.id} data-step={s.id} data-state={s.state} className="flex gap-2">
              <span aria-hidden className={cn('w-3 shrink-0 text-center font-mono', tone)}>{g}</span><span className="sr-only">{s.state}: </span><span className="min-w-0">{s.label}{s.text && s.state !== 'done' ? <span className="text-muted-foreground"> · {s.text}</span> : null}</span></li>; })}</ol></>)}
          {open === 'verify' && <p>{closed ? `${t.key} is ${t.status === 'done' ? 'merged' : 'closed'}. This files one linked task for ${firstOf('sre')} (SRE) to check it with read-only probes; ${t.key} keeps its state.`
            : `${firstOf('sre')} (SRE) checks it with read-only production probes and answers here; real follow-up work becomes its own task.`}</p>}
        </>}
        {/* The routed step, and its access choice (the same per-person choice as the people picker). */}
        {d && !(closed && open !== 'verify') && <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          {!(closed && open === 'verify') && why && <label className="flex min-w-0 basis-full items-center gap-2 text-[13px] text-muted-foreground sm:basis-auto sm:flex-1">
            {why[seat]?.length === 0 ? <><Switch checked={allow} aria-label={`Allow ${firstOf(seat)} production read access for this reply`} onCheckedChange={(on) => setChoice({ ...choice, [seat]: on })} />
              <span>{allow ? 'Read-only access for this reply (1 hour at most)' : 'Ask me in Inbox before any access'}</span></>
              : <span title={toOwner(why[seat] || [])}>No automatic production access{why[seat] ? `: ${toOwner(why[seat].slice(0, 1))}` : ''}.</span>}</label>}
          <span className="flex-1" />
          {closed && open === 'verify' ? <AsyncButton size="sm" data-quick-run run={fileVerify}>File the check</AsyncButton>
            : <AsyncButton size="sm" data-quick-run run={sendAsk}>{open === 'verify' ? `Ask ${firstOf(seat)} to verify` : `Ask ${firstOf(seat)}`}</AsyncButton>}
        </div>}
        {closed && open !== 'verify' && d && <p className="text-[13px] text-muted-foreground">It is closed, so nobody is asked: a quick ask never reopens a ticket.</p>}
        {result && <p role="status" data-quick-result={result.tone} className={cn('rounded-md px-3 py-2', result.tone === 'ok' ? 'bg-shipped/15' : 'bg-blocked/15')}>{result.text}
          {result.key && result.key !== t.key && <> <Button variant="link" size="sm" className="h-auto p-0" onClick={() => openTicket(result.key!)}>Open {result.key}</Button></>}</p>}
      </section>}
    </div>
  );
}
