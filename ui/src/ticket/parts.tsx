// Ticket panel sections. Behaviour is the v2/React-port behaviour; only presentation changed.
import { useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject } from 'react';
import { nameOf } from '../../../public/names.js';
import { conversationItems, nearLatest } from '../../../public/conversation.js';
import { safeGithubUrl } from '../../../public/prs-model.js';
import { S, api, agentMap, ticketByKey, openTicket, openSheet, loadDetail, loadSnapshot, prFor, councilFor, toast } from '@/store.js';
import { clean, hhmm, outcome, prNumber, questionText } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, Named, SeatAvatar } from '@/components/desk/Bits';
import { cardFor, EvidenceList, CiTag, Disclose, STAGE_LABEL, firstName } from '@/components/desk/Work';
import { cn } from '@/lib/utils';
import type { BoardItem, Ticket } from '@/types';

type Detail = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ConvState { agent: string; follow: boolean; top: number }

export function Block({ title, children, tone, className }: { title?: ReactNode; children: ReactNode; tone?: 'needs'; className?: string }) {
  return <section className={cn('grid gap-3 rounded-lg border bg-card p-4', tone === 'needs' && 'border-l-[3px] border-l-needs', className)}>{title && <h3 className="font-semibold">{title}</h3>}{children}</section>;
}
const Row = ({ k, children }: { k: string; children: ReactNode }) => <div className="grid gap-1 border-t pt-3 first:border-t-0 first:pt-0 md:grid-cols-[132px_1fr] md:gap-4"><span className="text-sm text-muted-foreground">{k}</span><div className="grid min-w-0 gap-2">{children}</div></div>;

export function Conversation({ d, live, tkey, state }: { d: Detail; live: boolean; tkey: string; state: MutableRefObject<ConvState> }) {
  const [, force] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const st = state.current;
  const amap = agentMap();
  const items = conversationItems({ ...d, agent: st.agent });
  const participants = [...new Set(conversationItems(d).map((i: { who: string }) => i.who))] as string[];
  const whoName = (id: string) => amap[id]?.name || ({ owner: 'You', system: 'Desk', github: 'GitHub' } as Record<string, string>)[id] || id;
  useLayoutEffect(() => { if (log.current) log.current.scrollTop = st.follow ? log.current.scrollHeight : st.top; });
  return (
    <section aria-label="Conversation" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">Show
          <select aria-label="Conversation participant" value={st.agent} onChange={(e) => { st.agent = e.target.value; st.follow = true; st.top = 0; force((n) => n + 1); }}
            className="h-9 rounded-md border border-input bg-background px-2 text-foreground"><option value="">Everyone</option>{participants.map((id) => <option key={id} value={id}>{whoName(id)}</option>)}</select></label>
        <span className="text-sm text-muted-foreground" role="status">{!S.connected ? 'Reconnecting…' : live ? 'Live' : 'Up to date'}</span>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" disabled={st.follow} onClick={() => { st.follow = true; force((n) => n + 1); }}>{st.follow ? 'Following latest' : 'Jump to latest'}</Button>
      </div>
      <div ref={log} role="region" aria-label="Task conversation" tabIndex={0} className="grid max-h-[58vh] min-h-48 content-start gap-3 overflow-y-auto overscroll-contain pr-1 [overflow-anchor:none]"
        onScroll={(e) => { st.top = e.currentTarget.scrollTop; const f = nearLatest(e.currentTarget); if (f !== st.follow) { st.follow = f; force((n) => n + 1); } }}>
        {items.length ? items.map((it: { id: string; who: string; text: string; kind: string; ts: string; runId?: number; steps?: { id: string; ts: string; raw: string }[] }) => {
          const mine = it.who === 'owner';
          const ask = String(it.text).startsWith('❓');
          const who = whoName(it.who);
          const run = S.runs.find((r: { id: number }) => r.id === it.runId);
          const meta = [amap[it.who]?.role, run?.model?.replace(':', ', ')].filter(Boolean).join(', ');
          if (it.kind === 'technical') return <div key={it.id} className="pl-11 text-[13px]"><Disclose id={`steps-${tkey}-${it.id}`} summary={`${who}: ${it.steps!.length} execution step${it.steps!.length === 1 ? '' : 's'}`}>
            <div className="whitespace-pre-wrap rounded-md bg-background p-2 font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{it.steps!.map((e) => <div key={e.id}><time dateTime={e.ts} className="opacity-70">{hhmm(e.ts)}</time> {e.raw}</div>)}</div></Disclose></div>;
          const text = ask ? questionText(it.text) : clean(it.text);
          const update = !['comment', 'say'].includes(it.kind);
          return (
            <article key={it.id} data-message={it.id} className={cn('flex items-start gap-2.5', mine && 'justify-end')}>
              {!mine && <SeatAvatar id={it.who} size="md" />}
              <div className={cn('grid min-w-0 gap-0.5 rounded-lg px-3 py-2', mine ? 'max-w-[88%] bg-primary/15' : 'flex-1 bg-secondary', ask && 'bg-needs/15', update && !ask && 'rounded-none border-l-2 border-muted-foreground bg-transparent py-1')}>
                <div className="flex flex-wrap items-baseline gap-2"><b className="text-sm">{ask ? `${who} asks you` : who}</b><time className="text-xs text-muted-foreground" dateTime={it.ts} title={new Date(it.ts).toLocaleString()}>{hhmm(it.ts)}</time></div>
                {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
                <div className="whitespace-pre-line [overflow-wrap:anywhere]">{text.length > 1200 ? <><Named text={`${text.slice(0, 800).trim()}…`} /> <Disclose id={`msg-${it.id}`} summary="Show all"><Named text={text} /></Disclose></> : <Named text={text} />}</div>
              </div>
            </article>
          );
        }) : <p className="text-muted-foreground">No recorded updates yet. Messages appear here as the team works.</p>}
      </div>
    </section>
  );
}

function CouncilView({ c }: { c: Detail | null }) {
  if (!c) return <p className="text-muted-foreground">Loading the council report…</p>;
  if (c.error) return <p className="text-blocked">Couldn't load the council: {c.error}</p>;
  let r: Detail | null = null;
  try { r = JSON.parse(c.result || 'null'); } catch { r = null; }
  return (
    <div className="grid gap-2">
      {c.stale && <p className="text-blocked">Ticket evidence changed since this council ran. Start a fresh council in Classic view before deciding.</p>}
      {r ? <>
        <p><Tag tone={r.verdict === 'approve' ? 'shipped' : 'needs'}>Verdict: {r.verdict}</Tag> <Named text={clean(r.recommendation)} /></p>
        {r.dissent?.length ? <div><p className="text-sm text-muted-foreground">Dissent</p><ul className="list-disc pl-5">{r.dissent.map((x: string, i: number) => <li key={i}>{clean(x)}</li>)}</ul></div> : <p className="text-sm text-muted-foreground">No dissent recorded.</p>}
        {r.conditions?.length > 0 && <div><p className="text-sm text-muted-foreground">Required validation</p><ul className="list-disc pl-5">{r.conditions.map((x: string, i: number) => <li key={i}>{clean(x)}</li>)}</ul></div>}
        {r.findings?.length > 0 && <Disclose id={`council-f-${c.id}`} summary={`Findings (${r.findings.length})`}><ul className="grid list-disc gap-2 pl-5">{r.findings.map((f: Detail, i: number) => <li key={i}><p>{f.severity}: {clean(f.issue)}</p><p className="text-sm text-muted-foreground">{clean(f.evidence)}</p></li>)}</ul></Disclose>}
      </> : c.result ? <p className="whitespace-pre-line">{clean(c.result)}</p> : <p className="text-muted-foreground">Council {c.status}.</p>}
    </div>
  );
}

export function Brief({ dec, t, d }: { dec: BoardItem; t: Ticket; d: Detail | null }) {
  const comments: Detail[] = d?.comments || [];
  const card = cardFor(t, d?.comments);
  const submit = [...comments].reverse().find((c) => /^🚀/.test(c.body) || /^Implementation note/i.test(c.body));
  const proposal = dec.kind === 'design' ? (d?.discussions || []).find((x: Detail) => x.id === dec.proposal_id) : null;
  const q = dec.kind === 'question' ? comments.filter((c) => String(c.body).startsWith('❓')).at(-1) : null;
  const strip = (x: string) => String(x).replace(new RegExp(`^\\s*${t.key}[a-z]?\\s*[:—-]\\s*`), '');
  const changed = dec.kind === 'question' ? outcome(card?.result?.summary || 'The engineer stopped to ask before going further.')
    : dec.kind === 'design' ? 'The manager finished a design recommendation for this ticket.'
      : dec.kind === 'research' ? "The independent second reviewer did not pass this research proposal; the author's revision allowance is used up or the reviewer rejected it."
        : dec.kind === 'council' ? 'The architecture council finished its review.'
          : outcome(strip(submit ? submit.body.split('\n').slice(1).join(' ').trim() || submit.body : card?.result?.summary || t.progress_msg || 'No change summary posted.'));
  const pr = prFor(t);
  const risk = ({
    merge: [pr ? `CI ${pr.checks}${pr.mergeable === 'CONFLICTING' ? ', conflicts with the base branch' : ''}.` : 'CI status not loaded yet.', 'Merging deploys production.'],
    publish: ['Approving pushes the branch and opens a draft PR. Nothing merges until you merge it.'],
    guard: ['The change touches protected paths or is unusually large. Approving pushes it and opens a draft PR.'],
    question: [`${firstName(t.assignee)} is paused until you answer.`],
    design: ['Approving records the design. Implementation, QA and merge keep their own gates.'],
    council: ['A council verdict records a design decision; implementation, QA and merge keep their own gates.'],
    research: ['Approving waives the second review (recorded as your verdict) and lets the manager groom it. Send back gives the author one more revision with your notes. Reject closes the proposal.'],
  } as Record<string, string[]>)[dec.kind || ''] || [];
  return (
    <Block tone="needs">
      <Row k="Your decision"><p className="font-semibold">{dec.verb}</p>
        {q && <p className="whitespace-pre-line rounded-md bg-needs/15 px-3 py-2"><Named text={clean(questionText(q.body))} /></p>}
        {dec.kind === 'design' && (proposal ? <div className="whitespace-pre-line rounded-md bg-background p-3"><p className="mb-1 text-sm text-muted-foreground">Recommendation #{proposal.id}</p><Named text={clean(proposal.response)} /></div>
          : <p className="text-muted-foreground">Loading recommendation #{dec.proposal_id}…</p>)}
        {dec.kind === 'council' && <CouncilView c={councilFor(dec.council_id)} />}
        {!q && !['design', 'council'].includes(dec.kind || '') && <p><Named text={clean(dec.reason)} /></p>}</Row>
      <Row k="Outcome"><p><Named text={changed} /></p></Row>
      {!['design', 'council'].includes(dec.kind || '') && <Row k="Evidence"><EvidenceList ev={card?.evidence} /></Row>}
      <Row k="Remaining risk">{risk.map((r, i) => <p key={i}>{r}</p>)}</Row>
    </Block>
  );
}

export function PrSummary({ t, dec }: { t: Ticket; dec: BoardItem | null }) {
  const n = prNumber(t.pr_url);
  const href = safeGithubUrl(t.pr_url);
  if (!n) {
    if (dec?.kind !== 'guard' && dec?.kind !== 'publish') return null;
    const files = (cardFor(t)?.evidence || []).find((e: { kind?: string }) => e.kind === 'files') as { files: string[] } | undefined;
    return <Block title="Change"><p>No PR yet, so the desk cannot show the diff.{t.branch && <> Branch <span className="font-mono [overflow-wrap:anywhere]">{t.branch}</span>.</>}</p>
      {files && <p className="text-sm text-muted-foreground">Engineer lists {files.files.length} file{files.files.length === 1 ? '' : 's'}: {files.files.map((f) => f.split('/').pop()).join(', ')}</p>}</Block>;
  }
  const pr = prFor(t);
  const r = S.detail?.data?.refresh;
  const refreshable = t.head_sha && ['needs_human', 'ready_for_human', 'todo'].includes(t.status) && (!r || ['rebased', 'published'].includes(r.status));
  return (
    <Block title={`Pull request #${n}`}>
      {pr ? <p className="flex flex-wrap items-center gap-2"><CiTag t={t} /><span className="font-mono text-sm">+{pr.additions} −{pr.deletions}</span><span className="text-sm text-muted-foreground">in {pr.files} files</span></p>
        : <p className="text-muted-foreground">{S.prsLoading ? 'Loading CI status from GitHub…' : S.prs?.error ? `GitHub status unavailable: ${S.prs.error}` : 'CI status not loaded.'}</p>}
      <p className="text-sm text-muted-foreground">Merging into {S.prs?.base || 'main'} deploys production.</p>
      {r && <p className="text-sm text-muted-foreground" role="status">Branch refresh: {r.status === 'conflicts' ? 'engineer resolving conflicts' : r.status === 'rebased' ? 'rebased, fresh validation in progress' : r.status === 'published' ? 'published after fresh QA' : 'preparing'}; base {r.base?.slice(0, 10) || 'pending'}</p>}
      <div className="flex flex-wrap gap-2">
        {dec?.kind !== 'merge' && <Button variant="secondary" onClick={() => openSheet({ type: 'pr', number: n })}>PR actions</Button>}
        {refreshable && <AsyncButton variant="secondary" disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/refresh-base`, { expected_updated_at: t.updated_at }, 300000); await loadSnapshot(); await loadDetail(); }} ok="Branch refreshed; engineer and fresh QA queued">Refresh branch & resume</AsyncButton>}
        {href && <Button variant="ghost" asChild><a href={href} target="_blank" rel="noopener noreferrer">Open on GitHub</a></Button>}
      </div>
    </Block>
  );
}

export function ProductReview({ t, d, msg, setMsg }: { t: Ticket; d: Detail | null; msg: string; setMsg: (s: string) => void }) {
  const reviews: Detail[] = d?.product_reviews || (S.meta.product_reviews || []).filter((r: Detail) => r.ticket_key === t.key);
  const amap = agentMap();
  const act = (r: Detail, action: string) => async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: r.phase, revision: r.revision, action, message: msg }); setMsg(''); await loadSnapshot(); await loadDetail(); };
  return (
    <Block title="Product & design review">
      {t.parent_key && (S.meta.product_reviews || []).some((r: Detail) => r.ticket_key === t.parent_key) && <Button variant="secondary" size="sm" className="justify-self-start" onClick={() => openTicket(t.parent_key!)}>View parent feature review</Button>}
      {reviews.length ? reviews.map((r) => (
        <div key={`${r.phase}-${r.revision}`} className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0">
          <p><b>{r.phase === 'plan' ? 'Before implementation' : 'User feedback'}</b> <Tag tone={r.status === 'approved' ? 'shipped' : r.stale || ['changes', 'failed'].includes(r.status) ? 'needs' : 'neutral'}>{r.stale ? 'Stale' : r.status}</Tag> <span className="text-sm text-muted-foreground">revision {r.revision}</span></p>
          <p className="text-sm text-muted-foreground">{r.status === 'reviewing' ? 'Independent perspectives, one bounded challenge round, then the engineering manager synthesizes.' : 'Every required perspective must support the plan. Objections remain visible.'}</p>
          {r.members.map((m: Detail) => <Disclose key={m.agent_id + m.stage} id={`product-${t.key}-${r.phase}-${r.revision}-${m.agent_id}`} summary={`${amap[m.agent_id]?.name || m.agent_id}, ${amap[m.agent_id]?.role || m.stage}: ${m.report?.verdict || m.status}`}>
            {m.report ? <>
              {m.initial_report && <p className="text-sm text-muted-foreground">Initial {m.initial_report.verdict}: {m.initial_report.recommendation}</p>}
              <p>{m.report.recommendation}</p>
              {['users', 'benefits', 'drawbacks', 'alternatives', 'evidence', 'conditions'].map((k) => <div key={k}><b className="text-sm">{k[0].toUpperCase() + k.slice(1)}</b><ul className="list-disc pl-5">{m.report[k].map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>)}
              {['architecture', 'rollout', 'success_metric'].map((k) => <p key={k}><b className="text-sm">{k.replace('_', ' ')}: </b>{m.report[k]}</p>)}
            </> : <p className="text-muted-foreground">{m.error || (m.status === 'pending' ? 'Waiting for capacity, provider availability, and preceding reviews.' : 'Review in progress.')}</p>}
          </Disclose>)}
          {r.status !== 'reviewing' && <>
            <Textarea rows={2} aria-label={`${r.phase} review correction`} placeholder="Correction or new evidence…" value={msg} onChange={(e) => setMsg(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <AsyncButton variant="secondary" run={act(r, 'revise')} ok="Review updated">Revise & review</AsyncButton>
              {r.status === 'failed' && !r.stale && <AsyncButton variant="secondary" run={act(r, 'retry')} ok="Review updated">Retry failed reviews</AsyncButton>}
              <AsyncButton variant="ghost" run={act(r, 'defer')} ok="Review updated">Defer plan</AsyncButton>
              <AsyncButton variant="ghost" className="text-destructive" run={act(r, 'reject')} ok="Review updated">Reject plan</AsyncButton>
            </div>
          </>}
        </div>
      )) : <p className="text-sm text-muted-foreground">New root feature plans get an independent product and architecture review before implementation. You can request one for this task.</p>}
      <div className="flex flex-wrap gap-2">
        {!reviews.some((r) => r.phase === 'plan') && !t.head_sha && <AsyncButton variant="secondary" disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: 'plan' }); await loadDetail(); }} ok="Product review queued">Review this plan</AsyncButton>}
        {!reviews.some((r) => r.phase === 'feedback') && t.head_sha && <AsyncButton variant="secondary" disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: 'feedback' }); await loadDetail(); }} ok="User feedback queued">Request user feedback</AsyncButton>}
      </div>
    </Block>
  );
}

export function ResearchReview({ t, d }: { t: Ticket; d: Detail | null }) {
  if (t.source !== 'research' || !t.research_review) return null;
  const sum = (S.meta.research_reviews || []).find((r: Detail) => r.ticket_key === t.key);
  const rows: Detail[] = (d?.research_reviews || []).slice().sort((a: Detail, b: Detail) => a.id - b.id);
  const amap = agentMap();
  const label = ({ pending: 'Awaiting second review', passed: 'Passed', changes: 'Changes requested', held: 'Held for you', waived: 'Waived by you' } as Record<string, string>)[t.research_review] || t.research_review;
  const blocks = ['pending', 'changes', 'held'].includes(t.research_review);
  return (
    <Block title="Independent research review">
      <p className="flex flex-wrap items-center gap-2"><Tag tone={['passed', 'waived'].includes(t.research_review) ? 'shipped' : blocks ? 'needs' : 'neutral'}>{label}</Tag>
        <span className="text-sm text-muted-foreground">Program {t.research_program || 'unknown'}, version {t.research_generation || 1}{sum && t.research_review === 'pending' ? `; ${sum.needed} more pass${sum.needed === 1 ? '' : 'es'} needed` : ''}</span></p>
      {sum?.reason && <p className="text-sm text-muted-foreground">{sum.reason}</p>}
      {rows.length ? <ul className="grid gap-2">{rows.map((r) => <li key={r.id} className="text-sm">
        <b>{r.reviewer === 'owner' ? 'You' : amap[r.reviewer]?.name || r.reviewer}</b> on version {r.generation}: {r.verdict || r.status}{r.report?.summary ? `. ${r.report.summary}` : ''}{r.report?.conditions?.length ? ` Conditions: ${r.report.conditions.join('; ')}` : ''}{r.error ? `. ${r.error}` : ''}</li>)}</ul>
        : <p className="text-sm text-muted-foreground">No reviewer has reported yet.</p>}
      {blocks && t.status !== 'needs_human' && <AsyncButton variant="secondary" className="justify-self-start" run={async () => {
        const note = window.prompt('Waive the independent second review? This is recorded as your verdict. Optional note:', '');
        if (note == null) return false;
        await api('POST', `/api/tickets/${t.key}/research-review/waive`, { note }); await loadSnapshot(); await loadDetail();
      }} ok="Review waived; the manager can groom it">Waive review</AsyncButton>}
    </Block>
  );
}

export function Details({ t, d }: { t: Ticket; d: Detail | null }) {
  const amap = agentMap();
  const worker = S.agents.find((a: Detail) => a.current_ticket === t.key && a.status === 'working');
  const run = worker ? S.runs.find((r: Detail) => r.id === worker.current_run) : null;
  const kids = S.tickets.filter((x: Ticket) => x.parent_key === t.key);
  const patch = (field: string, ok: string) => async (e: { target: { value: string } }) => { try { await api('PATCH', `/api/tickets/${t.key}`, { [field]: e.target.value }); toast(ok); } catch (err) { toast((err as Error).message, true); } };
  const Sel = ({ label, field, options, value, ok }: { label: string; field: string; options: [string, string][]; value: string; ok: string }) => (
    <label className="grid grid-cols-[120px_1fr] items-center gap-3"><span className="text-sm text-muted-foreground">{label}</span>
      <select aria-label={label} value={value} onChange={patch(field, ok)} className="h-10 rounded-md border border-input bg-background px-2">{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
  );
  const Fact = ({ k, children }: { k: string; children: ReactNode }) => <div className="grid grid-cols-[120px_1fr] gap-3"><span className="text-sm text-muted-foreground">{k}</span><span className="min-w-0 [overflow-wrap:anywhere]">{children}</span></div>;
  return (
    <div className="grid gap-5">
      <Block title="Description"><div className="max-h-[40vh] overflow-auto whitespace-pre-line [overflow-wrap:anywhere]">{t.description || 'No description provided.'}</div></Block>
      <Block title="Ticket">
        <Sel label="Stage" field="status" options={Object.entries(STAGE_LABEL).filter(([k]) => k !== 'done' || t.status === 'done')} value={t.status} ok="Stage changed" />
        <Sel label="Assignee" field="assignee" options={[['', 'Auto (by size)'], ...(S.meta.engineers || []).map((id: string) => [id, `${amap[id]?.name}, ${amap[id]?.role}`] as [string, string])]} value={t.assignee || ''} ok="Reassigned" />
        <Sel label="Priority" field="priority" options={['P0', 'P1', 'P2', 'P3'].map((p) => [p, p] as [string, string])} value={t.priority || 'P2'} ok="Priority saved" />
        <Fact k="Area and size">{t.area || 'not set'}, {t.complexity || 'not sized'}</Fact>
        <Fact k="Branch"><span className="font-mono">{t.branch || 'none yet'}</span></Fact>
        <Fact k="Requested by">{(t.reporter && amap[t.reporter]?.name) || (t.reporter === 'owner' ? 'You' : t.reporter) || 'unknown'}</Fact>
        {t.parent_key && <Fact k="Part of"><button type="button" className="text-primary hover:underline" onClick={() => openTicket(t.parent_key!)}>{nameOf(ticketByKey(t.parent_key) || { title: t.parent_key })}</button></Fact>}
        {t.issue_number && S.meta.repo && <Fact k="GitHub issue"><a className="text-primary hover:underline" href={`https://github.com/${S.meta.repo}/issues/${t.issue_number}`} target="_blank" rel="noopener noreferrer">#{t.issue_number}</a></Fact>}
        <Fact k="Review rounds"><span className="font-mono">{String(t.qa_loops || 0)}</span></Fact>
      </Block>
      {kids.length > 0 && <Block title="Slices"><ul className="grid gap-1.5">{kids.map((k: Ticket) => <li key={k.key} className="flex items-center justify-between gap-2"><button type="button" className="text-left hover:underline max-md:min-h-11" onClick={() => openTicket(k.key)}>{nameOf(k)}</button><Tag tone={k.status === 'done' ? 'shipped' : 'neutral'}>{STAGE_LABEL[k.status] || k.status}</Tag></li>)}</ul></Block>}
      {(d?.discussions || []).length > 0 && <Block title="Design discussions">{d!.discussions.slice(0, 4).map((x: Detail) => <p key={x.id} className="text-sm">#{x.id}: {x.status.replaceAll('_', ' ')}{x.error ? `, ${x.error}` : ''}</p>)}</Block>}
      <div className="flex flex-wrap gap-2">
        <AsyncButton variant="secondary" run={async () => { const v = window.prompt('Short name for this ticket (2 to 5 words):', nameOf(t)); if (v == null) return false; await api('POST', `/api/tickets/${t.key}/name`, { name: v }); await loadSnapshot(); }} ok="Renamed">Rename</AsyncButton>
        <Button variant="ghost" asChild><a href={`/classic.html#${t.key}`}>Architecture review & council (Classic)</a></Button>
        {run && <AsyncButton variant="destructive" confirm={`Stop ${worker!.name}'s run on ${nameOf(t)}?`} run={() => api('POST', `/api/runs/${run.id}/kill`, {})} ok="Stopping the run">Stop run</AsyncButton>}
      </div>
    </div>
  );
}
