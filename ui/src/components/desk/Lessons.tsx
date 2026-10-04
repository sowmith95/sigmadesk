// Team lessons: what builders learned from setbacks, approved by the owner, read by every later build in that area.
// Proposed lessons wait here (never one Inbox item each); active ones show how many tasks carried them and how often
// QA saw the same mistake again, which is how the owner tells a working lesson from one that is being ignored.
import { useState } from 'react';
import { S, api, loadSnapshot, openTicket, agentMap } from '@/store.js';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AsyncButton } from './AsyncButton';
import { Tag, SeatAvatar } from './Bits';

type Lesson = { id: number; area: string | null; text: string; source_ticket: string | null; proposed_by: string | null; status: string;
  decided_at: string | null; updated_at: string; repeats: number; tasks: number };

function Row({ l }: { l: Lesson }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.text);
  const act = (action: string, extra: Record<string, unknown> = {}) => async () => { await api('POST', `/api/lessons/${l.id}`, { action, expected_updated_at: l.updated_at, ...extra }); setEditing(false); await loadSnapshot(); };
  const who = agentMap()[l.proposed_by || '']?.name || l.proposed_by || 'the team';
  return (
    <li data-lesson={l.id} className="grid gap-2 rounded-md bg-secondary/50 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <SeatAvatar id={l.proposed_by} /><span>From {who}</span>{l.area ? <Tag>{l.area}</Tag> : <Tag>every area</Tag>}
        {l.source_ticket && <button type="button" className="font-mono hover:underline" onClick={() => openTicket(l.source_ticket!)}>{l.source_ticket}</button>}
        {l.status === 'active' && <span>· in {l.tasks} task{l.tasks === 1 ? '' : 's'} · {l.repeats ? <b className="text-blocked">repeated {l.repeats}×</b> : 'not repeated'}</span>}
      </div>
      {editing ? <Textarea aria-label="Lesson text" rows={2} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /> : <p>{l.text}</p>}
      <div className="flex flex-wrap gap-2">
        {editing ? <>
          <AsyncButton size="sm" run={act(l.status === 'proposed' ? 'approve' : 'edit', { text })} ok={l.status === 'proposed' ? 'Approved; builds in this area now read it' : 'Saved'}>{l.status === 'proposed' ? 'Approve edited' : 'Save'}</AsyncButton>
          <Button size="sm" variant="ghost" onClick={() => { setText(l.text); setEditing(false); }}>Cancel</Button>
        </> : l.status === 'proposed' ? <>
          <AsyncButton size="sm" run={act('approve')} ok="Approved; builds in this area now read it">Approve</AsyncButton>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          <AsyncButton size="sm" variant="ghost" run={act('reject')} ok="Rejected">Reject</AsyncButton>
        </> : <>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
          <AsyncButton size="sm" variant="ghost" confirm="Retire this lesson? Builds stop reading it." run={act('retire')} ok="Retired">Retire</AsyncButton>
        </>}
      </div>
    </li>
  );
}

export function Lessons() {
  const all = (S.meta.lessons || []) as Lesson[];
  const proposed = all.filter((l) => l.status === 'proposed');
  const active = all.filter((l) => l.status === 'active');
  return (
    <section aria-label="Team lessons" className="grid gap-4 rounded-lg border bg-card p-4">
      <div className="grid gap-1"><b>Team lessons</b>
        <p className="text-sm text-muted-foreground">When QA or a reviewer sends work back, the builder can propose one lesson. Once you approve it, every build in that area reads it. A lesson QA sees repeated is not working: edit or retire it.</p></div>
      {proposed.length > 0 && <div className="grid gap-2"><span className="text-sm font-medium">Waiting for you ({proposed.length})</span><ul className="grid gap-2">{proposed.map((l) => <Row key={l.id} l={l} />)}</ul></div>}
      {active.length > 0 ? <div className="grid gap-2"><span className="text-sm font-medium">Active ({active.length})</span><ul className="grid gap-2">{active.map((l) => <Row key={l.id} l={l} />)}</ul></div>
        : !proposed.length && <p className="text-sm text-muted-foreground">No lessons yet. They appear after work is sent back and fixed.</p>}
    </section>
  );
}
