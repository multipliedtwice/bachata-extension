# TODO

Active backlog only. Every box below is unfinished work. Bridge-owned review items
live in [`../browser-bridge/TODO.md`](../browser-bridge/TODO.md); they are not
duplicated here. Cross-repository and owner work lives in [`../TODO.md`](../TODO.md).

## Release verification

- [ ] **EX-AUD-08 / paired release:** prove the release job against real artifacts.
  `BRIDGE_ARTIFACT_READ_TOKEN` configured. Hosted artifact proof remains
  (PAIR-AUD-01).

## Existing safety: ignored writes

- [ ] **EX-G6-09 / ignored native writes:** managed local-provider CLIs write outside
  controller envelopes. Git inventory omits ignored paths, so a native ignored mutation
  can evade candidate and verification evidence. Decide a compatible coverage policy;
  implement and verify it. No native-write attribution channel exists in current runtime.
  Preserve unrelated cache/OS activity and valid persisted verification fingerprints.
  Root-scoped enumeration alone does not distinguish task writes from unrelated activity.
## Feature scope undecided

The three feature groups below are not automatic packaging or unrelated-release prerequisites.
Choose inclusion against release claims first. If included, settle the named design decisions,
implement and verify. Existing behavior and safety obligations remain; no feature is silently
included, deferred or claimed complete. See `docs/STABLE_RELEASE_GATE.md`.

### Bounded execution state pilot

- [ ] **EX-BOUNDED-STATE-01 / bounded execution state pilot:** decide release inclusion.
  If included, build the opt-in design in
  [`docs/BOUNDED_EXECUTION_STATE.md`](docs/BOUNDED_EXECUTION_STATE.md). Scope:
  `todo-implementation` + local Claude/Codex adapters, off by default. Needs: per-domain typed
  schema with hard byte/item/depth bounds; controller-only compare-and-swap reducer keyed on
  (revision, candidate fingerprint); typed field operations, never dictionary merge, never
  omission-as-deletion; evidence held as audit-plane references; fresh provider session wherever
  state-only semantics are claimed.
  If included, owner sets per-domain bound values and whether Lead may write `unresolved`.

### P2: expanded evidence authority

- [ ] Promote the exact consensus-accepted candidate. Bind content hash, ruling,
  participants and round. Reject a recorder mismatch.
  Blocked on one owner answer: define "recorder". It appears in no specification and no
  production source in either repository — the only hits are unrelated local test helpers — so
  which of the agent that wrote the candidate, the participant that recorded the ruling, or the
  run that persisted it is meant, and therefore what a mismatch is, cannot be derived. Every
  other bullet here depends on it: a transition may only fire once candidate identity is bound.
  Recommendation, not a decision, and it does not authorize itself: the controller-owned record
  that persists the final consensus ruling, never an agent claiming its own acceptance.
  Once answered the rest is specified — `docs/STATE.md` fixes the external-evidence record's
  identity, revisions, lifecycle, freshness and challenge, and `docs/PRODUCT_SPEC.md` records
  that accepted external evidence performs no finding transition yet.
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
- [ ] Add a runnable longitudinal record/score command, verified in a validation round.
- [ ] Consider competing isolated implementations only once comparative evidence
  supports the added execution surface.

## Verification rules

Use `PATH="/opt/homebrew/bin:$PATH"` for managed-worktree tests. Delete an item once its
focused regression and the final gates pass. Do not clear `.bachata-worktree.lock`; report
blocked lock-aware commands exactly.

## External validation

Requires the owner's provider accounts and local-model endpoint; not run automatically.

- One authenticated browser smoke flow per provider profile after installation.
- Benchmark the configured Qwen, Bonsai or DeepSeek endpoint against the bounded
  candidate fixtures before enabling auto-heal unattended.

Stable support claims are governed by `docs/STABLE_RELEASE_GATE.md`.
