// SigmaDesk Projects home: every project desk at a glance, and a setup wizard that asks what you are building, scans
// the repository read-only, recommends a team with reasons, and creates the desk once you approve. Mobile first; the
// draft survives reloads; nothing is created until the last step.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, FolderGit2, Loader2, Plus, Sparkles } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { ChoiceChips, MultiChips } from '@/components/desk/Choices';
import { Field, SwitchRow, TokenInput } from '@/components/desk/Fields';
import { Tag, Empty, Section } from '@/components/desk/Layout';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { teamCoverage } from '../../../src/team-catalog.js';
import { Composer, Recent } from './Instructions';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// ---------------- home ----------------
function ProjectCard({ p, onChanged }: { p: Any; onChanged: () => void }) {
  const s = p.summary || {};
  const state = !s.online ? { label: p.classic || p.state === 'installed' ? 'Not running' : 'Not started', tone: 'neutral' as const }
    : s.needs_you ? { label: `${s.needs_you} need${s.needs_you === 1 ? 's' : ''} you`, tone: 'needs' as const }
      : s.paused ? { label: 'Paused', tone: 'neutral' as const } : { label: s.working ? `${s.working} working` : 'Ready', tone: 'shipped' as const };
  return (
    <article data-project={p.id} className={cn('grid content-start gap-3 rounded-lg border bg-card p-4', s.needs_you && 'border-l-[3px] border-l-needs')}>
      <div className="flex flex-wrap items-center gap-2"><Tag tone={state.tone}>{state.label}</Tag>{p.classic && <Tag>Original desk</Tag>}<span className="flex-1" /><span className="font-mono text-[13px] text-muted-foreground">:{p.port}</span></div>
      <h3 className="text-[17px] font-semibold leading-snug">{p.name}</h3>
      <p className="truncate text-sm text-muted-foreground" title={p.repoPath}>{p.repoPath}</p>
      {s.online && s.error && <p className="text-sm text-muted-foreground">Running. Open it to see its work.</p>}
      {s.online && !s.error && <p className="text-sm text-muted-foreground">{s.working || 0} working, {s.queued || 0} queued{s.blocked ? `, ${s.blocked} blocked` : ''}. Spent ${Number(s.spend_today || 0).toFixed(2)} of ${Number(s.budget || 0).toFixed(0)} today.</p>}
      <div className="flex flex-wrap gap-2">
        {s.online ? <Button asChild><a href={p.url}>Open desk<ExternalLink className="size-4" aria-hidden /></a></Button>
          : !p.classic && <AsyncButton run={async () => { await api('POST', `/api/hub/projects/${p.id}/start`, {}); setTimeout(onChanged, 2500); }} ok="Starting the desk">Start desk</AsyncButton>}
      </div>
    </article>
  );
}

function Home({ onNew }: { onNew: () => void }) {
  const [st, setSt] = useState<Any | null>(null);
  const load = () => api('GET', '/api/hub/state').then(setSt).catch((e) => setSt({ error: e.message, projects: [] }));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  if (!st) return <p className="text-muted-foreground">Loading projects…</p>;
  const projects = st.projects || [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {st.error && <p className="text-blocked">{st.error}</p>}
      {projects.length > 0 && <Composer projects={projects} onSent={load} />}
      <Recent projects={projects} />
      <Section title="Projects" count={projects.length} actions={<Button onClick={onNew}><Plus className="size-4" aria-hidden />Add a project</Button>}>
        {projects.length ? <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2 xl:grid-cols-3">{projects.map((p: Any) => <ProjectCard key={p.id} p={p} onChanged={load} />)}</div>
          : <Empty title="No projects yet" action={<Button onClick={onNew}>Add your first project</Button>}>Point SigmaDesk at a repository; it asks what you are building and recommends a team.</Empty>}
      </Section>
      <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">Project data lives in {st.appRoot}. Each project runs its own desk on its own port.</p>
    </div>
  );
}

// ---------------- wizard ----------------
const STEPS = ['Repository', 'What we found', 'Your goals', 'Team', 'Review'];
const DRAFT = 'sd.hub.draft.v1';
type Draft = { step: number; repoPath: string; name: string; scan: Any | null; answers: Any; rec: Any | null; custom: Any[] };
const blank = (): Draft => ({ step: 0, repoPath: '', name: '', scan: null, rec: null, custom: [],
  answers: { summary: '', audience: '', firstGoal: '', neverBreak: [], neverTouchPaths: [], domains: [], authority: 'prs', budgetUsd: 25,
    quietHours: { enabled: false, label: 'Busy hours', start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }, research: { enabled: false }, watchLogs: false } });
const loadDraft = (): Draft => { try { const d = JSON.parse(localStorage.getItem(DRAFT) || 'null'); return d?.answers ? { ...blank(), ...d } : blank(); } catch { return blank(); } };

function Progress({ step }: { step: number }) {
  return (
    <ol aria-label="Setup steps" className="flex gap-1.5">
      {STEPS.map((s, i) => <li key={s} className="grid flex-1 gap-1" aria-current={i === step ? 'step' : undefined}>
        <span className={cn('h-1.5 rounded-full', i < step ? 'bg-shipped' : i === step ? 'bg-primary' : 'bg-secondary')} />
        <span className={cn('hidden text-xs sm:block', i === step ? 'text-foreground' : 'text-muted-foreground')}>{s}</span></li>)}
    </ol>
  );
}
const Chips = ({ items }: { items: string[] }) => <div className="flex flex-wrap gap-1.5">{items.length ? items.map((x) => <span key={x} className="rounded-full bg-secondary px-3 py-1 text-sm">{x}</span>) : <span className="text-sm text-muted-foreground">None found</span>}</div>;
const Card = ({ title, children }: { title: ReactNode; children: ReactNode }) => <section className="grid gap-2 rounded-lg border bg-card p-4"><h3 className="text-[15px] font-semibold">{title}</h3>{children}</section>;

function StepRepo({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const [repos, setRepos] = useState<Any[]>([]);
  useEffect(() => { api('GET', '/api/hub/repos').then((r) => setRepos(r.repos || [])).catch(() => {}); }, []);
  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground">Which repository is this desk for? It must be a git checkout on this machine. SigmaDesk reads it; it does not change it.</p>
      <Field label="Repository folder" id="repo-path">{({ id }) => <Input id={id} autoFocus value={d.repoPath} placeholder="~/projects/my-app" onChange={(e) => set({ repoPath: e.target.value, scan: null, rec: null })} />}</Field>
      <Field label="Project name" id="repo-name" hint="Shown on the desk and the Projects page.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={d.name} placeholder={d.repoPath.split('/').filter(Boolean).pop() || 'My app'} onChange={(e) => set({ name: e.target.value })} />}</Field>
      {repos.length > 0 && <div className="grid gap-2"><span className="text-sm text-muted-foreground">Repositories on this machine</span>
        <div className="grid gap-1.5 sm:grid-cols-2">{repos.map((r) => <button key={r.path} type="button" onClick={() => set({ repoPath: r.path, name: d.name || r.name, scan: null, rec: null })}
          className={cn('flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-left hover:bg-secondary', d.repoPath === r.path && 'border-primary bg-primary/10')}><FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 truncate">{r.name}</span></button>)}</div></div>}
    </div>
  );
}

function StepFound({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const s = d.scan!;
  const areas = s.areas || [];
  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground">Read from the repository's files; nothing was run. Correct anything that is wrong: it shapes the team.</p>
      <Card title="Languages"><Chips items={(s.languages || []).map((l: Any) => `${l.name} (${l.files})`)} /></Card>
      <Card title="Stack"><Chips items={s.stack || []} /></Card>
      <Card title="Parts of the codebase"><MultiChips label="Parts" hideLabel value={areas} onChange={(v) => set({ scan: { ...s, areas: v }, rec: null })}
        options={[{ value: 'frontend', label: 'User interface' }, { value: 'backend', label: 'Server' }, { value: 'db', label: 'Database' }, { value: 'infra', label: 'Infrastructure' }]} /></Card>
      <Card title="Tests"><Chips items={(s.tests || []).map((t: Any) => t.command)} />{!(s.tests || []).length && <p className="text-sm text-needs">No test command found. The playbook should say how to prove a change works.</p>}</Card>
      <Card title="CI and deploys">
        <p className="text-sm"><span className="text-muted-foreground">Runs on pull requests: </span>{s.ci?.pullRequestWorkflows?.join(', ') || 'nothing'}</p>
        <p className="text-sm"><span className="text-muted-foreground">Deploys or publishes: </span>{s.ci?.deployWorkflows?.join(', ') || 'nothing detected'}</p>
      </Card>
      <p className="text-[13px] text-muted-foreground">{s.files} tracked files · base branch {s.repo?.baseBranch}{s.repo?.githubRepo ? ` · GitHub ${s.repo.githubRepo}` : ' · no GitHub remote'}</p>
    </div>
  );
}

function StepGoals({ d, setA, questions }: { d: Draft; setA: (p: Any) => void; questions: Any | null }) {
  const a = d.answers;
  const q = a.quietHours;
  const opts = (k: string) => (questions?.[k] || []).map(([value, label]: [string, string]) => ({ value, label }));
  return (
    <div className="grid gap-5">
      <Field label="What does it do?" id="g-summary">{({ id }) => <Textarea id={id} rows={3} value={a.summary} placeholder="A dashboard that shows my open positions and risk in real time." onChange={(e) => setA({ summary: e.target.value })} />}</Field>
      <Field label="Who uses it?" id="g-audience">{({ id }) => <Input id={id} value={a.audience} placeholder="Me, during market hours, mostly on my phone" onChange={(e) => setA({ audience: e.target.value })} />}</Field>
      <Field label="What should the desk work on first?" id="g-first">{({ id }) => <Textarea id={id} rows={2} value={a.firstGoal} placeholder="Fix the flaky login, then add CSV export." onChange={(e) => setA({ firstGoal: e.target.value })} />}</Field>
      <MultiChips label="What kind of project is it?" value={a.domains} onChange={(v) => setA({ domains: v })} options={opts('domains')} />
      <MultiChips label="What must never break?" value={a.neverBreak} onChange={(v) => setA({ neverBreak: v })} options={opts('neverBreak')} />
      <TokenInput label="Paths the desk must never change without you" values={a.neverTouchPaths} onChange={(v: string[]) => setA({ neverTouchPaths: v })} placeholder="e.g. infra/** or src/payments/**" />
      <ChoiceChips label="What may the desk do on its own?" value={a.authority} onChange={(v) => setA({ authority: v })} options={opts('authority')} />
      <p className="-mt-3 text-[13px] text-muted-foreground">You always approve merges. QA and code review run on every change.</p>
      <div className="grid gap-3 rounded-lg border bg-card p-4">
        <SwitchRow label="Quiet hours for deploying merges" hint="Merges that deploy wait outside these hours unless you override." checked={q.enabled} onChange={(v) => setA({ quietHours: { ...q, enabled: v } })} />
        {q.enabled && <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" id="q-label">{({ id }) => <Input id={id} value={q.label} onChange={(e) => setA({ quietHours: { ...q, label: e.target.value } })} />}</Field>
          <Field label="From" id="q-start">{({ id }) => <Input id={id} type="time" value={q.start} onChange={(e) => setA({ quietHours: { ...q, start: e.target.value } })} />}</Field>
          <Field label="To" id="q-end">{({ id }) => <Input id={id} type="time" value={q.end} onChange={(e) => setA({ quietHours: { ...q, end: e.target.value } })} />}</Field>
          <MultiChips className="sm:col-span-3" label="Days" size="sm" value={q.days.map(String)} onChange={(v) => setA({ quietHours: { ...q, days: v.map(Number) } })}
            options={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => ({ value: String(i), label: n }))} />
        </div>}
      </div>
      <Field label="Daily spending limit (USD)" id="g-budget" hint="Runs stop for the day when it is reached.">{({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} step={5} inputMode="decimal" className="w-32" value={a.budgetUsd} onChange={(e) => setA({ budgetUsd: Number(e.target.value) })} />}</Field>
      <div className="grid gap-3 rounded-lg border bg-card p-4">
        <SwitchRow label="Research ideas for me" hint="A product manager reads the code and your field and proposes features, each checked by a second seat." checked={!!a.research?.enabled} onChange={(v) => setA({ research: { enabled: v } })} />
        <SwitchRow label="Watch my error logs" hint="An on-call engineer investigates recurring errors. You connect the logs later." checked={!!a.watchLogs} onChange={(v) => setA({ watchLogs: v })} />
      </div>
    </div>
  );
}

function StepTeam({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const rec = d.rec!;
  const [showMore, setShowMore] = useState(false);
  const [c, setC] = useState({ name: '', role: '', lens: '', pattern: '' });
  const toggleCore = (id: string, on: boolean) => set({ rec: { ...rec, core: rec.core.map((x: Any) => (x.id === id ? { ...x, on } : x)) } });
  const toggleAdv = (id: string, on: boolean) => set({ rec: { ...rec, advisors: rec.advisors.map((x: Any) => (x.id === id ? { ...x, on } : x)) } });
  const gaps = teamCoverage(rec.core.map((x: Any) => ({ id: x.id, enabled: x.on })));
  const recommended = rec.advisors.filter((a: Any) => a.suggested);
  const others = rec.advisors.filter((a: Any) => !recommended.includes(a));
  const Row = ({ x, on, onChange, required }: { x: Any; on: boolean; onChange: (v: boolean) => void; required?: boolean }) => (
    <li className={cn('grid gap-1 rounded-lg border bg-card p-3', !on && 'opacity-60')} data-seat={x.id}>
      <div className="flex items-center gap-2"><b className="min-w-0 flex-1">{x.name ? `${x.name}, ${x.role}` : x.role}</b>
        {required ? <Tag>Required</Tag> : <Switch aria-label={`${on ? 'Remove' : 'Add'} ${x.role}`} checked={on} onCheckedChange={onChange} />}</div>
      <p className="text-sm text-muted-foreground">{x.why}</p>
      {x.evidence?.length > 0 && <p className="text-[13px] text-muted-foreground">Because: {x.evidence.join('; ')}</p>}
    </li>
  );
  return (
    <div className="grid gap-5">
      <p className="text-muted-foreground">The smallest team that covers your project. Each seat says why it is here; switch off what you do not need.</p>
      {gaps.length > 0 && <p role="alert" className="rounded-md bg-blocked/15 px-3 py-2 text-sm">Not enough to run: {gaps.join('; ')}.</p>}
      <Section title="Engineering team" count={rec.core.filter((x: Any) => x.on).length}>
        <ul className="grid gap-2 md:grid-cols-2">{rec.core.map((x: Any) => <Row key={x.id} x={x} on={x.on} required={x.required} onChange={(v) => toggleCore(x.id, v)} />)}</ul>
      </Section>
      <Section title="Advisors" count={rec.advisors.filter((x: Any) => x.on).length + d.custom.length}>
        <p className="-mt-1 text-sm text-muted-foreground">Advisors review plans from their angle and can research. They never write code and never block approval.</p>
        <ul className="grid gap-2 md:grid-cols-2">{recommended.map((x: Any) => <Row key={x.id} x={x} on={x.on} onChange={(v) => toggleAdv(x.id, v)} />)}
          {d.custom.map((x, i) => <li key={x.id} className="grid gap-1 rounded-lg border bg-card p-3"><div className="flex items-center gap-2"><b className="min-w-0 flex-1">{x.name}, {x.role}</b>
            <Button size="sm" variant="ghost" onClick={() => set({ custom: d.custom.filter((_, j) => j !== i) })}>Remove</Button></div><p className="text-sm text-muted-foreground">{x.lens}</p></li>)}</ul>
        <Button variant="ghost" className="justify-self-start" onClick={() => setShowMore(!showMore)}>{showMore ? 'Hide' : `More advisors (${others.length})`}</Button>
        {showMore && <ul className="grid gap-2 md:grid-cols-2">{others.map((x: Any) => <Row key={x.id} x={x} on={x.on} onChange={(v) => toggleAdv(x.id, v)} />)}</ul>}
        <details className="rounded-lg border bg-card p-3"><summary className="cursor-pointer font-medium">Add your own advisor</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Name" id="c-name">{({ id }) => <Input id={id} value={c.name} placeholder="Pat" onChange={(e) => setC({ ...c, name: e.target.value })} />}</Field>
            <Field label="Role" id="c-role">{({ id }) => <Input id={id} value={c.role} placeholder="Payments Advisor" onChange={(e) => setC({ ...c, role: e.target.value })} />}</Field>
            <Field className="sm:col-span-2" label="What they check" id="c-lens">{({ id }) => <Textarea id={id} rows={2} value={c.lens} placeholder="Refunds, idempotency and reconciliation in every payment change." onChange={(e) => setC({ ...c, lens: e.target.value })} />}</Field>
            <Field className="sm:col-span-2" label="Join reviews that mention (words, separated by |)" id="c-pattern">{({ id }) => <Input id={id} value={c.pattern} placeholder="refund|checkout|payment" onChange={(e) => setC({ ...c, pattern: e.target.value })} />}</Field>
            <Button variant="secondary" className="justify-self-start" disabled={!c.name.trim() || !c.role.trim() || !c.lens.trim()} onClick={() => {
              const id = `${c.role || c.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'advisor';
              set({ custom: [...d.custom, { id: /^[a-z]/.test(id) ? id : `a-${id}`, name: c.name.trim(), role: c.role.trim(), lens: `You are ${c.name.trim()}, ${c.role.trim()}. ${c.lens.trim()}`, triggers: { pattern: c.pattern.trim() } }] });
              setC({ name: '', role: '', lens: '', pattern: '' });
            }}>Add advisor</Button>
          </div></details>
      </Section>
    </div>
  );
}

function StepReview({ d, done }: { d: Draft; done: Any | null }) {
  const a = d.answers; const rec = d.rec!;
  const team = [...rec.core.filter((x: Any) => x.on).map((x: Any) => x.role), ...rec.advisors.filter((x: Any) => x.on).map((x: Any) => x.role), ...d.custom.map((x) => x.role)];
  const auth = ({ build: 'plan and build on branches; you open pull requests', prs: 'plan, build and open pull requests', 'merge-ready': 'open pull requests and queue merges after your approval' } as Any)[a.authority];
  if (done) return (
    <div className="grid gap-4 rounded-lg border border-shipped/40 bg-shipped/10 p-5">
      <p className="flex items-center gap-2 text-lg font-semibold"><Check className="size-5 text-shipped" aria-hidden />{d.name || 'The project'} has a desk</p>
      <p>{done.started ? 'It is starting in the background, paused. Open it, look around, then press Start on the desk when you are ready.' : `It was created but did not start: ${done.startError}. Start it from the Projects page.`}</p>
      <div className="flex flex-wrap gap-2"><Button asChild><a href={done.url}>Open the desk<ExternalLink className="size-4" aria-hidden /></a></Button></div>
    </div>
  );
  return (
    <div className="grid gap-3">
      <Card title="Project"><p>{d.name || d.scan?.repo?.name} at <span className="font-mono text-sm">{d.repoPath}</span></p><p className="text-sm text-muted-foreground">{(d.scan?.stack || []).join(', ')}</p></Card>
      {a.summary && <Card title="What it does"><p>{a.summary}</p>{a.audience && <p className="text-sm text-muted-foreground">Used by: {a.audience}</p>}</Card>}
      <Card title={`Team of ${team.length}`}><Chips items={team} /></Card>
      <Card title="Rules"><ul className="grid list-disc gap-1 pl-5 text-[15px]">
        <li>The desk may {auth}. You always approve merges.</li>
        {a.neverBreak.length > 0 && <li>Must never break: {a.neverBreak.join(', ')}.</li>}
        {a.neverTouchPaths.length > 0 && <li>Never change without you: {a.neverTouchPaths.join(', ')}.</li>}
        <li>{a.quietHours.enabled ? `${a.quietHours.label}: ${a.quietHours.start} to ${a.quietHours.end}; deploying merges wait.` : 'No quiet hours.'}</li>
        <li>Spending limit ${a.budgetUsd} a day.</li></ul></Card>
      <Card title="What happens when you create it"><ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
        <li>A folder for this project in your SigmaDesk application folder, with its config, team and playbook.</li>
        <li>A background service that runs its desk on its own port. It starts paused: nothing runs until you press Start on the desk.</li>
        <li>The repository itself is not changed.</li></ul></Card>
    </div>
  );
}

function Wizard({ onExit }: { onExit: () => void }) {
  const [d, setD] = useState<Draft>(loadDraft);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Any | null>(null);
  const [questions, setQuestions] = useState<Any | null>(null);
  useEffect(() => { api('GET', '/api/hub/catalog').then((c) => setQuestions(c.questions)).catch(() => {}); }, []);
  const set = (p: Partial<Draft>) => setD((x) => { const n = { ...x, ...p }; localStorage.setItem(DRAFT, JSON.stringify(n)); return n; });
  const setA = (p: Any) => set({ answers: { ...d.answers, ...p } });
  const gaps = useMemo(() => (d.rec ? teamCoverage(d.rec.core.map((x: Any) => ({ id: x.id, enabled: x.on }))) : []), [d.rec]);
  const go = async (to: number) => {
    if (to > d.step) {
      setBusy(true);
      try {
        if (d.step === 0) { if (!d.repoPath.trim()) throw new Error('Pick a repository first.'); const scan = await api('POST', '/api/hub/scan', { repoPath: d.repoPath.trim() }); set({ scan, name: d.name || scan.repo.name, step: to }); return; }
        if (d.step === 2 && (!d.rec || to === 3)) { const rec = await api('POST', '/api/hub/recommend', { scan: d.scan, answers: d.answers }); set({ rec, step: to }); return; }
        if (d.step === 3 && gaps.length) throw new Error(`The team is not ready: ${gaps.join('; ')}`);
      } catch (e) { toast((e as Error).message, true); return; } finally { setBusy(false); }
    }
    set({ step: to }); window.scrollTo(0, 0);
  };
  const create = async () => {
    const team = { version: 1, advisors: [...d.rec!.advisors.filter((x: Any) => x.on).map((x: Any) => x.id), ...d.custom], core: Object.fromEntries(d.rec!.core.filter((x: Any) => !x.required && !x.on).map((x: Any) => [x.id, { enabled: false }])) };
    const out = await api('POST', '/api/hub/projects', { repoPath: d.repoPath.trim(), name: d.name.trim(), answers: d.answers, scan: d.scan, team });
    setDone(out); localStorage.removeItem(DRAFT);
  };
  const body = d.step === 0 ? <StepRepo d={d} set={set} /> : d.step === 1 ? <StepFound d={d} set={set} /> : d.step === 2 ? <StepGoals d={d} setA={setA} questions={questions} />
    : d.step === 3 ? <StepTeam d={d} set={set} /> : <StepReview d={d} done={done} />;
  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-5 pb-28">
      <div className="flex items-center gap-2"><Button variant="ghost" size="sm" className="-ml-2" onClick={onExit}><ArrowLeft className="size-4" aria-hidden />Projects</Button><span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => { localStorage.removeItem(DRAFT); setD(blank()); setDone(null); }}>Start over</Button></div>
      <Progress step={d.step} />
      <h2 className="text-2xl font-semibold">{['Pick the repository', 'What we found', 'Tell us about it', 'Your recommended team', 'Review and create'][d.step]}</h2>
      {body}
      {!done && <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-3 backdrop-blur pb-[calc(env(safe-area-inset-bottom)+12px)] md:static md:border-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          {d.step > 0 && <Button variant="secondary" onClick={() => go(d.step - 1)}><ArrowLeft className="size-4" aria-hidden />Back</Button>}
          <span className="flex-1" />
          {d.step < 4 ? <Button disabled={busy} onClick={() => go(d.step + 1)}>{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{d.step === 0 ? 'Scan repository' : d.step === 2 ? 'Recommend a team' : 'Next'}<ArrowRight className="size-4" aria-hidden /></Button>
            : <AsyncButton run={create} ok="Desk created"><Sparkles className="size-4" aria-hidden />Create the desk</AsyncButton>}
        </div></div>}
    </div>
  );
}

export function HubApp() {
  const [view, setView] = useState(location.hash === '#/new' ? 'new' : 'home');
  useEffect(() => { const on = () => setView(location.hash === '#/new' ? 'new' : 'home'); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const nav = (v: string) => { location.hash = v === 'new' ? '#/new' : '#/'; setView(v); };
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3"><span aria-hidden className="text-2xl font-semibold leading-none text-primary">σ</span>
          <h1 className="text-lg font-semibold">SigmaDesk <span className="font-normal text-muted-foreground">Projects</span></h1><span className="flex-1" />
          {view === 'new' && <span className="text-sm text-muted-foreground">New project</span>}</div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6">{view === 'new' ? <Wizard onExit={() => nav('home')} /> : <Home onNew={() => nav('new')} />}</main>
      <Toaster position="top-center" />
    </div>
  );
}
