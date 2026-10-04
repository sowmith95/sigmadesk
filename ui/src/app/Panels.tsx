// Secondary panels and the new-ticket dialog: seat, models per seat, new ticket.
import { useEffect, useRef, useState } from 'react';
import { presenceOf } from '../../../public/avatars.js';
import { nameOf } from '../../../public/names.js';
import { S, api, agentMap, ticketByKey, closeSheet, openSheet, openTicket, openSeat, loadSnapshot } from '@/store.js';
import { hhmm, money } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Panel } from '@/components/desk/Panel';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { ChoiceChips } from '@/components/desk/Choices';
import { Field, SwitchRow } from '@/components/desk/Fields';
import { SeatAvatar, StatTile, Key } from '@/components/desk/Bits';
import type { Agent } from '@/types';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tname = (k: string) => nameOf(ticketByKey(k) || { title: k });

// ---------------- new ticket ----------------
const TYPES = [{ value: 'feature', label: 'Feature' }, { value: 'bug', label: 'Bug' }, { value: 'task', label: 'Task' }, { value: 'research', label: 'Research' }];
const PRIORITIES = [{ value: 'P0', label: 'P0', hint: 'drop everything' }, { value: 'P1', label: 'P1', hint: 'next' }, { value: 'P2', label: 'P2', hint: 'normal' }, { value: 'P3', label: 'P3', hint: 'someday' }];
const newDraft = { title: '', description: '', type: 'feature', priority: 'P2' }; // survives closing by accident
export function NewTicketDialog() {
  const [d, setD] = useState({ ...newDraft });
  const set = (patch: Partial<typeof newDraft>) => setD((x) => { const n = { ...x, ...patch }; Object.assign(newDraft, n); return n; });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeSheet(); }}>
      <DialogContent className="max-h-[92dvh] gap-5 overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>New ticket</DialogTitle><DialogDescription>Support triages it and routes it to the right seat.</DialogDescription></DialogHeader>
        <Field label="Title" id="new-title">{({ id }) => <Input id={id} data-autofocus autoFocus value={d.title} maxLength={200} placeholder="What do you need?" onChange={(e) => set({ title: e.target.value })} />}</Field>
        <Field label="Description" id="new-description">{({ id }) => <Textarea id={id} rows={6} value={d.description} placeholder="Context, links, acceptance criteria." onChange={(e) => set({ description: e.target.value })} />}</Field>
        <ChoiceChips label="Type" options={TYPES} value={d.type} onChange={(type) => set({ type })} />
        <ChoiceChips label="Priority" options={PRIORITIES} value={d.priority} onChange={(priority) => set({ priority })} />
        <DialogFooter><Button variant="ghost" onClick={closeSheet}>Cancel</Button>
          <AsyncButton run={async () => {
            if (!d.title.trim()) throw new Error('A title is required.');
            const t = await api('POST', '/api/tickets', d);
            Object.assign(newDraft, { title: '', description: '', type: 'feature', priority: 'P2' });
            closeSheet(); openTicket(t.key);
          }} ok="Ticket created; support will triage it">Create ticket</AsyncButton></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- seat ----------------
export function SeatPanel() {
  const seat = S.seat;
  const a = seat ? (agentMap()[seat.id] as Agent | undefined) : undefined;
  const log = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  useEffect(() => { if (log.current && seat?.events && !scrolled.current) { log.current.scrollTop = log.current.scrollHeight; scrolled.current = true; } });
  if (!a || !seat) return null;
  const pr = presenceOf(a);
  const run = a.current_run ? S.runs.find((r: Row) => r.id === a.current_run) : null;
  const route = S.meta.routing?.[a.id] || {};
  const st = seat.stats;
  const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
  return (
    <Panel title={a.name} head={<div className="flex items-center gap-3"><SeatAvatar id={a.id} size="lg" /><span className="text-sm text-muted-foreground">{a.role}. {pr.text}.</span></div>} onClose={closeSheet}>
      {a.current_ticket && <button type="button" onClick={() => openTicket(a.current_ticket!)} className="flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left hover:bg-secondary"><b>{tname(a.current_ticket)}</b><Key k={a.current_ticket} /></button>}
      <p className="text-sm text-muted-foreground">Runs on {route.engine || a.engine}{(route.model ?? a.model) ? `, ${route.model ?? a.model}` : ''}{route.effort || a.effort ? `, effort ${route.effort || a.effort}` : ''}{route.fallback ? `; fallback: ${route.reason}` : ''}</p>
      {run && <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3"><span className="font-mono text-sm">{run.kind} run, {money(run.reserve_usd)} reserved</span><span className="flex-1" />
        <AsyncButton variant="destructive" size="sm" confirm={`Stop ${a.name}'s current run?`} run={() => api('POST', `/api/runs/${run.id}/kill`, {})} ok="Stopping the run">Stop run</AsyncButton></div>}
      {st && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3"><StatTile label="Shipped or awaiting you" value={String(st.shipped)} /><StatTile label="First-pass QA" value={pct(st.first_pass_rate)} /><StatTile label="Runs" value={String(st.runs)} />
        <StatTile label="Spend, 7 days" value={money(st.cost_7d)} /><StatTile label="Cost per shipped" value={st.cost_per_shipped == null ? 'n/a' : money(st.cost_per_shipped)} /><StatTile label="Today" value={money(a.spend_today)} /></div>}
      <Button variant="secondary" className="justify-self-start" onClick={() => openSheet({ type: 'models', id: a.id })}>Models & fallback</Button>
      <h3 className="font-semibold">Recent log</h3>
      {seat.events ? <div ref={log} className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
        {seat.events.slice(-200).map((e: Row, i: number) => <div key={e.id ?? i} className={e.kind === 'error' ? 'text-blocked' : e.kind === 'done' ? 'text-shipped' : ['say', 'action'].includes(e.kind) ? 'text-foreground' : ''}><span className="opacity-70">{hhmm(e.ts)}</span> {e.ticket_key && <span className="text-foreground">{tname(e.ticket_key)} </span>}{e.text}</div>)}</div>
        : <p className="text-muted-foreground">Loading…</p>}
    </Panel>
  );
}

// ---------------- models per seat ----------------
const POLICIES = [{ value: 'automatic', label: 'Automatic', hint: 'any compatible provider' }, { value: 'custom', label: 'My order' }, { value: 'off', label: 'Wait', hint: 'for the preferred provider' }];
type Profile = { engine: string; model: string; effort: string };
function ProfileEditor({ title, p, onChange, catalog, seatId }: { title: string; p: Profile; onChange: (p: Profile) => void; catalog: Row; seatId: string }) {
  const allowed: string[] = catalog.seats.find((s: Row) => s.id === seatId)?.supported_engines || ['claude', 'codex'];
  const engines: Row[] = catalog.engines.filter((e: Row) => allowed.includes(e.id));
  const engine = engines.find((e) => e.id === p.engine);
  const models: Row[] = engine?.models || [];
  const health = (S.meta.providers || []).find((x: Row) => x.id === p.engine);
  const relayHeld = p.engine === 'perplexity' && !(S.meta.providers || []).find((x: Row) => x.id === 'claude')?.ready;
  const efforts: string[] = models.find((m) => m.id === p.model)?.efforts || engine?.efforts || [];
  const setEngine = (v: string) => onChange({ ...p, engine: v, ...(catalog.seats.find((s: Row) => s.id === seatId)?.suggestions[v] || { model: catalog.engines.find((e: Row) => e.id === v)?.models[0]?.id || '', effort: 'medium' }) });
  const setModel = (v: string) => { const e: string[] = models.find((m) => m.id === v)?.efforts || engine?.efforts || []; onChange({ ...p, model: v, effort: e.includes(p.effort) ? p.effort : e.includes('high') ? 'high' : e[0] }); };
  return (
    <fieldset className="grid gap-4 rounded-lg border bg-card p-4"><legend className="px-1 font-semibold">{title}</legend>
      <ChoiceChips label={`${title} provider`} options={engines.map((e) => ({ value: e.id, label: e.label, hint: e.available ? null : 'unavailable' }))} value={p.engine} onChange={setEngine} />
      <Field label={`${title} model`}>{({ id }) => <select id={id} value={p.model} onChange={(e) => setModel(e.target.value)} className="h-10 rounded-md border border-input bg-background px-2">
        {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id || m.note || 'Account default'}</option>)}</select>}</Field>
      {efforts.length > 0 && <ChoiceChips label={`${title} reasoning effort`} size="sm" options={efforts.map((e) => ({ value: e, label: e }))} value={p.effort} onChange={(effort) => onChange({ ...p, effort })} />}
      <p className="text-sm" role="status">{health?.ready ? (relayHeld ? 'Connected; waiting for an available Claude relay' : 'Provider ready') : health?.reason || 'Provider status unavailable'}</p>
      <p className="text-[13px] text-muted-foreground">{models.find((m) => m.id === p.model)?.note || engine?.costs || ''}</p>
      {p.engine === 'perplexity' && <p className="text-[13px] text-muted-foreground">Thinking roles only. Uses Perplexity credits plus a local Claude relay; both must be available.</p>}
    </fieldset>
  );
}
export function ModelsPanel({ id }: { id: string }) {
  const a = agentMap()[id] as Agent;
  const [catalog, setCatalog] = useState<Row | null>(null);
  const [error, setError] = useState('');
  const [d, setD] = useState(() => ({ engine: a.engine || 'claude', model: a.model || '', effort: a.effort || 'medium', enabled: a.enabled !== false,
    mode: a.fallbacks === undefined ? 'automatic' : a.fallbacks.length ? 'custom' : 'off', fallbacks: structuredClone(a.fallbacks || []) as Profile[] }));
  useEffect(() => { api('GET', '/api/engines').then(setCatalog).catch((e: Error) => setError(e.message)); }, []);
  const running = S.runs.find((r: Row) => r.id === a.current_run);
  const setMode = (mode: string) => {
    const next = { ...d, mode };
    if (mode === 'custom' && !d.fallbacks.length && catalog) { const alt = catalog.engines.find((e: Row) => e.id !== d.engine && e.id !== 'perplexity'); if (alt) next.fallbacks = [{ engine: alt.id, ...catalog.seats.find((s: Row) => s.id === a.id)?.suggestions[alt.id] }]; }
    setD(next);
  };
  return (
    <Panel title={`${a.name}: models`} description={a.role} onClose={closeSheet}
      footer={catalog && <div className="flex justify-end"><AsyncButton size="lg" run={async () => {
        if (d.mode === 'custom' && !d.fallbacks.length) throw new Error('Add a fallback or choose another policy.');
        await api('POST', '/api/team', { seats: { [a.id]: { engine: d.engine, model: d.model, effort: d.effort, enabled: d.enabled, fallback_mode: d.mode, ...(d.mode === 'automatic' ? {} : { fallbacks: d.mode === 'off' ? [] : d.fallbacks }) } } });
        await loadSnapshot(); openSeat(a.id);
      }} ok="Model preferences saved for the next run">Save models</AsyncButton></div>}>
      {!catalog ? <p className="text-muted-foreground">{error || 'Loading installed providers and model catalogs…'}</p> : <>
        <p>{running ? `Current run: ${running.model}. Saved changes apply to the next run.` : 'Changes apply to the next run.'}</p>
        <div className="rounded-lg border bg-card p-4"><SwitchRow label="Seat enabled" hint="An off seat takes no new work." checked={d.enabled} onChange={(enabled) => setD({ ...d, enabled })} /></div>
        <ProfileEditor title="Preferred" p={d} catalog={catalog} seatId={a.id} onChange={(p) => setD({ ...d, engine: p.engine, model: p.model, effort: p.effort })} />
        <ChoiceChips label="When the preferred provider is unavailable" options={POLICIES} value={d.mode} onChange={setMode} />
        {d.mode === 'custom' && d.fallbacks.map((p, i) => <div key={i} className="grid gap-2"><ProfileEditor title={`Fallback ${i + 1}`} p={p} catalog={catalog} seatId={a.id} onChange={(np) => setD({ ...d, fallbacks: d.fallbacks.map((x, j) => (j === i ? np : x)) })} />
          <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setD({ ...d, fallbacks: d.fallbacks.filter((_, j) => j !== i) })}>Remove fallback</Button></div>)}
        {d.mode === 'custom' && d.fallbacks.length < 3 && <Button variant="secondary" className="justify-self-start" onClick={() => setD({ ...d, fallbacks: [...d.fallbacks, { engine: 'codex', model: '', effort: 'medium' }] })}>Add fallback</Button>}
        <p className="text-sm text-muted-foreground">Provider quota holds apply to all its models. If every compatible provider is unavailable, work waits and keeps its state.</p>
        {S.settings.auto_fallback !== 'true' && <p className="text-sm text-needs">Automatic fallback is globally off. Turn it on from Team to use these backups.</p>}
      </>}
    </Panel>
  );
}
