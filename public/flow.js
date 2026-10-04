// Work order inside a feature or epic, shared by the server (scheduling, Inbox grouping) and the UI (next step, gates).
// Pure: every function takes the ticket list. A ticket is blocked by its own `after_key` and by any ancestor's
// `after_key` that is not done yet (an epic that waits holds its tasks). Gates written only as text ("gated on SD-29")
// are detected so they can be turned into recorded dependencies; they never block on their own.

const DONE = new Set(['done']);
const CLOSED = new Set(['done', 'wontdo']);
const KEY_RE = /\b[A-Z][A-Z0-9]{0,9}-\d+\b/g;
const GATE_RE = /\b(gated on|gate[sd]? (?:by|on)|after|blocked (?:by|on)|depends on|dependent on|requires|until|waits? (?:for|on))\b/i;
// Wording that can only mean a dependency. "after", "requires" and "until" also appear in examples and history, so a gate
// found only through them is a suggestion for a person to confirm, never recorded on its own.
const STRONG_RE = /\b(gated on|gate[sd]? (?:by|on)|blocked (?:by|on)|depends on|dependent on|waits? (?:for|on))\b/i;

export function index(tickets) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const kids = new Map();
  for (const t of tickets) if (t.parent_key) (kids.get(t.parent_key) || kids.set(t.parent_key, []).get(t.parent_key)).push(t);
  return { byKey, kids };
}
export function ancestors(t, ix) {
  const out = [];
  const seen = new Set([t.key]);
  for (let p = ix.byKey.get(t.parent_key); p && !seen.has(p.key) && out.length < 10; p = ix.byKey.get(p.parent_key)) { seen.add(p.key); out.push(p); }
  return out;
}
export const rootOf = (t, ix) => ancestors(t, ix).at(-1) || t;
export function descendants(key, ix, seen = new Set()) {
  return (ix.kids.get(key) || []).flatMap((k) => (seen.has(k.key) ? [] : (seen.add(k.key), [k, ...descendants(k.key, ix, seen)])));
}

/** Recorded blockers: own and ancestors' `after_key` that are not done. [{ key, via }] (via = the ticket that waits). */
export function recordedBlockers(t, ix) {
  const out = [];
  for (const x of [t, ...ancestors(t, ix)]) {
    const dep = x.after_key && ix.byKey.get(x.after_key);
    if (dep && !DONE.has(dep.status)) out.push({ key: dep.key, via: x.key });
  }
  return out;
}
/**
 * Gates written only as text: keys named after a gate word in the title or description, in the same tree, still open,
 * not the ticket itself, its ancestors or descendants, and not already a recorded blocker.
 */
function rawTextGates(t, ix, re = GATE_RE) {
  const text = `${t.title || ''}\n${t.description || ''}`;
  const root = rootOf(t, ix).key;
  const family = new Set([t.key, ...ancestors(t, ix).map((a) => a.key), ...descendants(t.key, ix).map((d) => d.key)]);
  const recorded = new Set(recordedBlockers(t, ix).map((b) => b.key));
  const found = new Set();
  for (const line of text.split(/[\n.;]/)) {
    const m = re.exec(line);
    if (!m) continue;
    // Only keys AFTER the gate word: "until SD-29 reports" gates this ticket; "unblocks SD-31 until …" does not.
    for (const k of line.slice(m.index + m[0].length).match(KEY_RE) || []) {
      const dep = ix.byKey.get(k);
      if (dep && !family.has(k) && !recorded.has(k) && !CLOSED.has(dep.status) && rootOf(dep, ix).key === root) found.add(k);
    }
  }
  return [...found];
}
/** Everything `key` transitively waits on (recorded and text, through epics), with a cycle guard. */
function dependsOn(key, ix, memo = new Map(), stack = new Set()) {
  if (memo.has(key)) return memo.get(key);
  const t = ix.byKey.get(key);
  const out = new Set();
  if (!t || stack.has(key)) return out;
  stack.add(key);
  for (const d of [...recordedBlockers(t, ix).map((b) => b.key), ...rawTextGates(t, ix)]) {
    out.add(d);
    for (const x of dependsOn(d, ix, memo, stack)) out.add(x);
    for (const k of descendants(d, ix).map((x) => x.key)) out.add(k); // waiting for an epic means waiting for its tasks
  }
  stack.delete(key);
  memo.set(key, out);
  return out;
}
/**
 * The gates worth recording: a text gate is dropped when another gate or a recorded dependency already implies it
 * (it waits on it, directly or through an epic), so SD-34 "after SD-29, SD-30, SD-32, SD-33" becomes "after SD-33".
 */
export function textGates(t, ix, { strong = false } = {}) {
  const raw = rawTextGates(t, ix, strong ? STRONG_RE : GATE_RE);
  if (raw.length <= 1 && !recordedBlockers(t, ix).length) return raw;
  const memo = new Map();
  const others = (g) => [...raw.filter((h) => h !== g), ...recordedBlockers(t, ix).map((b) => b.key)];
  return raw.filter((g) => !others(g).some((h) => h === g || dependsOn(h, ix, memo).has(g) || descendants(g, ix).some((d) => d.key === h)));
}

/** Every open task in the tree that waits (recorded or by text gate, directly or through an epic) on `key`. */
export function waitingOn(key, tickets, ix = index(tickets)) {
  const target = ix.byKey.get(key);
  if (!target) return [];
  const root = rootOf(target, ix).key;
  const tree = [ix.byKey.get(root), ...descendants(root, ix)].filter(Boolean).filter((t) => !CLOSED.has(t.status) && t.key !== key);
  const direct = (t) => [...recordedBlockers(t, ix).map((b) => b.key), ...textGates(t, ix)];
  const out = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tree) {
      if (out.has(t.key)) continue;
      const deps = direct(t);
      const viaEpic = ancestors(t, ix).some((a) => out.has(a.key));
      if (deps.includes(key) || deps.some((d) => out.has(d)) || viaEpic) { out.add(t.key); grew = true; }
    }
  }
  // Report work items (leaves), not the epics that contain them.
  return [...out].map((k) => ix.byKey.get(k)).filter((t) => !(ix.kids.get(t.key) || []).length);
}

/**
 * The next step in a tree: the open leaf task that is actionable (no recorded or text blocker) and unblocks the most
 * work; tasks needing the owner come first. Returns { task, who: 'owner'|'team', waiting: [tasks], gates: [...] } or null.
 */
export function nextStep(rootKey, tickets, ix = index(tickets)) {
  const leaves = descendants(rootKey, ix).filter((t) => !CLOSED.has(t.status) && !(ix.kids.get(t.key) || []).length);
  if (!leaves.length) return null;
  const free = leaves.filter((t) => !recordedBlockers(t, ix).length && !textGates(t, ix).length);
  const pool = free.length ? free : leaves;
  const needsOwner = (t) => !!t.owner_task || ['needs_human', 'ready_for_human'].includes(t.status);
  const ranked = pool.map((t) => ({ t, waiting: waitingOn(t.key, tickets, ix) }))
    .sort((a, b) => Number(needsOwner(b.t)) - Number(needsOwner(a.t)) || b.waiting.length - a.waiting.length || String(a.t.key).localeCompare(String(b.t.key), 'en', { numeric: true }));
  const best = ranked[0];
  return { task: best.t, who: needsOwner(best.t) ? 'owner' : 'team', waiting: best.waiting, blockedEverywhere: !free.length };
}

/** Text gates across a tree, as one-tap suggestions: [{ key, after }] (one per ticket; several gates listed separately). */
export function gateSuggestions(rootKey, tickets, ix = index(tickets)) {
  const tree = [ix.byKey.get(rootKey), ...descendants(rootKey, ix)].filter(Boolean).filter((t) => !CLOSED.has(t.status));
  return tree.flatMap((t) => textGates(t, ix).map((after) => ({ key: t.key, after, title: t.title })));
}

/** Would making `key` wait for `after` create a loop (after already waits on key, or they are the same family)? */
export function wouldCycle(key, after, tickets, ix = index(tickets)) {
  const t = ix.byKey.get(key), a = ix.byKey.get(after);
  if (!t || !a || key === after) return true;
  const family = new Set([key, ...ancestors(t, ix).map((x) => x.key), ...descendants(key, ix).map((x) => x.key)]);
  if (family.has(after)) return true;
  const reach = dependsOn(after, ix);
  return [...family].some((k) => reach.has(k));
}
