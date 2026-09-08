# Longitudinal refinement benchmark

Fixed multi-round tasks. Committed fixtures. Explicit scoring. No user data. No telemetry.

The single-round benchmark in [../README.md](../README.md) compares one run against one run.
This harness measures the thing that harness explicitly does not: what accumulates across
repeated fresh review, correction, and validation cycles against the same fixture.

## Scope limit

Nothing here proves correctness. A round is scored against a committed answer key for a
committed fixture. Saturation, agreement, and repetition are not correctness.

## What is measured

Per round, per arm:

- `newSupportedFindings` — answer-key findings first reported in this round, counted by
  stable finding identity, not by run-local id.
- `falsePositives` — findings named in the answer key as false positives.
- `dispositions` — accepted, rejected, and unresolved counts.
- `resolvedStayResolved` — a finding that disappeared from a fresh review must not
  reappear without a recorded material evidence delta.
- `regressions` — a resolved finding that reappears.
- `humanVisibleCoreDecisions` — answer-key core decisions actually surfaced to a human.
- `routineCollapsed` — repeated routine information collapses to one tracked identity
  per answer-key item instead of one item per round.

## What is committed

- `tasks/*.json` — task, rounds, arms, answer key, declared metrics.
- `runs/<task>/<arm>.json` — recorded rounds. Empty until a human records them.

The fixture repositories are shared with the single-round benchmark under `../fixtures/`.

## Claim rule

A task is eligible only when both arms have recorded rounds. With no eligible task the
verdict states that the benchmark supports no claim. Claude does not record rounds.
