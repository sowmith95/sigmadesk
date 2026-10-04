import { useState } from 'react';
import { Check } from 'lucide-react';
import { S, api, agentMap, loadResearch, loadSnapshot } from '@/store.js';
import { ago } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { ChoiceChips, MultiChips } from '@/components/desk/Choices';
import { Field, TokenInput } from '@/components/desk/Fields';
import { Tag } from '@/components/desk/Bits';
import { Disclose } from '@/components/desk/Work';
import { cn } from '@/lib/utils';
import type { Connector } from '@/types';

const STEPS = ['Proposed', 'Assessing', 'Assessed', 'Approved'];
const STEP_OF: Record<string, string> = { proposed: 'Proposed', assessing: 'Assessing', assessed: 'Assessed', approved: 'Approved' };
const HINTS: Record<string, string> = {
  'Purpose': 'What this connector is, in a sentence or two.', 'Benefit to the application': 'Which programs or seats gain what they cannot do today.',
  'How it is used': 'Which tools, in which runs, read-only or not.', 'SDLC stage improved': 'The measurable effect you expect at that stage.',
  'Cost': 'Price or credits per call, calls per session, monthly estimate.', 'Time': 'Setup effort, delay per call, upkeep.',
  'Data leaving the machine': 'What is sent out, and to whom.', 'Risks and fallback': 'What can go wrong, and what research does instead.', 'Success measure': 'How you will know in 30 days that it earned its place.',
};
const refresh = () => Promise.all([loadResearch(), loadSnapshot().catch(() => {})]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseCase(md: string, sections: string[]) {
  return Object.fromEntries(sections.map((s) => {
    const start = md.search(new RegExp(`^## ${esc(s)}\\s*$`, 'im'));
    if (start < 0) return [s, ''];
    const after = md.slice(start).replace(/^.*\n/, '');
    const next = after.search(/^## /m);
    return [s, (next < 0 ? after : after.slice(0, next)).trim()];
  })) as Record<string, string>;
}

/** Ordered lifecycle (a real sequence, so steps are justified). */
function Steps({ current, failed }: { current: string; failed?: boolean }) {
  const at = STEPS.indexOf(current);
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[13px]" aria-label="Connector status">
      {STEPS.map((s, i) => <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('inline-flex items-center gap-1.5', i < at ? 'text-foreground' : i === at ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
        {i > 0 && <span aria-hidden className="h-px w-4 bg-border" />}
        <span aria-hidden className={cn('grid size-4 place-items-center rounded-full border', i < at && 'border-shipped bg-shipped text-background', i === at && (failed ? 'border-blocked bg-blocked' : 'border-primary bg-primary'))}>{i < at && <Check className="size-3" />}</span>{s}</li>)}
    </ol>
  );
}

/** Guided case: one short field per required section, composed into the markdown case the server validates. */
function CaseForm({ existing, onDone }: { existing?: Connector; onDone: () => void }) {
  const sections: string[] = S.research?.sections || Object.keys(HINTS);
  const stages: string[] = S.research?.stages || ['discovery', 'design', 'implementation', 'qa', 'review', 'operations'];
  const initial = existing ? parseCase(existing.case_md || '', sections) : {} as Record<string, string>;
  const [name, setName] = useState(existing?.name || '');
  const [purpose, setPurpose] = useState(existing?.purpose || '');
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries(sections.map((s) => [s, initial[s] || ''])));
  const [stageSel, setStageSel] = useState<string[]>(() => stages.filter((st) => new RegExp(`\\b${st}\\b`, 'i').test(initial['SDLC stage improved'] || '')));
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
    <div className="grid gap-4 rounded-lg border bg-card p-5">
      {!existing && <Field label="Name" hint="Lowercase with dashes; this is how programs refer to it." id="conn-name">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={name} maxLength={40} placeholder="paper-search" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />}</Field>}
      <Field label="In one line" id="conn-purpose">{({ id }) => <Input id={id} value={purpose} maxLength={200} placeholder="Search arXiv, PubMed and Semantic Scholar for papers" onChange={(e) => setPurpose(e.target.value)} />}</Field>
      {sections.map((s) => (s === 'SDLC stage improved'
        ? <div key={s} className="grid gap-3"><MultiChips label="Stage of the work it improves" options={stages.map((st) => ({ value: st, label: st[0].toUpperCase() + st.slice(1) }))} value={stageSel} onChange={setStageSel} />
          <Field label="Expected effect" hint={HINTS[s]}>{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={stageText} onChange={(e) => setFields({ ...fields, [s]: e.target.value })} />}</Field></div>
        : <Field key={s} label={s} hint={HINTS[s]}>{({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={2} value={fields[s]} onChange={(e) => setFields({ ...fields, [s]: e.target.value })} />}</Field>))}
      <div className="flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={onDone}>Cancel</Button>
        <AsyncButton run={submit} ok={existing ? 'Case updated; request an assessment next' : 'Connector proposed; request its assessment next'}>{existing ? 'Save case' : 'Propose connector'}</AsyncButton></div>
    </div>
  );
}

function ApproveForm({ c }: { c: Connector }) {
  const [type, setType] = useState(c.binding?.type || 'http');
  const [url, setUrl] = useState(c.binding?.url || '');
  const [command, setCommand] = useState(c.binding?.command || '');
  const [args, setArgs] = useState((c.binding?.args || []).join(' '));
  const [tools, setTools] = useState<string[]>(c.tools || []);
  const [days, setDays] = useState('30');
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-4 rounded-md border p-4">
      <ChoiceChips label="How the desk reaches it" options={[{ value: 'http', label: 'HTTPS endpoint' }, { value: 'stdio', label: 'Local program' }]} value={type} onChange={setType} />
      {type === 'http' ? <Field label="https URL">{({ id }) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />}</Field> : <>
        <Field label="Program (absolute path on this Mac)">{({ id }) => <Input id={id} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/Users/…/.venv/bin/python3" />}</Field>
        <Field label="Arguments" hint="Separated by spaces.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={args} onChange={(e) => setArgs(e.target.value)} />}</Field>
        <p className="rounded-md bg-needs/15 px-3 py-2 text-sm">A local program runs outside the sandbox with your user's file access. The desk removes its own credentials and allows only the tools below; it cannot confine the program.</p></>}
      <TokenInput label="Tools a seat may call" values={tools} onChange={setTools} normalize={(s) => (/^[A-Za-z0-9_.-]{1,80}$/.test(s.trim()) ? s.trim() : null)} invalidText="Tool names use letters, digits, dot, dash and underscore." placeholder="Exact tool names, Enter after each" />
      <ChoiceChips label="Re-evaluate after" size="sm" options={['14', '30', '60', '90', '180'].map((n) => ({ value: n, label: `${n} days` }))} value={days} onChange={setDays} />
      <Field label="Note for the record">{({ id }) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <AsyncButton className="justify-self-end" run={async () => {
        const binding = type === 'http' ? { type, url: url.trim() } : { type, command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] };
        await api('POST', `/api/connectors/${c.name}/approve`, { binding, tools, review_after_days: Number(days), note }); await refresh();
      }} ok={`${c.name} approved; programs can select it now`}>Approve {c.name}</AsyncButton>
    </div>
  );
}

function ConnectorCard({ c }: { c: Connector }) {
  const [mode, setMode] = useState<'case' | 'reject' | 'retire' | null>(null);
  const [reason, setReason] = useState('');
  const amap = agentMap();
  const hasCase = !!String(c.case_md || '').trim();
  const failed = c.status === 'proposed' && /assessment failed|interrupted/.test(c.decision_note || '');
  const a = c.assessment;
  const by = (id?: string | null) => (id === 'owner' ? 'you' : id === 'config' ? 'the config file' : (id && amap[id]?.name) || id);
  return (
    <article className="grid gap-3 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3"><b className="text-base">{c.name}</b>
        {['rejected', 'retired'].includes(c.status) ? <Tag tone={c.status === 'rejected' ? 'blocked' : 'neutral'}>{c.status === 'rejected' ? 'Rejected' : 'Retired'}</Tag> : <Steps current={STEP_OF[c.status]} failed={failed} />}
        {c.due_for_review && <Tag tone="needs">Re-evaluate</Tag>}</div>
      <p>{c.purpose || 'No purpose written yet.'}</p>
      <p className="text-sm text-muted-foreground">Proposed by {by(c.proposed_by)}{c.assessed_by ? `, assessed by ${by(c.assessed_by)}` : ''}{c.approved_at ? `, approved ${ago(c.approved_at)}; re-evaluate by ${String(c.review_after).slice(0, 10)}` : ''}.</p>
      {a && <div className="grid gap-2 rounded-md bg-background p-3">
        <div className="flex flex-wrap gap-1.5"><Tag tone={a.verdict === 'recommend' ? 'shipped' : 'blocked'}>{a.verdict === 'recommend' ? 'Recommended' : 'Declined'}</Tag><Tag>Benefit {a.benefit_score}/5</Tag><Tag>{a.sdlc_stage}</Tag><Tag tone={a.risk === 'high' ? 'blocked' : a.risk === 'medium' ? 'needs' : 'neutral'}>{a.risk} risk</Tag></div>
        <p>{a.rationale}</p>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-sm"><dt className="text-muted-foreground">Cost</dt><dd>{a.cost_estimate}</dd><dt className="text-muted-foreground">Time</dt><dd>{a.time_estimate}</dd><dt className="text-muted-foreground">Data leaving</dt><dd>{a.data_leaving}</dd>
          {a.conditions?.length > 0 && <><dt className="text-muted-foreground">Conditions</dt><dd>{a.conditions.join('; ')}</dd></>}</dl>
      </div>}
      {c.status === 'approved' && <p className="text-sm">{c.binding?.type === 'stdio' ? 'Local program' : 'HTTPS endpoint'}; tools: {c.tools.join(', ')}</p>}
      {(c.usage?.runs || 0) > 0 && <p className="text-sm text-muted-foreground">Used in {c.usage!.runs} session{c.usage!.runs === 1 ? '' : 's'} costing ${c.usage!.cost_usd}; {c.usage!.proposals} proposal{c.usage!.proposals === 1 ? '' : 's'}, {c.usage!.passed_review} passed review. Last used {ago(c.usage!.last_used_at)}.</p>}
      {c.decision_note && <p className={cn('text-sm', failed ? 'text-blocked' : 'text-muted-foreground')}>{c.decision_note}</p>}
      {hasCase ? <Disclose id={`case-${c.name}`} summary="The case"><pre className="whitespace-pre-wrap font-sans [overflow-wrap:anywhere]">{c.case_md}</pre></Disclose> : <p className="text-sm text-needs">No case written yet. Write it before asking for an assessment.</p>}
      {c.status === 'assessed' && <ApproveForm c={c} />}
      {mode === 'case' && <CaseForm existing={c} onDone={() => setMode(null)} />}
      {(mode === 'reject' || mode === 'retire') && <div className="flex flex-wrap gap-2"><Input aria-label={`Reason to ${mode}`} placeholder="Reason, for the record" value={reason} onChange={(e) => setReason(e.target.value)} className="min-w-60 flex-1" />
        <AsyncButton variant="destructive" run={async () => { await api('POST', `/api/connectors/${c.name}/${mode}`, { reason }); setMode(null); await refresh(); }} ok={mode === 'reject' ? `${c.name} rejected` : `${c.name} retired`}>{mode === 'reject' ? 'Reject' : 'Retire'}</AsyncButton>
        <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button></div>}
      {!mode && <div className="flex flex-wrap gap-2">
        {['proposed', 'assessed', 'rejected'].includes(c.status) && hasCase && <AsyncButton variant={c.status === 'proposed' ? 'default' : 'secondary'} run={async () => { await api('POST', `/api/connectors/${c.name}/assess`, {}); await refresh(); }}
          ok="Assessment requested; another seat reviews the case">{c.status === 'proposed' ? 'Request assessment' : 'Assess again'}</AsyncButton>}
        {['proposed', 'assessed', 'rejected'].includes(c.status) && <Button variant="secondary" onClick={() => setMode('case')}>{hasCase ? 'Edit case' : 'Write the case'}</Button>}
        {c.status === 'assessing' && <span className="self-center text-sm text-muted-foreground">Being assessed…</span>}
        {['proposed', 'assessing', 'assessed'].includes(c.status) && <Button variant="ghost" onClick={() => setMode('reject')}>Reject</Button>}
        {c.status === 'approved' && <Button variant="ghost" className="text-destructive" onClick={() => setMode('retire')}>Retire</Button>}
      </div>}
    </article>
  );
}

export function Connectors() {
  const [proposing, setProposing] = useState(false);
  const list: Connector[] = S.research?.connectors || [];
  return (
    <section id="connectors" aria-labelledby="connectors-h" className="grid scroll-mt-28 gap-3">
      <div className="flex flex-wrap items-center gap-3"><h2 id="connectors-h" className="text-base font-semibold">Connectors</h2><span className="flex-1" />{!proposing && <Button variant="secondary" onClick={() => setProposing(true)}>Propose a connector</Button>}</div>
      <p className="max-w-[68ch] text-muted-foreground">A connector gives researchers a source the web cannot, such as a paper index or your knowledge base. Each one needs a written case, an assessment by another seat, and your approval with the exact tools allowed. Usage and results are tracked for the re-evaluation.</p>
      {proposing && <CaseForm onDone={() => setProposing(false)} />}
      {list.map((c) => <ConnectorCard key={c.name} c={c} />)}
      {!list.length && !proposing && <p className="text-muted-foreground">No connectors yet.</p>}
    </section>
  );
}
