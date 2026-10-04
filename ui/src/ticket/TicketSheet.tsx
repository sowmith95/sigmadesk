import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { nameOf } from '../../../public/names.js';
import { humanReason } from '../../../public/attention.js';
import { S, api, ticketByKey, currentBoard, closeSheet, openSheet, openFeature, loadDetail, loadSnapshot, loadPrs, councilFor, draftKey, setDraft, toast } from '@/store.js';
import { clean, prNumber } from '@/lib/format.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Panel } from '@/components/desk/Panel';
import { AsyncButton } from '@/components/desk/AsyncButton';
import { Tag, Key, Named } from '@/components/desk/Bits';
import { KIND_LABEL, BUCKET_LABEL, BUCKET_TONE, cardFor, RunCard, Reviews, prReviewsOf, firstName } from '@/components/desk/Work';
import { Conversation, Brief, PrSummary, ProductReview, ResearchReview, Details, Block, type ConvState } from './parts';
import type { Board, BoardItem, Ticket } from '@/types';

type Detail = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Decision actions. Decisions carry the ticket version on screen (expected_updated_at), so a stale screen cannot act;
 *  a draft is cleared only after the server accepts it; a 409 refreshes and keeps the draft. */
function Footer({ t, dec, d, compose, setCompose, onDecided, replyRef }:
  { t: Ticket; dec: BoardItem | null; d: Detail | null; compose: boolean; setCompose: (v: boolean) => void; onDecided: () => void; replyRef: React.RefObject<HTMLTextAreaElement | null> }) {
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
  const done = () => { setDraft(dk, ''); setText(''); setMode(null); setCompose(false); onDecided(); };
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
  const send = (m: 'answer' | 'comment' | 'discussion') => async () => {
    const body = text.trim();
    if (!body) { replyRef.current?.focus(); throw new Error(m === 'answer' ? 'Type your answer first.' : 'Type a message first.'); }
    return guard(async () => { const r = await api('POST', `/api/tickets/${t.key}/reply`, { body, mode: m, expected_updated_at: m === 'answer' ? t.updated_at : undefined }); done(); await loadDetail(); return r; });
  };
  const menuRun = (fn: () => Promise<unknown>, ok: string) => async () => { if (busy) return; setBusy(true); try { const r = await fn(); if (r !== false) toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } };
  const box = (placeholder: string, label: string) => <Textarea id="reply" ref={replyRef} rows={2} aria-label={label} placeholder={placeholder} maxLength={8000} value={text} onChange={(e) => edit(e.target.value)} />;
  const More = ({ items }: { items: { label: string; run: () => Promise<unknown>; ok: string; danger?: boolean; disabled?: boolean }[] }) => (
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" aria-label="More actions"><MoreHorizontal className="size-4" />More</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">{items.map((i) => <DropdownMenuItem key={i.label} disabled={i.disabled || busy} variant={i.danger ? 'destructive' : 'default'} onSelect={menuRun(i.run, i.ok)} className="min-h-10">{i.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
  );
  const note = running ? <p className="text-sm text-muted-foreground">The worker is finishing; decisions unlock when its run settles.</p> : null;
  const row = 'flex flex-wrap items-center gap-2 max-md:[&>[data-primary]]:order-first max-md:[&>[data-primary]]:basis-full';
  const composeUi = <>
    {box('Message the manager about this ticket…', 'Message')}
    <div className={row}>
      <Button variant="ghost" onClick={() => setCompose(false)}>{dec ? 'Back to the decision' : 'Cancel'}</Button>
      <AsyncButton variant="secondary" run={send('comment')} ok="Comment saved to the thread">Comment only</AsyncButton>
      <span className="flex-1" />
      <AsyncButton data-primary size="lg" run={send('discussion')} ok="Sent to the manager; the ticket keeps its place">Ask the manager</AsyncButton>
    </div><p className="text-sm text-muted-foreground">Asking the manager starts a design discussion. It does not answer or approve anything.</p></>;
  const talk = { label: 'Comment or ask the manager…', run: async () => { setCompose(true); requestAnimationFrame(() => replyRef.current?.focus()); return false; }, ok: '' };
  if (compose) return composeUi;
  if (dec?.kind === 'product') return <div className={row}><More items={[talk]} /><p className="text-sm text-muted-foreground">Resolve the objections in the Reviews tab.</p></div>;
  if (dec?.kind === 'question') return <>
    {box(`Your answer to ${who}…`, 'Your answer')}
    <div className={row}>
      <More items={[talk, { label: 'Approve as asked (no message)', run: decide('approve'), ok: `Approved; ${who} resumes`, disabled: running }, { label: 'Reject ticket…', run: decide('reject'), ok: 'Rejected; ticket closed, local work kept', danger: true, disabled: running }]} />
      <span className="flex-1" />
      <AsyncButton data-primary size="lg" disabled={running} run={send('answer')} ok={`Answer delivered; ${who} resumes`}>Answer and continue</AsyncButton>
    </div>{note}</>;
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
  const [compose, setCompose] = useState(false);
  const [reviewMsg, setReviewMsg] = useState('');
  const conv = useRef<ConvState>({ agent: '', follow: true, top: 0 });
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const B = currentBoard() as Board;
  const decisions = t ? B.needs_you.filter((x) => x.key === t.key) : [];
  const dec = decisionId ? decisions.find((x) => x.id === decisionId) || null : decisions[0] || null;
  const gone = !!decisionId && !dec;
  const it = t ? B.byKey[t.key] : undefined;
  // No explicit choice yet: follow the data (a decision that loads after the panel opens still leads).
  const [chosen, setTab] = useState<string | null>(sh.tab || (sh.decision ? 'decision' : null));
  const tab = chosen ?? (decisions[0] ? 'decision' : 'conversation');
  useEffect(() => { if (sh.focus && det?.data) { replyRef.current?.focus(); sh.focus = false; } }, [det?.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (t?.pr_url) loadPrs(); }, [t?.pr_url]);
  if (!t) return <Panel title={det?.error || 'Loading ticket…'} onClose={closeSheet}><p className="text-muted-foreground">{det?.error ? 'This ticket could not be loaded.' : 'Loading…'}</p></Panel>;
  const d = det?.data || null;
  const card = cardFor(t, d?.comments);
  const label = (x: BoardItem) => (x.proposal_id ? `Design #${x.proposal_id}` : x.council_id ? `Council #${x.council_id}` : KIND_LABEL[x.kind || ''] || x.kind);
  const reviewsCount = [prReviewsOf(t, d), (d?.product_reviews || []).length, t.research_review].filter(Boolean).length;
  const head = (
    <div className="flex flex-wrap items-center gap-2">
      {dec ? <Tag tone="needs">{KIND_LABEL[dec.kind || ''] || 'Needs you'}</Tag> : it ? <Tag tone={BUCKET_TONE[it.bucket] || 'neutral'}>{BUCKET_LABEL[it.bucket] || it.bucket}</Tag> : null}
      {it?.stage && <Tag>{it.stage}</Tag>}<Key k={t.key} />
      {nameOf(t) !== t.title && <span className="truncate text-sm text-muted-foreground">{t.title}</span>}
    </div>
  );
  const footer = <Footer t={t} dec={dec} d={d} compose={compose} setCompose={setCompose} onDecided={() => setDecisionId(null)} replyRef={replyRef} />;
  return (
    <Panel wide label={nameOf(t)} title={nameOf(t)} head={head} onClose={closeSheet}
      footer={(dec || compose) ? footer : <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => { setCompose(true); requestAnimationFrame(() => replyRef.current?.focus()); }}>Comment or ask the manager</Button></div>}>
      {decisions.length > 1 && <div role="group" aria-label="Decisions on this ticket" className="flex flex-wrap gap-2">
        {decisions.map((x) => <Button key={x.id} size="sm" variant={dec?.id === x.id ? 'default' : 'secondary'} aria-pressed={dec?.id === x.id} onClick={() => { setDecisionId(x.id); setTab('decision'); }}>{label(x)}</Button>)}</div>}
      {t.type === 'feature' && !t.parent_key && <div className="flex flex-wrap items-center gap-3 rounded-md bg-primary/10 px-3 py-2"><span className="min-w-0 flex-1 text-sm">This is a feature. Its plan, tasks and grooming session are on its feature page.</span><Button size="sm" variant="secondary" onClick={() => openFeature(t.key)}>Open the feature</Button></div>}
      {gone && <p role="status" className="rounded-md bg-blocked/15 px-3 py-2">That decision was resolved or changed while you were reading. Nothing was submitted.</p>}
      {!dec && it && ['blocked', 'queued', 'epic'].includes(it.bucket) && <p className="rounded-md bg-secondary px-3 py-2"><Named text={humanReason(clean(it.reason), S.tickets)} /></p>}
      <Tabs value={dec || tab !== 'decision' ? tab : 'conversation'} onValueChange={setTab} className="min-w-0 gap-4">
        <TabsList className="w-full max-w-full justify-start overflow-x-auto">
          {dec && <TabsTrigger value="decision">Decision</TabsTrigger>}
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="run">{card?.live ? 'Live run' : 'Run'}</TabsTrigger>
          <TabsTrigger value="reviews">Reviews{reviewsCount ? ` (${reviewsCount})` : ''}</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
        {dec && <TabsContent value="decision" className="grid gap-4">
          {dec.kind === 'product' ? <ProductReview t={t} d={d} msg={reviewMsg} setMsg={setReviewMsg} /> : <Brief dec={dec} t={t} d={d} />}
          <PrSummary t={t} dec={dec} />
          <Reviews raw={prReviewsOf(t, d)} compact={false} t={t} />
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
    </Panel>
  );
}
