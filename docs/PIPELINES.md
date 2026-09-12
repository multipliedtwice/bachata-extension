# Pipelines

Pipeline JSON version: `1`.

## Choosing a workflow

Start with **Fix a bug**, **Code review**, **Implementation plan**, **UI/UX review**, or **Code review and refinement**. Choose the providers separately in **Agents**. The picker keeps custom definitions visible and places specialized workflows, compatibility copies and internal controller stages under **More workflows and compatibility presets**.

Code review is read-only and single-source. UI/UX review has two read-only reviewers and requires actual visual evidence. Code review and refinement reviews first, then implements confirmed findings inside its declared scope, performs independent review, one explicit revision, and final review. Consensus rounds exchange claims; composer iterations replay the entire workflow. Neither is an unbounded “until correct” loop.

See [the complete pipeline audit](#pipeline-product-audit--071-source-candidate) for all shipped choices, prerequisites, verification ownership and the separate assignment scope of generated tasks. Existing pipeline IDs and archived execution snapshots remain intact.

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

## Pipeline product audit — 0.7.1 source candidate

This audit concerns the uploaded source candidate. It does not invalidate the user’s observed working Codex CLI and Claude CLI pipelines. Authenticated Browser Bridge acceptance and native VS Code graphical acceptance remain open.

### What to choose

| Your intent | First choice | What happens |
|---|---|---|
| Fix a reported bug | Fix a bug | One participant diagnoses without writes, then implements after the existing human gate. The controller runs the declared checks. No commit. |
| Review code without changes | Code review | One read-only pass. Findings remain single-source; there is no independent consensus or implementation phase. |
| Plan a change | Implementation plan | One read-only planning pass. |
| Review UI/UX | UI/UX review | Two read-only reviewers inspect usability, accessibility and hierarchy, then reconcile in at most four rounds. Supply screenshots or actual UI access. Source alone is insufficient for visual acceptance. |
| Review and refine code | Code review and refinement | Two independent reviews, up to four reconciliation rounds, one implementation phase, independent lead review, one explicit revision phase and a final review. Writes are scoped to src/tests; checks must be configured. No commit. |

Choose providers in Agents after choosing the workflow. The five common choices appear first. Custom pipelines remain visible. More workflows exposes specialized workflows, compatibility copies and clearly named internal controller stages. A selected specialized workflow remains visible in the common view. Existing IDs and archived snapshots are preserved; historical snapshots may retain their old names because they record the exact definition that ran.

### Root causes and corrections

The old catalog conflated four separate dimensions: task intent, provider defaults, orchestration/controller stages, and repeated review mechanisms. Titles and participant names carried provider identities even after assignments became independent. Provider-specific duplicate presets competed with ordinary choices. Product direction review and a four-browser implementation pipeline were the nearest apparent substitutes for a visual UX audit, although neither was a read-only visual workflow.

All shipped titles and participant labels now describe responsibilities. Compatibility copies retain their IDs, executable steps and default adapters. They are secondary choices, not deleted definitions. No stored user definition or historical snapshot is rewritten. Two additive workflows fill the missing read-only UI/UX and review-before-refinement paths.

The new refinement pipeline keeps its participants in the root run. Source tracing found that executeChecklist task pipelines have their own accepted snapshot and participant configuration: parent Agents overrides are not automatically propagated to those children. The reviewed-task preset now says this explicitly. Unifying that behavior is still separate engineering work; this candidate does not pretend the parent picker controls every child.

### Rounds, revisions and iterations

Consensus rounds exchange structured candidate claims until agreement or the configured limit. They do not imply code changes. The generic browser worker/lead presets have an unconditional planned revision step, not an accept/reject-driven revision loop. The new code refinement workflow also has exactly one explicit revision step. It declares no browser-only maxRevisionCycles policy: its one revision is an explicit step, not a conditional loop.

Improve This Project has a different controller-owned review/revision loop, with checks and structured accept/reject decisions. Its component presets require controller packets and should not be mistaken for standalone everyday workflows. The TODO controller owns child worktrees, scheduling, checks and integration.

Composer iterations replay the entire accepted workflow sequentially with fresh chats. They are not consensus rounds and do not mean “repeat code refinement until defect-free.” Pipeline completion, consensus and passing checks are distinct facts.

### Complete shipped catalog

Rounds list each consensus step’s configured maximum. The table is generated from all 31 final definitions, not inferred from titles. A managed declaration is not evidence that a real provider or project verifier ran in this environment.

| Stable ID | Current title | Enabled steps | Consensus maxima | Input context | Verification ownership |
|---|---|---:|---|---|---|
| `browser-pair` | Browser research — cross-review | 2 | 10 | Run input | No managed controller checks in this definition |
| `chatgpt-browser-spike` | Browser task — one participant | 1 | None | Run input | No managed controller checks in this definition |
| `claude-browser-agent` | Browser task — one participant (compatibility) | 1 | None | Run input | No managed controller checks in this definition |
| `claude-fix` | Fix a bug — one implementer (compatibility) | 2 | None | Run input | Managed policy; inspect configured checks and scope |
| `claude-browser-pair` | Implement and refine — browser pair (compatibility) | 5 | None | Run input | Managed policy; inspect configured checks and scope |
| `claude-plan` | Implementation plan — one planner (compatibility) | 1 | None | Run input | No managed controller checks in this definition |
| `claude-review` | Code review — one reviewer (compatibility) | 1 | None | Run input | No managed controller checks in this definition |
| `code-review-refine` | Code review and refinement | 7 | 4 | Run input | Managed policy; inspect configured checks and scope |
| `codex-fix` | Fix a bug | 2 | None | Run input | Managed policy; inspect configured checks and scope |
| `codex-plan` | Implementation plan | 1 | None | Run input | No managed controller checks in this definition |
| `codex-review` | Code review | 1 | None | Run input | No managed controller checks in this definition |
| `core-decisions` | Identify decisions for you | 2 | 10 | Run input | No managed controller checks in this definition |
| `cross-reference-development` | Review and prepare tasks | 3 | 10 | Run input | No managed controller checks in this definition |
| `debug` | Diagnose and fix — model review | 5 | 10, 15 | Run input | No managed controller checks in this definition |
| `feature-delivery` | Deliver a feature | 8 | 6 | Direction | Managed policy; inspect configured checks and scope |
| `generic-browser-pair` | Implement and refine — generic browser | 5 | None | Run input | Managed policy; inspect configured checks and scope |
| `gpt-browser-pair` | Implement and refine — browser pair | 5 | None | Run input | Managed policy; inspect configured checks and scope |
| `managed-fix` | Fix within a declared scope | 3 | None | Direction | Managed policy; inspect configured checks and scope |
| `paired-managed-fix` | Fix a bug — reviewed tasks | 4 | 4 | Run input | Task controller: bachata:workspace-integrity, bachata:project-checks |
| `plan` | Implementation plan — reconcile proposals | 3 | 10 | Direction | No managed controller checks in this definition |
| `product-review` | Product direction review | 4 | 6 | Direction | No managed controller checks in this definition |
| `review-only` | Code review — reconcile findings | 3 | 10 | Direction | No managed controller checks in this definition |
| `self-improvement-convergence` | Internal — improvement convergence | 1 | 2 | Run input | No managed controller checks in this definition |
| `self-improvement-discovery` | Internal — improvement discovery | 1 | None | Run input | No managed controller checks in this definition |
| `self-improvement-review` | Internal — improvement review | 1 | None | Run input | No managed controller checks in this definition |
| `self-improvement-revision` | Internal — improvement revision | 1 | None | Run input | No managed controller checks in this definition |
| `self-improvement` | Internal — improvement task | 3 | None | Run input | No managed controller checks in this definition |
| `specialist-browser-review` | Implement with QA and UX review | 5 | 16 | Run input | No managed controller checks in this definition |
| `todo-implementation` | Internal — task implementation | 4 | None | Run input | Managed policy; inspect configured checks and scope |
| `todo-master` | Internal — task progress check | 2 | None | Run input | No managed controller checks in this definition |
| `ui-ux-review` | UI/UX review | 2 | 4 | Run input | No managed controller checks in this definition |

### Browser Bridge and model selection

Previously, Browser Bridge only expanded a list and told the user to connect elsewhere. Opening it now sends bridge.discover; the runtime starts or refreshes the local endpoint before discovery, preserving the serialized host mutation queue. The role card keeps pairing instructions, Copy pairing token, local endpoint, Refresh conversations and any bridge error together. A remote VS Code window explains the local-window requirement. Clicking the button cannot install the companion extension, sign into a provider, or establish an authenticated browser connection by itself. Those real external actions remain necessary.

The former Model name / Use this model field sends an exact provider model-ID override for the selected participant. It does not install a model, provision access, or change the browser site’s model. It is now a closed Other model (advanced) disclosure with those semantics and Apply model override. The common model choices remain visible. Automatic means the provider default unless the pipeline pins a model, in which case Pipeline default names the pin. Browser sessions retain “selected in the browser · unreported.” Opening browser setup hides the unrelated CLI model controls.

### Verification and remaining decisions

The product regression suite checks every shipped title and role label, validates every definition, verifies UI/UX read-only permissions, and executes the new review/refinement step order with provider doubles. DOM tests cover common versus expanded choices, inline bridge discovery/pairing, advanced model explanation and the browser-model ownership note. Provider doubles prove scheduling and request formation; they are not authenticated provider acceptance.

The source audit still leaves release-wide work open: a complete composed outgoing-message ceiling, the full real-adapter Stop race matrix, provider-level subagent prevention against the user’s exact installed Codex version, native VS Code graphical review, and the missing release inputs listed in the final engineering report. The new workflows require live product acceptance before publication.
