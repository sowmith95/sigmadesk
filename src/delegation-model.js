// Delegation (sowmith95/sigmadesk#9): which owner decisions the Engineering Manager (Morgan) or the SRE (Devon) may
// decide FOR the owner, and the deterministic rules that send a decision back to the owner before any model runs. Pure:
// src/delegation.js gathers the facts, owns the records and applies decisions; this file only says what is allowed.
//
// Per decision kind a mode: owner (the owner decides; nothing runs) · shadow (the delegate decides, the decision is
// recorded and shown to the owner, and the owner still decides) · em / sre (that seat decides for the owner; the owner
// can override or reopen). Everything not listed here (merges, publish guards, reverts, hold releases, standing or
// renewal grants, packages, budget, policy and this matrix itself) is the owner's in v1 and has no mode at all.
import crypto from 'node:crypto';

export const MODES = ['owner', 'shadow', 'em', 'sre'];
export const SEAT_OF = { em: 'manager', sre: 'sre' };
export const MODE_LABEL = { owner: 'You decide', shadow: 'Shadow', em: 'Morgan decides', sre: 'Devon decides' };

/**
 * The delegable kinds, in the order v1 enables them. delegates: the modes besides owner/shadow a kind may take.
 * actions: what a delegate may do (escalate is always allowed). deterministic: decided by rule, with no model call.
 */
export const KINDS = {
  owner_task: { label: 'Owner tasks', scope: 'Steps filed as yours: a read-only production check goes to the SRE, a missing package becomes a package request, everything else stays yours',
    delegates: ['em'], actions: ['route'], deterministic: true },
  question: { label: "Engineers' questions", scope: 'Factual engineering questions on low-risk tickets; money, credentials, product preference, trading semantics, schema effects and anything risky stay yours',
    delegates: ['em'], actions: ['answer'] },
  research: { label: 'Research-review holds', scope: 'Coordinating corrections or rescoping of a held proposal; approving past a dissenting reviewer stays yours',
    delegates: ['em'], actions: ['changes'] },
  loop_limit: { label: 'QA and review loop limits', scope: 'Rescoping or reassigning work that failed QA, CI or review repeatedly; clearing a failure stays yours',
    delegates: ['em'], actions: ['changes'] },
  design: { label: 'Design and plan reviews', scope: 'Design recommendations and council verdicts on positively low-risk tickets, never by the seat that wrote them',
    delegates: ['em', 'sre'], actions: ['approve', 'changes', 'reject'] },
};
export const KIND_IDS = Object.keys(KINDS);
/** The seat that decides in shadow mode (the kind's first delegate). */
export const shadowSeat = (kind) => SEAT_OF[KINDS[kind]?.delegates?.[0]] || null;

// Structured hold kinds (tickets.hold_kind) each delegable kind covers. Anything else is never delegated.
export const LOOP_HOLDS = ['qa_loops', 'review_loops', 'ci_loops', 'github_loops', 'review_disagree'];
export const OWNER_ROUTES = { check: 'a read-only production check', package: 'a Python package the work needs' };
/**
 * What an asking seat says its question is about (desk needs-human --about). Only a factual engineering question, one a
 * reader can settle from the repository or its documentation, can be answered for the owner; every other subject is
 * the owner's by its nature, and so is a question that does not say.
 */
export const QUESTION_SCOPES = {
  factual: null, money: 'money and budget are yours', credentials: 'credentials and accounts are yours', product: 'a product preference is yours',
  trading: 'trading semantics and risk tolerance are yours', schema: 'a schema or data change is yours', other: 'it is not a factual engineering question',
};
const OWNER_KEEP = {
  write: 'a production write is yours', restart: 'a restart is yours', credential: 'credentials are yours', business: 'a business decision is yours',
  other: 'the step is not a production check or a package', probe: "the SRE's read-only probes could not answer it", owner: 'you took this task yourself',
};

const err = (msg) => Object.assign(new Error(msg), { status: 400 });
const bool = (v, name) => { if (typeof v !== 'boolean') throw err(`${name} must be true or false`); return v; };

/** The config block with every value in range (sigmadesk.config.json → delegation, after the env overrides). */
export function settingsFrom(cfg = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const kinds = Object.fromEntries(KIND_IDS.map((k) => [k, validMode(k, cfg.kinds?.[k]) ? cfg.kinds[k] : 'shadow']));
  return {
    enabled: cfg.enabled !== false, kinds, peerAccess: cfg.peerAccess === true,
    budgetUsd: num(cfg.budgetUsd, 0.75, 0.05, 20), maxMinutes: num(cfg.maxMinutes, 6, 0.01, 60), maxSteps: num(cfg.maxSteps, 60, 3, 200),
    maxActions: num(cfg.maxActions, 12, 2, 60), maxWaitMinutes: num(cfg.maxWaitMinutes, 30, 1, 1440), maxPerDay: num(cfg.maxPerDay, 40, 0, 1000),
    research: { maxCorrections: num(cfg.research?.maxCorrections, 1, 0, 5), maxSpendUsd: num(cfg.research?.maxSpendUsd, 1.5, 0, 50) },
    loopLimit: { maxRescopes: num(cfg.loopLimit?.maxRescopes, 1, 0, 5) },
    rulesSection: typeof cfg.rulesSection === 'string' && cfg.rulesSection.trim() && !/[\n#]/.test(cfg.rulesSection) ? cfg.rulesSection.trim().slice(0, 120) : RULES_SECTION,
  };
}
/** The playbook heading the owner lists a delegate's standing rules under (delegation.rulesSection). */
export const RULES_SECTION = 'Standing rules the EM may apply alone';
export const validMode = (kind, mode) => mode === 'owner' || mode === 'shadow' || (KINDS[kind]?.delegates || []).includes(mode);

/** Validate the owner's matrix as a whole (Settings → Autonomy). → { kinds, peerAccess } or throws. */
export function validatePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw err('policy must be an object');
  const kinds = p.kinds;
  if (!kinds || typeof kinds !== 'object' || Array.isArray(kinds)) throw err('kinds must map each decision kind to a mode');
  for (const k of Object.keys(kinds)) if (!KINDS[k]) throw err(`unknown decision kind "${String(k).slice(0, 40)}" (${KIND_IDS.join(', ')})`);
  const out = {};
  for (const k of KIND_IDS) {
    const m = kinds[k] ?? 'shadow';
    if (!validMode(k, m)) throw err(`${KINDS[k].label}: mode must be one of owner, shadow${KINDS[k].delegates.map((d) => `, ${d}`).join('')}`);
    out[k] = m;
  }
  return { kinds: out, peerAccess: bool(p.peerAccess ?? false, 'peerAccess') };
}

/**
 * What applies now: the config (defaults ← file ← env) with the owner's saved matrix on top. The config's
 * enabled:false and the owner's "Escalate everything" both make every kind the owner's, whatever is saved.
 * → { enabled, escalateAll, kinds: {kind: mode}, configured: {kind: mode}, peerAccess, source }
 */
export function effective({ cfg = settingsFrom(), saved = null, escalateAll = false } = {}) {
  const s = saved && typeof saved === 'object' ? saved : null;
  const configured = Object.fromEntries(KIND_IDS.map((k) => [k, s?.kinds && validMode(k, s.kinds[k]) ? s.kinds[k] : cfg.kinds[k]]));
  const locked = !cfg.enabled || escalateAll;
  return { enabled: cfg.enabled, escalateAll: !!escalateAll, configured, kinds: locked ? Object.fromEntries(KIND_IDS.map((k) => [k, 'owner'])) : configured,
    peerAccess: !locked && (s && typeof s.peerAccess === 'boolean' ? s.peerAccess : cfg.peerAccess), source: s ? 'saved' : 'config' };
}
/** The policy from the desk's settings rows and the config block (shared by src/delegation.js and src/access.js). */
export function fromSettings(settings = {}, cfg = {}) {
  let saved = null;
  try { saved = settings.delegation ? JSON.parse(settings.delegation) : null; } catch { saved = null; }
  return effective({ cfg: settingsFrom(cfg), saved, escalateAll: settings.delegation_escalate_all === 'true' });
}
/** A short fingerprint of the matrix in force (stored with every delegated decision; any change invalidates in-flight ones). */
export const versionOf = (pol, epoch = 0) => crypto.createHash('sha256').update(JSON.stringify([pol.kinds, pol.peerAccess, pol.escalateAll, pol.enabled, Number(epoch) || 0])).digest('hex').slice(0, 10);

/** Who decides a kind under a mode: em → the manager, sre → the SRE, shadow → the kind's first delegate, owner → nobody. */
export function delegateFor(kind, mode) {
  if (mode === 'shadow') return shadowSeat(kind);
  return KINDS[kind] && KINDS[kind].delegates.includes(mode) ? SEAT_OF[mode] : null;
}
/** The actions a delegate may take on this decision (escalate is always one of them). */
export const allowedActions = (kind) => [...(KINDS[kind]?.actions || []), 'escalate'];

/** The smallest dollar cap a decision run is started with (below it, an allowance counts as used up). */
export const MIN_RUN_USD = 0.05;
/**
 * The hard bound one decision run is admitted with. bound: the engine's own (src/delegation.js boundFor: 'usd', a dollar
 * cap the engine enforces; 'time', minutes and steps on a plan, charged at its reservation). left: what remains of a
 * lifetime spend allowance (a research proposal's) after everything charged and every other open reservation, or null.
 * reserveAt(usd): what the run reserves, and is charged without a cost report, under a dollar cap usd (null: none).
 * A capped run gets at most what is left; a run that cannot be capped starts only when its whole reservation fits.
 * → { usd, reserve } or { refuse }.
 */
export function allowance({ bound, left = null, reserveAt = () => 0 }) {
  if (!bound) return { refuse: 'the engine has no hard bound' };
  const money = (n) => `$${Math.max(0, n).toFixed(2)}`;
  if (bound.kind === 'usd') {
    const usd = left == null ? bound.usd : Math.min(bound.usd, Math.floor(left * 100 + 1e-6) / 100);
    if (usd < MIN_RUN_USD) return { refuse: `only ${money(left)} is left of this proposal's lifetime allowance for delegated decisions` };
    return { usd, reserve: reserveAt(usd) };
  }
  const reserve = reserveAt(null);
  if (left != null && reserve > left + 1e-9) return { refuse: `the engine cannot cap a run in dollars, and its ${money(reserve)} reservation is more than the ${money(left)} left of this proposal's lifetime allowance` };
  return { usd: null, reserve };
}

/** Positively low risk: the stored risk says low and the diff classifier does not say high. Unknown counts as high. */
export const positivelyLow = (t) => !!t && t.risk === 'low' && t.diff_risk !== 'high';

/**
 * The deterministic rules, checked before any model call and again when a decision is applied. facts:
 *   { kind, delegate, ticket, interest: why the delegate is a party (src/delegation.js interestedSeats) or null,
 *     rules: how many standing rules the owner marked for a delegate (null: not checked), rulesSection,
 *     lifetime: { count, spend }, limits: settingsFrom(), designStatus, stale, verifyReady, packagesEnabled, ownerTaskKind }
 * → null (the delegate may decide) or a plain-language reason it is the owner's.
 */
export function ownerReason(f, nameOf = (s) => s) {
  const t = f.ticket || null;
  const who = nameOf(f.delegate);
  if (!f.delegate) return 'no delegate is set for this kind';
  if (f.delegateOff) return `${who}'s seat is switched off`;
  if (t && ['done', 'wontdo'].includes(t.status)) return 'the ticket is closed';
  // Never decide one's own matter: one's own question, request, work, review, proposal or plan.
  if (f.interest) return `${who} ${f.interest}, so ${who} cannot decide it for you`;
  // Authority is the owner's: a model decides only under standing rules the owner marked for it, so with none the run
  // could only escalate (it never starts).
  if (!KINDS[f.kind]?.deterministic && f.rules === 0) return `your playbook marks no standing rules a delegate may apply alone (a "${f.rulesSection || RULES_SECTION}" section), so it stays yours`;
  switch (f.kind) {
    case 'owner_task': {
      const k = f.ownerTaskKind;
      if (!k) return 'nobody said what kind of step it is, so it stays yours';
      if (OWNER_KEEP[k]) return OWNER_KEEP[k];
      if (k === 'check' && !f.verifyReady) return 'it is a read-only production check, but nobody on the team can read production right now';
      if (k === 'package' && !f.packagesEnabled) return 'it needs a package, but package requests are switched off';
      if (!OWNER_ROUTES[k]) return 'the step is not one the team can take over';
      return null;
    }
    case 'question':
      if (!f.scope) return 'the asker did not mark it as a factual engineering question, so it stays yours';
      if (!Object.hasOwn(QUESTION_SCOPES, f.scope)) return 'the asker gave it an unknown subject, so it stays yours';
      if (QUESTION_SCOPES[f.scope]) return `the asker said it is about ${f.scope}: ${QUESTION_SCOPES[f.scope]}`;
      if (!positivelyLow(t)) return t?.risk === 'high' || t?.diff_risk === 'high' ? 'the ticket is high risk (trading, money or deploy paths)' : 'the ticket has no low-risk classification, so it counts as high risk';
      return null;
    case 'research':
      if (f.lifetime && f.lifetime.count >= f.limits.research.maxCorrections) return `${who} already sent this proposal back ${f.lifetime.count} time${f.lifetime.count === 1 ? '' : 's'} (limit ${f.limits.research.maxCorrections} for its whole life)`;
      if (f.lifetime && f.limits.research.maxSpendUsd - f.lifetime.spend < MIN_RUN_USD) return `delegated decisions on this proposal already cost $${f.lifetime.spend.toFixed(2)} of its $${f.limits.research.maxSpendUsd.toFixed(2)} lifetime limit`;
      return null;
    case 'loop_limit':
      if (f.lifetime && f.lifetime.count >= f.limits.loopLimit.maxRescopes) return `${who} already rescoped this ticket ${f.lifetime.count} time${f.lifetime.count === 1 ? '' : 's'} (limit ${f.limits.loopLimit.maxRescopes})`;
      return null;
    case 'design':
      if (f.designStatus && f.designStatus !== 'complete') return f.designStatus === 'partial' ? 'the council is incomplete (a reviewer failed)' : `the recommendation is ${f.designStatus}`;
      if (f.stale) return 'the recommendation is stale: the ticket changed after it was written';
      if (!positivelyLow(t)) return 'only positively low-risk work may be approved for you (backend changes can alter trading without any UI change)';
      return null;
    default: return 'this kind of decision is not delegable';
  }
}

// ---------------- what a decision may cite ----------------
/**
 * The owner section's strict grammar, line by line (#9): deliberately narrower than Markdown, so that nothing nested,
 * indented or quoted as an example can open the section, close it or become a rule.
 *  - Nothing at all: a line inside a fence (``` or ~~~ opened at indent 0-3, the rest of a ``` line holding no
 *    backtick; closed by the same character, as long or longer, at indent 0-3; an unclosed fence swallows the rest), an
 *    HTML comment (across lines too), a line indented four or more spaces (a tab counts four), and a # line that is not
 *    at column 0. None of these is a heading, a section boundary or rule text, and none is skipped either: each keeps
 *    its place as a line of its own, so whatever it stands between is not adjacent.
 *  - A heading: a column-0 `#` … `######` line (then a space or nothing), or a column-0 text line that is not a list
 *    item, immediately followed by a column-0 `===` or `---` line. Only one whose text line is a paragraph of its own
 *    can be the owner's: a text line straight after a list item or another line of text continues that paragraph.
 *  - A rule: starts only at a column-0 list marker (`- `, `* `, `+ `, `1. `). Lines indented one to three spaces, text
 *    or list items, continue the rule above, and so does a column-0 text line directly after one of its lines (the
 *    same paragraph), however the rule reached that line. A blank line and then column-0 text, a column-0 thematic
 *    break, or a heading end it. A rule is never kept without part of its own text: one whose paragraph a setext
 *    heading cut short is dropped (part of it became the heading), and so is one whose paragraph runs on into a line
 *    indented four or more, which Markdown reads as more of it (an indented fence there opens an example instead).
 * One token per physical line, in order: → [{ t: 'h', level, text, cuts } | { t: 'item', text } | { t: 'more', text } |
 *    { t: 'text', text } | { t: 'break' } | { t: 'blank' } | { t: 'nothing' } (fenced, commented) |
 *    { t: 'deep', opens } (indented four or more; opens: a fence) | { t: 'hash' } (an indented # line)]
 */
function ownerGrammar(text = '') {
  const lines = [];
  let fence = null, comment = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const src = raw.replace(/\t/g, '    ');
    if (fence) { if (fence.test(src)) fence = null; lines.push({ t: 'nothing' }); continue; }
    const commented = comment;
    let line = '', rest = src;
    while (rest) {
      if (comment) { const end = rest.indexOf('-->'); if (end < 0) break; comment = false; rest = rest.slice(end + 3); continue; }
      const at = rest.indexOf('<!--');
      if (at < 0) { line += rest; break; }
      line += rest.slice(0, at); rest = rest.slice(at + 4); comment = true;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) { fence = new RegExp(`^ {0,3}${open[1][0] === '`' ? '`' : '~'}{${open[1].length},}\\s*$`); lines.push({ t: 'nothing' }); continue; }
    if (!line.trim()) { lines.push(src.trim() || commented ? { t: 'nothing' } : { t: 'blank' }); continue; } // a comment, not a blank line
    const indent = line.match(/^ */)[0].length;
    if (indent >= 4) { const f = line.trim().match(/^(`{3,}|~{3,})(.*)$/); lines.push({ t: 'deep', opens: !!f && !(f[1][0] === '`' && f[2].includes('`')) }); continue; }
    if (indent > 0) { lines.push(/^ +#/.test(line) ? { t: 'hash' } : { t: 'more', text: line.trim() }); continue; }
    const h = line.match(/^(#{1,6})(?:\s+(.*?))?\s*$/);
    if (h) { lines.push({ t: 'h', level: h[1].length, text: (h[2] || '').replace(/\s+#+\s*$/, '').trim() }); continue; }
    if (/^#/.test(line)) { lines.push({ t: 'text', text: line.trim() }); continue; } // #hashtag: plain text
    if (/^(=+|-+)\s*$/.test(line)) { lines.push({ t: 'under', ch: line[0], text: line.trim() }); continue; }
    if (/^((\*\s*){3,}|(_\s*){3,})$/.test(line)) { lines.push({ t: 'break' }); continue; }
    const item = line.match(/^(?:[-*+]|\d{1,9}\.) +(\S.*)$/);
    if (item) { lines.push({ t: 'item', text: item[1].trim() }); continue; }
    lines.push({ t: 'text', text: line.trim() });
  }
  // Setext, on the physical lines: a column-0 text line and the column-0 underline on the very next line (anything in
  // between, even an ignored line, and it is no heading). `cuts`: the line before it may be the same paragraph (a list
  // item, text, or a line Markdown could read as more of it), so the heading may have taken a rule's last line, and its
  // text may be only the end of its own title. Any other underline is a thematic break or text.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i], b = lines[i + 1];
    if (a.t === 'text' && b?.t === 'under') {
      const prev = out.at(-1);
      out.push({ t: 'h', level: b.ch === '=' ? 1 : 2, text: a.text, cuts: !!prev && ['item', 'more', 'text', 'deep', 'hash'].includes(prev.t) }, { t: 'nothing' });
      i++; continue;
    }
    out.push(a.t === 'under' ? (a.ch === '-' && a.text.length >= 3 ? { t: 'break' } : { t: 'text', text: a.text }) : a);
  }
  return out;
}
/**
 * The standing rules a delegate may apply alone: the rules (see ownerGrammar) under the column-0 playbook heading the
 * OWNER marks for them (delegation.rulesSection, any level), in order (R1, R2 …), until the next heading of the same or
 * a higher level. No such heading, or no rule under it → [] (then nothing is decided for the owner by a model).
 */
export function standingRules(text = '', heading = RULES_SECTION) {
  const norm = (x) => String(x).toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
  const blocks = ownerGrammar(text);
  const at = blocks.findIndex((b) => b.t === 'h' && !b.cuts && norm(b.text) === norm(heading)); // a paragraph of its own
  if (at < 0) return [];
  const level = blocks[at].level;
  const rules = [];
  const drop = (rule) => rules.splice(rules.indexOf(rule), 1);
  // own: the line just before this one, physically, was the current rule's own text (a blank or ignored line between
  // them, and it was not).
  let cur = null, own = false;
  for (const b of blocks.slice(at + 1)) {
    const after = own; own = false;
    if (b.t === 'h') {
      if (b.cuts && cur) drop(cur); // its paragraph was cut short: never a partial rule
      if (b.level <= level) break; // the section ends at a heading of its level or higher
      cur = null; continue;
    }
    if (b.t === 'item') { cur = [b.text]; rules.push(cur); own = true; continue; }
    if (b.t === 'more') { if (cur) { cur.push(b.text); own = true; } continue; } // indented one to three spaces: the rule above
    if (b.t === 'text') { if (cur && after) { cur.push(b.text); own = true; } else cur = null; continue; } // directly after its text: the same paragraph; else a paragraph between rules
    if (b.t === 'deep' && cur && after && !b.opens) { drop(cur); cur = null; continue; } // more of its paragraph that is never rule text here
    if (b.t === 'break') cur = null;
  }
  return rules.map((r) => r.join('\n').trim()).filter(Boolean).slice(0, 60);
}
/** desk decide --cite "R2, E1, file:src/x.py:40": the ids, in order, each once. */
export function parseCites(raw) {
  if (raw == null || raw === true) return [];
  return [...new Set(String(raw).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))].slice(0, 30);
}
/** file:<path>[:<line>[-<line>]] → { path, from, to } for a relative path inside the repository, else null. */
export function parseFileCite(id) {
  const m = String(id).match(/^file:([^:]+)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  const p = m[1];
  if (p.length > 300 || /^[/-]/.test(p) || /[\\\u0000-\u001f]/.test(p) || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const from = m[2] ? Number(m[2]) : null, to = m[3] ? Number(m[3]) : from;
  if (from != null && (from < 1 || to < from)) return null;
  return { path: p, from, to };
}
/**
 * Why a decision's citations do not support it, or null. A decision that changes anything must cite at least one of
 * the standing rules the owner marked for a delegate to apply alone (R) and at least one numbered piece of evidence
 * from its brief (E). A repository file (file:) may be cited as well, never instead of an E. Every id must be one its
 * run was given, or a file that exists at the pinned base (badFiles: the cited files that do not).
 */
export function citationProblem(ids = [], { rules = new Set(), evidence = new Set(), badFiles = new Set() } = {}) {
  if (!ids.length) return 'cites nothing from its brief';
  const isFile = (id) => !!parseFileCite(id) && !badFiles.has(id);
  const unknown = ids.filter((id) => !rules.has(id) && !evidence.has(id) && !isFile(id));
  if (unknown.length) return `cites ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in its brief or the repository`;
  if (!ids.some((id) => rules.has(id))) return 'cites none of the standing rules you marked for a delegate to apply alone';
  if (!ids.some((id) => evidence.has(id))) return 'cites no numbered evidence from its brief (a file citation does not replace one)';
  return null;
}

/** The plain-language line for a delegated decision ("Morgan answered Riley: …"). */
export function lineFor(rec, nameOf = (s) => s) {
  const who = nameOf(rec.seat), asker = rec.asker ? nameOf(rec.asker) : null;
  const text = String(rec.text || '').replace(/\s+/g, ' ').trim();
  const clip = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (rec.action === 'escalate') return `${who} left this for you: ${rec.why || 'no reason given'}`;
  if (rec.action === 'answer') return `${who} answered ${asker || 'the engineer'}: ${clip}`;
  if (rec.action === 'route') return `${who} ${clip || 'routed it to the team'}`;
  if (rec.kind === 'research') return `${who} sent the proposal back for corrections: ${clip}`;
  if (rec.kind === 'loop_limit') return `${who} gave the team new direction: ${clip}`;
  if (rec.kind === 'design') return `${who} ${rec.action === 'approve' ? 'approved the design' : rec.action === 'reject' ? 'rejected the design' : 'asked for design corrections'}${clip ? `: ${clip}` : ''}`;
  return `${who} decided: ${clip}`;
}

/**
 * "Owner interventions avoided" and spend, per kind, over a window: every decision counts once (records are unique per
 * decision and evidence version). avoided = applied and neither overridden nor reopened; shadow = what the delegate
 * would have decided (the owner still decided). records: [{ kind, status, mode, created_at, spent_usd, estimated }].
 */
export function metrics(records = [], { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86400_000;
  const blank = () => ({ applied: 0, avoided: 0, overridden: 0, reopened: 0, escalated: 0, shadow: 0, spend_usd: 0, runs: 0, estimated_runs: 0 });
  const per = Object.fromEntries(KIND_IDS.map((k) => [k, blank()]));
  for (const r of records) {
    if (!per[r.kind] || !(Date.parse(r.created_at) >= since)) continue;
    const m = per[r.kind];
    if (['applied', 'overridden', 'reopened'].includes(r.status)) m.applied++;
    if (r.status === 'applied') m.avoided++;
    if (r.status === 'overridden') m.overridden++;
    if (r.status === 'reopened') m.reopened++;
    if (r.status === 'escalated') m.escalated++;
    if (r.status === 'shadow') m.shadow++;
    m.spend_usd += Number(r.spent_usd) || 0;
    m.runs += Number(r.runs) || 0;
    m.estimated_runs += Number(r.estimated_runs) || 0;
  }
  const total = Object.values(per).reduce((a, m) => { for (const k of Object.keys(a)) a[k] += m[k]; return a; }, blank());
  for (const m of [...Object.values(per), total]) m.spend_usd = Math.round(m.spend_usd * 100) / 100;
  const money = (n) => `$${n.toFixed(2)}`;
  return { window_days: days, since: new Date(since).toISOString(), kinds: per, total,
    spend_text: `Delegated decisions in the last ${days} days: ${money(total.spend_usd)} across ${total.runs} run${total.runs === 1 ? '' : 's'}${total.estimated_runs ? ` (${total.estimated_runs} without a cost report, charged at their cap)` : ''}.`,
    avoided_text: `${total.avoided} owner intervention${total.avoided === 1 ? '' : 's'} avoided (${total.overridden + total.reopened} overridden or reopened, ${total.escalated} escalated to you, ${total.shadow} in shadow).` };
}
