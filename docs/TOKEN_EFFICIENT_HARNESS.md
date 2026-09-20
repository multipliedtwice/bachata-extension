# Token-efficient harness (design, not shipped)

Status: proposal. No runtime change. No Bachata token or cost claim.

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

Each answer returns a validated state patch plus its task result. Controller applies patch. Full
answer stays in audit storage. Next prompt uses state, not transcript replay.

State-only semantics require a fresh provider session. A resumed provider session may retain hidden
history, so Bachata must not claim bounded context while resuming it.

### 2. Structured consensus projection

Replace raw peer-answer replay with bounded fields:

- agreed claims.
- disputed claims.
- evidence references.
- unresolved decisions.
- requested next action.

Keep original peer answers in audit storage. Allow exact recall by reference when a dispute needs
it. Fail closed if projection is invalid or incomplete.

### 3. Browser observation handles

Large DOM, diff, and verifier output becomes controller-owned evidence. Prompt gets compact summary
and stable handle. Model may request exact evidence by handle. Controller checks scope and returns a
bounded slice.

Conversation rollover becomes state-aware. Start a fresh browser conversation when hidden history
is no longer useful, not only when a large byte ceiling is reached.

### 4. Safe action fusion

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

1. Local bounded-state pilot on one managed workflow.
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
- full chronology and original evidence remain exportable.
- disabling feature restores current behavior.

Tests may assert prompt bytes, provider turns, state transitions, and result equivalence. No runtime
measurement layer.

## Paper evidence and limit

SoL-Pi reports lower token traffic and cost on its Pi-based evaluation, with a quality tradeoff at
its complete efficiency setting. Those are paper results, not Bachata results. Bachata has different
providers, session behavior, pipelines, browser control, audit requirements, and safety gates.

## Owner decisions

- ship pilot or keep design only.
- first workflow for pilot.
- fresh-session cost acceptable or not.
- state and evidence bounds.
- reducer model, deterministic reducer, or hybrid.
- minimum quality-equivalence fixtures before default-on consideration.
