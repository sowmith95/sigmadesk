// Who acts, per ACTION (never per agent), said in two separate dimensions (sowmith95/sigmadesk#6):
//   AUTHORIZED MODE — what the owner's policy and config allow: human-led (the owner performs it), assisted (seats prepare,
//                     the owner authorizes), autonomous (the desk executes it within policy).
//   READINESS       — whether that mode can act right now: ready, or blocked with ordered reasons (a failed CI run makes an
//                     autonomous merge blocked; it does not make it human-led).
// Pure, and DESCRIPTIVE ONLY: it reads the same settings and config the gates read at execution time, adds no capability,
// and has no way to say "production writes" or "trading" — those are not actions any seat can take.
const list = (xs) => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
export const MODES = ['human-led', 'assisted', 'autonomous'];
export const MODE_LABEL = { 'human-led': 'Human-led', assisted: 'Assisted', autonomous: 'Autonomous' };
export const NOT_REPRESENTABLE = [
  { id: 'prod_write', label: 'Production writes, restarts and hand deploys', text: 'No seat can do these: the desk has read-only probes only, so there is no level to set.' },
  { id: 'trading', label: 'Trading and broker actions', text: 'No seat can place, change or cancel orders. Not representable.' },
];
const R = (state, reasons = []) => ({ state: reasons.length ? 'blocked' : state, reasons });

/**
 * facts: { settings, seats: { manager, sre, builders: n, reviewers: n }, autoMerge: { enabled, excludeRiskHigh }, mergeTrain,
 *   reviewsRequired, requiredChecks: { names, unknownBlocks }, busyWindow: { enabled, days, start, end, timezone }, busyNow,
 *   windowEnd, deployLock, ops: { configured, on, verify }, policy (access), grants: [{ seat_name, expires_at }], budgetLeft,
 *   names: { manager, sre }, policyVersion }
 * → { policy_version, actions: [...], not_representable }
 */
export function matrix(f) {
  const s = f.settings || {};
  const halted = s.paused === 'true';
  // The scheduler starts a run only when the day's headroom covers that run's full cap (scheduler: headroom < need).
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const budgetFor = (kind, cap) => (f.budgetLeft != null && cap != null && f.budgetLeft < cap ? [`The daily budget has ${money(Math.max(0, f.budgetLeft))} left; a ${kind} run reserves ${money(cap)}.`] : []);
  const halt = halted ? ['The desk is halted (Desk → Resume).'] : [];
  const caps = f.caps || {};
  const common = [...halt, ...budgetFor('build', caps.implement ?? 0.01)];
  const mgr = f.names?.manager || 'The manager', sre = f.names?.sre || 'The SRE';
  const am = f.autoMerge || {};
  const trainOn = f.mergeTrain !== false && am.enabled && (f.reviewsRequired ?? 2) > 0;
  const gh = s.github_sync === 'true';
  const lock = f.deployLock;
  const lockBad = lock && ['failed', 'escalated'].includes(lock.state);
  const mergeBlocks = [...(halted ? ['The desk is halted (Desk → Resume).'] : []), ...(!gh ? ['GitHub sync is off (Settings → GitHub).'] : []),
    ...(f.requiredChecks?.unknownBlocks ? ['It waits until you confirm which CI checks a merge needs (Settings → GitHub).'] : [])];
  const cfg = (path, text) => ({ kind: 'config', editable: false, path, text: text || `Set in sigmadesk.config.json (${path}). There is no owner setting for it here yet.` });
  const actions = [];

  actions.push({ id: 'groom', label: 'Triage and grooming', scope: 'New tasks; a feature’s plan always waits for your approval',
    mode: f.seats?.manager ? 'autonomous' : 'human-led',
    mode_text: f.seats?.manager ? `${mgr} sizes, staffs and splits new tasks by itself. Feature plans are assisted: you approve each plan.` : `${mgr}'s seat is off, so nobody grooms: new requests wait for you.`,
    readiness: R('ready', f.seats?.manager ? [...halt, ...budgetFor('grooming', caps.groom ?? 0.01)] : []), control: { kind: 'link', to: 'team', editable: false, text: 'Seat on or off in Team; halt or resume on Desk.' } });

  actions.push({ id: 'implement', label: 'Implementation', scope: 'Groomed tasks, through QA and two code reviews',
    mode: f.seats?.builders ? 'autonomous' : 'human-led',
    mode_text: f.seats?.builders ? 'Engineers build groomed tasks; QA and two reviewers check every commit. A task you take yourself is human-led.' : 'Every builder seat is off: nobody builds.',
    readiness: R('ready', f.seats?.builders ? common : []), control: { kind: 'link', to: 'desk', editable: false, text: 'Halt or resume on Desk; per task: “I will do this one myself”.' } });

  actions.push({ id: 'merge_low', label: 'Merge · low risk', scope: 'Stored risk AND the diff classifier both say low',
    mode: trainOn ? 'autonomous' : 'assisted',
    mode_text: trainOn ? 'The desk merges it after QA, two approvals and green CI, one at a time.' : `Reviewers approve; you merge (${!am.enabled ? 'automatic merging is off' : 'the merge train is off'}).`,
    readiness: R('ready', trainOn ? mergeBlocks : []), control: cfg('review.autoMerge.enabled') });

  const highAuto = trainOn && am.excludeRiskHigh === false;
  actions.push({ id: 'merge_high', label: 'Merge · high or unknown risk', scope: 'Trading, broker, risk, schema or deploy paths; or no risk recorded',
    mode: highAuto ? 'autonomous' : 'assisted',
    mode_text: highAuto ? 'The desk merges it like low-risk work.' : 'Reviewers approve; you merge. The owner requirement for high and unknown risk is on.',
    waiver: highAuto ? 'Waived in your config: review.autoMerge.excludeRiskHigh is false, so high-risk work merges without you.' : null,
    readiness: R('ready', highAuto ? mergeBlocks : []), control: cfg('review.autoMerge.excludeRiskHigh') });

  const bw = f.busyWindow || {};
  const deployBlocks = [...(lockBad ? [`The last deploy (${lock.key || 'last merge'}) ${lock.state === 'failed' ? 'failed' : 'was never confirmed'}: every deploying merge waits until you check it.`] : []),
    ...(lock && ['running', 'merging'].includes(lock.state) ? [`The deploy of ${lock.key || 'the last merge'} is running; the next deploying merge waits for it.`] : []),
    ...(f.busyNow ? [`Inside the busy window${f.windowEnd ? ` until ${f.windowEnd}` : ''}: deploying merges are scheduled for its end.`] : [])];
  actions.push({ id: 'deploy_timing', label: 'Deploy timing', scope: 'Merges that start a deploying workflow',
    mode: 'autonomous',
    mode_text: bw.enabled ? `The desk holds its deploying merges inside the busy window (${bw.start}–${bw.end}, ${bw.timezone}) and deploys one at a time. Your own merge inside it needs the market-hours override.`
      : 'No busy window is configured: deploying merges go when ready, one at a time.',
    readiness: R('ready', deployBlocks), control: cfg('limits.busyWindow') });

  const ops = f.ops || {};
  // The SRE runs the checks, and the SRE approves access for others: its OWN access is always the owner's decision
  // (access.violations), so a production check is assisted at best: the desk prepares, you grant.
  const sreGrant = (f.grants || []).concat(f.ownerGrants || []).find((g) => g.seat === 'sre');
  const opsMode = !ops.configured || !ops.on || !ops.verify || !f.seats?.sre ? 'human-led' : 'assisted';
  actions.push({ id: 'prod_read', label: 'Production read checks', scope: '“Verify in production” tasks, read-only probes only',
    mode: opsMode,
    mode_text: !ops.configured ? 'Not configured on this desk (ops.enabled in the config): every production check is yours.'
      : !ops.on ? 'Production read access is off: every production check is yours.'
        : !f.seats?.sre ? `${sre}'s seat is off: every production check is yours.`
          : !ops.verify ? 'Verify runs are not allowed to probe (ops.kinds): every production check is yours.'
            : `${sre} verifies with read-only probes once access is granted. ${sre} approves access for others, so ${sre}'s own access is always yours to grant.`,
    // Readiness, separately: can a check actually run now? Grants, halt, budget, and something for the probes to read.
    readiness: R('ready', opsMode === 'human-led' ? [] : [...halt.map((r) => r.replace('.', ': no verify run starts.')), ...budgetFor('verify', caps.verify ?? 0.01),
      ...(!sreGrant ? [`${sre} holds no production access: a check waits until you grant it (Inbox request, or Settings → Production access).`] : []),
      ...(ops.targets === 0 ? ['No database or container is configured for the probes, so they have nothing to read.'] : [])]),
    grant: sreGrant || null,
    control: ops.configured ? { kind: 'setting', key: 'ops_enabled', editable: true, value: ops.on, text: 'Production read access (Settings). Off stops every probe at once.' } : cfg('ops.enabled') });

  const tagAuto = f.policy?.ownerMentionAutoGrant !== false;
  actions.push({ id: 'tag_access', label: 'Access for tagged replies', scope: 'A seat you tag in a conversation',
    mode: tagAuto ? 'autonomous' : 'assisted',
    mode_text: tagAuto ? 'A seat you tag may get read-only access for that one reply (run-bound, 60 min at most, within the policy). The EM and the SRE never: their access is yours. You can switch it off per tag.'
      : 'You decide each tagged seat’s access request in the Inbox.',
    readiness: R('ready', ops.configured && !ops.on ? ['Production read access is off, so no probe runs anyway.'] : !ops.configured ? ['Production read access is not configured on this desk.'] : []),
    control: { kind: 'policy', key: 'ownerMentionAutoGrant', editable: true, value: tagAuto, text: 'Access policy (Settings → Production access).' } });

  const pub = gh && s.open_draft_prs === 'true';
  actions.push({ id: 'publish', label: 'Publishing branches', scope: 'After QA: push the branch, open a draft PR',
    mode: pub ? 'autonomous' : 'human-led',
    mode_text: pub ? 'After QA the desk pushes the branch and opens a draft PR. The publish guard always holds protected paths (workflows, Dockerfiles, lockfiles, .env, scripts) and oversized diffs for you.'
      : `Off (${!gh ? 'GitHub sync' : 'Draft PRs'} is off): branches stay local until you publish them.`,
    waiver: null, readiness: R('ready', []),
    control: { kind: 'setting', key: 'open_draft_prs', editable: true, value: s.open_draft_prs === 'true', text: 'Open draft PRs (Settings → GitHub). The guard’s paths are config only (project.protectedPaths).' } });

  return { policy_version: f.policyVersion || null, actions, not_representable: NOT_REPRESENTABLE };
}

/**
 * One ticket's summary line: build · merge (by risk class) · production read. facts: { ticket, matrix, policy
 * (autoMergePolicy for the ticket), grants (open, for its seats or for it), nameOf } → { items, text }.
 * Each item: { id, text, mode, reason?, until? }. `until` is an ISO time the UI formats ("expires 14:30").
 */
export function forTicket({ ticket: t, matrix: m, policy = null, grants = [], nameOf = (s) => s }) {
  const by = Object.fromEntries((m?.actions || []).map((a) => [a.id, a]));
  const items = [];
  const closed = ['done', 'wontdo'].includes(t.status);
  if (!closed) {
    if (t.owner_task) items.push({ id: 'build', mode: 'human-led', text: 'Build is yours', reason: 'You took this task yourself.' });
    else if (t.status === 'needs_human') items.push({ id: 'build', mode: by.implement?.mode || 'autonomous', text: 'Build waits for you', reason: t.progress_msg || 'A question or hold is yours.' });
    else if (['triage', 'proposed'].includes(t.status)) items.push({ id: 'build', mode: by.groom?.mode, text: by.groom?.mode === 'autonomous' ? 'Grooming automatic' : 'Grooming needs you', reason: by.groom?.mode_text });
    else if (!t.pr_url || ['todo', 'in_progress', 'qa'].includes(t.status)) items.push({ id: 'build', mode: by.implement?.mode, text: by.implement?.mode === 'autonomous' ? 'Build automatic' : 'Build needs you', reason: by.implement?.mode_text,
      blocked: by.implement?.readiness?.state === 'blocked' ? by.implement.readiness.reasons[0] : null });
    // Merge by risk class: the ticket's stored risk and the diff classifier (known after QA).
    const risk = t.risk === 'low' && t.diff_risk === 'low' ? 'low' : t.risk === 'low' && !t.diff_risk ? 'low until QA reads the diff' : t.risk === 'high' || t.diff_risk === 'high' ? 'high' : 'unknown';
    const cls = risk === 'low' ? by.merge_low : by.merge_high;
    if (t.merge_hold) items.push({ id: 'merge', mode: 'human-led', text: 'merge held', reason: `On hold: ${t.merge_hold}` });
    else if (cls?.mode === 'autonomous' && risk === 'low') items.push({ id: 'merge', mode: 'autonomous', text: 'merge automatic (low risk)', reason: cls.mode_text, blocked: cls.readiness?.state === 'blocked' ? cls.readiness.reasons[0] : null });
    else if (cls?.mode === 'autonomous') items.push({ id: 'merge', mode: 'autonomous', text: `merge automatic (risk ${risk}, waived)`, reason: cls.waiver || cls.mode_text });
    else items.push({ id: 'merge', mode: 'assisted', text: `merge needs you (risk ${risk === 'low until QA reads the diff' ? 'unknown until QA' : risk})`, reason: policy?.reason ? `Needs your merge: ${policy.reason}.` : cls?.mode_text });
  }
  const g = [...grants].sort((a, b) => String(a.expires_at || '9').localeCompare(String(b.expires_at || '9')))[0];
  if (g) items.push({ id: 'prod_read', mode: by.prod_read?.mode, text: g.expires_at ? 'prod read expires' : `prod read ${g.ticket_key ? 'until the ticket closes' : 'until its run ends'}`, until: g.expires_at || null, seat: g.seat, reason: `${nameOf(g.seat)} holds read-only production access${g.reason ? `: ${g.reason}` : ''}.` });
  else if (!closed && by.prod_read) items.push({ id: 'prod_read', mode: by.prod_read.mode, text: by.prod_read.mode === 'human-led' ? 'prod checks are yours' : 'no prod read now', reason: by.prod_read.mode_text });
  if (closed && by.prod_read) items.push({ id: 'verify', mode: by.prod_read.mode, text: by.prod_read.mode === 'human-led' ? 'prod checks are yours' : 'verify in production: the SRE can check it', reason: by.prod_read.mode_text });
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  return { items, text: items.map((i, n) => (n === 0 ? cap(i.text) : i.text)).join(' · ') };
}
