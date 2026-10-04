// The desk's sync contract, ported from v2 without React so it can be tested: one /api/state snapshot, then /api/stream
// deltas. Deltas that arrive while a snapshot is in flight are buffered and replayed on top of it, so none is lost.
// `applyDelta` mutates the state object and returns what changed so the store can schedule follow-ups.

export function upsert(list, item, key = 'id') {
  const i = list.findIndex((x) => x[key] === item[key]);
  if (i >= 0) list[i] = { ...list[i], ...item }; else list.unshift(item);
}
export const byId = (...lists) => {
  const m = new Map();
  for (const l of lists) for (const x of l || []) m.set(x.id, { ...(m.get(x.id) || {}), ...x });
  return [...m.values()].sort((a, b) => (a.id > b.id ? 1 : -1));
};
export const mergeEvents = (a, b) => { const m = new Map(); for (const e of [...(b || []), ...(a || [])]) m.set(e.id, e); return [...m.values()].sort((x, y) => x.id - y.id); };

export const emptyPending = () => ({ comments: [], events: [], discussions: [], product_reviews: [], research_reviews: [], refresh: null });
/**
 * Apply one stream message.
 * S.detail = { key, data, pending, seq } is the open ticket's detail (or null). Until `data` arrives, every detail-scoped
 * item (comments, events, discussions, reviews, branch refresh) is parked in `pending` so none is lost.
 * S.seat = { id, events } is the open seat sheet (or null).
 * Returns { meta: boolean (refresh the snapshot soon), research: boolean (refetch research/connectors), feature: key whose
 * feature document should be refetched }.
 */
export function applyDelta(S, m) {
  const out = { meta: false, research: false, feature: null };
  const d = S.detail;
  const mine = (k) => d && d.key === k;
  const into = (field, item) => {
    if (!mine(item.ticket_key)) return;
    const list = d.data ? (d.data[field] ||= []) : d.pending[field];
    upsert(list, item);
  };
  switch (m.type) {
    case 'ticket': upsert(S.tickets, m.data, 'key'); out.feature = m.data.parent_key || m.data.key; break;
    case 'agent': { const a = S.agents.find((x) => x.id === m.data.id); if (a) Object.assign(a, m.data); break; }
    case 'run': upsert(S.runs, m.data); if (m.data.status !== 'running') out.meta = true; break;
    case 'settings': { const teamChanged = S.settings.team !== m.data.team; S.settings = m.data; out.meta = teamChanged; out.research = true; break; }
    case 'incident': upsert(S.incidents, m.data); break;
    case 'quota': out.meta = true; break;
    case 'discussion': into('discussions', m.data); out.meta = true; break;
    case 'branch-refresh': if (mine(m.data.ticket_key)) { if (d.data) d.data.refresh = m.data; else d.pending.refresh = m.data; } break;
    case 'product-review': if (mine(m.data.ticket_key)) upsert(d.data ? (d.data.product_reviews ||= []) : d.pending.product_reviews, m.data, 'phase'); out.meta = true; break;
    case 'research-review': into('research_reviews', m.data); out.meta = true; break;
    case 'connector': out.meta = true; out.research = true; break;
    case 'council': delete S.councils[m.data.id]; out.meta = true; break;
    case 'feature-plan': {
      const plans = (S.meta.feature_plans ||= []);
      const i = plans.findIndex((p) => p.ticket_key === m.data.ticket_key);
      if (i >= 0) plans[i] = m.data; else plans.push(m.data);
      out.feature = m.data.ticket_key;
      break;
    }
    case 'lessons': out.meta = true; break; // a lesson was proposed or decided: refresh the snapshot
    case 'epic-review': {
      const list = (S.meta.epic_reviews ||= []);
      const i = list.findIndex((r) => r.key === m.data.key);
      if (i >= 0) list[i] = m.data; else list.push(m.data);
      break;
    }
    case 'event':
      if (!S.events.some((e) => e.id === m.data.id)) S.events.push(m.data);
      if (S.events.length > 600) S.events.splice(0, S.events.length - 600);
      into('events', m.data);
      if (S.seat && S.seat.id === m.data.agent_id && S.seat.events) S.seat.events.push(m.data);
      break;
    case 'comment':
      into('comments', m.data);
      if (String(m.data.body || '').startsWith('❓')) delete S.questions[m.data.ticket_key];
      break;
    default: break;
  }
  return out;
}

/**
 * Merge a fetched ticket detail with what is already shown and with stream items that arrived meanwhile.
 * Order is oldest → newest (shown, fetched, then live), so a newer status always wins and live items are never dropped.
 */
export function mergeDetail(prev, fetched, pending) {
  const reviews = [...(fetched.product_reviews || [])];
  for (const r of pending.product_reviews || []) upsert(reviews, r, 'phase');
  return { ...fetched, comments: byId(prev?.comments, fetched.comments, pending.comments), events: byId(prev?.events, fetched.events, pending.events),
    discussions: byId(prev?.discussions, fetched.discussions, pending.discussions), research_reviews: byId(fetched.research_reviews, pending.research_reviews),
    product_reviews: reviews, refresh: pending.refresh || fetched.refresh || null };
}
