import { presenceOf } from '../../../public/avatars.js';
import { S, api, loadSnapshot, openSeat, openTicket, openSheet } from '@/store.js';
import { money } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Tag, SeatAvatar } from '@/components/desk/Bits';
import { SwitchRow } from '@/components/desk/Fields';
import { toast } from '@/store.js';
import { TeamStats } from '@/components/desk/TeamStats';
import { Lessons } from '@/components/desk/Lessons';
import { TeamOverviewSection } from '@/components/team/Departments';
import type { Agent, Run } from '@/types';

export function TeamPage() {
  const agents = S.agents as Agent[];
  const working = agents.filter((a) => a.status === 'working');
  const ordered = [...working, ...agents.filter((a) => a.status !== 'working')];
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3">
        <p className="text-muted-foreground"><b className="font-mono text-foreground">{working.length}</b> of {agents.length} seats working</p>
        <span className="flex-1" />
        <div className="w-full sm:w-auto sm:min-w-72"><SwitchRow label="Automatic fallback" hint="When a provider is low or down, seats use another. Limits and gates still apply." checked={S.settings.auto_fallback === 'true'}
          onChange={async (on) => { try { await api('POST', '/api/settings', { key: 'auto_fallback', value: String(on) }); await loadSnapshot(); toast('Fallback policy updated'); } catch (e) { toast((e as Error).message, true); } }} /></div>
      </div>
      <TeamOverviewSection />
      <TeamStats />
      <Lessons />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {ordered.map((a) => {
          const route = S.meta.routing?.[a.id] || {};
          const run = (S.runs as Run[]).find((r) => r.id === a.current_run);
          const pr = presenceOf(a);
          return (
            <article key={a.id} className="grid content-start gap-3 rounded-lg border bg-card p-4">
              <div className="flex items-center gap-3">
                <SeatAvatar id={a.id} size="lg" />
                <div className="grid min-w-0 flex-1"><button type="button" className="truncate text-left font-semibold hover:underline" onClick={() => openSeat(a.id)}>{a.name}</button><span className="truncate text-sm text-muted-foreground">{a.role}</span></div>
                <Tag tone={a.enabled === false ? 'neutral' : a.status === 'working' ? 'action' : 'neutral'}>{a.enabled === false ? 'Off' : pr.text}</Tag>
              </div>
              <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Prefers</dt><dd className="[overflow-wrap:anywhere]">{a.engine}, {a.model || 'account default'}</dd>
                <dt className="text-muted-foreground">{run ? 'Running' : 'Next run'}</dt><dd className="[overflow-wrap:anywhere]">{run ? run.model : `${route.engine || 'waiting'}${route.model ? `, ${route.model}` : route.reason ? `: ${route.reason}` : ''}`}</dd>
                <dt className="text-muted-foreground">Fallback</dt><dd>{a.fallbacks === undefined ? 'automatic' : a.fallbacks.length ? a.fallbacks.map((p) => `${p.engine}/${p.model || 'default'}`).join(' then ') : 'wait for preferred'}</dd>
                {Number(a.spend_today) > 0 && <><dt className="text-muted-foreground">Today</dt><dd className="font-mono">{money(a.spend_today)}</dd></>}
              </dl>
              <div className="flex flex-wrap gap-2">
                {a.current_ticket && <Button variant="secondary" size="sm" onClick={() => openTicket(a.current_ticket!)}>View live work</Button>}
                <Button variant="outline" size="sm" onClick={() => openSheet({ type: 'models', id: a.id })}>Models & fallback</Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
