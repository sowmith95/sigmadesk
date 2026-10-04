# Plan: dynamic model catalogs for Claude/Perplexity and gated Perplexity council reviews

Date: 2026-10-04. Supersedes the work in commit afe1071 (reverted in c770430).

## Summary

A Perplexity Computer session was asked to (a) expose every Perplexity model and "Model Council" in SigmaDesk,
(b) let Perplexity seats sit on architecture councils, and (c) fetch model catalogs dynamically for Claude and Codex.
It pushed afe1071 to `main`. That commit is reverted because it failed 8 tests, deleted 11 council tests, removed the
Codex read-deny sandbox profile, broke the Claude `--allowedTools` argument when the allow list is empty, and wired a
`pplx_model_council` model and `mode="council"` that do not exist in Perplexity's `models_list`
(verified live on 2026-10-04: 12 model ids, modes light/standard/high/ultra only).

This plan redoes the legitimate parts on top of the current council code without touching the sandbox profiles.

## What is already true at HEAD (c770430)

- `src/council.js` `models()` already includes any engine where `supports('council_review')` is true, so adding
  the kind to Perplexity's `THINK_KINDS` is the only switch needed to list it. It was left out on purpose:
  `docs/perplexity-connection.md` gates Computer council use behind a five-step verification (OAuth, model list,
  credit delta, interruption behaviour, locked-screen continuity) and `test/council.test.js:145` asserts the
  reviewer pool is Claude/Codex only.
- `src/engines/codex.js` already reads `~/.codex/models_cache.json` plus `config.engines.codex.models`. Nothing to
  redo there; afe1071's Codex changes were a regression, not a feature.
- `src/engines/perplexity.js` has a static `MODELS` list dated 2026-10-03 that matches today's `models_list`
  exactly (12 ids, verified 2026-10-04). What it lacks is per-model effort sets and any refresh path.

## Files

- `src/config.js` — add `engines.claude.models: []`, `engines.perplexity.models: []`,
  `engines.perplexity.councilEnabled: false`; validate shapes in the problems list.
- `src/engines/claude.js` — `models()` merges `config.engines.claude.models` into the four base tiers
  (there is no Claude Code local catalog file; configured ids are the honest dynamic source). Keep the
  `perms.allow.length` guard on `--allowedTools` exactly as it is.
- `src/engines/perplexity.js` — `models()` merges, in order: static `MODELS`, a desk-owned cache
  `data/perplexity-models.json` (written from a real `models_list` result, with `fetched_at`, 0600),
  then `config.engines.perplexity.models`. Export per-model `efforts` from the cache so seat validation can reject
  an effort the model does not support (DeepSeek V4 Pro accepts none; Grok accepts low/medium/high only).
  Add `council_review` to `THINK_KINDS` only when `config.engines.perplexity.councilEnabled` is true.
  In `relayCharter`, never emit `mode` together with `model`.
- `src/council.js` — map model family from the Perplexity id (`kimi`, `grok`, `gpt`, `claude`, `deepseek`,
  `glm`) instead of the current `codex ? 'gpt' : 'claude'` so the "two different families" rule is meaningful.
  `status().computer` reports `connected` from `providerHealth()` for the perplexity engine when the flag is on,
  and keeps the current "not verified" reason when it is off.
- `src/doctor.js` (or a `desk models refresh` command) — one explicit, owner-run step that calls `models_list`
  through the existing relay allow-list and writes `data/perplexity-models.json`. No background fetching.
- `test/council.test.js` — replace the Claude/Codex-only assertion with: pool excludes Perplexity when the flag is
  off, includes it with the right families when on. Add tests for catalog merging and effort validation.
- `README.md`, `docs/perplexity-connection.md`, `docs/product-review-and-models.md` — describe the flag and the
  refresh step; keep the statement that Model Council has no MCP interface.

## Steps

1. Config keys and validation; tests for invalid shapes.
2. Claude `models()` merge; test that base tiers stay first and duplicates are dropped.
3. Perplexity catalog merge + `data/perplexity-models.json` reader; test precedence and the `fetched_at` note.
4. Per-model effort validation in seat settings (reuse the Codex path in `src/team-settings.js`).
5. Council family mapping + flag-gated `council_review`; update tests.
6. Doctor/CLI refresh step that records `models_list` output.
7. Docs. Run `npm test` (expect 220 + new tests, 0 failures). Run `npm run doctor`.
8. Commit on a branch, open a PR (repo uses PRs with two independent reviewers; do not push to main directly).

## Risks and considerations

- Enabling Perplexity on councils before the verification protocol passes spends Computer credits with no
  cancellation path; hence the default-off flag.
- Perplexity ids and effort sets change; the cache file must carry `fetched_at` and the UI should show it.
- The daemon (`com.sigmadesk.complextrading`) runs from `/Users/srp/projects/sigmadesk`; restart only via
  `scripts/restart-when-idle.sh` after the branch is merged and pulled.
- Owner decision 2026-10-04: push the revert (done, c770430), enable Perplexity on councils only behind the
  default-off flag, no GitHub issue.

## Swarm review (2026-10-04)

One of three agents answered (GLM-4.7 Flash; Gemini's API call failed, Codex timed out). Accepted points:
- Write `data/perplexity-models.json` atomically (temp file + rename) because the daemon may read it while the
  refresh script writes it.
- Parse the `models_list` payload defensively: require an array of objects with string `id`; ignore unknown fields;
  fail the refresh with a clear message rather than writing a partial file.
- Validate configured model ids and the flag's type in `validateConfig`, so `npm run doctor` catches mistakes
  before a seat is edited.
Rejected: "validate seat efforts at startup" — seat profiles are already validated atomically on save in
`src/team-settings.js`, and the catalog can legitimately change under a saved seat; access is checked on use.

## Implementation notes found while reading the code

- A council member on an engine runs through `runner.startRun` with kind `council_review`, no desk socket and
  `permissionsFor('council_review')` = no tools. For Perplexity that means the relay gets only the MCP allow-list;
  the relay charter for `council_review` must say: answer from the brief and pack only, request no files, return
  the JSON. Whether `--tools ''` still exposes MCP tools to the relay is part of the live verification the flag gates.
- `council.execute()` picks its timeout by `m.model.startsWith('claude/'|'codex/')`; a Perplexity engine member
  needs the engine path too, with a longer budget (`council_review` minutes + `remoteWaitMinutes`), otherwise the
  5-minute advisor timeout would abort a Computer task mid-flight. Engine ids (`perplexity/pplx_asi_kimi_k3`) and
  advisor ids (`perplexity/kimi-k3`) share a prefix; select by catalog lookup, never by prefix.
- Refresh path: `scripts/refresh-perplexity-models.mjs` runs the Claude CLI once with only `models_list` allowed
  and writes the catalog; `npm run models:refresh`. `npm run doctor` reports the catalog's age or its absence.

## Status (2026-10-04)

Implemented on branch `perplexity-catalogs-council-flag`. 227 tests pass (220 existing + 7 new in
`test/model-catalogs.test.js`). `npm run models:refresh` was run live and recorded the 12 account models; this also
showed that a relay started with `--tools ''` can still call an allowed MCP tool, which the council path depends on.
Still unverified and still gated by the flag: an actual Perplexity council_review call end to end (credits, timeout,
remote cancellation) per docs/perplexity-connection.md.
