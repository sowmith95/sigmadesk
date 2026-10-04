# Research programs, connectors and the second-person review

Research on the desk is a set of **programs**. Each program says who researches, how often, in which market window,
with which sources, whether it may use the web, which approved connectors it may call, how many proposals one session
may file, and who must review a proposal before the engineering manager may groom it. The default program,
`product-discovery`, is the Principal PM's competitor and user-pain research; it is derived from `pm.*` in the config
and the legacy `PM research` / cadence settings until you save programs in **Settings → Research**, after which the saved
list wins as a whole. `Reset to config` returns to the derived list.

## A program

| Field | Meaning |
|---|---|
| `seat` | Any seat. Its engine must fit: web research needs a Claude or Perplexity seat; connectors need a Claude Code seat. |
| `intervalMinutes` | Minimum gap between two sessions of this program (15 min to one year). |
| `window` | `any`, `market` (only during `research.marketHours`, default NYSE regular hours in New York time) or `off-market`. Checked when a session starts; a session that starts before the close may finish after it. Exchange holidays are not modelled. |
| `focus` | Standing focus text added to every session. "Run now" may add a one-off focus. |
| `sources` | Approved sources (domains, journals, repositories, document ids). The prompt requires every Evidence bullet to cite one; cited URLs are extracted onto the ticket for the reviewer. |
| `tools.web` | WebSearch/WebFetch. These run outside the OS sandbox, which is why only research kinds ever get them. |
| `tools.connectors` | Names of **approved** connectors (below). Saving a program with an unapproved connector fails. |
| `maxProposals` | Proposal allowance per session, also capped by the global `Max open proposals` net of allowances other running sessions still hold. Enforced on every `desk propose`. |
| `review.minReviewers` / `review.reviewers` | The second-person gate: how many distinct seats, from which pool, must pass a proposal. The researching seat is never in its own pool. |

Due programs run oldest-first so list order cannot starve one. Review and revision work is scheduled ahead of new
discovery, and shares the two-seat review allowance with product reviews; one capacity slot stays free for QA/SRE.

## The second-person review

A proposal filed by a research run is stamped `source=research` with its program, the frozen review policy and
`research_review=pending`. Until the required number of distinct reviewers (never the author, preferring a different
model family) have passed it, it is invisible to grooming, cannot be moved to `todo` by an owner edit, and blocks slices.
The reviewer runs read-only (no sandboxed shell, no writes, only `desk show/list/context-file`), may use the web when the
program allows it to check citations, and answers with one JSON verdict: `pass`, `changes` or `reject`.

- **pass**: counts toward the quorum for the current generation of the text; a verdict given for an older version never counts.
- **changes**: open assignments are cancelled and the author gets one `research_revision` run that may only `desk revise <KEY>` its own proposal, opening a new generation and a fresh review. A second `changes` holds the proposal for you.
- **reject**: held for you. Holds appear in the Inbox as *Decide proposal*: approve (an audited waiver), send back with notes (the author revises), or reject. A plain reply to a held proposal is treated as "send back with these notes".
- **Waive review** on a ticket is the only bypass and is recorded as an owner verdict.

Proposals you file yourself, triage-routed tickets and pre-existing `pm` proposals are not gated. Product review,
QA and merge gates are unchanged.

## Connectors: propose, assess, approve, measure

A connector is an MCP server a research seat may call. Adding one is a governed decision, not a config edit:

1. **Case.** Anyone with a thinking seat (`desk connector-propose --name <slug>` from a research/design run) or you (Settings → Research → Connectors) writes the case with these sections: `## Purpose`, `## Benefit to the application`, `## How it is used`, `## SDLC stage improved` (discovery, design, implementation, qa, review, operations), `## Cost`, `## Time`, `## Data leaving the machine`, `## Risks and fallback`, `## Success measure`. Seats never supply bindings.
2. **Assessment.** *Request assessment* runs one read-only seat other than the proposer (quant-research or trading-advisor for market/data sources, principal-be for engineering tooling). It verifies pricing, terms and capability with the web and returns a structured verdict: recommend/decline, benefit 1-5, SDLC stage, risk, cost and time estimates, data leaving, conditions.
3. **Approval.** Only you, only after an assessment, and you fix the **binding** and the exact **tools** the seat may call, plus a re-evaluation date (default 30 days). `http` bindings need an `https://` URL; `stdio` bindings need an absolute command that exists on this machine. Bindings carry no credentials: configure those in the connector's own files.
4. **Use and measurement.** Programs reference approved connectors by name. Each run records which connectors it carried, so the connector sheet shows runs, cost, proposals produced and how many passed the second review. Past the re-evaluation date the sheet flags it; nothing retires automatically. Retire or reject records the reason.

Connectors seeded from `research.connectors` in the config start as *proposed*: nothing is usable until assessed and approved.

### What a connector can do on this machine

A **stdio** connector is a trusted host extension. It runs outside the OS sandbox as a Claude Code subprocess with your
user's file access. The desk removes its own credentials from that process (`DESK_RUN_TOKEN`, `DESK_SOCKET`,
`DESK_MAILBOX`), passes Claude only transport fields, and allows only the listed tools, but it cannot confine the
connector's file access. The case must say what data leaves the machine, and you approve knowing that. Prefer `http`
bindings when a service offers one. Connectors never reach builders, QA or reviewers; a provider fallback that would
drop a program's web or connectors is refused rather than silently degraded.

## Operations

- `GET /api/research` shows programs with their eligibility (next session, window, funnel), market hours and connectors.
- `PUT /api/research/programs` saves the whole list atomically; `POST /api/research/programs/<id>/run {focus}` starts one now (budget, capacity, engine fit and the allowance still apply).
- `POST /api/tickets/<KEY>/research-review/waive {note}`; `GET/POST /api/connectors…` for the connector lifecycle.
- A restart cancels in-flight reviews and assessments; the next tick assigns fresh ones. Completed verdicts are kept.
