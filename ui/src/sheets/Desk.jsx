import { useEffect, useRef, useState } from 'react';
import { deskStatus } from '../../../public/attention.js';
import { presenceOf } from '../../../public/avatars.js';
import { nameOf } from '../../../public/names.js';
import { S, api, agentMap, ticketByKey, closeSheet, openSheet, openTicket, loadSnapshot, toast } from '../store.js';
import { ago, hhmm, money } from '../lib/format.js';
import { Sheet, SheetHead, CloseButton, Chip, ChipGroup, Toggle, Field, Button, AsyncButton, Avatar, Disclosure, KeyTag } from '../kit/index.js';

const tname = (k) => nameOf(ticketByKey(k) || { title: k });

// ---------------- new ticket ----------------
const TYPES = [{ value: 'feature', label: 'Feature' }, { value: 'bug', label: 'Bug' }, { value: 'task', label: 'Task' }, { value: 'research', label: 'Research' }];
const PRIORITIES = [{ value: 'P0', label: 'P0', hint: 'drop everything' }, { value: 'P1', label: 'P1', hint: 'next' }, { value: 'P2', label: 'P2', hint: 'normal' }, { value: 'P3', label: 'P3', hint: 'someday' }];
const newDraft = { title: '', description: '', type: 'feature', priority: 'P2' }; // survives closing by accident
export function NewTicketSheet() {
  const [d, setD] = useState({ ...newDraft });
  const set = (patch) => setD((x) => { const n = { ...x, ...patch }; Object.assign(newDraft, n); return n; });
  return (
    <Sheet label="New ticket" onClose={closeSheet} head={<SheetHead title="New ticket" onClose={closeSheet} />}
      footer={<div className="f-actions"><span className="spacer" /><AsyncButton variant="primary" size="big" run={async () => {
        if (!d.title.trim()) throw new Error('A title is required.');
        const t = await api('POST', '/api/tickets', d);
        Object.assign(newDraft, { title: '', description: '', type: 'feature', priority: 'P2' });
        closeSheet(); openTicket(t.key);
      }} ok="Ticket created — support will triage it">Create ticket</AsyncButton></div>}>
      <Field label="Title" htmlFor="new-title"><input id="new-title" type="text" value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="What do you need?" maxLength={200} data-autofocus /></Field>
      <Field label="Description" htmlFor="new-description"><textarea id="new-description" rows={7} value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder="Context, links, acceptance criteria. Support triages and routes it." /></Field>
      <ChipGroup label="Type" options={TYPES} value={d.type} onChange={(type) => set({ type })} />
      <ChipGroup label="Priority" options={PRIORITIES} value={d.priority} onChange={(priority) => set({ priority })} />
    </Sheet>
  );
}

// ---------------- desk: status, halt/resume, breaker, incidents ----------------
const INC = { watching: 'Watching', investigating: 'Investigating', ticketed: 'Ticketed', paged: 'Paged you', foreign: 'Other project', muted: 'Muted', resolved: 'Resolved' };
function Incident({ i }) {
  const act = (label, action, variant) => <AsyncButton size="small" variant={variant} run={() => api('POST', `/api/incidents/${i.id}`, { action })} ok={`${label} — done`}>{label}</AsyncButton>;
  return (
    <article className={`inc s-${i.status}`}>
      <div className="dcard-top"><Chip tone={i.status === 'paged' ? 'amber' : ''}>{INC[i.status] || i.status}</Chip><b>{i.label}</b><span className="spacer" /><span className="mono small">{i.count}×</span></div>
      <p className="mono small wrap">{i.normalized}</p>
      <p className="muted small">Last seen {ago(i.last_seen)}{i.ticket_key && <> · <button className="linkish" type="button" onClick={() => openTicket(i.ticket_key)}>{tname(i.ticket_key)}</button></>}</p>
      <div className="row-actions">{i.status === 'watching' && act('Investigate now', 'investigate')}{['watching', 'paged', 'foreign'].includes(i.status) && act('Mute', 'mute')}{i.status === 'muted' && act('Unmute', 'unmute')}</div>
    </article>
  );
}
export function DeskSheet() {
  const ds = !S.connected ? { label: 'Offline', tone: 'red', detail: 'Reconnecting to the desk' } : deskStatus(S);
  const paused = S.settings.paused === 'true';
  const sc = S.meta.scheduler || {};
  const live = S.incidents.filter((i) => ['paged', 'investigating', 'watching'].includes(i.status));
  const quiet = S.incidents.filter((i) => !['paged', 'investigating', 'watching'].includes(i.status));
  return (
    <Sheet label="Desk" onClose={closeSheet} head={<SheetHead title="Desk" onClose={closeSheet} />}>
      <section className={`desk-status tone-${ds.tone}`}><p className="big"><i className="dot" aria-hidden="true" />{ds.label}</p><p className="muted">{ds.detail}</p></section>
      <div className="row-actions">
        {paused ? <AsyncButton variant="primary" data-autofocus run={async () => {
          try { await api('POST', '/api/control/start', {}); } catch (e) {
            if (e.code === 'confirm_team') { toast('Confirm each seat\'s engine and model in Classic view first.', true); location.href = '/classic.html'; return false; }
            throw e;
          }
        }} ok="Desk resumed — seats pick up work">Resume desk</AsyncButton>
          : <AsyncButton confirm={'Halt the desk?\n\nRunning work finishes; nothing new starts.'} run={() => api('POST', '/api/control/pause', {})} ok="Desk halted — running work finishes">Halt desk</AsyncButton>}
        <AsyncButton variant="danger" confirm="Circuit breaker: halt the desk and stop every running seat now?" run={() => api('POST', '/api/control/stop-all', {})} ok="Breaker tripped — every run stopped">Trip breaker</AsyncButton>
      </div>
      <p className="muted small">Halt lets running work finish. The breaker stops every running seat immediately.</p>
      <h3>Scheduler</h3>
      <div className="kv">
        <div className="kv-row"><span>Last tick</span>{sc.last_tick ? ago(sc.last_tick) : 'not yet'}</div>
        <div className="kv-row"><span>Running</span>{S.meta.running || 0} of {S.meta.capacity ?? '—'} seats{S.meta.busy_window ? ' · market-hours limit' : ''}</div>
        <div className="kv-row"><span>Queued</span>{String(sc.queued ?? '—')}</div>
        <div className="kv-row"><span>Budget headroom</span><span className="mono">{money(Math.max(0, sc.budget_headroom || 0))}</span></div>
        {sc.last_error && <div className="kv-row"><span>Last error</span><span className="red-t">{sc.last_error.seat || ''} {sc.last_error.message || String(sc.last_error)}</span></div>}
      </div>
      <h3>Production errors{live.length ? ` · ${live.length} active` : ''}</h3>
      {S.meta.watch?.enabled === false && <p className="muted">Log watching is off for this desk.</p>}
      {(S.meta.watch?.sources || []).filter((s) => !s.ok || s.stale).map((s, i) => <p key={i} className="red-t small">{s.type} · {s.project}: {s.stale ? 'poll overdue' : s.error}</p>)}
      {live.length ? <div className="stack">{live.map((i) => <Incident key={i.id} i={i} />)}</div> : S.meta.watch?.enabled === false ? null : <p className="muted">No active error signatures.</p>}
      {quiet.length > 0 && <Disclosure id="quiet-incidents" summary={`${quiet.length} handled or muted`}><div className="stack">{quiet.map((i) => <Incident key={i.id} i={i} />)}</div></Disclosure>}
    </Sheet>
  );
}

// ---------------- spend and quota ----------------
function quotaText(p) {
  const q = p.quota;
  if (!q) return ['Usage not reported. Unknown is not zero.'];
  const windows = q.windows || [['five_hour', 300], ['seven_day', 10080]].filter(([k]) => q[k] != null)
    .map(([k, dur]) => ({ remaining_percent: 100 - q[k] * 100, duration_minutes: dur, resets_at: q[`${k}_resets_at`] || (k === 'five_hour' ? q.resets_at : null) }));
  return windows.map((w) => `${w.duration_minutes === 10080 ? 'Weekly' : w.duration_minutes === 300 ? '5-hour' : `${Math.round((w.duration_minutes || 0) / 60)} h`} window: ${Math.round(w.remaining_percent)}% left${w.resets_at ? ` · resets ${new Date(w.resets_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`);
}
export function MoneySheet() {
  const spend = Number(S.meta.spend_today) || 0, limit = Number(S.settings.daily_budget_usd) || 0;
  const seats = S.agents.filter((a) => a.spend_today > 0).sort((a, b) => b.spend_today - a.spend_today);
  return (
    <Sheet label="Spend and quota" onClose={closeSheet} head={<SheetHead title="Spend and quota" onClose={closeSheet} />}>
      <p className="big mono">{money(spend)}<span className="muted"> of {money(limit)} today</span></p>
      <p className="muted small">{limit ? Math.round((spend / limit) * 100) : 0}% of the daily limit. Each running seat reserves its per-run cap. Change the limit in Settings.</p>
      {seats.length > 0 && <><h3>By seat today</h3><div className="kv">{seats.map((a) => <div key={a.id} className="kv-row"><span className="who"><Avatar id={a.id} />{a.name}</span><span className="mono">{money(a.spend_today)}</span></div>)}</div></>}
      <h3>Providers</h3>
      {(S.meta.providers || []).map((p) => (
        <article key={p.id} className="prov"><div className="dcard-top"><b>{p.label}</b><span className="spacer" /><Chip tone={p.ready ? 'green' : p.available ? 'amber' : 'red'}>{p.ready ? 'Ready' : p.available ? 'On hold' : 'Unavailable'}</Chip></div>
          {p.reason && <p className="small">{p.reason}</p>}{quotaText(p).map((x, i) => <p key={i} className="small mono">{x}</p>)}{p.quota?.at && <p className="muted small">Reported {ago(p.quota.at)}</p>}</article>
      ))}
      {S.meta.usage?.perplexity_desktop && <p className="small">Perplexity desktop: {Math.floor(S.meta.usage.perplexity_desktop.credits_remaining).toLocaleString()} credits (observed {ago(S.meta.usage.perplexity_desktop.at)})</p>}
      <div className="row-actions"><AsyncButton run={async () => { await api('POST', '/api/providers/refresh', {}); await loadSnapshot(); }} ok="Provider usage refreshed">Refresh provider usage</AsyncButton></div>
    </Sheet>
  );
}

// ---------------- settings ----------------
function NumberSetting({ k, label, help, step = 1 }) {
  const [v, setV] = useState(S.settings[k] ?? '');
  const saved = useRef(S.settings[k]);
  useEffect(() => { if (S.settings[k] !== saved.current) { saved.current = S.settings[k]; setV(S.settings[k] ?? ''); } });
  const save = async () => {
    if (String(v) === String(S.settings[k])) return;
    try { await api('POST', '/api/settings', { key: k, value: String(v) }); toast('Saved'); } catch (e) { toast(e.message, true); setV(S.settings[k] ?? ''); }
  };
  return (
    <label className="set"><span className="set-l"><b>{label}</b><span className="muted small">{help}</span></span>
      <input id={`set-${k}`} type="number" inputMode="decimal" min={k === 'daily_budget_usd' ? '0' : '1'} step={String(step)} value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /></label>
  );
}
function BoolSetting({ k, label, help }) {
  return <div className="set"><Toggle label={label} hint={help} checked={S.settings[k] === 'true'} onChange={async (on) => { try { await api('POST', '/api/settings', { key: k, value: String(on) }); toast('Saved'); } catch (e) { toast(e.message, true); } }} /></div>;
}
export function SettingsSheet() {
  const progs = S.meta.research?.programs || [];
  return (
    <Sheet label="Settings" onClose={closeSheet} head={<SheetHead title="Settings" onClose={closeSheet} />}>
      <h3>Limits</h3>
      <NumberSetting k="daily_budget_usd" label="Daily spend limit (USD)" help="Notional model spend per day." step={5} />
      <NumberSetting k="max_concurrent" label="Seats at once" help="A market-hours window in the config can lower this." />
      <BoolSetting k="auto_fallback" label="Provider fallback" help="When one provider is low or down, seats use the other. Limits and gates still apply." />
      <h3>Research</h3>
      <button type="button" className="set research-entry" onClick={() => openSheet({ type: 'research' })}>
        <span className="set-l"><b>Research programs</b><span className="muted small">{progs.length ? `${progs.filter((p) => p.enabled).length} of ${progs.length} running. Who researches, how often, and who checks their work.` : 'Who researches, how often, and who checks their work.'}</span></span>
        <span className="btn">Open</span>
      </button>
      <NumberSetting k="max_open_proposals" label="Proposals waiting at most" help="Research pauses while this many ideas wait for grooming." />
      <h3>GitHub</h3>
      <BoolSetting k="github_sync" label="Sync GitHub issues" help={`Mirror tickets and comments to ${S.meta.repo || 'GitHub'}.`} />
      <BoolSetting k="open_draft_prs" label="Open draft PRs" help="After QA, push the branch and open a draft PR. Nothing merges automatically." />
      <p className="muted small">Halt, resume and the breaker live under the Desk instrument in the header.</p>
      <h3>Team</h3>
      <ul className="seat-list">{S.agents.map((a) => { const r = S.meta.routing?.[a.id] || {}; return (
        <li key={a.id}><button type="button" className="idle-row" onClick={() => openSheet({ type: 'models', id: a.id })}><Avatar id={a.id} size="md" />
          <span className="seat-who"><b>{a.name}</b><span className="muted small">{a.role}</span></span><span className="spacer" />
          <span className="mono small">{a.enabled === false ? 'off' : `${r.engine || a.engine}${(r.model ?? a.model) ? ` · ${r.model ?? a.model}` : ''}`}</span></button></li>); })}</ul>
      <div className="row-actions"><a className="btn" href="/classic.html">Open Classic view</a><Button onClick={() => openSheet({ type: 'prs' })}>Pull requests</Button></div>
    </Sheet>
  );
}

// ---------------- seat ----------------
export function SeatSheet() {
  const seat = S.seat;
  const a = agentMap()[seat?.id];
  const logRef = useRef(null);
  const scrolled = useRef(false);
  useEffect(() => { if (logRef.current && seat?.events && !scrolled.current) { logRef.current.scrollTop = logRef.current.scrollHeight; scrolled.current = true; } });
  if (!a) return null;
  const pr = presenceOf(a);
  const run = a.current_run ? S.runs.find((r) => r.id === a.current_run) : null;
  const route = S.meta.routing?.[a.id] || {};
  const st = seat.stats;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const Tile = ({ label, v }) => <div className="tile"><span className="muted small">{label}</span><b className="mono">{v}</b></div>;
  return (
    <Sheet label={a.name} onClose={closeSheet} head={<div className="row"><Avatar id={a.id} size="xl" /><div className="seat-who"><h2>{a.name}</h2><span className="muted">{a.role}</span><span className="small">{pr.text}</span></div><span className="spacer" /><CloseButton onClose={closeSheet} /></div>}>
      {a.current_ticket && <button className="seat-ticket" type="button" onClick={() => openTicket(a.current_ticket)}><span>{tname(a.current_ticket)}</span><KeyTag k={a.current_ticket} /></button>}
      <p className="muted small">Runs on {route.engine || a.engine}{(route.model ?? a.model) ? ` · ${route.model ?? a.model}` : ''}{route.effort || a.effort ? ` · effort ${route.effort || a.effort}` : ''}{route.fallback ? ` · fallback: ${route.reason}` : ''}</p>
      {run && <div className="row-actions"><span className="mono small">{run.kind} run · {money(run.reserve_usd)} reserved</span><span className="spacer" />
        <AsyncButton variant="danger" confirm={`Stop ${a.name}'s current run?`} run={() => api('POST', `/api/runs/${run.id}/kill`, {})} ok="Stopping the run">Stop run</AsyncButton></div>}
      {st && <div className="tiles"><Tile label="Shipped" v={String(st.shipped)} /><Tile label="First-pass QA" v={pct(st.first_pass_rate)} /><Tile label="Runs" v={String(st.runs)} />
        <Tile label="Spend 7 d" v={money(st.cost_7d)} /><Tile label="Cost per shipped" v={st.cost_per_shipped == null ? '—' : money(st.cost_per_shipped)} /><Tile label="Today" v={money(a.spend_today)} /></div>}
      <Button onClick={() => openSheet({ type: 'models', id: a.id })}>Edit models & fallback</Button>
      <h3>Recent log</h3>
      {seat.events ? <div className="log mono seat-log" ref={logRef}>{seat.events.slice(-200).map((e, i) => <div key={e.id ?? i} className={`l-${e.kind}`}><span className="t">{hhmm(e.ts)}</span> {e.ticket_key && <span className="lk">{tname(e.ticket_key)} </span>}{e.text}</div>)}</div>
        : <p className="muted">Loading…</p>}
    </Sheet>
  );
}
