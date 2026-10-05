# "Your step" and a Technical Program Manager: the desk handles the flow, the owner gets one clear step

## Problem (SD-77, 2026-10-05)
A review fix was held by the publish guard (411 > 400 lines); a refresh failed and overwrote the guard notice; the
merge panel offered "merge anyway with a reason" on the older PR head. Three parts each reported their own fragment;
nothing joined them into "approve publishing the fix, then it merges by itself". The owner asked: the agents should
handle all of this, and hand over only the step the owner must take — plus a Technical Program Manager who sorts,
prioritises and connects work every few hours and joins grooming.
(Fixed separately, 6e41b4f: refresh accepts the desk's own publish; a failed refresh keeps the hold; the merge panel
refuses a stale head and says "publish the fix first".)

## Layer 1 — "Your step" (deterministic, no model)
`public/yourstep.js` (pure, shared by server + UI): for a ticket, from its state (status, progress_msg/guard, head_sha
vs published vs PR head, qa_sha, review stage/approvals at head, merge state, deploy lock, refresh state, owner task,
feature plan, epic review) → `{ who: 'you' | 'team' | 'desk', step, why, action: { kind, label } | null, blocked_by }`.
Rules (examples):
- guard held + QA passed → you: "Approve publishing the review fix (11 lines over the small-task cap)"; action publish.
- PR head ≠ desk head, not guarded → desk: "publishing the new commit", nothing for you.
- head published, approvals missing at head → team: "Rowan and Sage re-check the new commit".
- approved, merge state queued/scheduled → desk: "merges by itself (after market hours)".
- approved, merge state owner (high risk) → you: "Merge #465 (high risk: owner merges)".
- deploy lock running for this ticket → desk: "deploying".
- needs_human question → you: the question (from the board's decision).
- conflict → team: "Riley resolves a conflict with main".
- refresh held / unknown inconsistency → TPM picks it up (see below); you see nothing until it needs you.
Shown: Inbox rows (reason line), ticket Tracker (replaces "line"), PR merge panel header. The board's decisions stay
the single source of "needs you"; yourstep explains and never adds a decision on its own.

## Layer 2 — Technical Program Manager seat (`tpm`, "Avery"? name TBD, core, optional)
- **Cadence**: a program run every 3 h (setting) and on triggers: a ticket stuck > 2 h in a state with no running
  work (needs_human not owner-facing, refresh held, review not re-requested after a new commit, guard on a review
  fix, publish failed), or ≥ 3 open owner items in one epic.
- **Deterministic first ("flow doctor", no model)**: fixes inconsistencies the desk understands: re-queue the review
  round when the head changed and approvals are stale; retry a refresh/publish that failed transiently; restore holds;
  release stale reservations. Each action is logged on the ticket ("TPM: re-requested reviews at 2d71688").
- **Program run (model, read-only + bounded mutations, like epic review)**: across open epics and tasks it may
  (a) set priority P0–P3 with a one-line reason (never on in_progress work), (b) record dependencies (same rules as
  epic review: same tree, no cycles, never overwrite an open dependency), (c) flag duplicates / stale tickets as
  proposals (closing needs the owner), (d) consolidate owner items: at most one owner-facing ask per epic, written as
  "your step", (e) write a short program update (what moved, what is stuck and why, what needs you — ≤ 8 lines) shown
  on the Desk page and as the Inbox header line.
- **Grooming**: the manager's groom/feature-plan prompt includes the TPM's current priorities and dependency map; the
  TPM reviews each newly groomed batch (cheap pass) to set order/priority before work starts.
- **Guardrails**: budget-capped (one program run per interval, deterministic doctor free), all changes reversible and
  listed, never merges, never approves publish/guard/merge, never changes in-progress work, owner can turn it off.

## Files
public/yourstep.js (new) · src/tpm.js (new: doctor + program run, kv state, apply) · src/team-catalog.js + src/team.js
(seat, charter, prompts) · src/scheduler.js (cadence, triggers, deskAction allowlist for kind tpm_program) ·
src/server.js (program update in meta, routes: run now, turn off) · ui: Inbox reason line, Tracker line, Prs panel
header, Desk page program update, Settings toggle/interval · tests: yourstep per state (incl. SD-77 sequence),
doctor actions, program apply validation, e2e: SD-77-like fixture shows one step.

## Risks
- A wrong "your step" is worse than none: rules are explicit per state, unknown → "TPM is looking into it".
- TPM changing priorities the owner set: owner-set priority (PATCH) is pinned (`priority_pinned`), TPM never overrides.
- Cost: deterministic doctor every tick; model run every 3 h max, skipped when nothing changed (fingerprint).
- New core seat touches team catalog, seat lists, avatars, tests expecting 14 seats.
