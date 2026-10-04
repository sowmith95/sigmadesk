import { ENGINES, suggestFor } from './engines/index.js';
import { agentById } from './team.js';
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export function supportsSeat(id, engine) {
  const e = ENGINES[engine];
  return !!e && (agentById[id]?.kinds || []).every(kind => !e.supports || e.supports(kind));
}
export function profileFor(id, profile) {
  if (!supportsSeat(id, profile.engine)) fail('This provider cannot perform this role; implementation and QA need a local execution provider');
  const e = ENGINES[profile.engine];
  const model = e.models().find(m => m.id === profile.model);
  if (!model) fail(`Model is outside the ${e.label} catalog`);
  if (!(model.efforts?.length ? model.efforts : e.efforts).includes(profile.effort)) fail('Unsupported reasoning effort for this model');
  return { engine: profile.engine, model: profile.model, effort: profile.effort };
}
export function normalizeSeat(id, input, previous = agentById[id]) {
  if (!previous || !input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid seat settings');
  const engine = input.engine || previous.engine;
  const defaults = engine === previous.engine ? previous : suggestFor(id, engine);
  const main = profileFor(id, { engine, model: input.model ?? defaults.model, effort: input.effort ?? defaults.effort });
  const fallbacks = input.fallback_mode === 'automatic' ? undefined : input.fallbacks === undefined ? previous.fallbacks : input.fallbacks;
  if (fallbacks !== undefined && (!Array.isArray(fallbacks) || fallbacks.length > 3)) fail('Choose up to three fallback models');
  const normalized = fallbacks?.map(f => profileFor(id, f));
  const signatures = [main, ...(normalized || [])].map(p => `${p.engine}:${p.model}`);
  if (new Set(signatures).size !== signatures.length) fail('Primary and fallback models must be distinct');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('Enabled must be true or false');
  return { ...main, enabled: input.enabled ?? previous.enabled, ...(normalized ? { fallbacks: normalized } : {}) };
}
