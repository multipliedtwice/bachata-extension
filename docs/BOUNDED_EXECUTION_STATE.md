# Bounded execution state

Local TODO slice implemented in source. `legacy` remains default. Full dependency-backed gates
pending. Other domains remain design only.

## Implemented contract

`executionState.ts` owns strict parsing and the pure reducer. `executionProjection.ts` owns prompt
bounds. `localExecutionState.ts` owns evidence admission, durable dispatch boundaries and recall.
`createRuntime.ts` keeps existing controller checks, workspace audits and Lead verdict routing.

Model proposals name version, issued dispatch, base revision, procedure, typed operations and task
result. Planner proposes bounded plan/acceptance. Worker reports work or proposes a resolution.
Lead proposes exact defects or resolves named defects after controller verification. Controller
alone changes candidate, checks, policy, phase and completion. Omission retains data. No merge,
null-delete or rolling summary. Duplicate JSON keys and duplicate operation targets refuse.

Compare the proposal with its issued state, then bind authorized Worker edits to the audited
post-turn candidate. Read-only drift refuses. Required evidence and unresolved defect text must
fit; no truncation to make a dispatch fit.

| Bound | Initial value |
| --- | --- |
| Complete Bachata prompt | 128 KiB |
| State projection | 32 KiB |
| Exact task + all role/workflow instructions | 32 KiB |
| Latest observation | 16 KiB |
| Recalled UTF-8 content per dispatch | 16 KiB |
| Plan items / unresolved defects / required checks | 16 / 10 / 16 |
| JSON depth | 8 |
| Free text / identifiers | 4 KiB / 128 bytes; defect ids 80 bytes |

Recall names known handles and byte ranges. Validate scope, reader, digest, completeness, candidate
and UTF-8 boundaries. Pages carry continuation offsets. Historical pages cannot pass current
checks. Recall is explicit and runs in another fresh conversation.

Exact evidence is durable before references are published. See [State](./STATE.md) for storage and
export limits. Prepared prompts reconstruct byte-for-byte. Settled dispatches can recover a lost
workflow checkpoint. Unsettled writes reconcile workspace state and block automatic replay.
Explicit task restart preserves old evidence. Mode changes apply at a new run boundary.

The source tests include deterministic 10/50/100/200-transition fixtures, byte comparisons,
malformed proposals, stale revisions, recall integrity and crash boundaries. These fixtures are
not a provider quality or cost result. The dependency-equipped checkout must run the full gates.

## Original design context

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

## Legacy baseline

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

## Earlier design sketch (not the implemented schema)

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

- local Claude/Codex resumed session: explicit fresh session per state-only turn. Enforced by the discriminated adapter request and runtime guard in the pilot.
- managed browser continuation is fresh once per task and agent, then continues until rollover.
  It is not state-only. Per-turn freshness and state-aware rollover remain proposed browser work.
- turn that keeps its provider session is NOT state-only. Never describe it as one.

## Pilot scope

- `todo-implementation` only. Local Claude/Codex adapters only.
- explicit opt-in setting. Current behaviour stays default.
- no Browser Bridge change. No Feature Delivery or P3 decision implied.
- transcripts and evidence: nothing deleted.
- no product performance claim before real controlled evaluation. Paper's numbers are paper's.

## Acceptance gates

- prompt projection constant across 10, 50, 100, 200 simulated transitions, bounds fixed.
- restart from persisted state gives the same next prompt and same allowed action set.
- stale, malformed, oversized, unknown-field, unauthorized-deletion patches all fail closed.
- external workspace drift invalidates stale state immediately.
- two patches against one base revision behave deterministically.
- admitted exact evidence stays exportable after preview pruning; exclusions stay explicit.
- state-only and current mode reach equivalent results on deterministic fixtures.
- provider sessions demonstrably fresh where state-only semantics are claimed.

No telemetry. No benchmark infrastructure. Deterministic tests may assert bounds; nothing measures
at runtime. `NO_TELEMETRY.md` is authoritative.

## Migration, compatibility, security

- additive opt-in modules and an explicit fresh-session adapter request. Legacy request shape remains accepted.
- `schemaVersion` bump on any field change. Unknown version refuses, does not guess.
- off by default: no migration for existing runs.
- security boundary unchanged: controller still owns verification, Git and write scope. State
  carries evidence REFERENCES, so a model cannot smuggle forged check output into the next turn.
- rollback: setting off for new runs. Existing recovery retains its pinned mode and evidence.

## Pilot decisions locked

Local TODO only. Fresh local conversation for every dispatch. Bounds above. Lead proposes defects;
controller writes them. No default-on rollout. Broader domains remain separate work.
