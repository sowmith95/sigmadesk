// Recorded public updates only; command output stays available as evidence, not dialogue.
import { humanizeStep, humanizeError, isToolExit } from './runcard.js';

export function conversationItems({ comments = [], events = [], agent = '' } = {}) {
  const items = new Map();
  for (const c of comments) items.set(`c${c.id}`, { id: `c${c.id}`, ts: c.ts, who: c.author, text: c.body, kind: 'comment' });
  for (const e of events) {
    // The desk may emit an activity echo alongside the persisted full comment.
    if (comments.some((c) => c.author === e.agent_id && Math.abs(Date.parse(c.ts) - Date.parse(e.ts)) < 5000
      && (c.body === e.text || (String(e.text).startsWith('Commented: ') && c.body.startsWith(e.text.slice(11)))))) continue;
    const technical = ['tool', 'plan'].includes(e.kind) || (e.kind === 'error' && isToolExit(e.text));
    items.set(`e${e.id}`, { id: `e${e.id}`, ts: e.ts, who: e.agent_id || 'system', runId: e.run_id,
      kind: technical ? 'technical' : e.kind, raw: e.text,
      text: e.kind === 'action' ? humanizeStep(e.text) : e.kind === 'error' ? humanizeError(e.text) : e.text });
  }
  const sorted = [...items.values()].filter((i) => i.text && (!agent || i.who === agent))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.id[0].localeCompare(b.id[0]) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const grouped = [];
  for (const item of sorted) {
    const last = grouped.at(-1);
    if (item.kind === 'technical' && last?.kind === 'technical' && last.who === item.who && last.runId === item.runId) last.steps.push(item);
    else grouped.push(item.kind === 'technical' ? { ...item, steps: [item] } : item);
  }
  return grouped;
}

export const nearLatest = ({ scrollHeight, scrollTop, clientHeight }) => scrollHeight - scrollTop - clientHeight < 48;
