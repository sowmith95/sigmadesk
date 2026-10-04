import { useEffect, useId, useRef, useState } from 'react';
import { Play, Pause, Pencil } from 'lucide-react';
import { S, api, agentMap, loadResearch, loadSnapshot } from '@/store.js';
import { ago, until } from '@/lib/format.js';
import { FREQUENCIES, WINDOWS, SOURCE_SUGGESTIONS, TEMPLATES, frequencyLabel, parseInterval, normalizeSource, sentence, fromProgram, listWith, listWithout, withSeat, problems, uniqueId } from '@/lib/programs.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { ChoiceChips, MultiChips } from '@/components/desk/Choices';
import { Field, TokenInput, Stepper, SwitchRow } from '@/components/desk/Fields';
import { Tag, SeatAvatar, type Tone } from '@/components/desk/Bits';
import { cn } from '@/lib/utils';
import type { Agent, Program, Connector } from '@/types';

type Draft = ReturnType<typeof fromProgram>;
const EXAMPLES: string[] = TEMPLATES.filter((t: { focus: string }) => t.focus).map((t: { focus: string }) => t.focus);

/** Save the list with one program changed, against the revision this edit started from (409 if someone saved since). */
export async function saveList(list: unknown[], revision: string | undefined = S.research?.data?.revision) {
  try { await api('PUT', '/api/research/programs', { programs: list, expected_revision: revision }); }
  catch (e) { if ((e as { status?: number }).status === 409) await loadResearch(); throw e; }
  await Promise.all([loadResearch(), loadSnapshot().catch(() => {})]);
}

function status(p: Program): [string, Tone] {
  if (p.code === 'due') return ['Due now', 'shipped'];
  if (p.code === 'disabled') return ['Paused', 'neutral'];
  if (p.code === 'seat_disabled') return ['Researcher is off', 'needs'];
  if (p.code === 'funnel') return ['Waiting for grooming', 'needs'];
  if (p.code === 'cadence') return [`Eligible ${until(p.next_eligible_at)}`, 'neutral'];
  if (p.code === 'window') return [p.window === 'market' ? 'Waits for market hours' : 'Waits for the close', 'neutral'];
  return [p.reason || p.code || '', 'neutral'];
}

/** One program, written as a sentence. Every underlined part opens the editor at that question. */
export function ProgramCard({ program, saved, editingRow, onEdit, onClose }: { program: Program; saved: Program[]; editingRow: string | null; onEdit: (row: string) => void; onClose: () => void }) {
  const d = fromProgram(program) as Draft;
  const [label, tone] = status(program);
  const [runOpen, setRunOpen] = useState(false);
  const [focus, setFocus] = useState('');
  const editorId = useId();
  return (
    <article data-program={program.id} className={cn('grid gap-3 rounded-lg border bg-card p-5', !program.enabled && 'opacity-80')}>
      <p className={cn('max-w-[36em] text-xl leading-relaxed [overflow-wrap:anywhere] max-md:text-lg', !program.enabled && 'text-muted-foreground')}>
        {sentence(d, S.agents).map((part: { slot?: string; text: string }, i: number) => (part.slot
          ? <button key={i} type="button" aria-expanded={!!editingRow} aria-controls={editorId} onClick={() => onEdit(part.slot!)}
            className={cn('border-b-2 border-primary px-px text-left hover:bg-primary/15 focus-visible:rounded-sm', part.slot === 'seat' && 'font-semibold')}>{part.text}</button>
          : <span key={i}>{part.text}</span>))}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <Tag tone={tone}>{label}</Tag><span className="text-foreground">{program.label}</span>
        <span>{program.last_run_at ? `Last session ${ago(program.last_run_at)}` : 'Never run'}</span>
        <span>{program.maxProposals} proposal{program.maxProposals === 1 ? '' : 's'} per session</span>
        <span className="flex-1" />
        {!editingRow && <div className="flex flex-wrap gap-1.5">
          <AsyncButton variant="ghost" size="sm" run={() => saveList(listWith(saved, { ...d, enabled: !d.enabled }))} ok={d.enabled ? 'Program paused' : 'Program resumed'}>{d.enabled ? <Pause /> : <Play />}{d.enabled ? 'Pause' : 'Resume'}</AsyncButton>
          <Button variant="secondary" size="sm" aria-expanded={runOpen} onClick={() => setRunOpen(!runOpen)}>Run now</Button>
          <Button variant="secondary" size="sm" onClick={() => onEdit('label')}><Pencil />Edit</Button>
        </div>}
      </div>
      {runOpen && !editingRow && <div className="flex flex-wrap gap-2">
        <Input aria-label="Topic for this session only" placeholder="Anything specific this time? (optional)" value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={500} className="min-w-60 flex-1" />
        <AsyncButton run={async () => { await api('POST', `/api/research/programs/${program.id}/run`, { focus }); setRunOpen(false); setFocus(''); }} ok={`${agentMap()[program.seat]?.name || 'The researcher'} started a session`}>Start session</AsyncButton>
        <Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button>
      </div>}
      {editingRow && <div id={editorId}><ProgramEditor initial={d} saved={saved} focusRow={editingRow} onClose={onClose} /></div>}
    </article>
  );
}

const Q = ({ title, row, children, note }: { title: string; row: string; children: React.ReactNode; note?: React.ReactNode }) => (
  <div data-row={row} className="grid gap-2.5"><h3 className="font-semibold">{title}</h3>{children}{note && <p className="text-sm text-muted-foreground">{note}</p>}</div>
);

/** Editor for one program. Local draft: live updates never overwrite what is being typed. */
export function ProgramEditor({ initial, saved, focusRow = 'label', onClose, isNew = false }: { initial: Draft; saved: Program[]; focusRow?: string; onClose: () => void; isNew?: boolean }) {
  const [d, setD] = useState<Draft>(initial);
  const [custom, setCustom] = useState(FREQUENCIES.some((f: { minutes: number }) => f.minutes === initial.intervalMinutes) ? '' : String(initial.intervalMinutes));
  const [showProblems, setShowProblems] = useState(false);
  const [baseRevision, setBaseRevision] = useState<string | undefined>(() => S.research?.data?.revision);
  const root = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const agents = S.agents as Agent[];
  const amap = agentMap();
  const conns: Connector[] = S.research?.connectors || [];
  const approved = conns.filter((c) => c.status === 'approved').map((c) => c.name);
  const market = S.research?.data?.market_hours;
  const seat = amap[d.seat] as Agent | undefined;
  const issues: string[] = problems(d, { approvedConnectors: approved, seatEngine: seat?.engine || 'claude' });
  useEffect(() => {
    const row = root.current?.querySelector(`[data-row="${focusRow}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    (row?.querySelector<HTMLElement>('input, textarea, [role="radio"][tabindex="0"], [role="radio"][data-state="on"], button') || null)?.focus();
  }, [focusRow]);
  const preset = FREQUENCIES.some((f: { minutes: number }) => f.minutes === d.intervalMinutes) && !custom ? String(d.intervalMinutes) : 'custom';
  const person = (a: Agent) => ({ value: a.id, label: a.name, title: `${a.name}, ${a.role}`, lead: <SeatAvatar id={a.id} /> });
  const save = async () => {
    if (issues.length) { setShowProblems(true); throw new Error(issues[0]); }
    const draft = isNew ? { ...d, id: uniqueId(d.label, saved.map((p) => p.id)) } : d;
    try { await saveList(listWith(saved, draft), baseRevision); }
    catch (e) { if ((e as { status?: number }).status === 409) setBaseRevision(S.research?.data?.revision); throw e; }
    onClose();
  };
  return (
    <div ref={root} className="grid gap-6 border-t pt-5">
      <div data-row="label" className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Name" id="program-name">{({ id }) => <Input id={id} value={d.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Quant papers" />}</Field>
        <div className="min-w-64"><SwitchRow label="Running" hint={d.enabled ? 'Sessions start on schedule.' : 'Paused: no scheduled sessions.'} checked={d.enabled} onChange={(enabled) => set({ enabled })} /></div>
      </div>
      <Q title="Who researches" row="seat" note={seat ? `${seat.role}. ${seat.bio || ''}` : null}>
        <ChoiceChips label="Who researches" hideLabel options={agents.map(person)} value={d.seat} onChange={(v) => setD((x) => withSeat(x, v) as Draft)} />
      </Q>
      <Q title="What to research" row="topic">
        <ChoiceChips label="What to research" hideLabel options={[{ value: 'own', label: 'On their own' }, { value: 'directed', label: 'A topic I set' }]} value={d.mode} onChange={(mode) => set({ mode })} />
        {d.mode === 'own' ? <p className="text-sm text-muted-foreground">{seat?.name || 'They'} choose{seat ? 's' : ''} topics from their role and what the product already does.</p> : <>
          <Textarea aria-label="Topic" rows={3} maxLength={2000} value={d.focus} onChange={(e) => set({ focus: e.target.value })} placeholder="What should they look into? Be specific about the user and the outcome." />
          <div className="flex flex-wrap gap-1.5">{EXAMPLES.filter((x) => x !== d.focus).slice(0, 3).map((x) => <button key={x} type="button" onClick={() => set({ focus: x })} className="rounded-full border border-dashed border-input px-3 py-1 text-left text-sm text-muted-foreground hover:bg-secondary hover:text-foreground">{x.length > 64 ? `${x.slice(0, 62)}…` : x}</button>)}</div>
        </>}
      </Q>
      <Q title="How often" row="frequency" note="Counted from the last session. A session waits while enough proposals are already waiting for grooming.">
        <ChoiceChips label="How often" hideLabel value={preset} onChange={(v) => { if (v === 'custom') setCustom(String(d.intervalMinutes)); else { setCustom(''); set({ intervalMinutes: Number(v) }); } }}
          options={[...FREQUENCIES.map((f: { minutes: number; label: string }) => ({ value: String(f.minutes), label: f.label })), { value: 'custom', label: preset === 'custom' ? frequencyLabel(d.intervalMinutes) : 'Custom…' }]} />
        {preset === 'custom' && <Field label="Every" hint="Minutes, or with a unit: 90m, 4h, 2d, 1w. At least 15 minutes." id="program-interval">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={custom} className="max-w-48" aria-invalid={!parseInterval(custom) || undefined}
            onChange={(e) => { setCustom(e.target.value); const m = parseInterval(e.target.value); if (m) set({ intervalMinutes: m }); }} />}</Field>}
      </Q>
      <Q title="When" row="window" note={market ? `Market hours are ${market.start} to ${market.end} ${market.timezone.replace('_', ' ')}, weekdays. The market is ${market.open_now ? 'open' : 'closed'} now.` : null}>
        <ChoiceChips label="When" hideLabel options={WINDOWS.map((w: { id: string; label: string }) => ({ value: w.id, label: w.label }))} value={d.window} onChange={(window) => set({ window })} />
      </Q>
      <div data-row="sources"><TokenInput label="Approved sources" values={d.sources} onChange={(sources) => set({ sources })} suggestions={SOURCE_SUGGESTIONS} normalize={normalizeSource}
        placeholder="Type a domain and press Enter" invalidText="That does not look like a source; try a domain such as arxiv.org." hint="Every piece of evidence must cite one of these. Leave empty to accept any cited link." /></div>
      <Q title="Tools" row="tools">
        <SwitchRow label="Web search and reading" hint="Runs outside the sandbox. Needed to read papers and competitor pages." checked={d.web} onChange={(web) => set({ web })} />
        {conns.length ? <MultiChips label="Connectors" value={d.connectors} onChange={(connectors) => set({ connectors })}
          options={conns.filter((c) => !['rejected', 'retired'].includes(c.status)).map((c) => ({ value: c.name, label: c.name, disabled: c.status !== 'approved', hint: c.status === 'approved' ? null : 'needs approval', title: c.purpose }))} />
          : <p className="text-sm text-muted-foreground">No connectors yet. Propose one below; programs can use it once approved.</p>}
        {conns.some((c) => c.status !== 'approved' && !['rejected', 'retired'].includes(c.status)) && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => document.getElementById('connectors')?.scrollIntoView({ block: 'start' })}>Review connectors</Button>}
      </Q>
      <Q title="Checked by" row="reviewers" note="Each proposal goes to another seat, preferring a different model family, before the manager may groom it.">
        <MultiChips label="Checked by" hideLabel options={agents.filter((a) => a.id !== d.seat).map(person)} value={d.reviewers} onChange={(reviewers) => set({ reviewers })} />
        <ChoiceChips label="Passes needed before grooming" size="sm" options={['1', '2', '3'].map((n) => ({ value: n, label: n }))} value={String(d.minReviewers)} onChange={(v) => set({ minReviewers: Number(v) })} />
      </Q>
      <div data-row="proposals"><Stepper label="Proposals per session" value={d.maxProposals} min={1} max={10} onChange={(maxProposals) => set({ maxProposals })} /></div>
      {showProblems && issues.length > 0 && <ul role="alert" className="grid list-disc gap-0.5 rounded-md bg-blocked/15 py-2.5 pl-8 pr-3 text-sm">{issues.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="flex flex-wrap items-center gap-2 max-md:[&>[data-primary]]:order-first max-md:[&>[data-primary]]:basis-full">
        {!isNew && saved.length > 1 && <AsyncButton variant="ghost" className="text-destructive" confirm={`Delete "${initial.label}"? Its past sessions and proposals stay; no new sessions start.`}
          run={async () => { await saveList(listWithout(saved, initial.id), baseRevision); onClose(); }} ok="Program deleted">Delete</AsyncButton>}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <AsyncButton data-primary size="lg" run={save} ok={isNew ? 'Program added' : 'Program saved'}>{isNew ? 'Add program' : 'Save program'}</AsyncButton>
      </div>
    </div>
  );
}
