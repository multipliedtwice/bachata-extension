# Token-efficient harness

Status: first local TODO slice implemented in source, off by default. Full project gates still
require the dependency-equipped checkout. No token, cost, or latency claim.

## Runs control

- Runs composer, Agents popover: **Efficient context · Experimental**. Keyboard checkbox.
  Shown only for TODO Implementation. Other workflows hide it.
- Uses bounded state and fresh local Claude/Codex sessions for TODO Implementation.
  May reduce repeated context. Savings are not yet measured.
- One default: `bachata.executionContextMode`. Advanced setting stays. Off by default.
- Host checks current pipeline, providers, workspace and selected attachments. Stale setup refuses.
- One pending write in the panel. Wait for host reply before another toggle or Send.
  Host serializes writes, checks expected default, skips equal values, preserves setting scope.
- Unsupported providers, workspace or attachments: unchecked, unavailable, reason shown. Saved default stays unchanged.
  New ineligible run pins `legacy`. Supported new run pins the saved default.
- Active, recovered and replayed runs stay locked to recorded mode. Old checkpoints use legacy.
  Resume and restart never take a changed default. Unsupported pinned setup still refuses.
- Controller checks, evidence export, revision budgets and workspace rules stay in force.

## Implemented slice

- `bachata.executionContextMode`: `legacy` default; `localTodoStateV1` opt-in. Pin to run.
- Local Claude/Codex, serial `todo-implementation` planner/worker/reviewer only. No attachments.
- Exact admitted evidence store first. Post-redaction bytes, immutable blobs, manifest, catalog
  references, explicit export. No provider-private history. See [State](./STATE.md).
- Strict versioned proposals. Controller applies one transition per issued revision. Unknown,
  stale, incomplete, over-limit, wrong-owner and unauthorized data refuse advancement.
- Fresh Claude session and Codex `thread/start` for each dispatch, including repair and recall.
  Session locators stay private audit records; never become resume inputs in this mode.
- Keep existing scope audits, controller verification, candidate-bound Lead acceptance and
  revision budgets. Worker reports cannot pass checks or clear Lead defects.
- Persist prepared/dispatched/settled state, directives and budgets at awaited boundaries.
  Uncertain writes reconcile and block; never auto-replay. Safe setting rollback is a new run.
- Prompt 128 KiB; state projection 32 KiB; exact task + instructions 32 KiB; observation 16 KiB;
  recall content 16 KiB. At most 16 plan items, 10 unresolved defects, 16 checks; depth 8.
- Native ignored-write attribution remains the pre-existing `EX-G6-09` limitation. No new claim
  of complete native tool history or ignored-file coverage.

Remaining sections describe later mechanisms unless explicitly named above.

Source ideas:

- [SoL-Pi paper](https://arxiv.org/html/2609.20519v1)
- [SoL-Pi source](https://github.com/NVlabs/SoL-Pi)
- [Bounded execution state](./BOUNDED_EXECUTION_STATE.md)

Use mechanisms. Do not embed SoL-Pi or copy Pi-specific code. Bachata owns Claude Code, Codex,
browser providers, pipelines, controller checks, audit records, and recovery.

## Why

Current flow repeats useful but large context:

- pipeline turns can render raw prior, peer, intervention, and named outputs.
- local providers can resume a session after Bachata also sends that context again.
- consensus rounds can pass full peer answers each round.
- browser work can split mutation and verification into separate model turns.
- browser handoff and continuation byte limits stop runaway payloads. Limits do not make payloads
  efficient.

Result: Claude and Codex can reread history that the controller already understands.

## Goal

- Send the smallest sufficient state for the next decision.
- Keep exact evidence and full audit history outside automatic prompt replay.
- Reduce repeated model input and avoid safe-but-redundant turns.
- Preserve result quality, controller authority, recovery, and export.

Non-goals:

- no silent truncation.
- no weaker verification.
- no runtime telemetry, metrics, tracing, counters, or benchmark service.
- no claim that SoL-Pi's reported savings transfer to Bachata.

## Design

### 1. Bounded typed execution state

Pilot local Claude/Codex first. Each turn gets:

- immutable task and pipeline references.
- current typed state.
- latest controller observation.
- recallable evidence references.

Each answer returns typed proposed operations plus its task result. Controller validates ownership and applies the transition. Full
answer stays in audit storage. Next prompt uses state, not transcript replay.

State-only semantics require a fresh provider session. A resumed provider session may retain hidden
history, so Bachata must not claim bounded context while resuming it.

### 2. Structured consensus projection — proposed

Replace raw peer-answer replay with bounded fields:

- agreed claims.
- disputed claims.
- evidence references.
- unresolved decisions.
- requested next action.

Keep original peer answers in audit storage. Allow exact recall by reference when a dispute needs
it. Fail closed if projection is invalid or incomplete.

### 3. Browser observation handles — proposed

Large DOM, diff, and verifier output becomes controller-owned evidence. Prompt gets compact summary
and stable handle. Model may request exact evidence by handle. Controller checks scope and returns a
bounded slice.

Conversation rollover becomes state-aware. Start a fresh browser conversation when hidden history
is no longer useful, not only when a large byte ceiling is reached.

### 4. Safe action fusion — proposed

For managed browser work, permit one bounded mutation plan to include declared verification. The
controller still executes checks and owns the verdict. Failure enters the existing bounded revision
path.

Do not fuse when:

- human approval is required.
- verification target is unknown before mutation.
- provider must inspect new evidence before any safe next action.
- recovery or write scope would become ambiguous.

### 5. Evidence receipts later

Add deterministic receipts only after state projection works. Receipt names evidence id, type,
content digest, scope, and freshness. It is a reference, not proof supplied by a model.

## Provider split

| Path | First change | Main risk |
| --- | --- | --- |
| Local Claude/Codex | fresh sessions + bounded execution state | startup cost can erase savings on short tasks |
| Consensus pipeline | structured peer projection | reducer can hide a decisive disagreement |
| Browser Bridge | observation handles + state-aware rollover | website retains hidden conversation state |
| Managed browser mutation | action + declared verification fusion | unsafe coupling across an approval boundary |

## Invariants

- Controller remains authority for Git, write scope, verification, and integration.
- Exact source evidence stays durable and exportable.
- Projection never deletes audit evidence.
- Missing or stale evidence fails closed.
- Unknown schema version fails closed.
- Fresh-session gate is explicit and tested.
- Feature starts off. Existing flow remains fallback.
- No telemetry added.

## Rollout

1. Local bounded-state pilot on one managed workflow: implemented off by default; project gates pending.
2. Structured consensus projection.
3. Browser observation handles and state-aware rollover.
4. Safe action fusion.
5. Evidence receipts if earlier phases prove useful.

Each phase stands alone. Do not require later phases to ship an earlier safe reduction.

## Acceptance

- projected prompt size stays bounded across 10, 50, 100, and 200 deterministic transitions.
- deterministic fixtures reach equivalent allowed actions and final result with current flow.
- provider turn count drops where action fusion applies.
- stale, malformed, oversized, or unauthorized patches and evidence requests fail closed.
- restart from persisted state produces the same next prompt and allowed actions.
- exact admitted evidence remains exportable after preview pruning; disclose exclusions and redactions.
- disabling the setting restores legacy behavior for new runs; recoverable runs retain their pinned state.

Tests may assert prompt bytes, provider turns, state transitions, and result equivalence. No runtime
measurement layer.

## Paper evidence and limit

SoL-Pi reports lower token traffic and cost on its Pi-based evaluation, with a quality tradeoff at
its complete efficiency setting. Those are paper results, not Bachata results. Bachata has different
providers, session behavior, pipelines, browser control, audit requirements, and safety gates.

## Locked pilot decisions

Local TODO workflow, fresh sessions, fixed initial bounds, controller-only deterministic reducer,
strict proposals, no telemetry, off by default. No open product decision for this slice.
Later mechanisms and any default-on rollout need separate authorization and evidence.
