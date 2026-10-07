// Who acts, per action (sowmith95/sigmadesk#6): the server's matrix (meta.autonomy, src/autonomy-model.js) as Settings →
// Autonomy, and one ticket's summary line ("Build automatic · merge needs you (risk high) · prod read expires 14:30") with
// its expanded form in Details. Two dimensions, never merged: the AUTHORIZED MODE (what policy allows) and READINESS (can
// it act now, and if not, why, in order). Only controls that already have an owner write path are editable here; every
// other row says where it is set. Nothing here adds a capability.
import { useState } from 'react';
import { S, api, loadSnapshot, loadDetail, openSheet, toast } from '@/store.js';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { cn } from '@/lib/utils';
import type { Ticket } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const MODE: Record<string, [string, string]> = { 'human-led': ['Human-led', 'bg-secondary text-foreground'], assisted: ['Assisted', 'bg-needs/15 text-needs'], autonomous: ['Autonomous', 'bg-primary/15 text-primary'] };
const MODE_HINT: Record<string, string> = { 'human-led': 'you perform it', assisted: 'seats prepare, you authorize', autonomous: 'the desk executes within policy' };
export const hhmm = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const Chip = ({ mode }: { mode: string }) => { const [l, c] = MODE[mode] || [mode, 'bg-secondary']; return <span data-mode={mode} className={cn('inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-[13px] font-medium', c)}>{l}</span>; };

/** The control behind a row: an existing owner write path (a switch), or where it is set (read-only, said so). */
function Control({ a }: { a: any }) {
  const c = a.control || {};
  const [busy, setBusy] = useState(false);
  if (!c.editable) return <p className="text-[13px] text-muted-foreground" data-readonly>Read-only here. {c.text}</p>;
  const flip = async (on: boolean) => {
    setBusy(true);
    try {
      if (c.kind === 'setting') await api('POST', '/api/settings', { key: c.key, value: String(on) });
      else if (c.kind === 'policy') { const cur = await api('GET', '/api/access'); await api('POST', '/api/access/policy', { policy: { ...cur.policy, [c.key]: on } }); }
      await loadSnapshot(); toast('Saved; the gate re-reads it when it next acts');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return <label className="flex items-center gap-2 text-[13px] text-muted-foreground"><Switch checked={!!c.value} disabled={busy} aria-label={c.text} data-control={c.key} onCheckedChange={flip} /><span>{c.text}</span></label>;
}

/** Settings → Autonomy: one row per action. */
export function AutonomyMatrix() {
  const m = S.meta.autonomy;
  if (!m) return <p className="text-muted-foreground">Loading…</p>;
  return (
    <div className="grid gap-3" data-autonomy-matrix>
      <p className="text-[13px] text-muted-foreground">Per action, never per person. <b className="font-medium text-foreground">Mode</b> is what your policy and config allow ({Object.entries(MODE_HINT).map(([k, v], i) => <span key={k}>{i > 0 && '; '}{MODE[k][0].toLowerCase()}: {v}</span>)}). <b className="font-medium text-foreground">Now</b> is whether it can act at this moment. The gates re-check both when they act. Policy <span className="font-mono">{m.policy_version}</span>.</p>
      <div className="divide-y rounded-lg border bg-card">
        {m.actions.map((a: any) => (
          <section key={a.id} data-action={a.id} data-ready={a.readiness.state} className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] md:gap-x-6">
            <div className="grid content-start gap-1"><b className="font-medium">{a.label}</b><span className="text-[13px] text-muted-foreground">{a.scope}</span></div>
            <div className="grid min-w-0 gap-1.5">
              <div className="flex flex-wrap items-center gap-2"><Chip mode={a.mode} />
                <span className={cn('text-[13px] font-medium', a.readiness.state === 'blocked' ? 'text-blocked' : 'text-shipped')} data-readiness>{a.readiness.state === 'blocked' ? 'Blocked now' : 'Ready now'}</span>
                {a.grant && <span className="text-[13px] text-muted-foreground">{a.grant.seat_name} holds access{a.grant.expires_at ? ` until ${hhmm(a.grant.expires_at)}` : ''}</span>}</div>
              <p className="text-sm">{a.mode_text}</p>
              {a.waiver && <p className="rounded-md bg-needs/15 px-2 py-1 text-[13px]" data-waiver>{a.waiver}</p>}
              {a.readiness.reasons.length > 0 && <ol className="grid list-decimal gap-0.5 pl-5 text-[13px] text-blocked" data-reasons>{a.readiness.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ol>}
              <Control a={a} />
            </div>
          </section>))}
        {m.not_representable.map((n: any) => (
          <section key={n.id} data-not-representable={n.id} className="grid gap-1 px-4 py-3 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] md:gap-x-6">
            <b className="font-medium text-muted-foreground">{n.label}</b><p className="text-sm text-muted-foreground">Not representable. {n.text}</p></section>))}
      </div>
    </div>
  );
}

const lineText = (a: any) => (a?.items || []).map((i: any, n: number) => { const s = `${i.text}${i.until ? ` ${hhmm(i.until)}` : ''}`; return n === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s; }).join(' · ');

/** The ticket header's one line; tapping it opens Details. */
export function AutonomyLine({ a, onOpen }: { a: any; onOpen: () => void }) {
  if (!a?.items?.length) return null;
  return <button type="button" data-autonomy-line onClick={onOpen} className="min-w-0 text-left text-[13px] line-clamp-2 text-muted-foreground hover:text-foreground" title="Who acts on this ticket (Details)">{lineText(a)}</button>;
}

/** Details → Who acts: each item with why, and the per-ticket controls that already exist. */
export function TicketAutonomy({ t, a }: { t: Ticket; a: any }) {
  if (!a) return null;
  const refresh = async () => { await loadSnapshot().catch(() => {}); await loadDetail(); };
  const canHold = t.status === 'ready_for_human' && !!t.pr_url;
  const canTake = ['triage', 'proposed', 'todo', 'needs_human'].includes(t.status) && !t.head_sha && !t.pr_url && !t.owner_task && !(Number(t.active_run) > 0);
  return (
    <section className="grid gap-3 rounded-lg border bg-card p-4" data-ticket-autonomy>
      <h3 className="font-semibold">Who acts</h3>
      <ul className="grid gap-2">{a.items.map((i: any) => <li key={i.id} data-autonomy-item={i.id} className="grid gap-0.5 text-sm">
        <span className="flex flex-wrap items-center gap-2">{i.mode && <Chip mode={i.mode} />}<b className="font-medium">{i.text}{i.until ? ` ${hhmm(i.until)}` : ''}</b></span>
        {i.reason && <span className="text-muted-foreground">{i.reason}</span>}{i.blocked && <span className="text-blocked">Blocked now: {i.blocked}</span>}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        {canHold && (t.merge_hold ? <AsyncButton variant="secondary" run={async () => { await api('POST', `/api/tickets/${t.key}/merge-hold`, { hold: false }); await refresh(); }} ok="Released; the desk merges it when every check passes">Release the hold</AsyncButton>
          : <AsyncButton variant="secondary" run={async () => { const why = window.prompt('Hold the merge. Why? (optional)', ''); if (why == null) return false; await api('POST', `/api/tickets/${t.key}/merge-hold`, { hold: true, reason: why }); await refresh(); }} ok="On hold: nothing merges it until you release it">Hold the merge</AsyncButton>)}
        {canTake && <AsyncButton variant="secondary" confirm={`Take ${t.key} yourself? No engineer picks it up; the tasks after it wait until you mark it done.`} run={async () => { await api('POST', `/api/tickets/${t.key}/owner-task`, { owner_task: true }); await refresh(); }} ok="It is your task now">Take ownership</AsyncButton>}
        <Button variant="ghost" onClick={() => openSheet({ type: 'access' })}>Scoped production access</Button>
      </div>
      <p className="text-[13px] text-muted-foreground">Desk-wide rules are in Settings → Autonomy. Policy <span className="font-mono">{a.policy_version}</span>.</p>
    </section>
  );
}
