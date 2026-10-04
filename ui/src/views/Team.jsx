import { S, api, loadSnapshot, openSeat, openTicket, openSheet } from '../store.js';
import { Chip, Avatar, AsyncButton, Button } from '../kit/index.js';

export function Team() {
  const active = S.agents.filter((a) => a.status === 'working');
  const on = S.settings.auto_fallback === 'true';
  return (
    <>
      <div className="toolbar"><h1 className="page-h">Team</h1><span className="spacer" />
        <AsyncButton run={async () => { await api('POST', '/api/settings', { key: 'auto_fallback', value: on ? 'false' : 'true' }); await loadSnapshot(); }} ok="Fallback policy updated">Automatic fallback: {on ? 'on' : 'off'}</AsyncButton>
        <span className="muted">{active.length} working</span></div>
      <div className="grid-cards">{[...active, ...S.agents.filter((a) => a.status !== 'working')].map((a) => {
        const route = S.meta.routing?.[a.id] || {}, run = S.runs.find((r) => r.id === a.current_run);
        return (
          <article key={a.id} className="kcard team-model">
            <div className="row"><Avatar id={a.id} size="md" /><button className="title-btn" type="button" onClick={() => openSeat(a.id)}>{a.name}</button><span className="spacer" />
              <Chip>{a.enabled === false ? 'Off' : a.status === 'working' ? 'Working' : 'Available'}</Chip></div>
            <p className="muted small">{a.role}</p>
            <p className="small wrap">Preferred: {a.engine} · {a.model || 'Account default'}</p>
            <p className="small wrap">{run ? `Running: ${run.model}` : `Next run: ${route.engine || 'Waiting'} · ${route.model || route.reason || ''}`}</p>
            <p className="muted small wrap">Fallback: {a.fallbacks === undefined ? 'automatic compatible provider' : a.fallbacks.length ? a.fallbacks.map((p) => `${p.engine}/${p.model || 'default'}`).join(' → ') : 'wait for preferred provider'}</p>
            {route.fallback && <p className="muted small">{route.reason}</p>}
            {a.current_ticket && <Button variant="ghost" size="small" onClick={() => openTicket(a.current_ticket)}>View live conversation</Button>}
            <Button onClick={() => openSheet({ type: 'models', id: a.id })}>Edit models & fallback</Button>
          </article>
        );
      })}</div>
    </>
  );
}
