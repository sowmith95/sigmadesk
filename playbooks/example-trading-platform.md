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

<!-- The next section is yours alone: the desk and its seats never write it. When you let Morgan (or Devon, for design
     reviews) decide a kind of decision for you (Settings → Autonomy), they may decide only under a rule listed under
     its heading, and must cite it; left empty, every delegated decision stays yours. Write each rule as a dash bullet
     right under the heading, for instance "- Answer which-file and which-test questions from the code, citing the
     file and line.", with any condition on the same line or indented two spaces under it. No code blocks, HTML,
     comments or numbered lists there: the desk stops reading at the first line of another kind, and Settings shows
     how many rules it found. -->
## Standing rules the EM may apply alone
