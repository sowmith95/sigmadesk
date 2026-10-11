import { useEffect, useRef, useState } from 'react';
import { S, api, toast, setView, openSheet } from '@/store.js';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SwitchRow } from '@/components/desk/Fields';
import { SeatAvatar, Section } from '@/components/desk/Bits';
import { ChoiceChips } from '@/components/desk/Choices';
import { AutonomyMatrix } from '@/components/desk/Autonomy';
import { DelegationSettings } from '@/components/desk/Delegation';
import type { ResearchBacklog } from '@/types';

function NumberSetting({ k, label, hint, step = 1, min = k === 'daily_budget_usd' ? 0 : 1 }: { k: string; label: string; hint: string; step?: number; min?: number }) {
  const [v, setV] = useState<string>(S.settings[k] ?? '');
  const seen = useRef(S.settings[k]);
  useEffect(() => { if (S.settings[k] !== seen.current) { seen.current = S.settings[k]; setV(S.settings[k] ?? ''); } });
  const save = async () => {
    if (String(v) === String(S.settings[k])) return;
    try { await api('POST', '/api/settings', { key: k, value: String(v) }); toast('Saved'); } catch (e) { toast((e as Error).message, true); setV(S.settings[k] ?? ''); }
  };
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <label htmlFor={`set-${k}`} className="grid gap-0.5"><b className="font-medium">{label}</b><span className="text-[13px] text-muted-foreground">{hint}</span></label>
      <Input id={`set-${k}`} type="number" inputMode="decimal" min={min} step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} className="w-28 shrink-0 text-right font-mono" />
    </div>
  );
}
const Bool = ({ k, label, hint }: { k: string; label: string; hint: string }) => (
  <div className="py-3"><SwitchRow label={label} hint={hint} checked={S.settings[k] === 'true'} onChange={async (on) => { try { await api('POST', '/api/settings', { key: k, value: String(on) }); toast('Saved'); } catch (e) { toast((e as Error).message, true); } }} /></div>
);
const Group = ({ children }: { children: React.ReactNode }) => <div className="divide-y rounded-lg border bg-card px-4">{children}</div>;

/** The CI checks a merge waits for: learned from the repository or set by you, with where each one comes from. */
function RequiredChecks() {
  const [rc, setRc] = useState<{ names: string[]; source: string; workflows: Record<string, string[]> } | null>(null);
  const [add, setAdd] = useState('');
  const load = () => api('GET', '/api/ci/required-checks').then(setRc).catch(() => setRc({ names: [], source: 'auto', workflows: {} }));
  useEffect(() => { load(); }, []);
  const save = async (names: string[], learn = false) => { setRc(await api('POST', '/api/ci/required-checks', { names, learn }).then(() => api('GET', '/api/ci/required-checks'))); toast('Saved'); };
  if (!rc) return <p className="py-3 text-muted-foreground">Loading checks…</p>;
  return (
    <div className="grid gap-3 py-3">
      <div className="grid gap-0.5"><b className="font-medium">Checks a merge waits for</b>
        <span className="text-[13px] text-muted-foreground">{rc.source === 'auto' ? 'Learned from pull-request workflows that run on your base branch. Checks that never run on pull requests are dropped automatically.' : 'Set by you; the desk will not change this list.'} A check whose workflow does not run for a pull request's files is not required for that pull request.</span></div>
      <div className="flex flex-wrap gap-1.5">{rc.names.length ? rc.names.map((n) => (
        <span key={n} className="inline-flex items-center gap-1 rounded-full border py-0.5 pl-3 pr-1 text-sm" title={(rc.workflows[n] || []).join(', ') || 'workflow unknown'}>{n}
          <span className="text-xs text-muted-foreground">{(rc.workflows[n] || [])[0]?.split('/').pop() || ''}</span>
          <button type="button" aria-label={`Stop requiring ${n}`} className="grid size-7 place-items-center rounded-full hover:bg-secondary" onClick={() => save(rc.names.filter((x) => x !== n))}>×</button></span>))
        : <span className="text-sm text-muted-foreground">None yet. Until the desk has seen a pull-request check, you merge yourself.</span>}</div>
      <div className="flex flex-wrap gap-2"><Input aria-label="Add a required check" placeholder="Exact check name, e.g. Run tests (alpaca_trader)" value={add} onChange={(e) => setAdd(e.target.value)} className="min-w-64 flex-1" />
        <Button variant="secondary" disabled={!add.trim()} onClick={async () => { await save([...rc.names, add.trim()]); setAdd(''); }}>Require</Button>
        {rc.source !== 'auto' && <Button variant="ghost" onClick={() => save(rc.names, true)}>Let the desk keep it up to date</Button>}</div>
    </div>
  );
}

/** What the research backlog limit means, with how many research items are open now. */
function backlogHint(b?: ResearchBacklog | null) {
  const base = 'New research, Run now included, waits while this many research items are under review, revision or your decision, counting room that running sessions hold; 0 stops it.';
  return b ? `${base} Open now: ${b.count}.` : base;
}

type KnowledgeFailure = { id: number; ticket_key: string; status: string; attempts: number; last_error: string | null };
/** Past-work search and the notes the desk writes back (#10): scope, budget, what was written, and the week's numbers. */
function KnowledgeSettings() {
  const k = S.meta.knowledge;
  if (!k) return null;
  const m = k.metrics || {};
  const o = k.outbox || {};
  const pct = (x: number) => `${Math.round((x || 0) * 100)}%`;
  const retry = async (id: number) => { try { await api('POST', `/api/knowledge/notes/${id}/retry`); toast('Trying again'); } catch (e) { toast((e as Error).message, true); } };
  return (
    <Group>
      <Bool k="knowledge_enabled" label="Past-work search" hint={k.configured ? 'Seats can search how earlier work was solved, and the desk writes facts back when a ticket merges. Off stops every search at once.' : 'Not set up on this desk: set knowledge.enabled and knowledge.executable in the config first.'} />
      <div className="grid gap-1 py-3 text-[13px] text-muted-foreground">
        <p><b className="font-medium text-foreground">Searches</b> {k.namespaces?.length ? k.namespaces.join(', ') : 'nothing (no allowed namespace)'}. Never searched, whatever the config says: {k.deny}.</p>
        {(k.refused_namespaces || []).length > 0 && <p>Left out of your config: {(k.refused_namespaces as { namespace: string; why: string }[]).map((r) => `${r.namespace} (${r.why})`).join(', ')}.</p>}
        <p>Up to {k.per_run} searches per run, the automatic one included. Runs that start with past work: {(k.auto_kinds || []).join(', ').replaceAll('_', ' ')}. Notes are shown as untrusted history and reach the seat's model provider.</p>
        <p>Facts written to {k.write_namespace || 'nowhere (no allowed namespace)'}: {o.verified || 0} written, {o.pending || 0} waiting, {(o.failed || 0) + (o.refused || 0)} failed. Only records the desk owns, never seat-written text.</p>
      </div>
      <div className="grid gap-1 py-3 text-[13px] text-muted-foreground">
        <b className="font-medium text-foreground">This week</b>
        <p>{m.searches_per_run ?? 0} searches per run · {pct(m.share_searched)} of runs searched · {m.cited_resolved ?? 0} cited answers settled without coming to you · {m.notes_written ?? 0} notes written · {m.outbox_failures ?? 0} write problems</p>
      </div>
      {(k.failures || []).length > 0 && <div className="grid gap-2 py-3">
        <b className="font-medium">Notes that did not write</b>
        {(k.failures as KnowledgeFailure[]).map((f) => (
          <div key={f.id} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0 text-muted-foreground"><span className="font-mono text-foreground">{f.ticket_key}</span> · {f.status === 'pending' ? `trying again (${f.attempts} tries so far)` : f.status} · {f.last_error || 'no reason recorded'}</span>
            {f.status !== 'pending' && <Button variant="secondary" size="sm" onClick={() => retry(f.id)}>Try again</Button>}
          </div>))}
      </div>}
    </Group>
  );
}

export default function SettingsPage() {
  const progs = S.meta.research?.programs || [];
  return (
    <div className="grid max-w-3xl gap-8">
      <Section title="Limits"><Group>
        <NumberSetting k="daily_budget_usd" label="Daily spend limit (USD)" hint="Notional model spend per day." step={5} />
        <NumberSetting k="max_concurrent" label="Seats at once" hint="A market-hours window in the config can lower this." />
        <Bool k="auto_fallback" label="Provider fallback" hint="When one provider is low or down, seats use another. Limits and gates still apply." />
      </Group></Section>
      <Section title="Autonomy" id="autonomy"><AutonomyMatrix />
        <h3 className="mt-3 font-semibold" id="delegation">Decisions made for you</h3><DelegationSettings /></Section>
      <Section title="Grooming"><Group>
        <div className="grid gap-3 py-3">
          <div className="grid gap-0.5"><b className="font-medium">Morgan grooms on</b><span className="text-[13px] text-muted-foreground">Grooming reads the repository and turns requests into tasks. Codex reads the code directly; the seat's own engine is whatever Models per seat sets for Morgan.</span></div>
          <ChoiceChips label="Grooming engine" hideLabel value={S.settings.groom_engine === 'seat' ? 'seat' : 'codex'}
            options={[{ value: 'codex', label: 'Codex' }, { value: 'seat', label: "Morgan's own engine" }]}
            onChange={async (v) => { try { await api('POST', '/api/settings', { key: 'groom_engine', value: v }); toast('Saved'); } catch (e) { toast((e as Error).message, true); } }} />
        </div>
      </Group></Section>
      <Section title="Research"><Group>
        <div className="flex items-center justify-between gap-4 py-3"><div className="grid gap-0.5"><b className="font-medium">Research programs</b><span className="text-[13px] text-muted-foreground">{progs.length ? `${progs.filter((p: { enabled: boolean }) => p.enabled).length} of ${progs.length} running.` : 'None yet.'} Who researches, how often, and who checks their work.</span></div>
          <Button variant="secondary" onClick={() => setView('research')}>Open Research</Button></div>
        <NumberSetting k="max_open_proposals" label="Proposals waiting at most" hint="Research pauses while this many ideas wait for grooming." />
        <NumberSetting k="research_backlog_max" min={0} label="Research items open at most" hint={backlogHint(S.meta.research?.backlog)} />
      </Group></Section>
      <Section title="GitHub"><Group>
        <Bool k="github_sync" label="Sync GitHub issues" hint={`Mirror tickets and comments to ${S.meta.repo || 'GitHub'}.`} />
        <Bool k="open_draft_prs" label="Open draft PRs" hint="After QA, push the branch and open a draft PR. Nothing merges automatically." />
        <RequiredChecks />
      </Group></Section>
      <Section title="Production read access"><Group>
        <Bool k="ops_enabled" label="Production read access" hint={S.meta.ops?.configured ? 'Seats holding a grant may run the read-only probes below. Off stops every probe at once.' : 'Not configured on this desk: set ops.enabled and the databases/containers in the config first (README, "Production read access").'} />
        <div className="flex items-center justify-between gap-4 py-3"><div className="grid gap-0.5"><b className="font-medium">Who has access</b>
          <span className="text-[13px] text-muted-foreground">{(S.meta.access?.grants || []).length ? (S.meta.access.grants as { seat_name: string }[]).map((g) => g.seat_name).join(', ') : 'Nobody right now.'}{(S.meta.access?.owner_requests || []).length ? ` ${S.meta.access.owner_requests.length} request(s) wait for you.` : ''} Grants are time-boxed and revocable; the EM and SRE approve within your policy.</span></div>
          <Button variant="secondary" onClick={() => openSheet({ type: 'access' })}>Production access</Button></div>
        <div className="grid gap-1 py-3 text-[13px] text-muted-foreground">
          {(S.meta.ops?.probes || []).map((p: { id: string; about: string }) => <p key={p.id}><span className="font-mono text-foreground">{p.id}</span> · {p.about}</p>)}
          {S.meta.ops?.busy && <p>Market hours now: tighter timeouts and budgets.</p>}
        </div>
      </Group></Section>
      <Section title="Knowledge"><KnowledgeSettings /></Section>
      <Section title="Models per seat"><div className="divide-y rounded-lg border bg-card">
        {S.agents.map((a: { id: string; name: string; role: string; engine?: string; model?: string; enabled?: boolean }) => { const r = S.meta.routing?.[a.id] || {}; return (
          <button key={a.id} type="button" onClick={() => openSheet({ type: 'models', id: a.id })} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-secondary">
            <SeatAvatar id={a.id} size="md" /><span className="grid min-w-0 flex-1"><b className="truncate">{a.name}</b><span className="truncate text-sm text-muted-foreground">{a.role}</span></span>
            <span className="font-mono text-[13px] text-muted-foreground">{a.enabled === false ? 'off' : `${r.engine || a.engine}${(r.model ?? a.model) ? `, ${r.model ?? a.model}` : ''}`}</span></button>); })}
      </div></Section>
      <p className="text-sm text-muted-foreground">Halt, resume and the breaker are on the Desk page. The <a className="text-primary hover:underline" href="/classic.html">Classic view</a> stays available for architecture reviews and councils.</p>
    </div>
  );
}
