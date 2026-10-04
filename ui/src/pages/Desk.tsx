// Desk health in one place: run state and the stop controls, the scheduler, today's spend and provider quota,
// and production errors (the watch desk). Replaces v2's separate Desk and Spend sheets.
import { deskStatus } from '../../../public/attention.js';
import { nameOf } from '../../../public/names.js';
import { S, api, ticketByKey, openTicket, loadSnapshot, toast } from '@/store.js';
import { ago, money } from '@/lib/format.js';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, SeatAvatar, StatTile, Section } from '@/components/desk/Bits';
import { Disclose } from '@/components/desk/Work';
import { cn } from '@/lib/utils';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const INC: Record<string, string> = { watching: 'Watching', investigating: 'Investigating', ticketed: 'Ticketed', paged: 'Paged you', foreign: 'Other project', muted: 'Muted', resolved: 'Resolved' };
const tname = (k: string) => nameOf(ticketByKey(k) || { title: k });

function Incident({ i }: { i: Row }) {
  const act = (label: string, action: string) => <AsyncButton variant="secondary" size="sm" run={() => api('POST', `/api/incidents/${i.id}`, { action })} ok={`${label}: done`}>{label}</AsyncButton>;
  return (
    <article className={cn('grid gap-2 rounded-lg border bg-card p-4', i.status === 'paged' && 'border-l-[3px] border-l-needs')}>
      <div className="flex flex-wrap items-center gap-2"><Tag tone={i.status === 'paged' ? 'needs' : 'neutral'}>{INC[i.status] || i.status}</Tag><b>{i.label}</b><span className="flex-1" /><span className="font-mono text-sm">{i.count}×</span></div>
      <p className="font-mono text-sm [overflow-wrap:anywhere]">{i.normalized}</p>
      <p className="text-sm text-muted-foreground">Last seen {ago(i.last_seen)}{i.ticket_key && <>; <button type="button" className="text-primary hover:underline" onClick={() => openTicket(i.ticket_key)}>{tname(i.ticket_key)}</button></>}</p>
      <div className="flex flex-wrap gap-2">{i.status === 'watching' && act('Investigate now', 'investigate')}{['watching', 'paged', 'foreign'].includes(i.status) && act('Mute', 'mute')}{i.status === 'muted' && act('Unmute', 'unmute')}</div>
    </article>
  );
}
function quotaText(p: Row) {
  const q = p.quota;
  if (!q) return ['Usage not reported. Unknown is not zero.'];
  const windows = q.windows || [['five_hour', 300], ['seven_day', 10080]].filter(([k]) => q[k as string] != null)
    .map(([k, dur]) => ({ remaining_percent: 100 - q[k as string] * 100, duration_minutes: dur, resets_at: q[`${k}_resets_at`] || (k === 'five_hour' ? q.resets_at : null) }));
  return windows.map((w: Row) => `${w.duration_minutes === 10080 ? 'Weekly' : w.duration_minutes === 300 ? '5-hour' : `${Math.round((w.duration_minutes || 0) / 60)} h`} window: ${Math.round(w.remaining_percent)}% left${w.resets_at ? `, resets ${new Date(w.resets_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`);
}

export default function DeskPage() {
  const ds = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting to the desk' } : deskStatus(S);
  const paused = S.settings.paused === 'true';
  const sc = S.meta.scheduler || {};
  const spend = Number(S.meta.spend_today) || 0, limit = Number(S.settings.daily_budget_usd) || 0;
  const seats = S.agents.filter((a: Row) => a.spend_today > 0).sort((a: Row, b: Row) => b.spend_today - a.spend_today);
  const live = S.incidents.filter((i: Row) => ['paged', 'investigating', 'watching'].includes(i.status));
  const quiet = S.incidents.filter((i: Row) => !['paged', 'investigating', 'watching'].includes(i.status));
  const dot = ({ green: 'bg-shipped', amber: 'bg-needs', red: 'bg-blocked' } as Record<string, string>)[ds.tone] || 'bg-muted-foreground';
  return (
    <div className="grid max-w-5xl gap-8">
      <section className="grid gap-4 rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center gap-3"><span aria-hidden className={cn('size-3 rounded-full', dot)} /><p className="text-2xl font-semibold">{ds.label}</p><p className="text-muted-foreground">{ds.detail}</p></div>
        <div className="flex flex-wrap gap-2">
          {paused ? <AsyncButton size="lg" run={async () => {
            try { await api('POST', '/api/control/start', {}); } catch (e) {
              if ((e as { code?: string }).code === 'confirm_team') { toast("Confirm each seat's engine and model in the Classic view first.", true); location.href = '/classic.html'; return false; }
              throw e;
            }
            await loadSnapshot();
          }} ok="Desk resumed; seats pick up work">Resume desk</AsyncButton>
            : <AsyncButton variant="secondary" size="lg" confirm={'Halt the desk?\n\nRunning work finishes; nothing new starts.'} run={async () => { await api('POST', '/api/control/pause', {}); await loadSnapshot(); }} ok="Desk halted; running work finishes">Halt desk</AsyncButton>}
          <AsyncButton variant="destructive" size="lg" confirm="Circuit breaker: halt the desk and stop every running seat now?" run={async () => { await api('POST', '/api/control/stop-all', {}); await loadSnapshot(); }} ok="Breaker tripped; every run stopped">Trip breaker</AsyncButton>
        </div>
        <p className="text-sm text-muted-foreground">Halt lets running work finish. The breaker stops every running seat immediately.</p>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Spent today" value={money(spend)} sub={`of ${money(limit)} (${limit ? Math.round((spend / limit) * 100) : 0}%)`} />
        <StatTile label="Running" value={`${S.meta.running || 0} of ${S.meta.capacity ?? '?'}`} sub={S.meta.busy_window ? 'Market-hours limit applies' : 'seats'} />
        <StatTile label="Queued" value={String(sc.queued ?? '?')} sub={sc.last_tick ? `Scheduler ran ${ago(sc.last_tick)}` : 'Scheduler has not run yet'} />
        <StatTile label="Budget headroom" value={money(Math.max(0, sc.budget_headroom || 0))} sub="after reserved run caps" />
      </div>
      {sc.last_error && <p className="rounded-md bg-blocked/15 px-3 py-2"><b>Last scheduler error</b>: {sc.last_error.seat || ''} {sc.last_error.message || String(sc.last_error)}</p>}
      {seats.length > 0 && <Section title="Spend by seat today"><div className="divide-y rounded-lg border bg-card">{seats.map((a: Row) => <div key={a.id} className="flex items-center gap-3 px-4 py-2.5"><SeatAvatar id={a.id} /><span className="flex-1">{a.name}</span><span className="font-mono">{money(a.spend_today)}</span></div>)}</div></Section>}
      <Section title="Providers" actions={<AsyncButton variant="secondary" size="sm" run={async () => { await api('POST', '/api/providers/refresh', {}); await loadSnapshot(); }} ok="Provider usage refreshed">Refresh usage</AsyncButton>}>
        <div className="grid gap-3 md:grid-cols-2">{(S.meta.providers || []).map((p: Row) => (
          <article key={p.id} className="grid gap-1.5 rounded-lg border bg-card p-4"><div className="flex items-center gap-2"><b className="flex-1">{p.label}</b><Tag tone={p.ready ? 'shipped' : p.available ? 'needs' : 'blocked'}>{p.ready ? 'Ready' : p.available ? 'On hold' : 'Unavailable'}</Tag></div>
            {p.reason && <p className="text-sm">{p.reason}</p>}{quotaText(p).map((x: string, i: number) => <p key={i} className="font-mono text-[13px]">{x}</p>)}{p.quota?.at && <p className="text-[13px] text-muted-foreground">Reported {ago(p.quota.at)}</p>}</article>))}</div>
        {S.meta.usage?.perplexity_desktop && <p className="text-sm">Perplexity desktop: {Math.floor(S.meta.usage.perplexity_desktop.credits_remaining).toLocaleString()} credits (observed {ago(S.meta.usage.perplexity_desktop.at)})</p>}
      </Section>
      <Section title="Production errors" count={live.length} tone="needs">
        {S.meta.watch?.enabled === false && <p className="text-muted-foreground">Log watching is off for this desk.</p>}
        {(S.meta.watch?.sources || []).filter((s: Row) => !s.ok || s.stale).map((s: Row, i: number) => <p key={i} className="text-sm text-blocked">{s.type}, {s.project}: {s.stale ? 'poll overdue' : s.error}</p>)}
        {live.length ? <div className="grid gap-2">{live.map((i: Row) => <Incident key={i.id} i={i} />)}</div> : S.meta.watch?.enabled === false ? null : <p className="text-muted-foreground">No active error signatures.</p>}
        {quiet.length > 0 && <Disclose id="quiet-incidents" summary={`${quiet.length} handled or muted`}><div className="grid gap-2">{quiet.map((i: Row) => <Incident key={i.id} i={i} />)}</div></Disclose>}
      </Section>
    </div>
  );
}
