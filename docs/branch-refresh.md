# Refresh a stale PR

Open the ticket and choose **Refresh branch & resume** in its Pull request card. This applies to a submitted PR awaiting work or owner review, after its workers finish. Design approval records a recommendation separately; final merge stays in the PR review flow.

The desk fetches the current remote base, preserves the original commit and remote branch lease, and prepares a rebase in its private recovery clone. Existing local edits, changed remote heads, stacked PRs targeting another branch, and unsupported file paths hold the operation rather than overwriting work.

If there are conflicts, the implementer edits only the listed files, then calls `desk continue-rebase`. The desk completes Git's operation. The implementer reruns the relevant tests and submits; independent QA validates the new commit, followed by requester acceptance. The desk updates the existing PR with an explicit force-with-lease guard.

QA records the new head and base. Publication and the owner's merge action reject evidence for another head/base. A concurrent remote update requires reconciliation. Interrupted Git preparation stays held for inspection, with the original commit and recovery metadata under `data/refresh/`; it is never replayed blindly. Seats retain their network, rebase and push restrictions.

Validated on SD-19: original `45c28a2c` rebased onto `f49c4bc681` as `924f8767`, retaining both Live stop and loss-budget changes. Independent QA and manager acceptance completed, PR #400 was updated, and GitHub CI passed. No final merge was performed.
