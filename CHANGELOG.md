# Changelog

## Unreleased — Self-improvement: one command reproduces the Codex-to-Claude workflow

Initial remediation has local regression coverage. Final safety follow-up awaits broad
regression gates. Dependency fixes use registry audit evidence.
Live provider and packaged UI acceptance remain separate release gates.

### Added

- `Bachata: Improve This Project` runs the whole loop from one command. With an executable TODO it runs that TODO unchanged and never rewrites your file. Without one — missing, empty, or refused by the executable parser — the existing file becomes audit context and discovery runs first: the run worktree is prepared, Codex and Claude audit that one immutable candidate tree independently and in parallel from the same prompt, neither sees the other's first pass, and only then do they cross-check every claim against the paths it cites. A claim the source does not support is dropped, a claim the repository cannot settle stays unresolved and never becomes a task, and a judgment a human owns becomes a named blocker that stops the run before implementation. The controller consumes the exact accepted convergence candidate — no agent is asked to restate it — validates it, renders an executable TODO, and parses that back with the same parser `Bachata: Run TODO.md` uses. A plan that cannot round-trip never reaches a worker. The generated TODO and the parsed plan are persisted in run state, execution starts without a second Start action, and the generated TODO is part of the retained result. `tests/selfImprovement.test.cjs`.
- A local CLI revision loop, owned by the controller rather than declared and unimplemented. Per task: Codex plans, Claude implements, the controller runs the declared checks, and only then does Codex review — receiving the exact diff, the changed files, the check commands with their exit codes and output, the worker's report, and the candidate tree identity. The review answer is machine-readable accept, or reject with bounded actionable defects. A rejection buys one bounded revision by default (`bachata.improveMaxRevisionCycles`); Claude receives the full review and revises in the same worktree, the checks rerun, and Codex reviews once more. Only a check-passing, lead-accepted candidate integrates. An exhausted budget fails the task, records both reviews, and integrates nothing. `tests/selfImprovement.test.cjs`.
- One workspace-level approval lets an Improve run start the commands `.bachata/verifiers.json` declares. `Bachata: Run TODO.md` still refuses every descriptor, approved or not. The approval is read from VS Code workspace state on every run and resume and never from a run ledger, so a hand-edited ledger grants nothing. It records that a human accepted these executables; it is not proof they are safe, and Bachata says so. Direct known E2E forms stay refused on the resolved plan even under approval. `tests/selfImprovement.test.cjs`, `tests/humanE2ePolicy.test.cjs`, `tests/verifierRegistry.test.cjs`.
- Four presets carry the workflow: `self-improvement` (Codex plans, Claude implements), `self-improvement-discovery` (two independent audits, then arbiter-ruled convergence on a validated task plan), `self-improvement-review` (Codex returns a structured verdict), and `self-improvement-revision` (one bounded Claude revision). All four are gate-free and safe for unattended execution. Settings: `bachata.improvePipeline`, `bachata.improveDiscoveryPipeline`, `bachata.improveReviewPipeline`, `bachata.improveRevisionPipeline`, `bachata.improveMaxRevisionCycles`, `bachata.improveBaselineFailures`.

### Fixed

- Manager shutdown prevents delayed baseline reads from publishing through a closed catalog.
- Codex file approvals read proposed paths from the matching file-change item, including
  rename targets. Valid approvals reach the UI; stale, foreign and out-of-scope proposals
  are refused. Scoped approvals apply once and recheck path scope after the user responds.
- POSIX provider cleanup reaches descendants that retain the inherited scope token after leaving
  the original process group. Both provider adapters use scoped cleanup; Windows boundary unchanged.
- Controller workspace actions refuse Git-ignored targets before mutation. Later-hidden task changes
  remain blocked across verification and restart; exact baseline reverts remove false change evidence.
  Native local-provider ignored writes still need coverage policy (EX-G6-09).
- Orchestrator retains unexpected task-operation errors when a sibling settles at the same time,
  then drains active work before closing the failed run.
- Model requests reject redirects before forwarding prompts. Remote semantic interpretation now
  honors explicit opt-in; configuration and transport failures remain visible. Selector healing
  stays loopback-only.
- Streaming transcripts keep a bounded visible window while preserving explicitly loaded history
  capacity and the older-history control.
- Doctor links to official Codex and Claude documentation. Bridge download URL still needs owner
  identity.
- Patched transitive `fast-uri` and `qs` advisories without changing direct dependency ranges.
- Independent discovery could complete without a second audit ever happening. The audit prompt advertised the logical repository root while the agent's session was rooted at the checked-out candidate, so one participant's every read was refused; the step was untyped, so "no audit possible" counted as completion and convergence proceeded on one audit. The prompt now names the checked-out tree as the one thing to read and marks the logical root as identity only; the audit step returns a validated record of what was read before what was found; and the controller gates on those records before convergence exists. An agent that reports it could not read the candidate, or cites no path it opened, stops discovery before convergence and before any worker. Discovery and convergence are separate pipelines so the gate is the controller's, not a step ordering inside one run. Each audit record is persisted on the run, so the claim that two audits happened can be checked afterwards instead of taken on trust.
- A missing configured TODO produced `BACHATA_IMPROVE.md` instead of the file the human asked for. A configured TODO that does not exist is now generated at that exact path; one that exists but is not executable is preserved untouched and the plan goes to `BACHATA_IMPROVE.md` beside it. The chosen path is recorded on the run.
- Completed generated tasks stayed unchecked: the ledger said done while the generated checklist still said `[ ]`, so an applied result understated itself and a resume had no file-level record. The generated checklist is now controller-owned like a TODO file — each accepted, integrated task is checked off in it, a worker that edits it fails its own task, and a resumed run reads it to know what is already done. `generatedTodo.source` stays the immutable plan as accepted; the file in the tree is the live checklist.
- Improve could not run on a dirty checkout. It skipped the working-tree seal that `Bachata: Run TODO.md` offers and asked readiness for a clean baseline, so the repository Bachata is normally asked to improve was refused. Both commands now share one seal.
- The generated plan existed only in run state. It is now written to `BACHATA_IMPROVE.md` in the run's integration worktree and committed there, so it is part of the retained result and reaches the human through Apply. The name is dedicated: an Improve run that generated a plan is exactly the run whose workspace TODO is missing or not executable, so Bachata never writes over the file already there.
- Resume could restart a run that had stopped on a human-owned decision: it cleared the error, reset the tasks, and began execution. A run carrying unresolved blockers now refuses to resume and names them.
- A plan that was nothing but a human-owned decision was thrown away. Zero tasks plus a named blocker now persists as a blocked run carrying the question, rather than failing startup and losing it.
- A generated `bachata:verifier:<id>` was checked for syntax only, so a descriptor the repository does not declare — or one this workspace has not approved — failed after the worker had already implemented the task. Both are now checked against the candidate tree before rendering. Evidence paths are checked the same way: a path the candidate does not contain is not evidence.
- A lead review that answered `accept` while still naming defects was integrated. Reject-without-defects was already refused; accept-with-defects is now refused too, so Bachata never integrates work its own reviewer flagged.
- An Improve run defaulted its tasks to `todo-implementation`, which reviews inside the pipeline — before the controller's checks — while the UI claimed checks precede every review. Improve now defaults to the review-free `self-improvement` pipeline, and the confirmation names any task pipeline that declares steps of its own instead of claiming otherwise.
- The approval prompt said the approval could be removed through `Bachata: Repository Verifiers`, which only opened and copied descriptors. That command now offers `Remove this workspace's approval`, and removing it refuses every descriptor again.
- The Master watchdog could not run against a real provider. Its turn resolved to a read-only write scope, which the adapter audit treats as task-bounded and refuses outside a Git worktree — and the Master deliberately runs in Bachata's own storage directory, which is not one. Every unattended run therefore failed at its first Master check. The Master role now declares its scope explicitly. Found by the first real Codex-and-Claude self-improvement run; no fake-provider test could see it.
- Discovery and lead-review turns now declare a read-only write scope, so the adapter's post-turn audit actively proves those participants changed nothing, rather than treating them as task-scoped writers.

### Changed

- Copy that said Bachata starts no repository-declared executable now says what the runtime does: nothing runs until a descriptor is declared and this workspace approves it, and even then only during an Improve run. Doctor, Setup, the verifier remediation, and the generated verification-policy block are reconciled with that. `tests/verifierOnboarding.test.cjs`.
- `Bachata: Improve This Project` is the one command title that is not lowercase `Bachata: `. The product owner fixed the exact string; `docs/BRANDING.md` records it as the single named exception and `tests/branding.test.cjs` enforces that no other title drifts into the capitalized form.

## 0.7.0 — Antagonistic pipelines: findings reconcile themselves, attention bubbles up, and Z.AI GLM is its own provider

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Added

- Findings reconcile themselves after discovery freezes. A fresh reviewer still discovers independently and its output still converges within the run; only then does Bachata map the frozen findings onto prior stable identities, scoring description overlap against file and line proximity. A clear match merges automatically, records a controller-owned alias carrying the wording the reviewer actually used, and folds both wordings into one history. A novel finding gets a new identity. Only three cases reach the human: a description that fits more than one tracked finding, a second description that arrives after another finding already claimed the same identity, and a description matching a finding the human rejected. A finding with the same subject in a different file is never matched, and an unrelated finding sharing a file is never proposed as work. `tests/findingReconciliation.test.cjs`.
- A session-lived notification layer carries human attention. A bell states the unread count, one optional inline line carries the newest unread event, and `bachata.notificationMode` selects `off`, decisions only, material events, or all. Seven event kinds are derived from recorded controller state: human decision required, findings converged, material new finding, fix ready or applied, verification failed or stale, provider blocked, and reversible retained work available. The text is written deterministically from typed state, so generating it costs no model tokens, and republishing unchanged state does not renew the unread count. The store is bounded and session-lived; there is no notification archive. Notification text never reaches a reviewer prompt or the outbound context, and a test asserts which modules may even see it. `tests/notifications.test.cjs`, `tests/webviewDom.test.cjs`.
- `Discard` and `Restore` appear only when Bachata owns an exact reversible retained worktree. A run that wrote straight into the selected workspace offers `Inspect` and makes no rollback promise it cannot keep.
- GLM through Z.AI ships as the distinct provider identity `zai-glm`. It reuses the Claude Code process transport, because Z.AI documents Claude Code support through its Anthropic-compatible endpoint, but it is never labelled Anthropic Claude: the run contract, the outbound-context preview, the Result Center, and Doctor all name Z.AI GLM. `bachata.zaiCommand`, `bachata.zaiBaseUrl`, `bachata.zaiModel`, `bachata.zaiAuthTokenEnvironment`, and `bachata.zaiEnvironmentVariables` configure it; no GLM release is hardcoded. `tests/providerIsolation.test.cjs`.
- Provider environments are scoped by variable ownership. `ANTHROPIC_*` and `CLAUDE_*` reach Claude Code only, `OPENAI_*` and `CODEX_*` reach Codex only, and `ZAI_*`, `ZHIPUAI_*`, and `GLM_*` reach Z.AI only, whichever provider names them in `bachata.providerEnvironmentVariables`. A Z.AI token therefore cannot be forwarded to Codex or Claude Code, and an inherited `ANTHROPIC_AUTH_TOKEN` is never reused as a Z.AI credential. Bachata reads the credential at spawn time and never stores, exports, or logs its value.
- Doctor states the Z.AI command, endpoint, credential-variable presence, and selected model without printing the credential and without spending a model request. A missing model is reported as a fact: Z.AI picks its own default and recorded evidence then cannot name the model.
- Every run states where its provider history lives. Bachata records a minimal locator — adapter and provider identity, provider session id, role, creation and last-seen state — and whether that history can be reconstructed. A provider Bachata cannot reconstruct reports `unavailable` rather than implying otherwise. Browser conversations keep only the origin, never the conversation path. `tests/conversationLocator.test.cjs`.

### Changed

- **Capability reduction.** Bachata no longer starts any repository-declared executable. A `bachata:verifier:<id>` descriptor is refused before the verifier registry is read and before any process is spawned; `bachata:workspace-integrity` and `bachata:project-checks` are unaffected. A descriptor names an executable and Bachata cannot reason about what that executable does — an ordinary `node scripts/check.js` can start a browser E2E runner from inside itself — so no classifier over a command line can make an unattended run safe. A `TODO.md` task or a forked pipeline that declared `Verify: bachata:verifier:<id>` now records a refusal where it previously recorded a check; run that check yourself. The registry, its parser, discovery and the bootstrap command are kept, and `repositoryVerifiers: "humanApproved"` is the authority a future approved runner would pass, but no Bachata command passes it today. `tests/verifierRegistry.test.cjs`, `tests/humanE2ePolicy.test.cjs`.
- Human-only E2E refusal is applied to the resolved execution plan rather than to the symbolic command that named it. The executable, argument vector and the package scripts of the stated working directory are classified before the plan is executed and again immediately before the spawn, and the registry parser refuses an E2E plan behind any descriptor id. Coverage widened to scoped `@playwright/test`, Playwright CLI paths, `playwright-core`, and manager flags that take a value. It follows neither `--prefix` nor `--workspace` into another package, and it is not a proof that arbitrary code cannot launch E2E; that is why unattended descriptors are refused outright rather than classified. `tests/humanE2ePolicy.test.cjs`.

- The per-finding human ruling gate is gone. A finding the pipeline accepted after a challenge involving more than one participant is actionable on its own and routes straight to a bounded fix under an already pre-authorized execution contract; Bachata no longer fabricates a human acceptance to unblock it, and a single-participant finding stays provisional. `findingNeedsRuling` now means what it says: an `unresolved` finding that two or more participants argued over and no human has answered. The Direction view dropped the redundant Accept action and the "waiting on your ruling" framing; a human still inspects, rejects, defers, reopens, or restores by exception. A review-only pipeline gains no write authority from this, reject and reopen change semantic state rather than pretending to reverse files, an applied fix stays unverified until fresh independent evidence, and Bachata still never commits, merges, rebases, tags, or pushes.
- A persisted human resolution was parsed and then dropped: `parseHumanResolution` built the record and returned nothing, so every stored acceptance, rejection, deferral, supersession, and reopening read back as absent. It returns the parsed resolution.
- Saturation no longer implies that a review count is owed. `SATURATION_QUIET_REVIEWS` is now `QUIET_FRESH_REVIEW_SIGNAL`, a default evidence signal rather than a requirement, and the copy states the fact: `Two consecutive fresh reviews found no material change. Continue or close the cycle.` No surface says more reviews are needed, nothing auto-closes on the signal, and closing the cycle stays available before and after it — including with no quiet review recorded at all. The disclaimer now refuses both correctness and a required count. `tests/saturationSignal.test.cjs`.
- Public copy leads with human-directed agentic pipelines for software refinement. Independent agents challenge, converge, and bubble up only what needs human judgment. Breadth stays a strength, and no surface claims that agreement, saturation, agent count, or a passing check proves correctness.

### Corrected records

- An earlier entry stated that nothing is merged automatically and that Bachata never merges two findings on its own. That was true when it was written and is no longer the product contract: clear matches now merge automatically after discovery freezes, with provenance and an undo. What has not changed is that Bachata never asks a human to confirm an obvious duplicate, and never merges a Git branch.

## Direction is bound to a repository candidate, accepted findings become work, and initiatives are first-class

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- The Direction view read its verification state from whichever run tab happened to be selected, so switching tabs — or simply repainting before any tab was selected — changed whether the same initiative looked verified or saturated. Verification is now recorded on the cycle, keyed by the run that produced it, and the Direction view selects the record belonging to the cycle's latest round. Selecting a different run tab now leaves the published direction byte-identical.
- A cycle carried no repository candidate in practice: `repositoryBaseline` was accepted by `startCycle` and rendered by the webview, but no production path ever set it. A cycle is now baselined with the commit, the branch, and a digest of the working tree, and Bachata reports exactly how the repository left that candidate — a moved commit, a changed branch, or an edited working tree. Drift marks the recorded checks stale, blocks saturation, and asks for a rebaseline instead of asking for checks that would describe a different candidate.
- A human could not accept a finding the pipeline had already ruled accepted: the lifecycle matrix offered only reject, defer, supersede, and reopen from that state. Accepting is now allowed, and it is what turns a finding into work.
- Accepting a finding removed it from the Direction view. `outstandingAcceptedFindings` filtered out every entry carrying a human resolution, and actionability required a model challenge that a human acceptance does not create, so a finding the human accepted appeared nowhere and drove no next action. Findings waiting on a ruling and findings the human accepted are now two separate surfaces, and an accepted finding carries its own fix state until evidence closes it.
- A read-only review produced no work to apply, yet the first-run path demanded an applied run between resolving findings and running a fresh review, and a review with nothing to resolve could not pass the resolution milestone at all. The path now runs review, resolve, fix, apply, fresh review, compare, next action, and a review that produced nothing to resolve completes the resolve, fix, and apply steps on that fact.

- The export compared artifact digests against the already path-filtered bundle rather than the original, so an artifact whose content changed only through path exclusion kept the digest of its unredacted form. Digests are compared by artifact id against what was exported.
- The candidate digest never read the origin hash, so fingerprinting a rename or copy source achieved nothing: changing only the copy source, or a rename origin reappearing, left the candidate unchanged. The origin hash is part of the digest.
- A path whose content contradicted its recorded status — deleted but present, or present but gone — was accepted as a coherent snapshot. Completeness is now one rule over the recorded expectations, and either contradiction marks the candidate incomplete, which reads as changed.
- Fingerprinting selected paths per status entry, so a copied destination deleted from the working tree (`CD`) took its still-present source out of the candidate with it. Destination and origin are now decided independently: a rename origin is expected absent, a copy source is expected present.
- A path recorded as deleted was never probed again, so a file that reappeared between the status snapshot and fingerprinting stayed recorded as absent. Every path is fingerprinted; expected absence only suppresses the incompleteness flag, and a reappeared file changes the candidate.
- An unmerged porcelain status does not follow ordinary XY semantics: `UD` means the other side deleted the file while our version stays in the tree. Treating every unmerged state as absence skipped fingerprinting those files, so editing a conflicted file left the candidate unchanged. Only `DD` is absence; every other conflict state is fingerprinted.
- An ordinary unstaged deletion is porcelain status `" D"`, which the deletion check missed, so the vanished path marked every capture incomplete and an unchanged dirty tree never compared equal to itself. Both status columns are read, and unmerged states are treated as expected absence.
- The bundle schema required `contentComplete` and the two `baselineEpoch` fields that the types and parsers still default, so a readable earlier bundle was refused. They are optional, and their fail-closed defaults apply: a candidate with no recorded fingerprint completeness reads as changed.
- `ruledBy` was classified as free text, but `parseRulingProvenance` requires an arbiter ruling to name one of its own participants, so redacting it produced an export Bachata refused to read back. It is structural, and the test now asserts the round trip rather than only the sanitization.
- The bundle schema could not express whether a field was required and let `null` through, so a null or deleted artifact body, a deleted provenance, and a deleted initiative scope all imported as empty defaults. Every field declares presence, `null` is refused, and counts carry their positive or non-negative bound.
- Redaction rewrote an artifact's title, body, and evidence while preserving the digest that described the original, so a later replay treated the redacted content as unchanged. An artifact whose digested content was redacted is exported without its digest.
- A copy source is expected to remain present, so its disappearance between `git status` and hashing is a race, not expected absence. Only a rename origin may vanish silently.
- Transient longitudinal failures were filed under whichever repository was active rather than the one that produced them, and no caller passed a repository. Every report names its own repository.
- Applying any retained run earned the onboarding apply milestone once some unrelated scoped fix had completed, and the milestone fired before the work was recorded. It requires the applied run itself to be a persisted scoped fix, and fires only after recording succeeds.
- Replaying an identical apply after a fresh review had verified the work pushed the finding and its fix run back from `verified` to `fixApplied`. An apply whose content is already recorded returns the existing patch and writes nothing.
- Bundle validation was still lossy underneath: a non-numeric line number, a malformed latest observation, an object-valued artifact body, a malformed initiative scope, and an unknown field all normalized away and imported. Every field of a bundle is now described by one schema, and every supplied value must match it.
- Export classified strings by property name rather than by schema path, so a real arbiter ruling provenance was refused as unclassified while a branch name — which the user chooses — was protected from configured redaction. Classification comes from the same schema, by path, and the test that claimed to protect ruling provenance used an invalid shape and proved nothing; it now uses `arbiterRuling` with `participants` and `ruledBy`.
- A stale run's outcome lived only on a round the current candidate filters out, with the visible notice coming from a session-wide array that vanished on restart and could appear under another repository. Stale runs are read from the record and reported in Direction, and transient failures are scoped to the repository that produced them.
- A rename origin that no longer exists is expected absence, but any other path disappearing between `git status` and hashing now marks the candidate incomplete instead of reading as a deletion.
- A scoped fix was recognised only from session memory, so a run recovered after restart could not complete the onboarding fix milestone. It is derived from the persisted, non-imported fix-run link.
- Import accepted a merge that named itself, a merge whose alias was still a live finding, and a merge with no owner.
- A stale round kept the identities and counts derived from a fold it never committed, so Bachata rejected its own export for naming findings the bundle did not contain. A stale round is built before the fold, with no identities, no counts, and no decision changes.
- A stale run reached the interface as an ordinary completion: the notice was filtered out of Direction with its epoch, and onboarding still counted the fresh review. Recording a round now returns whether it was stale; a stale run states that it ran against an earlier candidate and completes no current-candidate milestone.
- Applying work with no staged file returned success, advanced every linked finding to `fixApplied`, and recorded no patch. An empty staged set is refused before anything is written.
- Replaying an identical apply produced another revision-1 patch. Identical applied work is recorded once, and different applied work supersedes the previous patch of that cycle.
- Bundle validation called the lenient persistence parsers underneath its strict top level, so a malformed challenge history, evidence list, decision option, provenance block, round identity set, or decision change was silently normalized away and imported. Every supplied nested field must parse, or the import is refused.
- Import did not check that children belonged to the exported initiative, nor for duplicate rounds, merges, fix runs, or cycle sequences, some of which became silent first-wins during persistence. The whole graph is validated before anything is remapped.
- Structural redaction classified keys by a partial allowlist, so it destroyed ruling provenance while leaving free-text `customType` unredacted. Every string field is now classified as structure or as free text, and an unclassified field refuses the export instead of guessing.
- Any completed write-capable workflow earned the onboarding fix milestone once a resolution existed, and the recorded change set was ignored. The milestone requires a run Bachata opened as a scoped fix that actually changed files.
- Migration 13 was edited after it had already run, so a catalog that recorded it skipped the new fix-run column and failed with `no such column: imported`. Migration 13 is restored to what it was, and the column is added by migration 15.
- A round bound to a superseded candidate was hidden from saturation but still folded its findings, decisions, artifacts, and cycle deltas into the current candidate. Such a round is now recorded as history, with a stated reason, and changes nothing current; a check from that run is refused too.
- The fix outcome and its patch artifact were two transactions, so a closed cycle could leave a finding marked `fixApplied` with no patch recorded. Applying work validates one open, current-epoch binding and commits the outcome and the patch together or not at all.
- Exporting after a merge produced a bundle Bachata itself refused: historical rounds name the absorbed identity, and validation checked only current findings. Historical identities resolve through recorded merges.
- Bundle validation was strict at the top level and lenient underneath: a malformed human resolution was silently discarded, and cycle finding deltas were not checked at all. Nested resolutions must parse, and every finding delta must resolve.
- Index stages were keyed by path, so in a conflicted file a change to one stage could be masked by another. Every `(path, stage, mode, blob)` entry is digested.
- Any `stat` failure counted as a missing file and left the candidate complete, so a permission error read as a deletion. Only `ENOENT` is absence; every other failure marks the candidate incomplete.
- The manager compared candidates with its own identity string that omitted `contentComplete`, so a refresh between complete and incomplete could publish no update. It uses the shared comparison.
- Structural redaction rewrote schema values, so a policy redacting a word like `review` changed a cycle type and produced an export Bachata could not read back. Ids, enums, and identity lists are preserved, and the sanitized bundle is parsed before it can be saved.
- A run reference shared by live fix links in two initiatives was resolved by arbitrary ordering. The link matching the run's own binding wins, and an ambiguous unbound reference is refused.
- Fix-run upserts never updated the imported flag, so a live link colliding with an imported row stayed historical and was ignored. Live status dominates.
- Every fresh review rebaselined its cycle, even against a byte-identical candidate, so each review invalidated the preceding one and two quiet rounds were unreachable through the interface. A fresh review now compares the candidate and keeps the epoch when nothing changed.
- Run bindings carried no epoch, so a run started before a rebaseline was stamped with the epoch it happened to finish in and counted as evidence about a candidate it never saw. A binding records the epoch it was bound at, and its round and checks are recorded against that epoch.
- The candidate hashed working-tree bytes only, ignoring the index, and discarded the source path of a rename or copy, so a staged-only change and a rename could both leave the digest unchanged. The candidate now covers index blob state and both sides of a rename.
- A file the fingerprint could not hash was recorded as absent rather than marking the candidate incomplete, so an unreadable file read as a deleted one. Every batch and single-path failure now marks the candidate incomplete, which reads as changed.
- A thrown baseline capture returned the previously cached candidate, so a repository that became unreadable while changing appeared unchanged. The cache is cleared and the candidate becomes unknown, which reads as drifted.
- A persisted candidate with no `contentComplete` field was trusted as complete. Only an explicit `true` is trusted now.
- Import validated only top-level references, and any id it could not map was silently preserved, so a bundle naming a cycle that did not exist imported with a dangling reference. Provenance, challenge history, resolution references, and round identity sets are all validated, and an id that fails to map refuses the whole import.
- Import reused the lenient parser that repairs persisted state, so a corrupt enum was normalized instead of rejected — a cycle whose completion read `corrupt` imported as an open, mutable cycle. Bundles now go through a strict parser that rejects rather than repairs.
- Initiative export redacted literals after serialization, so a Windows path escaped by JSON survived redaction. Redaction runs structurally over the bundle before it is serialized.
- Imported fix runs kept the exporting workspace's run references and were treated as live, so a local run whose reference collided with an imported one could route its outcome into the imported initiative. Imported links are marked historical and never drive a fix transition.
- Merging two findings that shared a fix run could destroy the canonical row and keep the less advanced state. Colliding rows merge explicitly, keeping the furthest state.
- Validation errors were read from the newest round of any epoch, so an error recorded against a superseded candidate survived a rebaseline.
- The cycle candidate fingerprinted `git status` output, not file contents, so editing a file that was already dirty left the digest unchanged and stale checks kept reading as current. The candidate now hashes the content of every dirty and untracked path. A tree Bachata cannot fingerprint completely reads as changed, and a repository it cannot read at all reads as drifted rather than as unchanged.
- Rebaselining a cycle replaced only its candidate, leaving the previous candidate's quiet fresh reviews and passing checks in force, so a brand-new candidate could look saturated without being reviewed once. A cycle now carries a baseline epoch; rebaselining bumps it, and rounds and checks recorded against an earlier epoch no longer count toward saturation or appear as current verification.
- Closing a cycle did not close it. Runs could still be bound to it, rounds and checks recorded against it, and Direction kept offering to close the already-closed cycle. A completed cycle now refuses new bindings, rounds, checks, patches, and rebaselines, and Direction offers to start the next cycle instead.
- Applying a fix and recording its verification resolved the initiative and cycle from whichever was active, so switching initiative or cycle before Apply attached the patch and the fix outcome to the wrong history. Both now resolve through the run's own fix-run link and cycle binding, and recording a round resolves its initiative from the bound cycle rather than the active one.
- Merging a finding kept only the canonical record's resolution and fix state and then deleted the absorbed row, so merging an accepted or in-progress finding silently discarded the human's acceptance and orphaned its fix runs. A merge now carries the surviving acceptance and the furthest fix state, repoints the absorbed fix runs at the canonical finding, and is refused outright when the two carry conflicting human resolutions.
- Rerunning the required checks from Direction used the active tab's retained run, which could recheck work unrelated to the checks Direction was reporting. It now resolves the run that recorded the verification and refuses when that run is not open or kept nothing to recheck.
- Initiative export wrote raw JSON with no export-policy filtering, no redaction, no preview, and no confirmation, unlike every other Bachata export. It now goes through the same path: policy exclusion, path masking, literal redaction, an editor preview, and an explicit confirmation listing the applied rules.
- Initiative import remapped only top-level ids, leaving provenance, challenge history, and resolution references pointing at the source workspace's records. Every nested reference is remapped now, and a bundle whose references do not resolve — or that repeats an id, omits a list, or carries one malformed record — imports nothing at all instead of reporting a successful partial import.
- Bundles omitted fix runs while carrying the finding fix state that depends on them, so an imported finding could claim a fix with no provenance, and imported cycles kept verification that `docs/STATE.md` said was never carried. Fix-run links are exported and imported; candidate-bound verification and run bindings are dropped, and the documentation now says exactly that.
- A plan whose only change was its evidence produced no new revision, so the new evidence was discarded. The plan digest covers evidence.

### Added

- Findings can be merged by hand. Two rounds that describe one defect in different wording produce two identities, because identity is a digest of subject and file. A merge records an alias with a reason, folds the absorbed history into the canonical one, and makes later rounds resolve through the alias, so a reworded repeat is no longer new material. Alias chains collapse to one canonical finding. Nothing is merged automatically; unmerging stops future folding and does not split history already shared.
- Direction's next action is executable. Accepting a finding opens a bounded fix scoped to that finding, with its evidence and challenges in the prompt and a statement that a human already accepted it; drift rebaselines the cycle; stale checks rerun; a saturated cycle closes; a judgment action focuses the surface that needs the human. The fix workflow is `bachata.fixPipelineId`, then the selected workflow, then built-in `managed-fix`; a read-only workflow is refused.
- An accepted finding is tracked from acceptance to evidence: awaiting a fix, a fix running, a fix applied, and verified. Only a fresh review that no longer observes the finding marks it verified. An applied fix is not a verified one, and an accepted finding without a verified fix blocks saturation.
- A converged plan is persisted as a typed `plan` artifact with its own content digest and supersession chain, instead of staying ordinary run output. Applying retained work persists a typed `patch` artifact naming the staged files and the findings the work was scoped to.
- A repository can hold more than one initiative. Initiatives are created, switched, and moved between active, paused, completed, and abandoned explicitly, and each keeps its own cycles, findings, decisions, and artifacts.
- An initiative can be exported to a JSON bundle and imported elsewhere. Import always creates a separate initiative with remapped ids and merges nothing, because Bachata has no rule for reconciling two divergent histories.

## Review round: the finding projection follows the latest observation, and run binding is atomic

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- Removing a finding's severity or line range updated the latest-observation baseline and reported the change, but left the stale value on the finding itself, so the Direction view kept showing a location the review no longer claimed. The finding's message, severity, and location are now projected from the latest observation, and an explicit absence clears the field instead of falling through to the previous value. Cumulative evidence, challenge history, and resolution history are untouched, and the cleared state is not written back on persist.
- `bindRun` committed the run binding and then saved the cycle in two transactions, so a failed cycle write left a durable binding whose cycle listed no run — including ghost fresh-review bindings. Binding and cycle membership now commit in one `commitRunBinding` transaction. Fresh-review binding still overrides an earlier generic binding, a repeated binding stays idempotent, and a failed transaction leaves both the previous binding and the previous cycle exactly as they were.

## Review round: invalid rounds cannot saturate, per-observation deltas, fail-closed adoption, and chain-only supersession

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- A round carrying decision-validation errors still counted as quiet, so two malformed fresh reviews could satisfy the saturation count. A round with any validation error is never quiet, and quiet counting resumes only from later consecutive valid quiet reviews. The behaviour is identical after a restart.
- Material change was measured against the cumulative evidence and challenge lists, so a withdrawal was reported on every later identical review, a restored item could not be detected, and a removed severity or location was either missed or repeated. Findings now carry a latest-observation snapshot; message, evidence, challenges, severity, and location are compared against the immediately previous observation, additions and removals are detected symmetrically, and explicit absence is representable. Rows written before the snapshot existed derive their first baseline from the existing fields, so no migration is needed.
- Repository-identity adoption was fail-open on its first failure: the guard ran before adoption was attempted, the legacy initiative was returned, and the next write succeeded under the legacy identity. Every public longitudinal mutation — `defineInitiative`, `setDirection`, `startCycle`, `bindRun`, `recordRound`, `closeCycle`, `saveDecisions`, `saveArtifacts`, and `resolve` — now goes through one resolver that discovers and attempts adoption first and then refuses. `bindRun`, `closeCycle`, `saveDecisions`, and `saveArtifacts` previously had no guard at all. After a failure no further write is attempted, including the adoption write itself, while reads still surface the legacy state and the visible failure.
- Accepting an artifact retired every current lower revision that shared its type, so accepting one plan silently retired an independent plan. Only records reachable through the explicit `supersedesId` chain are retired now; the walk continues through already-superseded intermediates and still terminates safely on cyclic or missing predecessors. The single finding-set chain still leaves exactly one current revision.
- The main-worktree legacy identity was derived with `endsWith("/.git")`, which missed `C:\repo\.git`. A pure helper now derives the root without assuming POSIX separators and refuses `/repo/not.git`, `/repo/.github`, and `/repo/.git/modules/x`.

## Review round: every execution bound, closures that reopen, one lifecycle matrix, and exclusion that survives delimiters

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- Ordinary runs were never bound to a cycle, so recording a round fell back to whatever cycle was open at the time. Opening a new cycle and refreshing replayed an old terminal execution into it and inflated occurrence counts. Every accepted execution is now bound to its initiative and cycle before provider work, an unbound historical round is recovered from `cycle_runs` instead, and a round with no cycle of its own is not recorded at all.
- A finding that changed materially after a human closed it kept the stale resolution, so it was excluded from outstanding work and its round counted as quiet. Any material change after any human closure now reopens the finding, moves the prior resolution into a durable resolution history, and marks the round as material. Material change now includes added and withdrawn evidence, new challenges, a changed message, a changed severity, and a changed location.
- Every lifecycle state offered every resolution, so reopening a proposed decision left it proposed with a resolution attached and removed it from the human queue. One transition matrix now governs the service and the UI: the service refuses a disallowed action, and the UI receives the matrix in the snapshot and renders only the actions that record's state allows. Superseded records offer nothing, and deferred decisions stay visible.
- Artifact supersession stopped at an already-superseded intermediate, so accepting revision 3 could leave revisions 1 and 3 accepted and current at once. The chain is now walked to its end with cycle protection, and any lower revision still current is retired in the same write, leaving exactly one current revision.
- An invalid candidate inside a multi-decision source was silently dropped, unknown predecessors were ignored, and a same-identity record could shadow a declared predecessor. Decision sets are now validated all-or-nothing, and duplicate option ids, malformed candidates, conflicting identities, unknown predecessors, and predecessor conflicts produce validation evidence that is stored on the round and shown in the Direction view.
- Canonical repository ownership was not cached under the canonical repository root and did not adopt an initiative recorded against the main worktree root when the repository was opened only through a linked worktree. Both compatibility paths are added, and when adoption fails, longitudinal mutation is refused rather than proceeding against the wrong identity.
- Cycle start and human resolution spanned several transactions, and a finding resolution never populated `resolvedFindingIdentities`. Both are now single atomic store operations, the resolved identity is recorded in the cycle delta, and longitudinal persistence failures are surfaced in the Direction view instead of only the output channel.
- Path exclusion still leaked a configured prefix after `:`, `@`, `!`, `#`, `&`, `+`, `%`, `^`, and `~`, because a match was accepted only after a whitespace-or-punctuation boundary. Matching is now segment-aware: a match is rejected only when the neighbouring character could extend the segment name. Export metadata — title, working directory, pipeline name, provider identity, and ruling attribution — is masked, and a final no-leak pass runs over the rendered bundle, Markdown, and SARIF before the policy literals are applied. JSON exports stay valid.

## Review round: the fresh-review contract, immutable decision history, canonical digests, and prefix-driven exclusion

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- A fresh review checked only execution safety, so a read-only planning or decision workflow qualified. Those produce no findings, so two of their rounds would read as saturation. A fresh review now also requires a workflow that actually produces review findings: an enabled step declaring a `proposedModelFindingSet` output, or a consensus step whose accepted candidate is a `ruledModelFindingSet`. Plan, Core Decisions, and a custom read-only non-review workflow are refused by name.
- The validated pipeline snapshot was discarded and only its id was passed on, so a custom workflow could change between validation and preflight and regain write authority. The validated snapshot is now resolved with `requireCurrentCatalog`, handed to conversation creation, and executed directly; the run refuses if the snapshot that reaches preflight is not the one that was validated.
- Superseded decisions were excluded when computing the next revision, so re-observing one produced revision 1 again and its derived id overwrote the historical row, its human resolution, and its supersession chain. Decision rows now carry immutable unique ids, revision is computed across every record in the logical chain including superseded ones, and a re-observation can never overwrite an earlier row.
- Decision rows written before logical identity existed defaulted their `logicalId` to the old subject-only id, so an exact new observation opened a second current chain. Compatibility parsing now derives the subject-and-scope identity for those rows, and the new observation supersedes the legacy record instead of duplicating it.
- Affected scope was part of the lookup identity with no way to express a genuine scope change, so widening a scope silently left the accepted predecessor current. A typed decision candidate can now name its predecessor by subject and scope; only then is the predecessor superseded. Two unrelated scopes of one subject still stay two decisions.
- Two conflicting candidates for one logical decision produced a single stored row but duplicate round changes. A decision source with conflicting duplicates is now refused whole, exact duplicates collapse to one, and duplicate option ids invalidate the candidate.
- Artifact equality compared the rendered human-readable body, so a message containing label-shaped text such as `evidence:` could collide with a separate evidence entry and suppress a material revision. Equality now uses a canonical structured digest with deterministic ordering; the body is presentation only. Reordering evidence or challenges produces no revision, and the digest survives restart and replay.
- Path exclusion masked prose by first guessing generic path runs, so a configured prefix containing a space could never match and opening punctuation sheltered a path: `path=`, `(`, `[`, `{`, and Markdown links all leaked. Masking is now driven by the normalised configured prefixes with boundary-aware matching, covering spaces, Unicode, tabs, backslashes, dot segments, absolute paths, and punctuation. A regression test asserts no configured prefix and no complete raw path survives the bundle, the Markdown report, or the SARIF document.
- Longitudinal ownership keyed on the repository root, so a linked worktree of one repository received its own initiative. Ownership now uses the Git common directory, with the working and repository roots kept separately for filesystem work. A linked worktree shares its main worktree's initiative; nested paths, symlinks, and separate repositories behave as before. Adoption of an initiative recorded under an earlier identity reports its failure to the output channel instead of failing silently.

## Review round: fresh-review authority, decision revisions, artifact authority, and exclusion that survives odd paths

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- A fresh review copied whatever workflow the source conversation had selected, so starting one from a write-capable or checklist workflow ran that authority. Bachata now resolves the workflow's execution contract and refuses unless every enabled step is read-only and no step executes a checklist. `bachata.freshReviewPipelineId` names an explicit read-only fallback; without it Bachata refuses instead of substituting a workflow, and it refuses a configured workflow that is not read-only. The refusal happens before any conversation, cycle, or run exists. Provider sessions are reset once, not twice: the duplicate reset before the guarded run path is gone.
- A decision was identified by subject alone and then rewritten in place, so a materially different question, scope, options, or trade-offs silently inherited the earlier human approval. Decisions are now deduplicated by normalised subject **and** affected scope, and carry a logical identity, a revision, and an occurrence count. An exact repeat accumulates occurrences and provenance and keeps its resolution. Any material change to question, scope, options, trade-offs, recommendation, or evidence supersedes the previous record and opens a proposed successor that inherits no human resolution and records the visible delta. The same subject in two different scopes stays two decisions.
- New model output automatically superseded a human-accepted artifact. An accepted artifact is no longer revoked by a later round: the round records a proposed successor instead, the accepted revision stays current, and accepting the successor supersedes the ancestor chain in one write.
- Artifact equality compared only disposition, subject, and file, so a changed message, severity, line range, evidence, or challenge produced no revision and left the stored artifact stale. The artifact body is now a canonical rendering of every material field, and each of those changes produces a revision.
- Excluded paths leaked when they contained spaces or non-ASCII characters, or were written with `./`, `..`, or mixed separators. Comparison now normalises separators and dot segments before matching, and covers absolute paths that contain the excluded prefix. Prose masking no longer depends on an ASCII token pattern: it masks the whole path run, including one interior space when the next token continues the path. A regression test asserts that no excluded raw path text survives the bundle, the Markdown report, or the SARIF document.
- The latest comparison compared decisions against an empty list, so every retained decision was reported as changed, including after a restart. Rounds now persist the decision changes they caused, and the surface replays them.
- Resolved findings in a round were derived from accumulated cycle state, so an earlier human resolution was attributed to a later review round. A round now records only the findings that transitioned to resolved during that round.
- Repository identity hashed whatever working directory was supplied, so `/repo`, `/repo/package`, and a symlink to `/repo` created three initiatives. The manager now canonicalises through the existing Git-root and realpath resolution, caches it, warms it on initialisation, conversation creation, and selection, and awaits it before any longitudinal write. An initiative bound to a pre-canonical path is adopted onto the canonical identity instead of being orphaned. Separate repositories stay isolated.
- The flagship journey test compared a hand-picked fingerprint. It now deep-compares the complete durable direction state — initiative, cycles, artifacts, decisions, findings, comparison, saturation, and next action — across both a terminal replay and a manager and catalog restart, and asserts every human resolution survives.

## Review round: real artifact and decision producers, and one proved end-to-end journey

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Added

- A real artifact producer. A review round whose consensus ruled a finding set now persists that set as a `findingSet` artifact with provenance, participant ids, run reference, cycle, evidence, and revision. The artifact is written in the same transaction as the round, the finding fold, and the cycle delta, so a replayed execution produces no second artifact. A later round with a different ruled set supersedes the previous revision; an identical set produces no revision at all. The cycle records the artifact in its output ids, and accepting or rejecting an artifact records it in the cycle's accepted state delta.
- A typed decision producer. A core decision is created only from a validated `longitudinalDecisionSet` candidate carrying a subject, the actual question, a non-empty affected scope, and non-empty evidence. Options, trade-offs, and a recommendation are recorded only when the workflow supplied them, and are never invented. A ruled finding set, an unresolved risk string, a provider error, a task blocker, an evidence gap, and an unaccepted decision artifact all produce no decision. A repeated decision subject accumulates evidence and keeps its human resolution instead of reverting to proposed.
- One shipped workflow that produces such a decision: the `core-decisions` preset converges two independent providers on the choices a human owns, and declares the typed decision shape so a malformed candidate makes that participant's decision invalid.
- The Direction view answers "which artifacts are accepted?" directly. Accepted artifacts are listed separately from proposed artifacts, and superseded revisions stay in history.
- One integration test walks the whole journey: define the initiative, start a fresh review, assert an independent conversation and one real pipeline call with no prior finding, evidence, or decision in the prompt, persist the artifact and the finding history, record human acceptance, run a second fresh review in the same cycle, compare the rounds, restart the manager and the catalog, and assert the direction, artifacts, decisions, findings, rounds, comparison, and next action are byte-identical.

### Fixed

- The direction surface reported the accumulated cycle delta while claiming it was the latest change, so a finding first seen in an earlier round still appeared as new material. Rounds now persist their own new, repeated, resolved, regressed, reopened, and not-observed identity lists, and the surface reports the latest round.
- Onboarding conflated "a fresh review completed" with "a round was compared". They are separate outcome milestones now: the comparison milestone requires a second round in the same cycle, so a single fresh review can no longer complete it.

### Documented

- Initiative state is local to this VS Code workspace and storage identity. It is not stored in the repository, not synchronised, and has no import or export. Moving or re-cloning a repository to a different path can require a new initiative. Bachata does not claim portable or repository-backed initiative history. A test pins that statement in the README, the state document, and the roadmap.

## Review round: fresh review actually runs, rounds are durable, and silence is no longer resolution

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- "Start fresh review" reset provider sessions and opened a cycle but never ran a pipeline. It now creates its own root conversation carrying the working directory, the selected pipeline, and the initiative goal, desired outcome, scope, constraints, and acceptance criteria, resets sessions, and executes through the existing guarded run path. No prior finding, ruling, decision, confidence, or transcript reaches the provider prompt: a test asserts the prompt line-for-line. A refused run leaves no cycle and no round behind, because the cycle is opened and the run bound only after execution is accepted.
- Every fresh review opened a new cycle while rounds were stored against the current cycle, so two quiet rounds and saturation were unreachable, and two rounds sharing a run reference overwrote each other. A run is now durably bound to one cycle, repeated fresh reviews stay rounds of the same open review cycle, and rounds are keyed by initiative, cycle, run, and execution.
- Replay protection lived in a `Set` in memory, so a restart could re-fold terminal evidence and inflate occurrence counts. Rounds are now a table with a composite primary key; the round insert, the finding fold, and the cycle delta commit in one transaction, and a duplicate execution is a no-op that changes no occurrence, delta, or round count.
- One review that omitted a finding marked it resolved. Absence of model output is not evidence that a condition is gone. A finding a fresh review does not mention is recorded as not observed, stays open, and still blocks saturation. Resolution now requires an explicit human resolution or controller-owned evidence.
- Finding identity hashed the complete message, so a paraphrase created a new finding while the previous one was falsely resolved. Identity is now the subject and the file only; message, evidence, and challenges are revision history.
- Decision rows were keyed by a globally unique id derived from risk text alone, so identical subjects in two initiatives corrupted ownership. Decisions are now keyed by initiative and decision together, and migration 11 rebuilds the table.
- Every conversation used the first workspace folder's longitudinal state, so a multi-root window wrote into the wrong repository. Longitudinal state is now resolved per conversation from its working directory, its pipeline scope root, or the workspace default. Bachata refuses to bind an initiative when it cannot name a repository.
- Repository paths were always lowercased, so distinct case-sensitive paths collided. Case folding is now platform-aware.
- Bundle exports still carried excluded paths embedded in prose such as a final ruling, an assessment summary, a transcript entry, an event title, or a structured output, and the bundle was built from the unsanitised result. The bundle is now built from the sanitised evidence result, and one shared masker replaces excluded path tokens inside arbitrary strings for the bundle, Markdown, and SARIF. Omissions report counts and never repeat an excluded path.
- Every operational error, blocker, and evidence gap was promoted to a core human decision. That producer is removed. Operational failures stay operational evidence; Bachata exposes no decision rather than fabricating one.
- Supersede existed in the domain and the protocol but had no UI, and reopen collected only a reason. Both are now reachable. Reopen requires a reason and at least one material evidence delta at the parser, the service, and the dialog. Supersede requires an existing replacement in the same initiative and refuses a self-reference.

## Review round: typed ruling provenance, validated consensus candidates, structural export exclusion, and longitudinal product state

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- A valid unanimous two-provider consensus was reported as `inconclusive`. `buildDecisionArtifact` produced an accepted decision with no `ruledBy`, the conversation manager recorded only `ruledBy`, and the result projection treated a missing `rulingBy` as missing evidence. Decisions now carry typed ruling provenance that distinguishes unanimous participant consensus, an arbiter ruling, a single-provider result, controller verification, and human resolution. Unanimous consensus persists every participant id and provider identity and names no ruler, so Bachata no longer has to fabricate one provider as the decider. Legacy persisted results with only `rulingBy` still parse, and a rerun never inherits the previous ruling's provenance.
- `parseDecisionParticipant` accepted any candidate JSON, so a malformed ruled candidate was accepted as valid, its findings were silently dropped later, and the run completed with an assessment and zero findings. A single reusable typed finding schema is now declared once in `src/pipeline/candidateShapes.ts` and applied by name. Every built-in consensus step that promises `{"findings":[...]}` declares `candidateShape`, an invalid candidate makes that participant's decision invalid with explicit validation evidence, an invalid arbiter ruling cannot complete the run, and a valid empty `findings` list is still accepted. The two review presets that duplicated the same finding schema now reference the shared shape instead.
- Evidence exports filtered only `changedFiles`, so an accepted finding's location, a risk, a check command, or narrative text could still carry a path the repository export policy excludes. Path exclusion is now applied structurally to the whole evidence input before rendering, covering findings and their locations, changed files, risks, recovered errors, evidence gaps, checks, the diff summary, the final ruling, the assessment summary, and the apply reasons. Markdown, SARIF, and the bundle share one sanitised input, and the omission summary states how many paths, findings, and entries were withheld.

### Added

- Durable, versioned longitudinal state: initiative, cycle, artifact, decision ledger, and cross-run finding history, behind catalog migration 10. Existing installations open without data loss, and the writer fence covers the new tables.
- Cross-run finding identity. The same finding reported by two different runs is one tracked item with two occurrences, not two bugs. A finding is not actionable until it has been challenged and then accepted.
- Fresh review, round comparison, saturation, and human resolution. A fresh review resets provider sessions and carries no prior confidence or conclusion into provider prompts; prior findings are available only for post-review comparison. Comparison separates new material findings, repeated findings, resolved findings, regressions, findings reopened on new evidence, outstanding accepted findings, and decision changes. Saturation is reported only when several consecutive fresh reviews added nothing material, prior accepted findings are resolved or explicitly accepted, core decisions are closed, and the required checks are current, and it is never labelled as correctness.
- A direction-first surface. The top level answers what the work is trying to achieve, what direction is accepted, what changed in the latest cycle, which decisions need human judgment, which accepted findings remain unresolved, and the one next useful action, without opening a transcript. Run mechanics remain available as drill-down.
- Onboarding continues past first-run evidence inspection through resolve, apply, fresh review, compare, and choose the next action.
- A longitudinal benchmark design under `benchmarks/longitudinal/` measuring new supported findings per round, false positives, dispositions, resolved findings staying resolved, regressions, human-visible core decisions, and collapsed routine information. No round is recorded, so it states that it supports no claim.

## Review round: a recoverable binding transaction and behavioural proof for it

Every entry below is proved by a behavioural test in this tree. Nothing here is asserted from source text.

### Fixed

- `release:bind` was still not atomic. A staging failure before the write was registered left an orphan file; staging wrote mode `0600` over `0644` documentation; rollback used a pathname `writeFile`, so it followed a replacement symbolic link, was not atomic, and dropped the document's original mode; each document's identity was checked before staging rather than immediately before its rename; a lock-write failure or a rollback failure could leave a stale lock; and a crash between renames left nothing to recover from. Binding now runs through `scripts/lib/documentBindingTransaction.mjs`: staging names are registered before anything is created, each document is copied through an `O_NOFOLLOW` descriptor into a backup carrying its original mode, staging uses that same mode, a recovery journal is written before the first rename, each document's bytes and `dev`/`ino` are re-read immediately before its own rename, rollback renames the backup back into place, the lock is always released, and a journal is left behind only when a rollback failed so the next run replays it.
- The test named "binding restores every document when one write fails" injected no failure at all; it only pre-created the lock. It is replaced by fixtures covering success with mode preservation, staging failure, rename failure after a partial commit, a document edited between staging and commit, a target replaced by a symbolic link, a live lock, an unreadable lock, a dead-owner lock, a rollback failure, and a binder killed between renames that the next run recovers.
- `openPinnedArtifact` reported every mid-read change with one message and compared no `dev`, and `readArtifactSnapshot` applied no artifact-specific bound. Size changes, inode replacement and same-size in-place rewrites are now reported separately, `dev` is compared alongside `ino`, and each artifact carries its own descriptor-size and declared-archive-byte limits.
- Browser Bridge directory records were checked for uncompressed size only, and two entry names differing only by case or Unicode form were both accepted. A directory record must now declare zero compressed and zero uncompressed bytes, and entries that collide once NFC-normalised and case-folded are refused.
- VSIX verification rejected a normalised-name collision by calling `reject` directly, leaving the archive open and any active stream running. Every refusal now goes through one settle path, and a failure to remove the extraction directory is aggregated with the verification error instead of replacing it.
- VSIX entry names were tested for Windows reserved device names before trailing dots and spaces were stripped, so `nul. ` passed. They are stripped first, and `CONIN$` and `CONOUT$` are refused alongside the other reserved names.
- The locked production closure applied `os`, `cpu` and `libc` predicates to required packages as well as optional ones, so a required package the predicate excluded silently left the expected set and its absence from the VSIX could not fail. Only optional packages are now excused.
- `release-verify.mjs` removed its own `bachata-release-verify-*` snapshot and re-raised the signal before `verifyVsix` could remove its separate `bachata-vsix-*` extraction directory. Both are created through one registry, one cleanup removes every tracked directory, and the signal is re-raised only once the registry is empty.
- A failed attachment-snapshot removal inside a `finally` block skipped the remaining bookkeeping and replaced the error that ended the run. Bookkeeping now runs first, and a removal failure is raised alone for a clean run or inside an `AggregateError` whose first element is the original failure. Direct-message success and failure, capability refusal, checklist refusal, pipeline interruption, programmatic preflight, and removal failure each have a behavioural test.
- Attachment ancestor validation compared `lstat` results only, and `save` and `restore` created the attachments directory before validating it. Every ancestor is now opened `O_NOFOLLOW`/`O_DIRECTORY` and its descriptor's `dev`/`ino` compared with the `lstat` that authorised it, the opened attachment's descriptor is compared with `lstat` of its own path, and both directories are validated before `mkdir`.

### Corrected records

- The reported ancestor-symlink bypass of the attachment store did not reproduce against the code already in this tree; the existing `lstat` ancestor walk refused it. What this round adds is descriptor-level confirmation and the behavioural tests that were missing.
- The previously recorded `npm test` result of 1113 tests is withdrawn. Rerunning it on this tree failed: a source-text assertion pinned an error string the artifact reader no longer emitted, and the runner stops at the first failing file.

## Review round: verified bytes, tracked lifecycle, and a flagship paired managed fix

### Fixed

- Attachment snapshots were never disposed after a direct or pipeline run, and a resolution failure left agent reservations and foreground counters behind. Resolution now happens inside the protected block and the snapshot is disposed on every exit path. No behavioural test proved this until the round below.
- `backup()` still validated with `stat()` and then read the attachment by pathname, so a same-size symbolic link substitution captured external bytes. It uses the descriptor-based `O_NOFOLLOW` reader, and `restore()` replaces the target rather than writing through a link.
- The record schema pinned the dependency-audit `Notes` cell, so recording a real `0 vulnerabilities` result was rejected. Only descriptor cells are pinned.
- Release artifacts were read once but their bytes discarded, and every consumer reopened the path for hashing, manifest parsing, and copying. Each artifact is now read once into a snapshot that produces the digest, the manifest version, and the verified copy.
- `release:bind` staged into predictable `.bachata-bind` files that could follow a pre-existing symbolic link. Staging uses a unique exclusive `O_NOFOLLOW` file under an exclusive lock. The identity re-check and the atomic rollback claimed here were not true as written; see the round below.
- VSIX duplicate detection compared raw entry names while extraction normalised them, so `extension//package.json` and `extension/package.json` both extracted to the same target. Empty segments and normalised, case-folded, Unicode-normalised collisions are refused before extraction.
- Bridge manifest validation omitted `storage.managed_schema` and `file_handlers[].action`, two packaged-path contracts; both are validated now.
- Two identical copies of the pinned Bridge archive were accepted; exactly one is required.
- Directory records were excluded from the Bridge closure comparison, so an extra directory passed as a complete match.
- The shared ZIP reader had no total declared-byte bound and several failure paths rejected without closing the archive.
- Dependency traversal followed a symlinked package root, and the locked closure ignored npm platform predicates while excluding every optional production entry. The predicate was then applied to required packages too; see the round below.
- `release:verify` signal handlers re-raised even when the snapshot removal failed. The removal is retried and the signal re-raised only once the snapshot is gone.
- An attachment was validated with `stat()` and then read again later by the provider adapter, so replacing it with a same-size symbolic link could send arbitrary local file contents to a provider. Attachments are now opened with `O_NOFOLLOW`, validated through that descriptor, and copied into a read-only per-run snapshot that adapters read and that is removed when the run ends.
- Record identity compared only each row's first cell, so a compatibility row could be replaced with an invented provider or an easier checklist and still pass. Every non-placeholder descriptor cell of every required row is now pinned, and the binder applies the same schema.
- A missing or non-directory Browser Bridge build tree was accepted with nothing compared. A regular no-follow directory is required, and the archive must compare entry for entry.
- The expected production dependency set was derived from the artifact under test, so removing a whole package removed it from both comparison directions. The closure is now read from `package-lock.json` and the package sets are compared first.
- Manifest reads and VSIX extraction had no archive bounds, so a crafted candidate could exhaust memory or disk before any trust check. Records, per-entry declared and streamed size, duplicates, total uncompressed size, and archive size are all bounded, and Bridge directory records are counted and validated instead of skipped.
- Bridge manifest validation resolved only a few MV3 fields. Content-script CSS, options pages, the side panel, devtools, sandbox pages, URL overrides, and declarative rule resources are all validated now.
- Release artifacts were reopened separately for `lstat`, hashing, and manifest parsing, and overrides skipped no-follow validation, so a path replacement could mix bytes and versions. Each artifact is read once through a no-follow descriptor and a size change during the read is refused.
- `release:bind` wrote documents sequentially, so a later failure left earlier records rebound. Every document is staged and then renamed; a failure restores all of them and reports any it could not restore. The rollback itself was corrected in the round below.
- `release:verify` marked its cleanup complete before the removal succeeded, so a failed removal was never retried. Cleanup is marked complete only on success, retried in `finally`, and a failure fails the command.
- The record schema verified only positional artifact kinds, so an empty table, a substituted one-row table, an altered header, or a swap between same-kind tables all passed. It now fixes each record table's exact headers and its exact required row descriptors, in order, and the binder validates the whole schema before planning any write.
- Browser Bridge verification checked five required entries and never compared the archive with the build it was packaged from. It is now a closed package contract: entries are compared in both directions with the Bridge `dist` tree, every file the manifest declares — including `action.default_popup` — must exist, and unexpected entries are refused.
- Bridge entries were buffered whole before any bound was applied, so a ZIP bomb could exhaust memory before rejection. Entries are hashed while streaming under a 512-entry, 8 MB per-entry, and 64 MB total uncompressed bound, and a stream that exceeds its declared size is refused.
- The packaged dependency comparison ran packaged-to-checkout only, so a production file missing from the artifact passed unless the smoke test happened to import it. Both directions are now compared across the packaged package set, and a symbolic link in either tree is refused.
- `--bridge=` and `--vsix=` overrides bypassed the pinned release. Every override is checked against the pinned file name and, for the Bridge, its manifest version.
- Bridge resolution followed symbolic links and ignored unpinned sibling ZIP files. It now requires a regular no-follow file and refuses any unpinned sibling archive or directory.
- `SIGINT`, `SIGTERM`, and `SIGHUP` bypassed the snapshot cleanup in `release:verify`. Signal and exit handlers remove the snapshot and then re-raise the signal.
- VSIX verification executed the packaged extension for a module-load smoke test before comparing its production dependencies with this locked checkout, so a tampered dependency inside the archive could run arbitrary code during verification. Every packaged `extension/node_modules/**` file is now byte-compared first, and verification aborts before anything is executed if one differs.
- Which artifacts a record table must name was inferred from headers the document itself controls, so deleting a `Bridge SHA-256` column downgraded a browser result to VSIX-only evidence. The required artifacts of every record table are now fixed in code; removing a column, adding a table, or dropping one fails the gate.
- `release:bind` accepted a terminal dual-artifact row that named only one of the two artifacts. Every artifact column a recorded row declares must now hold a staged hash.
- Bind, check, and verify selected the first readable Browser Bridge archive beside the repository, ignoring `browserBridgeVersion` in `protocol/browser-bridge.compatibility.json`. All three now resolve exactly the pinned version and refuse when an unpinned version is present or the pinned one is missing.
- The Browser Bridge was only hashed and its manifest version read. Its archive is now opened and checked: unsafe or duplicate entry names, required entries, manifest version against the pin, `manifest_version` 3, and every file the manifest declares.
- Provider-terms browser rows named only the VSIX, so a review survived a Bridge rebuild. The review table is split into local and browser providers, and browser rows must name both artifacts.
- `release:verify` called `process.exit(1)`, which skipped its cleanup and left complete copies of both artifacts in the temporary directory. It sets `process.exitCode` instead and always removes its snapshot.
- The blended `maxConsensusRounds`, `consensusRoundsExtendable`, and `consensusRoundLimitRetryable` fields were still exported beside the accurate per-step data, so a consumer could restate the original misreport. They are removed; only `consensusSteps` remains.
- `parseQueuedMessage()` dropped the composer origin, so a queued composer run lost its authorization record across a restart and its execution-time preflight skipped the refreshed refusal. The flag is now parsed and restored, and a queued pipeline request with no recorded origin is blocked with an explanation rather than run unauthorized.
- VSIX verification compared only the packaged manifest's publisher and version, so an artifact carrying stale commands, contributions, or configuration passed. The packaged manifest is now compared to the repository manifest key by key.
- Dual-artifact evidence passed with only one hash while the other was excused, so a browser row could claim a result without naming the Browser Bridge build it ran against. Every artifact a record table declares must now be named in every recorded row, and the live-provider section is split so local-provider and browser-provider rows each declare only the artifacts they depend on.
- `release:verify` reopened the artifact for each check, so an archive swapped and restored between reads could have the checks inspect different bytes. Both artifacts are copied into a private snapshot, every check reads the snapshot, and any drift in the staged copies fails the run.
- Release verification covered only the VSIX. The Browser Bridge ZIP is now part of the verified set, and a missing Bridge fails verification instead of being skipped.
- Consensus limits were reported with `some()` for retryability and a maximum for the round count, so a pipeline mixing policies was misreported. Limits are modelled per consensus step and rendered per step.
- `npm run package` invoked `vscode:prepublish` and VSCE invoked it again, running the whole test suite twice.
- `verify-vsix` derived its byte-equivalence set by recursing into `media/` and `docs/`, so it demanded packaged copies of the screenshots and binding records that are deliberately excluded. `media/screenshots/README.md` already exists, so a freshly built candidate would have failed its own verifier. The set is now derived from `package.json` `files`.
- Per-row artifact provenance accepted either staged hash in any hash column, so the Browser Bridge hash passed in a `VSIX SHA-256` cell. Every hash column now names its artifact, a hash in the wrong column is refused, a generic column is refused, and a row that does not involve an artifact records `not applicable` explicitly. Rows that depend on the Bridge gained a `Bridge SHA-256` column.
- Queued and interrupt composer executions dropped the composer origin, so authorization was checked before enqueue but never rechecked when the request was dequeued. The origin is persisted on the queued request and restored on dequeue.
- The contract advertised a round-limit retry for every consensus step, although `onMaxRounds: "fail"` terminates and `requestArbiterRuling` rules instead. Retryability at the round limit is now disclosed separately from retryability after an invalid round.
- `release:verify` validated the records and then reopened the archive as a second command, so an archive replaced or repacked in between could pass both halves against different bytes. It is one command that fingerprints the artifact before, between, and after both checks.
- The privacy note claimed a run bundle's digest proves the file was not edited. It is self-declared: anyone who edits a bundle can recompute it. It is now described as accidental-change detection, in the document and in the two places the product states it.
- `npm run release:bind` reported a recorded row that named no artifact hash and then rewrote the document binding anyway, exiting 0; `release:verify` accepted those rows because it only validated hash columns that existed. Unbindable evidence is now fatal — the binder writes nothing and exits non-zero unless `--void-unbindable` is given — every record table carries an `Artifact SHA-256` column, and the artifact stage refuses both a record table without one and any terminal row that names no staged hash.
- Voiding a row erased every cell but the first, destroying the provider, OS, browser, and checklist descriptors a tester needs to repeat the test. Descriptor columns are preserved and only evidence fields are reset.
- Both composer refusal checks ran before preflight refreshed the repository policy and the contract acknowledgement, so authority that expanded during preflight was never re-checked. `preflightPipeline` now re-checks composer authorization after the refresh, for composer-originated runs only.
- Candidate creation demanded a screenshot of the exact packaged build while `media/` shipped inside that build, so capturing one and adding it changed the artifact it was supposed to prove. `media/screenshots/` is no longer packaged, and the screenshot check moved from the identity stage to the evidence stage.
- Resume asserted cancellation before `restoreRun` but not after it, so integration reset, master-conversation creation, and task-worktree removal could still run after disposal.
- The contract said a granted consensus retry adds `maxConsensusRounds`; an invalid-consensus retry adds one. Both are now stated exactly, and a consensus-only pipeline no longer claims checklist sub-runs it never starts.
- The manager's immediate `pipeline.run` path never reached the runtime's run refusal, so one of the two composer paths still started runs with no resolved working root or an unacknowledged contract. The runtime now exposes `pipelineRunRefusal()` and both message paths call it. Programmatic and orchestrated runs are unaffected: they carry their own explicit authorization.
- Disposal during orchestration startup could still land between the ledger write and `begin()`, leaving an active-run pointer for a run that never started. Every await boundary in start, checklist start, and resume re-asserts cancellation.
- `package.json` declared both a `files` property and a `.vscodeignore`. VSCE 3.9.2 exits non-zero on that combination, so packaging could not run at all. There is now one strategy — `files` only — with the four artifact-binding records excluded by name, and a test that fails if the packaged documentation set drifts.
- Packaging still required human evidence before the artifact that evidence describes existed. Candidate creation and release validation are now separate: `vscode:prepublish` checks identity only, `npm run package` builds and prints the candidate's SHA-256, and `npm run release:verify` is the publication gate that checks identity, evidence, and binding together.
- `npm run release:bind` treated any non-empty table cell as recorded evidence, producing false "unbindable" reports that `--void-unbindable` could then erase, and it skipped the verdict document. Rows are now routed by their own result column, the verdict is bound but never voided, and the binder plans every document before writing any so a malformed table refuses the whole operation.
- Published decisions were not filtered to the current execution, so a rerun that produced no new decision inherited the previous ruling, unresolved risks, and consensus classification.
- A consensus step declaring `onMaxRounds: "fail"` was reported as finally bounded, but an invalid consensus round always offers a human retry that raises the limit. Any consensus step now reports that its bound is human-extendable.
- Sealing an untracked file used `lstat` then `copyFile`, leaving a window in which the path could be replaced by a symbolic link. The file is opened once with `O_NOFOLLOW`, verified through that descriptor, and copied from it.
- A run bundle's digest covered only the run section, so the recorded version and export time could be rewritten and still verify. The digest now covers all three, and an unknown bundle version reads as unrecorded rather than verified.
- The packaged README linked release documents that are not packaged, and the compatibility matrix claimed it ships inside the artifact.
- `submitMessage()` kept its own weaker guard, so Ctrl/Cmd+Enter started runs that the Send button refused: no working root, unresolved readiness findings, or an unacknowledged execution contract. The submit path now *is* the blocker list, and the runtime refuses a run with no resolved working root or an unacknowledged contract regardless of who asked.
- Sealing an untracked symbolic link copied the file it pointed at, so a link could pull content from outside the repository into the agent's worktree. Symlinks and non-regular files are refused, and the canonical source must resolve inside the repository.
- Disposal during orchestration startup was still unsafe: startup had no cancellation, and a drain that timed out was logged and then followed by releasing Git ownership. Startup now carries an abort controller checked at every irreversible boundary, and a drain that does not complete quarantines ownership instead of releasing it.
- Packaging was still circular in the other direction: the artifact-binding records were packaged inside the VSIX whose hash they name, so binding them changed the hash they had just recorded. They are excluded from the artifact, `verify-vsix` fails if one reappears, and the source stage no longer demands cells that only exist once the artifact does.
- The generated repository-policy profiles refused most of the pipelines they approved. Every profile that names its approved pipelines now refuses none of them, and the wizard lists exactly which built-in pipelines a profile will refuse before it writes the file.
- `Bachata: Replay Run Bundle` refused only a mismatched digest, so deleting the `integrity` block made a tampered bundle replayable. Replay now requires a verified digest, and says plainly that the digest proves the file did not change, not who produced it.
- Text, log, Markdown, and JSON attachments were advertised but rejected by an image-only allowlist that ran before the type was derived.
- TODO Setup recorded itself complete before starting orchestration, so a cancelled or failed start still counted as finished.
- The execution contract reported "at most N" consensus rounds and participant turns while a human retry raises the limit. It now exposes whether the bound is human-extendable and says the number holds until a human grants more.
- The paired managed fix advertised `workspace` write authority although it writes only inside isolated task worktrees. A pipeline that executes a checklist now contributes isolated task scope.
- A unanimous consensus with no arbiter had no `rulingBy`, so the final assessment classified it as controller or single-provider. A published decision now marks the ruling as consensus, and the flag survives reload and merge.
- `Bachata: Bootstrap Verifiers and Repository Policy` silently wrote to the first workspace folder in a multi-root window; it now asks which repository the files belong to.
- A retained recheck ran its checks inside the mutable integration worktree while export and apply built their patch from the immutable integration tree. Checks could therefore approve bytes that were never applied. A recheck now materialises a throwaway repository from the run's baseline commit plus the exact export patch and runs there, under the same shared-resource lease, mutation detection, and cancellation as verification during the run. If the retained worktree changes while checks run, the recheck is refused instead of recorded.
- A recheck ran only the final check commands and then replaced the whole evidence aggregate, so passing final-only evidence hid stale task checks. A recheck now runs every recorded command, anything it did not re-run is marked stale, and stale evidence blocks Apply.
- Startup, retained recheck, and retained apply were not tracked as orchestrator operations. `stop()` could return without stopping them and `dispose()` could release Git ownership while they were still running. Every public orchestrator operation is now tracked; `stop()` aborts maintenance and drains tracked work, and `dispose()` drains again before releasing ownership.
- A file or hunk subset inherited the full run's accepted result and was checked only with `git apply --check`, so a subset that broke a dependency the full run satisfied could be staged as accepted. Bachata now materialises the selected composition on the run's baseline and runs the run's checks against exactly those bytes before staging anything. Apply is refused when the selection alone does not pass.
- `ResourceBroker.acquire()` checked disposal once, and `dispose()` snapshotted leases before setting `disposed`, so a concurrent acquisition could escape cleanup or race the closed SQLite database. Disposal is now set first, re-checked at every wait iteration and at grant time, and `dispose()` drains in-flight acquisitions before closing the database.
- Adversarial-input redaction failed its linear-complexity gate under parallel test load. Each redaction rule is now skipped unless its literal marker is present in the input; 2 MB of marker-free text redacts in about 13 ms.
- Packaging was circular: metadata validation demanded records bound to an existing exact VSIX, and `npm run package` ran that gate before creating the new artifact. `vscode:prepublish` now runs the artifact-independent source stage, and `scripts/package.mjs` runs the artifact-bound stage after the VSIX exists.
- The release-metadata gate copied the VSIX version from the working `package.json` and hardcoded the Bridge version, so version-mismatch validation could not fail. Both versions are now read from the archives themselves, and `verify-vsix` refuses a VSIX whose publisher or version differs from the repository.
- Stale-artifact detection compared only a few entry and webview files. Every packaged `extension/dist/**` file and every shipped document must now match the local build byte for byte, and a packaged runtime file the build cannot vouch for is refused.
- Verification provenance was stamped from the mutable `conversation.updatedAt`, so renaming or archiving a run changed the displayed verification time. It now comes from the checks' own completion times, or from the verification event.
- `composerCanSubmit` ignored readiness findings, so Send could appear enabled while a provider or pipeline was not ready. It is now defined as "no send blockers", so the button and the blocker list cannot disagree.
- The Result Center diff cache exempted the current entry from its 8 MB bound, so one oversized response could stay far above the intended total. An oversized current entry is now dropped with an explicit truncation notice.
- Benchmark fix correctness trusted self-recorded findings and never used the committed reference implementation, and the paired fix arm required no verification at all. A fix run must now commit the files it produced and match the reference, and a task whose arms are held to different proof is refused before it is scored.
- `README.md` and `CHANGELOG.md` said hunk-level apply is not implemented while the source and tests implemented it.
- The execution contract read only agent-level permission modes, so a pipeline that granted write access in a step — `debug` does — resolved as read-only. Step-level permission modes now count, and `debug` reports the interactive authority it actually has.

### Added

- `paired-managed-fix`: the flagship Fix workflow. Both providers diagnose independently and converge on the root cause, one implements inside the declared write scope with no commit authority, the other cross-reviews the change, and the controller runs the declared verification. The accepted work waits in a retained worktree for file or hunk selection. It is now the preferred paired Fix pipeline in Setup.
- The execution contract now discloses the whole run budget: the maximum consensus rounds per consensus step and the worst-case number of participant turns for the entire run, alongside the existing iteration and timeout limits. A pipeline that embeds checklist execution says so instead of implying the turn count is complete.
- The execution contract now carries provenance: the extension version, the SHA-256 of the exact pipeline definition, and per provider the configured model and the detected provider runtime version. Anything not known is stated as `unreported` rather than omitted.
- `Bachata: Bootstrap Verifiers and Repository Policy`. It proposes verifier descriptors from what the repository already declares — npm scripts, Cargo, Go, or Python project files — never proposes a browser acceptance script, shows the exact `.bachata/verifiers.json` before writing it, validates it against the descriptor rules, and then offers a curated `.bachata/policy.json` profile: read-only repository, verified changes only, or isolated changes only.
- Every contract now carries an assurance label — read-only, unverified, model-reviewed, controller-verified, or controller-verified and isolated — derived from what the pipeline actually declares. Setup shows it per workflow mode, and the composer shows it next to the safety level with the sentence that says what it does and does not prove.
- Every exported run bundle now records a SHA-256 digest of exactly the run section it carries. `Bachata: Inspect Run Bundle` reads a bundle read-only — integrity verdict, run identity, providers, verification, changed files, evidence ledger, unresolved risks, and final assessment — without creating a run, and `Bachata: Replay Run Bundle` refuses a bundle whose digest does not match the file.
- Resumable Setup. Setup now records the goal you picked before you finish, and a later `Bachata: Setup` offers to continue from it or to start over. It is recorded as complete only once the run is actually created.
- Sealed working-tree input. When the tree is dirty, `Bachata: Run TODO.md` lets you seal selected staged or unstaged changes as the run's starting point. Bachata copies them into the isolated run worktree and records the resulting tree object under `refs/bachata/input/<run>` — a tree, not a commit, so Bachata still creates no commit anywhere. Your branch does not move and your index is untouched. The run's diff is measured against that sealed input, so applying the result never re-applies your own changes. Unsealed dirty paths still block the run.
- Bounded text attachments alongside images. A run can now carry `.txt`, `.log`, `.md`, and `.json` files under the same per-attachment and per-task byte limits. Text is validated as decodable UTF-8 before it is stored, and both providers receive it as a text content block, not as an image.
- `npm run release:bind` rewrites the `Artifacts under test:` binding lines and artifact tables from the staged artifacts, and voids every recorded row whose artifact changed, so rebinding can never silently carry an old validation result onto a new build.

### Changed

- `README.md` leads with what Bachata is: the local approval and evidence layer between coding agents and your repository. Each workflow now carries one of four assurance labels — read-only, model-reviewed, controller-verified, isolated-and-applicable — and the table states where each workflow's changes land.

## Review round: contract-aware evidence, execution identity, single-provider workflows, repository policy

### Fixed

- Export policy exclusions were applied only to the Markdown and SARIF evidence reports. The JSON run bundle kept excluded paths in its transcript, events, structured outputs, iterations, and result while the export claimed the rule was applied. Every bundle section is now structurally filtered before rendering, excluded scalar values are replaced, and the omission line reports the total.
- Terminal run evidence was cached by conversation `runRef` alone, so a second execution of the same conversation could inherit the previous execution's changed files, checks, ruling, risks, worktree, and handoff binding. Evidence now carries the execution identity of its `run.started` event, rotates when a new execution starts, and refuses to merge across executions.
- The stable release gate searched for literal pending markers and accepted an arbitrary one-line record as evidence. It now parses each record table structurally, requires every cell, an ISO date, and a terminal verdict, hashes the staged artifacts itself, and binds every record to the artifact it was produced from.
- `docs/RELEASE_VERDICT.md` is the single authoritative, artifact-bound verdict. Obsolete parent-level verdict and release-spec records contradicted the source and were removed.

### Added

- Contract-aware evidence. Every evidence line is `recorded`, `not applicable`, or `expected but missing`, read from what the pipeline actually declares. A successful read-only review no longer reports three evidence gaps for evidence it never promised.
- A typed final assessment on every run: accepted, rejected, inconclusive, or not applicable, with the method that produced it (model consensus, single provider, or controller verification) and its provider provenance.
- Single-provider `codex-plan` and `claude-plan`, and deterministically verified `codex-fix` and `claude-fix`. Plan and Fix no longer require both providers.
- `managed-fix`: a bounded fix with an explicit write scope, declared writable and protected paths, no commit authority, and controller-owned verification.
- Controller verification now runs for any interactive pipeline that declares `managedPolicy.verificationChecks`, and its results are recorded as run evidence.
- `.bachata/policy.json`: the repository's own cap on approved pipelines, widest write scope, commit authority, allowed verification operations, protected paths, and required human gates. Local settings and pipeline definitions can only narrow it. Refusals appear in the contract and preflight refuses to start. See `docs/REPOSITORY_POLICY.md`.
- Contract acknowledgement. The contract opens for a new run and reopens whenever its authority changes; when authority materially expands it shows the authority diff and refuses to send until it is acknowledged. Narrowing never asks again.
- Git-native review scopes: `Bachata: Review Uncommitted Changes`, `Bachata: Review Branch Against Base`, `Bachata: Review Commit`, and `Bachata: Review Commit Range`. Refs that could inject an argument or a range are refused.
- `Bachata: Publish Findings to Problems` puts failed checks, unresolved risks, located ruling findings, and missing evidence into the Problems view. A finding that names a path outside the repository is never published to a file.
- `Bachata: Replay Run Bundle` creates a new run from an exported bundle and states pipeline, provider, extension-version, and working-directory drift first. A missing pipeline blocks the replay.
- `Bachata: Explain Pipeline` resolves any pipeline into a read-only explanation of providers, effective role authority, scope, verification, gates, fallback order, limits, completion, outbound context, and policy refusals, without creating a run.
- `Bachata: Repository Verifiers` lists declared descriptors, copies a `bachata:verifier:<id>` command, and offers a template when `.bachata/verifiers.json` does not exist. `.bachata/verifiers.json`, `.bachata/policy.json`, and `.bachata/export-policy.json` now report validation errors in Problems on the offending line.
- Selective apply: choose individual changed files in the Result Center and apply or export a patch for only those. Bachata refuses any path the run did not change.
- `npm run validate:local <repository>`: a headless validator for `TODO.md`, pipelines, `.bachata/verifiers.json`, `.bachata/export-policy.json`, `.bachata/policy.json`, and every resolved contract.
- `npm run docs:policy` and `npm run check:policy-docs`: verification-policy prose in `README.md`, `docs/PIPELINES.md`, `docs/ORCHESTRATION.md`, and `docs/VERIFIERS.md` is generated from the same constants execution uses, and the test suite fails on drift.

### Changed

- "Fix bug" is described as diagnosis and implementation inside a declared write scope. The `debug` pipeline states plainly that its verification is a second model review, not a controller-owned check.
- `README.md` no longer claims runs are reproducible; it states that a run can be replayed with its drift stated.

## Review round: readiness correctness, guardrail-first onboarding, evidence handoff

### Fixed

- Readiness accepted an incorrectly nested protected path: `nested/.bachata/pipelines/evil.pipeline.json` matched an allowed `.bachata/pipelines` root, so Doctor could report ready while execution preflight rejected the same workspace. Allowed dirty paths now match only an exact root-relative path or its descendants, with normalized separators, and absolute or traversal-shaped candidates are refused.
- Git porcelain status parsing trimmed each line before slicing its status columns, which corrupted unstaged paths (` M .bachata/x` became `air/x`) and made readiness disagree with preflight.

### Added

- Repository-owned deterministic verifiers: `.bachata/verifiers.json` declares fixed executable, arguments, working directory, environment allowlist, timeout, output bound, and expected result. Autonomous verification accepts `bachata:verifier:<id>` descriptors; a model selects an id and never writes a command. Shell and process wrappers are refused, `.bachata/` is a restricted path for managed mutation, and preflight blocks a run that names a missing or invalid descriptor. See `docs/VERIFIERS.md`.
- Inspect and apply handoff: a retained run can export its patch, rerun its approved checks, or stage its accepted work on your current branch without creating a commit. Applying refuses, without touching the working tree, on a dirty repository, a detached HEAD, an extension-owned branch, a diverged baseline, or a patch that no longer applies; the run worktree is kept in every refusal.
- Evidence exports in Markdown and SARIF 2.1.0 alongside the run bundle, for review tooling and IDE diagnostics.
- Export preview: every export opens its exact bytes in an editor and states its applied redaction rules and size before it is written. `.bachata/export-policy.json` adds repository-owned literal redactions and excluded path prefixes.
- Outbound context preview: the run contract states, per provider, what is sent, what is selected at run time within which byte bounds, what is never sent, and that outbound text is not rewritten.
- `Bachata: Local Data` lists every local store with its exact path and size, states what deleting each removes and keeps, and offers confirmed cleanup of archived-run data older than `bachata.localDataRetentionDays`.
- TODO authoring: line-level diagnostics with quick fixes, metadata and verification completion, snippets, and `Bachata: Preview TODO Plan` with execution order, dependency graph, cycles, and overlapping write scopes.
- `Bachata: Workspace Ownership`: release ownership from the owning window, request it from another, with stale-owner reporting. A live lease is never taken away.
- Participant comparison side by side with candidate hashes, per-participant objections, risks, and validation errors, plus an iteration comparison of rulings and how risks changed between them.
- `npm run check:release-metadata` blocks packaging while publisher identity, repository, homepage, issue, support, screenshots, the public Browser Bridge acquisition URL, provider documentation URLs, or any pending row in the release validation, provider terms, or compatibility records is still a placeholder.

### Changed

- The walkthrough completes on outcomes, not on invoked commands: a provider that actually answers, Doctor with no blocking finding, a selected read-only workflow, a finished review, and its evidence read.
- Provider remediation is provider-specific: the exact failed prerequisite, numbered steps, a terminal probe, the override setting, documentation, and a recheck of only that probe instead of a full Doctor run.
- Setup asks only guardrail questions and states the resolved guardrails — providers, working root, write authority, paths, checks, commit policy, completion policy, human decisions — before creating a run.
- The full pipeline editor is behind `bachata.advancedMode`; the default view keeps only the guardrails a first run needs.
- A disabled Send now lists every blocking condition, what is required, and a direct fix where one is safe.
- The CI/CD run view is now the Execution view. It never integrated with a deployment pipeline.
- Renamed the product to `Bachata`, with lowercase technical namespaces and capitalized prose and UI. See `docs/BRANDING.md`.
- Positioning: a local safety and evidence controller for agentic repository work, for experienced Git users and risk-sensitive teams.

## Review round: contract parity, correlated recovery, byte-safe search, verified artifacts

- The execution contract now mirrors the runner's verification precedence: a managed policy's checks override role checks instead of being unioned with them, so displayed completion criteria match the checks that actually execute.
- Recovery evidence is correlated: an agent recovery or provider fallback clears only the failing agent and step, a run resume clears only run-scoped errors, and an answer clears only its own agent and step.
- Merged persisted and live results reconcile classifications, so one error can never appear as both unresolved and recovered; the newer projection decides.
- History scanning is byte-exact for UTF-8: multi-byte characters and surrogate pairs are never split, and consumed bytes never exceed the budget.
- Prepared drafts are stored synchronously in webview state on every keystroke, survive panel disposal before the debounce fires, and reconcile with catalog state on reload.
- VSIX verification no longer executes code from the archive, rejects duplicate and unsafe entries, and compares every shipped first-party file — package.json, presets, protocol contracts, process scripts, media, README, changelog, and license — against the working tree in addition to the runtime build.

## Review round: contract authority, export privacy, evidence durability

- Compatibility errors now name the step, the provider and its adapter, and the missing ability in plain words, and say what to do about it; readiness findings use the same wording instead of raw capability identifiers.
- The run contract shows readable provider names (Codex CLI, Claude Code, ChatGPT browser, Claude browser, Generic browser) alongside each agent.
- Doctor guides Browser Bridge setup step by step — install, discover, pair, open the conversation, bind a role — and can open the Browser Bridge documentation.
- Human E2E, live smoke, and stable-gate documents now require checks for the run contract, safety levels, TODO confirmation and refusal, draft durability, multi-root binding, result provenance and handoff, export privacy, and search truncation.
- VSIX verification now compares every packaged runtime file — the extension entry, webview bundles, webview asset manifest, stylesheet, Codicon assets, and Prism runtime, theme, and components — against the current build and rejects a stale artifact.
- Export redaction now removes provider-prefixed catalog identity fields (`providerSessionId`, `providerConversationUrl`, `providerConversationIdentity`, `providerMessageCursor`), document tokens, and tab/frame identifiers.
- The execution contract reports per-role managed authority — write scope, writable/readable/protected paths, commit policy, and verification per role — plus a conservative aggregate, so a managed role with task scope and commits is no longer shown as interactive workspace-wide with commits prohibited.
- A pipeline with any managed role is classified as managed implementation.
- TODO readiness resolves task and Master pipelines through the TODO workspace root's own pipeline catalog scope instead of the active conversation's scope.
- Result Center merges persisted terminal evidence with live projections instead of replacing it, and keeps the persisted status when no live run state exists.
- Transcript errors count as recovered only when the same agent and step later answered, or an explicit recovery event followed.
- Prepared drafts persist user edits (debounced) until the run starts or the draft is cleared.
- History search walks values without full serialization, stops inside its byte budget, guards cycles and depth, and reports truncation in the run drawer.
- VSIX verification requires the webview runtime assets declared by the packaged code (`webview.css`, Codicon CSS and font, Prism runtime, theme, and components).

## Release integrity and run contract

- Removed provider conversation URLs, session identifiers, and conversation identities from exported run bundles, and made the stated omissions match what the export actually removes.
- Bound Review File, Review Selection, Review Staged Diff, Fix Diagnostic, and Setup runs to the repository that owns the target, with an explicit repository pick in multi-root workspaces.
- Fix Diagnostic now prepares the diagnostic under the cursor instead of the first diagnostic in the file.
- Setup "Run TODO.md" starts TODO orchestration; its readiness now runs the full orchestration preflight (Git baseline, TODO.md, task metadata, task and Master pipelines).
- Prepared command drafts persist until the run starts or the user clears them, including across panel reloads and restarts.
- Completed-run evidence (changed files, checks, rulings, blockers, transcript errors) persists and is replayed in Result Center after a restart.
- Result Center separates unresolved risks from recovered errors, records which provider ruled, and lists the providers that produced the run.
- Result Center hands off to VS Code: reveal a changed file, open its diff, open Source Control, reveal retained worktrees, export sanitized evidence.
- Generic browser readiness now requires verified send, verified completion lifecycle, confirmed interruption, and confirmed conversation state, matching managed execution.
- Agent-specific adapter readiness is no longer masked by a general provider probe, and a reported agent failure is no longer masked by an available probe.
- A dirty permitted `.bachata/pipelines` catalog no longer blocks readiness for its own checklist pipeline.
- History search binds results to the query that produced them and runs under a global work budget.
- Browser Bridge builds clean `dist` first, package from an exact allowlist with manifest-reference checks, derive the artifact name from the package version, and publish atomically.
- Browser Bridge ZIP verification validates headers, compression, sizes, bounds, duplicates, names, and archive structure instead of accepting malformed archives.
- Source-distribution and VSIX verification now require legal, manifest, protocol, runtime, and build inputs positively.
- Added an execution contract: every run states providers, scope, commit policy, verification, limits, fallback, human decisions, and completion criteria before it starts; TODO orchestration requires explicit confirmation of that contract.
- Added visible safety levels (review, interactive implementation, managed implementation, TODO orchestration) in Setup and the run contract.
- Grouped settings so essentials stay separate from advanced limits, timeouts, and browser internals.
- Upgraded AJV to 8.20.0, clearing the outstanding dependency advisory.

## Release candidate hardening

- Made the VSIX self-contained, added artifact module-load verification, and bundled complete project/Codicon/third-party license notices.
- Fixed duplicate command registration after workspace-ownership retry failure.
- Made Doctor use the active workspace cwd and production-restricted environments; Git version detection now fails closed.
- Preserved non-editor disclosure state across webview rerenders.
- Added explicit task/configured/workspace/read-only write scopes; task scope derives from user-mentioned paths and empty bounded scope fails closed.
- Added bounded managed `context.tree`, package-first inventory, nearest-project TypeScript resolution, cumulative browser-conversation rollover, fresh per-task role sessions, typed recovery errors, and zero-byte hashing.
- Bound verification evidence to the exact workspace fingerprint and restricted autonomous verification to controller-owned workspace-integrity and project-check operations.
- Enforced no-commit autonomous execution and canonical task-scope/post-turn audits across managed browser, Claude Code, and Codex paths while preserving local Claude Code/Codex as first-class developer authorities.
- Added a bundled managed Claude Browser pair and updated release claims to distinguish source/static validation from authenticated live-provider validation.

## 0.6.12

- Added one wall-clock deadline for ordinary browser action loops, immediate rejection of already-aborted browser/local-model requests, and dynamic Generic autonomous capability checks from the exact bound session.
- Preserved the exact initial-context omitted-file total separately from its bounded preview, improved whole-inventory path relevance promotion, and report typed repository-inventory truncation causes.
- Disabled experimental selector healing by default until the configured runtime/model is validated and made unattended pipeline preflight reject human-gated paths.
- Added one persisted managed-task wall-clock deadline across context preparation, Worker, Lead, and revision turns, plus bounded continuation serialization and deduplicated context reinjection.
- Bounded large handoff metadata with explicit coverage/omission counts and paged retrieval for truncated task/metadata state, refreshed selected source content before handoff, and supported managed Git baselines before the repository has an initial commit.
- Added browser-session capability gating so manual-only, synthetic-send, or uncertain Generic conversations cannot enter unattended managed execution.
- Separated workspace integrity, controller project checks, and configured project-check evidence while keeping configured commands controller-owned, no-commit guarded, and Git-observational.
- Made blocking approvals/gates visible from both run views, added pending CI/CD counts, and fixed final-ruling participant navigation across views.
- Added stable-release gates for browser providers and exact local-interpreter configurations without telemetry or remote diagnostics.
- Enforced browser inventory/search/action ceilings in the runtime even when settings are hand-edited, bounded resident-index candidate examination, and made oversized directory listings fail explicitly instead of allocating an unbounded entry array.
- Allowed only the controller's freshly provisioned browser session to attach during an active workflow, required a confirmed fresh generic conversation on first programmatic acquisition, and kept manual mid-run session switching blocked.
- Bounded managed-browser repository inventory and nonresident search by path count, bytes, per-file size, and elapsed time; added revision-bound continuation cursors and bounded excerpts for very large/minified matching lines.
- Made ranged context reads return explicit range-only hashes, added an explicit full-file hash action for patch preconditions, and stopped ranged reads from traversing to EOF solely to compute a file hash.
- Increased managed browser action budgets for large-repository workflows, clarified controller verification scope, recycled prior browser tabs only for fresh programmatic iterations, and corrected the Protocol v9 compatibility contract checksum.
- Added a fail-closed maintained-source exporter/validator so source deliveries exclude dependency locks, build/test/runtime/cache artifacts, nested archives, generated reports, VCS metadata, and symlinks.
- Source verification no longer writes generated JSON reports into the project tree, preventing validation itself from contaminating a later source export.
- Made stale pipeline-catalog recovery race-safe by publishing reclaim intents before removing abandoned locks; fresh contenders back out while reclamation is active, and stale intents are recoverable with bounded waits.
- Removed the unused per-request local-model queue setting, propagated bearer authentication consistently to Ollama discovery/chat requests, and aligned semantic-interpreter tests with the candidate-ID-only protocol.
- Revalidated workspace mutation parents and leaves immediately before link, rename, unlink, and directory removal to narrow external filesystem replacement races.

- Split loopback-only browser selector-healing configuration from optionally remote semantic interpretation and refresh healer settings on live Bridge connections.
- Recheck expected file hashes immediately before existing-file writes, file deletes, and patch application; new-file writes use atomic no-clobber publication.
- Distribute initial context coverage across large repositories, continue filling capacity after unreadable/oversized samples, promote changed and explicitly named source files at index capacity, support Unicode relevance tokens, and remove a CommonJS `exports` shadow that could crash context indexing at runtime.
- Added the managed GPT browser Worker/Lead pipeline with explicit role identity, shared ChatGPT-account capacity, structured controller handoffs, and one bounded revision cycle.
- Wired bounded TS/JS context indexing, import expansion, safe directory/text-file reads, selected spec ingestion, source hashes, repository diff evidence, and context invalidation after edits into the active browser runtime.
- Made the controller authoritative for managed actions: Lead is hard read-only, mutations are path/symlink/hash checked, verification uses only declared check IDs, and required checks gate Worker handoff and Lead acceptance.
- Restricted the optional local Qwen/Bonsai/DeepSeek interpreter to controller-created read/search candidate IDs with LM Studio/Ollama, bounded concurrency, strict validation, and abstention on malformed or incomplete classifications.
- Added generic browser adapter registration and provider-resource routing with bounded queues, shared-account circuits, typed provider failures, and side-effect-aware fallback.
- Made managed no-commit orchestration persist uncommitted integration state as Git tree objects instead of task or integration commits, including restart, rollback, cleanup, and accidental task-commit recovery.
- Added managed architecture, focused protocol/policy, and no-commit regression gates to the normal release checks.
- Advanced the paired browser transport to Browser Protocol v9 for explicit local-model selector-healing configuration.
- Hardened managed completion, repository baselines, exact-path evidence, credential-path protection, and read-only verification so unfinished or policy-violating work cannot be reported as complete.
- Added lazy Codex/Claude quota fallback to distinct GPT browser Lead/Worker sessions with exact task scope, SHA-256 stale-write preconditions, single-writer fencing, and arbitrary browser shell execution disabled.
- Normalized accidental agent commits back to the no-commit task baseline before verification while retaining file edits, and added Claude pre-tool enforcement for read-only, scoped, secret-path, and shell restrictions.
- Made managed revision routing state-driven for zero through two bounded revision cycles and preserved actual fallback-agent provenance.

## 0.6.10

- Freeze every enabled `executeChecklist` task pipeline into the accepted parent execution snapshot, including its normalized definition, SHA-256 revision, and storage scope.
- Persist exact task and Master pipeline snapshots in generated-checklist and top-level `TODO.md` orchestration so pending tasks, retries, restarts, and recovery cannot substitute edited, deleted, or upgraded definitions.
- Reject missing, invalid, scope-mismatched, or nested checklist task pipelines before any provider starts, and fail closed for legacy orchestration state without verifiable task or Master snapshots.
- Replace the structured editor's free-text task-pipeline field with a scope- and revision-aware selector.
- Invalidate a persisted pipeline scope when its workspace root is removed, clear the stale working directory, detach the old catalog, and block multi-root submission until a valid root is selected.
- Prevent duplicated runs from carrying a removed workspace root or its custom pipeline into another active root.
- Added regression coverage for immutable child definitions across edits, deletion, retries, and restart; exact Master reuse; missing and nested child rejection; selected-root removal; restart persistence; duplicate fallback; and task-pipeline selector behavior.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.9

- Coordinate custom-pipeline mutations by canonical physical catalog directory across runs and workspace definitions through the profile-wide broker, with a token-checked filesystem lock covering separate local VS Code profiles.
- Prevent suspended live writers from being reclaimed as stale, reclaim confirmed abandoned local locks, and publish pipeline files with create-if-absent conditional commits instead of overwrite-by-rename.
- Treat Linux zombie-only process groups as terminated in runtime and script cleanup, avoiding false cleanup failures without treating a live descendant as gone.
- Canonicalize multi-root pipeline scope while retaining the original workspace path for display, and reject `.bachata` or pipeline paths that resolve outside the selected workspace root.
- Watch external custom-pipeline file changes and revalidate the selected custom definition immediately before direct execution.
- Require exact `<pipeline-id>.pipeline.json` regular files and fail the complete custom catalog closed when a file is invalid, misnamed, symbolic, duplicated, or collides with a built-in preset.
- Preflight `executeChecklist` Git state before any provider turn, permit only the active custom-pipeline catalog to be dirty for that embedded flow, enumerate every untracked file, and keep top-level TODO orchestration strict.
- Added regression coverage for independent physical writers, external edits, live and abandoned locks, symlinked roots, escaping catalog symlinks, invalid catalog entries, early Git preflight, tracked edits, untracked files, and rename boundaries.
- Corrected the human E2E document so scripted graphical coverage, committed non-graphical regressions, and required manual multi-window checks are stated separately.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.8

- Persist the exact validated pipeline definition, SHA-256 revision, and storage scope for queued work, interrupted recovery, iterations, and run history.
- Fail closed for legacy queued or recoverable work that has no verifiable pipeline snapshot; blocked queue entries remain cancellable and invalid recovery is recorded in durable history.
- Added one manager-owned, root-scoped custom-pipeline catalog for all runs in an Extension Host, with serialized mutations and catalog refresh across open runs.
- Reject stale Save and Delete requests with compare-and-swap revisions, and reject New or Import collisions instead of silently overwriting an existing custom pipeline.
- Scope duplicate custom pipeline IDs to the selected workspace root so multi-root runs never load or edit another root's definition.
- Store no-workspace custom pipelines in shared extension storage, independent of any conversation lifecycle.
- Migrate legacy global custom pipelines into every available workspace scope and extension-local storage without replacing existing files, and retain the legacy source until every required write succeeds.
- Changed the bundled cross-reference flow to review, converge, and select checklist work without repository modification; unchecked execution is no longer the first-run default.
- Renamed the TODO Stop control to state that active pairs and checks are interrupted, and corrected pipeline-editor copy guidance.
- Added regression coverage for immutable queue and recovery snapshots, legacy fail-closed migration, stale cross-run writes, deletion propagation, multi-root identity, no-workspace persistence, and revision-aware webview mutations.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.7

- Reject known TODO metadata keys when their nested Markdown list marker is missing.
- Track successful verification descendants across new POSIX sessions before releasing declared resources.
- Run Windows verification commands inside a kill-on-close Job Object and verify that the job is empty before reporting cleanup success.
- Resolve Windows command shells and Job Object hosts from `SystemRoot`, `SYSTEMROOT`, or `WINDIR`.
- Use the same process-scope cleanup for command availability checks, bounded test commands, isolated test files, and the human E2E runner.
- Package the process-scope runtime and Windows Job Object host with the extension.
- Document the Windows Job Object guarantee and the supported POSIX scope-tracking boundary without presenting process cleanup as an operating-system sandbox.
- Retry transient build-output cleanup failures before compiling a fresh `dist/` tree.
- Increased the Codex adapter test-only startup bound to remove cold-load timing sensitivity without changing production timeouts.
- Require Browser Bridge 0.6.5.

## 0.6.6

- Reject every unknown TODO metadata-shaped key, invalid `global:` casing, and resource declarations without matching verification commands.
- Keep workspace writer identity stable before and after the workspace storage directory is created through a symlinked ancestor.
- Terminate surviving POSIX process-group descendants after otherwise successful commands before releasing shared resources.
- Require lockfile validation in prepublish and direct packaging paths.
- Require Browser Bridge 0.6.4.

## 0.6.5

- Derived workspace-writer ownership from the immutable VS Code state-storage location and persisted composite resource-key plus fencing-token identities.
- Added startup stale-owner grace so a window opened immediately after system wake cannot revoke a live pre-sleep owner; genuinely stale owners are reclaimed after the grace interval.
- Made TODO metadata fail closed for unknown keys, malformed integers, invalid resources, duplicates, and conflicting verification declarations.
- Terminated detached child process groups when test wrappers receive SIGINT or SIGTERM and put the complete human E2E fixture lifecycle under cleanup protection.
- Strengthened graphical TODO E2E assertions for Master scheduling, terminal review, task verification, and final verification.
- Added concise webview and popup status announcements, completed remaining control labels, and centralized the Browser Bridge message-size default.
- Made release packaging fail closed when `npm ls --all --package-lock-only` detects an incomplete dependency graph.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.4

- Made queued enqueue, start, cancellation, pause, resume, recovery adoption, and restart reconciliation commit durable state before publication or execution.
- Added a persisted queued-start claim so uncertain startup cannot silently lose, duplicate, or execute work in a different repository.
- Blocked working-directory changes while durable task state exists and staged complete replacement provider topologies before preserving history across directory changes.
- Made workflow recovery creation and discard persist-before-publish, and kept committed queue, recovery, and browser-routing operations authoritative when audit-only transcript writes fail.
- Made Browser Bridge conversation selection roll routing back on persistence failure and made conversation rename clone, persist, then publish.
- Pinned exact `@vscode/vsce@3.9.2` as a development dependency and removed the ad-hoc packaging installation path.
- Added late-failure, restart, cancellation-race, duplicate-recovery, directory-contamination, browser-routing, workflow-recovery, and rename regression coverage.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.3

- Made task reset, pipeline activation, custom-pipeline Save/Delete, conversation create/select/archive/delete, and TODO cleanup recoverable after late filesystem, catalog, provider, Git, or state-persistence failures.
- Replaced recent-transcript pipeline mutability checks with durable task state so old history, queued work, resumable workflows, and attachments cannot be erased after transcript-window rollover.
- Staged replacement provider topologies before task reset or pipeline activation, preserving the active adapters on failure and using the target working-directory environment on success.
- Added recoverable conversation-deletion tombstones, transactional catalog updates, retryable initialization, complete failed-creation cleanup, and startup reconciliation for interrupted lifecycle operations.
- Persisted TODO `abandoning` and `cleanupPending` intent before Git destruction and made startup reconciliation finish interrupted cleanup idempotently.
- Restricted Codex and Claude availability probes to the same allowlisted environment as real provider processes and made provider executable settings machine-scoped.
- Added semantic selected-state and live error announcements, visible no-run TODO command feedback, and shared cross-platform process-tree termination.
- Expanded the guarded graphical E2E to create its first run and pipeline through the UI, recover a Git-backed TODO run across Extension Host processes, clean and abandon TODO runs, and exercise a controlled Protocol v8 Browser Bridge peer.
- Restricted the E2E API and Browser-origin override to Development Extension Hosts even when the guard environment variable is present.
- Made release packaging require a verified exact local `@vscode/vsce@3.9.2` installation without runtime `npx` resolution.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.2

- Enforced one authoritative Bachata state writer per workspace so separate Extension Hosts cannot overwrite, archive, or delete each other’s conversations, transcripts, pipelines, or orchestration state. Multiple pairs still run inside the owning Bachata window.
- Made catalog and global resource-broker startup retry-safe under simultaneous Extension Host activation and moved migration checks inside the write transaction.
- Made broker deadlines monotonic, protected whole-machine resume from immediate mass expiry, and added persisted fencing so a selectively paused or unhealthy owner fails closed after a live peer replaces it.
- Recomputed capacities from active leases and queue order, prevented later low-capacity requests from blocking earlier requests, rejected claims above their declared capacity, and made quarantined resources fail immediately before queueing.
- Enforced `bachata.maxConcurrentLocalAgents` as a hard physical-process limit after role assignment, accounting for persistent Codex app-server processes and concurrent Claude Code turns without reserving unused agents; uncertain provider cleanup now quarantines those slots.
- Enforced aggregate local-provider demand across every user of a retained execution lease, including direct interventions and queued work, and coordinated native availability probes through the same hard machine-wide limit.
- Added an SQLite workspace mutation fence around transcript, attachment, custom-pipeline, orchestration-ledger, active-run, and Memento commits so a replacement writer cannot overlap or be followed by stale filesystem state.
- Made custom-pipeline Save and Delete transactional with runtime state: failed file writes leave the last persisted definition active, and failed deletes keep the pipeline available.
- Released parent capacity during final checklist execution and reacquired only before a later iteration, so completed checklist work cannot fail solely while reclaiming unused slots.
- Closed Browser Bridge and aborted runtime, TODO, and verification work when their shared-resource lease is lost.
- Fixed omitted attachment defaults, checklist summarizer selection, composer accessible names, and real Extension Host registration coverage for quarantine clearing.
- Added repository-lifetime TODO orchestration ownership so two Extension Hosts cannot start competing runs against the same repository.
- Preserved Git timeout, cancellation, and cleanup certainty; uncertain Git process termination now quarantines administration ownership, while failed cleanup retains recoverable metadata.
- Added visible `waitingForResources` state, a Cancel wait control, and regression coverage proving cancelled work never starts when capacity returns.
- Added explicit Browser Bridge ownership handoff through Discover or Reset after the previous owner closes.
- Hardened transcript metadata after simultaneous appenders and changed pipeline/transcript exports to atomic file replacement.
- Fixed no-workspace runtime initialization, strict webview compilation, Windows human-E2E process-tree termination, and behavioral refusal-path tests for the human-only runner.
- Separated orchestration ledgers from worktree-only directory discovery and expanded multi-process regression coverage.

Stable release still requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.1

- Added cross-process resource coordination for simultaneous Bachata sessions, including bachata/provider capacity, same-repository execution, Git administration, protected checks, Browser Bridge ownership, bounded waiting, cancellation, stale-owner recovery, and physical-resource quarantine.
- Split task checks from final checks, added explicit shared-resource metadata, preserved completed implementation while verification waits, and prevented unattended Workers from owning protected acceptance and E2E commands.
- Fixed pipeline-editor source identity so a new draft cannot delete the selected custom pipeline, existing custom IDs cannot silently fork, and deletion names the exact source pipeline.
- Changed pipeline import to populate an unsaved draft; it does not persist or select the imported pipeline until Save.
- Serialized pipeline switching with editor actions and blocked every editor-close path while Save, Import, Export, Validate, or Delete is pending.
- Added dedicated Lead’s Final Ruling cards with the selected result, objections, dispositions, unresolved risks, and participant-output navigation.
- Persisted completed TODO runs as independently revealable and cleanable retained Git resources across restarts and later runs.
- Rendered approval cards in the conversation flow and made interaction and approval submissions locally locked and backend-idempotent.
- Added deterministic recovery for interrupted multi-iteration runs.
- Added a human-only two-process Extension Host E2E suite. It drives the real Runs drawer, pipeline editor, composer, interaction response, persisted cold recovery, archive, unarchive, and delete controls.
- Fixed queue resume during another serialized mutation so queued work cannot become unpaused but stranded.
- Replaced native prompts and confirmations with accessible in-webview dialogs, limited pipeline dragging to explicit handles, collapsed dense editor cards, and preserved stored image previews.
- Added searchable run history with read-only archived transcripts and tree-wide unarchive/delete behavior.
- Required valid explicit responses for permissions, human gates, questions, and secrets. Empty execution checklists remain an explicit supported choice.
- Locked the complete pipeline editor while validation or file operations are pending.
- Added side-effect-free pipeline preflight and runtime operation acceptance.
- Added total attachment-size preflight before base64 encoding.
- Preserved exact pipeline and iteration settings through immediate, queued, interrupt, and resumed execution.
- Added typed outputs, deterministic consensus, persisted interactions, recent activity, TODO controls, responsive overflow, and Inspector policy visibility.
- Hardened TODO orchestration scope, verification snapshots, Git ownership, cleanup, retries, rollback, and persisted recovery.
- Hardened Browser Protocol v8 endpoint recovery and extension-origin token binding.
- Replaced committed Prism copies with pinned `prismjs` build assets.
- Added source-only and critical-module coverage gates, then removed obsolete versioned reports and smoke-test copies.
- Added explicit central-runtime and executable webview-behavior coverage gates plus a browserless smoke test against the compiled webview. Destructive dialogs now default to Cancel and restore focus to the originating control.
- Preserves pipeline-editor focus through failed or cancelled import/delete operations. Normal test files must exit naturally under a bounded watchdog, while broad coverage uses bounded concurrency of two to avoid Git-worktree races and process-tree stalls.
- Hardened approved browser shell actions to use the fixed non-login command shell.
- Unified browser workspace listing, read, and search restrictions for credential, VCS, dependency, generated, worktree metadata, and symlink-alias paths.
- Added Git-backed patch validation for text, rename, copy, mode-only, binary, quoted-path, and unsafe-path cases, with one shared action deadline across every Git subprocess.
- Fixed attachment control semantics and documented local-only browser adapter support.

Stable release requires `docs/HUMAN_E2E.md` and `docs/LIVE_SMOKE_TEST.md`.

## 0.6.0

- Replaced room-list UX with root runs and child task chats.
- Added SQLite run state, custom pipelines, interactions, iterations, TODO orchestration, and Browser Protocol v8.
- Removed the default Reviewer role. Built-in TODO work uses Lead and Worker.

## 0.5.0

- Added the deterministic TODO orchestration and Browser Protocol v7 baselines.
