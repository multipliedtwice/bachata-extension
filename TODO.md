# TODO

Active backlog only. Every box below is unfinished work. Bridge-owned review items
live in [`../browser-bridge/TODO.md`](../browser-bridge/TODO.md); they are not
duplicated here. Cross-repository and owner work lives in [`../TODO.md`](../TODO.md).

## Release verification

- [ ] **EX-AUD-08 / paired release:** prove the release job against real artifacts.
  Blocked on: `BRIDGE_ARTIFACT_READ_TOKEN` provisioning and one hosted run
  (PAIR-AUD-01).
- [ ] **Human graphical acceptance gate:** run `docs/HUMAN_E2E.md` against the installed
  VSIX, in a real VS Code window, with the owner present. Human-only by construction: no
  automated gate substitutes for it, and the activation smoke does not cover it.
  Blocked on: the owner running it.

## Existing safety: ignored writes

- [ ] **EX-G6-09 / ignored native writes:** managed local-provider CLIs write outside
  controller envelopes. Git inventory omits ignored paths, so a native ignored mutation
  can evade candidate and verification evidence. Decide a compatible coverage policy;
  implement and verify it. No native-write attribution channel exists in current runtime.
  Preserve unrelated cache/OS activity and valid persisted verification fingerprints.
  Root-scoped enumeration alone does not distinguish task writes from unrelated activity.

## Active composer work

- [ ] **EX-MENTION-01 / role-addressed messages:** while a run works, typing `@` opens
  the bound pipeline roles. Pick one or more roles; Bachata routes one direct message to
  their current participants. Running workflow: accept as queued work without making the
  user change Delivery. Show role + participant, keep keyboard/screen-reader behavior,
  refuse stale or unbound roles, dedupe one participant holding multiple roles, preserve
  attachments and exact transcript order. Add DOM/runtime/protocol regression coverage and
  Cypress coverage for 320, 480 and 900 px in light/dark themes. Workers author Cypress but
  do not run it; lead runs and reviews the visual gate.
## Feature scope undecided

The three feature groups below are not automatic packaging or unrelated-release prerequisites.
Choose inclusion against release claims first. If included, settle the named design decisions,
implement and verify. Existing behavior and safety obligations remain; no feature is silently
included, deferred or claimed complete. See `docs/STABLE_RELEASE_GATE.md`.

### Bounded execution state pilot

- [ ] **EX-BOUNDED-STATE-01 / frozen pilot export journey:** make
  `tests/cypress/execution-result-hierarchy.cy.cjs` pass, then lead runs it. 28 of 29 cases fail:
  result details are collapsed by default (since d1a0b18) and the spec expects them open, so it
  never finds `.result-primary-actions`, `.ruling-compare`, `result-copy` or finding selects. Open
  **Review details** in setup; keep the toggle case asserting the collapsed start. Pilot frozen;
  keep `legacy` default. No provider-quality, token, cost or latency claim. Native ignored-write
  gap remains EX-G6-09.
- [ ] **EX-BROWSER-OBS-01 / Browser Bridge observation handles:** Bachata owns the managed
  browser tool loop, so SoL-Pi ObservationPack fits there: large DOM, diff and verifier output
  becomes controller evidence; prompt carries a compact head/tail and stable handle; model
  recalls exact slices by handle. Spec first (design mechanism 3). Web chats keep no local token
  log, so first extend the offline benchmark script to record bytes Bachata sends per managed
  browser turn and their growth across turns; proceed only if large observations dominate.
  - Paths: docs, src/browser, tests
  - Verify: bachata:project-checks
- [ ] **EX-CONSENSUS-SHARE-01 / measure before consensus projection:** extend the offline
  benchmark script (today `todo-implementation` fix tasks only) to a consensus pipeline (Code
  review reconcile) with local Claude/Codex participants. Report Bachata prompt share of
  provider input per round. Structured consensus projection (design mechanism 2) only if that
  share is material; otherwise drop it.
  - Paths: benchmarks, scripts/context-mode-benchmark.cjs
  - Verify: none

### P2: expanded evidence authority

- [ ] Store composable evidence records naming subject, state, authority, evidence ref,
  candidate identity, time and freshness.
- [ ] Keep facets separate — finding state, evidence, execution, provenance, currency —
  and derive the UI summary from the applicable current records.
- [ ] Link accepted external evidence to its target finding. Transition only when the
  evidence scope covers both the finding and the exact candidate.
- [ ] Add a finding-specific verification contract supporting regression test,
  deterministic reproduction, targeted invariant, static rule or accepted external
  evidence.
- [ ] For regression evidence, record the same test hash, exact before and after
  candidates, fail-before, pass-after, verifier, environment and acceptance.
- [ ] Preserve compatibility with valid existing persisted state throughout.

### P3: retained Feature Delivery

- [ ] **Owner answer owed: how Feature Delivery gets retained, verified isolation.**

  Remaining gap: attended retained isolation and Apply. Local controller verification already
  runs for managed turns with declared checks (`src/runtime/createRuntime.ts`). Retained task
  worktrees and Apply remain on orchestration; orchestration is unattended and refuses the
  preset's requirement-consensus, design-record and implement human gates. Preserve those
  gates until the owner chooses an execution mode.

  - **(A) Drop the gates, make Feature Delivery unattended.** Gains retention, verification and
    Apply now, no new execution mode. Costs the requirement-consensus, design-record and implement
    gates, where a human shapes what gets built; the human then reviews a finished candidate
    instead of steering an unfinished one.
  - **(B) Add an attended retained execution mode.** Keeps every gate, gains isolation,
    verification, retention and Apply, controller owns all four. Costs a second execution mode: a
    second place isolation and Apply can be wrong, and both modes then need the safety evidence
    the orchestration path already has.
  - **(C) Leave Feature Delivery outside TODO orchestration, give attended runtime its own
    retained-worktree coordinator.** Paths stay independent, neither constrains the other. Costs a
    second coordinator repeating worktree lifecycle, verification binding and Apply — two
    implementations is where they drift.

  Recommendation, not a decision: **(B)**. Only option keeping gates and safety machinery
  together. Second-mode cost real but bounded; (C)'s duplicated coordinator unbounded; (A)
  discards a shipped capability to avoid writing one. All three change shipped behaviour, so none
  may be picked to make a test pass, and the recommendation does not authorize itself.

  Same answer settles where a human accepts a write scope, so that is not a separate box: the
  preset hardcodes `managedPolicy.allowedPaths: ["src", "tests"]` beside
  `writeScope: "configured"` and `protectedPaths: [".git", ".bachata"]`, has eight steps and no
  gate that could carry an acceptance, and whether an accepted scope is per-run evidence or
  per-workspace configuration follows from which option is chosen.

## Deferred: need evidence or owner choice

- [ ] After approval, add same-provider local paired presets with separate sessions.
  Label session independence, not model diversity.
- [ ] After one recorded user format and job, add structured SARIF, JUnit, saved CI
  result or issue-criteria import.
- [ ] Add the next language-aware context graph only from user evidence.
- [ ] Run a longitudinal validation round with `npm run benchmark:longitudinal` and record its
  results. The command itself is implemented and unit-verified
  (`scripts/longitudinal-benchmark.mjs`, `tests/longitudinalBenchmarkCommand.test.cjs`);
  `BUILD_FACTS.md` still reports 0 Git-tracked longitudinal result records, so no round has run.
- [ ] Consider competing isolated implementations only once comparative evidence
  supports the added execution surface.

## Verification rules

Use `PATH="/opt/homebrew/bin:$PATH"` for managed-worktree tests. Delete an item once its
focused regression and the final gates pass. Do not clear `.bachata-worktree.lock`; report
blocked lock-aware commands exactly.

## External validation

Requires the owner's provider accounts and local-model endpoint; not run automatically.

- One authenticated browser smoke flow per provider profile after installation.
- Run the automatically selected local model against the bounded candidate fixtures on a
  real Ollama or LM Studio installation before enabling auto-heal unattended. Bachata's
  startup contract check is a gate, not evidence of quality on the owner's own corpus.

Stable support claims are governed by `docs/STABLE_RELEASE_GATE.md`.
