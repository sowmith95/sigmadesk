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
// The owner section is read as a strict subset of Markdown: every rule the desk finds is a bullet Markdown shows under
// the owner's heading, made of exactly that bullet's lines (test/owner-rules-oracle.test.js checks this against a
// reference CommonMark parser when one is given). Line ends are LF, CRLF or a lone CR, nothing else (U+2028, U+2029 and
// U+0085 are text in a line, as in Markdown, and every pattern takes them in); a tab runs to the next fourth column, and
// only spaces and tabs are blank or indentation, as in Markdown (a no-break space is text).
const HTML_BLOCK = /^<(?:[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|\/[A-Za-z]|\?|![A-Za-z[])/; // a tag, <? or <! (not an autolink)
const BREAK = /^([-*_])[ ]*(?:\1[ ]*){2,}$/; // a thematic break (it wins over a bullet: "- - -")
const UNDERLINE = /^(?:=+|-+) *$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/s; // s: a line or paragraph separator (U+2028/9) is text, as in Markdown
const fenceOpens = (s) => { const f = s.match(FENCE); return !!f && !(f[1][0] === '`' && f[2].includes('`')); };
const strip = (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''); // what Markdown strips from a line: spaces and tabs only
/** Tabs to spaces as Markdown counts them: to the next column that is a multiple of four (">\t-" is "> " and two). */
function tabs(line) { let out = ''; for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch; return out; }
// Headings are compared as plain text only: a heading anywhere in the playbook (ATX of any level, or a paragraph with
// an underline) holding markup or a non-ASCII character could show the owner's words without spelling them, so then
// the playbook has no standing rules at all, and Settings says why.
const RAW_TEXT = /<(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)(?=[\s/>]|$)/i;
const MARKED = /[&<[\]\\`]|[^\x00-\x7F]/;
export const MARKED_HEADING = 'a heading uses markup or non-ASCII characters; headings must be plain text';
export const UNSURE_BLOCK = 'the playbook has raw HTML, or a code block or comment that a less indented line interrupts; the desk cannot tell what Markdown shows after it';
export const EARLIER_HEADING = 'an earlier heading has the same words; the owner\'s section is the first, and it must be a plain "##" heading';
const loose = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); // letters and digits only
// What a rule's text may not hold, because Markdown would show it differently or not at all: `<` (HTML, comments,
// autolinks), `[` and `]` (links, images and link definitions, whose targets are never shown), character references,
// controls and every character Unicode marks as default-ignorable (invisible: joiners, variation selectors, tag
// characters, direction marks and overrides…).
const UNSHOWN = /[<[\]\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\p{Default_Ignorable_Code_Point}]|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/u;
/** Text Markdown reads as nothing but paragraph text where it stands, and shows as written: no block mark at its start. */
function plain(s) {
  return !!s && !/^(?:#|>|`{3}|~{3}|[-*+](?: |$)|\d{1,9}[.)](?: |$))/.test(s) && !UNDERLINE.test(s) && !BREAK.test(s) && !UNSHOWN.test(s);
}
/** `- rule`, `* rule` or `+ rule` (one to four spaces after the mark, then plain text) → its text and the column it starts at. */
function bulletOf(s) {
  const m = s.match(/^([-*+])( {1,4})([^ ].*)$/s);
  return m && !BREAK.test(s) && plain(m[3]) ? { text: strip(m[3]), col: 1 + m[2].length } : null;
}
/** A column-0 line Markdown starts a block with even under a list item's paragraph, ending that list item. */
function interrupts(s) {
  return /^(?:#{1,6}(?: |$)|>|[-*+] |\d{1,9}[.)](?: |$)|<!--)/.test(s) || BREAK.test(s) || fenceOpens(s);
}
/**
 * The standing rules a delegate may apply alone (#9), in order (R1, R2 …): the rules under the owner's heading
 * (delegation.rulesSection), read strictly, each with the playbook lines it was read from (0-based). No such heading,
 * or no rule under it → [] (then nothing is decided for the owner by a model).
 *  - The section opens only at a column-0 `## <heading>` line: no other level, no underlined heading, and it must
 *    be the first heading anywhere with those words. Every heading is compared as plain text: one holding markup or
 *    a non-ASCII character leaves the playbook with no rules. Before the owner's heading, nothing may be read
 *    differently by Markdown: a line starting with raw HTML (a comment aside), or an indented fence or comment that a
 *    less indented line interrupts, leaves the playbook with no rules.
 *  - Inside it, exactly these lines are read: blank lines; a rule, starting at a column-0 `- `, `* ` or `+ `; and its
 *    continuation, which is plain text at column 0 directly under a line of the rule, or plain text or a plain bullet
 *    indented two or three spaces (no less than where the rule's text starts), blank line before it or not.
 *  - The first line of any other shape ends the section, and nothing after it is read: a column-0 `#` heading (the
 *    usual end), a fence, any HTML or comment, a `<`, `[` or `]`, a character reference, an invisible character, a
 *    line indented four or more, an indented `#`, a numbered line, a paragraph or a one-space line after a blank line,
 *    an underline. When Markdown would still count that line as part of the rule above it, the rule is dropped too:
 *    it may be missing a condition.
 */
export function standingRuleLines(text = '', heading = RULES_SECTION) { return standingRulesRead(text, heading).rules; }
/** standingRuleLines, and why there are none when something in the playbook stands in the way (MARKED_HEADING, EARLIER_HEADING, UNSURE_BLOCK). */
export function standingRulesRead(text = '', heading = RULES_SECTION) {
  const norm = (x) => String(x).toLowerCase().replace(/[:.]+$/, '').replace(/\s+/g, ' ').trim();
  const lines = String(text || '').split(/\r\n|\r|\n/), none = { rules: [], problem: null };
  const target = loose(heading);
  // A line's list item and quote marks, read as Markdown nests them: after each mark up to three spaces (a tab counts
  // four) may come before the next one. → { marks, rest: what follows them, code: the rest is indented code, empty }
  const marksOf = (b) => {
    let t = b, marks = 0, m;
    for (;;) {
      const r = marks ? t.replace(/^ {0,3}/, '') : t;
      if ((m = r.match(/^> ?/))) { t = r.slice(m[0].length); marks++; continue; }
      if ((m = r.match(/^(?:[-*+]|\d{1,9}[.)])( +|$)/))) {
        marks++;
        if (m[1].length > 4) return { marks, rest: r.slice(m[0].length), code: true, empty: false }; // five or more spaces: code
        t = r.slice(m[0].length); continue;
      }
      return { marks, rest: r, code: marks > 0 && /^ {4}/.test(t), empty: marks > 0 && !r };
    }
  };
  // A list item or quote line, and whether it leaves a paragraph open (its text after the marks is paragraph text):
  // then the lines under it continue that paragraph, inside the container, and are never a heading of the document.
  // A mark alone on its line is an empty item: no paragraph open.
  const opens = (b) => {
    const k = marksOf(b), t = k.rest;
    return !k.code && !k.empty && !!t && !/^(?:#{1,6}(?: |$)|`{3}|~{3}|<)/.test(t) && !BREAK.test(t) && !UNDERLINE.test(t);
  };
  // 1. Every heading candidate in the whole playbook, outside fences and comments: each ATX line (any level) and each
  // paragraph with an underline. Any with markup or non-ASCII: no rules. The first one with the owner's words (letters
  // and digits compared) must be the exact column-0 `## <heading>` line; a later one never opens a section. The scan
  // runs to the end of the file, and anything Markdown may read differently (raw HTML, a fence or comment a less
  // indented line interrupts), wherever it is, leaves no rules.
  let at = -1, fence = null, comment = null, run = [], untracked = false;
  for (let i = 0; i < lines.length; i++) {
    const src = tabs(lines[i]), indent = src.match(/^ */)[0].length, body = src.slice(indent);
    if ((fence || comment) && /[^ ]/.test(src) && indent < (fence || comment).indent) return { rules: [], problem: UNSURE_BLOCK };
    if (fence) { if (indent <= 3 && fence.close.test(src)) fence = null; continue; }
    if (comment) { if (src.includes('-->')) comment = null; continue; } // Markdown: the closing line is all comment
    if (/^ *$/.test(src)) { run = []; continue; }
    // A fence, comment or HTML block opened inside a list item or quote (after its marks), or deeper than the
    // document's own four columns: where Markdown ends it is not tracked here, and a comment left open there runs on
    // in the page Markdown writes, hiding what follows. No rules.
    // A raw-text element (a script, style, iframe…) opened anywhere, even inside a line, hides the rest of the page.
    if (RAW_TEXT.test(src)) return { rules: [], problem: UNSURE_BLOCK };
    // Marks are peeled here with any spacing at all: how far in a nested block starts depends on list items this
    // scanner does not follow (">     - <!--" is still a comment, inside the quote's numbered item), so any opener
    // after marks, however indented, counts.
    let inner = body, peeled = 0;
    for (let m; (m = inner.match(/^ *(?:>|(?:[-*+]|\d{1,9}[.)])(?= |$))/)); peeled++) inner = inner.slice(m[0].length);
    inner = inner.replace(/^ +/, '');
    if ((peeled || indent > 3) && (fenceOpens(inner) || inner.startsWith('<!--') || HTML_BLOCK.test(inner))) return { rules: [], problem: UNSURE_BLOCK };
    // An indented line that may start a block (a fence, heading, HTML, break or underline, at any depth) may sit
    // inside a list item or quote: from here the containers' state is not tracked (see below).
    if (indent > 0 && (/^(?:#{1,6}(?: |$)|`{3}|~{3}|<)/.test(body) || BREAK.test(body) || UNDERLINE.test(body))) untracked = true;
    if (indent <= 3 && body.startsWith('<!--')) { comment = body.slice(2).includes('-->') ? null : { indent }; run = []; continue; } // a comment block
    if (indent <= 3 && HTML_BLOCK.test(body)) return { rules: [], problem: UNSURE_BLOCK }; // a raw HTML block: where it ends is Markdown's call
    if (indent <= 3 && fenceOpens(body)) { const f = body.match(FENCE)[1]; fence = { indent, close: new RegExp(`^ {0,3}${f[0] === '`' ? '`' : '~'}{${f.length},} *$`) }; run = []; continue; }
    const atx = indent <= 3 && body.match(/^(#{1,6})(?:[ ]+(.*?))?[ ]*$/s); // the whole line, separators included
    if (atx) {
      const t = (atx[2] || '').replace(/(?:^|[ ]+)#+$/, '');
      if (MARKED.test(t)) return { rules: [], problem: MARKED_HEADING };
      if (at < 0 && loose(t) === target) { if (indent === 0 && atx[1] === '##' && norm(t) === norm(heading)) at = i; else return { rules: [], problem: EARLIER_HEADING }; }
      run = []; continue;
    }
    if (indent <= 3 && UNDERLINE.test(body) && run.length) {
      // Markdown's paragraph is a tail of the run that starts at a line of the document's own: not a list item or
      // quote line, and not a line continuing the paragraph one of those left open.
      const starts = run.map((r, k) => k).filter((k) => run[k].doc);
      if (starts.some((k) => MARKED.test(run.slice(k).map((r) => r.body).join(' ')))) return { rules: [], problem: MARKED_HEADING };
      if (at < 0 && starts.some((k) => loose(run.slice(k).map((r) => r.body).join(' ')) === target)) return { rules: [], problem: EARLIER_HEADING };
      run = []; continue;
    }
    if (indent <= 3 && BREAK.test(body)) { run = []; continue; }
    if (indent > 3 && !run.length) continue; // four or more in only continues a paragraph (else code)
    const marked = indent <= 3 && marksOf(body).marks > 0, last = run.at(-1);
    // It continues a list item's or quote's open paragraph only as plain continuation text: a line that may start a
    // block inside the container (a heading, fence, quote, list or HTML at any depth) closes that paragraph.
    const starts = /^(?:#{1,6}(?: |$)|`{3}|~{3}|<|>|[-*+](?: |$)|\d{1,9}[.)](?: |$))/.test(body) || BREAK.test(body);
    // Only while the containers' state is known: after a list item or quote holding something other than a paragraph
    // (a fence, a heading…), nothing inside it is tracked here, across blank lines too, until a column-0 line ends it
    // (a quote mark continues it); meanwhile every line counts as the document's own.
    if (indent === 0 && !/^>/.test(body)) untracked = false;
    if (marked && !opens(body)) untracked = true;
    const held = !marked && !starts && !untracked && !!last && (last.open || last.held);
    run.push({ body, indent, doc: !marked && !held, open: marked && !untracked && opens(body), held });
  }
  if (at < 0) return none;
  // 2. The section, line by line.
  const rules = [];
  let cur = null, gap = false; // gap: a blank line since the rule's last line
  const take = (r, i, t) => { r.text.push(t); r.lines.push(i); };
  for (let i = at + 1; i < lines.length; i++) {
    const raw = lines[i], src = tabs(raw);
    if (/^ *$/.test(src)) { gap = true; continue; }
    const indent = src.match(/^ */)[0].length, body = src.slice(indent), own = !!cur && !gap;
    const after = raw.slice(raw.match(/^ */)[0].length), spaced = /^[-*+] /.test(after) && !/^[-*+] *\t/.test(after); // no tab after the mark
    if (indent === 0) {
      const b = spaced ? bulletOf(body) : null;
      if (b) { cur = { text: [strip(raw.replace(/^[-*+] +/, ''))], lines: [i], col: b.col }; rules.push(cur); gap = false; continue; }
      if (own && plain(body)) { take(cur, i, strip(raw)); continue; } // the same paragraph
      if (own && !interrupts(body)) rules.pop(); // Markdown reads it as more of the rule
      break;
    }
    if (cur && indent < 4 && indent >= cur.col) {
      if (plain(body) || (spaced && bulletOf(body))) { take(cur, i, strip(raw)); gap = false; continue; }
      rules.pop(); break; // inside the rule's bullet, but not something the desk reads
    }
    if (cur && (own || indent >= cur.col)) rules.pop(); // indented four or more inside its bullet, or more of its paragraph
    break;
  }
  // The shape playbooks shipped with before the strict reading: a comment right under the heading the scanner chose.
  const next = lines.slice(at + 1).find((l) => /[^ \t]/.test(l));
  return { rules: rules.map((r) => ({ text: r.text.join('\n'), lines: r.lines })), problem: null, noteUnderHeading: !!next && /^ {0,3}<!--/.test(next) }; // every rule: no ceiling
}
export const standingRules = (text = '', heading = RULES_SECTION) => standingRuleLines(text, heading).map((r) => r.text);
/**
 * The shape playbooks shipped with before the strict reading: a comment right under the owner's heading (the one the
 * scanner opens, never a heading inside a fence or comment). It ends the section, so no rule after it counts.
 */
export const noteUnderHeading = (text = '', heading = RULES_SECTION) => !!standingRulesRead(text, heading).noteUnderHeading;
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
