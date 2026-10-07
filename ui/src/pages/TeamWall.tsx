// Team → Wall mode (`/?wall=1`): the desk on a TV or second monitor. No chrome; large type readable from 3 m. Exceptions
// first (deploy holds, incidents, stalled runs, approvals by age), then a flat department map with honest hand-off lines
// (only hand-offs the desk logged in the last 20 min). Every block says when it was observed. Dimmed at night; nothing
// moves, so reduced motion needs no special case. Desktop/TV only: phones use the Team page.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, CircleSlash, Rocket, Siren, TimerOff } from 'lucide-react';
import { age, isNight, FLOW_KINDS } from '../../../public/departments.js';
import { deskStatus } from '../../../public/attention.js';
import { S, openTicket } from '@/store.js';
import { hhmm } from '@/lib/format.js';
import { cn } from '@/lib/utils';
import { usePresenceClock } from '@/components/desk/Presence';
import { Counts, KpiRow, WaitingPill, useSeatTap } from '@/components/team/Departments';
import { teamOverview, openDecision, STATE_TEXT, type DeptFlow, type Exception, type TeamOverview } from '@/components/team/model';

const EX: Record<string, { label: string; icon: typeof Rocket; cls: string }> = {
  deploy: { label: 'Deploy hold', icon: Rocket, cls: 'border-l-blocked text-blocked' }, incident: { label: 'Incident', icon: Siren, cls: 'border-l-blocked text-blocked' },
  stalled: { label: 'Stalled run', icon: TimerOff, cls: 'border-l-needs text-needs' }, approval: { label: 'Waiting for you', icon: AlertTriangle, cls: 'border-l-needs text-needs' },
};
function ExceptionCard({ e, now, onSeat }: { e: Exception; now: number; onSeat: (id: string) => void }) {
  const k = EX[e.type];
  const open = () => (e.item ? openDecision(e.item) : e.seat ? onSeat(e.seat) : e.ticket ? openTicket(e.ticket) : undefined);
  return (
    <li><button type="button" onClick={open} data-exception={e.type} className={cn('grid w-full gap-1 rounded-xl border border-l-4 bg-card px-4 py-3 text-left hover:bg-secondary', k.cls)}>
      <span className="flex items-center gap-2 text-base font-semibold uppercase tracking-wide"><k.icon className="size-5" aria-hidden />{k.label}
        {e.since && <span className="ml-auto font-mono text-lg font-medium normal-case tracking-normal tabular">{age(now - Date.parse(e.since))}</span>}</span>
      <span className="line-clamp-2 text-2xl font-medium leading-snug text-foreground">{e.title}</span>
      <span className="truncate text-base text-muted-foreground">{e.detail}{e.since ? `${e.detail ? ' · ' : ''}since ${hhmm(e.since)}` : ''}</span>
    </button></li>
  );
}

const flowText = (f: DeptFlow) => Object.entries(f.kinds as Record<string, number>).map(([k, n]) => `${FLOW_KINDS[k as keyof typeof FLOW_KINDS]?.label || k}${n > 1 ? ` ×${n}` : ''}`).join(', ');

/**
 * A flat map: departments in two rows (config order) with a corridor between them. Hand-off lines run only in the
 * corridor, from a card's inner edge to another's, so no line ever crosses a card; you sit in the middle of it.
 */
function DepartmentMap({ m, onSeat }: { m: TeamOverview; onSeat: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const on = () => setW(el.clientWidth);
    on(); const ro = new ResizeObserver(on); ro.observe(el); return () => ro.disconnect();
  }, []);
  const n = m.deps.length, topN = Math.ceil(n / 2), botN = n - topN, GAP = 16, H = 210;
  const cw = W ? (W - GAP * (topN - 1)) / topN : 0;
  const top = m.deps.slice(0, topN), bottom = m.deps.slice(topN);
  const botOff = W ? (W - (botN * cw + (botN - 1) * GAP)) / 2 : 0;
  const at: Record<string, { x: number; y: number; row: 'top' | 'bottom' | 'mid' }> = { owner: { x: W / 2, y: H / 2, row: 'mid' } };
  top.forEach((d, i) => { at[d.id] = { x: i * (cw + GAP) + cw / 2, y: 0, row: 'top' }; });
  bottom.forEach((d, i) => { at[d.id] = { x: botOff + i * (cw + GAP) + cw / 2, y: H, row: 'bottom' }; });
  const path = (a: (typeof at)[string], b: (typeof at)[string]) => {
    const c1y = a.row === b.row && a.row !== 'mid' ? (a.row === 'top' ? H * 0.55 : H * 0.45) : (a.y + b.y) / 2;
    // The label sits a third of the way along, nearer the sender, so labels of different lines rarely meet in the middle.
    const t = 0.35, u = 1 - t;
    const mid = { x: u * u * u * a.x + 3 * u * u * t * a.x + 3 * u * t * t * b.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1y + 3 * u * t * t * c1y + t * t * t * b.y };
    return { d: `M${a.x},${a.y} C${a.x},${c1y} ${b.x},${c1y} ${b.x},${b.y}`, mid };
  };
  const row = (deps: typeof m.deps, cls: string, style?: React.CSSProperties) => (
    <div className={cn('grid gap-4', cls)} style={{ gridTemplateColumns: `repeat(${deps.length}, ${cw ? `${cw}px` : 'minmax(0,1fr)'})`, ...style }}>
      {deps.map((d) => <WallDepartment key={d.id} d={d} m={m} onSeat={onSeat} />)}
    </div>
  );
  return (
    <div ref={box} className="flex min-h-0 flex-col justify-center" data-department-map>
      {row(top, 'items-stretch')}
      <div className="relative shrink-0" style={{ height: H }}>
        {W > 0 && <svg className="absolute inset-0" width={W} height={H} aria-hidden data-handoffs={m.flows.length}>
          <defs><marker id="sd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7ea6ff" /></marker></defs>
          {[...top, ...bottom].map((d) => { const p = at[d.id]; return <circle key={d.id} cx={p.x} cy={p.y} r={5} fill="#263246" />; })}
          {m.flows.map((f) => {
            const a = at[f.from], b = at[f.to];
            if (!a || !b) return null;
            const { d } = path(a, b);
            return <path key={`${f.from}>${f.to}`} data-handoff={`${f.from}>${f.to}`} d={d} fill="none" stroke="#5B8CFF" strokeOpacity={0.3 + 0.6 * f.strength} strokeWidth={2 + Math.min(3, f.count)}
              markerEnd="url(#sd-arrow)" strokeDasharray={f.from === 'owner' || f.to === 'owner' ? '7 6' : undefined} />;
          })}
        </svg>}
        <div className="absolute grid size-16 place-items-center rounded-full border border-primary/50 bg-background text-lg font-semibold text-primary" style={{ left: W / 2 - 32, top: H / 2 - 32 }} aria-hidden>You</div>
        {W > 0 && (() => {
          // Labels never cover each other: placed left to right, a label that would overlap one already placed moves down.
          const placed: { x: number; y: number; w: number }[] = [];
          return m.flows.map((f) => ({ f, a: at[f.from], b: at[f.to] })).filter((x) => x.a && x.b)
            .map((x) => ({ ...x, mid: path(x.a, x.b).mid, text: `${flowText(x.f)} · ${age(m.now - Date.parse(x.f.lastTs))} ago` }))
            .sort((p, q) => p.mid.x - q.mid.x)
            .map(({ f, mid, text }) => {
              const w = text.length * 7.6 + 24;
              let y = mid.y;
              while (placed.some((p) => Math.abs(p.x - mid.x) < (p.w + w) / 2 + 4 && Math.abs(p.y - y) < 28)) y += 28;
              placed.push({ x: mid.x, y, w });
              return <span key={`${f.from}>${f.to}`} className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border bg-background px-2.5 py-0.5 text-sm text-foreground/85"
                style={{ left: mid.x, top: y }} data-handoff-label>{text}</span>;
            });
        })()}
      </div>
      {row(bottom, 'items-stretch', { marginLeft: botOff })}
    </div>
  );
}

const DOT: Record<string, string> = { working: 'bg-primary', quiet: 'bg-primary/45', stalled: 'bg-needs', next: 'border border-muted-foreground', idle: 'bg-secondary', off: 'bg-secondary opacity-40' };
function WallDepartment({ d, m, onSeat }: { d: TeamOverview['deps'][number]; m: TeamOverview; onSeat: (id: string) => void }) {
  const K = m.kpis[d.id];
  return (
    <article data-department={d.id} className="grid min-w-0 content-start gap-2 overflow-hidden rounded-2xl border bg-card px-4 py-3 shadow-lg shadow-black/30">
      <div className="flex items-baseline gap-2"><h3 className="truncate text-xl font-semibold">{d.label}</h3>
        <span className="ml-auto flex gap-1" aria-label="Seats">{d.seats.map((s) => { const st = m.states[s]?.state || 'idle'; const a = m.agents[s];
          return <button key={s} type="button" onClick={() => onSeat(s)} title={`${a?.name}: ${STATE_TEXT[st]}`} data-seat-dot={s} data-state={st} className={cn('size-3.5 rounded-full', DOT[st])}><span className="sr-only">{a?.name}: {STATE_TEXT[st]}</span></button>; })}</span></div>
      <WaitingPill d={d} m={m} wall />
      {K?.kpis.map((k) => <KpiRow key={k.label} k={k} wall />)}
      <Counts c={m.counts[d.id]} wall />
    </article>
  );
}

export default function TeamWall() {
  usePresenceClock();
  const m = teamOverview();
  const { tap, sheet } = useSeatTap();
  const now = new Date(m.now);
  const night = isNight(now, S.settings.wall_night || '22-7');
  const live = useRef(m.now);
  if (S.connected) live.current = m.now;
  useEffect(() => { document.title = 'SigmaDesk · Team wall'; }, []);
  const B = m.board;
  const desk = !S.connected ? { label: 'Offline', tone: 'red' } : deskStatus(S);
  const lastEvent = S.events.length ? S.events.reduce((x, e) => (Date.parse(e.ts) > Date.parse(x.ts) ? e : x)).ts : null;
  const ex = m.exceptions;
  const stat = (n: number, label: string, cls: string) => <span className="inline-flex items-baseline gap-2"><b className={cn('font-mono text-4xl font-medium tabular', n ? cls : 'text-muted-foreground/60')}>{n}</b><span className="text-lg text-muted-foreground">{label}</span></span>;
  return (
    <div data-team-wall data-night={night || undefined} className={cn('flex h-dvh flex-col overflow-hidden bg-background px-8 pb-5 pt-6 transition-[filter] duration-1000', night && 'brightness-[.6]')}>
      <header className="flex items-center gap-8">
        <div className="flex items-baseline gap-3"><span aria-hidden className="text-4xl font-semibold text-primary">σ</span><h1 className="text-3xl font-semibold tracking-tight">Team</h1>
          <span className="text-xl text-muted-foreground">{S.meta.project || 'SigmaDesk'}</span></div>
        <div className="flex items-baseline gap-7">{stat(B.counts.needs_you, 'need you', 'text-needs')}{stat(B.counts.blocked, 'blocked', 'text-blocked')}{stat(B.counts.working, 'working', 'text-primary')}{stat(B.counts.queued, 'queued', 'text-foreground')}</div>
        <span className="flex-1" />
        <span className="grid text-right text-base text-muted-foreground" data-observed>
          <span className="inline-flex items-center justify-end gap-2 text-lg text-foreground"><span aria-hidden className={cn('size-3 rounded-full', { green: 'bg-shipped', amber: 'bg-needs', red: 'bg-blocked' }[desk.tone as string] || 'bg-muted-foreground')} />{desk.label}</span>
          <span>{S.connected ? `live · observed ${hhmm(new Date(live.current).toISOString())}` : `offline · last observed ${hhmm(new Date(live.current).toISOString())}`}{lastEvent ? ` · last desk event ${hhmm(lastEvent)}` : ''}</span>
        </span>
        <time className="font-mono text-4xl font-medium tabular">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
      </header>
      <div className="mt-5 grid min-h-0 flex-1 grid-cols-[27rem_minmax(0,1fr)] gap-6">
        <section aria-labelledby="ex-h" className="flex min-h-0 flex-col gap-3">
          <h2 id="ex-h" className="text-2xl font-semibold">Needs attention <span className="font-mono text-muted-foreground">{ex.length}</span></h2>
          {ex.length ? <ol className="grid min-h-0 content-start gap-3 overflow-hidden">{ex.slice(0, 6).map((e) => <ExceptionCard key={e.id} e={e} now={m.now} onSeat={tap} />)}</ol>
            : <p className="flex items-center gap-2 text-xl text-muted-foreground"><CircleSlash className="size-5" aria-hidden />Nothing needs you or is stuck.</p>}
          {ex.length > 6 && <p className="text-lg text-muted-foreground">+{ex.length - 6} more in the Inbox</p>}
        </section>
        <section aria-label="Departments" className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-2">
          <DepartmentMap m={m} onSeat={tap} />
          <p className="text-base text-muted-foreground">Lines: hand-offs the desk logged in the last 20 min between departments (dashed: to or from you). Dots: seats — <span className="text-primary">working</span>, <span className="text-needs">no update</span>, grey available or off.</p>
        </section>
      </div>
      {sheet}
    </div>
  );
}
