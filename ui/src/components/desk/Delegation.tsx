// Delegation (sowmith95/sigmadesk#9) on screen: what Morgan or Devon decided for you ("Decided for you", with Override
// and Reopen), what they would decide (shadow) or why they left a decision to you, and the controls in Settings →
// Autonomy. Everything shown comes from the server's records (meta.delegation, /api/delegation); Override and Reopen are
// the owner's own endpoints. Nothing here applies a decision.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { S, api, loadSnapshot, openTicket, toast } from '@/store.js';
import { ago, clean, money } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from './AsyncButton';
import { SwitchRow } from './Fields';
import { ChoiceChips } from './Choices';
import { cn } from '@/lib/utils';
import type { BoardItem } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rec = Record<string, any>;
const first = (id?: string | null) => String(S.agents.find((a: { id: string }) => a.id === id)?.name || id || '').split(/\s+/)[0];
const MODE_LABEL = (m: string) => ({ owner: 'You decide', shadow: 'Shadow', em: `${first('manager')} decides`, sre: `${first('sre')} decides` } as Record<string, string>)[m] || m;
const STATUS: Record<string, [string, string]> = { overridden: ['Overridden', 'text-needs'], reopened: ['Reopened', 'text-needs'], applied: ['Decided', 'text-shipped'] };

/**
 * On an open decision: what the delegate would decide (shadow: you still decide) or why it is yours (an escalation, with
 * the delegate's one-line recommendation when it gave one).
 */
export function DelegateNote({ it, className }: { it: BoardItem & { delegate?: Rec; escalation?: Rec }; className?: string }) {
  const r = it.delegate || it.escalation;
  if (!r) return null;
  const shadow = r.status === 'shadow';
  return (
    <div data-delegate-note={r.status} className={cn('grid gap-0.5 rounded-md bg-secondary/60 px-3 py-2 text-sm', className)}>
      <p className="[overflow-wrap:anywhere]"><b className="font-medium">{shadow ? `${r.seat_name} would decide: ` : `${r.seat_name} left this for you: `}</b>
        {shadow ? clean(r.text) : clean(r.why)}</p>
      {shadow && r.why && <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">Why: {clean(r.why)}</p>}
      {!shadow && r.recommendation && <p className="[overflow-wrap:anywhere]"><span className="text-muted-foreground">Recommends: </span>{clean(r.recommendation)}</p>}
      <p className="text-[13px] text-muted-foreground">{shadow ? 'Shadow mode: nothing was changed, and you still decide.' : 'Nothing was changed: the decision is yours.'}</p>
    </div>
  );
}

/** What a delegated decision was based on (the brief the owner saw), fetched when opened. */
function BasedOn({ id }: { id: number }) {
  const [rec, setRec] = useState<Rec | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api('GET', `/api/delegation/${id}`).then(setRec).catch((e) => setError((e as Error).message)); }, [id]);
  if (error) return <p className="text-sm text-blocked">Could not load it: {error}</p>;
  if (!rec) return <p className="text-sm text-muted-foreground">Loading what it was based on…</p>;
  const b = rec.brief || {};
  const p = rec.provenance || {};
  return (
    <div className="grid gap-1 text-sm" data-based-on>
      {b.you_decide && <p><span className="text-muted-foreground">The decision: </span>{b.you_decide}</p>}
      {b.gate?.headline && <p><span className="text-muted-foreground">Its gate then: </span>{b.gate.headline}</p>}
      {rec.why && <p className="[overflow-wrap:anywhere]"><span className="text-muted-foreground">{rec.seat_name}'s reason: </span>{clean(rec.why)}</p>}
      {rec.cited?.length > 0 && <p className="[overflow-wrap:anywhere]" data-cited><span className="text-muted-foreground">It cited: </span>
        {rec.cited.map((c: Rec) => `${c.id}${c.text ? ` (${clean(c.text).slice(0, 90)})` : ''}`).join('; ')}</p>}
      <p className="text-[13px] text-muted-foreground">Decided for you by {rec.seat_name}{p.deterministic ? ' by rule (no model run)' : p.model ? ` on ${p.model}` : ''}{rec.runs ? ` · ${rec.runs} run${rec.runs === 1 ? '' : 's'}, ${money(rec.spent_usd)}${rec.estimated_runs ? ' (estimated)' : ''}` : ''} · policy <span className="font-mono">{rec.policy_version}</span> · delegation <span className="font-mono">{rec.delegation_version}</span></p>
    </div>
  );
}

/**
 * One decision in "Decided for you". Collapsed it is two lines at any width: what was decided (one truncated line) and
 * its status, time, kind and ticket (one truncated line, the ticket last so a long title is what gets cut). Expanding
 * shows the full text, the ticket, what it was based on, and Override / Reopen.
 */
function DecidedRow({ r }: { r: Rec }) {
  const [open, setOpen] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [text, setText] = useState('');
  const t = r.ticket;
  const done = r.status !== 'applied';
  const [label, tone] = STATUS[r.status] || [r.status, 'text-muted-foreground'];
  const refresh = () => loadSnapshot().catch(() => {});
  const line = clean(r.line);
  return (
    <article data-decided={r.id} data-status={r.status} className="grid grid-cols-[minmax(0,1fr)] gap-2 px-3 py-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} title={line}
        className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 rounded text-left hover:bg-secondary/40">
        <span className="row-span-2 grid size-5 place-items-center text-muted-foreground" aria-hidden>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</span>
        <span data-decided-title className="min-w-0 truncate text-[15px] font-medium">{line}</span>
        <span data-decided-meta className="min-w-0 truncate whitespace-nowrap text-[13px] text-muted-foreground">
          {done && <span className={cn('font-medium', tone)}>{label} · </span>}{[ago(r.decided_at || r.created_at), r.kind_label, t ? t.name || t.title : null].filter(Boolean).join(' · ')}
        </span>
      </button>
      {open && <div className="grid gap-2 pl-7" data-decided-detail>
        <p className="text-sm [overflow-wrap:anywhere]">{r.text ? <><span className="text-muted-foreground">{r.seat_name}'s {r.action === 'answer' ? 'answer' : r.action === 'route' ? 'routing' : 'decision'}: </span>{clean(r.text)}</> : line}</p>
        {t && <button type="button" className="justify-self-start text-sm text-foreground underline-offset-2 hover:underline [overflow-wrap:anywhere]" onClick={() => openTicket(t.key)}>Open {t.key}: {t.name || t.title}</button>}
        <BasedOn id={r.id} />
        {!done && !overriding && <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setOverriding(true)}>Override</Button>
          <AsyncButton variant="ghost" size="sm" confirm={`Reopen this decision? It comes back to you to decide again. Nothing that already happened is undone.`}
            run={async () => { await api('POST', `/api/delegation/${r.id}/reopen`, {}); await refresh(); }} ok="Reopened: it is your decision again">Reopen</AsyncButton>
        </div>}
        {overriding && <div className="grid gap-2">
          <label htmlFor={`override-${r.id}`} className="text-sm font-medium">Your decision instead</label>
          <Textarea id={`override-${r.id}`} value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="What should the team do instead? It is posted on the ticket as yours." />
          <div className="flex flex-wrap gap-2">
            <AsyncButton size="sm" disabled={text.trim().length < 2} run={async () => { await api('POST', `/api/delegation/${r.id}/override`, { message: text }); setOverriding(false); setText(''); await refresh(); }} ok="Posted on the ticket as your decision">Post my decision</AsyncButton>
            <Button variant="ghost" size="sm" onClick={() => { setOverriding(false); setText(''); }}>Cancel</Button>
          </div>
        </div>}
      </div>}
    </article>
  );
}

/** Inbox → "Decided for you": the last 24 hours, newest first. Not counted as needing you. */
export function DecidedLane({ rows }: { rows: Rec[] }) {
  const [open, setOpen] = useState(true);
  if (!rows.length) return null;
  return (
    <section aria-label="Decided for you" data-lane="decided" className="grid gap-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-baseline gap-2 text-left">
        {open ? <ChevronDown className="size-4 self-center" aria-hidden /> : <ChevronRight className="size-4 self-center" aria-hidden />}
        <b className="shrink-0 whitespace-nowrap">Decided for you</b><span className="font-mono text-sm text-muted-foreground">{rows.length}</span>
        <span className="min-w-0 truncate text-[13px] text-muted-foreground max-md:hidden">What {first('manager')} and {first('sre')} decided in the last 24 hours. Override or reopen anything.</span>
      </button>
      {open && <div className="grid grid-cols-[minmax(0,1fr)] divide-y overflow-hidden rounded-lg border bg-card">{rows.map((r) => <DecidedRow key={r.id} r={r} />)}</div>}
    </section>
  );
}

const kindLine = (m: Rec | undefined) => {
  if (!m) return '';
  const bits = [m.avoided ? `${m.avoided} decided for you` : null, m.overridden ? `${m.overridden} overridden` : null, m.reopened ? `${m.reopened} reopened` : null,
    m.escalated ? `${m.escalated} left for you` : null, m.shadow ? `${m.shadow} in shadow` : null, m.spend_usd ? money(m.spend_usd) : null].filter(Boolean);
  return bits.length ? `Last 7 days: ${bits.join(' · ')}` : 'Nothing in the last 7 days.';
};

/** Settings → Autonomy: who decides each kind of decision, the emergency switch, peer access and what it cost. */
export function DelegationSettings() {
  const [d, setD] = useState<Rec | null>(null);
  const [busy, setBusy] = useState(false);
  const v = S.meta.delegation?.version;
  const rulesNow = S.meta.delegation?.rules?.hash; // the playbook's rules, from every snapshot: an edit there refreshes this
  useEffect(() => { api('GET', '/api/delegation').then(setD).catch(() => setD(null)); }, [v, rulesNow]);
  if (!d) return <p className="text-muted-foreground">Loading delegation…</p>;
  const save = async (patch: { kinds?: Record<string, string>; peerAccess?: boolean }) => {
    setBusy(true);
    try {
      const kinds = Object.fromEntries(d.kinds.map((k: Rec) => [k.id, k.configured]));
      const next = await api('POST', '/api/delegation/policy', { policy: { kinds: { ...kinds, ...(patch.kinds || {}) }, peerAccess: patch.peerAccess ?? d.peer_access } });
      setD({ ...next, metrics: d.metrics }); await loadSnapshot(); toast('Saved; decisions in progress came back to you');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const escalate = async (on: boolean) => {
    if (on && !window.confirm('Escalate everything? Every decision comes to you from now on, and decisions in progress stop at once.')) return;
    setBusy(true);
    try { const next = await api('POST', '/api/delegation/escalate-all', { on }); setD({ ...next, metrics: d.metrics }); await loadSnapshot(); toast(on ? 'Every decision is yours now' : 'Delegation follows your settings again'); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const m = d.metrics || {};
  const locked = !d.enabled || d.escalate_all;
  return (
    <div className="grid gap-3" data-delegation>
      <p className="text-[13px] text-muted-foreground">Who makes each kind of decision for you. <b className="font-medium text-foreground">Shadow</b>: {first('manager')} or {first('sre')} decides, you see it on the decision, and you still decide. When they decide for you, it is posted on the ticket as theirs and you can override or reopen it from the Inbox.</p>
      <div data-standing-rules={d.rules?.count ?? 0} className={cn('grid gap-1 text-[13px] [overflow-wrap:anywhere]', d.rules?.count ? 'text-muted-foreground' : 'text-needs')}>
        {d.rules?.count
          ? <p>They decide for you only under the {d.rules.count === 1 ? 'standing rule' : `${d.rules.count} standing rules`} the desk found in your playbook under “{d.rules.section}”, and each decision must cite one, with evidence from the decision’s brief. The desk checks that what they cite is your rule and was in the brief; whether the rule fits the decision is their judgment, so keep rules narrow.</p>
          : <p>The desk found no standing rules in your playbook, so nothing below is decided for you by judgment: those decisions all come to you. It reads them as dash bullets right under a “## {d.rules?.section || 'Standing rules the EM may apply alone'}” heading, and stops at the first line of another kind (code, HTML, a comment, a numbered list or a new paragraph). Owner tasks are the exception: a step filed as a check or a package is routed by rule, without any standing rule.</p>}
        <p className="text-muted-foreground">Override and Reopen let you decide again, but they cannot undo what the team already did after a decision.</p>
      </div>
      <div className="divide-y rounded-lg border bg-card px-4">
        <div className="py-3"><SwitchRow label="Escalate everything" checked={!!d.escalate_all} disabled={busy || !d.enabled} onChange={escalate}
          hint={d.escalate_all ? 'On: every decision is yours, whatever is set below.' : 'Emergency switch: every decision comes to you, and decisions in progress stop at once.'} /></div>
        {!d.enabled && <p className="py-3 text-sm text-blocked">Switched off in the config (delegation.enabled): every decision is yours.</p>}
        {d.kinds.map((k: Rec) => (
          <section key={k.id} data-delegation-kind={k.id} data-mode={k.mode} className={cn('grid gap-2 py-3', locked && 'opacity-70')}>
            <div className="grid gap-0.5"><b className="font-medium">{k.label}</b><span className="text-[13px] text-muted-foreground">{k.scope}.{k.deterministic ? ' Decided by rule, with no model run.' : ''}</span></div>
            <ChoiceChips label={`${k.label}: who decides`} hideLabel size="sm" value={k.configured} onChange={(mode) => { if (mode !== k.configured) save({ kinds: { [k.id]: mode } }); }}
              options={k.modes.map((mode: string) => ({ value: mode, label: MODE_LABEL(mode), disabled: busy || !d.enabled }))} />
            <p className="text-[13px] text-muted-foreground" data-kind-metrics>{kindLine(m.kinds?.[k.id])}</p>
          </section>))}
        <div className="py-3"><SwitchRow label={`${first('manager')} and ${first('sre')} may grant each other production read access`} checked={!!d.peer_access} disabled={busy || locked} onChange={(on) => save({ peerAccess: on })}
          hint="Only for one ticket and within your access policy. Renewals and standing grants stay yours." /></div>
      </div>
      {m.total && <p className="text-sm" data-delegation-totals>{m.avoided_text} {m.spend_text}</p>}
      <p className="text-[13px] text-muted-foreground">Each decision gets one attempt: up to {money(d.limits.budget_usd)} on an engine with a spending cap, or {d.limits.max_minutes} minutes and {d.limits.max_steps} steps on a plan-billed one. One that has not started within {d.limits.max_wait_minutes} minutes comes to you. At most {d.limits.max_per_day} decision runs a day.</p>
      <p className="text-[13px] text-muted-foreground">Always yours: {d.never.join('; ')}.</p>
    </div>
  );
}
