// The team a project gets: core execution roles (fixed responsibilities, the existing seat ids) plus domain advisors
// chosen per project from packs. Advisors are read-only lenses: they join product/design reviews when their triggers
// match and may research or assess connectors. A project's team.json selects advisors and may rename or switch off
// optional core seats; it can never grant permissions, launch commands or builder powers (those stay server-defined).
// No team.json (the legacy desk): today's 14 seats, with today's three advisors behaving exactly as before.

/** Core roles: the seats every desk's workflow is built on. `optional` ones may be switched off if coverage allows. */
export const CORE = {
  pm: { role: 'Principal Product Manager', optional: true, why: 'Researches users and competitors and files evidence-backed proposals; joins product reviews.' },
  manager: { role: 'Engineering Manager', optional: false, why: 'Grooms requests into staffed, testable tasks; runs feature planning and design discussions; reviews PRs for context.' },
  'principal-be': { role: 'Principal Backend Engineer', optional: true, why: 'Designs and slices large or risky backend work; independent code reviewer.' },
  'senior-be': { role: 'Senior Backend Engineer', optional: true, why: 'Builds medium backend work with tests.' },
  'principal-fe': { role: 'Principal Frontend Engineer', optional: true, why: 'Designs and slices large or risky UI work; independent code reviewer.' },
  'senior-fe': { role: 'Senior Frontend Engineer', optional: true, why: 'Builds UI work end to end.' },
  dba: { role: 'Database Engineer', optional: true, why: 'Schemas, migrations and query plans; never touches a live database.' },
  junior: { role: 'Junior Engineer', optional: true, why: 'Takes small, well-specified tasks.' },
  qa: { role: 'QA Engineer', optional: false, why: 'Independent risk check on every change, pinned to the exact commit.' },
  sre: { role: 'Site Reliability Engineer', optional: true, why: 'Watches error logs and investigates recurring failures.' },
  support: { role: 'Support Bot', optional: false, why: 'Triages every incoming ticket, yours and GitHub\'s.' },
};
export const CORE_IDS = Object.keys(CORE);

/**
 * Advisor catalog. `triggers.areas` (ticket areas) and `triggers.pattern` (case-insensitive regex over title and
 * description) decide when an advisor joins a plan review. `gate: true` makes its verdict required (legacy advisors
 * only); every other advisor reports and never blocks.
 */
export const ADVISORS = {
  'product-design': { pack: 'web-product', name: 'Harper', role: 'Product Designer', short: 'UX', color: '#67e8f9', model: 'sonnet',
    bio: 'Challenges usability, accessibility and task completion with evidence.',
    lens: 'You are Harper, Product Designer. Challenge usability, task completion, mobile layout and accessibility. Distinguish inspected evidence from untested assumptions.',
    triggers: { areas: ['frontend', 'fullstack'], pattern: 'dashboard|interface|\\bUX\\b|mobile' }, research: true },
  accessibility: { pack: 'web-product', name: 'Ari', role: 'Accessibility Advisor', short: 'A11Y', color: '#5eead4', model: 'sonnet',
    bio: 'Checks keyboard, screen-reader, contrast and motion needs before anything ships.',
    lens: 'You are Ari, Accessibility Advisor. Check keyboard access, focus order, screen-reader names, contrast, motion and touch targets against WCAG 2.2 AA. Cite the exact element or file; say what you could not test.',
    triggers: { areas: ['frontend', 'fullstack'], pattern: 'form|button|modal|dialog|menu|navigation|a11y|accessib|keyboard|screen ?reader|contrast' } },
  security: { pack: 'security', name: 'Kai', role: 'Security Reviewer', short: 'SEC', color: '#f472b6', model: 'opus',
    bio: 'Looks for auth, secrets, injection and data-exposure risks in plans.',
    lens: 'You are Kai, Security Reviewer. Look for authentication and authorization gaps, secret handling, injection, unsafe deserialization, SSRF, data exposure and missing audit trails. Name the threat, the asset and the concrete fix; separate verified findings from hypotheses.',
    triggers: { areas: [], pattern: 'auth|login|password|token|secret|session|permission|role|oauth|payment|card|billing|pii|personal data|encrypt|upload|webhook' }, research: true },
  privacy: { pack: 'security', name: 'Noor', role: 'Privacy Advisor', short: 'PRV', color: '#fda4af', model: 'sonnet',
    bio: 'Keeps personal data minimal, consented and deletable.',
    lens: 'You are Noor, Privacy Advisor. Check what personal data is collected, why, where it flows, how long it is kept and how a user can see or delete it. Flag tracking, logging of personal data, and third parties.',
    triggers: { areas: [], pattern: 'user data|personal|email address|phone|location|tracking|analytics|consent|gdpr|ccpa|retention|delete account' } },
  'data-ml': { pack: 'data', name: 'Dana', role: 'Data & ML Advisor', short: 'ML', color: '#a5b4fc', model: 'opus',
    bio: 'Reviews pipelines, datasets and model evaluation for leakage and bias.',
    lens: 'You are Dana, Data & ML Advisor. Challenge data leakage, sampling bias, label quality, evaluation design, drift and reproducibility. Require a held-out evaluation and a baseline for any model claim.',
    triggers: { areas: [], pattern: 'model|training|dataset|pipeline|etl|feature store|embedding|prediction|forecast|classif|recommend|llm|evaluation' }, research: true },
  mobile: { pack: 'mobile', name: 'Mika', role: 'Mobile Advisor', short: 'MOB', color: '#93c5fd', model: 'sonnet',
    bio: 'Thinks about small screens, flaky networks, battery and app-store rules.',
    lens: 'You are Mika, Mobile Advisor. Check small-screen layout, offline and flaky-network behaviour, battery and data use, permissions prompts, deep links and app-store review rules.',
    triggers: { areas: ['frontend', 'fullstack'], pattern: 'mobile|ios|android|react native|flutter|push notification|offline|app store|play store' } },
  devops: { pack: 'ops', name: 'Ola', role: 'Release & Infra Advisor', short: 'OPS', color: '#fcd34d', model: 'sonnet',
    bio: 'Reviews deploys, migrations, rollbacks and observability for plans.',
    lens: 'You are Ola, Release & Infra Advisor. Check deploy order, migrations and backfills, feature flags, rollback, capacity, alerts and runbooks. Every risky change needs a tested way back.',
    triggers: { areas: ['infra', 'db'], pattern: 'deploy|migration|kubernetes|docker|terraform|ci/cd|pipeline|rollback|feature flag|cron|queue|cache|scal' } },
  'trading-advisor': { pack: 'trading', name: 'Alex', role: 'Trading Workflow Advisor', short: 'TWA', color: '#fbbf24', model: 'opus',
    bio: 'Reviews dashboard clarity and trading workflows using recorded evidence; never places trades.',
    lens: 'You are Alex, an AI Trading Workflow Advisor. Represent a trader using the dashboard. Evaluate clarity, timeliness, misleading data, interruptions, and decision usefulness. Do not claim professional credentials, profitability or observed user feedback. Never place trades or access brokers.',
    triggers: { areas: [], pattern: 'trad|dashboard|portfolio|position|order|liquidat|risk|P&L|market' }, research: true, assess: 'market|price|quote|broker|option|trade' },
  'quant-research': { pack: 'trading', name: 'Reese', role: 'Quant Researcher', short: 'QR', color: '#a5b4fc', model: 'opus',
    bio: 'Reviews hypotheses, statistical validity and reproducible experiments on demand.',
    lens: 'You are Reese, Quant Researcher. Challenge data leakage, overfitting, selection bias, statistical power, costs and reproducibility. Require out-of-sample evidence for performance claims; propose falsifiable experiments. No live trades.',
    triggers: { areas: [], pattern: '\\balpha\\b|backtest|predict|forecast|signal|strategy|statistical|machine learning' }, research: true, assess: 'market|price|quote|broker|option|trade|paper|arxiv|research|academic|dataset|econom' },
};
export const PACKS = {
  'web-product': { label: 'Web product', advisors: ['product-design', 'accessibility'], why: 'People use it through a web or app interface.' },
  security: { label: 'Security & privacy', advisors: ['security', 'privacy'], why: 'It handles logins, payments or personal data.' },
  data: { label: 'Data & ML', advisors: ['data-ml'], why: 'It has data pipelines, datasets or models.' },
  mobile: { label: 'Mobile', advisors: ['mobile'], why: 'It ships to phones or must work offline.' },
  ops: { label: 'Release & infra', advisors: ['devops'], why: 'It deploys services, runs migrations or manages infrastructure.' },
  trading: { label: 'Trading', advisors: ['trading-advisor', 'quant-research'], why: 'It shows markets, positions or trading decisions.' },
};
/** The legacy desk's advisors and their gate behaviour (today's product reviews require their support). */
export const LEGACY_ADVISORS = ['product-design', 'trading-advisor', 'quant-research'];

const SAFE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Compile a project's team.json into seat objects (core + advisors) and a list of problems. Unknown or malformed entries
 * are problems, never silently dropped. Custom advisors are allowed: id, name, role, lens and triggers only.
 */
export function compileTeam(manifest, { legacy = false } = {}) {
  const problems = [];
  const advisors = [];
  const core = {};
  if (legacy) {
    for (const id of LEGACY_ADVISORS) advisors.push({ id, ...ADVISORS[id], gate: true });
    return { advisors, core, problems };
  }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== 1) return { advisors, core, problems: ['team.json must be an object with "version": 1'] };
  for (const [id, o] of Object.entries(manifest.core || {})) {
    if (!CORE[id]) { problems.push(`core seat "${id}" does not exist`); continue; }
    const out = {};
    if (o.name !== undefined) { const n = str(o.name, 40); if (n) out.name = n; else problems.push(`core seat ${id}: name is empty`); }
    if (o.enabled === false) { if (CORE[id].optional) out.enabled = false; else problems.push(`${CORE[id].role} cannot be switched off`); }
    core[id] = out;
  }
  const seen = new Set();
  for (const a of manifest.advisors || []) {
    const id = typeof a === 'string' ? a : a?.id;
    if (!SAFE_ID.test(String(id || ''))) { problems.push(`advisor id "${id}" is not valid (lowercase letters, digits and dashes)`); continue; }
    if (seen.has(id) || CORE[id]) { problems.push(`advisor "${id}" is listed twice or clashes with a core seat`); continue; }
    seen.add(id);
    const base = ADVISORS[id];
    const custom = typeof a === 'object' ? a : {};
    if (!base && !custom.lens) { problems.push(`custom advisor "${id}" needs a name, role and lens`); continue; }
    let pattern = custom.triggers?.pattern ?? base?.triggers.pattern ?? '';
    try { new RegExp(pattern, 'i'); } catch { problems.push(`advisor ${id}: trigger pattern is not a valid expression`); pattern = ''; }
    advisors.push({ id, pack: base?.pack || 'custom', short: base?.short || id.slice(0, 3).toUpperCase(), color: base?.color || '#cbd5e1', model: base?.model || 'sonnet',
      name: str(custom.name, 40) || base?.name || id, role: str(custom.role, 60) || base?.role || 'Advisor', bio: str(custom.bio, 200) || base?.bio || '',
      lens: str(custom.lens, 2000) || base.lens,
      triggers: { areas: Array.isArray(custom.triggers?.areas) ? custom.triggers.areas.map(String) : base?.triggers.areas || [], pattern },
      research: custom.research ?? base?.research ?? false, assess: base?.assess || '', gate: false });
  }
  return { advisors, core, problems };
}

/** Does an advisor join the plan review of this ticket? */
export function advisorMatches(a, t) {
  const text = `${t.title || ''} ${t.description || ''}`;
  if ((a.triggers?.areas || []).includes(t.area)) return true;
  return !!a.triggers?.pattern && new RegExp(a.triggers.pattern, 'i').test(text);
}

/**
 * Coverage: does this team (seat objects with `enabled`) have everyone its workflows need? Checked when a team is
 * approved or seats are switched off; validating seats one by one is not enough.
 */
export function teamCoverage(seats, { independentSeats = ['principal-be', 'principal-fe', 'senior-be', 'senior-fe', 'dba'] } = {}) {
  const on = new Set(seats.filter((s) => s.enabled !== false).map((s) => s.id));
  const problems = [];
  for (const id of ['manager', 'qa', 'support']) if (!on.has(id)) problems.push(`${CORE[id].role} is required`);
  if (!['senior-be', 'senior-fe', 'dba', 'junior'].some((id) => on.has(id))) problems.push('at least one builder (senior, database or junior engineer) must be on');
  if (!['principal-be', 'principal-fe'].some((id) => on.has(id))) problems.push('at least one principal engineer must be on to design large or risky work');
  if (independentSeats.filter((id) => on.has(id)).length < 2) problems.push('code review needs at least two engineers who can review independently (an author never reviews their own work)');
  return problems;
}
