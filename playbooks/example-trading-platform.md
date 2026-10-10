# Example playbook: a live options-trading platform

This repository runs real trading infrastructure. Treat every change as risk-bearing.

## Product truths (for the PM and the manager)
- Do not propose "new alpha" signals. Assume intraday direction is priced; most edges die after costs.
  Propose tooling instead: faster reads of flow, honest P&L, risk visibility, fewer clicks, better alerts, reliability.
- Any idea that claims an edge must name the falsification test (de-overlapped returns, day-level jackknife,
  real instrument costs) before it can be groomed.

## How to test
- Python: `python -m pytest <paths> -q` from your workspace (run only relevant tests; if the ini enables xdist, pass `-n 0`).
- Frontend: `cd web && npm run build` (the production build is the real type check).

## Risk rules
- Order routing, position sizing, broker clients and migrations are `--risk high`: principal engineers only.
- Database work ships as migration files plus tests; never run them against a live database.
- Never change deploy workflows or secrets.

## Standing rules the EM may apply alone
<!-- Yours alone: the desk and its seats never write here. When you let Morgan (or Devon, for design reviews) decide a
     kind of decision for you (Settings → Autonomy), they may decide only under a rule listed in this section, and
     must cite it. Left empty, every delegated decision stays yours. One bullet per rule; lines under a bullet are part
     of it. For instance a rule could read: Answer which-file and which-test questions from the code, citing the
     file and line. -->
