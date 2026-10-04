import { useEffect, useId, useRef, useState } from 'react';
import { S, api, agentMap, loadResearch, loadSnapshot, toast } from '../store.js';
import { ago, until } from '../lib/format.js';
import { FREQUENCIES, WINDOWS, SOURCE_SUGGESTIONS, TEMPLATES, frequencyLabel, parseInterval, normalizeSource, sentence, fromProgram, toProgram, listWith, listWithout, withSeat, problems, uniqueId } from '../lib/programs.js';
import { Chip, ChipGroup, ChipInput, NumberStepper, Toggle, Field, Button, AsyncButton, Avatar } from '../kit/index.js';

const STATUS = {
  due: ['Due now', 'green'], cadence: null, window: null, disabled: ['Paused', ''], seat_disabled: ['Researcher is off', 'amber'], funnel: ['Waiting for grooming', 'amber'],
};
const EXAMPLES = TEMPLATES.filter((t) => t.focus).map((t) => t.focus);

/** Save the whole list with one program changed, against `revision`: the list the person was looking at when they
 *  started this edit. Live refreshes must not move that baseline, or another person's save would be overwritten. */
async function saveList(list, revision = S.research?.data?.revision) {
  try {
    await api('PUT', '/api/research/programs', { programs: list, expected_revision: revision });
  } catch (e) {
    if (e.status === 409) await loadResearch();
    throw e;
  }
  await Promise.all([loadResearch(), loadSnapshot().catch(() => {})]);
}

function statusOf(p) {
  if (STATUS[p.code]) return STATUS[p.code];
  if (p.code === 'cadence') return [`Eligible ${until(p.next_eligible_at)}`, ''];
  if (p.code === 'window') return [p.window === 'market' ? 'Waits for market hours' : 'Waits for the close', ''];
  return [p.reason || p.code, ''];
}

/** The program as a sentence. Every underlined part opens the editor at that question. */
export function ProgramCard({ program, saved, editing, onEdit, onClose }) {
  const agents = S.agents;
  const d = fromProgram(program);
  const [status, tone] = statusOf(program);
  const [runOpen, setRunOpen] = useState(false);
  const [focus, setFocus] = useState('');
  const editorId = useId();
  const parts = sentence(d, agents);
  return (
    <article className={`program ${program.enabled ? '' : 'off'}`} data-program={program.id}>
      <p className="program-sentence">
        {parts.map((part, i) => (part.slot
          ? <button key={i} type="button" className={`slot ${part.slot === 'seat' ? 'who' : ''}`} aria-expanded={editing} aria-controls={editorId}
            onClick={() => onEdit(part.slot)}>{part.text}</button>
          : <span key={i}>{part.text}</span>))}
      </p>
      <div className="program-meta">
        <Chip tone={tone}>{status}</Chip>
        <span>{program.label}</span>
        <span>{program.last_run_at ? `Last session ${ago(program.last_run_at)}` : 'Never run'}</span>
        <span>{program.maxProposals} proposal{program.maxProposals === 1 ? '' : 's'} per session</span>
        <span className="spacer" />
        {!editing && <>
          <AsyncButton size="small" variant="ghost" run={() => saveList(listWith(saved, { ...d, enabled: !d.enabled }))} ok={d.enabled ? 'Program paused' : 'Program resumed'}>{d.enabled ? 'Pause' : 'Resume'}</AsyncButton>
          <Button size="small" onClick={() => setRunOpen(!runOpen)} aria-expanded={runOpen}>Run now</Button>
          <Button size="small" onClick={() => onEdit('label')}>Edit</Button>
        </>}
      </div>
      {runOpen && !editing && (
        <div className="row-actions">
          <input type="text" aria-label="Topic for this session only" placeholder="Anything specific this time? (optional)" value={focus} onChange={(e) => setFocus(e.target.value)} maxLength={500} />
          <AsyncButton variant="primary" run={async () => { await api('POST', `/api/research/programs/${program.id}/run`, { focus }); setRunOpen(false); setFocus(''); }}
            ok={`${agentMap()[program.seat]?.name || 'The researcher'} started a session`}>Start session</AsyncButton>
          <Button variant="ghost" onClick={() => setRunOpen(false)}>Cancel</Button>
        </div>
      )}
      {editing && <div id={editorId}><ProgramEditor initial={d} saved={saved} focusRow={editing} onClose={onClose} /></div>}
    </article>
  );
}

/** Editor for one program (existing or new). Local draft: live updates never overwrite what is being typed. */
export function ProgramEditor({ initial, saved, focusRow = 'label', onClose, isNew = false }) {
  const [d, setD] = useState(initial);
  const [custom, setCustom] = useState(FREQUENCIES.some((f) => f.minutes === initial.intervalMinutes) ? '' : String(initial.intervalMinutes));
  const [showProblems, setShowProblems] = useState(false);
  // The saved list this edit is based on. After a conflict the person has been told; the next save is against the latest.
  const [baseRevision, setBaseRevision] = useState(() => S.research?.data?.revision);
  const root = useRef(null);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const agents = S.agents;
  const amap = agentMap();
  const conns = S.research?.connectors || [];
  const approved = conns.filter((c) => c.status === 'approved').map((c) => c.name);
  const market = S.research?.data?.market_hours;
  const seat = amap[d.seat];
  const issues = problems(d, { approvedConnectors: approved, seatEngine: seat?.engine || 'claude' });
  useEffect(() => {
    const row = root.current?.querySelector(`[data-row="${focusRow}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    (row?.querySelector('input, textarea, [role="radio"][tabindex="0"], button') || null)?.focus();
  }, [focusRow]);
  const presetValue = FREQUENCIES.some((f) => f.minutes === d.intervalMinutes) && !custom ? d.intervalMinutes : 'custom';
  const seatOpt = (a) => ({ value: a.id, label: a.name, title: `${a.name}, ${a.role}`, lead: <Avatar id={a.id} /> });
  const save = async () => {
    if (issues.length) { setShowProblems(true); throw new Error(issues[0]); }
    const takenIds = saved.map((p) => p.id);
    const draft = isNew ? { ...d, id: uniqueId(d.label, takenIds) } : d;
    try { await saveList(listWith(saved, draft), baseRevision); }
    catch (e) { if (e.status === 409) setBaseRevision(S.research?.data?.revision); throw e; }
    onClose();
  };
  return (
    <div className="editor" ref={root}>
      <div className="editor-row" data-row="label">
        <Field label="Name" htmlFor="program-name"><input id="program-name" type="text" value={d.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Quant papers" /></Field>
        <Toggle label="Running" hint={d.enabled ? 'Sessions start on schedule.' : 'Paused: no scheduled sessions.'} checked={d.enabled} onChange={(enabled) => set({ enabled })} />
      </div>
      <div className="editor-row" data-row="seat">
        <h4>Who researches</h4>
        <ChipGroup label="Who researches" labelHidden options={agents.map(seatOpt)} value={d.seat} onChange={(v) => setD((x) => withSeat(x, v))} />
        {seat && <p className="muted">{seat.role}. {seat.bio}</p>}
      </div>
      <div className="editor-row topic" data-row="topic">
        <h4>What to research</h4>
        <ChipGroup label="What to research" labelHidden options={[{ value: 'own', label: 'On their own' }, { value: 'directed', label: 'A topic I set' }]} value={d.mode} onChange={(mode) => set({ mode })} />
        {d.mode === 'own'
          ? <p className="muted">{seat?.name || 'They'} choose{seat ? 's' : ''} topics from their role and what the product already does.</p>
          : <>
            <textarea aria-label="Topic" rows={3} maxLength={2000} value={d.focus} onChange={(e) => set({ focus: e.target.value })} placeholder="What should they look into? Be specific about the user and the outcome." />
            <div className="chip-row suggestions">{EXAMPLES.filter((x) => x !== d.focus).slice(0, 3).map((x) => <button key={x} type="button" className="choice ghosted" onClick={() => set({ focus: x })}>{x.length > 60 ? `${x.slice(0, 58)}…` : x}</button>)}</div>
          </>}
      </div>
      <div className="editor-row" data-row="frequency">
        <h4>How often</h4>
        <ChipGroup label="How often" labelHidden options={[...FREQUENCIES.map((f) => ({ value: f.minutes, label: f.label })), { value: 'custom', label: presetValue === 'custom' ? frequencyLabel(d.intervalMinutes) : 'Custom…' }]}
          value={presetValue} onChange={(v) => { if (v === 'custom') setCustom(String(d.intervalMinutes)); else { setCustom(''); set({ intervalMinutes: v }); } }} />
        {presetValue === 'custom' && <Field label="Every" hint="Minutes, or with a unit: 90m, 4h, 2d, 1w. At least 15 minutes." htmlFor="program-interval">
          <input id="program-interval" type="text" value={custom} onChange={(e) => { setCustom(e.target.value); const m = parseInterval(e.target.value); if (m) set({ intervalMinutes: m }); }} aria-invalid={!parseInterval(custom) || undefined} /></Field>}
        <p className="muted">Counted from the last session; a session waits while enough proposals are already waiting for grooming.</p>
      </div>
      <div className="editor-row" data-row="window">
        <h4>When</h4>
        <ChipGroup label="When" labelHidden options={WINDOWS.map((w) => ({ value: w.id, label: w.label }))} value={d.window} onChange={(window) => set({ window })} />
        {market && <p className="muted">Market hours are {market.start}–{market.end} {market.timezone.replace('_', ' ')}, weekdays. The market is {market.open_now ? 'open' : 'closed'} now.</p>}
      </div>
      <div className="editor-row" data-row="sources">
        <h4>Sources</h4>
        <ChipInput label="Approved sources" values={d.sources} onChange={(sources) => set({ sources })} suggestions={SOURCE_SUGGESTIONS} normalize={normalizeSource}
          placeholder="Type a domain and press Enter" hint="Every piece of evidence must cite one of these. Leave empty to accept any cited link." />
      </div>
      <div className="editor-row" data-row="tools">
        <h4>Tools</h4>
        <Toggle label="Web search and reading" hint="Runs outside the sandbox. Needed to read papers and competitor pages." checked={d.web} onChange={(web) => set({ web })} />
        {conns.length ? <ChipGroup label="Connectors" multiple options={conns.filter((c) => !['rejected', 'retired'].includes(c.status)).map((c) => ({ value: c.name, label: c.name, disabled: c.status !== 'approved', hint: c.status === 'approved' ? null : 'needs approval', title: c.purpose }))}
          value={d.connectors} onChange={(connectors) => set({ connectors })} />
          : <p className="muted">No connectors yet. Propose one below; it can be used here once approved.</p>}
        {conns.some((c) => c.status !== 'approved' && !['rejected', 'retired'].includes(c.status)) && <Button variant="ghost" size="small" onClick={() => document.getElementById('connectors')?.scrollIntoView({ block: 'start' })}>Review connectors</Button>}
      </div>
      <div className="editor-row" data-row="reviewers">
        <h4>Checked by</h4>
        <ChipGroup label="Checked by" labelHidden multiple options={agents.filter((a) => a.id !== d.seat).map(seatOpt)} value={d.reviewers} onChange={(reviewers) => set({ reviewers })} />
        <ChipGroup label="Passes needed before grooming" size="compact" options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))} value={d.minReviewers} onChange={(minReviewers) => set({ minReviewers })} />
        <p className="muted">Each proposal goes to another seat, preferring a different model family, before the manager may groom it.</p>
      </div>
      <div className="editor-row" data-row="proposals">
        <NumberStepper label="Proposals per session" value={d.maxProposals} min={1} max={10} onChange={(maxProposals) => set({ maxProposals })} />
      </div>
      {showProblems && issues.length > 0 && <ul className="problems" role="alert">{issues.map((x) => <li key={x}>{x}</li>)}</ul>}
      <div className="editor-actions">
        {!isNew && saved.length > 1 && <AsyncButton variant="danger" confirm={`Delete "${initial.label}"? Its past sessions and proposals stay; no new sessions start.`}
          run={async () => { await saveList(listWithout(saved, initial.id), baseRevision); onClose(); }} ok="Program deleted">Delete</AsyncButton>}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <AsyncButton variant="primary" run={save} ok={isNew ? 'Program added' : 'Program saved'}>{isNew ? 'Add program' : 'Save program'}</AsyncButton>
      </div>
    </div>
  );
}
export { toProgram };
export const toastSaved = () => toast('Saved');
