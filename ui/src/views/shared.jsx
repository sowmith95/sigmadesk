// Pieces shared by the Inbox, Work board and ticket sheet. Ported from v2 with the same rules and wording.
import { runCard } from '../../../public/runcard.js';
import { humanReason } from '../../../public/attention.js';
import { safeGithubUrl } from '../../../public/prs.js';
import { S, api, agentMap, openTicket, openSheet, prFor, emit } from '../store.js';
import { mergeEvents } from '../lib/sync.js';
import { clean, money, mins, hhmm, prNumber } from '../lib/format.js';
import { Chip, Named, Disclosure, Avatar, AsyncButton, Button } from '../kit/index.js';

export const STAGE_LABEL = { triage: 'Intake', proposed: 'Proposed', todo: 'To do', in_progress: 'Building', qa: 'QA', review: 'Acceptance', needs_human: 'Needs you', ready_for_human: 'Ready for review', done: 'Shipped', wontdo: 'Closed' };
export const BUCKET_LABEL = { needs_you: 'Needs you', blocked: 'Blocked', working: 'Working', queued: 'Queued', shipped: 'Shipped', closed: 'Closed' };
export const KIND_LABEL = { product: 'Product review', question: 'Question', guard: 'Publish guard', merge: 'Ready to merge', publish: 'Ready to publish', design: 'Design decision', council: 'Council verdict', page: 'Production errors', research: 'Research proposal' };
export const BUCKET_TONE = { needs_you: 'amber', blocked: 'red', shipped: 'green' };
export const firstName = (id) => (agentMap()[id]?.name || '').split(/\s+/)[0] || 'The engineer';
export const reasonText = (r) => humanReason(clean(r), S.tickets);

export function cardFor(t, comments) {
  const d = S.detail;
  const events = d && d.key === t.key && d.data ? mergeEvents(S.events, d.data.events) : S.events;
  return runCard({ ticket: t, events, runs: S.runs, agents: S.agents, comments: comments || [] });
}

export function NowLine({ card, compact = false }) {
  if (!card) return null;
  const text = compact && card.now && card.now.text.length > 110 ? `${card.now.text.slice(0, 109)}…` : card.now?.text;
  const bits = compact ? [card.plan ? `Plan ${card.plan.done} of ${card.plan.total}` : null, card.elapsedMin != null && card.live ? `${mins(card.elapsedMin)} elapsed` : null,
    card.cost ? (card.cost.running ? `${money(card.cost.reserve)} cap reserved` : card.cost.label) : null].filter(Boolean) : [];
  const [provider, ...model] = String(card.run?.model || '').split(':');
  return (
    <>
      {card.now && <p className={`now ${card.now.error ? 'err' : ''}`} title={card.now.text}>{card.now.error && <span className="now-l">Failed: </span>}<Named text={text} /></p>}
      {card.issue && <p className="issue"><span className="issue-l">Last check: </span>{card.issue.text}</p>}
      {card.stale && <p className={`stale ${card.stale.severe ? 'severe' : ''}`}>No update for {card.stale.minutes} min</p>}
      {compact && card.live && card.run?.model && <p className="facts">Running on {{ codex: 'Codex', claude: 'Claude', perplexity: 'Perplexity' }[provider] || provider}{model.length ? ` · ${model.join(':')}` : ''}</p>}
      {bits.length > 0 && <p className="facts mono">{bits.join(' · ')}</p>}
    </>
  );
}

export function EvidenceList({ ev }) {
  if (!ev?.length) return <p className="muted">No evidence posted yet.</p>;
  const src = { verified: 'Verified', claimed: 'Engineer says', pending: 'Pending', earlier: 'Earlier commit' };
  return (
    <ul className="evidence">
      {ev.map((e, i) => {
        const href = e.url ? safeGithubUrl(e.url) : null;
        return (
          <li key={i} className={`ev-${e.tone}`}>
            <span className="ev-l">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{e.label}</a> : e.label}{e.detail && <span className="ev-d"> {e.kind === 'files' ? '· ' : ''}{e.detail}</span>}</span>
            <span className={`ev-s ${e.source}`}>{src[e.source] || e.source}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function CiChip({ t }) {
  const pr = prFor(t);
  if (!pr) return <Chip>{S.prsLoading ? 'CI loading' : 'CI unknown'}</Chip>;
  const tone = { passing: 'green', failing: 'red', pending: 'amber' }[pr.checks] || '';
  return <>{<Chip tone={tone}>CI {pr.checks === 'none' ? 'not run' : pr.checks}</Chip>}{pr.mergeable === 'CONFLICTING' && <Chip tone="red">Conflicts</Chip>}</>;
}

export const prReviewsOf = (t, d) => d?.pr_reviews || d?.ticket?.pr_reviews || t?.pr_reviews || null;
const VERDICT = (v) => (/approv|pass|lgtm/i.test(v || '') ? ['✓', 'approved', 'green'] : /chang|fail|reject|request|block/i.test(v || '') ? ['✎', 'changes requested', 'amber'] : ['…', 'pending', '']);
export function ReviewsView({ raw, compact = false }) {
  let rv = raw;
  if (typeof rv === 'string') { try { rv = JSON.parse(rv); } catch { return null; } }
  if (!rv || typeof rv !== 'object') return null;
  const list = Array.isArray(rv) ? rv : Array.isArray(rv.reviewers) ? rv.reviewers : Array.isArray(rv.reviews) ? rv.reviews : [];
  if (!list.length) return null;
  const amap = agentMap();
  const round = rv.round ?? (Math.max(0, ...list.map((x) => Number(x.round) || 0)) || null);
  const findingsOf = (x) => (Array.isArray(x.findings) ? x.findings : []);
  const findings = list.reduce((n, x) => n + (Array.isArray(x.findings) ? x.findings.length : Number(x.findings) || 0), 0);
  const auto = rv.auto_merge?.status || rv.auto_merge_status || (typeof rv.auto_merge === 'string' ? rv.auto_merge : null);
  const who = (x) => amap[x.seat]?.name || x.name || x.seat || 'Reviewer';
  const people = list.map((x, i) => {
    const [g, word, tone] = VERDICT(x.verdict || x.state || x.status);
    const label = `${who(x)}${x.role ? `, ${x.role}` : ''}${x.context ? ` (${x.context})` : ''}: ${word}${x.sha ? ` at ${String(x.sha).slice(0, 8)}` : ''}`;
    return <span key={i} className={`rv ${tone}`} title={label} aria-label={label}>{amap[x.seat] ? <Avatar id={x.seat} /> : <span className="av">{who(x)[0]}</span>}
      <span className="rv-g" aria-hidden="true">{g}</span>{!compact && <span>{who(x)} · {word}</span>}</span>;
  });
  const facts = [round ? `round ${round}` : null, findings ? `${findings} finding${findings === 1 ? '' : 's'}` : null, auto ? `auto-merge ${auto}` : null].filter(Boolean).join(' · ');
  if (compact) return <span className="reviews compact">{people}{facts && <span className="muted small">{facts}</span>}</span>;
  const all = list.flatMap((x) => findingsOf(x).map((f) => ({ f, by: who(x) })));
  return (
    <section className="reviews-block" aria-label="Reviews">
      <h3>Reviews</h3><div className="reviews">{people}</div>
      {facts && <p className="muted small">{facts}</p>}
      {all.length > 0 && <Disclosure id="review-findings" summary={`Findings · ${all.length}`}><ul className="findings">{all.map(({ f, by }, i) => {
        const text = typeof f === 'string' ? f : f.text || f.title || f.body || f.issue || JSON.stringify(f);
        const resp = typeof f === 'object' ? f.response || f.responses?.map?.((r) => r.text || r.body || r).join(' · ') : null;
        return <li key={i}><p>{f.severity ? `${f.severity} · ` : ''}{clean(text)}</p><p className="muted small">from {by}{resp ? ` · response: ${clean(resp)}` : ''}</p></li>;
      })}</ul></Disclosure>}
    </section>
  );
}

export function RunCardView({ card, withEvidence = true }) {
  if (!card) return null;
  return (
    <section className="runcard" aria-label="Run card">
      <h3>{card.live ? 'Current run' : 'Last run'}</h3>
      <div className="rc-row"><span className="rc-k">{card.live ? 'Now' : 'Last step'}</span><div className="rc-v">{card.now ? <NowLine card={card} /> : <p className="muted">{card.live ? 'Starting' : card.result ? 'Not running' : 'Not started'}</p>}</div></div>
      <div className="rc-row"><span className="rc-k">Plan</span><div className="rc-v">{card.plan ? <>
        <p>{card.plan.done} of {card.plan.total} milestones</p>
        <ol className="plan">{card.plan.items.map((i, n) => <li key={n} className={`p-${i.state}`}><span className="p-m" aria-hidden="true">{i.state === 'done' ? '✓' : i.state === 'now' ? '▸' : '·'}</span><span className="sr">{i.state === 'done' ? 'Done: ' : i.state === 'now' ? 'In progress: ' : 'Pending: '}</span>{i.text}</li>)}</ol>
      </> : <p className="muted">No plan posted</p>}</div></div>
      {withEvidence && <div className="rc-row"><span className="rc-k">Evidence</span><div className="rc-v"><EvidenceList ev={card.evidence} /></div></div>}
      {card.result && <div className="rc-row"><span className="rc-k">Result</span><div className="rc-v">
        {card.result.summary && <p><Named text={clean(card.result.summary)} /></p>}<p className="muted small">{card.result.text}</p>
        {card.result.next && <p><span className="muted">Next: </span>{card.result.next}</p>}</div></div>}
      {card.cost && <div className="rc-row"><span className="rc-k">Cost</span><div className="rc-v"><p className="mono">{card.cost.label}</p>
        {card.run && <p className="muted small">{card.run.kind} run on {card.run.model}{card.elapsedMin != null ? ` · ${mins(card.elapsedMin)}` : ''}</p>}</div></div>}
      {card.says.length > 0 && <div className="rc-row"><span className="rc-k">Notes</span><div className="rc-v">
        {card.sayCount > 2 && <Disclosure id={`says-${card.key}`} summary={`Earlier updates · ${card.sayCount - 2}`}>{card.allSays.slice(0, -2).map((s, i) => <p key={i} className="say"><Named text={clean(s.text)} /></p>)}</Disclosure>}
        {card.says.map((s, i) => <p key={i} className="say"><Named text={clean(s.text)} /></p>)}</div></div>}
      {card.toolCount > 0 && <Disclosure id={`tools-${card.key}`} summary={`Execution details · ${card.toolCount} step${card.toolCount > 1 ? 's' : ''}`}>
        <div className="log mono">{card.tools.map((e, i) => <div key={i}><span className="t">{hhmm(e.ts)}</span> {e.text}</div>)}</div></Disclosure>}
    </section>
  );
}

/** Long text: the first ~n characters, then "Show all" (open state survives re-renders). */
export function Clamp({ id, text, n }) {
  if (text.length <= n + 40) return <p className="reason"><Named text={text} /></p>;
  const cut = text.slice(0, n).replace(/\s+\S*$/, '');
  return <Disclosure id={id} className="long" summary={<span className="reason"><Named text={`${cut}…`} /><span className="more"> Show all</span></span>}><p className="reason"><Named text={text} /></p></Disclosure>;
}

/** The one primary button on a decision. Publishing confirms first; merges open the PR actions sheet. */
export function DecisionButton({ it, label, className, ...rest }) {
  const t = it.ticket;
  const text = label || it.action;
  switch (it.kind) {
    case 'question': return <Button variant="primary" className={className} {...rest} onClick={() => openTicket(t.key, { decision: it.id, focus: true })}>{text}</Button>;
    case 'merge': return <Button variant="primary" className={className} {...rest} onClick={() => { const n = prNumber(t.pr_url); if (n) openSheet({ type: 'pr', number: n }); else openTicket(t.key, { decision: it.id }); }}>{text}</Button>;
    case 'page': return <Button variant="primary" className={className} {...rest} onClick={() => openSheet({ type: 'desk' })}>{text}</Button>;
    case 'guard': case 'publish':
      return <AsyncButton variant="primary" className={className} {...rest}
        confirm={it.kind === 'guard' ? `Lift the publish guard on ${it.name}?\n\nThe change touches protected paths or is unusually large. Approving pushes the branch and opens a draft PR. You still merge.`
          : `Publish ${it.name}?\n\nApproving pushes the branch and opens a draft PR. Nothing merges until you merge it.`}
        run={() => api('POST', `/api/tickets/${t.key}/decision`, { decision: 'approve', message: '', expected_updated_at: t.updated_at })}
        ok={it.kind === 'guard' ? 'Guard lifted — pushing the branch and opening a draft PR' : 'Approved — opening a draft PR'}>{text}</AsyncButton>;
    default: return <Button variant="primary" className={className} {...rest} onClick={() => openTicket(t.key, { decision: it.id })}>{text}</Button>;
  }
}
export const touch = emit;
