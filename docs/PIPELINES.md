# Pipelines

Pipeline JSON version: `1`.

## Product role

A pipeline performs one bounded pass inside a goal-directed cycle. It coordinates Lead, Worker, independent participants, checks, and revisions. It cannot prove correctness, remove shared blind spots, or validate product direction. Later fresh cycles inspect updated project state again. Human owns direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

Pipeline breadth is intentional. Different step shapes serve review, planning, implementation, debugging, and larger task execution.

## Cycle contract

Pipeline preset defines:

- problem context and human authority;
- cycle type and expected artifact;
- roles and participant independence;
- proposal, challenge, revision, or implementation flow;
- materiality and human escalation rules;
- convergence/disposition contract;
- accepted output and next-cycle handoff.

Artifact semantics belong to preset. A debugging preset may converge finding dispositions. Feature preset may converge requirements, plan, patch, and acceptance evidence. Product-review preset may converge observations and proposals while reserving direction decisions for human. Planning preset converges plan and open choices. Do not treat every pipeline output as finding or bug.

Current runtime and built-in presets focus on software work. Custom pipeline may define other artifacts and reasoning flows with existing providers. Do not add dedicated domain adapters by default.

## Step types

- `assignRoles`: bind user-defined roles to agents.
- `agent`: run one or more participants.
- `checklist`: convert accepted findings into strict issue JSON.
- `executeChecklist`: execute selected issues through the deterministic controller. It must be the final enabled step.

There is no default Reviewer. Built-in TODO work uses Lead and Worker. `todo-master` is a separate read-only watchdog.

## Typed outputs

An agent step may declare one JSON output and schema. The runner parses, validates, canonicalizes, hashes, stores, and exposes the artifact. Control behavior is never inferred from arbitrary prose.

## Decisions

Unanimous mode requires one identical candidate hash from every required participant. Arbiter mode lets the configured Lead publish one final ruling after objections.

Maximum-round behavior is explicit: human gate, fail, or Lead ruling when configured.

The conversation renders each arbiter result as a Lead’s Final Ruling card. It shows the selected candidate, ruling participant, participant set, objections and their dispositions, unresolved risks, and links to the corresponding participant outputs.

Unanimity and Lead ruling select one-run output only. Neither proves truth or correct direction. Shared model assumptions remain possible. Human resolves any direction-changing choice.

## Human attention projection

Pipeline output feeds one cross-run core-decision view. Top level includes only direction-changing decisions, unresolved disagreements, material assumptions, new material risks, and evidence needed for human judgment.

Each material decision projects stable subject, question, materiality, options, tradeoffs, recommendation, evidence, affected scope, status, provenance, and human resolution. Repeated same-subject output updates history. Material change supersedes prior version and shows delta. Resolved detail leaves top level. Material new evidence reopens it.

Routine turns, successful mechanics, repeated findings, completed revisions, and raw output stay in drill-down history. Pipeline completion alone creates no top-level decision.

## Finding lifecycle for review/debugging presets

Participant finding lists are provisional competing hypotheses. Never expose raw list as actionable or current codebase state.

Each finding needs stable subject, claim, affected scope, evidence, challenger response, and disposition:

1. `proposed`;
2. `challenged` or `confirmed` with evidence;
3. `accepted`, `rejected`, or `unresolved`.

There is no actual pipeline bug list before competing claims converge on dispositions. Pipeline-accepted routine findings enter execution checklist or actionable list automatically. Pre-authorized execution contract may proceed with routine fixes; no per-finding human ruling gate. Material unresolved findings, direction or scope changes, ambiguous identity, and irreversible action bubble to human. Rejected findings and debate remain provenance/history. Lead role gives no automatic correctness. Lead ruling may disposition configured pipeline, but convergence remains current one-run result.

Finding `accepted` = challenged model claim, actionable now. Not human direction. Not run completion. Not Git approval. Single-model and legacy claims stay proposed.

Single-participant finding remains single-source and provisional until later challenge/convergence. It is never bachata-accepted.

Later fresh review may reopen accepted or rejected finding only with materially new evidence. Reopened record shows prior disposition, new evidence, and delta.

## Checklist output

```json
{
  "issues": [
    {
      "id": "ISSUE_1",
      "title": "Fix cancellation",
      "details": "Block late repository mutation.",
      "dependencies": [],
      "paths": ["src/orchestrator"]
    }
  ]
}
```

Checklist model output cannot contain commands. Issue IDs use `^[A-Za-z][A-Za-z0-9_-]{0,79}$`. Paths must be nonempty, visible, repository-relative, and inside `executeChecklist.allowedPaths`.

`executeChecklist` owns:

```json
{
  "type": "executeChecklist",
  "allowedPaths": ["src", "tests"],
  "checks": ["bachata:project-checks", "bachata:workspace-integrity"],
  "checkResources": ["database:test", "port:4173"],
  "allowNoChecks": false,
  "retries": 1,
  "maxConcurrency": 2
}
```

<!-- generated:verification-policy -->
Autonomous verification runs `bachata:workspace-integrity` and `bachata:project-checks` by default. A `bachata:verifier:<id>` descriptor declared in `.bachata/verifiers.json` is refused before any process starts unless one workspace-level approval has been recorded and the run was started by the Improve command; every other run refuses every descriptor. That approval says a human accepted these executables, not that they are safe: a descriptor names an executable and Bachata cannot reason about what that executable does, and an ordinary script can start a browser E2E runner from inside itself. Direct E2E command forms are still classified on the executable, argument vector and the package scripts of the stated working directory, and refused, as defense in depth. That classification does not follow a manager's `--prefix` or `--workspace` into another package, and it is not a proof that arbitrary code cannot launch E2E. `tests/humanE2ePolicy.test.cjs` asserts these boundaries at runtime, and this generated block records the declaration only.
<!-- /generated:verification-policy -->

Use `checkResources` for database, Redis, port, Docker, browser-profile, or other shared resources required by generated-checklist verification. Names are repository-scoped unless prefixed with `global:`. Use `allowNoChecks: true` only when zero deterministic commands are intentional. Bundled first-run review pipelines do not modify the repository, and no bundled default silently opts into unchecked execution. See `CONCURRENCY.md`.

The exact checklist payload is persisted before selection. A restart restores it unchanged. Dependencies of selected issues are included only when present in the same validated checklist.

The `pipelineId` of every enabled `executeChecklist` step is selected from the current storage scope. Before any provider starts, Bachata resolves that task pipeline and validates its definition, capabilities, unattended permissions, and scope. A task pipeline cannot contain another enabled `executeChecklist` step. Missing, invalid, nested, or scope-mismatched dependencies reject the parent request before execution.

## Storage and revisions

Built-in presets are read-only. Custom pipelines are scoped by the canonical physical workspace root and stored in `<workspace-root>/.bachata/pipelines`. The UI retains the original VS Code workspace path for display. A multi-root workspace may use the same pipeline ID independently in different physical roots. A symlinked workspace root resolves to its physical root instead of falling back to extension-local storage. A `.bachata` or pipeline path that resolves outside that physical root is rejected before reading or writing. Without a workspace, every run uses one shared extension-local pipeline directory independent of conversation deletion.

Every file must be a regular file named exactly `<pipeline-id>.pipeline.json`. Invalid JSON, schema failures, symbolic files, wrong filenames, duplicate IDs, and built-in ID collisions block the complete custom catalog. The webview shows the catalog error and disables Save and Delete until the filesystem conflict is resolved.

Legacy global custom pipelines migrate into every current workspace-root scope and extension-local storage. Existing files are never replaced, and the legacy source is retained until every required target write succeeds.

Every custom definition has a canonical SHA-256 revision. The editor sends its source ID, storage scope, and expected revision for Save or Delete. A stale editor is rejected after another run changes or deletes the definition. New and imported drafts use create semantics and cannot replace an existing custom or built-in ID. Deliberate replacement requires reopening the current definition and saving its current revision.

Mutation ownership is keyed to the canonical physical catalog directory. Runs in one Extension Host serialize through one manager queue. Independent workspace definitions in one profile also coordinate through the profile-wide resource broker. A token-checked filesystem lock in the catalog additionally coordinates separate local VS Code profiles. The lock heartbeat updates its owned file handle. A live local process is never reclaimed solely because its heartbeat looks stale; a confirmed abandoned local lock may be reclaimed after the configured stale interval. File publication and deletion are conditional on the exact prior content, and concurrent external content is preserved rather than overwritten.

Open runs watch catalog file creation, change, and deletion and refresh after committed changes. A run that already owns durable history keeps its immutable selected snapshot. A clean run adopts the current catalog definition. Direct execution reloads and compares the selected custom definition immediately before acceptance. Reset re-resolves the current root catalog and drops a deleted custom selection.

Structured and JSON modes edit one draft. Validation, import, export, save, and delete lock the complete editor, including nested controls, drag ordering, Escape, and close controls, until the operation finishes. Import validates into an unsaved draft and requires Save before the definition is persisted or selected. Pipeline selection completes before editing controls are enabled.

An enabled `executeChecklist` step performs Git preflight before any provider is called. For this embedded flow, only files inside the active custom-pipeline catalog may be dirty; every other tracked, staged, untracked, copied, or renamed path blocks execution and is listed in the error. This exemption treats pipelines as controller configuration and does not copy their uncommitted content into generated worktrees. The top-level `Bachata: Run TODO.md` command does not receive this exemption and still requires a completely clean repository.

## Execution snapshots

Immediate execution, queued work, interrupt delivery, every requested iteration, and interrupted recovery use one validated immutable execution bundle. The bundle stores the parent pipeline's normalized definition, SHA-256 revision, and storage scope plus the same identity for every enabled `executeChecklist` task pipeline. Its canonical bundle hash authenticates the complete accepted execution plan. Catalog edits, deletion, or extension upgrades after acceptance cannot change pending or recoverable parent, task, retry, or Master work.

Generated-checklist tasks receive the exact accepted task-pipeline snapshot. Top-level `TODO.md` orchestration resolves and persists each distinct task pipeline and the Master pipeline before creating worktrees or provider sessions. Every task attempt and retry explicitly uses that stored snapshot. Task and Master snapshot slots are root definitions only; nested dependency bundles are rejected. Legacy queue, recovery, or orchestration state without the required verifiable snapshots fails closed instead of resolving current catalog definitions.

Iterations repeat one execution bundle with the same input and attachments. They are sequential and use fresh chats. If an iteration is interrupted, Resume restores that exact bundle and persisted catalog context, then continues later requested iterations after completion.

Fresh chats inside one iteration series reduce conversational carry-over, but series remains one configured run. Product refinement also uses separate fresh top-level review or debugging runs after accepted code changes. `until clean` means configured iterations stopped changing repository state. It never means no defects remain.

## MVP limit

No general branching language or arbitrary workflow scripting.

## Product review and feature delivery

Two presets exist so a product judgment is not left to a generic review.

`product-review` cross-checks what the work commits the product to, converges on
recommendations that each carry an explicit disposition, and records the agreed set as a
durable `recommendation` artifact. It writes nothing.

`feature-delivery` converges on the requirements a feature must meet, records them as a
`requirement` artifact and the chosen approach as a `design` artifact, then runs a managed
Worker inside the declared write scope while a read-only Lead reviews against those
records. The controller owns verification and Git.

Both bound their consensus rounds and escalate to a human gate rather than accepting a
majority, and both end by naming the material judgments they leave to you.
