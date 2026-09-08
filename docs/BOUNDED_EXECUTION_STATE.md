# Bounded execution state (design, not shipped)

Design only. No behaviour change. Default unchanged. No implementation here.

Source: SKILL.state, <https://arxiv.org/html/2608.26263>. Take core. Do not port the framework. Do
not copy its merge semantics.

## Paper

Turn gets three things only: immutable procedure spec, current execution state, latest
observation. Model returns reasoning + state patch + action. Runtime validates the patch, applies
it, discards the reasoning. Prompt O(1), not O(T^2).

| Reported | State-only | History-appending baseline |
| --- | --- | --- |
| 200 steps, Warehouse, Gemini-3-Flash | 122k tokens at 0.94 accuracy | 6.1M tokens |
| InterCode CTF | 54.2% pass at 387k tokens | 41.8% at 1.13M |
| Noise 50 events/turn | accuracy >= 0.97 | 0.53 |
| After external drift | 0 recovery steps | 5-8 hallucinated steps |

Paper limits, both hit Bachata:

- single-agent evaluation. Concurrent writes and merge conflicts unexplored.
- history cannot be discarded when the task IS history: audit, debugging, provenance.
- merge-by-dictionary with null-delete breaks small models. Premature overwrite/deletion is the
  dominant reported open-weight failure.

## Two planes

- Execution: bounded typed state. Controller owns. Goes into next turn.
- Audit: transcript, evidence, catalog, ledger. Append-only, kept, never replayed into a prompt.

Invariant: transcript never source of truth for the next action. Execution state never a record of
what happened.

## Baseline today

`src/pipeline/runner.ts:485` builds the template values: prior/peer/intervention answers, role
identity, `outputsJson`, per-agent and per-role answer maps. Prompt = `Role: <name> (<id>)` + role
instructions + rendered template (`runner.ts:1226`). Managed local turn adds
`renderControllerVerificationEvidence`; rejected Worker adds Lead defects + controller results
(`src/runtime/managedLeadReview.ts` `managedWorkerRevisionPrompt`).

## Evidence boundary

| Kind | Examples | In prompt? |
| --- | --- | --- |
| Immutable spec | `PipelineSnapshot` definition + hash, role instructions, declared checks | yes, by hash + parts role needs |
| Operational state | revision count, unresolved defects, assigned roles, write scope, task/run id | yes, bounded |
| Latest observation | workspace fingerprint, changed files, last controller check results | yes, latest only |
| Audit evidence | transcript, `structured_outputs`, `events`, `OrchestrationLedger`, diffs, provider answers | no. stored, referenced by id |

## Primitives already here

Nothing foreign to import. Gap is schema, reducer, who-writes rule.

- `PipelineRunnerSnapshot` (`src/pipeline/runner.ts:176`) — resumable run position.
- `ManagedPairCheckpoint` (`src/orchestrator/managedPair.ts:49`) — `taskId`, `taskHash`,
  `workspaceRevision`, `workspaceFingerprint`, `changedFiles`, `verification`. Closest shipped
  thing to paper's sigma.
- `OrchestrationLedger` (`src/orchestrator/types.ts:183`) — run-level durable record.
- `ManagedTaskState` (`src/runtime/managedTaskState.ts`) — one task's revision budget + pending
  Lead directive. Single-slot, dropped at task end.
- `managedWorkspaceFingerprint` + controller verification fingerprints — the CAS token.
- Transcript store + `state/catalog` — audit plane, already separate.
- Pipeline output schemas — typed structured output, validated per step.

## Proposed contract

Versioned per pipeline domain. `todo-implementation` first.

```text
executionState:
  schemaVersion: int
  procedureHash: string          # PipelineSnapshot hash. immutable for the run.
  taskId, runId: string
  revision: int                  # monotonic. controller increments.
  candidateFingerprint: string   # workspace fingerprint the state describes
  observation:                   # controller-owned. latest only, never appended
    changedFiles: string[]       # bounded count
    checks: {id, status, exitCode?, outputRef}[]
    recordedAt: string
  unresolved: {id, statement, requiredChange, severity}[]   # bounded count
  hypotheses: {id, claim, evidenceRefs}[]                   # bounded count
  verification:
    evidenceRefs: string[]       # ids into the audit plane. never copied output

patch:
  baseRevision: int
  procedureHash: string
  candidateFingerprint: string
  operations: typed field operations
  action: declared action
```

Bound categories, hard, per field: byte cap, item cap, depth cap. Cap is a function of schema, not
of turn count. Values unset: owner decision.

## Reducer rules

- unknown field rejected.
- omission never deletes. No dictionary merge, no null-delete.
- deletion only through an explicit schema-authorized operation (`clearUnresolved(id)` and such).
- stale `baseRevision` rejected. Re-observe, retry.
- `procedureHash` mismatch rejected.
- `candidateFingerprint` mismatch rejected: tree moved under the agent.
- only the controller applies a patch. Agent proposes.
- every accepted patch writes an audit event: before hash, after hash, accepted action. Reasoning
  never enters the next prompt.

## Multi-agent

Paper does not solve this. No last-write-wins.

- agents propose patches only. Controller is single writer.
- every proposal is compare-and-swap on (`revision`, `candidateFingerprint`).
- one owner per field. `observation` and `verification` controller-only. Lead may write
  `unresolved`; Worker may not. Lead may never rewrite controller verification evidence.
- conflict rejects and forces re-observation. Never silent merge.
- transcripts stay audit. Never mutable source of truth.

## Fresh session required

Invariant: state-only prompting is not a smaller prompt. Two stores outside the template still
grow — the resumed Claude/Codex session, which keeps its own conversation while Bachata stores
only a locator (`docs/STATE.md`), and the managed browser continuation, whose transcript lives in
the tab, unowned. State-only semantics hold only where the provider conversation is also fresh.

- local Claude/Codex resumed session: explicit fresh session per state-only turn. Rule not yet
  explicit for local adapters.
- managed browser continuation: `managedFreshSessionKeys` +
  `ensureFreshManagedBrowserSession` (`src/runtime/createRuntime.ts`) already do this.
- turn that keeps its provider session is NOT state-only. Never describe it as one.

## Pilot scope

- `todo-implementation` only. Local Claude/Codex adapters only.
- explicit opt-in setting. Current behaviour stays default.
- no Browser Bridge change. No Feature Delivery or P3 decision implied.
- transcripts and evidence: nothing deleted.
- no product performance claim before real controlled evaluation. Paper's numbers are paper's.

## Acceptance for a later implementation

- prompt projection constant across 10, 50, 100, 200 simulated transitions, bounds fixed.
- restart from persisted state gives the same next prompt and same allowed action set.
- stale, malformed, oversized, unknown-field, unauthorized-deletion patches all fail closed.
- external workspace drift invalidates stale state immediately.
- two patches against one base revision behave deterministically.
- full chronology stays exportable while none of it auto-replays.
- state-only and current mode reach equivalent results on deterministic fixtures.
- provider sessions demonstrably fresh where state-only semantics are claimed.

No telemetry. No benchmark infrastructure. Deterministic tests may assert bounds; nothing measures
at runtime. `NO_TELEMETRY.md` is authoritative.

## Migration, compatibility, security

- additive. New module `src/pipeline/executionState.ts` + per-domain schema. No existing type
  changes.
- `schemaVersion` bump on any field change. Unknown version refuses, does not guess.
- off by default: no migration for existing runs.
- security boundary unchanged: controller still owns verification, Git and write scope. State
  carries evidence REFERENCES, so a model cannot smuggle forged check output into the next turn.
- rollback: setting off. State records inert when unread.

## Owner decisions still open

- whether the pilot ships at all.
- whether a fresh local provider session per turn is acceptable cost.
- bound values (bytes, items) per domain.
- whether Lead may write `unresolved` directly or only propose.
