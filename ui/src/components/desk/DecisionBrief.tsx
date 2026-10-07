// The decision snapshot on screen (sowmith95/sigmadesk#6): the server's brief (meta.decision_briefs, src/decision-model.js)
// rendered the same way on an Inbox card and in the Decision sheet. It leads with what you decide, what approving does,
// what it releases and how long it has waited; then the gate in order and how fresh each piece of evidence is. A brief
// for an older commit says so: what the screen shows never authorizes anything (the server re-checks at execution).
import { useEffect } from 'react';
import { Check, CircleAlert, CircleDashed, Clock, HelpCircle, User } from 'lucide-react';
import { S, openTicket, refreshMeta } from '@/store.js';
import { cn } from '@/lib/utils';
import type { BoardItem, Ticket } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Brief = Record<string, any>;
export const briefOf = (id?: string | null): Brief | null => (id && S.meta.decision_briefs?.[id]) || null;
const short = (s?: string | null) => String(s || '').slice(0, 7);
/** "QA · QA passed…" reads twice: the label already says it. */
const dropLabel = (label: string, text: string) => { const t = String(text || ''); return t.toLowerCase().startsWith(`${label.toLowerCase()} `) ? t.slice(label.length + 1) : t; };

const GATE_ICON: Record<string, [typeof Check, string, string]> = {
  ok: [Check, 'text-shipped', 'passed'], yours: [User, 'text-needs', 'yours'], waiting: [Clock, 'text-muted-foreground', 'waiting'],
  blocked: [CircleAlert, 'text-blocked', 'blocked'], unknown: [HelpCircle, 'text-muted-foreground', 'unknown'],
};
const FRESH: Record<string, [string, string]> = { current: ['current', 'text-shipped'], old: ['old', 'text-needs'], stale: ['stale', 'text-blocked'], unknown: ['unknown', 'text-muted-foreground'], none: ['none', 'text-blocked'] };
const TONE: Record<string, string> = { ok: 'text-foreground', deploy: 'text-foreground', unknown: 'text-needs' };
// Four distinct gate states: green only when every predicate is positively satisfied.
const GATE_HEAD: Record<string, string> = { ready: 'text-shipped', waiting: 'text-needs', unknown: 'text-muted-foreground', blocked: 'text-blocked' };
const GATE_DOT: Record<string, string> = { ready: 'bg-shipped', waiting: 'bg-needs', unknown: 'border border-muted-foreground bg-transparent', blocked: 'bg-blocked' };
const GATE_WORD: Record<string, string> = { ready: 'Ready', waiting: 'Waiting', unknown: 'Not confirmed', blocked: 'Blocked' };

/** The brief describes another commit than the one on screen: say it, and fetch a fresh snapshot. */
function useStale(b: Brief | null, t?: Ticket | null) {
  const stale = !!(b && t && b.evidence?.head_sha && t.head_sha && b.evidence.head_sha !== t.head_sha);
  useEffect(() => { if (stale) refreshMeta(); }, [stale, t?.head_sha]); // eslint-disable-line react-hooks/exhaustive-deps
  return stale;
}

/** One line for a collapsed Inbox row: gate state, then what approving does. */
export function BriefLine({ it }: { it: BoardItem }) {
  const b = briefOf(it.id);
  if (!b || b.error || !b.consequence) return null;
  const g = b.gate || {};
  const showConsequence = ['merge', 'publish', 'guard', 'deploy', 'access'].includes(b.kind);
  if (!showConsequence && g.state === 'ready') return null;
  return (
    <p data-brief-line={b.kind} className="flex min-w-0 items-baseline gap-1.5 pl-9 text-[13px] text-muted-foreground">
      <span aria-hidden data-gate-dot={g.state} className={cn('relative top-[-1px] inline-block size-2 shrink-0 rounded-full', GATE_DOT[g.state] || GATE_DOT.unknown)} />
      <span className="sr-only">{GATE_WORD[g.state] || g.state}: </span>
      <span className="min-w-0 [overflow-wrap:anywhere] max-md:line-clamp-2 md:truncate" title={b.consequence.summary}>
        {g.state !== 'ready' ? <span className={GATE_HEAD[g.state]}>{g.headline} </span> : null}{showConsequence ? b.consequence.summary : null}</span>
    </p>
  );
}

// Section labels in sentence case (UX v2: no all-caps labels).
function Label({ children }: { children: React.ReactNode }) { return <p className="text-[13px] font-medium text-muted-foreground">{children}</p>; }

/** Evidence freshness in one line: QA · Reviews · CI, each current / old / stale / unknown with its age, then commit and policy. */
export function Freshness({ b }: { b: Brief }) {
  const ev = b.evidence || {};
  const rows = [['QA', ev.qa], ['Reviews', ev.reviews], ['CI', ev.ci]].filter(([, x]) => x) as [string, Brief][];
  if (!rows.length) return null;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]" data-freshness>
      {rows.map(([k, x]) => { const [word, tone] = FRESH[x.state] || [x.state, 'text-muted-foreground']; return (
        <span key={k} data-evidence={k.toLowerCase()} data-state={x.state} title={x.text}><span className="text-muted-foreground">{k} </span><b className={cn('font-medium', tone)}>{word}</b>
          {x.age_minutes != null && x.state !== 'unknown' && <span className="text-muted-foreground"> · {x.age_minutes < 60 ? `${x.age_minutes} min` : `${Math.round(x.age_minutes / 60)} h`}</span>}</span>); })}
      <span className="text-muted-foreground">{ev.head_sha ? <>commit <span className="font-mono">{short(ev.head_sha)}</span> · </> : null}policy <span className="font-mono">{b.policy_version || 'unknown'}</span></span>
    </p>
  );
}

/** The gate in order: each reason with its state. */
export function GateList({ b, compact = false }: { b: Brief; compact?: boolean }) {
  const g = b.gate;
  if (!g) return null;
  return (
    <div className="grid gap-1.5" data-gate={g.state}>
      <p className={cn('font-medium', GATE_HEAD[g.state])} data-gate-headline>{g.headline}</p>
      {!compact && <ol className="grid gap-1">{g.items.map((i: Brief) => { const [Icon, tone, word] = GATE_ICON[i.state] || [CircleDashed, 'text-muted-foreground', i.state]; return (
        <li key={i.id} data-gate-item={i.id} data-state={i.state} className="flex items-start gap-2 text-sm">
          <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone)} /><span className="sr-only">{word}: </span>
          <span className="min-w-0 [overflow-wrap:anywhere]"><b className="font-medium">{i.label}</b> <span className="text-muted-foreground">{dropLabel(i.label, i.text)}</span></span></li>); })}</ol>}
    </div>
  );
}

/**
 * The lead of a decision: you decide · what approving does · what it releases · wait. `full` adds the gate list,
 * the freshness rows and what stays yours (the Decision sheet and an expanded Inbox row).
 */
export function DecisionLead({ it, t, full = true, inline = false }: { it: BoardItem; t?: Ticket | null; full?: boolean; inline?: boolean }) {
  const b = briefOf(it.id);
  const stale = useStale(b, t || it.ticket);
  if (!b) return <p className="text-sm text-muted-foreground" data-brief-missing>Loading what this decision does…</p>;
  if (b.error) return <p className="text-sm text-blocked">The desk could not summarize this decision: {b.error}</p>;
  const c = b.consequence || {};
  const rel = b.releases?.tickets || [];
  return (
    <section aria-label="Decision summary" data-decision-lead={b.kind} className={cn('grid gap-3', !inline && 'rounded-lg border border-l-[3px] border-l-needs bg-card p-4')}>
      {!inline && <div className="grid gap-1"><Label>You decide</Label><p className="text-[17px] font-semibold leading-snug" data-you-decide>{b.you_decide}</p></div>}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted-foreground"><span data-wait>{b.wait?.text}</span>
        <span data-releases>{rel.length ? <>Unblocks {rel.slice(0, 3).map((r: Brief, i: number) => <span key={r.key}>{i > 0 && ', '}<button type="button" className="text-foreground hover:underline" onClick={() => openTicket(r.key)}>{r.name}</button></span>)}{rel.length > 3 ? ` and ${rel.length - 3} more` : ''}</> : b.releases?.text}</span></p>
      {stale && <p role="status" className="rounded-md bg-needs/15 px-3 py-2 text-sm">This summary is for commit <span className="font-mono">{short(b.evidence?.head_sha)}</span>; the ticket is now at <span className="font-mono">{short((t || it.ticket)?.head_sha)}</span>. Refreshing.</p>}
      <div className="grid gap-1.5" data-consequence={c.deploy?.state || b.kind}>
        <Label>If you approve</Label>
        <ol className="grid gap-1">{(c.steps || []).map((s: Brief, i: number) => <li key={i} className={cn('flex gap-2 text-sm', TONE[s.tone] || 'text-foreground')}>
          <span aria-hidden className="w-4 shrink-0 text-right font-mono text-[12px] leading-5 text-muted-foreground">{i + 1}</span><span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span></li>)}</ol>
      </div>
      {(full || b.gate?.state !== 'ready') && <div className="grid gap-1.5"><Label>Gate</Label><GateList b={b} compact={!full} /></div>}
      {full && b.evidence && (b.evidence.qa || b.evidence.ci) && <div className="grid gap-1.5"><Label>Evidence freshness</Label><Freshness b={b} /></div>}
      {full && b.human?.length > 0 && <div className="grid gap-1.5" data-human><Label>Still yours after approving</Label>
        <ul className="grid list-disc gap-1 pl-5 text-sm">{b.human.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></div>}
    </section>
  );
}
