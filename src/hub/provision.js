// Create a project from the setup wizard: the owner's answers become its config and playbook, the team they approved
// becomes team.json, and the approval itself is recorded so the desk does not ask again. Nothing outside the project's
// own folders changes here; installing the service is a separate, explicit step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createProject, updateProject } from '../projects.js';

const LOOPBACK = /^(127\.|::1$|localhost$)/;
const clampNum = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const lines = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean).slice(0, 30) : []);
const NEVER = { money: 'Money and payments', auth: 'Logins and permissions', personal: 'Personal data', uptime: 'Uptime', data: 'Data integrity', accessibility: 'Accessibility' };

export function playbookFrom(name, answers = {}, scan = {}) {
  const tests = (scan.tests || []).map((t) => `- \`${t.command}\` (${t.evidence})`).join('\n') || '- (add the commands that prove a change works)';
  const never = [...lines(answers.neverBreak).map((k) => NEVER[k] || k), ...lines(answers.neverTouchPaths).map((p) => `\`${p}\` (never change without the owner)`)];
  return `# ${name}: how to work here

${String(answers.summary || 'Describe what this project does and who uses it.').trim().slice(0, 2000)}

## Who uses it
${String(answers.audience || '(who the users are)').trim().slice(0, 600)}

## What to work on first
${String(answers.firstGoal || '(the owner will add tickets)').trim().slice(0, 1200)}

## Stack
${(scan.stack || []).join(', ') || '(not detected)'}; languages: ${(scan.languages || []).map((l) => l.name).join(', ') || '(not detected)'}.

## Build and test
${tests}

## Must never break
${never.length ? never.map((n) => (n.startsWith('-') ? n : `- ${n}`)).join('\n') : '- (nothing listed yet)'}
`;
}

/**
 * answers: { summary, audience, firstGoal, neverBreak[], neverTouchPaths[], authority, quietHours: { enabled, label,
 * timezone, days, start, end }, budgetUsd, research: { enabled }, watchLogs } — team: a team.json manifest.
 */
export function provisionProject({ repoPath, name, answers = {}, scan = {}, team, hosts = ['127.0.0.1'], root } = {}) {
  const p = createProject({ repoPath, name, team, root });
  const file = path.join(p.home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.server = { ...cfg.server, hosts: lines(hosts).length ? lines(hosts) : ['127.0.0.1'] };
  if (cfg.server.hosts.some((h) => !LOOPBACK.test(h))) cfg.server.ownerToken = crypto.randomBytes(18).toString('base64url'); // reachable beyond this machine: require a token
  cfg.pm = { ...cfg.pm, enabled: !!answers.research?.enabled, persona: String(answers.audience || cfg.pm.persona).slice(0, 300) };
  cfg.limits = { ...cfg.limits, dailyBudgetUsd: clampNum(answers.budgetUsd, 1, 10_000, 25) };
  const q = answers.quietHours || {};
  cfg.limits.busyWindow = q.enabled ? { enabled: true, label: String(q.label || 'Busy hours').slice(0, 40), timezone: String(q.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone),
    days: Array.isArray(q.days) && q.days.length ? q.days.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5],
    start: /^\d\d:\d\d$/.test(q.start) ? q.start : '09:00', end: /^\d\d:\d\d$/.test(q.end) ? q.end : '17:00', maxConcurrent: 1 } : { enabled: false };
  const prs = ['prs', 'merge-ready'].includes(answers.authority);
  cfg.github = { ...cfg.github, sync: prs && !!cfg.project.githubRepo, openDraftPrs: prs };
  const extra = lines(answers.neverTouchPaths);
  if (extra.length) cfg.project.protectedPaths = [...new Set([...(cfg.project.protectedPaths || []), ...extra])];
  // The owner approved this team in the wizard: the desk records it instead of asking again. It still starts paused.
  cfg.bootstrap = { teamConfirmed: true, approvedAt: new Date().toISOString(), approvedBy: 'owner, in the setup wizard' };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(p.home, 'playbook.md'), playbookFrom(p.name, answers, scan), { mode: 0o600 });
  updateProject(p.id, { state: 'ready', answers_summary: String(answers.summary || '').slice(0, 300) }, root);
  return { ...p, token: cfg.server.ownerToken || '' };
}
