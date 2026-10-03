// Engines: the CLIs that power seats. Each engine turns a seat + task into a sandboxed process and normalizes its
// output stream into desk events. Add a new engine by implementing the same shape as claude.js / codex.js.
import { claude } from './claude.js';
import { codex } from './codex.js';

export const ENGINES = { claude, codex };

// Capability tiers: what each seat needs, independent of vendor.
export const SEAT_TIER = {
  pm: 'frontier', 'principal-be': 'frontier', 'principal-fe': 'frontier',
  manager: 'strong', 'senior-be': 'strong', 'senior-fe': 'strong', dba: 'strong', sre: 'strong',
  junior: 'fast', qa: 'fast',
  support: 'cheap',
};
export const TIER_TEXT = {
  frontier: 'Hardest reasoning: architecture, research, risky changes',
  strong: 'Solid all-rounder for medium work and planning',
  fast: 'Quick and cheap for small, well-specified tasks',
  cheap: 'Routing and triage only',
};

export function suggestFor(seatId, engineId) {
  const e = ENGINES[engineId];
  return e ? e.suggest(SEAT_TIER[seatId] || 'strong') : null;
}

// Presets offered on first run. "mixed" puts review seats on a different vendor than the builders on purpose:
// a second model family catches mistakes the first one is blind to.
export function presets(available) {
  const has = (id) => available.includes(id);
  const out = [];
  if (has('claude')) out.push({ id: 'claude', label: 'All Claude', note: 'Mature OS sandbox; recommended default.', engine: () => 'claude' });
  if (has('codex')) out.push({ id: 'codex', label: 'All Codex (GPT)', note: 'Same isolation via a Codex permission profile (beta feature).', engine: () => 'codex' });
  if (has('claude') && has('codex')) {
    out.push({ id: 'mixed', label: 'Mixed: Claude builds, Codex reviews', note: 'Engineers on Claude; QA and the SRE on Codex for cross-vendor review.', engine: (id) => (['qa', 'sre'].includes(id) ? 'codex' : 'claude') });
  }
  return out;
}

export async function detectEngines() {
  const out = [];
  for (const e of Object.values(ENGINES)) out.push({ id: e.id, label: e.label, isolation: e.isolation, ...(await e.detect()), models: e.models(), efforts: e.efforts, costs: e.costNote });
  return out;
}
