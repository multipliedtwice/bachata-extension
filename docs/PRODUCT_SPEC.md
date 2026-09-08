# Product spec

## Positioning

Bachata provides **human-directed agentic pipelines for software refinement** in VS Code. Independent agents challenge candidate work and converge artifacts or findings. Pairing and antagonistic convergence are mechanics. Human direction, accumulated refinement, and attention compression are product benefits.

Software engineering remains product focus. Custom pipelines may reuse same reasoning model for other problems. Dedicated vertical products are not planned.

Human owns goal, premise, and direction. Preset defines expected artifact, roles, challenge/revision method, escalation, and completion for one cycle type. Lead/Worker is common execution shape, not universal product semantics. Quality accumulates through accepted specifications, decisions, plans, changes, and corrections.

One pipeline cannot prove correctness, remove shared model blind spots, or detect a misdirected premise accepted by every model. Consensus and arbitration coordinate a run. Only human corrects direction. See [Product doctrine](PRODUCT_DOCTRINE.md).

**Current primary audience:** software builders who use LLMs for substantial work, need repeated refinement, and cannot supervise full output volume.

**Not the audience:** anyone expecting one prompt, one pair, or one consensus result to prove software correct.

**Out of scope:** hosting, deployment, accounts, central service, telemetry, and current-release CI/CD integration. Typed attention events may later gain external or CI renderers. Such renderers stay display-only and never enter model context.

## Product

Bachata runs Lead/Worker, independent-review, single-agent, and custom LLM pipelines inside VS Code. Breadth covers different refinement stages; it is intentional.

Product hierarchy:

- initiative: durable human problem or desired outcome;
- cycle: framing, research, proposal, critique, planning, execution, validation, review, debugging, or another goal-directed phase;
- pipeline run: one bounded execution inside cycle;
- artifact: cycle-specific candidate or accepted output.

One initiative contains many cycle types. One cycle may contain many fresh runs. A pipeline preset is reusable execution and convergence contract, not whole workflow. Finding set is one artifact type only. Others include hypothesis, requirement, recommendation, decision, model, plan, design, protocol, and patch.

Custom problem pipeline declares artifact, evidence expectations, roles, challenge/revision flow, escalation, and convergence. This generic escape hatch must not expand roadmap into domain-specific adapters or integrations.

The main view provides root-run tabs, searchable run history, child task chats, recent activity, pipeline selection and editing, image and bounded text attachments, iteration count, and immediate, queued, or interrupt delivery.

Runtime preflight validates the exact immutable execution bundle, capabilities, attachments, and recovery state before mutating run history or provider sessions. The bundle contains the parent pipeline and every enabled checklist task pipeline with normalized definitions, SHA-256 revisions, storage scopes, and one canonical bundle hash. Queued work, iterations, generated tasks, retries, top-level TODO task and Master work, and recovery persist those accepted identities. Rejected requests keep the draft.

## Human attention surface

Top-level view must show current initiative direction without transcript reading. It bubbles up only:

- accepted material outputs for current cycle, including actionable findings when applicable;
- direction-changing core decisions;
- material unresolved findings or disagreements needing human judgment;
- material assumptions;
- newly discovered material risks;
- irreversible actions;
- minimum evidence needed to judge;
- blocked choices no model can resolve from existing direction.

Raw Lead and Worker finding lists, rejected findings, challenge debate, routine chatter, repeated or resolved findings, successful mechanics, and raw output remain available in drill-down history.

Internal orchestration stays hidden until user asks for detail. Progressive disclosure preserves capability without spending human attention on routine mechanics.

Finding lifecycle applies only to finding-producing review and debugging presets. Initial findings are provisional competing hypotheses. Lead/Worker convergence assigns accepted, rejected, or unresolved disposition. Pipeline-accepted routine finding becomes actionable automatically, and routine fix may proceed under pre-authorized execution contract. No per-finding human ruling gate. Material unresolved finding, direction-changing choice, scope or acceptance change, ambiguous identity, or irreversible action bubbles to human. Lead role grants no truth authority. Later fresh review may reopen accepted or rejected disposition only with materially new evidence and visible delta.

Feature delivery may converge requirements, plan, implementation, and acceptance evidence. Product review may converge observations and recommendations, but direction-changing priorities require human resolution. Planning converges a plan and open decisions. Never force these artifacts through bug-list schema.

Single-participant finding remains single-source and provisional until later challenge/convergence. It is never bachata-accepted.

Core decision record contains stable subject, material question, options and tradeoffs, recommendation and evidence, affected scope, status, provenance, and human resolution. Status is `proposed`, `accepted`, `rejected`, `deferred`, or `superseded`.

Deduplicate by subject and scope. Repeated support updates history only. Materially changed recommendation, evidence, scope, or resolution supersedes prior decision and shows delta. Resolved decisions leave top-level view. Material new evidence reopens decision and shows what changed.

Within-run convergence resolves duplicate finding descriptions. Fresh discovery freezes before any cross-run comparison. Post-discovery reconciliation then maps final findings to prior stable identities. Clear matches merge automatically with provenance; novel findings receive new identities. Only ambiguous or materially conflicting mappings bubble to human. Prior findings and summaries never enter fresh discovery prompts.

Bubble-up notifications are session-lived human projection of typed controller events. Bell shows unread count; chat or activity view may show one concise line. Levels: `off`, `decisions only`, `material`, `all`. Controller generates text deterministically with zero extra LLM calls by default. Notification content never enters fresh reviewer prompts and never forms durable notification archive.

Offer `Discard` or `Restore` only for exact reversible retained work owned by controller. Otherwise offer `Inspect`. Never imply rollback for arbitrary direct workspace edits.

Human may inspect, reject, reopen, or restore semantic finding disposition from bubble or finding view. This changes semantic state, not arbitrary workspace bytes. Applied fix stays unverified. The only basis runtime records today is a later fresh review that no longer reports the finding, shown as model non-observation rather than verification. Accepted external evidence is recorded but performs no finding transition yet, and that gap is tracked in `TODO.md` under P2.

Direction, core-decision and notification views are implemented. The external-evidence transition gap above remains open. [Moderated validation](MODERATED_VALIDATION.md) must establish whether these views let a human hold direction without reading transcripts.

## Execution modes

Every workflow declares the authority it runs with.

- Review: read-only. No repository writes.
- Interactive implementation: writes reach the repository only through provider actions the user approves.
- Managed implementation: the controller owns write scope, path policy, verification, and the no-commit boundary.
- TODO orchestration: isolated unattended execution in per-task Git worktrees behind a strict preflight.

Setup currently states safety level of each offered workflow. Level follows pipeline definition: enabled `executeChecklist` means orchestration, `managedPolicy` means managed implementation, all read-only or plan-mode agents mean review, anything else means interactive implementation.

These modes are implementation mechanics. They must not dominate positioning or human attention. New restrictions need a concrete failure mode, user need, or platform constraint. Do not add friction for abstract safety value.

## Execution contract

Before execution, the controller resolves and shows one run contract for the selected pipeline:

- selected pipeline, providers, models, and the roles each provider can take;
- working directory, write scope, writable, readable, and protected paths;
- commit policy;
- controller-owned verification operations and the shared resources they require;
- run limits: iterations and iteration mode, provider turn, managed task, and browser operation deadlines, managed revision cycles, task retries, task concurrency, the maximum consensus rounds per consensus step, and the worst-case number of participant turns for the whole run;
- provenance: the extension version, the SHA-256 of the exact pipeline definition, and per provider the resolved model and detected runtime version, or an explicit `unreported` when either is not known;
- provider fallback order per role, including optional managed roles;
- human decisions that will interrupt the run;
- completion criteria;
- unresolved readiness findings for the selected providers.

`Bachata: Run TODO.md` resolves the same contract for unattended orchestration — repository, tasks, task and Master pipelines, writable paths, task and final verification, concurrency, retries, commit policy, isolation, human decisions, and completion — and starts only after explicit confirmation. A preflight blocker stops the command before any branch, worktree, or provider session is created.

## Control boundary

Human provides intent and direction. Cycle preset defines roles and artifact. When Lead/Worker applies, Lead converts direction into work, reviews Worker output, and escalates material decisions; Worker investigates or implements. Models provide requirements, recommendations, plans, code, candidate findings, candidate decisions, and evidence. Neither role is presumed correct.

Deterministic code owns step order, timeouts, permissions, dependencies, scheduling, scope, verification, Git integration, rollback, cleanup, and completion. An embedded `executeChecklist` flow performs its Git preflight before any provider turn. It may exempt only its active custom-pipeline catalog from the clean-tree requirement; top-level TODO orchestration remains fully strict.

Automatic finding reconciliation is semantic state handling, not Git integration. Bachata never merges Git branches automatically. Human explicitly applies accepted retained work; Bachata stages selected work without commit, merge, rebase, tag, or push.

Deterministic ownership keeps execution coherent. It does not establish product direction or correctness. Restriction is subordinate to refinement quality and human attention.

Built-in TODO work uses Lead and Worker. There is no default Reviewer. Master receives compact execution state only and cannot schedule or mutate work. Custom pipelines may add roles.

## Workspace ownership

One Extension Host is the authoritative mutable Bachata writer for a workspace. It may run several conversations and managed tasks. A second host for the same workspace fails closed before opening catalog, transcript, pipeline, or orchestration writers. Separate workspaces still coordinate shared Bachata, provider, Git, check, and Browser Bridge resources through the global broker.

Resource acquisition is bounded. A conversation waiting for capacity exposes an explicit waiting state and Cancel wait control. Cancellation guarantees that the request cannot start after capacity returns.

## Runs and history

Active root runs appear in tabs. Terminal and retry task chats remain under their root run.

Archive and Delete operate on the complete run tree. Archived runs remain searchable and open as read-only history. Unarchive restores the tree before any mutation or continuation. Duplicate creates an independent root run.

Routine workflow progress persists as typed internal state, not generated repository specs or reports. Normal task-required project documents remain allowed.

Fresh independent review receives current repository context and current human direction, not prior LLM summaries, notification prose, or PR-facing LLM handoff. Human evidence export remains available. Post-discovery reconciliation may inspect prior structured findings only after fresh output freezes.

Full provider output stays with the provider session. Bachata keeps a minimal provider conversation locator and compact typed evidence, and states per run whether that history can be reconstructed on demand: `available`, `unavailable`, or `unknown`. It fetches nothing eagerly. No durable full-output snapshot or unlimited response cache. Export strips provider locators, and a browser conversation keeps only its origin.

## Pipelines

Structured and JSON modes edit the same validated definition. Supported fields include agents, roles, participants, prompts, capabilities, permission mappings, typed outputs, unanimous or Lead-arbiter consensus, terminal policy, checklist scope, checks, retries, and concurrency.

A pending editor operation locks the complete draft, including nested controls, drag ordering, Escape, and every close path. Validation or file-operation results therefore apply to the exact submitted snapshot.

Custom pipelines are root-scoped by canonical physical workspace root while retaining the original VS Code root for display. Every mutation acquires manager serialization, profile-wide ownership keyed to the physical catalog, and a token-checked filesystem lock that also covers separate local VS Code profiles. The final file commit is conditional on the exact prior content. External file events refresh open runs. Editing carries the exact source ID, scope, and expected SHA-256 revision. Stale mutations fail instead of overwriting another run or profile. New and imported drafts use create semantics and cannot replace an existing ID. Import validates a file into an unsaved draft; it does not persist or select anything by itself. Pipeline selection must finish before Edit or New becomes available.

A root catalog must remain inside its canonical workspace root. Pipeline files must be regular files named exactly `<pipeline-id>.pipeline.json`. A symbolic, misnamed, duplicate, invalid, or built-in-colliding entry blocks the complete custom catalog until the conflict is resolved.

A run with durable work keeps the immutable execution bundle it accepted even if the catalog changes. Every enabled checklist task pipeline is resolved from the same scope before any provider starts; missing, invalid, nested, or scope-mismatched dependencies fail preflight. Generated tasks and retries use the stored child snapshot, while top-level TODO work persists exact task and Master snapshots before model or worktree activity. Clean runs refresh to the current root-scoped definition, and direct execution revalidates the selected custom file immediately before acceptance. Legacy queue, recovery, or orchestration state without required verifiable snapshots fails closed rather than substituting current definitions.

A configured workspace pipeline root is valid only while its canonical identity remains in the current workspace-root set. Removing the selected root clears its working directory and catalog scope. A multi-root run cannot submit until a valid root is explicitly selected, and Duplicate does not copy a removed root or its custom selection.

Arbiter decisions render as a dedicated Lead’s Final Ruling card with the selected candidate, Lead identity, objections and dispositions, unresolved risks, and navigation to participant output.

Consensus and arbiter output are one-run coordination records. Agreement must never be rendered as proof of truth, absence of shared blind spots, or correct product direction. Material ruling choices feed core decision lifecycle; routine rulings stay in history.

## Interactions

Questions, permissions, human gates, secrets, and checklists stay attached to the correct run.

Permission and human-gate submissions require exactly one valid choice. Questions require a valid choice or allowed free text. Secrets require nonempty input. Execution checklists may explicitly continue with no selected work.

Secret drafts stay in webview memory until submission. Persisted deadlines are authoritative; countdowns are display-only. Interaction and approval cards lock immediately after submission, and duplicate responses are idempotent.

## Attachments

Supported attachment type, per-file size, count, and total bytes are checked before base64 encoding. Images are `.png`, `.jpg`, `.webp`, and `.gif`, matched against their magic bytes. Text is `.txt`, `.log`, `.md`, and `.json`, and must decode as UTF-8 with no NUL byte. Providers receive text as a text content block, never as an image. Attachments cannot be added to archived runs.

## Iterations and queues

Iterations run sequentially with fresh participant chats. Later iterations see repository state left by earlier iterations. Failure stops later iterations.

One configured iteration series remains one pipeline run. Initiative loop also needs separate fresh top-level cycles against updated state and evidence. Current software adapter includes review and debugging cycles against current codebase. Fresh cycles should not inherit prior confidence. Neither iteration completion nor `until clean` means quality achieved.

Bachata may report review saturation only as facts: fresh comprehensive reviews found no new material issues, prior material findings are resolved or accepted, core decisions are closed, and required checks are current. Default signal may appear after two quiet fresh reviews. It never proves correctness, auto-closes, requires another review, or restricts human stop or continue choice. Factual copy: `Two consecutive fresh reviews found no material change. Continue or close the cycle.`

Queued work remains bound to the pipeline and iteration count selected when queued. Prompt history is recorded once.

Completed TODO runs retain their integration worktree and branch for inspection. Every retained run remains independently revealable after extension restart or after later TODO runs replace the active run. Cleanup is available when no TODO mutation is active and preserves conversation history.

## Browser Bridge

Protocol v9 binds explicit ChatGPT and Claude conversations. The Browser Bridge has no filesystem or shell access. Browser-requested local actions are validated by the extension and require configured approval.

## Source delivery

Source archives exclude `dist/`, `node_modules/`, coverage output, generated artifacts, and VCS metadata.

## Human-only E2E

Only a human may start the Extension Host E2E suite. AI assistants, coding agents, CI, prepublish, packaging, scheduled jobs, and automated review systems must never invoke it.

The suite must remain outside automated scripts, reject CI and noninteractive terminals, use isolated VS Code data, and avoid authenticated provider actions.
