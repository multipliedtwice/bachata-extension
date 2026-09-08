# Security

No telemetry. `NO_TELEMETRY.md` is authoritative.

## Product boundary

This file records current software implementation boundaries and residual risk. Security restriction is not Bachata's product value. Product value is human-directed multi-agent problem solving and attention compression. See [Product doctrine](PRODUCT_DOCTRINE.md).

Do not turn a documented boundary into broader restriction without concrete failure mode, user need, or platform constraint. Review friction against refinement quality. Keep accurate boundary; remove or simplify control that only interrupts Lead/Worker work without material benefit.

## Boundaries

- VS Code extension: local controller, filesystem, Git, and controller-owned autonomous checks.
- Provider adapter: provider session and response.
- Browser Bridge: provider page and authenticated browser context.
- Pipeline file: prompts, independent read/write paths, checks, retries, and concurrency.
- Workspace-state writer: one authoritative mutable Bachata host per workspace.
- Custom-pipeline catalog: canonical root containment, machine-wide physical ownership, a token-checked file lock, exact-content commits, and fail-closed file validation.
- Global resource broker: Bachata, provider, repository, TODO lifecycle, Git administration, check, Browser Bridge, and declared service ownership across Extension Hosts in one VS Code profile.

## Workspace and ownership

- TODO execution requires Workspace Trust and a clean committed baseline. An embedded custom `executeChecklist` may exempt only its active pipeline catalog; top-level TODO execution remains completely strict.
- Every run is bound to the initiating workspace and Git common directory. A second host for that workspace cannot start mutable Bachata services.
- Persisted paths, branch namespaces, task identities, dependencies, integration trees, write scope, and verification fingerprints are validated before recovery. Commit-enabled autonomous state is rejected.
- Master runs in an extension-managed empty directory and receives state only.
- Browser workspace actions enforce path, realpath, symlink, and credential-path containment. Listings, reads, and searches reject credential, VCS, dependency, and generated paths, including worktree-style `.git` files and symlink aliases.
- Root-scoped pipeline storage resolves workspace aliases to one canonical physical root. A `.bachata` or pipeline path that escapes that root, or a symbolic pipeline file, is rejected. Pipeline files must be regular and named from their validated ID.

## Generated work

- Checklist model output contains issue metadata and paths only.
- Model-generated commands are rejected.
- Generated paths are shown to the user and must remain inside pipeline-owned `allowedPaths`.
- Empty or repository-wide generated scope is invalid unless the pipeline explicitly owns repository-wide scope.
- Timeout selects no generated work.

## Commands

- Git uses executable plus argv.
- Autonomous TODO `Verify:` and pipeline `executeChecklist.checks` accept only `bachata:workspace-integrity`, `bachata:project-checks`, and `bachata:verifier:<id>` descriptors declared in `.bachata/verifiers.json`; a model selects a descriptor id and never writes a command. Arbitrary shell and package-script wrappers are rejected before launch.
- A verifier descriptor fixes its executable and argv in the repository. Shell and process wrappers are refused by name, and a registry that fails validation is refused whole.
- Controller project checks invoke only fixed, bounded executables and Bachata's pinned TypeScript compiler with an allowlisted environment. They do not use the user-selected login shell or a repository-local compiler executable.
- Verification has a timeout and output cap.
- Verification and related controller commands use a process scope. Windows uses a kill-on-close Job Object. Supported POSIX systems combine the original process group with an inherited random scope token so new-session descendants are found before resources are released.
- Local Claude Code and Codex transports use the same POSIX group and token cleanup. Windows provider transports retain `taskkill /T`; the command-runner Job Object guarantee does not apply to those transports.
- POSIX token tracking is not a kernel sandbox. A deliberately hostile descendant can attempt to remove the marker and daemonize; untrusted-code isolation requires an external operating-system or container boundary.
- Unsupported process-scope inspection or uncertain cleanup fails closed and quarantines declared physical resources.
- Controller-owned checks acquire shared resources atomically before the process starts.
- Task models do not own acceptance, integration, E2E, database, Docker, browser, or other protected checks.
- Unattended orchestration rejects Claude `bypassPermissions`.
- Verification runs in a disposable standalone repository made from the exact pending snapshot.
- Source branch, HEAD, index, and worktree state are checked before and after verification.
- Controller-owned verification is not a general repository command runner. Interactive commands outside autonomous orchestration remain the user's responsibility and are not represented as autonomous verification evidence.
- Physical resources are quarantined when process termination or cleanup cannot be confirmed. See `CONCURRENCY.md`.

## Browser-requested actions

- Workspace reads, listings, and searches ask by default.
- File mutations and destructive changes ask by default.
- Browser-requested arbitrary shell actions are disabled. Browser agents can use only the structured workspace action surface.
- Patch actions ask by default, enumerate affected paths through Git, reject unsafe paths, and pass `git apply --check` before mutation. Multi-file publication rolls back already-published paths on failure; an unverifiable rollback stops managed orchestration.
- Automatic workspace reads require explicit user configuration.
- The optional semantic interpreter is off by default and never gains execution authority.

## Git

- Task delta starts at the recorded baseline and includes staged, unstaged, deleted, and untracked files. If an external task agent creates a commit while no-commit mode is active, Bachata retains the file delta and rewinds the task branch before integration.
- Scope is checked before verification, after verification, and before integration.
- Task ancestry and branch ownership are validated.
- Failed integration restores the recorded integration tree. Autonomous orchestration never creates task or integration commits.
- Controller-owned TODO state cannot be changed by task models.
- Abandon removes only verified extension-owned task and integration worktrees and branches. Failed or uncertain cleanup retains the ledger, pointer, and exact resource metadata; it is never reported as successful. Retained-run cleanup removes only the selected validated completed integration resources. Both retain conversations.

## Interactions

- Every gate visit has a persisted occurrence identity.
- Recovery reuses only the exact pending occurrence and payload.
- Checklist content is persisted before selection.
- Semantic questions may fall back to Lead.
- Human-gate instructions are addressed to Lead explicitly.
- Secret drafts stay only in webview memory until submission.
- Secret input never falls back to another model.
- Timeout resolution is atomic.

## Browser transport

- loopback only;
- exact Chrome extension origin pinned at pairing;
- one-use pairing token;
- persistent connection token;
- strict schemas and byte limits;
- exact provider, tab, frame, document, and conversation binding;
- cancellable bounded provisioning;
- strict recoverable endpoint validation.

## Residual risk

Managed local-provider native writes bypass browser action envelopes. Git inventory does not
surface ignored paths, so an ignored native write may be absent from candidate and verification
evidence. Controller-envelope guards do not establish native-write coverage; EX-G6-09 remains open.

Provider CLIs, app servers, browser DOMs, and authenticated sessions can change. Run live provider smoke tests before stable release.

## Human-only E2E

The Extension Host E2E suite runs only after interactive human confirmation. It rejects CI and noninteractive terminals, uses isolated VS Code and workspace directories, and is not part of normal tests, prepublish, or packaging. It does not authenticate to providers.
