// Department cards for the Team page and its Wall mode: one concern, two domain KPIs (each with its source, window and
// observation time, or "unknown" and why), the department's highest-priority waiting decision as a pill that opens it,
// the board counts for its work, and honest presence chips for its seats.
import { useState } from 'react';
import { AlertTriangle, Tv } from 'lucide-react';
import { age, decisionLabel } from '../../../../public/departments.js';
import { S, openSeat, openTicket, setDraft, draftKey } from '@/store.js';
import { hhmm } from '@/lib/format.js';
import { cn } from '@/lib/utils';
import { SeatAvatar } from '@/components/desk/Bits';
import { PersonSheet } from '@/components/desk/PeopleSheet';
import { usePresenceClock } from '@/components/desk/Presence';
import { Button } from '@/components/ui/button';
import { teamOverview, openDecision, STATE_TEXT, type Department, type Kpi, type TeamOverview } from './model';
import type { Agent } from '@/types';

/** Tap a seat: the person sheet (status, current work, access, tag in chat) when it is on a ticket, else the seat sheet. */
export function useSeatTap() {
  const [person, setPerson] = useState<{ seat: string; tkey: string } | null>(null);
  const tap = (seat: string) => {
    const a = S.agents.find((x) => x.id === seat) as Agent | undefined;
    if (a?.current_ticket) setPerson({ seat, tkey: a.current_ticket }); else openSeat(seat);
  };
  const sheet = person && <PersonSheet seat={person.seat} tkey={person.tkey} onClose={() => setPerson(null)} onTag={(seat) => {
    const a = S.agents.find((x) => x.id === seat) as Agent | undefined;
    const k = draftKey(person.tkey), first = String(a?.name || seat).split(/\s+/)[0], cur = S.drafts[k] || '';
    if (!cur.includes(`@${first}`)) setDraft(k, `${cur ? `${cur.trimEnd()} ` : ''}@${first} `);
    openTicket(person.tkey, { tab: 'conversation', focus: true });
  }} />;
  return { tap, sheet };
}

const TONE: Record<string, string> = { needs: 'text-needs', blocked: 'text-blocked', neutral: 'text-foreground' };
const when = (iso: string | null) => (iso ? hhmm(iso) : '');

export function KpiRow({ k, wall }: { k: Kpi; wall?: boolean }) {
  const meta = k.unknown ? k.unknown : [k.window, k.at ? `as of ${when(k.at)}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="grid min-w-0 gap-0.5" data-kpi={k.label} data-unknown={k.unknown ? true : undefined} title={`Source: ${k.source}${k.window ? `\nWindow: ${k.window}` : ''}${k.at ? `\nObserved: ${new Date(k.at).toLocaleString()}` : ''}`}>
      <div className="flex items-baseline gap-3">
        <span className={cn('min-w-0 flex-1 text-muted-foreground', wall ? 'text-lg' : 'text-sm')}>{k.label}</span>
        <b className={cn('shrink-0 font-mono font-medium tabular', wall ? 'text-2xl' : 'text-base', k.unknown ? 'font-sans text-sm font-normal italic text-muted-foreground' : TONE[k.tone] || '')}>{k.unknown ? 'unknown' : k.value}</b>
      </div>
      <span className={cn('truncate text-muted-foreground/80', wall ? 'text-sm' : 'text-xs')}>{meta}</span>
    </div>
  );
}

const RING: Record<string, string> = { working: 'ring-2 ring-primary', quiet: 'ring-1 ring-primary/50', stalled: 'ring-2 ring-needs', next: 'ring-1 ring-muted-foreground/60', idle: 'ring-1 ring-border', off: 'opacity-40 grayscale' };
export function SeatChip({ id, m, onTap, wall }: { id: string; m: TeamOverview; onTap: (id: string) => void; wall?: boolean }) {
  const a = m.agents[id], st = m.states[id];
  if (!a || !st) return null;
  const first = String(a.name).split(/\s+/)[0];
  return (
    <button type="button" onClick={() => onTap(id)} data-seat-chip={id} data-state={st.state} title={`${a.name}, ${a.role}: ${STATE_TEXT[st.state]}${st.label ? ` · ${st.label}` : ''}`}
      className={cn('inline-flex max-w-full items-center gap-2 rounded-full border bg-background/50 py-0.5 pl-0.5 pr-2.5 text-left hover:bg-secondary', wall ? 'text-base' : 'min-h-8 text-sm max-md:min-h-11',
        st.state === 'stalled' && 'border-needs/50', st.state === 'off' && 'text-muted-foreground')}>
      <span className={cn('inline-flex shrink-0 rounded-full ring-offset-1 ring-offset-card', RING[st.state])}><SeatAvatar id={id} size={wall ? 'md' : 'sm'} /></span>
      <span className="truncate">{first}<span className={cn('text-muted-foreground', st.state === 'working' && 'text-primary', st.state === 'stalled' && 'text-needs')}> · {STATE_TEXT[st.state]}</span></span>
    </button>
  );
}

/** "⚠ 1 waiting merge · 23 min" — the department's first decision in Inbox order; tapping opens it. */
export function WaitingPill({ d, m, wall }: { d: Department; m: TeamOverview; wall?: boolean }) {
  const w = m.counts[d.id]?.waiting || [];
  if (!w.length) return null;
  const top = w[0] as (typeof w)[number] & { since?: string | null };
  const wait = top.since ? age(m.now - Date.parse(top.since)) : '';
  const text = w.length === 1 ? `1 waiting ${decisionLabel(top.kind)}` : `${w.length} waiting · ${decisionLabel(top.kind)}`;
  return (
    <button type="button" onClick={() => openDecision(top)} data-waiting-pill={d.id} aria-label={`${top.verb}${wait ? `, waiting ${wait}` : ''}. ${w.length} waiting in ${d.label}. Open the decision`}
      className={cn('inline-flex max-w-full items-center gap-1.5 justify-self-start rounded-full bg-needs/15 px-2.5 py-1 font-medium text-needs hover:bg-needs/25', wall ? 'text-lg' : 'text-sm max-md:min-h-10')}>
      <AlertTriangle className={wall ? 'size-5' : 'size-4'} aria-hidden /><span className="truncate">{text}{wait && <span className="font-mono tabular"> · {wait}</span>}</span>
    </button>
  );
}

export function Counts({ c, wall }: { c: { working: number; queued: number; blocked: number }; wall?: boolean }) {
  const n = (v: number, l: string, cls: string) => <span className="inline-flex items-baseline gap-1"><b className={cn('font-mono font-medium tabular', wall ? 'text-xl' : '', v ? cls : 'text-muted-foreground/70')}>{v}</b><span className="text-muted-foreground">{l}</span></span>;
  return <div className={cn('flex flex-wrap gap-x-4 gap-y-1', wall ? 'text-base' : 'text-sm')}>{n(c.working, 'working', 'text-primary')}{n(c.queued, 'queued', 'text-foreground')}{n(c.blocked, 'blocked', 'text-blocked')}</div>;
}

export function DepartmentCard({ d, m, onSeat, wall, seats = true }: { d: Department; m: TeamOverview; onSeat: (id: string) => void; wall?: boolean; seats?: boolean }) {
  const K = m.kpis[d.id];
  const c = m.counts[d.id];
  return (
    <article data-department={d.id} aria-labelledby={`dep-${d.id}`} className={cn('grid content-start gap-3 rounded-xl border bg-card', wall ? 'gap-3.5 p-5' : 'p-4')}>
      <header className="grid gap-0.5">
        <div className="flex items-baseline gap-2"><h3 id={`dep-${d.id}`} className={cn('font-semibold', wall ? 'text-2xl' : 'text-base')}>{d.label}</h3>
          <span className={cn('ml-auto text-muted-foreground', wall ? 'text-base' : 'text-xs')}>{d.seats.length} {d.seats.length === 1 ? 'seat' : 'seats'}</span></div>
        {K?.concern && <p className={cn('text-muted-foreground', wall ? 'text-base' : 'text-sm')}>{K.concern}</p>}
      </header>
      <WaitingPill d={d} m={m} wall={wall} />
      <div className="grid gap-2.5">{K?.kpis.map((k) => <KpiRow key={k.label} k={k} wall={wall} />)}</div>
      {d.id === 'qa' && <div className="grid gap-1 rounded-lg bg-background/50 px-3 py-2" data-release>
        <span className={cn('text-muted-foreground', wall ? 'text-sm' : 'text-xs')}>Release · merged is not deployed is not verified</span>
        <div className="grid grid-cols-3 gap-2">{m.release.map((r) => (
          <div key={r.label} className="grid" data-release-fact={r.label} title={`Source: ${r.source}${r.window ? `\nWindow: ${r.window}` : ''}${r.unknown ? `\nUnknown: ${r.unknown}` : ''}`}>
            <b className={cn('font-mono font-medium tabular', wall ? 'text-xl' : 'text-base', r.unknown && 'font-sans text-sm font-normal italic text-muted-foreground')}>{r.unknown ? 'unknown' : r.value}</b>
            <span className={cn('text-muted-foreground', wall ? 'text-sm' : 'text-xs')}>{r.label}</span></div>))}</div>
      </div>}
      {c && <Counts c={c} wall={wall} />}
      {seats && d.seats.length > 0 && <div className="flex flex-wrap gap-1.5">{d.seats.map((id) => <SeatChip key={id} id={id} m={m} onTap={onSeat} wall={wall} />)}</div>}
    </article>
  );
}

/** The Team page's overview: department cards above the individual seats, and the way into Wall mode. */
export function TeamOverviewSection() {
  usePresenceClock();
  const m = teamOverview();
  const { tap, sheet } = useSeatTap();
  return (
    <section aria-labelledby="departments-h" className="grid gap-3" data-team-overview>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="departments-h" className="text-base font-semibold">Departments</h2>
        <span className="text-sm text-muted-foreground">counts are the Inbox and Work counts, split by who holds the work</span>
        <span className="flex-1" />
        <Button variant="outline" size="sm" asChild className="max-md:hidden"><a href="/?wall=1" target="_blank" rel="noreferrer"><Tv className="size-4" />Wall mode</a></Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{m.deps.map((d) => <DepartmentCard key={d.id} d={d} m={m} onSeat={tap} />)}</div>
      {sheet}
    </section>
  );
}
