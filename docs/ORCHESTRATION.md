# Deterministic TODO orchestration

## Product role

TODO orchestration executes bounded work inside larger refinement loop. It can coordinate and verify tasks. It cannot validate product premise, remove shared model blind spots, or declare codebase finished. Human owns direction. Fresh comprehensive review and debugging runs inspect integrated result later. See [Product doctrine](PRODUCT_DOCTRINE.md).

Execution controls below are mechanics. Add friction only for concrete loss, corruption, incompatibility, or unrecoverable state.

## Input

Start from a clean committed Git baseline.

```md
- [ ] [TASK-1] Fix cancellation
  - Depends on: TASK-0
  - Paths: src/jobs, tests/jobs
  - Pipeline: todo-implementation
  - Verify: bachata:project-checks
  - Resources: database:test
  - Verify Final: bachata:workspace-integrity
  - Final Resources: global:database:verification, global:port:4173
  - Priority: 10
  - Retries: 1
```

`Verify: none` is explicit. `Paths` is required, and `Paths: .` explicitly selects the whole workspace.

<!-- generated:verification-policy -->
Autonomous verification runs `bachata:workspace-integrity` and `bachata:project-checks` by default. A `bachata:verifier:<id>` descriptor declared in `.bachata/verifiers.json` is refused before any process starts unless one workspace-level approval has been recorded and the run was started by the Improve command; every other run refuses every descriptor. That approval says a human accepted these executables, not that they are safe: a descriptor names an executable and Bachata cannot reason about what that executable does, and an ordinary script can start a browser E2E runner from inside itself. Direct E2E command forms are still classified on the executable, argument vector and the package scripts of the stated working directory, and refused, as defense in depth. That classification does not follow a manager's `--prefix` or `--workspace` into another package, and it is not a proof that arbitrary code cannot launch E2E. `tests/humanE2ePolicy.test.cjs` asserts these boundaries at runtime, and this generated block records the declaration only.
<!-- /generated:verification-policy -->

Metadata is fail-closed. Unknown or misspelled keys, incomplete integers, out-of-range priorities or retries, invalid resource names, duplicate scalar fields, and conflicting `none` declarations stop parsing with the TODO path and line number. Plain prose remains a continuation line or uses `Description:` or `Notes:`.

Path scope syntax is explicit for paths that do not exist yet. A missing path without a trailing slash is treated as one future file; use a trailing slash for a future directory scope, for example `Paths: src/features/new-dashboard/`. Existing files and directories are classified from the filesystem.

## Sealed working-tree input

A run normally starts from a clean `HEAD`. When the working tree is dirty, `Bachata: Run TODO.md` lists the changed paths and lets you seal the ones this run should start from.

Sealing copies those changes into the run's isolated worktree and records the resulting tree object under `refs/bachata/input/<run>`. It is a tree, not a commit: Bachata still creates no commit anywhere. Your branch does not move, your index is not touched, and nothing enters your history.

The run's own diff is measured against the sealed input, not against `HEAD`. Applying the result therefore stages only what the run produced; it never re-applies your own changes. A dirty path you did not seal still blocks the run, and sealing a path the working tree did not change is refused. Cleanup removes the sealed input ref with the rest of the run's Git resources.

## Ownership

The controller owns task graph, readiness, path conflicts, Bachata creation, retries, verification, Git, rollback, TODO updates, cleanup, and final state.

Start and resume claim one operation before asynchronous preparation. A conversation also claims one active run before creating iterations, pairs, or provider sessions.

Persisted recovery is accepted only for the same workspace and Git common directory. Before worktree or provider activity, Start resolves and persists the exact Master pipeline and every distinct incomplete task pipeline with normalized definition, SHA-256 revision, and storage scope. Resume and retries use those stored snapshots instead of current catalog definitions. Legacy pending work without them fails closed.

## UX

TODO Start, Resume, Stop, and Abandon are available inside Bachata and through VS Code commands.

Completed runs appear as retained Git resources with Reveal and Clean up actions. Retained runs survive extension restart and remain independently addressable after later runs replace the active run. Cleanup waits until no TODO mutation is active.

Start and Resume focus the exact root run. Each task opens its own child chat. Completed, failed, interrupted, and prior retry chats remain available under the root.

Abandon requires confirmation that names the integration branch and worktree. It keeps conversation history.

## Master

Master receives compact execution state only: task identity, dependencies, paths, status, attempts, result/check presence, completion time, and short errors.

It returns typed `continue` or `deviation` output. The controller validates every deviation kind and task reference. Master cannot inspect code, schedule work, mutate state, or override checks.

Master is execution watchdog, not human's product-direction Lead. It cannot decide that task premise is correct or that no further review is needed.

## Parallelism

Tasks run together only when dependencies are complete, path scopes do not overlap, and Bachata, provider, repository, and check capacity exists. Missing scope conflicts with every active task. Ordinary conversations reserve the repository exclusively; isolated TODO task worktrees may share bounded repository capacity. See `CONCURRENCY.md`.

Task IDs are canonical. Worktree and branch storage names include a stable hash so lossy filename normalization cannot collide.

## Git flow

The default managed mode is no-commit. Task and integration state are carried as staged trees while the source repository HEAD stays at its baseline.

```text
baseline
→ integration worktree
→ task worktree
→ pair pipeline
→ scope check
→ isolated snapshot verification
→ scope and Git-state check
→ stage exact task delta
→ serial tree integration
→ persist integration tree
→ isolated final verification
```

Verification runs in a disposable standalone repository created from the exact pending tree and placed outside orchestration worktree storage. Resets, commits, checkouts, and index changes there do not alter the source task or integration repository.

Before and after verification, the controller compares source branch, HEAD, index tree, and worktree status. Before integration it validates task branch ownership and ancestry. Autonomous orchestration always uses no-commit tree integration; environment variables and pipeline data cannot enable a commit/merge path.

POSIX checks use fixed non-login `/bin/sh -c`. Windows checks resolve `System32\cmd.exe /d /s /c` from the active absolute `SystemRoot` or `WINDIR`. Verification receives an allowlisted environment. It is not an OS sandbox.

## Stop and recovery

Stop prevents later controller mutations, cancels pending resource requests, interrupts active pairs and checks within bounded deadlines, and keeps resumable state. Uncertain physical-resource cleanup causes quarantine rather than immediate reuse.

Resume:

- keeps prior task conversations as history;
- creates a fresh chat for a retried attempt;
- removes stale extension-owned task worktrees and branches;
- reconciles TODO checkbox state already persisted before a ledger save;
- retries interrupted attempts without consuming an extra budget slot;
- resumes a preserved implementation checkpoint at verification without rerunning the model;
- leaves terminally exhausted tasks failed;
- offers only persisted rollback snapshots.

Failed integration restores the pre-task integration tree snapshot. Autonomous orchestration does not create task or integration commits.

## Cleanup

Successful tasks lose their task worktree and branch. Their conversations remain visible. The integration worktree and branch remain for inspection after completion. The controller discovers the retained set from validated persisted run ledgers rather than replacing it with the next run.

Clean up first persists `cleanupPending` with the exact verified extension-owned resources, then removes the selected completed run’s integration worktree and branch, and finally removes the retained ledger. Other retained runs and all conversation history remain intact. Startup reconciliation resumes an interrupted pending cleanup idempotently.

Abandon first persists `abandoning` with the exact verified extension-owned task and integration resources, then removes their worktrees and branches, persists `abandoned`, and clears the active recovery pointer. It does not delete task or Master histories. Startup reconciliation resumes interrupted cleanup idempotently. Failed or uncertain cleanup keeps the durable intent and exact resource metadata for another explicit attempt. If the active recovery pointer or ledger is corrupt, abandon refuses destructive cleanup, logs the validation failure, and preserves the pointer and Git resources whose ownership cannot be proven.

## Self-improvement

`Bachata: Improve This Project` runs the same controller with one extra job: when the repository
has no executable TODO, it works out what to do first.

Two paths, one command.

- Configured TODO parses with tasks left to run: Bachata runs it unchanged. No discovery, no
  rewrite of your file.
- TODO missing, empty, or not executable: the existing file becomes audit context, never
  executable input, and discovery starts.

Discovery, when it runs:

1. The run worktree is prepared first, so both agents read one immutable candidate tree.
2. Codex and Claude audit that tree independently, in parallel, from the same prompt, with their
   sessions rooted at it. Neither sees the other's first pass. Each returns a validated record of
   what it read before what it found.
3. The controller gates on those audits. An agent that reports it could not read the candidate,
   or that cites no path it opened, stops discovery here — before convergence and before any
   worker. A completed transport is not a completed audit.
4. Both then cross-check every claim against the paths it cites. A claim the source does not
   support is dropped. A claim the repository cannot settle stays unresolved and never becomes
   a task. A judgment a human owns becomes a named blocker carrying the exact question.
5. They converge on one structured task plan. Codex rules when they still disagree.
6. The controller takes the exact accepted candidate. No agent is asked to restate it.
7. The plan is checked against the candidate itself: a `bachata:verifier:<id>` it declares must
   exist in that tree's registry and be executable under this run's authority, and every
   evidence path must be a path the candidate has. Then it is rendered as an executable TODO and
   parsed back with the same parser `Bachata: Run TODO.md` uses. A plan that fails any of this never
   reaches a worker.
8. The generated TODO is written into the run's integration worktree and committed there, so the
   plan Bachata executed is part of the retained result and reaches you through Apply. Where it goes
   depends on what you have: a configured TODO that does not exist is the file you asked for and
   do not have, so the plan is written there; a TODO that exists but is not executable is prose
   you still want, so it is preserved untouched and the plan goes to `BACHATA_IMPROVE.md` beside it.
   The chosen path is recorded on the run.
9. The generated TODO and the parsed plan are persisted in run state and execution starts. No
   second Start action.

That file is the controller's for the rest of the run: each accepted, integrated task is checked
off in it, a worker that edits it fails its own task, and a resumed run reads it to know what is
already done. `generatedTodo.source` stays the immutable plan as accepted; the file in the tree
is the live checklist.

A plan carrying a blocker stops before implementation. The run is persisted, blocked, and names
the question — including a plan that is nothing but a blocker and carries no task at all. Resume
refuses such a run rather than restarting the question as work: answer it, abandon the run, and
run Improve again.

Both entry points offer the same working-tree seal, so a dirty checkout is startable: the paths
you select are copied into the isolated run as its starting point, and your branch, index and
working tree are untouched.

### Review and revision

Per task, in order:

1. Codex plans, Claude implements, in the task's own worktree.
2. The controller runs the task's declared checks. They come before the controller's own review.
   An Improve run defaults its tasks to the review-free `self-improvement` pipeline, so the
   common path has exactly one review, after the checks. A task that names its own pipeline
   keeps it, and a pipeline with its own review step necessarily runs that step inside the
   pipeline — before these checks. The Improve confirmation names any such pipeline.
3. Codex reviews that exact candidate — the diff, the changed files, the check commands with
   their exit codes and output, the worker's report, and the candidate tree identity. It
   returns machine-readable `accept`, or `reject` with bounded actionable defects. An `accept`
   that still names a defect is two answers at once and is refused, not resolved by guessing.
4. A rejection buys one bounded revision by default (`bachata.improveMaxRevisionCycles`). Claude
   receives the full review and revises in the same worktree.
5. The checks rerun, and Codex reviews once more. That review is final.
6. Only a check-passing, lead-accepted candidate integrates.

An exhausted revision budget fails the task, records both reviews, and integrates nothing.

Final declared checks then run against the integration tree. A successful run is retained and
offers one Apply action. Nothing is committed, pushed, or applied on its own.

### Repository verifiers during self-improvement

An Improve run may start the commands `.bachata/verifiers.json` names, after one workspace-level
approval. `Bachata: Run TODO.md` never does. See `docs/VERIFIERS.md` for what that approval is and
what it is not.

## Generated checklist

`executeChecklist` is the final enabled step.

- Model output contains ID, title, details, dependencies, and paths.
- Exact validated issues are checkpointed before user selection.
- Paths are visible and must remain inside user-authored `allowedPaths`.
- The task pipeline is selected from the parent's scope and snapshotted before the parent starts. Missing, invalid, scope-mismatched, or nested checklist pipelines reject preflight.
- Every generated task and retry explicitly uses that accepted task snapshot even after catalog edits, deletion, restart, or extension upgrade.
- Commands come only from pipeline-authored `checks`.
- Empty checks require explicit `allowNoChecks: true`; bundled first-run review flows do not execute repository changes without controller-owned checks.
- Timeout interrupts before orchestration and selects nothing.
- Repository `TODO.md` is not rewritten.

TODO metadata is strict: any indented list entry containing a colon is parsed as metadata and unknown keys are rejected. `Resources` requires at least one `Verify` command, `Final Resources` requires at least one `Verify Final` command, and machine-wide resource names must use the exact lowercase `global:` prefix.

## Authoring a TODO file

`TODO.md` is validated while you type. Bachata reports, per line:

- unknown metadata keys, with the closest real key as a one-click fix;
- a missing `Paths`, with an insert for the explicit whole-workspace form;
- a missing `Verify`, with inserts for `bachata:project-checks` or `none`;
- a verification command autonomous execution will not accept, with controller-owned replacements;
- duplicate ids, duplicate keys, unknown dependencies, self-dependencies, and dependency cycles;
- independent tasks that declare overlapping write scopes, which can run at the same time and whose merges can then conflict.

Snippets (`bachata-task`, `bachata-task-depends`, `bachata-task-resources`, `bachata-task-verifier`) write a well-formed task, and completion offers the metadata keys and the accepted verification values.

`Bachata: Preview TODO Plan` renders the execution order as numbered groups that may run together, the dependency graph, the overlapping write scopes, and every problem found. It runs the same analysis the diagnostics use, so a clean preview and a clean file are the same statement.

## Repository verifiers

<!-- generated:verification-operations -->
| Operation | Owner | Declared in |
| --- | --- | --- |
| `bachata:workspace-integrity` | controller | built in |
| `bachata:project-checks` | controller | built in |
| `bachata:verifier:<id>` | repository | `.bachata/verifiers.json` |
<!-- /generated:verification-operations -->

See `docs/VERIFIERS.md`.

## Applying accepted work

A retained run is not applied to your branch. The Result Center's inspect-and-apply handoff exports the patch, reruns the approved checks, or stages the accepted work on your current branch without creating a commit. Every refusal keeps the run worktree.

“Accepted” here means run's configured handoff conditions passed. It does not mean product direction or software correctness is proven. Applied result remains input to later fresh review runs.

### What a recheck verifies

A recheck never runs inside the retained integration worktree. The controller materialises a throwaway repository from the run's immutable baseline commit plus the exact patch that export and apply would produce, and runs the checks there. Checks therefore observe the same bytes the apply would stage, and a later edit inside the retained worktree cannot be mistaken for verified work. The recheck also acquires the same shared-resource lease, mutation detection, and cancellation as verification during the run; if the retained worktree changes while checks run, the recheck is refused instead of recorded.

A recheck runs the complete recorded command set — every task check plus the final checks — not the final checks alone. Any recorded check the recheck did not re-run is marked stale, and stale evidence blocks Apply until it is re-run.

### What a partial selection verifies

Selecting files or hunks produces a composition that no run ever verified. Before staging a partial selection, Bachata materialises that exact selection on top of the baseline commit and runs the run's checks against it. Apply proceeds only when every check passes on the selection alone. A selection that breaks a dependency the full run satisfied is refused, and the working tree is untouched.
