import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { humanReason } from '../../../public/attention.js';
import { S, api, ticketByKey, currentBoard, closeSheet, openSheet, openFeature, openTicket, loadDetail, loadSnapshot, loadPrs, councilFor, draftKey, setDraft, toast } from '@/store.js';
import { clean, prNumber } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Panel } from '@/components/desk/Panel';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, Key, Named } from '@/components/desk/Bits';
import { KIND_LABEL, BUCKET_LABEL, BUCKET_TONE, cardFor, RunCard, Reviews, prReviewsOf, firstName, DecisionButton } from '@/components/desk/Work';
import { Conversation, Brief, PrSummary, ProductReview, ResearchReview, Details, Block, type ConvState } from './parts';
import { Lineage, EpicTree, EpicProgress, childrenOf, isFeatureRoot } from '@/components/desk/Epic';
import { NextStep, GateSuggestions, EpicReview, OwnerTaskActions } from '@/components/desk/Flow';
import { Tracker } from '@/components/desk/Tracker';
import { PresenceStrip } from '@/components/desk/Presence';
import { Participants } from './Mentions';
import { MessageBar, type BarHandle } from './MessageBar';
import { Production } from './Production';
import { PersonSheet } from '@/components/desk/PeopleSheet';
import type { Board, BoardItem, Ticket } from '@/types';

type Detail = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Decision actions. Decisions carry the ticket version on screen (expected_updated_at), so a stale screen cannot act;
 *  a draft is cleared only after the server accepts it; a 409 refreshes and keeps the draft. */
function Footer({ t, dec, d, onDecided, replyRef, onTyping, toMessage, condensed, toDecision }:
  { t: Ticket; dec: BoardItem | null; d: Detail | null; onDecided: () => void; replyRef: React.RefObject<HTMLTextAreaElement | null>; onTyping: (v: boolean) => void; toMessage: () => void;
    condensed?: boolean; toDecision: () => void }) {
  const [mode, setMode] = useState<'changes' | null>(null);
  const [busy, setBusy] = useState(false);
  const dk = draftKey(t.key, dec?.id);
  const [text, setText] = useState<string>(S.drafts[dk] || '');
  useEffect(() => { setText(S.drafts[dk] || ''); setMode(null); }, [dk]);
  const running = !!t.active_run && !['design', 'council'].includes(dec?.kind || '');
  const proposal = dec?.kind === 'design' ? (d?.discussions || []).find((x: Detail) => x.id === dec.proposal_id) : null;
  const council = dec?.kind === 'council' ? councilFor(dec.council_id) : null;
  const who = firstName(t.assignee);
  const edit = (v: string) => { setText(v); setDraft(dk, v); };
  // The reply may unmount while focused (no blur event): the phone header gets its full height back here.
  const done = () => { setDraft(dk, ''); setText(''); setMode(null); onTyping(false); onDecided(); };
  const refresh = async () => { await loadSnapshot().catch(() => {}); await loadDetail(); };
  const guard = async <T,>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if ((e as { status?: number }).status === 409) await refresh(); throw e; } };
  const decide = (value: 'approve' | 'correction' | 'reject') => async () => {
    const msg = text.trim();
    if (value === 'correction' && !msg) { setMode('changes'); requestAnimationFrame(() => replyRef.current?.focus()); throw new Error('Describe the changes so the engineer can act on them.'); }
    if (value === 'reject' && !window.confirm(`Reject ${dec!.kind === 'design' ? `design proposal #${dec!.proposal_id}` : dec!.kind === 'council' ? `council #${dec!.council_id}` : nameOf(t)}?\n\n${['design', 'council'].includes(dec!.kind || '') ? 'The ticket stays open; only this recommendation is rejected.' : 'The ticket closes. Local work is kept, so the decision is reversible.'}`)) return false;
    await guard(async () => {
      if (dec!.kind === 'council') { await api('POST', `/api/councils/${dec!.council_id}/decision`, { decision: value, message: msg }); delete S.councils[dec!.council_id!]; }
      else {
        const r = await api('POST', `/api/tickets/${t.key}/decision`, { decision: value, message: msg, expected_updated_at: t.updated_at, discussion_id: dec!.kind === 'design' ? dec!.proposal_id : undefined });
        if (value === 'approve' && r?.pr_next) { done(); openSheet({ type: 'pr', number: r.pr_next, banner: r.already ? { mode: 'already' } : (r.github_approval || {}) }); return; }
      }
      done(); await refresh();
    });
  };
  // The answer to a hold: same stale guard as decisions (expected_updated_at). Messages and tags go through the bar.
  const send = (m: 'answer') => async () => {
    const body = text.trim();
    if (!body) { replyRef.current?.focus(); throw new Error('Type your answer first.'); }
    return guard(async () => { const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode: m, mentions: [], expected_updated_at: t.updated_at }); done(); await loadDetail(); return r; });
  };
  const menuRun = (fn: () => Promise<unknown>, ok: string) => async () => { if (busy) return; setBusy(true); try { const r = await fn(); if (r !== false) toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } };
  // The reply grows with what you type (up to 40% of the screen), so the whole answer stays readable while writing.
  // Phones keep it shorter (22% of the screen) so the message being answered stays readable above it.
  const grow = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * (window.innerWidth < 768 ? 0.22 : 0.4))}px`; };
  useLayoutEffect(() => { grow(replyRef.current); }, [text, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = (placeholder: string, label: string) => <Textarea id="reply" ref={replyRef} rows={2} aria-label={label} placeholder={placeholder} maxLength={8000} value={text}
    className="max-h-[40dvh] min-h-[3.25rem] resize-none overflow-y-auto leading-relaxed max-md:max-h-[22dvh]"
    onChange={(e) => edit(e.target.value)}
    // Typing on a phone: the header shrinks to one line and the thread scrolls so the newest message starts at the top.
    onFocus={() => { if (window.innerWidth >= 768) return; onTyping(true); setTimeout(() => document.querySelector('[data-panel] [role="log"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250); }}
    onBlur={() => onTyping(false)} />;
  const More = ({ items }: { items: { label: string; run: () => Promise<unknown>; ok: string; danger?: boolean; disabled?: boolean }[] }) => (
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" aria-label="More actions"><MoreHorizontal className="size-4" />More</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">{items.map((i) => <DropdownMenuItem key={i.label} disabled={i.disabled || busy} variant={i.danger ? 'destructive' : 'default'} onSelect={menuRun(i.run, i.ok)} className="min-h-10">{i.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
  );
  const note = running ? <p className="text-[13px] text-muted-foreground">The worker is finishing; decisions unlock when its run settles.</p> : null;
  // On a phone the primary action leads and shares its row with More: the reply area stays short.
  const row = 'flex flex-wrap items-center gap-2 max-md:[&>[data-primary]]:order-first max-md:[&>[data-primary]]:basis-full';
  // The answer footer is the common one on a phone: its primary shares one row with More.
  const tight = 'flex flex-wrap items-center gap-2 max-md:[&>[data-primary]]:order-first max-md:[&>[data-primary]]:flex-1 max-md:[&>span.flex-1]:hidden';
  const talk = { label: 'Message the team or ask the manager…', run: async () => { toMessage(); return false; }, ok: '' };
  if (dec?.kind === 'product') return <div className={row}><More items={[talk]} /><p className="text-sm text-muted-foreground">Resolve the objections in the Reviews tab.</p></div>;
  if (dec?.kind === 'deploy') {
    const lock = (dec as BoardItem & { deploy?: { merge_sha?: string } }).deploy;
    const repo = S.meta.repo;
    return <div className={row}>
      {repo && lock?.merge_sha && <Button variant="secondary" asChild><a href={`https://github.com/${repo}/commit/${lock.merge_sha}/checks`} target="_blank" rel="noopener noreferrer">See the deploy runs</a></Button>}
      <span className="flex-1" />
      <AsyncButton data-primary size="lg" confirm="Clear the deploy hold? Do this after checking the deploy runs: deploying merges continue." run={async () => { await api('POST', '/api/merge-train/clear-deploy', { merge_sha: lock?.merge_sha }); done(); await refresh(); }} ok="Deploy hold cleared">Clear the hold</AsyncButton>
    </div>;
  }
  if (dec?.kind === 'watch_schedule') return <div className={row}><span className="flex-1 text-sm text-muted-foreground">{dec.reason}</span><DecisionButton it={dec} /></div>;
  if (dec?.kind === 'regression') {
    const w = (dec as BoardItem & { regression?: { id: number } }).regression;
    return <div className={row}><span className="flex-1 text-sm text-muted-foreground">Check production first; the revert (if any) is yours to merge.</span>
      <AsyncButton data-primary size="lg" confirm="Clear the regression hold? Do this once production is safe: deploying merges continue. The regression verdict stays on record."
        run={async () => { await api('POST', '/api/deploy/regression-hold/clear', { watch_id: w?.id }); done(); await refresh(); }} ok="Regression hold cleared">Clear the hold</AsyncButton></div>;
  }
  // Under the Conversation's message bar, an answer box would be a second text field: one line that leads to it instead.
  if (condensed && ['question', 'conflict', 'setup', 'refresh', 'stuck'].includes(dec?.kind || '')) return (
    <div className="flex items-center gap-2 rounded-md bg-needs/10 px-3 py-1.5" data-decision-line>
      <span className="min-w-0 flex-1 text-sm"><b className="text-needs">{KIND_LABEL[dec?.kind || ''] || 'Needs you'}</b> · {who} is waiting for your answer{text.trim() ? ' (draft saved)' : ''}</span>
      <Button size="sm" className="h-9" onClick={toDecision}>Answer</Button>
    </div>);
  if (['question', 'conflict', 'setup', 'refresh', 'stuck'].includes(dec?.kind || '')) return <>
    {box(`Your answer to ${who}…`, 'Your answer')}
    <div className={tight}>
      <More items={[talk, { label: 'Approve as asked (no message)', run: decide('approve'), ok: `Approved; ${who} resumes`, disabled: running },
        { label: 'I will do this one myself', run: async () => { if (!window.confirm(`Take ${t.key} yourself? No engineer will pick it up; the tasks after it wait until you mark it done.`)) return false; await guard(() => api('POST', `/api/tickets/${t.key}/owner-task`, { owner_task: true })); done(); await refresh(); }, ok: 'It is your task now', disabled: running || !!t.head_sha || !!t.pr_url }, { label: 'Reject ticket…', run: decide('reject'), ok: 'Rejected; ticket closed, local work kept', danger: true, disabled: running }]} />
      <span className="flex-1" />
      <AsyncButton data-primary size="lg" disabled={running} run={send('answer')} ok={`Answer delivered; ${who} resumes`}>Answer and continue</AsyncButton>
    </div>{note}</>;
  if (dec?.kind === 'owner_task' || dec?.kind === 'epic_review') return <div className={row}><More items={[talk]} /><p className="text-sm text-muted-foreground">{dec.kind === 'owner_task' ? 'Mark it done or hand it back above.' : 'Answer the question or decide the closes above.'}</p></div>;
  if (dec && dec.kind !== 'page') {
    const target = dec.kind === 'design' ? ` #${dec.proposal_id}` : dec.kind === 'council' ? ` #${dec.council_id}` : '';
    const primaryLabel = dec.kind === 'merge' ? 'Review merge' : dec.kind === 'design' ? `Approve design${target}` : dec.kind === 'council' ? `Approve council${target}` : dec.kind === 'research' ? 'Approve for grooming' : 'Approve publication';
    const cantApprove = running || (dec.kind === 'design' && !proposal) || (dec.kind === 'council' && (!council || council.stale || council.status === 'partial'));
    const blockedAll = running || (dec.kind === 'council' && (!council || council.stale));
    const okApprove = dec.kind === 'design' ? `Design #${dec.proposal_id} approved; recorded for planning` : dec.kind === 'council' ? 'Council decision recorded'
      : dec.kind === 'research' ? 'Second review waived; the manager can groom it' : dec.kind === 'guard' ? 'Guard lifted; pushing the branch and opening a draft PR' : 'Approved; opening a draft PR';
    const changes = mode === 'changes';
    return <>
      {changes && box('What should change? (required)', 'Requested changes')}
      <div className={row}>
        <More items={[talk, { label: dec.kind === 'design' ? `Reject design${target}…` : dec.kind === 'council' ? `Reject council${target}…` : dec.kind === 'research' ? 'Reject proposal…' : 'Reject ticket…', run: decide('reject'),
          ok: ['design', 'council'].includes(dec.kind || '') ? 'Recommendation rejected' : 'Rejected; ticket closed, local work kept', danger: true, disabled: blockedAll }]} />
        <span className="flex-1" />
        {changes ? <Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          : <Button variant="secondary" disabled={blockedAll} onClick={() => { setMode('changes'); requestAnimationFrame(() => replyRef.current?.focus()); }}>Request changes</Button>}
        {changes ? <AsyncButton data-primary size="lg" disabled={blockedAll || !text.trim()} run={decide('correction')}
          ok={['design', 'council'].includes(dec.kind || '') ? 'Corrections sent to the manager' : dec.kind === 'research' ? 'Sent back to the author with your notes' : `Changes requested; ${who} picks it back up`}>{dec.kind === 'research' ? 'Send back' : 'Send changes'}</AsyncButton>
          : dec.kind === 'merge' ? <Button data-primary size="lg" onClick={() => { const n = prNumber(t.pr_url); if (n) openSheet({ type: 'pr', number: n }); }}>{primaryLabel}</Button>
            : <AsyncButton data-primary size="lg" disabled={cantApprove} run={decide('approve')} ok={okApprove}>{primaryLabel}</AsyncButton>}
      </div>{note}</>;
  }
  return null;
}

export function TicketSheet() {
  const sh = S.sheet!;
  const det = S.detail;
  const t: Ticket | undefined = ticketByKey(sh.key!) || det?.data?.ticket;
  // Session state above the tabs: switching tabs never loses a choice, a draft or a scroll position.
  const [decisionId, setDecisionId] = useState<string | null>(sh.decision ?? null);
  const [person, setPerson] = useState<string | null>(null); // the participant whose sheet is open
  const [typing, setTyping] = useState(false); // phone: the reply has focus, so the header gives its room to the thread
  const [reviewMsg, setReviewMsg] = useState('');
  const conv = useRef<ConvState>({ agent: '', follow: true, top: 0 });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const bar = useRef<BarHandle | null>(null);
  const B = currentBoard() as Board;
  const decisions = t ? (B.decisions || B.needs_you).filter((x) => x.key === t.key) : [];
  const dec = decisionId ? decisions.find((x) => x.id === decisionId) || null : decisions[0] || null;
  const gone = !!decisionId && !dec;
  const it = t ? B.byKey[t.key] : undefined;
  // No explicit choice yet: follow the data (a decision that loads after the panel opens still leads).
  const [chosen, setTab] = useState<string | null>(sh.tab || (sh.decision ? 'decision' : null));
  const tab = chosen ?? (decisions[0] ? 'decision' : childrenOf(sh.key!).length ? 'tasks' : 'conversation');
  useEffect(() => { if (sh.focus && det?.data) { (replyRef.current || bar.current)?.focus(); sh.focus = false; } }, [det?.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t?.pr_url) loadPrs(); }, [t?.pr_url]);
  if (!t) return <Panel title={det?.error || 'Loading ticket…'} onClose={closeSheet}><p className="text-muted-foreground">{det?.error ? 'This ticket could not be loaded.' : 'Loading…'}</p></Panel>;
  const d = det?.data || null;
  const card = cardFor(t, d?.comments);
  const label = (x: BoardItem) => (x.proposal_id ? `Design #${x.proposal_id}` : x.council_id ? `Council #${x.council_id}` : KIND_LABEL[x.kind || ''] || x.kind);
  const reviewsCount = [prReviewsOf(t, d), (d?.product_reviews || []).length, t.research_review].filter(Boolean).length;
  const kids = childrenOf(t.key);
  const tracked = t.reporter === 'owner' && !t.parent_key;
  const head = (
    <div className="grid gap-1.5">
    <Lineage t={t} />
    <div className="flex flex-wrap items-center gap-2">
      {dec ? <Tag tone="needs">{KIND_LABEL[dec.kind || ''] || 'Needs you'}</Tag> : it ? <Tag tone={BUCKET_TONE[it.bucket] || 'neutral'}>{BUCKET_LABEL[it.bucket] || it.bucket}</Tag> : null}
      {it?.stage && <Tag>{it.stage}</Tag>}<Key k={t.key} />
      {kids.length > 0 && <Tag>Epic</Tag>}
      {nameOf(t) !== t.title && <span className="truncate text-sm text-muted-foreground">{t.title}</span>}
    </div>
    <Participants tkey={t.key} list={d?.participants || []} onPerson={setPerson} />
    </div>
  );
  const shownTab = dec || tab !== 'decision' ? tab : 'conversation';
  const onConversation = shownTab === 'conversation';
  // The message bar lives at the bottom of the Conversation tab; elsewhere one button takes you there.
  const toMessage = () => { setTab('conversation'); requestAnimationFrame(() => bar.current?.focus()); };
  const tagInChat = (seat: string) => { setTab('conversation'); requestAnimationFrame(() => bar.current?.tag(seat)); };
  const footer = dec ? <Footer t={t} dec={dec} d={d} onDecided={() => setDecisionId(null)} replyRef={replyRef} onTyping={setTyping} toMessage={toMessage}
    condensed={onConversation} toDecision={() => { setTab('decision'); focusReply(); }} /> : null;
  const focusReply = () => requestAnimationFrame(() => replyRef.current?.focus());
  // Presence (who is writing) sits right above the reply area, in the Conversation only. Drafts for decisions that no
  // longer exist are not "unsent drafts" here.
  const drafts = Object.fromEntries(Object.entries(S.drafts).filter(([k]) => k === draftKey(t.key) || decisions.some((x) => k === draftKey(t.key, x.id))));
  const presence = onConversation ? <PresenceStrip tkey={t.key} drafts={drafts} onSeat={() => { (document.activeElement as HTMLElement | null)?.blur?.(); setTab('run'); }}
    // The bar shows the message draft itself; the open decision's footer shows its own.
    hideDraft={(id) => id === 'msg' || dec?.id === id}
    onDraft={(id) => { if (id === 'msg') toMessage(); else { setDecisionId(id); setTab('decision'); focusReply(); } }} /> : null;
  return (
    <Panel wide label={nameOf(t)} title={nameOf(t)} head={head} compact={typing} onClose={closeSheet}
      footer={<>{footer}{presence}
        {/* Always mounted (hidden off the Conversation tab): the draft, the tags and their access choices survive tab switches. */}
        <div hidden={!onConversation} className="min-w-0"><MessageBar t={t} onTyping={setTyping} handle={bar} /></div>
        {!onConversation && !dec && <Button variant="secondary" className="justify-self-start" onClick={toMessage}>Message the team</Button>}</>}>
      {tracked && <Tracker t={t} B={B} mergeState={d?.merge_state} choices={decisions} selected={dec?.id} labelOf={(x) => label(x) || "Decision"}
        onChoose={(id) => { setDecisionId(id); setTab('decision'); }} onDecision={(id, key) => { if (key === t.key) { setDecisionId(id); setTab('decision'); } else openTicket(key, { decision: id }); }} />}
      {!tracked && decisions.length > 1 && <div role="group" aria-label="Decisions on this ticket" className="flex flex-wrap gap-2">
        {decisions.map((x) => <Button key={x.id} size="sm" variant={dec?.id === x.id ? 'default' : 'secondary'} aria-pressed={dec?.id === x.id} onClick={() => { setDecisionId(x.id); setTab('decision'); }}>{label(x)}</Button>)}</div>}
      {isFeatureRoot(t) && <p className="text-[13px] text-muted-foreground">A feature: its plan, tasks and grooming are on <button type="button" className="text-primary hover:underline" onClick={() => openFeature(t.key)}>its feature page</button>.</p>}
      <Production t={t} />
      {gone && <p role="status" className="rounded-md bg-blocked/15 px-3 py-2">That decision was resolved or changed while you were reading. Nothing was submitted.</p>}
      {!dec && it && ['blocked', 'queued', 'epic'].includes(it.bucket) && <p className="rounded-md bg-secondary px-3 py-2"><Named text={humanReason(clean(it.reason), S.tickets)} /></p>}
      <Tabs data-sheet-tabs value={shownTab} onValueChange={setTab} className="min-w-0 scroll-mt-2 gap-4">
        <TabsList className="w-full max-w-full justify-start overflow-x-auto">
          {dec && <TabsTrigger value="decision">Decision</TabsTrigger>}
          {kids.length > 0 && <TabsTrigger value="tasks">Tasks ({kids.length})</TabsTrigger>}
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="run">{card?.live ? 'Live run' : 'Run'}</TabsTrigger>
          <TabsTrigger value="reviews">Reviews{reviewsCount ? ` (${reviewsCount})` : ''}</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        {dec && <TabsContent value="decision" className="grid gap-4">
          {dec.kind === 'product' ? <ProductReview t={t} d={d} msg={reviewMsg} setMsg={setReviewMsg} /> : dec.kind === 'owner_task' ? <OwnerTaskActions t={t} /> : dec.kind === 'epic_review' ? <EpicReview root={t.key} /> : <Brief dec={dec} t={t} d={d} />}
          <PrSummary t={t} dec={dec} />
          <Reviews raw={prReviewsOf(t, d)} compact={false} t={t} />
        </TabsContent>}
        {kids.length > 0 && <TabsContent value="tasks" className="grid gap-4">
          {!['done', 'wontdo'].includes(t.status) && <NextStep root={t.key} />}
          <Block><EpicProgress epic={t.key} /><EpicTree root={t.key} /></Block>
          {!['done', 'wontdo'].includes(t.status) && <GateSuggestions root={t.key} />}
          {!t.parent_key && !['done', 'wontdo'].includes(t.status) && <EpicReview root={t.key} />}
          <p className="text-sm text-muted-foreground">{t.status === 'in_progress' ? 'This epic closes by itself when every task above has shipped or been dropped.' : t.status === 'done' ? 'Every task has settled.' : 'Tasks start in the order shown; an indented task belongs to the one above it.'}</p>
        </TabsContent>}
        <TabsContent value="conversation">{d ? <Conversation d={d} live={!!card?.live} tkey={t.key} state={conv} status={t.status} /> : <p className="text-muted-foreground">{det?.error || 'Loading conversation…'}</p>}</TabsContent>
        <TabsContent value="run"><Block><RunCard card={card} /></Block></TabsContent>
        <TabsContent value="reviews" className="grid gap-4">
          <PrSummary t={t} dec={null} />
          <Block><Reviews raw={prReviewsOf(t, d)} t={t} />{!prReviewsOf(t, d) && <p className="text-sm text-muted-foreground">No code review yet.</p>}</Block>
          {dec?.kind !== 'product' && <ProductReview t={t} d={d} msg={reviewMsg} setMsg={setReviewMsg} />}
          <ResearchReview t={t} d={d} />
        </TabsContent>
        <TabsContent value="details"><Details t={t} d={d} /></TabsContent>
      </Tabs>
      {person && <PersonSheet seat={person} tkey={t.key} onClose={() => setPerson(null)} onTag={tagInChat} />}
    </Panel>
  );
}
