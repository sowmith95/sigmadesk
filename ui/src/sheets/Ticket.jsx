import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { nameOf } from '../../../public/names.js';
import { humanReason } from '../../../public/attention.js';
import { conversationItems, nearLatest } from '../../../public/conversation.js';
import { safeGithubUrl } from '../../../public/prs.js';
import { S, api, emit, agentMap, ticketByKey, currentBoard, closeSheet, openTicket, openSheet, loadDetail, loadSnapshot, loadPrs, prFor, councilFor, draftKey, setDraft, toast } from '../store.js';
import { clean, hhmm, outcome, prNumber, questionText } from '../lib/format.js';
import { Sheet, CloseButton, Chip, Button, AsyncButton, Avatar, Named, Disclosure, Menu, KeyTag } from '../kit/index.js';
import { KIND_LABEL, BUCKET_LABEL, BUCKET_TONE, STAGE_LABEL, cardFor, RunCardView, EvidenceList, CiChip, ReviewsView, prReviewsOf, firstName } from '../views/shared.jsx';

const ENGINEERS = () => S.meta.engineers || [];

function Thread({ d, card, tkey }) {
  const [agent, setAgent] = useState('');
  const [follow, setFollow] = useState(true);
  const log = useRef(null);
  const top = useRef(0);
  const amap = agentMap();
  const items = conversationItems({ ...d, agent });
  const participants = [...new Set(conversationItems(d).map((i) => i.who))];
  const whoName = (id) => amap[id]?.name || ({ owner: 'You', system: 'Desk', github: 'GitHub' }[id]) || id;
  useLayoutEffect(() => { if (log.current) log.current.scrollTop = follow ? log.current.scrollHeight : top.current; });
  return (
    <section className="conversation" aria-label="Conversation">
      <div className="conversation-h"><h3>Conversation</h3><span className="muted small" role="status">{!S.connected ? 'Reconnecting…' : card.live ? 'Live updates' : 'Up to date'}</span>
        <span className="spacer" /><Button size="small" disabled={follow} onClick={() => setFollow(true)}>{follow ? 'Following latest' : 'Jump to latest'}</Button></div>
      <div className="conversation-h"><label className="small">Show <select aria-label="Conversation participant" value={agent} onChange={(e) => { setAgent(e.target.value); setFollow(true); top.current = 0; }}>
        <option value="">Everyone</option>{participants.map((id) => <option key={id} value={id}>{whoName(id)}</option>)}</select></label></div>
      <div className="thread conversation-log" role="region" aria-label="Task conversation" tabIndex={0} ref={log}
        onScroll={(e) => { top.current = e.currentTarget.scrollTop; const f = nearLatest(e.currentTarget); if (f !== follow) setFollow(f); }}>
        {items.length ? items.map((it) => {
          const mine = it.who === 'owner';
          const ask = String(it.text).startsWith('❓');
          const who = whoName(it.who);
          const run = S.runs.find((r) => r.id === it.runId);
          const meta = [amap[it.who]?.role, run?.model?.replace(':', ' · ')].filter(Boolean).join(' · ');
          if (it.kind === 'technical') return <div key={it.id} className="conversation-steps"><Disclosure id={`steps-${tkey}-${it.id}`} summary={`${who} · ${it.steps.length} execution step${it.steps.length === 1 ? '' : 's'}`}>
            <div className="log mono">{it.steps.map((e) => <div key={e.id}><time dateTime={e.ts}>{hhmm(e.ts)}</time> {e.raw}</div>)}</div></Disclosure></div>;
          const text = ask ? questionText(it.text) : clean(it.text);
          const update = !['comment', 'say'].includes(it.kind);
          return (
            <article key={it.id} className={`msg ${mine ? 'mine' : ''} ${ask ? 'ask' : ''} ${update ? 'update' : ''}`} data-message={it.id}>
              {!mine && <Avatar id={it.who} size="md" />}
              <div className="msg-b"><div className="msg-h"><b>{ask ? `${who} asks you` : who}</b><time className="muted small" dateTime={it.ts} title={new Date(it.ts).toLocaleString()}>{hhmm(it.ts)}</time></div>
                {meta && <p className="muted small msg-meta">{meta}</p>}
                {text.length > 1200 ? <Disclosure id={`msg-${it.id}`} className="long" summary={<span><Named text={`${text.slice(0, 800).trim()}…`} /><span className="more"> Show all</span></span>}><div className="msg-t"><Named text={text} /></div></Disclosure>
                  : <div className="msg-t"><Named text={text} /></div>}
              </div>
            </article>
          );
        }) : <p className="muted">No recorded updates yet. Messages will appear here as the team works.</p>}
      </div>
      <p className="muted small">Recorded messages and progress updates · latest 600 activity events. Expand execution steps for technical details.</p>
    </section>
  );
}

function CouncilView({ c }) {
  if (!c) return <p className="muted">Loading the council report…</p>;
  if (c.error) return <p className="red-t">Couldn't load the council: {c.error}</p>;
  let r = null;
  try { r = JSON.parse(c.result || 'null'); } catch { r = null; }
  return (
    <div className="council">
      {c.stale && <p className="red-t">Ticket evidence changed since this council ran. Start a fresh council in Classic view before deciding.</p>}
      {r ? <>
        <p><Chip tone={r.verdict === 'approve' ? 'green' : 'amber'}>Verdict: {r.verdict}</Chip> <Named text={clean(r.recommendation)} /></p>
        {r.dissent?.length ? <div><p className="muted small">Dissent</p><ul>{r.dissent.map((x, i) => <li key={i}>{clean(x)}</li>)}</ul></div> : <p className="muted small">No dissent recorded.</p>}
        {r.conditions?.length > 0 && <div><p className="muted small">Required validation</p><ul>{r.conditions.map((x, i) => <li key={i}>{clean(x)}</li>)}</ul></div>}
        {r.findings?.length > 0 && <Disclosure id={`council-f-${c.id}`} summary={`Findings · ${r.findings.length}`}><ul className="findings">{r.findings.map((f, i) => <li key={i}><p>{f.severity} · {clean(f.issue)}</p><p className="muted small">{clean(f.evidence)}</p></li>)}</ul></Disclosure>}
      </> : c.result ? <p className="prose">{clean(c.result)}</p> : <p className="muted">Council {c.status}.</p>}
    </div>
  );
}

function Brief({ dec, t, d, card }) {
  const comments = d?.comments || [];
  const submit = [...comments].reverse().find((c) => /^🚀/.test(c.body) || /^Implementation note/i.test(c.body));
  const proposal = dec.kind === 'design' ? (d?.discussions || []).find((x) => x.id === dec.proposal_id) : null;
  const q = dec.kind === 'question' ? comments.filter((c) => String(c.body).startsWith('❓')).at(-1) : null;
  const strip = (x) => String(x).replace(new RegExp(`^\\s*${t.key}[a-z]?\\s*[:—-]\\s*`), '');
  const changed = dec.kind === 'question' ? outcome(card?.result?.summary || 'The engineer stopped to ask before going further.')
    : dec.kind === 'design' ? 'The manager finished a design recommendation for this ticket.'
      : dec.kind === 'research' ? 'The independent second reviewer did not pass this research proposal; the author\'s revision allowance is used up or the reviewer rejected it.'
        : dec.kind === 'council' ? 'The architecture council finished its review.'
          : outcome(strip(submit ? submit.body.split('\n').slice(1).join(' ').trim() || submit.body : card?.result?.summary || t.progress_msg || 'No change summary posted.'));
  const pr = prFor(t);
  const risk = {
    merge: [pr ? `CI ${pr.checks}${pr.mergeable === 'CONFLICTING' ? ' · conflicts with the base branch' : ''}.` : 'CI status not loaded yet.', 'Merging deploys production.'],
    publish: ['Approving pushes the branch and opens a draft PR. Nothing merges until you merge it.'],
    guard: ['The change touches protected paths or is unusually large. Approving pushes it and opens a draft PR.'],
    question: [`${firstName(t.assignee)} is paused until you answer.`],
    design: ['Approving records the design. Implementation, QA and merge keep their own gates.'],
    council: ['A council verdict records a design decision; implementation, QA and merge keep their own gates.'],
    research: ['Approving waives the second review (recorded as your verdict) and lets the manager groom it. Send back gives the author one more revision with your notes. Reject closes the proposal.'],
  }[dec.kind] || [];
  const Row = ({ k, children }) => <div className="brief-row"><span className="rc-k">{k}</span><div className="rc-v">{children}</div></div>;
  return (
    <section className="brief" id="brief" aria-label="Decision brief">
      <h3>Decision brief</h3>
      <Row k="Your decision"><p className="strong">{dec.verb}</p>
        {q && <p className="question"><Named text={clean(questionText(q.body))} /></p>}
        {dec.kind === 'design' && (proposal ? <Disclosure id={`proposal-${proposal.id}`} defaultOpen summary={`Recommendation #${proposal.id}`}><div className="prose"><Named text={clean(proposal.response)} /></div></Disclosure>
          : <p className="muted">Loading recommendation #{dec.proposal_id}…</p>)}
        {dec.kind === 'council' && <CouncilView c={councilFor(dec.council_id)} />}
        {!q && !['design', 'council'].includes(dec.kind) && <p><Named text={clean(dec.reason)} /></p>}</Row>
      <Row k="Outcome"><p><Named text={changed} /></p></Row>
      {!['design', 'council'].includes(dec.kind) && <Row k="Evidence"><EvidenceList ev={card?.evidence} /></Row>}
      <Row k="Remaining risk">{risk.map((r, i) => <p key={i}>{r}</p>)}</Row>
    </section>
  );
}

function PrSummary({ t, dec }) {
  const n = prNumber(t.pr_url);
  const href = safeGithubUrl(t.pr_url);
  if (!n) {
    if (dec?.kind !== 'guard' && dec?.kind !== 'publish') return null;
    const files = (cardFor(t)?.evidence || []).find((e) => e.kind === 'files');
    return <section className="prsum" aria-label="Change"><h3>Change</h3>
      <p>No PR yet, so the desk cannot show the diff. {t.branch && <>Branch <span className="mono wrap">{t.branch}</span>.</>}</p>
      {files && <p className="muted small">Engineer lists {files.files.length} file{files.files.length === 1 ? '' : 's'}: {files.files.map((f) => f.split('/').pop()).join(', ')}</p>}</section>;
  }
  const pr = prFor(t);
  const r = S.detail?.data?.refresh;
  const refreshable = t.head_sha && ['needs_human', 'ready_for_human', 'todo'].includes(t.status) && (!r || ['rebased', 'published'].includes(r.status));
  return (
    <section className="prsum" aria-label="Pull request">
      <h3>Pull request #{n}</h3>
      {pr ? <p><CiChip t={t} /> +{pr.additions} −{pr.deletions} in {pr.files} files</p>
        : <p className="muted">{S.prsLoading ? 'Loading CI status from GitHub…' : S.prs?.error ? `GitHub status unavailable: ${S.prs.error}` : 'CI status not loaded.'}</p>}
      <p className="muted small">Merging into {S.prs?.base || 'main'} deploys production.</p>
      {r && <p className="muted small" role="status">Branch refresh: {r.status === 'conflicts' ? 'engineer resolving conflicts' : r.status === 'rebased' ? 'rebased — fresh validation in progress' : r.status === 'published' ? 'published after fresh QA' : 'preparing'} · base {r.base?.slice(0, 10) || 'pending'}</p>}
      <div className="row-actions">
        {dec?.kind !== 'merge' && <Button onClick={() => openSheet({ type: 'pr', number: n })}>PR actions</Button>}
        {refreshable && <AsyncButton disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/refresh-base`, { expected_updated_at: t.updated_at }, 300000); await loadSnapshot(); await loadDetail(); }}
          ok="Branch refreshed — engineer and fresh QA queued">Refresh branch & resume</AsyncButton>}
        {href && <a className="btn ghost" href={href} target="_blank" rel="noopener noreferrer">Open on GitHub</a>}
      </div>
    </section>
  );
}

function ProductReview({ t, d }) {
  const reviews = d?.product_reviews || (S.meta.product_reviews || []).filter((r) => r.ticket_key === t.key);
  const [msg, setMsg] = useState('');
  const amap = agentMap();
  const act = (r, action) => async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: r.phase, revision: r.revision, action, message: msg }); setMsg(''); await loadSnapshot(); await loadDetail(); };
  return (
    <section className="product-review" aria-label="Product and design review"><h3>Product & design review</h3>
      {t.parent_key && (S.meta.product_reviews || []).some((r) => r.ticket_key === t.parent_key) && <Button size="small" onClick={() => openTicket(t.parent_key)}>View parent feature review</Button>}
      {reviews.length ? reviews.map((r) => (
        <div key={`${r.phase}-${r.revision}`} className="review-round">
          <p><b>{r.phase === 'plan' ? 'Before implementation' : 'User feedback'}</b> · {r.stale ? 'Stale' : r.status} · revision {r.revision}</p>
          <p className="muted small">{r.status === 'reviewing' ? 'Independent perspectives, one bounded challenge round, then engineering manager synthesis.' : 'Every required perspective must support the plan. Objections remain visible.'}</p>
          {r.members.map((m) => <Disclosure key={m.agent_id + m.stage} id={`product-${t.key}-${r.phase}-${r.revision}-${m.agent_id}`} summary={`${amap[m.agent_id]?.name || m.agent_id} · ${amap[m.agent_id]?.role || m.stage} · ${m.report?.verdict || m.status}`}>
            {m.report ? <>
              {m.initial_report && <p className="muted small">Initial {m.initial_report.verdict}: {m.initial_report.recommendation}</p>}
              <p>{m.report.recommendation}</p>
              {['users', 'benefits', 'drawbacks', 'alternatives', 'evidence', 'conditions'].map((k) => <div key={k}><b>{k[0].toUpperCase() + k.slice(1)}</b><ul>{m.report[k].map((x, i) => <li key={i}>{x}</li>)}</ul></div>)}
              {['architecture', 'rollout', 'success_metric'].map((k) => <p key={k}><b>{k.replace('_', ' ')}: </b>{m.report[k]}</p>)}
              <p className="muted small">{m.model || ''}</p>
            </> : <p className="muted">{m.error || (m.status === 'pending' ? 'Waiting for capacity, provider availability, and preceding reviews.' : 'Review in progress.')}</p>}
          </Disclosure>)}
          {r.status !== 'reviewing' && <>
            <textarea rows={2} aria-label={`${r.phase} review correction`} placeholder="Correction or new evidence…" value={msg} onChange={(e) => setMsg(e.target.value)} />
            <div className="row-actions">
              <AsyncButton run={act(r, 'revise')} ok="Review updated">Revise & review</AsyncButton>
              {r.status === 'failed' && !r.stale && <AsyncButton run={act(r, 'retry')} ok="Review updated">Retry failed reviews</AsyncButton>}
              <AsyncButton variant="ghost" run={act(r, 'defer')} ok="Review updated">Defer plan</AsyncButton>
              <AsyncButton variant="danger" run={act(r, 'reject')} ok="Review updated">Reject plan</AsyncButton>
            </div>
          </>}
        </div>
      )) : <p className="muted small">New root feature plans receive independent product and architecture review before implementation. You can request a review for this task.</p>}
      <div className="row-actions">
        {!reviews.some((r) => r.phase === 'plan') && !t.head_sha && <AsyncButton disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: 'plan' }); await loadDetail(); }} ok="Product review queued">Review this plan</AsyncButton>}
        {!reviews.some((r) => r.phase === 'feedback') && t.head_sha && <AsyncButton disabled={!!t.active_run} run={async () => { await api('POST', `/api/tickets/${t.key}/product-review`, { phase: 'feedback' }); await loadDetail(); }} ok="User feedback queued">Request user feedback</AsyncButton>}
      </div>
    </section>
  );
}

function ResearchReview({ t, d }) {
  if (t.source !== 'research' || !t.research_review) return null;
  const sum = (S.meta.research_reviews || []).find((r) => r.ticket_key === t.key);
  const rows = (d?.research_reviews || []).slice().sort((a, b) => a.id - b.id);
  const amap = agentMap();
  const label = { pending: 'Awaiting second review', passed: 'Passed', changes: 'Changes requested', held: 'Held for you', waived: 'Waived by you' }[t.research_review] || t.research_review;
  const tone = { passed: 'green', waived: 'green', held: 'amber', changes: 'amber' }[t.research_review] || '';
  const blocks = ['pending', 'changes', 'held'].includes(t.research_review);
  return (
    <section className="product-review" aria-label="Independent research review"><h3>Independent research review</h3>
      <p><Chip tone={tone}>{label}</Chip> · program {t.research_program || '—'} · generation {t.research_generation || 1}{sum && t.research_review === 'pending' ? ` · ${sum.needed} more pass${sum.needed === 1 ? '' : 'es'} needed` : ''}</p>
      {sum?.reason && <p className="muted small">{sum.reason}</p>}
      {rows.length ? <ul className="slices">{rows.map((r) => <li key={r.id}>{r.reviewer === 'owner' ? 'You' : amap[r.reviewer]?.name || r.reviewer} · generation {r.generation} · {r.verdict || r.status}
        {r.report?.summary ? ` — ${r.report.summary}` : ''}{r.report?.conditions?.length ? ` Conditions: ${r.report.conditions.join('; ')}` : ''}{r.error ? ` — ${r.error}` : ''}</li>)}</ul>
        : <p className="muted small">No reviewer has reported yet.</p>}
      {blocks && t.status !== 'needs_human' && <div className="row-actions"><AsyncButton run={async () => {
        const note = window.prompt('Waive the independent second review? This is recorded as your verdict. Optional note:', '');
        if (note == null) return false;
        await api('POST', `/api/tickets/${t.key}/research-review/waive`, { note }); await loadSnapshot(); await loadDetail();
      }} ok="Review waived — the manager can groom it">Waive review</AsyncButton></div>}
    </section>
  );
}

function More({ t, d }) {
  const amap = agentMap();
  const worker = S.agents.find((a) => a.current_ticket === t.key && a.status === 'working');
  const run = worker ? S.runs.find((r) => r.id === worker.current_run) : null;
  const kids = S.tickets.filter((x) => x.parent_key === t.key);
  const patch = (field, ok) => async (e) => { try { await api('PATCH', `/api/tickets/${t.key}`, { [field]: e.target.value }); toast(ok); } catch (err) { toast(err.message, true); } };
  const Sel = ({ label, field, options, value, ok }) => <label className="kv-row"><span>{label}</span><select aria-label={label} value={value} onChange={patch(field, ok)}>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>;
  return (
    <Disclosure id={`more-${t.key}`} summary="More">
      <div className="prose desc">{t.description || 'No description provided.'}</div>
      <div className="kv">
        <Sel label="Stage" field="status" options={Object.entries(STAGE_LABEL).filter(([k]) => k !== 'done' || t.status === 'done')} value={t.status} ok="Stage changed" />
        <Sel label="Assignee" field="assignee" options={[['', 'Auto (by size)'], ...ENGINEERS().map((id) => [id, `${amap[id]?.name} · ${amap[id]?.role}`])]} value={t.assignee || ''} ok="Reassigned" />
        <Sel label="Priority" field="priority" options={['P0', 'P1', 'P2', 'P3'].map((p) => [p, p])} value={t.priority} ok="Priority saved" />
        <div className="kv-row"><span>Area · size</span>{t.area || '—'} · {t.complexity || '—'}</div>
        <div className="kv-row"><span>Branch</span><span className="mono wrap">{t.branch || '—'}</span></div>
        <div className="kv-row"><span>Requested by</span>{amap[t.reporter]?.name || (t.reporter === 'owner' ? 'You' : t.reporter) || '—'}</div>
        {t.parent_key && <div className="kv-row"><span>Part of</span><button className="linkish" type="button" onClick={() => openTicket(t.parent_key)}>{nameOf(ticketByKey(t.parent_key) || { title: t.parent_key })}</button></div>}
        {t.issue_number && S.meta.repo && <div className="kv-row"><span>GitHub issue</span><a href={`https://github.com/${S.meta.repo}/issues/${t.issue_number}`} target="_blank" rel="noopener noreferrer">#{t.issue_number}</a></div>}
        <div className="kv-row"><span>Review rounds</span>{String(t.qa_loops || 0)}</div>
      </div>
      {kids.length > 0 && <><h4>Slices</h4><ul className="slices">{kids.map((k) => <li key={k.key}><button className="linkish" type="button" onClick={() => openTicket(k.key)}>{nameOf(k)}</button><Chip tone={k.status === 'done' ? 'green' : ''}>{STAGE_LABEL[k.status] || k.status}</Chip></li>)}</ul></>}
      {(d?.discussions || []).length > 0 && <><h4>Design discussions</h4>{d.discussions.slice(0, 4).map((x) => <p key={x.id} className="small">#{x.id} · {x.status.replaceAll('_', ' ')}{x.error ? ` · ${x.error}` : ''}</p>)}</>}
      <div className="row-actions">
        <AsyncButton run={async () => { const v = window.prompt('Short name for this ticket (2–5 words):', nameOf(t)); if (v == null) return false; await api('POST', `/api/tickets/${t.key}/name`, { name: v }); await loadSnapshot(); }} ok="Renamed">Rename</AsyncButton>
        <a className="btn" href={`/classic.html#${t.key}`}>Architecture review & council (Classic)</a>
        {run && <AsyncButton variant="danger" confirm={`Stop ${worker.name}'s run on ${nameOf(t)}?`} run={() => api('POST', `/api/runs/${run.id}/kill`, {})} ok="Stopping the run">Stop run</AsyncButton>}
      </div>
    </Disclosure>
  );
}

/** Footer: one primary action named for its effect; Request changes reveals its required note; Reject in the menu.
 *  Decisions carry the ticket version the owner is looking at (expected_updated_at), so a stale screen cannot act. */
function Footer({ t, dec, d, compose, setCompose, setDecisionId, replyRef }) {
  const [mode, setMode] = useState(null);
  const dk = draftKey(t.key, dec?.id);
  const [text, setText] = useState(S.drafts[dk] || '');
  useEffect(() => { setText(S.drafts[dk] || ''); setMode(null); }, [dk]);
  const running = !!t.active_run && !['design', 'council'].includes(dec?.kind);
  const proposal = dec?.kind === 'design' ? (d?.discussions || []).find((x) => x.id === dec.proposal_id) : null;
  const council = dec?.kind === 'council' ? councilFor(dec.council_id) : null;
  const who = firstName(t.assignee);
  const edit = (v) => { setText(v); setDraft(dk, v); };
  const done = () => { setDraft(dk, ''); setText(''); setMode(null); setDecisionId(null); setCompose(false); };
  const refresh = async () => { await loadSnapshot().catch(() => {}); await loadDetail(); };
  const on409 = async (e) => { if (e.status === 409) await refresh(); throw e; };
  const decide = (value) => async () => {
    const msg = text.trim();
    if (value === 'correction' && !msg) { setMode('changes'); requestAnimationFrame(() => replyRef.current?.focus()); throw new Error('Describe the changes so the engineer can act on them.'); }
    if (value === 'reject' && !window.confirm(`Reject ${dec.kind === 'design' ? `design proposal #${dec.proposal_id}` : dec.kind === 'council' ? `council #${dec.council_id}` : nameOf(t)}?\n\n${['design', 'council'].includes(dec.kind) ? 'The ticket stays open; only this recommendation is rejected.' : 'The ticket closes. Local work is kept, so the decision is reversible.'}`)) return false;
    try {
      if (dec.kind === 'council') { await api('POST', `/api/councils/${dec.council_id}/decision`, { decision: value, message: msg }); delete S.councils[dec.council_id]; }
      else {
        const r = await api('POST', `/api/tickets/${t.key}/decision`, { decision: value, message: msg, expected_updated_at: t.updated_at, discussion_id: dec.kind === 'design' ? dec.proposal_id : undefined });
        if (value === 'approve' && r?.pr_next) { done(); openSheet({ type: 'pr', number: r.pr_next, banner: r.already ? { mode: 'already' } : (r.github_approval || {}) }); return; }
      }
      done(); await refresh();
    } catch (e) { await on409(e); }
  };
  const send = (m) => async () => {
    const body = text.trim();
    if (!body) { replyRef.current?.focus(); throw new Error(m === 'answer' ? 'Type your answer first.' : 'Type a message first.'); }
    try { const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode: m, expected_updated_at: m === 'answer' ? t.updated_at : undefined }); done(); await loadDetail(); return r; }
    catch (e) { await on409(e); }
  };
  const box = (placeholder, label) => <textarea id="reply" ref={replyRef} rows={2} aria-label={label} placeholder={placeholder} maxLength={8000} value={text} onChange={(e) => edit(e.target.value)} />;
  if (dec?.kind === 'product') return <p className="muted small">Resolve the objections in Product & design review.</p>;
  const note = running ? <p className="muted small">The worker is finishing; decisions unlock when its run settles.</p> : null;
  if (dec?.kind === 'question') return <>
    {box(`Your answer to ${who}…`, 'Your answer')}
    <div className="f-actions">
      <Menu items={[<AsyncButton key="a" className="menu-i" disabled={running} run={decide('approve')} ok={`Approved — ${who} resumes`}>Approve as asked (no message)</AsyncButton>,
        <AsyncButton key="r" className="menu-i danger" disabled={running} run={decide('reject')} ok="Rejected — ticket closed, local work kept">Reject ticket…</AsyncButton>]} />
      <span className="spacer" />
      <AsyncButton variant="primary" size="big" disabled={running} run={send('answer')} ok={`Answer delivered — ${who} resumes`}>Answer and continue</AsyncButton>
    </div>{note}</>;
  if (dec && dec.kind !== 'page') {
    const target = dec.kind === 'design' ? ` #${dec.proposal_id}` : dec.kind === 'council' ? ` #${dec.council_id}` : '';
    const primaryLabel = dec.kind === 'merge' ? 'Review merge' : dec.kind === 'design' ? `Approve design${target}` : dec.kind === 'council' ? `Approve council${target}` : dec.kind === 'research' ? 'Approve for grooming' : 'Approve publication';
    const cantApprove = running || (dec.kind === 'design' && !proposal) || (dec.kind === 'council' && (!council || council.stale || council.status === 'partial'));
    const blockedAll = running || (dec.kind === 'council' && (!council || council.stale));
    const okApprove = dec.kind === 'design' ? `Design #${dec.proposal_id} approved — recorded for planning` : dec.kind === 'council' ? 'Council decision recorded'
      : dec.kind === 'research' ? 'Second review waived — the manager can groom it' : dec.kind === 'guard' ? 'Guard lifted — pushing the branch and opening a draft PR' : 'Approved — opening a draft PR';
    const primary = dec.kind === 'merge'
      ? <Button variant="primary" size="big" onClick={() => { const n = prNumber(t.pr_url); if (n) openSheet({ type: 'pr', number: n }); }}>{primaryLabel}</Button>
      : <AsyncButton variant="primary" size="big" disabled={cantApprove} run={decide('approve')} ok={okApprove}>{primaryLabel}</AsyncButton>;
    const changes = mode === 'changes';
    return <>
      {changes && box('What should change? (required)', 'Requested changes')}
      <div className="f-actions">
        <Menu items={[<AsyncButton key="r" className="menu-i danger" disabled={blockedAll} run={decide('reject')} ok={['design', 'council'].includes(dec.kind) ? 'Recommendation rejected' : 'Rejected — ticket closed, local work kept'}>
          {dec.kind === 'design' ? `Reject design${target}…` : dec.kind === 'council' ? `Reject council${target}…` : dec.kind === 'research' ? 'Reject proposal…' : 'Reject ticket…'}</AsyncButton>]} />
        <span className="spacer" />
        {changes ? <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          : <Button disabled={blockedAll} onClick={() => { setMode('changes'); requestAnimationFrame(() => replyRef.current?.focus()); }}>Request changes</Button>}
        {changes ? <AsyncButton id="send-changes" variant="primary" size="big" disabled={blockedAll || !text.trim()} run={decide('correction')}
          ok={['design', 'council'].includes(dec.kind) ? 'Corrections sent to the manager' : dec.kind === 'research' ? 'Sent back to the author with your notes' : `Changes requested — ${who} picks it back up`}>{dec.kind === 'research' ? 'Send back' : 'Send changes'}</AsyncButton> : primary}
      </div>{note}</>;
  }
  if (!compose) return null;
  return <>
    {box('Message the manager about this ticket…', 'Message')}
    <div className="f-actions">
      <Button variant="ghost" onClick={() => setCompose(false)}>Cancel</Button>
      <AsyncButton variant="ghost" run={send('comment')} ok="Comment saved to the thread">Comment only</AsyncButton>
      <span className="spacer" />
      <AsyncButton variant="primary" size="big" run={send('discussion')} ok="Sent to the manager — the ticket keeps its place">Send to manager</AsyncButton>
    </div></>;
}

export function TicketSheet() {
  const sh = S.sheet;
  const det = S.detail;
  const t = ticketByKey(sh.key) || det?.data?.ticket;
  const [decisionId, setDecisionId] = useState(sh.decision);
  const [compose, setCompose] = useState(false);
  const replyRef = useRef(null);
  useEffect(() => { if (sh.focus && det?.data) { replyRef.current?.focus(); sh.focus = false; } }, [det?.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t?.pr_url) loadPrs(); }, [t?.pr_url]);
  if (!t) return <Sheet label="Ticket" onClose={closeSheet} head={<div className="row"><h2>{det?.error || 'Loading ticket…'}</h2><CloseButton onClose={closeSheet} /></div>} />;
  const B = currentBoard();
  const it = B.byKey[t.key];
  const decisions = B.needs_you.filter((x) => x.key === t.key);
  const dec = decisionId ? decisions.find((x) => x.id === decisionId) || null : decisions[0] || null;
  const gone = !!decisionId && !dec;
  const d = det?.data;
  const card = cardFor(t, d?.comments);
  const label = (x) => (x.proposal_id ? `Design #${x.proposal_id}` : x.council_id ? `Council #${x.council_id}` : KIND_LABEL[x.kind] || x.kind);
  const thread = d ? <Thread d={d} card={card} tkey={t.key} /> : <p className="muted">{det?.error || 'Loading conversation…'}</p>;
  const head = <>
    <div className="row">{dec ? <Chip tone="amber">{KIND_LABEL[dec.kind] || 'Needs you'}</Chip> : it ? <Chip tone={BUCKET_TONE[it.bucket] || ''}>{BUCKET_LABEL[it.bucket] || (it.bucket === 'epic' ? 'Epic' : it.bucket)}</Chip> : null}
      {it?.stage && <Chip>{it.stage}</Chip>}<KeyTag k={t.key} /><span className="spacer" />
      {!dec && <Button size="small" aria-expanded={compose} onClick={() => { setCompose(!compose); if (!compose) requestAnimationFrame(() => replyRef.current?.focus()); }}>Message</Button>}
      <CloseButton onClose={closeSheet} /></div>
    <h2>{nameOf(t)}</h2>
    {nameOf(t) !== t.title && <p className="sub">{t.title}</p>}
    {(decisions.length > 1 || gone) && <div className="dec-tabs" role="group" aria-label="Decisions on this ticket">
      {decisions.map((x) => <button key={x.id} className="pill" type="button" aria-pressed={dec?.id === x.id} onClick={() => setDecisionId(x.id)}>{label(x)}</button>)}</div>}
  </>;
  const hist = <Disclosure id={`hist-run-${t.key}`} className="hist" summary={card.live ? 'Current run' : 'Execution history'}><RunCardView card={card} /></Disclosure>;
  const body = dec ? <>
    {dec.kind === 'product' ? <ProductReview t={t} d={d} /> : <Brief dec={dec} t={t} d={d} card={card} />}
    <PrSummary t={t} dec={dec} /><ReviewsView raw={prReviewsOf(t, d)} />{thread}{hist}
    {dec.kind !== 'product' && <ProductReview t={t} d={d} />}<ResearchReview t={t} d={d} /><More t={t} d={d} />
  </> : <>
    {gone && <p className="status-line blocked">That decision was resolved or changed while you were reading. Nothing was submitted.</p>}
    {it && ['blocked', 'queued', 'epic'].includes(it.bucket) && <p className={`status-line ${it.bucket}`}><Named text={humanReason(clean(it.reason), S.tickets)} /></p>}
    {thread}
    <Disclosure id={`hist-run-${t.key}`} summary={card.live ? 'Current run details' : 'Execution history'}><RunCardView card={card} /></Disclosure>
    <PrSummary t={t} dec={null} /><ReviewsView raw={prReviewsOf(t, d)} /><ProductReview t={t} d={d} /><ResearchReview t={t} d={d} /><More t={t} d={d} />
  </>;
  return <Sheet label={nameOf(t)} onClose={closeSheet} head={head} footer={<Footer t={t} dec={dec} d={d} compose={compose} setCompose={setCompose} setDecisionId={setDecisionId} replyRef={replyRef} />}>{body}</Sheet>;
}
export const _emit = emit;
