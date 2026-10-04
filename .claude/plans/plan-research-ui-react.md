# Plan: move the v2 desk UI to React 19 with a reusable component kit; redesign Research setup with chips

Date: 2026-10-04. Owner request: "UI looks old-schooled and hard to set up; make it easy; chips and reusable modules
using React and the latest node modules." Owner decision (2026-10-04): **rewrite the whole v2 UI in React now**, no
GitHub issue. The Classic page (`classic.html` + `app.js`) stays as the fallback and is not rewritten.

## What is hard today (from the owner's screenshot)

- Users type a kebab-case **Id**, raw **minutes** (720/180/240), and **comma-separated sources**.
- Seat names are truncated in a native select ("Avery · Principal Prod").
- Reviewer pool is 13 tiny checkboxes that wrap mid-name; connectors say "none approved yet" with no path forward.
- "Standing focus" is a one-line input; nothing says that empty means "researches on its own judgment".
- One global "Save programs" at the bottom of a long scroll; no per-program save, no templates.
- The connector case is one 9-heading markdown textarea.

## Design (tokens stay the desk's own so the island does not look bolted on)

- Color: ink #0F1622 (page), slate #172131 (sheet), raised #1E2A3D (chip rest), fog #E6EAF0 (text), steel #8A97AB
  (secondary), blue #5B8CFF (selected chip, primary action); amber/green only for status.
- Type: IBM Plex Sans throughout (already self-hosted). One scale: 20/28 sentence, 15/22 body, 13/18 meta. No all-caps
  labels, no mono for labels, no middle-dot meta strings in the new UI.
- The one memorable element: each program reads as an **editable sentence** at 20px, e.g.
  "Reese researches *quant trading papers* *every 4 hours*, *any time*, reviewed by *Harper*." Each italic part is a
  chip; tapping it opens the matching picker in place. Everything around it is quiet.
- Layout (sheet up to 760px, full width on phones; left aligned):

```
Research                                                     ×
Who researches, how often, and who checks their work.
┌ Reese researches quant trading papers every 4 hours,  ┐   collapsed program = the sentence
│ any time, reviewed by Harper.                         │   + status line + Run now
│ Next session in 2 h                     [Run now]     │
└───────────────────────────────────────────────────────┘
Start from:  (Competitor scan) (Quant papers) (Workflow review) (Reliability watch) (Blank)

expanded editor (one program at a time)
  Who        [avatar chips: Avery Alex Reese Rowan …]          single select, full names
  Researches (On their own) (A topic I set)  → textarea + example chips when directed
  How often  (Hourly)(Every 3 h)(Every 6 h)(Daily)(Weekly)(Custom…)
  When       (Any time)(Market hours)(After hours)   + "Market is closed now" hint
  Sources    [arxiv.org ×][ssrn.com ×] [type to add…]  + suggestion chips
  Tools      (Web search)  connector chips; unapproved ones disabled with "Needs approval"
  Checked by [avatar chips, author excluded]   needs (1)(2)(3)
  Per session [− 2 +] proposals
  [Delete]                      [Cancel] [Save program]
```

- Connectors: one card each with a three-step status (Proposed → Assessed → Approved; a real sequence, so steps are
  justified), assessment summary as chips (benefit 4/5, discovery, low risk), and the action that moves it forward.
  "Propose a connector" is a guided form with one short field per case section and hint text, composed into the
  markdown case on submit.
- Copy: sentence case, verbs that match results ("Save program" → "Program saved"), errors say what to fix.
- Quality floor: keyboard reachable chips (roving focus in groups, Enter/Space), visible focus ring (existing
  `:focus-visible`), `aria-pressed`/`role=radiogroup`, 44px touch targets under 760px, reduced motion respected.

## Architecture (whole v2 UI)

- Toolchain (all devDependencies; the server keeps zero runtime deps): React 19.3, react-dom 19.3, Vite 8.3,
  @vitejs/plugin-react 6.1. `vite.config.js` at the repo root with `root: 'ui'`, entry `ui/src/main.jsx`, output to
  `public/app/` with stable names (`main.js`, `main.css`, lazy chunks under `public/app/chunks/`). Static files are already
  served with `Cache-Control: no-store`, so stable names cannot go stale. `public/index.html` stays hand-written (meta tags,
  skip link, `#root`) and loads `/app/main.css` + `/app/main.js`. CSP `default-src 'self'` unchanged.
- Shared pure modules are imported from `public/` by relative path so tests and Classic keep one source of truth:
  `attention.js`, `names.js`, `runcard.js`, `conversation.js`, `avatars.js` (portrait/presenceOf), `prs.js` pure exports
  (`filterRows`, `stateOf`, `safeGithubUrl`). `public/v2.js` is deleted; `public/v2.css` moves into `ui/src/styles/` and is
  bundled (same class names and tokens, so the look is preserved where it already works).
- State: `ui/src/store.js` ports the v2 sync contract exactly: one `/api/state` snapshot, then `/api/stream` deltas
  buffered while a snapshot is in flight, `refreshMeta` debounce, reconnect on CLOSED, 15 s resync, 30 s clock tick,
  per-ticket detail merge by id with pending SSE items, questions/PR/council caches, drafts in localStorage. Exposed
  through `useSyncExternalStore` (`useDesk(selector)`); `board(S)` from attention.js computed once per version.
- App shell: `Header` (brand, tabs, New ticket, Settings, four instruments), `Banner`, views `Inbox`, `Work`, `Team`,
  `SheetHost`, `Toasts`. Mobile bottom tab bar as today.
- Sheets (each its own module, lazy-loaded where large): Ticket (decision brief, PR summary, reviews, conversation,
  run card, product review, research review, more, footer with drafts and stale guards), Seat, Desk, Money, Settings,
  Models, New ticket, PR console, PR actions, Research (new design below).
- Component kit `ui/src/kit/`: `Button`, `IconButton`, `Chip` (status), `ChoiceChip` + `ChipGroup` (single/multi,
  radiogroup/group semantics, roving focus), `ChipInput` (tokens + suggestions), `Segmented`, `NumberStepper`, `Toggle`,
  `Field`, `Disclosure` (open state persisted across re-renders), `Sheet` (dialog: focus trap, Escape, inert background,
  return focus, scroll restore), `Avatar` (wraps portrait SVG), `Named` (ticket-key chips via linkKeys), `Toast`,
  `StatusSteps`, `Popover`, `Menu` (overflow actions), `Empty`.
- Research sheet: the sentence-card design and pickers described above, built only from kit components.
- Tests: node:test for pure UI logic in `ui/src/lib/*.js` (programs drafts/presets/templates, payload accepted by the real
  `research.validatePrograms`, store reducers for deltas). `public/app/build.json` stamp (sha256 of `ui/**`,
  `vite.config.js`, `package-lock.json`) checked by a test so a stale committed bundle fails CI. `test/http.test.js`
  asserts the page loads `/app/main.js`. Visual check: headless Chromium screenshots of every view and sheet at 390 px
  and 1280 px against the isolated preview desk, iterated before merge.

## Risks

- Behaviour regressions in a full rewrite (stale-decision guards, drafts, live merge of SSE into ticket detail, focus
  return, scroll follow in the conversation). Mitigated by porting the store contract line by line, keeping the pure
  modules untouched, and screenshot + manual walkthrough of each sheet against the preview desk.
- Classic stays vanilla; two UI codebases until Classic is retired.
- Committed bundles can drift from source: the stamp test catches it.
- Bundle size: React adds ~60 KB gzip to first load; large sheets are lazy chunks.
- `npm install` writes `package-lock.json` and `node_modules/` (already gitignored).

## Swarm review (2026-10-04): Codex GPT-5.2 xhigh (498 s, read all of public/v2.js, ran 53 existing tests) + GLM-4.7

GLM's review was generic (it misread `expected_updated_at` as a client-side merge rule; not adopted). Codex findings
adopted into the implementation:
1. Vite `base: '/app/'` (lazy chunk and preload URLs), `modulePreload.polyfill: false`, stable entry, hashed chunks.
   A deploy replaces chunks under an open tab: an error boundary around sheets offers "Reload" instead of a blank sheet.
2. Stamp records the output inventory (name + sha256) and hashes every input (ui/**, vite.config.js, package-lock.json,
   the public/ modules the UI imports, the stamp script). `--check` fails on a missing or altered output. A test
   rebuilds into a temp dir and compares bytes when Vite is installed.
3. Server: a missing `/app/*` asset returns 404 instead of index.html; http test fetches main.js/main.css and checks
   content type and `no-store`.
4. Research saves are conditional: `GET /api/research` returns `revision`; `PUT` takes `expected_revision` and returns
   409 when another save happened since. Per-program save merges only that draft into the saved list.
5. Detail sync: stream items for refresh / product reviews / research reviews are buffered before the detail loads;
   refetch keeps previously live discussions (v2 dropped them); overlapping detail requests are sequenced.
6. `public/prs.js` pure helpers move to `public/prs-model.js` (re-exported by prs.js for Classic) so the React app does
   not import prs.js's module-level localStorage state.
7. Research: changing the researcher keeps the required reviewer count (validation asks for more reviewers instead of
   silently lowering it); "Eligible in …" instead of "Next session"; Run now runs the saved program; the connector card
   shows the full lifecycle (proposed, assessing, assessed, approved, plus rejected / retired / failed / due) and keeps
   rationale, conditions, cost, time, data leaving, binding and tools; unavailable connector chips link to review.
8. A11y/mobile: single choice = role=radio + aria-checked with roving focus; sentence slots are buttons with
   aria-expanded/aria-controls; token remove buttons named and ≥44 px on phones; inputs stay 16 px; Sheet stays mounted
   while lazy content loads. Widths checked: 320, 390, 760, 1280.
9. Browser interaction tests (playwright-core against the already-installed Chromium, skipped when absent): typing in a
   reply survives live updates, decision disappearance shows the notice, Escape/focus return, research program save.
Not adopted: replacing `aria-pressed` toggle buttons with native checkboxes for multi-select (both are valid patterns;
toggle buttons keep the chip look), a router or state library (unneeded for three views).
