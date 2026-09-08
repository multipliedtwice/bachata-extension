# Concurrency and shared resources

Concurrency is execution capacity, not software-quality signal. More parallel agents do not replace sequential fresh review or human direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

Bachata may run several conversations and managed TODO tasks at once inside one owning Extension Host. Separate workspaces may also run concurrently. The same workspace has one authoritative Bachata state writer to prevent stale-window catalog, transcript, pipeline, and cleanup mutations.

Git worktrees isolate tracked files. They do not isolate databases, Redis, ports, Docker projects, browser profiles, provider processes, CPU, memory, or disk. The deterministic controller owns resource acquisition, retry timing, release, checks, and quarantine. Models do not.

## Workspace ownership

At activation, Bachata acquires an abstract `workspace-state-writer` lease derived from the canonical VS Code workspace storage directory. The identity does not change when folders are added to or removed from a multi-root workspace. Mutable Bachata services are created only after that lease is acquired.

If another Extension Host owns the same workspace:

- Bachata commands in the second host fail closed;
- no conversation manager, catalog writer, transcript writer, pipeline editor, or TODO controller starts there;
- the user must close the owning window and reload the blocked window.

The lease is abstract. A crashed or selectively stalled owner may be replaced by a live peer after the stale-owner deadline. Every lease has a persisted resource identity and fencing token. Catalog mutations validate the live lease and SQLite triggers reject a connection whose resource identity or token has been replaced. Filesystem and VS Code Memento mutations pass through a workspace mutation fence that holds one SQLite write transaction across the final commit. A mutation already inside that fenced transaction finishes before a newer writer token activates; every later mutation from the old writer is rejected. Runtime, Browser Bridge, and TODO work observe lease loss and stop. The stale window must reload before it can mutate Bachata state again.

Whole-machine suspension is handled separately: every newly started broker receives one stale-owner grace interval, and a host that observes a long local timing gap renews that grace while all hosts resume. A window opened immediately after wake therefore cannot revoke pre-sleep owners before they heartbeat. Owners that remain stale are reclaimed after the grace interval. This does not let a selectively paused host retain authority after a live peer has replaced it.

Multiple conversations and task worktrees remain supported inside the owning Bachata interface.

## Global broker

One SQLite broker lives under the VS Code user-profile global storage directory. Hosts using that profile coordinate through it. Broker and catalog initialization use bounded retry for `SQLITE_BUSY` and `SQLITE_LOCKED`; migration versions are rechecked after the write transaction is acquired. Activation fails instead of continuing without coordination.

The broker provides:

- atomic all-or-nothing acquisition;
- FIFO ordering for overlapping requests;
- bounded capacities recomputed from active lease and queue declarations;
- rejection of any request whose units exceed its declared capacity;
- persisted fencing tokens and lease-loss signals;
- one wall-clock persistence deadline plus a local monotonic deadline;
- cancellation before process start;
- stale-owner cleanup;
- quarantine for physical resources whose cleanup is not confirmed;
- explicit operator-controlled quarantine clearing.

The current owner renews itself before stale cleanup and is excluded from its own cleanup query. A whole-machine timing gap starts a local cleanup grace period when that host resumes. A selectively paused or unhealthy owner can still be replaced by a live peer. On resume, persisted lease validation invalidates its local lease objects and protected work fails closed.

A heartbeat or lease-validation failure aborts local lease signals. Owners must stop the protected operation rather than continue with unverified authority.

The broker does not coordinate commands started outside Bachata, another operating-system user, another VS Code user-data profile, or another machine.

## Pair execution

Every active execution reserves machine-wide Bachata capacity. Native Codex and Claude participants also reserve local-provider capacity. `bachata.maxConcurrentLocalAgents` is a hard machine-wide maximum. Execution preparation resolves role assignments and calculates the largest provider-process demand across enabled steps. Codex app-server processes remain reserved after first use until provider cleanup. Sequential Claude Code turns share one transient slot, while parallel Claude turns reserve one slot per participant. Local-provider capacity is physical: uncertain provider cleanup or stale ownership quarantines it until an operator verifies that provider processes are gone.

For Git repositories:

- an ordinary conversation reserves the repository exclusively;
- ordinary conversations opened in different subdirectories of one repository serialize;
- a controller-created task reserves one repository unit and its exact managed worktree;
- distinct managed task worktrees may run in parallel up to `bachata.maxConcurrentRepositoryTasks`;
- an ordinary conversation conflicts with every managed task in that repository.

For non-Git folders, the canonical working directory is exclusive.

`bachata.executionSlotTimeoutMs` is one bounded request. Timeout fails once and does not create an internal retry loop. While waiting, the webview shows `waitingForResources`, confirms that no provider or check has started, and exposes Cancel wait. Cancellation removes the request; returning capacity cannot start it later.

A conversation execution lease is reference-counted. Each active user contributes its local-provider demand. Concurrent direct interventions, queued work, resumed work, and the retained pipeline reservation are summed; supplemental global slots are acquired before the added work starts, and the hard maximum is rejected before provider execution. Native availability checks use the same reservation and run through a bounded worker pool, while browser availability checks may proceed independently. Accepted nested work and queued continuation retain ownership until all users complete cleanup. New work arriving while cleanup closes waits for that bounded cleanup, then acquires a fresh lease.

The final `executeChecklist` step releases the parent execution lease before child orchestration starts. A completed checklist is persisted without reacquiring unused parent capacity. A later pipeline iteration performs a new bounded acquisition immediately before that iteration starts.

## Custom-pipeline catalogs

Pipeline catalog ownership is derived from the canonical physical catalog directory, not the VS Code workspace-state identity. One manager queue serializes runs in an Extension Host. The profile-wide broker serializes independent local Extension Hosts that address the same physical catalog. The filesystem lock additionally covers separate local VS Code profiles. A token-checked filesystem lock covers reload, revision comparison, conditional file commit, rollback, and delete finalization.

The lock heartbeat updates the already-open lock file rather than its pathname. A live local owner is not reclaimed only because the window or machine was paused beyond the stale interval. A stale lock is reclaimed automatically only when its local owning process is confirmed absent; malformed abandoned locks may also be reclaimed. Foreign-host ownership fails closed instead of guessing that another machine is dead.

External catalog file events refresh open runs. Direct execution also reloads the selected custom pipeline under the same ownership path and rejects a changed or invalid definition before provider work. Invalid catalog entries block all custom definitions in that scope rather than selecting a definition by filesystem enumeration order.

## TODO orchestration ownership

A repository-scoped physical `todo-orchestration-owner` lease covers the complete recoverable TODO lifecycle, including start, resume, stop, abandon, and retained cleanup. A second controller cannot start a competing orchestration merely because individual Git operations serialize.

The owner is released only after lifecycle cleanup is confirmed. Stop timeout or uncertain shutdown quarantines it.

## Git administration

Worktree creation, removal, pruning, branch/ref administration, validation snapshots, tree publication, resets, and cleanup use one exclusive resource derived from the Git common directory. Autonomous orchestration does not create task or integration commits.

Git failures preserve command, exit, timeout, cancellation, output, and process-cleanup certainty. If process termination is not confirmed, `git-administration` is quarantined. If a cleanup command exits but fails, Bachata retains the ledger and exact worktree or branch metadata instead of reporting cleanup success.

Models and checks do not hold the Git-administration lease while doing ordinary work in isolated task worktrees.

## Deterministic checks

Every controller-owned check reserves:

- machine-wide check capacity, bounded by `bachata.todoGlobalCheckConcurrency`;
- the repository verification resource exclusively;
- every resource declared by the task or final-check profile.

All claims are acquired atomically. Task checks and final checks are separate:

```md
- [ ] [API-1] Change API behavior
  - Paths: src/api, tests/api
  - Verify: bachata:project-checks
  - Resources: database:api-test, redis:api-test

- [ ] [UI-1] Change UI behavior
  - Paths: src/ui, tests/ui
  - Verify Final: bachata:workspace-integrity
  - Final Resources: global:database:verification
```

Resource names without `global:` are repository-scoped. Use `global:` only when separate repositories truly share the same resource. Identical final commands are deduplicated and run once after integration. Raw checks without resource metadata still receive exclusive repository verification.

The built-in TODO Worker may implement and inspect. It does not own declared acceptance, integration, E2E, database, Docker, browser, or other protected checks. Unattended orchestration rejects Claude `bypassPermissions`.

## Waiting, stopping, and recovery

After implementation succeeds, a task records `implementationComplete`, waits for resources, then verifies. If acquisition expires:

- the task becomes blocked;
- its worktree and checkpoint remain;
- the implementation retry budget is not consumed;
- no automatic reacquisition is created;
- explicit Resume creates one new bounded request.

Stop cancels pending requests before any process starts. Active commands receive cooperative cancellation, bounded process-scope termination, validation cleanup, and an outer shutdown deadline. Git commands receive the controller abort signal. Losing a workspace, execution, orchestration-owner, or verification lease also aborts the associated work.

Verification, availability, browser-action, bounded-test, isolated-test, and human-E2E commands run inside a controller-owned process scope. On Windows, a kill-on-close Job Object contains the command and its descendants, and cleanup succeeds only after the job reports no active process. On Linux, macOS, and supported BSD systems, Bachata combines the original process group with an inherited random scope token and scans for token-bearing descendants, including descendants that create a new session. Unsupported scanning or an uncertain result fails closed; declared physical resources are quarantined rather than reported reusable.

POSIX scope tracking is process cleanup, not a kernel sandbox. A deliberately hostile descendant may evade token-based tracking by removing the inherited marker and fully daemonizing. User-authored checks must not be treated as untrusted-code containment, and strict isolation still requires an operating-system or container boundary outside Bachata.

Local Claude Code and Codex transports also use POSIX group and inherited-token cleanup while
preserving their interactive pipes. Windows provider transports retain `taskkill /T`; they do not
use the command-runner Job Object host.

Corrupt recovery state is not silently deleted. Bachata preserves the pointer and refuses destructive cleanup when ownership cannot be verified.

## Quarantine

Physical resources are quarantined when process termination or cleanup cannot be confirmed. New acquisition attempts reject an already quarantined resource before entering the queue, regardless of the caller’s remaining deadline. Abstract capacity is released after owner loss. Examples include:

- a provider or check process tree that did not terminate;
- uncertain Git administration;
- failed validation-repository cleanup;
- uncertain TODO lifecycle shutdown;
- uncertain Browser Bridge shutdown.

Use `Bachata: Clear Resource Quarantine` only after verifying that related processes, ports, databases, Docker projects, browser profiles, worktrees, and Git operations are inactive. Clearing quarantine performs no project-specific cleanup.

## Browser Bridge

Only one local Extension Host per VS Code profile may own Browser Bridge. A non-owner keeps native providers available. After the owner closes cleanly, Discover or Reset performs one bounded acquisition and starts Bridge ownership in the surviving host without an infinite retry loop.

The lease is released only after Bridge shutdown is confirmed. Uncertain shutdown quarantines ownership. If the persisted lease is replaced or can no longer be verified, the local Bridge server closes and the window must reacquire ownership explicitly.

## Test databases and services

Serialization prevents overlap; it does not remove data left by a previous run. Prefer unique schemas, Redis prefixes, Docker project names, dynamic ports, browser profiles, and temporary directories derived from run and check identity. Delete only resources created for that identity.

For one shared test environment:

1. declare it exclusive;
2. reset it before the suite;
3. run the suite;
4. clean it afterward;
5. verify cleanup;
6. quarantine it when cleanup is uncertain.

A test command must fail closed when test configuration is missing and must never fall back to development or production data. Strict CPU, memory, process-count, and disk limits require operating-system or container controls outside Bachata.

Workspace writer identity canonicalizes the deepest existing storage-path ancestor and appends any missing tail. Directory creation therefore cannot change the ownership key. Verification resources are released only after the controller confirms that the process scope is empty; uncertain cleanup fails closed and quarantines declared physical resources.

## Ownership handoff between windows

`Bachata: Workspace Ownership` states which window writes this workspace state, and moves it deliberately.

The owning window can release ownership when no orchestration run is executing. Releasing stops writing and reloads that window; nothing is deleted.

A window that does not own the state sees whether another window holds the lease, how long ago that window last reported, and whether that is past the stale threshold. It can request ownership again or reload.

Bachata never takes a live lease from another window. A lease is reclaimed only after its owner stops reporting for longer than the stale threshold.
