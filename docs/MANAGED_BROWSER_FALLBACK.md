# Managed browser fallback

## Purpose

The managed browser path lets ChatGPT, Claude Browser, or a Generic Browser session continue repository work under a deterministic local controller. Each bundled managed pair uses independent Worker and Lead conversations. Local Claude Code or Codex are separate first-class developer authorities and may run directly or as the primary participants in the TODO pipeline.

This is one refinement pass inside [product quality loop](PRODUCT_DOCTRINE.md). Lead reviews Worker and may request correction. Neither Lead approval nor controller verification proves product direction or removes shared blind spots. Human owns direction; later fresh sessions review updated codebase again.

The selected pair working root is authoritative. A folder path written in a prompt can guide retrieval but cannot change the trusted root or escape it.

## Responsibility split

The selected Worker/Lead own software reasoning for this pass. In browser mode they use controller-owned structured actions. In task-scoped local Claude Code/Codex mode they use provider-native reasoning and file tools under deterministic path policy, disabled autonomous shell/network authority, no-commit enforcement, and a post-turn Git audit. The local controller owns role state, provider routing, repository truth, context retrieval, source hashes, read/write scope, guarded execution, verification, and retry limits.

The Worker requests context, dependency/dependent information, or one bounded guarded mutation at a time, requests declared verification checks, responds to Lead objections, and returns an explicit terminal state.

The Lead independently receives the original task and current repository evidence. `managedRole: "lead"` forces controller-side read-only behavior even if prompt text or browser output asks for a mutation.

Lead bubbles only direction-changing decisions, unresolved disagreements, material assumptions, and new material risks. Routine corrections and successful mechanics stay in run history.

A lightweight local Qwen/Bonsai/DeepSeek model is optional. Valid structured browser control bypasses it. For malformed prose it may only select controller-created list/read/search/dependency/dependent candidate IDs or abstain. It cannot create paths, arguments, commands, patches, selectors, permissions, provider routes, state transitions, or completion decisions.

## Flow

```text
prepare Worker handoff
Worker context / patch / declared verification
Worker done
Lead review
zero to configured bounded Worker revision cycles
Worker verification / done
Lead review after each requested revision
finalize or block
```

The state machine refuses a Lead turn while the controller is in a Worker state and refuses a Worker turn while it is in a Lead state. Required verification IDs must pass before the Worker can hand off or a clean Lead decision can finalize.

## Repository context

Initial context builds a bounded lightweight inventory of supported source/text files under the configured read scope while retaining full file content only inside separate resident file/byte budgets. Explicit file or directory paths in the user task are first-class retrieval seeds; files below an explicit directory outrank generic token matches. Local TypeScript/JavaScript imports and re-exports are followed for bounded dependency depth, and an eligible dependency can be promoted from the nonresident inventory when it is needed. Cache size/mtime checks are bounded by the same indexing deadline, and provider-bound snippets are content-hash refreshed before handoff. Initial handoffs remain byte-bounded and full-file snippets include SHA-256 evidence.

Managed `needContext` requests may also:

- read an existing snippet by ID;
- search resident and omitted eligible files under controller-enforced path, byte, per-file, and elapsed-time budgets, continuing with an index-revision-bound cursor when needed;
- stream one readable directory forward with cursor/limit pagination without materializing or sorting the whole directory;
- request a bounded recursive `context.tree` with depth, entry, byte, deadline, cursor, scope, and symlink limits;
- read one readable text file or line range; full reads carry a full-file SHA-256, while ranged reads carry only range-scoped hash evidence and require an explicit `context.hashFile` action before that hash can authorize a mutation;
- request local `context.dependencies` for imports/re-exports and paged `context.dependents` for reverse importers.

Inventory, resident candidate examination, directory/tree listing, omitted-file search, dependency scans, hashing, and refresh paths are cancellation-aware and separately bounded. `writeScope: "task"` derives its default mutation boundary from explicit task paths and fails closed when none can be resolved. `writeScope: "workspace"` is the only explicit whole-workspace form. `readPaths` remains independent: when it is not configured for a task-scoped run, Bachata expands initial reading to the nearest containing project/package while retaining the narrower write scope. This lets a task write only `src/routes/**` while reading controllers/services elsewhere. Every mutation attempt invalidates and refreshes affected context before the next browser round, including a failed attempt.

Selected text/code attachments are consumed locally and inserted into every managed Worker/Lead handoff. Supported images are sent through the browser adapter. Unsupported attachment types fail explicitly instead of disappearing from later turns.

## Managed control

Every managed browser response ends with one `bachata-control` block using protocol `bachata-browser-turn-v1`.

Each envelope has one operation class:

- `needContext`: one or more context actions;
- `applyPatch`: exactly one guarded `workspace.applyPatch`, `workspace.write`, or `workspace.delete` mutation;
- `verify`: exactly one declared verification request;
- `done`, `reviewComplete`, or `blocked`: no actions.

Malformed control gets one repair attempt. Managed execution never falls back to mutation-by-prose.

Existing-file patch/write/delete operations require exact controller-verifiable SHA-256 values. New files use `workspace.write` without an existing-file hash. Typed controller failures such as `STALE_FILE`, `PATH_OUTSIDE_READ_SCOPE`, and `PATH_OUTSIDE_WRITE_SCOPE` let the browser recover without interpreting error prose. The workspace executor obtains authoritative affected paths from `git apply --numstat -z`, supplements rename/copy preimage sources from decoded Git headers, applies task-scope and restricted-path checks to the complete set, verifies every existing source hash, and only then runs `git apply --check`. Publication is transactional across the full patch: if any file cannot be published, already-published files are restored and patch-created empty parent directories are removed when their filesystem identity is unchanged. If rollback cannot be verified safely, managed orchestration stops instead of continuing from uncertain workspace state.

Managed repository evidence is relative to an immutable task-start baseline. Pre-existing dirty files remain visible as pre-existing state and are not attributed to the Worker unless they change during the task. Context handoffs also report index coverage, including file-limit truncation and skipped large or unreadable files. Large metadata collections are serialized under bounded per-field coverage records with total/included/omitted counts instead of consuming the whole handoff. A truncated original task is continued with `context.readTask` UTF-8 byte paging, and omitted handoff metadata is continued with `context.readMetadata` field/item paging, so local size limits do not discard authoritative task state. Inventory is first bounded to the task-derived read roots and nearest containing project/package. If that scoped inventory remains incomplete, autonomous managed mode fails closed before provider work and reports whether the cause was the file cap, inventory timeout, ignore-file count bound, or ignore-file byte bound; remediation is specific to that cause. Resident-index truncation remains incrementally recoverable through bounded search/read actions, and the handoff forbids whole-repository conclusions while that recoverable resident coverage is incomplete. Repositories with an unborn Git `HEAD` are supported by using the index/staged state as the baseline.

## Verification

Managed pipelines declare verification IDs in controller-owned configuration. Autonomous execution accepts only `bachata:workspace-integrity` and `bachata:project-checks`; arbitrary repository commands, package scripts, and shell wrappers are rejected before process launch. Browser models receive only IDs in the handoff and cannot supply or alter command text. The normalized ID/command plan is hashed into the managed checkpoint. `protectedPaths` can additionally make evaluator, policy, or other immutable task paths readable but non-mutable for both managed and passive browser workspace actions.

Workspace integrity refreshes repository evidence against the immutable task-start baseline and fails on out-of-scope, restricted, generated, symlink, or HEAD changes. Controller project checks apply bounded controller-selected syntax and type checks to changed files; TypeScript uses Bachata's pinned compiler rather than a repository-local executable. Both operations share the managed absolute deadline and process-cleanup fence. Verification evidence is bound to the exact task policy, repository baseline, changed-file hashes, and verification-plan hash; resume invalidates evidence that no longer matches. Missing, skipped, stale, or failed required checks prevent Worker handoff and clean Lead acceptance.

## Managed execution bounds

One absolute managed-task deadline is created at the Worker start and persisted in the Worker/Lead checkpoint. Lead review and bounded Worker revisions reuse the same deadline instead of receiving a fresh full provider timeout. Context preparation, browser turns, controller actions, selector recovery, mutation, and verification all share cancellation from that deadline. Expired checkpoints require a fresh Worker start.

Controller-result continuations are serialized under one local byte ceiling. Individual file/search previews are reduced before serialization, repeated snippet IDs are deduplicated, and omitted results must be requested again in smaller batches or narrower ranges. The Browser Bridge transport limit is not treated as a model-context allowance. These bounds are ephemeral execution controls and are not stored as usage measurements or reported externally.

## Commit policy

The bundled GPT Bachata uses `commitMode: "never"`. The managed browser protocol exposes no arbitrary shell action, so a browser model cannot invoke Git commit operations through that path.

The older TODO/worktree orchestration also honors the managed no-commit policy. It carries accumulated integration state as referenced Git tree objects, not task or integration commits. Restart and rollback restore the persisted tree. If an external task agent creates a commit anyway, Bachata rewinds the task branch to its baseline while retaining the working-tree changes before integration.

Autonomous pipelines accept only `commitMode: "never"`. Interactive local-developer use may operate in the user's existing workspace, but Bachata does not create commits, merges, rebases, tags, or pushes for the task.

## Local model

Optional semantic interpretation supports LM Studio and Ollama. Requests are serialized through a bounded queue with timeout and cancellation. Model output is JSON-repaired once, schema validated, restricted to supplied candidate IDs, and converted only into list/read/search/dependency/dependent context operations. Unknown, overlapping, incomplete, or malformed classifications become abstention.

Valid managed `bachata-control` output bypasses local semantic interpretation entirely. If a managed browser response instead contains ordinary prose that deterministically yields list/read/search/dependency/dependent candidates, the local model may select only those candidate IDs; the resulting context requests still pass through managed scope, secret, symlink, and size checks. If it abstains, the browser receives one bounded control-repair request. The local model never advances Worker/Lead state or produces mutations.

## Provider resources and fallback

Physical agents may share a `resourceId`. The primary bundled browser fallbacks use `chatgpt-browser:default-account`, while the additional explicitly bound Generic Worker and Lead candidates use `generic-browser:default-origin`; submissions sharing either resource are serialized.

Provider-resource queues are bounded. The bundled Codex and Claude agents have explicit provider resource IDs, and their adapters classify quota/auth/rate/unavailable/timeout failures before the generic resource wrapper while tracking whether meaningful output or tool interaction occurred. Eligible no-side-effect failures can open the shared resource circuit and use the alternate agent; ambiguous failures after provider activity are not replayed blindly.

The bundled TODO Bachata starts with Codex Lead and Claude Worker. Browser fallback conversations are provisioned lazily only after the corresponding CLI participant reports an eligible no-side-effect provider failure. Each role tries its ChatGPT Browser candidate first and can continue to an explicitly bound Generic Browser candidate, such as Grok or Z.AI, after another eligible no-side-effect provider failure. Lead and Worker have distinct browser fallback agent identities, and a fallback candidate reserved by the opposite role cannot be reused. Browser fallback inherits separate read/write scopes, no-commit policy, workspace mutation fence, and SHA-256 stale-write preconditions. Every managed task, including ordinary UI-started tasks, opens a fresh Worker conversation and a separate fresh Lead conversation once per task; bounded revisions reuse only that task/role conversation. Generic fresh sessions must re-attest verified Send, lifecycle completion, interruption, and conversation state.

## Repeated improvement

Run execution supports fixed iteration counts and bounded `untilClean` convergence. `untilClean` always keeps a hard maximum iteration count and requires the configured number of consecutive completed iterations whose controller-observed repository fingerprint did not change. A Lead/model statement that the work is clean is not itself a convergence signal. When repository-change evidence is unavailable, the controller does not guess that an iteration is clean and continues until the hard maximum. Fresh provider sessions are requested between iterations. Built-in ChatGPT/Claude browser agents recycle only their previously bound tab into the provider fresh-chat entry route when possible. Generic providers reuse their persisted bound identity, activate the validated New Conversation control, and proceed only after the bridge observes fresh-conversation evidence; otherwise the iteration fails closed.
