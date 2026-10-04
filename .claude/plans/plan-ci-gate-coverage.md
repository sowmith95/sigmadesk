# Plan: a merge gate that explains itself, learns the right checks, and knows what CI covers

## What happened (PR #410, SD-23)
- SD-23 changed only `ui-trader/…` and `docs/…`.
- ComplexTrading's only pull-request workflow, "CI Tests", runs only for `alpaca_trader/**` and `scenario_research/**`.
- GitHub therefore started nothing on the PR (`statusCheckRollup: []`).
- The desk's merge gate blocks "no CI result reported" and "required checks never reported", and nothing can bypass CI,
  so the owner is stuck permanently.
- The desk's auto-learned required list grew to `Run tests (alpaca_trader), check-prerequisites, sync, deploy`:
  - `check-prerequisites` comes from an issues/schedule workflow.
  - `sync` and `deploy` come from push-to-main workflows.
  - None of them can ever report on a PR, so every PR is blocked.
- How the list went wrong: `namesOnCommit` keeps a check when its workflow is unknown ("fail closed"), and the list only
  grows. Unknown provenance came from a read of the workflow files at the base ref, or a run-to-suite mapping, that
  failed once.
- The UI shows the reason only as a toast after pressing Merge.

## Changes
1. Learning (src/mergetrain.js `namesOnCommit` / `learnFromBase`):
   - Learn only names whose check suite maps to a workflow that has a `pull_request`/`pull_request_target` trigger,
     plus commit-status contexts.
   - Unknown provenance (no workflow file or no suite mapping) is skipped for that round, never learned: learning too
     much blocks every merge forever, learning too little is visible and owner-editable.
   - Record `ci:check-files` {check name → workflow files} from the same runs, for applicability (below).
   - Auto mode prunes names whose every observed workflow has no pull-request trigger: provably impossible on a PR.
     The prune is logged; config or owner lists are never changed.
2. Applicability per PR (src/workflows.js `pullRequestTriggers`, src/prs.js `ciCoverage`):
   - For each required check, find its workflow from `ci:check-files`. If that workflow's pull_request trigger
     (branches = base, paths / paths-ignore) does not fire for the PR's changed files, the check is "not run for these
     files" and is not required for this PR.
   - Unknown workflow means still required (safe default).
   - `ciCoverage` returns rows {name, state: passed | failed | running | waiting | not_run_for_files, workflow} and
     `uncovered` (no applicable required check, and nothing reported).
3. Merge gate (src/prs.js `authorizeMerge`):
   - An uncovered PR is no longer a hard block. "No CI covers the files this PR changes" joins the owner-overridable
     chain: the owner merges with an audited reason, posted on the PR as today.
   - Desk auto-merge never overrides.
   - Failing, running and missing applicable checks still hard-block.
4. Dry run: `GET /api/prs/:n/merge-check` returns blockers, overridable items, coverage rows and the changed-file areas,
   so the UI shows readiness before anyone presses Merge.
5. PR panel UX (ui/src/pages/Prs.tsx):
   - A "Checks" section lists every required check with its state on this commit, in words ("not run: CI Tests only
     runs for alpaca_trader/ and scenario_research/").
   - A readiness line above Merge: "Ready to merge", "Waiting for: …", or "No CI covers these files: merge with a
     reason". The reason field appears inline.
   - Merge is disabled with the reasons listed (no surprise toast).
   - Settings → GitHub shows the required-check list with remove/add chips and where each check comes from.
6. Report the CI gap in the target repo (ComplexTrading) on the PR panel: "No pull-request workflow covers ui-trader/:
   add one so UI changes are tested". No repo change from the desk.

## Tests
- workflows: pull_request trigger with paths, paths-ignore, branches and the bare form.
- learning: unknown provenance not learned; non-PR workflows pruned; owner list untouched.
- coverage: UI-only PR → required alpaca check not applicable → uncovered → owner reason merges, desk cannot; failing or
  missing applicable check still blocks.
- browser: PR panel shows readiness and per-check rows; Merge disabled with reasons; override reason flow.

## Risks
- Path-based applicability trusts the workflow files at the base ref. A workflow edited on the PR branch is not used
  (consistent with the deploy classifier). Unknown or unparseable workflows mean the check stays required.
- Owner override of "uncovered" merges untested code. It needs a reason, is posted on the PR, and the UI says plainly
  that nothing tested it.
