# Human Extension Host E2E

Only a human may invoke this graphical suite. AI tools, agents, CI, prepublish, packaging, scheduled jobs, and automated review must not run it.

Product-direction checks follow [Product doctrine](PRODUCT_DOCTRINE.md). Passing execution mechanics alone does not validate product.

## Run

1. Use a graphical desktop and interactive terminal.
2. Run `npm run test:e2e:human`.
3. Enter the exact confirmation requested by the runner.

The runner rejects CI and noninteractive input and terminates the full VS Code process tree on timeout.

## Automated graphical phases

Phase 1 verifies:

- activation and command registration, including resource-quarantine clearing;
- real webview readiness;
- first-run creation through the New Run dialog;
- first custom-pipeline creation through the real pipeline editor, JSON mode, validation, Save, and selection;
- Runs drawer and pipeline editor controls;
- new-draft deletion isolation, immutable existing pipeline ID, one ordinary revision-aware update Save, and pending-operation close lock;
- prompt and iteration input;
- a persisted question answered through its interaction card;
- deterministic-adapter submission;
- an interrupted two-iteration run flushed to disk;
- a real Git-backed `TODO.md` run started and stopped through the webview while its task is active.

The committed non-graphical regression suite separately verifies create and import collisions, stale Save and Delete rejection, exact-content file commits, physical cross-runtime locking, symlink containment, invalid-catalog fail-closed behavior, immutable queue and recovery snapshots, and early Git preflight. Those checks are not presented as graphical actions.

Phase 2 starts a fresh Extension Host with the same isolated user data and workspace. It verifies:

- persisted interrupted-run recovery;
- selection and resume through the webview;
- completion of the resumed and remaining iterations;
- no duplicate `run.started`;
- archive, archived discovery, unarchive, and permanent deletion through real controls;
- restoration, resume, task verification, final verification, Master scheduling and terminal review, integration-worktree inspection, and cleanup of the stopped TODO run;
- creation and abandonment of a second TODO run through real controls;
- controlled Browser Protocol v9 pairing, discovery, status publication, session binding, prompt transport, streaming, completion, and run deletion without an authenticated provider.

## Required simultaneous-window check

After the scripted phases, use one disposable workspace in two VS Code windows under the same user profile:

1. Open Bachata in Window A and start a deterministic run that remains active.
2. Open the same workspace in Window B.
3. Verify Window B reports authoritative ownership by another Extension Host and does not create a second catalog writer or TODO controller.
4. Add or remove a non-first folder in Window A without reloading. Open the same workspace state in another window and verify ownership remains single-writer despite the changed multi-root folder set.
5. Verify Window A continues normally.
6. Close Window A, reload Window B, and verify Bachata opens with the authoritative persisted state.
7. In two different disposable workspaces, verify both hosts may run while shared Bachata and provider capacity still serializes according to settings.
8. Let one host own Browser Bridge, close it cleanly, then use Discover in the surviving different-workspace host and verify ownership transfers without reloading that host.
9. Queue a run behind held repository capacity, cancel it in the webview, release capacity, and verify it never starts.
10. Suspend and resume the machine while a safe deterministic lease is active; verify the live owner does not quarantine or lose its own lease.
11. While a pre-sleep owner is still resuming, open a new Bachata window immediately after wake. Verify the new broker does not revoke or quarantine the live owner, then verify an actually crashed owner is reclaimed after one stale interval.
12. With Window A owning the disposable workspace, pause only Window A's Extension Host beyond the stale-owner threshold while Window B remains active. Let Window B acquire workspace ownership, then resume Window A. Verify Window A reports lost ownership, stops active runtime and TODO work, closes Browser Bridge if it owned it, rejects catalog and transcript mutations, and requires reload before continuing.
13. With `bachata.maxConcurrentLocalAgents` set to 2, keep a one-local-agent deterministic pipeline paused and try a direct intervention targeting two local agents. Verify the intervention is rejected before either provider starts. End the paused run, then run Check availability and verify native probes never exceed two simultaneous processes.
14. Make `.bachata/pipelines` temporarily unwritable in the disposable workspace. Verify failed Save leaves the previous pipeline definition selected, failed Delete leaves the pipeline visible, and both remain consistent after reload. Restore permissions afterward.
15. In one window, open two root runs on the same custom pipeline. Save a change in Run A, then try to save or delete from the stale editor in Run B. Verify Run B is rejected, then reopen it and verify the committed revision is visible.
16. Delete a custom pipeline in Run A. Verify Run B refreshes its catalog, a clean Reset falls back safely, and durable history still displays the immutable pipeline snapshot it originally used.
17. Queue a custom pipeline, edit its catalog definition, restart the Extension Host, and verify the queued request runs the original accepted snapshot. Repeat with an interrupted workflow and verify Resume uses the original snapshot.
18. Seed a legacy queue or recovery fixture without an immutable snapshot. Verify the queue remains cancellable without a Resume action and the recovery is blocked with a durable warning.
19. In a multi-root workspace, create the same custom pipeline ID under both roots with different names. Select each working root in turn and verify execution and Save affect only that root.
20. Open Bachata without a workspace, create a custom pipeline in Run A, create Run B, and verify it is shared. Delete Run A and verify the custom pipeline remains available in Run B.
21. On a fresh profile, verify the first-run selected pipeline is review-only and the bundled cross-reference checklist flow stops before repository modification. Verify an `executeChecklist` draft with empty checks cannot validate unless `allowNoChecks` is explicitly enabled.
22. Open the same physical repository through two different `.code-workspace` files or local VS Code profiles. Open the same custom pipeline revision in both, start both Save operations together, and verify exactly one commits while the other reports a stale or changed-on-disk conflict.
23. Open a custom pipeline in Bachata, edit its file externally, then Save or Delete from the stale editor. Verify the external content remains and Bachata requires reopening the definition.
24. In a multi-root workspace, open one root through a directory symlink. Select that root and verify its custom pipelines remain root-scoped. Replace that root's `.bachata` directory with a symlink outside the physical root and verify Bachata refuses to read or write the catalog.
25. Add a copied, misnamed, symbolic, invalid, or built-in-colliding `*.pipeline.json` entry. Verify the complete custom catalog is blocked with visible paths. Remove the conflict and verify the catalog recovers.
26. Save a custom pipeline whose final enabled step is `executeChecklist`, leaving only `.bachata/pipelines` dirty. Run it and verify Git preflight occurs before the first provider turn and accepts that catalog-only dirtiness. Add an unrelated tracked, staged, untracked, copied, or renamed path and verify the run is rejected with the exact dirty paths. Verify `Bachata: Run TODO.md` still rejects the dirty catalog.
27. Pause a local process while it owns the physical pipeline catalog beyond the stale-lock interval. Verify a competing window times out instead of reclaiming the live lock. Terminate the owner, retry, and verify the abandoned local lock is reclaimed.
28. Create a parent pipeline whose final step uses a custom task pipeline. Accept the run, then edit or delete the task pipeline while tasks are pending. Verify every pending task and retry uses the original accepted definition, including after an Extension Host restart.
29. Configure a missing task pipeline, then a task pipeline containing its own enabled `executeChecklist`. Verify each parent request is rejected before any provider starts. Repeat top-level TODO Start with an unavailable task or Master pipeline and verify it fails before worktree or provider activity.
30. In a multi-root workspace, select Root A and one of its custom pipelines, then remove Root A. Verify its catalog disappears, Send remains blocked until a valid root is selected, restart does not restore Root A, and Duplicate does not copy the stale working directory, scope, or pipeline into Root B.

## Required run-contract, evidence, and draft checks

31. Select a review pipeline and open the run contract above the composer. Verify it states read-only scope, no commits, the providers with their models, run limits matching current settings, and no verification operations. Switch to a managed pipeline with a managed role and verify the contract states the role's write scope, writable paths, commit policy, and controller checks per role, and that the aggregate scope and commit policy are not narrower than any role's.
32. Change Max iterations and Mode in run options and verify the contract's stated iterations and completion criteria follow the draft, including the until-clean pass count. Verify UI does not describe until-clean completion as correctness or absence of defects.
33. Run `Bachata: Setup` in a workspace with a valid `TODO.md`. Verify each offered workflow states its safety level, choose **Run TODO.md**, and verify the confirmation dialog lists repository, task IDs, task and Master pipelines, writable paths, task and final verification, shared resources, concurrency, retries, commit policy, isolation, human decisions, and completion criteria. Cancel and verify no branch, worktree, or provider session was created.
34. Dirty the repository, run `Bachata: Run TODO.md`, and verify it refuses with the blocking preflight findings and starts nothing. Clean the repository, repeat, confirm, and verify orchestration starts.
35. Prepare a review draft from the editor context menu, edit the prepared text, close and reopen the panel, and verify the edited text is restored. Reload the window and verify it is still restored. Clear the composer and verify the draft is not restored after the next reload.
36. In a multi-root workspace, run Review File on a file in the second root and verify the run's working directory is that root. Run Review Staged Diff with no active editor and verify Bachata asks which repository the run targets and records it in the draft title and prompt. Cancel the pick and verify no run is created.
37. Complete a run that produces changed files, checks, and a ruling. In the Execution view verify the Result Center states which provider ruled, which providers produced the run, unresolved risks separately from recovered errors, and any evidence gaps. Use **Changes** on a changed file and verify the diff editor opens; use **Open Source Control** and verify the Source Control view opens. Reload the window and verify the same evidence is still shown for the completed run.
38. Export a run bundle from a run that used a browser provider. Verify the file contains no provider conversation URL path, session identifier, or conversation identity, that link origins are retained without their paths, and that the stated omissions match the file contents.
39. Search the Runs drawer for a token that appears only at the end of a very large transcript. Verify results either match or the drawer states that the search stopped at its evidence budget; verify the result set never belongs to an older query than the one in the search box.

## Required onboarding, remediation, and handoff checks

40. On a clean profile, open the walkthrough. With no provider installed, verify no step is complete. Run `Bachata: Doctor` and verify the first step completes only when a provider actually answers. Verify the remaining steps complete on a clean Doctor result, a selected read-only workflow, a finished review run, and opening its evidence. Verify no step completes merely because a command was invoked.
41. Rename or unset the Codex executable so its probe fails. Run Doctor, choose **Fix a Problem**, choose Codex, and verify the dialog names the exact failure, gives numbered steps, offers the terminal probe and the `bachata.codexCommand` setting, and rechecks only Codex rather than rerunning all of Doctor. Repeat for Claude Code and Git.
42. Run `Bachata: Setup`, choose Review code, choose each completion policy, and verify the confirmation states providers, working root, write authority, paths, checks, commit policy, completion policy, human decisions, and what is editable only in advanced mode. Cancel and verify no run is created.
43. With `bachata.advancedMode` off, open the pipeline editor and verify advanced step settings are replaced by an explanation and a control that opens the setting. Turn it on and verify the full editor returns.
44. Open a run with an empty prompt in a multi-root window with no selected root and an unavailable provider. Verify Send is disabled and every blocking condition is listed with what is required, that **Choose folder** and **Fix** are offered, and that **Fix** opens the same remediation Doctor offers.
45. Complete a TODO run that retains a worktree. In the Result Center verify the inspect-and-apply handoff states the checks, risks, gaps, and ruling provenance. Use **Export patch** and verify the diff preview opens and the saved file matches. Use **Rerun approved checks** and verify only declared controller-owned operations run. Use **Apply to current branch** on a dirty repository and verify it refuses without touching the working tree and keeps the worktree. Clean the repository, apply again, and verify the work is staged, no commit was created, and the worktree still exists.
46. Export the same run as Markdown and as SARIF. Verify each opens a preview first, that the confirmation lists the applied redaction rules and the heuristic-redaction warning, and that cancelling writes nothing. Add `.bachata/export-policy.json` with a literal and a path prefix, export again, and verify the literal is redacted, the path is excluded, and both rules are listed.
47. Open the run contract and expand a provider under **What each provider receives**. Verify it lists the prompt, step instructions, role instructions, and each attachment, marks run-time selections as such with their byte bounds, states what is never sent, and states that outbound text is not rewritten.
48. Run `Bachata: Local Data`. Verify each store shows its exact path and size and states what deletion removes and keeps. Set `bachata.localDataRetentionDays`, archive an old run, and verify the cleanup lists the exact runs before deleting and deletes nothing without confirmation.
49. Open a `TODO.md` with an unknown metadata key, a missing `Paths`, an arbitrary verification command, a dependency cycle, and two independent tasks sharing a scope. Verify each is reported on its own line, that quick fixes correct the key, insert the scope, and replace the command, and that `Bachata: Preview TODO Plan` shows the execution groups, the dependency graph, the overlapping scopes, and the same problems.
50. Open the same workspace in a second window. Verify the second window reports that another window owns the state. Run `Bachata: Workspace Ownership` in both: verify the second states the other window's last heartbeat and offers request and reload without taking the lease, and the owning window can release and reload. Verify release is refused while an orchestration run is executing.
51. Complete a run with more than one participant and more than one ruling. Verify participant outputs can be compared side by side with their candidate hashes, objections, risks, and validation errors, and that the iteration comparison lists each ruling and how the risks changed between them.
52. Complete two or more fresh review runs against same evolving feature. Verify each new run starts independent inspection of current codebase, prior material findings remain unavailable until discovery freezes, post-discovery reconciliation compares final material findings, and no run claims shared blind spots are solved.
53. From top-level control surface only, state current goal, active core decisions, accepted direction, unresolved disagreements, material assumptions, and new material risks. Verify routine chatter and successful mechanics do not require attention there.
54. Produce same material decision in two runs with changed wording. Verify one stable subject remains, repeat is history, and no duplicate top-level decision appears.
55. Change recommendation or evidence materially. Verify current decision supersedes old one, shows exact delta, and preserves old version in history. Resolve it, then add materially new evidence and verify reopened item states why it reopened.
56. Verify each decision shows question, materiality, options and tradeoffs, recommendation and minimum evidence, affected scope, status, provenance, and human resolution. Resolve routine model disagreement without human and verify it never bubbles up.
57. Reach default review-saturation signal after two quiet fresh reviews with prior material findings resolved or accepted, core decisions closed, and current required checks. Verify copy states observed facts, human may continue or close before or after signal, and UI never calls saturation correctness or another review needed.
58. Produce conflicting Lead and Worker finding lists. Verify both start provisional, each material claim receives challenge or confirmation evidence, and pipeline-accepted routine finding becomes actionable without human ruling. Verify pre-authorized routine fix may proceed, material unresolved finding bubbles to human, and rejected finding and debate stay history.
59. Inspect, reject, reopen, and restore semantic finding dispositions from bubble or finding view. Verify ambiguous identity and direction, scope, acceptance, or irreversible choices block. Verify work discard/restore appears only for exact reversible retained work. Verify applied fix remains unverified until fresh independent review or evidence.
60. Describe one already-tracked finding in different words in a later fresh review. Verify Bachata folds it into the same finding without asking, records who folded it and why, keeps both wordings in history, and that undoing the merge is available. Verify a finding with the same subject in a different file stays separate, and that only an ambiguous or conflicting mapping appears under the identity-decision section.
61. Exercise the notification bell. Verify the unread count, that the newest unread event also appears as one inline line, and that opening an event focuses what it names and clears its unread state. Switch `bachata.notificationMode` through `off`, decisions only, material events, and all, and verify the visible set and the unread count change accordingly and that `off` shows nothing. Verify repainting the same state does not renew the unread count, that clearing empties the list, and that the list is gone after an Extension Host restart.
62. Verify a run that kept a retained worktree offers Discard, and a run that wrote directly into the selected workspace offers only Inspect and promises no rollback.
63. Open the Execution view for a completed run. Verify it states, per participant, which provider and adapter held the conversation and whether that history is reconstructable or `unavailable`. Export the run bundle and verify it carries no provider session id, conversation identity, or conversation URL path.

Do not use authenticated providers for this suite. Complete `LIVE_SMOKE_TEST.md` separately.
