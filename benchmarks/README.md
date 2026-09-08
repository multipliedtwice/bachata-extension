# Offline comparison benchmark

Fixed tasks. Committed fixtures. Explicit scoring. No user data. No telemetry.

## Scope limit

This harness compares one single-agent run with one paired run. It does not test Bachata's core product mechanism: accumulated codebase refinement across many fresh review, debugging, and correction sessions. It also does not test human attention compression or ability to keep product direction without reading transcripts. See [Product doctrine](../docs/PRODUCT_DOCTRINE.md).

Pipeline agreement cannot prove correctness or remove shared blind spots. Any `correct` label below means only that one arm satisfies committed answer key and checks for one fixture.

## What it compares

One task, two arms:

- `single` — one strong agent, single-provider pipeline.
- `paired` — the matching cross-checked pair pipeline.

An arm is paired only if its pipeline actually runs two participants against each
other. `managed-fix` assigns one Worker under controller ownership, so it is a
`single` arm, not a pair. The paired Fix arm is `paired-managed-fix`, which reaches
consensus on the cause and then implements each selected item under controller
ownership.

Both arms must declare the SAME `requiredVerification`. The harness refuses a task
whose arms are held to different proof, because two arms proved differently cannot be
compared. The claim rule compares supported findings and false positives.

Task kinds: `review`, `plan`, `fix`.

## Boundary task

At least one task must require evidence the committed fixture cannot supply, or the
benchmark only measures reading committed files.

`protocol-boundary` is that task. Its required findings are properties of the Codex CLI
installed on the machine — the sandbox-mode and approval-policy spellings, the removed
readable-root fields, and the gap between `--version` and a real handshake. No amount of
reading `fixtures/protocol-boundary/` settles any of them.

A task states its outside access in `externalAccess`, and why the fixture cannot settle
it in `boundary`. That access belongs to the task, not to an arm: the harness refuses a
task that grants an arm its own access, and refuses a run record whose
`externalAccessUsed` is not exactly the access the task declares. Both arms therefore
run with the same access or neither is scored.

Neither arm may make a billable provider call to satisfy a boundary task. The declared
access for `protocol-boundary` is the schema generator and a non-billing app-server
handshake.

## What is committed

- `tasks/*.json` — task, prompt, arms, answer key.
- `fixtures/<task>/` — the repository files the task runs against.
- `runs/<task>/<arm>.json` — recorded run output. Empty until a human records a run.

Nothing here reaches a network. The harness reads files and prints a table. A boundary
task is the one exception, and only for the access it declares: the harness still reads
only committed files, and the run record states which declared access the arm was given
in `externalAccessUsed`.

## Record a run

Run the task by hand in Bachata against a copy of the fixture. Then write
`benchmarks/runs/<task>/<arm>.json`:

```json
{
  "taskId": "review-retry",
  "arm": "paired",
  "pipelineId": "review-only",
  "recordedAt": "2026-08-24T00:00:00.000Z",
  "provenance": {
    "extensionVersion": "0.7.0",
    "artifactPath": "bachata-vscode-0.7.0.vsix",
    "artifactSha256": "<sha256 of that file>",
    "fixtureSha256": "<sha256 the harness computes for this fixture>",
    "providers": [{ "name": "Codex", "adapter": "codex-app-server", "model": "gpt-5-codex" }],
    "runBundle": "runs/review-retry/paired.bundle.json"
  },
  "findings": [{ "id": "retry.unbounded", "file": "src/retry.ts", "line": 23 }],
  "verification": [{ "command": "bachata:project-checks", "status": "passed" }],
  "changedFiles": [],
  "completion": "completed"
}
```

`findings[].id` must be an answer-key id. A finding with any other id counts as a
false positive. That is the point: an arm cannot buy a score with volume.

## Provenance rules

Nothing here is taken on the record's word. A record is scored only when every one of
these holds. Otherwise the harness prints the rejection, exits non-zero, and makes no
claim:

- `pipelineId` is one of that arm's declared pipelines.
- `provenance.extensionVersion` equals the version in `package.json`.
- `provenance.artifactPath` resolves inside this checkout, the file is present, and the
  harness's own sha256 of it equals `provenance.artifactSha256`. A hash with no file
  behind it is refused.
- `provenance.fixtureSha256` equals the hash the harness computes from the committed
  fixture. A record produced against an edited fixture is void.
- `provenance.providers` records name, adapter, and model for every participant.
- `provenance.runBundle` resolves **inside `benchmarks/`**, exists, is tracked by Git,
  and parses as a Bachata run bundle. A path that escapes `benchmarks/` is refused, and so
  is an untracked file.
- The bundle corroborates the record: same pipeline, same participants down to the
  model, same verification results, same changed files, same completion status.

A hand-written record with no preserved run bundle is not evidence.

## Eligibility

An arm enters the comparison only when its run is *eligible*: completion `completed`,
scope held, and verification neither missing, failed, nor cancelled. An arm that
errored, ran out of scope, or has no verification result is not a data point — the task
counts as incomplete, and an incomplete task blocks every claim.

A paired arm that wins on findings but is not `correct` yields a tie, never a win.

## Scoring rules

Per arm, per task:

- **supported findings** — answer-key required findings the arm reported with the
  right id and a file match, line within 2.
- **misplaced findings** — right id, wrong location. Not supported, not a false positive.
- **false positives** — reported findings that are not answer-key required findings,
  including every `forbiddenFindings` entry.
- **verification outcome** — `passed`, `failed`, `cancelled`, `missing`, `notApplicable`.
  A required check with no recorded result is `missing`, never `passed`.
- **scope held** — changed files exactly match `expectedChangedFiles`. A review or
  plan task must change nothing.
- **completion** — as recorded: `completed`, `interrupted`, `error`, `notRecorded`.
- **correct** — every required finding supported, zero false positives, scope held,
  completion `completed`, and for `fix` tasks verification `passed`.

Per task, an arm wins only when it has strictly more supported findings and no more
false positives, or the same supported findings and strictly fewer false positives.
Anything else is a tie.

## Claim rule

The harness prints a claim only from recorded runs:

- Any record fails provenance: **no claim**, and the harness exits non-zero.
- Any preregistered task lacks an eligible result in **both** arms: **no claim**.
- Any task where `single` wins: **no claim that pairing improves results**.
- Every preregistered task won by a `correct` `paired` arm: the claim names the count.
- Mixed or tied: **no claim**.

The claim requires **all** preregistered tasks, not the subset that happened to record.

Do not quote a pairing claim that this harness did not print.

Do not generalize printed one-run claim into claim that two models solve misdirection or shared blindness. Do not use it as evidence for longitudinal refinement or human attention compression.

## Missing longitudinal benchmark

Core product needs separate committed benchmark across repeated fresh sessions on same evolving fixture. Record new material findings, false positives, regressions, durable resolutions, decision deduplication, reopened decisions, and human direction comprehension per round. No result exists yet. See [Roadmap](../docs/ROADMAP.md).

## Run it

```bash
node scripts/benchmark.mjs
```

With no recorded runs it prints the task inventory and states that no claim is supported.
