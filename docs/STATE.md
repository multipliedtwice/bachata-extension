# State and history

State serves accumulated solution refinement and human attention compression. Problem-general model must preserve initiative, cycle, pipeline-run, artifact, evidence, current direction, and material decision history across fresh runs without forcing transcript replay. Current storage implementation is software/workspace scoped. See [Product doctrine](PRODUCT_DOCTRINE.md).

SQLite is the local deterministic catalog. One authoritative Extension Host owns mutable state for a workspace; a second host fails closed before creating catalog, transcript, pipeline, or orchestration writers.

```text
runs
iterations
pairs
bachata_assignments
chats
steps
attempts
interactions
checklist_items
structured_outputs
resources
events
schema_migrations
```

## Initiative state is local to this workspace

Initiative, cycle, artifact, decision, external evidence, finding history, and round state live in the local SQLite catalog under this VS Code installation's extension storage for this workspace. They are not stored in the repository, not synchronised, and never leave this workspace unless you explicitly export an initiative bundle (see below).

- Initiative state is local to this VS Code workspace and storage identity.
- Moving, renaming, or re-cloning a repository to a different path can require a new initiative, because the repository identity is derived from the canonical repository path.
- Bachata does not claim portable or repository-backed initiative history.
- An initiative can be exported to a JSON bundle and imported into another workspace. Import always creates a **separate** initiative: Bachata remaps every id and does not combine or synchronise initiative state. This boundary is unrelated to automatic finding reconciliation and Git integration.
- Import does not carry verification, retained worktrees, run transcripts, or run bindings. Recorded checks describe a repository candidate the importing workspace does not have, so they are dropped and the imported cycles start unverified. Import carries the initiative, its cycles, artifacts, decisions, external evidence, finding history, rounds, finding merges, and fix-run links.
- Export is filtered by `.bachata/export-policy.json` like every other Bachata export, previewed in an editor, and written only after you confirm.
- Post-alpha work is tracked in [Roadmap](ROADMAP.md).

Bounded execution state for model turns, kept apart from the audit plane, is designed in [Bounded execution state](BOUNDED_EXECUTION_STATE.md). It is a design only; nothing in it is shipped or on by default.

## Stored state

Bachata stores provider bindings, compact previews, typed outputs and hashes, interaction state, exact pending checklist items, immutable parent and task pipeline snapshots with revisions and scope, execution-bundle hashes, workflow checkpoints, task resources, exact Master snapshots and checks, and Git bindings.

Provider sessions remain full conversation history. Durable Bachata state keeps only minimal conversation locator when provider exposes one: adapter/provider identity, provider session or conversation id, role, last-seen state, and reconstruction capability. Each run states whether its provider history can be reconstructed. A local CLI session Bachata can resume, and a browser conversation the Bridge can reopen, report `available`; a session with no recorded locator reports `unavailable`; an adapter Bachata cannot judge reports `unknown`. Bachata fetches nothing eagerly and stores no provider transcript of its own.

No new durable full-output or evidence snapshot exists. Compact typed outputs, provenance, hashes, and bounded operational transcript or recovery data remain. Raw response data may exist while active or resumable step needs it. No silent unlimited cache. Exports strip provider locators and credentials.

Bubble-up notifications remain session-lived and are not durable history. Durable typed events may regenerate current attention state without storing notification prose.

Routine workflow progress stays in typed local state. Bachata does not generate repository specs or reports for state tracking. Normal project documents remain allowed when user or task asks for them.

Product-level decision projection must persist stable subject, affected scope, current status, provenance, human resolution, supersession chain, and reopening delta. Routine output remains run-local history. Repeated same-subject findings do not become duplicate top-level decisions.

A run also persists the settings it executed under. Settings are classified by where they are read: values read through the runtime's one configuration accessor are pinned and restored on resume and replay; settings read at activation time or by the orchestrator are recorded for evidence but never restored; approval, permission, provider-enablement, executable and credential-destination controls are recorded and never restored, so withdrawing one takes effect at once; presentation and admission limits are neither. A snapshot that arrives from a file is rebuilt from Bachata's own declarations before it is applied, against the same contract the settings UI enforces — declared type, declared enum, declared bounds — and every refusal — including a pinned value the snapshot omits — is reported by name rather than dropped in silence. Only pinned values are restored: authority controls, recorded-only settings and the secret-reference list are rebuilt from live settings when a run begins, so a snapshot written elsewhere cannot weaken a control or make a run record another run's configuration as its own. Authority is re-read at every step boundary, so a control changed mid-run is published as it now stands. A snapshot carried in by a replay stays the source run's evidence and is stored in its own column, so an unstarted replay still executes on the values it was created with after a restart. A stored snapshot Bachata cannot fully apply is disclosed — in the run's transcript on resume, and as replay drift on import — never resumed on live values in silence. No credential value is ever recorded: settings that name an environment variable record the name only.

External evidence is a fourth durable record kind, separate from artifacts and decisions. An artifact is something a run produced; a decision is a judgment a run leaves to a human; external evidence is a claim from outside this repository that Bachata records so it can be ruled on. It persists its source (uri, title, publisher, retrieval time, and the SHA-256 of the copy the claim was read from; Bachata stores the fingerprint, never the copy), who authored the record, the claim, the relation it asserts (`supports`, `contradicts`, `qualifies`), the artifact, decision, finding or initiative it is claimed against, the authority behind it, an optional freshness horizon, participant challenges, and the same proposed/accepted/rejected/deferred/superseded lifecycle every record uses. Its identity is (source, claim target), so the same document cited against two targets is two records. Re-retrieving the same bytes changes nothing; different bytes mint a revision that supersedes the previous one. A predecessor a human has ruled on keeps the state that ruling put it in and still stops being current, so one claim never has two current records; a record that is no longer current accepts no further challenge and no further ruling. A record past its freshness horizon is reported stale and never silently dropped, and a run recorded before this kind existed reads back with no external evidence rather than with a guess.

Finding state also persists stable identity, subject, scope, evidence, challenge, `accepted` / `rejected` / `unresolved` disposition, provenance, reconciliation aliases, and reopening delta. Raw proposals never become actionable state. Rejected findings remain history. Material unresolved findings remain visible. Fresh discovery freezes before post-discovery reconciliation maps clear matches to prior stable identities. Ambiguous or materially conflicting mappings alone need human judgment.

Archived runs remain searchable and open read-only. Transcript paging and export stay available; rename, interactions, attachments, pipeline changes, and execution require unarchive.

Per run, Bachata retains at most:

- 5,000 events;
- 1,000 structured outputs;
- 1,000 handled interactions;
- 2,000 completed attempts.

Run metadata and unhandled recovery state remain until the run is deleted or abandoned. Full transcript export is explicit.

## IDs

Entity references use one type prefix plus eight generated characters from a restricted alphabet.

```text
R7K3M9QAB  run
I4F8X2DPT  iteration
P6Q2W7MAF  Bachata
C9D3K8AFT  chat
S5N7Q2BXM  step
Q8M4W6KRT  interaction
A3H7P9DXM  attempt
```

Titles:

```text
[R7K3M9QAB] Review src/jobs
[bachata:R7K3M9QAB:C9D3K8AFT] Lead · Review src/jobs
```

SQLite bindings are authoritative. Titles are human labels.

## Interactions

An interaction key identifies one occurrence, not one pipeline step forever.

- Restart recovery reopens the exact unresolved occurrence.
- A deliberate revisit creates a new occurrence.
- Resolved occurrences are consumed once.
- Checklist items and selected state are stored with the interaction.

## Recovery

Stopped and failed TODO runs retain their ledger, integration binding, task state, and provider references. Completed TODO ledgers remain discoverable as retained Git resources until the user cleans up that exact run.

Resume validates workspace ownership, Git repository identity, branch and worktree ownership, task shape, dependencies, retries, and persisted checkpoints before mutation.

Interrupted pipeline resume is manager-owned. It reopens the same catalog iteration and pair, restores the exact validated execution bundle and storage scopes, restores step and output routing after restart, finalizes the resumed iteration, then continues any remaining requested iterations. Changed or deleted parent and task catalog definitions cannot replace the recovery bundle. TODO ledgers persist exact task and Master snapshots, and retries reuse the same task snapshot. Legacy recovery or orchestration state without the required verifiable snapshots fails closed and writes a durable warning. Post-acceptance setup failures finalize catalog and visible state instead of leaving a running iteration behind.

Resume continues same run. It is not a fresh review. New top-level review or debugging run inspects current codebase independently, then compares its material findings with prior decision and finding history.

Abandon closes orchestration conversations, removes verified owned worktrees and branches for the active or recoverable run, clears the active pointer, and marks the run abandoned. Retained cleanup removes only the selected completed run’s verified integration worktree, branch, and ledger. Conversation history remains. If recovery state is corrupt, destructive abandon is refused. The pointer and unverifiable Git resources remain for explicit inspection instead of being silently discarded.
