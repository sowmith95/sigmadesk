# Plan: owner override of the deploy hold when merging

Owner request: "I should have an option to override and merge the PR."

Today a deploying merge is refused while the previous deploy is unverified (running, failed or escalated). The only
way forward is "Clear deploy hold" on the Desk page, and the PR panel says "Ready" until the merge is refused.

## Changes
- `mergetrain.beginMerge`: an owner merge may pass a held deploy when the hold is `failed` or `escalated` and a reason
  of at least 10 characters is given. A hold that is still `running`/`merging` cannot be overridden (two deploys would
  overlap). The desk's auto-merge never overrides.
- Audit, in the same transaction:
  - the superseded hold, reason, time and PR go into `train:deploy-overrides`;
  - the new hold records `overrode: { key, state, note }`.
  - After the merge: a comment on the earlier ticket and an event. Before dispatch: a PR comment (prs.merge, like the
    review and CI acknowledgements).
- `prs.mergeCheck` reports `deploy_hold` { key, state, note, merge_sha, overridable, deploys } using the same deploy
  classification. "Ready" is never shown while a hold blocks.
- Server: `deploy_override_reason` on the merge route.
- PR panel:
  - the hold appears in the readiness box with what happened, a link to the runs, "Clear the hold", and a "Why merge
    anyway?" reason;
  - Merge stays disabled until the reason is given;
  - while a deploy is running it says to wait.

## Tests
mergetrain:
- owner override passes an escalated or failed hold with a reason, and the audit is recorded;
- no reason, or a running hold, is refused;
- the desk's auto-merge cannot override.
prs: mergeCheck shows the hold and is not ready while it blocks.
