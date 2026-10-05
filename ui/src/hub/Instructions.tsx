// The front door: tell any project's team what to do, then land on that request in its desk. The draft (text,
// project, options and its request id) is kept on this device until the desk confirms the ticket, so a retry after a
// timeout or a reload never creates a second one. Below: your recent requests across every desk and where each stands.
import { useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ChoiceChips } from '@/components/desk/Choices';
import { Tag } from '@/components/desk/Layout';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Draft = { text: string; project: string; kind: 'auto' | 'feature'; priority: string; request_id: string };
const KEY = 'sd.hub.instruction';
const newId = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
const load = (): Draft => { try { return { text: '', project: '', kind: 'auto', priority: 'P2', request_id: newId(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { text: '', project: '', kind: 'auto', priority: 'P2', request_id: newId() }; } };

export function Composer({ projects, onSent }: { projects: Any[]; onSent: () => void }) {
  const [d, setD] = useState<Draft>(load);
  const [busy, setBusy] = useState<'' | 'sending'>('');
  const [problem, setProblem] = useState<Any | null>(null);
  // A changed request is a new request: a retry of the same text keeps its id (the desk returns the same ticket), an
  // edit gets a fresh one (reusing it for different text would be refused).
  const set = (patch: Partial<Draft>) => setD((x) => {
    const changed = (['text', 'project', 'kind', 'priority'] as const).some((k) => k in patch && patch[k] !== x[k]);
    const n = { ...x, ...patch, ...(changed ? { request_id: newId() } : {}) };
    localStorage.setItem(KEY, JSON.stringify(n)); return n;
  });
  // Last used project, else the only/first one.
  useEffect(() => { if (!d.project && projects.length) set({ project: projects[0].id }); }, [projects.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = projects.find((p) => p.id === d.project);
  const send = async () => {
    if (d.text.trim().length < 3) { toast('Write what the team should do first.', true); return; }
    if (!target) { toast('Choose a project.', true); return; }
    setBusy('sending'); setProblem(null);
    const sent = { ...d };
    try {
      const res = await fetch('/api/hub/instructions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ project: sent.project, text: sent.text, kind: sent.kind, priority: sent.priority, request_id: sent.request_id }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProblem({ ...j, error: j.error || `HTTP ${res.status}` });
        if (res.status === 409 && !j.offline) setD((x) => { const n = { ...x, request_id: newId() }; localStorage.setItem(KEY, JSON.stringify(n)); return n; }); // that id is spent
        return;
      }
      // Confirmed: forget exactly the request that was sent (the box was locked meanwhile), keep the project.
      const stored = load();
      if (stored.request_id === sent.request_id) localStorage.setItem(KEY, JSON.stringify({ text: '', project: d.project, kind: 'auto', priority: 'P2', request_id: newId() }));
      toast(j.duplicate ? `Already sent as ${j.key}; opening it` : `Sent to ${j.name} as ${j.key}`);
      onSent();
      window.location.href = j.url;
    } catch { setProblem({ error: 'No answer from the Projects home. Send again: it will not create a second ticket.', unknown: true }); }
    finally { setBusy(''); }
  };
  return (
    <section aria-label="Tell a team what to do" className="grid gap-3 rounded-lg border bg-card p-4">
      <label htmlFor="instruction" className="text-[17px] font-semibold">What should the team do?</label>
      <Textarea id="instruction" rows={4} maxLength={8000} value={d.text} readOnly={!!busy} onChange={(e) => set({ text: e.target.value })}
        placeholder="Fix the stale quote badge on the positions page; it should turn grey after 30 seconds without a tick." />
      <div className="grid gap-1.5">
        <span className="text-sm text-muted-foreground">Project</span>
        <div role="radiogroup" aria-label="Project" className="flex flex-wrap gap-2">{projects.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={d.project === p.id} disabled={!!busy} onClick={() => set({ project: p.id })}
            className={cn('min-h-10 rounded-full border px-3.5 text-sm', d.project === p.id ? 'border-primary bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {p.name}{!p.summary?.online && <span className="text-muted-foreground"> (stopped)</span>}</button>))}</div>
      </div>
      <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Options</summary>
        <div className="mt-3 grid gap-3">
          <ChoiceChips label="How" size="sm" value={d.kind} onChange={(kind) => set({ kind })}
            options={[{ value: 'auto', label: 'Let the team decide' }, { value: 'feature', label: 'Plan it first (feature)' }]} />
          <ChoiceChips label="Priority" size="sm" value={d.priority as 'P1' | 'P2' | 'P3'} onChange={(priority) => set({ priority })}
            options={[{ value: 'P1', label: 'High' }, { value: 'P2', label: 'Normal' }, { value: 'P3', label: 'Low' }]} />
        </div></details>
      {problem && <p role="alert" className="text-sm text-blocked">{problem.error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button data-send disabled={!!busy} onClick={send} className="max-md:flex-1">{busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{target ? `Send to ${target.name}` : 'Send'}<ArrowRight className="size-4" aria-hidden /></Button>
        <span className="text-[13px] text-muted-foreground">It becomes a ticket: the team triages it, plans it if needed, assigns an engineer, and you follow it on the desk.</span>
      </div>
    </section>
  );
}

export function Recent({ projects }: { projects: Any[] }) {
  const rows = projects.flatMap((p) => (p.summary?.recent_requests || []).map((r: Any) => ({ ...r, project: p.id, projectName: p.name, url: p.url })))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 12);
  // Not shown: stopped desks, and desks that answered with an error (for example refused the hub's sign-in).
  const offline = projects.filter((p) => !p.summary?.online || p.summary?.error);
  if (!rows.length && !offline.length) return null;
  return (
    <section aria-label="Your instructions" className="grid gap-2">
      <h2 className="text-[17px] font-semibold">Your instructions</h2>
      {rows.length ? <ul className="grid gap-2">{rows.map((r) => (
        <li key={`${r.project}:${r.key}`} data-request={`${r.project}:${r.key}`}>
          <a href={withNext(r.url, `#/inbox/${r.key}`)} className={cn('grid gap-1 rounded-lg border bg-card p-3 hover:bg-secondary/60', r.needs_you && 'border-l-[3px] border-l-needs')}>
            <span className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
              <Tag tone={r.needs_you ? 'needs' : r.done ? 'shipped' : 'neutral'}>{r.closed ? 'Closed' : r.needs_you ? 'Needs you' : r.done ? 'Done' : `Step ${r.step} of ${r.of}`}</Tag>
              <span>{r.projectName}</span><span className="font-mono">{r.key}</span></span>
            <span className="font-medium">{r.name || r.title}</span>
            <span className="text-sm text-muted-foreground">{r.line}{r.who_name && !r.done && !r.closed ? ` · ${r.who_name}` : ''}</span>
          </a></li>))}</ul>
        : <p className="text-sm text-muted-foreground">Nothing sent yet.</p>}
      {offline.length > 0 && <p className="text-[13px] text-muted-foreground">Not shown: requests on {offline.map((p) => p.name).join(', ')} (not running or not reachable).</p>}
    </section>
  );
}
// The desk link from the hub state carries the sign-in token (once); add the request to land on.
function withNext(url: string, next: string) {
  if (!url) return '#';
  return url.includes('?token=') ? `${url}&next=${encodeURIComponent(next)}` : `${url.replace(/\/$/, '/')}${next}`;
}
