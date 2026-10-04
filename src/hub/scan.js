// Read-only repository scan for onboarding: what the project is made of, how it is tested, how it ships. It reads the
// list of tracked files and a few small manifest files; it never runs scripts, installs dependencies or touches
// submodules. Every finding carries its evidence so the owner can see why it was suggested and correct it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRepo } from '../projects.js';
import { parseWorkflow, pullRequestTriggers } from '../workflows.js';

const MAX_FILES = 40_000;
const MAX_MANIFEST = 256 * 1024;
const LANG = { '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
  '.rb': 'Ruby', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.dart': 'Dart', '.php': 'PHP', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.scala': 'Scala',
  '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL', '.ex': 'Elixir', '.exs': 'Elixir' };
// dependency name → [label, signal]
const DEPS = [
  [/^(react|react-dom)$/, 'React', 'ui'], [/^next$/, 'Next.js', 'ui'], [/^vue$/, 'Vue', 'ui'], [/^svelte|@sveltejs\/kit$/, 'Svelte', 'ui'], [/^@angular\/core$/, 'Angular', 'ui'],
  [/^(express|fastify|koa|@nestjs\/core|hono)$/, 'Node server', 'backend'], [/^(django|flask|fastapi|starlette|aiohttp)$/i, 'Python web', 'backend'],
  [/^(rails|sinatra)$/, 'Ruby web', 'backend'], [/^(react-native|expo)$/, 'React Native', 'mobile'], [/^flutter$/, 'Flutter', 'mobile'], [/^electron$/, 'Electron', 'ui'],
  [/^(prisma|@prisma\/client|typeorm|sequelize|knex|drizzle-orm|sqlalchemy|alembic|psycopg2?|asyncpg|pg|mysql2?|mongoose|redis|ioredis)$/i, 'Database', 'db'],
  [/^(stripe|@stripe\/stripe-js|braintree|paypal|adyen)/i, 'Payments', 'payments'],
  [/^(next-auth|passport|@auth0|@clerk|firebase-admin|@supabase\/supabase-js|jsonwebtoken|bcrypt|argon2|django-allauth|authlib|python-jose|devise)/i, 'Auth', 'auth'],
  [/^(torch|tensorflow|keras|scikit-learn|sklearn|xgboost|lightgbm|transformers|pandas|numpy|polars|pyspark|langchain|openai|@anthropic-ai\/sdk)$/i, 'Data & ML', 'ml'],
  [/^(alpaca|alpaca-trade-api|alpaca-py|ib_insync|ccxt|yfinance|polygon-api-client|ta-lib|backtrader|vectorbt)/i, 'Trading libraries', 'trading'],
];

const readSmall = (file) => { try { const st = fs.statSync(file); return st.size <= MAX_MANIFEST ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; } };

function depsOf(root, files) {
  const deps = new Map(); // name → evidence file
  const add = (name, where) => { if (name && !deps.has(name)) deps.set(name, where); };
  for (const f of files.filter((x) => /(^|\/)package\.json$/.test(x) && !x.includes('node_modules/')).slice(0, 20)) {
    try { const j = JSON.parse(readSmall(path.join(root, f))); for (const k of Object.keys({ ...j.dependencies, ...j.devDependencies })) add(k, f); } catch { /* not JSON */ }
  }
  for (const f of files.filter((x) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg)$/.test(x)).slice(0, 20)) {
    for (const m of readSmall(path.join(root, f)).matchAll(/^\s*["']?([A-Za-z0-9_.-]+)\s*(?:[<>=~!;\[" ']|$)/gm)) add(m[1].toLowerCase(), f);
  }
  for (const f of files.filter((x) => /(^|\/)(Gemfile|pubspec\.yaml|go\.mod|Cargo\.toml)$/.test(x)).slice(0, 10)) {
    const text = readSmall(path.join(root, f));
    if (/pubspec\.yaml$/.test(f) && /flutter:/.test(text)) add('flutter', f);
    for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)/gm)) add(m[1], f);
  }
  return deps;
}

export function scanRepo(repoPath) {
  const repo = inspectRepo(repoPath);
  const root = repo.repoPath;
  let files = [];
  try { files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean).slice(0, MAX_FILES); } catch { files = []; }
  const langs = {};
  for (const f of files) { const l = LANG[path.extname(f).toLowerCase()]; if (l) langs[l] = (langs[l] || 0) + 1; }
  const languages = Object.entries(langs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, files: count }));
  const deps = depsOf(root, files);
  const signals = {}; // signal → [evidence]
  const note = (sig, evidence) => { (signals[sig] ||= []); if (signals[sig].length < 4 && !signals[sig].includes(evidence)) signals[sig].push(evidence); };
  const stack = new Set();
  for (const [name, where] of deps) for (const [re, label, sig] of DEPS) if (re.test(name)) { stack.add(label); note(sig, `${where}: ${name}`); }
  const has = (re) => files.find((f) => re.test(f));
  const evid = (re, sig, label) => { const f = has(re); if (f) { note(sig, f); if (label) stack.add(label); } };
  evid(/\.(tsx|jsx|vue|svelte)$/, 'ui'); evid(/(^|\/)(ios|android)\//, 'mobile', 'Native mobile');
  evid(/(^|\/)(migrations|alembic|db\/migrate|prisma\/migrations)\//, 'db'); evid(/\.sql$/, 'db');
  evid(/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/, 'infra', 'Docker'); evid(/\.tf$/, 'infra', 'Terraform'); evid(/(^|\/)(k8s|kubernetes|helm)\//, 'infra', 'Kubernetes');
  evid(/(^|\/)(auth|login|oauth)[^/]*\.(py|ts|js|go|rb)$/i, 'auth');
  if (languages.some((l) => ['Python', 'Go', 'Rust', 'Java', 'Ruby', 'PHP', 'C#', 'Kotlin', 'Elixir'].includes(l.name))) note('backend', `${languages.find((l) => ['Python', 'Go', 'Rust', 'Java', 'Ruby', 'PHP', 'C#', 'Kotlin', 'Elixir'].includes(l.name)).name} code`);
  evid(/(^|\/)(server|api|backend|routes?)[^/]*\.(js|ts|mjs)$|(^|\/)(server|api|backend)\//, 'backend');
  // Tests: how the project says to run them (read, never run).
  const tests = [];
  try { const pj = JSON.parse(readSmall(path.join(root, 'package.json'))); if (pj.scripts?.test && !/no test specified/.test(pj.scripts.test)) tests.push({ command: 'npm test', evidence: `package.json scripts.test: ${pj.scripts.test.slice(0, 80)}` }); } catch { /* none */ }
  if (deps.has('pytest') || has(/(^|\/)(pytest\.ini|conftest\.py)$/)) tests.push({ command: 'pytest', evidence: deps.has('pytest') ? `${deps.get('pytest')}: pytest` : has(/(^|\/)(pytest\.ini|conftest\.py)$/) });
  if (has(/(^|\/)go\.mod$/)) tests.push({ command: 'go test ./...', evidence: 'go.mod' });
  if (has(/(^|\/)Cargo\.toml$/)) tests.push({ command: 'cargo test', evidence: 'Cargo.toml' });
  // CI: which workflows run on pull requests, which run on pushes to the base (often deploys).
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).slice(0, 40).map((file) => {
    const wf = parseWorkflow(readSmall(path.join(root, file)));
    const onPr = !!wf && pullRequestTriggers(wf, repo.baseBranch, ['x']) || (!!wf?.on && ('pull_request' in wf.on || 'pull_request_target' in wf.on));
    const onPush = !!wf?.on && 'push' in wf.on;
    const deploys = /deploy|release|publish|(^|[^a-z])cd([^a-z]|$)/i.test(`${path.basename(file)} ${wf?.name || ''}`.replace(/ci-?cd/gi, (m) => (m.includes('-') ? 'ci cd' : 'ci')));
    if (deploys) note('deploys', file);
    return { file, name: wf?.name || path.basename(file), pullRequests: onPr, pushes: onPush, deploys };
  });
  const prPaths = workflows.filter((w) => w.pullRequests);
  return {
    repo, files: files.length, languages, stack: [...stack].sort(), signals, tests, workflows,
    ci: { pullRequestWorkflows: prPaths.map((w) => w.name), deployWorkflows: workflows.filter((w) => w.deploys).map((w) => w.name) },
    areas: ['frontend', 'backend', 'db', 'infra'].filter((a) => signals[{ frontend: 'ui', backend: 'backend', db: 'db', infra: 'infra' }[a]]),
  };
}
