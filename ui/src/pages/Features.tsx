// Features: one readable document per feature, groomed with Codex before any work starts.
// The list shows every top-level feature by where it stands; a feature's document shows the owner's request, the plan,
// its tasks and the grooming session (rounds with Codex, a reply box, and approval). Nothing builds until you approve.
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, CircleDot, ExternalLink, Loader2 } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { S, api, openFeature, openTicket, openSheet, closeSheet, loadFeature, planFor, setView, agentMap, draftKey, setDraft } from '@/store.js';
import { ago, plural } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { ChoiceChips } from '@/components/desk/Choices';
import { Field } from '@/components/desk/Fields';
import { Tag, Key, Empty, Section, SeatAvatar, type Tone } from '@/components/desk/Bits';
import { Markdown } from '@/components/desk/Markdown';
import { STAGE_LABEL } from '@/components/desk/Work';
import { cn } from '@/lib/utils';
import type { FeaturePlan, PlanTask, Ticket } from '@/types';

const isFeature = (t: Ticket) => t.type === 'feature' && !t.parent_key;
const kidsOf = (key: string) => S.tickets.filter((x: Ticket) => x.parent_key === key);

type Stand = 'review' | 'planning' | 'building' | 'unplanned' | 'shipped' | 'closed';
function standOf(t: Ticket, p: FeaturePlan | null): { stand: Stand; label: string; tone: Tone } {
  if (t.status === 'done') return { stand: 'shipped', label: 'Shipped', tone: 'shipped' };
  if (t.status === 'wontdo') return { stand: 'closed', label: 'Closed', tone: 'neutral' };
  if (p?.status === 'ready') return { stand: 'review', label: p.stale ? 'Plan out of date' : 'Plan ready', tone: 'needs' };
  if (p?.status === 'failed') return { stand: 'review', label: 'Grooming failed', tone: 'blocked' };
  if (p?.status === 'grooming') return { stand: 'planning', label: 'Grooming with Codex', tone: 'action' };
  if (p?.status === 'queued') return { stand: 'planning', label: 'Waiting for Codex', tone: 'neutral' };
  if (kidsOf(t.key).length) return { stand: 'building', label: 'Building', tone: 'action' };
  return { stand: 'unplanned', label: p?.status === 'discarded' ? 'Plan set aside' : 'Not planned yet', tone: 'neutral' };
}

function Progress({ keys }: { keys: string[] }) {
  const kids = keys.map((k) => S.tickets.find((x: Ticket) => x.key === k)).filter(Boolean) as Ticket[];
  if (!kids.length) return null;
  const done = kids.filter((k) => k.status === 'done').length;
  const closed = kids.filter((k) => k.status === 'wontdo').length;
  const pct = Math.round(((done + closed) / kids.length) * 100);
  return (
    <div className="grid gap-1.5">
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tasks settled">
        <div className="h-full rounded-full bg-shipped transition-[width]" style={{ width: `${pct}%` }} /></div>
      <span className="text-[13px] text-muted-foreground">{done} of {plural(kids.length, 'task')} shipped{closed ? `, ${closed} not doing` : ''}</span>
    </div>
  );
}

function FeatureCard({ t }: { t: Ticket }) {
  const p = planFor(t.key) as FeaturePlan | null;
  const s = standOf(t, p);
  const kids = kidsOf(t.key);
  const people = [...new Set(kids.map((k) => k.assignee).filter(Boolean))] as string[];
  const line = p?.plan?.summary || String(t.description || '').split('\n').find((l) => l.trim() && !l.startsWith('<!--')) || 'No description yet.';
  return (
    <article data-feature={t.key} className={cn('grid content-start gap-3 rounded-lg border bg-card p-4', s.stand === 'review' && 'border-l-[3px] border-l-needs')}>
      <div className="flex flex-wrap items-center gap-2"><Tag tone={s.tone}>{s.stand === 'planning' && p?.status === 'grooming' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}{s.label}</Tag>
        {t.priority && t.priority !== 'P2' && <Tag>{t.priority}</Tag>}<Key k={t.key} /><span className="flex-1" />
        <span className="text-[13px] text-muted-foreground">{ago(t.updated_at)}</span></div>
      <h3 className="text-[17px] font-semibold leading-snug"><button type="button" className="text-left hover:underline" onClick={() => openFeature(t.key)}>{t.title}</button></h3>
      <p className="line-clamp-2 text-muted-foreground">{line.replace(/[#*`]/g, '')}</p>
      {kids.length > 0 && <Progress keys={kids.map((k) => k.key)} />}
      {people.length > 0 && <div className="flex items-center gap-1">{people.slice(0, 6).map((id) => <SeatAvatar key={id} id={id} />)}</div>}
    </article>
  );
}

function FeatureList() {
  const all = S.tickets.filter(isFeature) as Ticket[];
  const by = (st: Stand) => all.filter((t) => standOf(t, planFor(t.key)).stand === st).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const groups: [Stand, string, string][] = [['review', 'Needs your review', 'Read the plan, reply to Codex, or approve it to start work.'], ['planning', 'Planning', 'Morgan is grooming these with Codex.'],
    ['building', 'Building', 'Approved. The team is working through the tasks.'], ['unplanned', 'Not planned yet', 'Open one and plan it with Codex.'], ['shipped', 'Shipped', '']];
  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-start gap-4">
        <p className="max-w-[62ch] text-muted-foreground">Describe what you want. Morgan grooms it with Codex into a plan you can read in two minutes. You reply or approve, and approval creates the tasks. Each approved feature is mirrored to a GitHub issue with a task checklist.</p>
      </div>
      {!all.length && <Empty title="No features yet" action={<Button onClick={() => openSheet({ type: 'new-feature' })}>Describe your first feature</Button>}>A feature is something you want built, in your words. Codex turns it into a plan before anyone writes code.</Empty>}
      {groups.map(([st, title, hint]) => { const items = by(st); if (!items.length) return null; return (
        <Section key={st} title={title} count={items.length} tone={st === 'review' ? 'needs' : undefined}>
          {hint && <p className="-mt-1 text-sm text-muted-foreground">{hint}</p>}
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">{items.map((t) => <FeatureCard key={t.key} t={t} />)}</div>
        </Section>); })}
    </div>
  );
}

// ---------------- document ----------------
const Bullets = ({ items, empty }: { items: string[]; empty?: string }) => items.length
  ? <ul className="grid list-disc gap-1.5 pl-5 marker:text-muted-foreground">{items.map((x, i) => <li key={i}><Markdown text={x} /></li>)}</ul>
  : empty ? <p className="text-muted-foreground">{empty}</p> : null;
function DocSection({ title, children, tone }: { title: string; children: ReactNode; tone?: 'needs' }) {
  return <section className={cn('grid gap-2', tone === 'needs' && 'rounded-lg border border-needs/40 bg-needs/10 p-4')}><h3 className="text-[15px] font-semibold">{title}</h3>{children}</section>;
}

function RequestEditor({ t, request }: { t: Ticket; request: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(request);
  const [title, setTitle] = useState(t.title);
  useEffect(() => { if (!editing) { setText(request); setTitle(t.title); } }, [request, t.title, editing]);
  if (!editing) return (
    <DocSection title="Your request">
      {request ? <Markdown text={request} self={t.key} /> : <p className="text-muted-foreground">No description yet.</p>}
      <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setEditing(true)}>Edit request</Button>
    </DocSection>
  );
  return (
    <DocSection title="Your request">
      <Field label="Name" id="feature-title">{({ id }) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="What it should do, and for whom" id="feature-request" hint="A plan written for the old text is marked out of date; ask Codex for a new round after editing.">
        {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={8} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      <div className="flex gap-2"><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
        <AsyncButton run={async () => {
          try { await api('PATCH', `/api/tickets/${t.key}`, { title, description: text, expected_updated_at: t.updated_at }); }
          catch (e) { if ((e as { status?: number }).status === 409) await loadFeature(); throw e; }
          setEditing(false); await loadFeature();
        }} ok="Request saved">Save request</AsyncButton></div>
    </DocSection>
  );
}

type Edit = { include: boolean; title: string; complexity: 'S' | 'M' };
function PlanTasks({ p, edits, setEdits, editable }: { p: FeaturePlan; edits: Record<string, Edit>; setEdits: (e: Record<string, Edit>) => void; editable: boolean }) {
  const tasks = p.plan!.tasks;
  const keys = p.task_keys || {};
  const live = (ref: string) => S.tickets.find((x: Ticket) => x.key === keys[ref]) as Ticket | undefined;
  const titleOf = (ref: string | null) => tasks.find((x) => x.ref === ref)?.title || ref;
  return (
    <ol className="grid gap-2">
      {tasks.map((x: PlanTask, i) => {
        const e = edits[x.ref] || { include: true, title: x.title, complexity: x.complexity };
        const set = (patch: Partial<Edit>) => setEdits({ ...edits, [x.ref]: { ...e, ...patch } });
        const k = live(x.ref);
        return (
          <li key={x.ref} data-task={x.ref} className={cn('grid gap-2 rounded-lg border bg-card p-3', editable && !e.include && 'opacity-55')}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-secondary font-mono text-xs" aria-hidden>{i + 1}</span>
              {editable ? <Input aria-label={`Task ${i + 1} title`} value={e.title} disabled={!e.include} onChange={(ev) => set({ title: ev.target.value })} className="h-9 min-w-0 flex-1 basis-56" />
                : k ? <button type="button" className="min-w-0 flex-1 text-left font-medium hover:underline" onClick={() => openTicket(k.key)}>{k.title}</button>
                  : <span className="min-w-0 flex-1 font-medium">{x.title}</span>}
              {editable && <Switch aria-label={`Include task ${i + 1}`} checked={e.include} onCheckedChange={(v) => set({ include: v })} />}
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-8 text-[13px]">
              {editable ? <ChoiceChips label={`Task ${i + 1} size`} hideLabel size="sm" value={e.complexity} onChange={(v) => set({ complexity: v })} options={[{ value: 'S', label: 'Small' }, { value: 'M', label: 'Medium' }]} />
                : <Tag>{x.complexity === 'S' ? 'Small' : 'Medium'}</Tag>}
              <Tag>{x.area}</Tag>{x.risk === 'high' && <Tag tone="blocked">High risk</Tag>}
              {x.after && <span className="text-muted-foreground">after “{titleOf(x.after)}”</span>}
              {k && <><span className="flex-1" />{k.assignee && <SeatAvatar id={k.assignee} />}<Tag tone={k.status === 'done' ? 'shipped' : k.status === 'needs_human' ? 'needs' : 'neutral'}>{STAGE_LABEL[k.status] || k.status}</Tag><Key k={k.key} /></>}
            </div>
            <details className="pl-8 text-[15px]"><summary className="cursor-pointer text-sm text-muted-foreground">What to build and how to check it</summary>
              <div className="mt-2 grid gap-2"><Markdown text={x.description} />{x.acceptance.length > 0 && <Bullets items={x.acceptance} />}</div></details>
          </li>
        );
      })}
    </ol>
  );
}

function SessionStatus({ p }: { p: FeaturePlan | null }) {
  const groom = S.meta.groom || {};
  if (!p) return <p className="text-muted-foreground">Not planned yet. Morgan grooms it on Codex: reads the code, then writes the goal, scope, acceptance criteria, risks and tasks.</p>;
  if (p.status === 'queued') return <p className="flex items-center gap-2"><CircleDot className="size-4 text-muted-foreground" aria-hidden />Round {p.revision} is waiting for Codex{groom.ready === false ? `: ${groom.reason || 'Codex is not available'}` : '.'}</p>;
  if (p.status === 'grooming') {
    const last = [...S.events].reverse().find((e) => e.run_id === p.run_id && ['say', 'tool', 'action'].includes(e.kind));
    return <div className="grid gap-1"><p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-primary" aria-hidden />Codex is grooming round {p.revision}.</p>
      {last && <p className="line-clamp-2 pl-6 text-sm text-muted-foreground">{String(last.text).replace(/^\$\s*/, '')}</p>}</div>;
  }
  if (p.status === 'failed') return <p className="text-blocked">Round {p.revision} failed: {p.error || 'no reason recorded'}.</p>;
  if (p.status === 'discarded') return <p className="text-muted-foreground">You set this plan aside. Nothing starts until you approve a plan.</p>;
  if (p.status === 'approved') return <p className="flex items-center gap-2"><Check className="size-4 text-shipped" aria-hidden />You approved round {p.revision} {p.approved_at ? ago(p.approved_at) : ''}. The tasks are on the board.</p>;
  return <p>{p.stale ? 'You edited the request after this plan was written. Ask Codex for a new round before approving.' : `Round ${p.revision} is ready for you.`}</p>;
}

function Session({ t, p, history, edits }: { t: Ticket; p: FeaturePlan | null; history: FeaturePlan[]; edits: Record<string, Edit> }) {
  const dk = draftKey(t.key, `plan-${p?.revision || 0}`);
  const [text, setText] = useState<string>(S.drafts[dk] || '');
  useEffect(() => { setText(S.drafts[dk] || ''); }, [dk]);
  const edit = (v: string) => { setText(v); setDraft(dk, v); };
  const act = (action: string, extra: Record<string, unknown> = {}) => async () => {
    try { await api('POST', `/api/features/${t.key}/plan`, { action, expected_revision: p?.revision, ...extra }); }
    catch (e) { if ((e as { status?: number }).status === 409) await loadFeature(); throw e; }
    if (['revise', 'start', 'approve'].includes(action)) { setDraft(dk, ''); setText(''); }
    await loadFeature();
  };
  const canReply = !p || ['ready', 'failed', 'discarded'].includes(p.status);
  const closed = ['done', 'wontdo'].includes(t.status);
  const rounds = history.filter((h) => h.revision < (p?.revision || 0));
  const included = p?.plan ? p.plan.tasks.filter((x) => edits[x.ref]?.include !== false).length : 0;
  return (
    <aside aria-label="Grooming session" className={cn('grid content-start gap-4 rounded-lg border bg-card p-4 lg:sticky lg:top-20', p?.status !== 'approved' && !closed && 'max-lg:order-first')}>
      <div className="flex items-center gap-2"><SeatAvatar id="manager" size="md" /><div className="grid"><b>Grooming with Codex</b><span className="text-[13px] text-muted-foreground">{agentMap().manager?.name || 'Morgan'}, Engineering Manager{p?.model ? `, ${String(p.model).replace(':', ' · ')}` : ''}</span></div></div>
      <SessionStatus p={p} />
      {rounds.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Earlier rounds ({rounds.length})</summary>
        <ol className="mt-2 grid gap-2">{rounds.map((h) => <li key={h.revision} className="grid gap-1 rounded-md bg-secondary p-2.5">
          <span className="text-xs text-muted-foreground">Round {h.revision}{h.plan ? `, ${plural(h.plan.tasks.length, 'task')}` : `, ${h.status}`}</span>
          {h.direction && <p><span className="text-muted-foreground">You: </span>{h.direction}</p>}{h.plan && <p className="text-muted-foreground">{h.plan.summary}</p>}</li>)}</ol></details>}
      {p?.direction && <p className="rounded-md bg-primary/10 px-3 py-2 text-sm"><span className="text-muted-foreground">Your note for this round: </span>{p.direction}</p>}
      {!closed && canReply && <div className="grid gap-2">
        <Textarea id="plan-reply" aria-label={p ? 'Reply to Codex' : 'Notes for Codex (optional)'} rows={3} maxLength={6000} value={text} onChange={(e) => edit(e.target.value)}
          placeholder={p ? 'Ask for changes: scope, order, a missing case, answers to its questions…' : 'Anything Codex should know first (optional).'} />
        {p ? <AsyncButton variant="secondary" run={async () => { if (!text.trim()) throw new Error('Write what should change first.'); await act('revise', { message: text })(); }} ok="Sent; Codex starts a new round">Send to Codex</AsyncButton>
          : <AsyncButton run={act('start', { message: text })} ok="Queued; Codex is grooming it">Plan with Codex</AsyncButton>}
      </div>}
      {p?.status === 'ready' && !closed && <div className="grid gap-2 border-t pt-4">
        <AsyncButton size="lg" data-primary disabled={!!p.stale || !included} run={act('approve', { edits: Object.entries(edits).map(([ref, e]) => ({ ref, ...e })) })}
          ok="Approved; tasks created and work starts">{`Approve plan and start ${plural(included, 'task')}`}</AsyncButton>
        <p className="text-[13px] text-muted-foreground">Approving creates the tasks, mirrors the feature to GitHub, and starts work in order. QA, code review and your merge approval still apply.</p>
        <AsyncButton variant="ghost" className="justify-self-start" confirm="Set this plan aside? Nothing starts until you approve a plan." run={act('discard')} ok="Plan set aside">Set aside</AsyncButton>
      </div>}
      {p?.status === 'failed' && !closed && <AsyncButton variant="secondary" run={act('retry')} ok="Queued again">Retry round {p.revision}</AsyncButton>}
    </aside>
  );
}

function FeatureDoc({ fkey }: { fkey: string }) {
  const fd = S.featureDetail;
  const t = S.tickets.find((x: Ticket) => x.key === fkey) as Ticket | undefined;
  const p = (planFor(fkey) as FeaturePlan | null) || (fd?.data?.plan as FeaturePlan | null) || null;
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  useEffect(() => { setEdits({}); }, [p?.revision, p?.status]);
  if (!t || !isFeature(t)) return (
    <div className="grid gap-4"><Button variant="ghost" className="justify-self-start" onClick={() => setView('features')}><ArrowLeft className="size-4" />All features</Button>
      <p className="text-muted-foreground">{fd?.error || (t ? 'This ticket is not a top-level feature.' : 'Loading…')}</p>
      {t && <Button variant="secondary" className="justify-self-start" onClick={() => openTicket(t.key)}>Open the ticket</Button>}</div>
  );
  const s = standOf(t, p);
  const plan = p?.plan;
  const request = fd?.data?.request ?? '';
  const repo = S.meta.repo;
  const kids = kidsOf(t.key);
  const planned = new Set(Object.values(p?.task_keys || {}));
  const extra = kids.filter((k) => !planned.has(k.key));
  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <Button variant="ghost" size="sm" className="-ml-2 justify-self-start" onClick={() => setView('features')}><ArrowLeft className="size-4" aria-hidden />All features</Button>
        <div className="flex flex-wrap items-center gap-2"><Tag tone={s.tone}>{s.label}</Tag>{t.priority && <Tag>{t.priority}</Tag>}<Key k={t.key} />
          {t.issue_number && repo && <a className="inline-flex items-center gap-1 text-sm text-primary hover:underline" href={`https://github.com/${repo}/issues/${t.issue_number}`} target="_blank" rel="noopener noreferrer">GitHub #{t.issue_number}<ExternalLink className="size-3.5" aria-hidden /></a>}
          <span className="flex-1" /><Button variant="ghost" size="sm" onClick={() => openTicket(t.key)}>Conversation and details</Button></div>
        <h2 className="text-2xl font-semibold leading-tight md:text-[28px]">{t.title}</h2>
        {kids.length > 0 && <div className="max-w-md"><Progress keys={kids.map((k) => k.key)} /></div>}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <article className="grid min-w-0 max-w-[72ch] gap-6 text-[16px] leading-relaxed">
          {plan && <p className="text-[18px] leading-relaxed">{plan.summary}</p>}
          <RequestEditor t={t} request={request} />
          {plan && <>
            <DocSection title="Goal"><Markdown text={plan.goal} /></DocSection>
            <DocSection title="Who it is for"><Bullets items={plan.users} /></DocSection>
            <div className="grid gap-6 md:grid-cols-2"><DocSection title="In scope"><Bullets items={plan.scope} /></DocSection><DocSection title="Out of scope"><Bullets items={plan.out_of_scope} empty="Nothing called out." /></DocSection></div>
            <DocSection title="Done when"><ul className="grid gap-1.5">{plan.acceptance.map((x, i) => <li key={i} className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-shipped" aria-hidden /><Markdown text={x} /></li>)}</ul></DocSection>
            {plan.risks.length > 0 && <DocSection title="Risks"><Bullets items={plan.risks} /></DocSection>}
            {plan.questions.length > 0 && p?.status !== 'approved' && <DocSection title="Questions for you" tone="needs"><Bullets items={plan.questions} /><p className="text-sm text-muted-foreground">Answer them in your reply to Codex, or approve if the plan's assumptions are fine.</p></DocSection>}
            <DocSection title={p?.status === 'approved' ? 'Tasks' : 'Proposed tasks'}>
              {p?.status === 'ready' && <p className="text-sm text-muted-foreground">Rename, resize or switch off tasks before approving. A task that depends on another needs both.</p>}
              <PlanTasks p={p!} edits={edits} setEdits={setEdits} editable={p?.status === 'ready'} />
            </DocSection>
          </>}
          {extra.length > 0 && <DocSection title={plan ? 'Other tasks' : 'Tasks'}><ul className="grid gap-1.5">{extra.map((k) => <li key={k.key} className="flex items-center gap-2"><button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => openTicket(k.key)}>{nameOf(k)}</button>
            {k.after_key && <span className="text-xs text-muted-foreground">after {k.after_key}</span>}<Tag tone={k.status === 'done' ? 'shipped' : 'neutral'}>{STAGE_LABEL[k.status] || k.status}</Tag></li>)}</ul></DocSection>}
        </article>
        <Session t={t} p={p} history={(fd?.data?.history || []) as FeaturePlan[]} edits={edits} />
      </div>
    </div>
  );
}

export default function FeaturesPage() {
  return S.feature ? <FeatureDoc fkey={S.feature} /> : <FeatureList />;
}

// ---------------- new feature ----------------
const newDraft = { title: '', goal: '', priority: 'P2', area: '' };
export function NewFeatureDialog() {
  const [d, setD] = useState({ ...newDraft });
  const set = (patch: Partial<typeof newDraft>) => setD((x) => { const n = { ...x, ...patch }; Object.assign(newDraft, n); return n; });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) closeSheet(); }}>
      <DialogContent className="max-h-[92dvh] gap-5 overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>New feature</DialogTitle><DialogDescription>Say what you want in your own words. Morgan grooms it with Codex into a plan; nothing is built until you approve it.</DialogDescription></DialogHeader>
        <Field label="Name" id="nf-title">{({ id }) => <Input id={id} autoFocus value={d.title} maxLength={200} placeholder="Options fill-cost journal" onChange={(e) => set({ title: e.target.value })} />}</Field>
        <Field label="What should it do, and for whom?" id="nf-goal" hint="The problem, who has it, what good looks like. Links and constraints help.">
          {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} rows={7} value={d.goal} placeholder="Record what each ETF4 options fill actually cost, so I can see slippage per strategy. Observe-only: never touch orders." onChange={(e) => set({ goal: e.target.value })} />}</Field>
        <ChoiceChips label="Priority" value={d.priority as 'P1' | 'P2' | 'P3'} onChange={(priority) => set({ priority })} options={[{ value: 'P1', label: 'High' }, { value: 'P2', label: 'Normal' }, { value: 'P3', label: 'Low' }]} />
        <ChoiceChips label="Mostly touches" value={(d.area || 'unsure') as string} onChange={(v) => set({ area: v === 'unsure' ? '' : v })}
          options={[{ value: 'unsure', label: 'Not sure' }, { value: 'backend', label: 'Backend' }, { value: 'frontend', label: 'Frontend' }, { value: 'fullstack', label: 'Both' }, { value: 'db', label: 'Database' }, { value: 'infra', label: 'Infra' }]} />
        <DialogFooter><Button variant="ghost" onClick={closeSheet}>Cancel</Button>
          <AsyncButton run={async () => {
            if (!d.title.trim()) throw new Error('Give the feature a name.');
            if (!d.goal.trim()) throw new Error('Describe what it should do.');
            const r = await api('POST', '/api/features', d);
            Object.assign(newDraft, { title: '', goal: '', priority: 'P2', area: '' });
            closeSheet(); openFeature(r.ticket.key);
          }} ok="Created; Codex is grooming it">Create and plan with Codex</AsyncButton></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
