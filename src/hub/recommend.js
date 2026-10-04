// Team recommendation for onboarding: the smallest team that covers the project's workflows, from the scan (what the
// code is) and the owner's answers (what matters). Every suggestion says why, with evidence; the owner decides.
import { CORE, ADVISORS, PACKS, teamCoverage, CORE_IDS } from '../team-catalog.js';

/** Owner answers the wizard collects (all optional; the scan fills the technical side). */
export const QUESTIONS = {
  neverBreak: [['money', 'Money and payments'], ['auth', 'Logins and permissions'], ['personal', 'Personal data'], ['uptime', 'Uptime'], ['data', 'Data integrity'], ['accessibility', 'Accessibility']],
  domains: [['web', 'A web or app product'], ['api', 'An API or backend service'], ['data', 'Data or ML'], ['mobile', 'A mobile app'], ['infra', 'Infrastructure or tooling'], ['trading', 'Trading or markets']],
  authority: [['build', 'Build on branches; I open PRs'], ['prs', 'Build and open pull requests'], ['merge-ready', 'Open PRs; queue merges I approve']],
};

export function recommendTeam(scan = {}, answers = {}) {
  const sig = scan.signals || {};
  const areas = new Set(scan.areas || []);
  const never = new Set(answers.neverBreak || []);
  const domains = new Set(answers.domains || []);
  const ev = (s) => (sig[s] || []).slice(0, 2);
  const frontend = areas.has('frontend') || domains.has('web') || domains.has('mobile');
  const backend = areas.has('backend') || domains.has('api') || domains.has('data') || !frontend;
  const db = areas.has('db');

  const core = CORE_IDS.map((id) => ({ id, role: CORE[id].role, required: !CORE[id].optional, on: true, why: CORE[id].why, evidence: [] }));
  const set = (id, on, why, evidence = []) => { const c = core.find((x) => x.id === id); if (c && !c.required) Object.assign(c, { on, why: why || c.why, evidence }); };
  if (!frontend) { set('principal-fe', false, 'No user interface found, so no frontend design seat.'); set('senior-fe', false, 'No user interface found.'); }
  else { set('principal-fe', true, CORE['principal-fe'].why, ev('ui')); set('senior-fe', true, CORE['senior-fe'].why, ev('ui')); }
  if (!backend) { set('principal-be', false, 'No server code found.'); set('senior-be', false, 'No server code found.'); }
  else { set('principal-be', true, CORE['principal-be'].why, ev('backend')); set('senior-be', true, CORE['senior-be'].why, ev('backend')); }
  set('dba', db, db ? CORE.dba.why : 'No migrations or SQL found; the backend engineers cover data changes.', ev('db'));
  set('pm', !!answers.research?.enabled, answers.research?.enabled ? 'You asked the desk to research ideas for you.' : 'Off: you will bring the ideas. Turn on to have the desk research proposals.');
  set('sre', !!answers.watchLogs, answers.watchLogs ? 'You want the desk to watch error logs and investigate failures.' : 'Off until you connect error logs.');

  const want = new Map(); // advisor id → { why, evidence }
  const add = (id, why, evidence = []) => { if (!want.has(id)) want.set(id, { why, evidence }); };
  if (frontend) add('product-design', PACKS['web-product'].why, ev('ui'));
  if (never.has('accessibility')) add('accessibility', 'You said accessibility must never break.');
  if (sig.auth || sig.payments || never.has('auth') || never.has('money')) add('security', PACKS.security.why, [...ev('auth'), ...ev('payments'), ...(never.has('money') ? ['you: money must never break'] : []), ...(never.has('auth') ? ['you: logins must never break'] : [])].slice(0, 3));
  if (never.has('personal')) add('privacy', 'You said personal data must never break.');
  if (sig.ml || domains.has('data')) add('data-ml', PACKS.data.why, ev('ml'));
  if (sig.mobile || domains.has('mobile')) add('mobile', PACKS.mobile.why, ev('mobile'));
  if (sig.deploys || sig.infra || never.has('uptime') || domains.has('infra')) add('devops', PACKS.ops.why, [...ev('deploys'), ...ev('infra')].slice(0, 3));
  if (sig.trading || domains.has('trading')) for (const id of PACKS.trading.advisors) add(id, PACKS.trading.why, ev('trading'));
  const advisors = [...want].map(([id, w]) => ({ id, name: ADVISORS[id].name, role: ADVISORS[id].role, pack: ADVISORS[id].pack, bio: ADVISORS[id].bio, on: true, suggested: true, ...w }));
  // Everything else in the catalog stays available to switch on.
  const more = Object.entries(ADVISORS).filter(([id]) => !want.has(id)).map(([id, a]) => ({ id, name: a.name, role: a.role, pack: a.pack, bio: a.bio, on: false, why: PACKS[a.pack]?.why || '', evidence: [] }));
  const gaps = teamCoverage(core.map((c) => ({ id: c.id, enabled: c.on })));
  return { core, advisors: [...advisors, ...more], gaps };
}

/** The team.json a recommendation (as edited by the owner) becomes. */
export function manifestFrom(rec, custom = []) {
  const core = {};
  for (const c of rec.core) if (!c.required && !c.on) core[c.id] = { enabled: false };
  return { version: 1, advisors: [...rec.advisors.filter((a) => a.on).map((a) => a.id), ...custom], core };
}
