import { useState } from 'react';
import { S, api, agentMap, loadResearch, loadSnapshot } from '../store.js';
import { ago } from '../lib/format.js';
import { Chip, ChipGroup, ChipInput, StatusSteps, Field, Button, AsyncButton, Disclosure } from '../kit/index.js';

const STEPS = ['Proposed', 'Assessing', 'Assessed', 'Approved'];
const STEP_OF = { proposed: 'Proposed', assessing: 'Assessing', assessed: 'Assessed', approved: 'Approved' };
const HINTS = {
  'Purpose': 'What this connector is, in a sentence or two.',
  'Benefit to the application': 'Which programs or seats gain what they cannot do today.',
  'How it is used': 'Which tools, in which runs, read-only or not.',
  'SDLC stage improved': 'The measurable effect you expect at that stage.',
  'Cost': 'Price or credits per call, calls per session, monthly estimate.',
  'Time': 'Setup effort, delay per call, upkeep.',
  'Data leaving the machine': 'What is sent out, and to whom.',
  'Risks and fallback': 'What can go wrong, and what research does instead.',
  'Success measure': 'How you will know in 30 days that it earned its place.',
};
const refresh = () => Promise.all([loadResearch(), loadSnapshot().catch(() => {})]);
const parseCase = (md, sections) => Object.fromEntries(sections.map((s, i) => {
  const start = md.search(new RegExp(`^## ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im'));
  if (start < 0) return [s, ''];
  const after = md.slice(start).replace(/^.*\n/, '');
  const next = after.search(/^## /m);
  return [s, (next < 0 ? after : after.slice(0, next)).trim()];
}));

/** Guided case: one short field per required section, composed into the markdown case the server validates. */
function CaseForm({ existing, onDone }) {
  const sections = S.research?.sections || Object.keys(HINTS);
  const stages = S.research?.stages || ['discovery', 'design', 'implementation', 'qa', 'review', 'operations'];
  const initial = existing ? parseCase(existing.case_md || '', sections) : {};
  const [name, setName] = useState(existing?.name || '');
  const [purpose, setPurpose] = useState(existing?.purpose || '');
  const [fields, setFields] = useState(() => Object.fromEntries(sections.map((s) => [s, initial[s] || ''])));
  const [stageSel, setStageSel] = useState(() => stages.filter((st) => new RegExp(`\\b${st}\\b`, 'i').test(initial['SDLC stage improved'] || '')));
  const stageText = (fields['SDLC stage improved'] || '').replace(new RegExp(`^(?:(?:${stages.join('|')})(?:,\\s*|\\s+—\\s+|$))+`, 'i'), '');
  const compose = () => sections.map((s) => `## ${s}\n${s === 'SDLC stage improved' ? `${stageSel.join(', ')}${stageText.trim() ? ` — ${stageText.trim()}` : ''}` : fields[s].trim()}\n`).join('\n');
  const missing = sections.filter((s) => (s === 'SDLC stage improved' ? !stageSel.length : !fields[s].trim()));
  const submit = async () => {
    if (!existing && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('Use a short lowercase name with dashes, e.g. paper-search.');
    if (missing.length) throw new Error(`Fill in: ${missing.join(', ')}.`);
    if (existing) await api('POST', `/api/connectors/${existing.name}/case`, { purpose, case_md: compose() });
    else await api('POST', '/api/connectors', { name, purpose, case_md: compose() });
    await refresh(); onDone();
  };
  return (
    <div className="case-form">
      {!existing && <Field label="Name" hint="Lowercase with dashes; this is how programs refer to it." htmlFor="conn-name"><input id="conn-name" type="text" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="paper-search" maxLength={40} /></Field>}
      <Field label="In one line" htmlFor="conn-purpose"><input id="conn-purpose" type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={200} placeholder="Search arXiv, PubMed and Semantic Scholar for papers" /></Field>
      {sections.map((s) => (s === 'SDLC stage improved'
        ? <div key={s} className="editor-row"><ChipGroup label="Stage of the work it improves" multiple options={stages.map((st) => ({ value: st, label: st[0].toUpperCase() + st.slice(1) }))} value={stageSel} onChange={setStageSel} />
          <Field label="Expected effect" hint={HINTS[s]}><input type="text" value={stageText} onChange={(e) => setFields({ ...fields, [s]: e.target.value })} /></Field></div>
        : <Field key={s} label={s} hint={HINTS[s]}><textarea rows={2} value={fields[s]} onChange={(e) => setFields({ ...fields, [s]: e.target.value })} /></Field>))}
      <div className="editor-actions"><span className="spacer" /><Button variant="ghost" onClick={onDone}>Cancel</Button>
        <AsyncButton variant="primary" run={submit} ok={existing ? 'Case updated — request an assessment next' : 'Connector proposed — request its assessment next'}>{existing ? 'Save case' : 'Propose connector'}</AsyncButton></div>
    </div>
  );
}

function ApproveForm({ c }) {
  const [type, setType] = useState(c.binding?.type || 'http');
  const [url, setUrl] = useState(c.binding?.url || '');
  const [command, setCommand] = useState(c.binding?.command || '');
  const [args, setArgs] = useState((c.binding?.args || []).join(' '));
  const [tools, setTools] = useState(c.tools || []);
  const [days, setDays] = useState(30);
  const [note, setNote] = useState('');
  return (
    <div className="case-form">
      <ChipGroup label="How the desk reaches it" options={[{ value: 'http', label: 'HTTPS endpoint' }, { value: 'stdio', label: 'Local program' }]} value={type} onChange={setType} />
      {type === 'http' ? <Field label="https URL"><input type="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>
        : <><Field label="Program (absolute path on this Mac)"><input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/Users/…/.venv/bin/python3" /></Field>
          <Field label="Arguments" hint="Separated by spaces."><input type="text" value={args} onChange={(e) => setArgs(e.target.value)} /></Field>
          <p className="warn">A local program runs outside the sandbox with your user's file access. The desk removes its own credentials and allows only the tools below; it cannot confine the program.</p></>}
      <ChipInput label="Tools a seat may call" values={tools} onChange={setTools} normalize={(s) => (/^[A-Za-z0-9_.-]{1,80}$/.test(s.trim()) ? s.trim() : null)} placeholder="Exact tool names, Enter after each" />
      <ChipGroup label="Re-evaluate after" size="compact" options={[14, 30, 60, 90, 180].map((n) => ({ value: n, label: `${n} days` }))} value={days} onChange={setDays} />
      <Field label="Note for the record"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="editor-actions"><span className="spacer" /><AsyncButton variant="primary" run={async () => {
        const binding = type === 'http' ? { type, url: url.trim() } : { type, command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] };
        await api('POST', `/api/connectors/${c.name}/approve`, { binding, tools, review_after_days: days, note }); await refresh();
      }} ok={`${c.name} approved — programs can select it now`}>Approve {c.name}</AsyncButton></div>
    </div>
  );
}

function ConnectorCard({ c: raw }) {
  const c = { ...raw, has_case: !!String(raw.case_md || '').trim() };
  const [mode, setMode] = useState(null); // 'case' | 'reject' | 'retire'
  const [reason, setReason] = useState('');
  const amap = agentMap();
  const failed = c.status === 'proposed' && /assessment failed|interrupted/.test(c.decision_note || '');
  const a = c.assessment;
  const by = (id) => (id === 'owner' ? 'you' : id === 'config' ? 'the config file' : amap[id]?.name || id);
  return (
    <article className="connector">
      <div className="connector-h"><b>{c.name}</b>
        {['rejected', 'retired'].includes(c.status) ? <Chip tone={c.status === 'rejected' ? 'red' : ''}>{c.status === 'rejected' ? 'Rejected' : 'Retired'}</Chip>
          : <StatusSteps label={`${c.name} status`} steps={STEPS} current={STEP_OF[c.status]} failed={failed} />}
        {c.due_for_review && <Chip tone="amber">Re-evaluate</Chip>}</div>
      <p>{c.purpose || 'No purpose written yet.'}</p>
      <p className="muted small">Proposed by {by(c.proposed_by)}{c.assessed_by ? `, assessed by ${by(c.assessed_by)}` : ''}{c.approved_at ? `, approved ${ago(c.approved_at)}; re-evaluate by ${String(c.review_after).slice(0, 10)}` : ''}.</p>
      {a && <>
        <div className="facts-row"><Chip tone={a.verdict === 'recommend' ? 'green' : 'red'}>{a.verdict === 'recommend' ? 'Recommended' : 'Declined'}</Chip><Chip>Benefit {a.benefit_score}/5</Chip>
          <Chip>{a.sdlc_stage}</Chip><Chip tone={a.risk === 'high' ? 'red' : a.risk === 'medium' ? 'amber' : ''}>{a.risk} risk</Chip></div>
        <p>{a.rationale}</p>
        <div className="kv"><div className="kv-row"><span>Cost</span>{a.cost_estimate}</div><div className="kv-row"><span>Time</span>{a.time_estimate}</div><div className="kv-row"><span>Data leaving</span>{a.data_leaving}</div>
          {a.conditions?.length > 0 && <div className="kv-row"><span>Conditions</span>{a.conditions.join('; ')}</div>}</div>
      </>}
      {c.status === 'approved' && <p className="small">{c.binding?.type === 'stdio' ? 'Local program' : 'HTTPS endpoint'}; tools: {c.tools.join(', ')}</p>}
      {c.usage?.runs > 0 && <p className="muted small">Used in {c.usage.runs} session{c.usage.runs === 1 ? '' : 's'} costing ${c.usage.cost_usd}; {c.usage.proposals} proposal{c.usage.proposals === 1 ? '' : 's'}, {c.usage.passed_review} passed review. Last used {ago(c.usage.last_used_at)}.</p>}
      {c.decision_note && <p className={failed ? 'red-t small' : 'muted small'}>{c.decision_note}</p>}
      {c.has_case ? <Disclosure id={`case-${c.name}`} summary="The case"><pre className="prose wrap">{c.case_md}</pre></Disclosure> : <p className="warn">No case written yet. Write it before asking for an assessment.</p>}
      {c.status === 'assessed' && <ApproveForm c={c} />}
      {mode === 'case' && <CaseForm existing={c} onDone={() => setMode(null)} />}
      {['reject', 'retire'].includes(mode) && <div className="row-actions"><input type="text" aria-label={`Reason to ${mode}`} placeholder="Reason, for the record" value={reason} onChange={(e) => setReason(e.target.value)} />
        <AsyncButton variant="danger" run={async () => { await api('POST', `/api/connectors/${c.name}/${mode}`, { reason }); setMode(null); await refresh(); }} ok={mode === 'reject' ? `${c.name} rejected` : `${c.name} retired`}>{mode === 'reject' ? 'Reject' : 'Retire'}</AsyncButton>
        <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button></div>}
      {!mode && <div className="row-actions">
        {['proposed', 'assessed', 'rejected'].includes(c.status) && <Button onClick={() => setMode('case')}>{c.has_case ? 'Edit case' : 'Write the case'}</Button>}
        {['proposed', 'assessed', 'rejected'].includes(c.status) && c.has_case && <AsyncButton variant={c.status === 'proposed' ? 'primary' : undefined} run={async () => { await api('POST', `/api/connectors/${c.name}/assess`, {}); await refresh(); }}
          ok="Assessment requested — another seat reviews the case">{c.status === 'proposed' ? 'Request assessment' : 'Assess again'}</AsyncButton>}
        {c.status === 'assessing' && <span className="muted small">Being assessed…</span>}
        {['proposed', 'assessing', 'assessed'].includes(c.status) && <Button variant="ghost" onClick={() => setMode('reject')}>Reject</Button>}
        {c.status === 'approved' && <Button variant="danger" onClick={() => setMode('retire')}>Retire</Button>}
      </div>}
    </article>
  );
}

export function Connectors() {
  const [proposing, setProposing] = useState(false);
  const list = S.research?.connectors || [];
  return (
    <section className="rs-section" id="connectors" aria-labelledby="h-connectors">
      <h3 id="h-connectors">Connectors</h3>
      <p className="rs-intro">A connector gives researchers a source the web cannot, such as a paper index or your knowledge base. Each one needs a written case, an assessment by another seat, and your approval with the exact tools allowed. Usage and results are tracked for the re-evaluation.</p>
      {list.map((c) => <ConnectorCard key={c.name} c={c} />)}
      {proposing ? <CaseForm onDone={() => setProposing(false)} /> : <div className="row-actions"><Button onClick={() => setProposing(true)}>Propose a connector</Button></div>}
    </section>
  );
}
