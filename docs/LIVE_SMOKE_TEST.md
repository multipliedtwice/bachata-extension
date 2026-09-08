# Authenticated provider smoke test

Human-only stable-release gate. Record pass or fail and non-sensitive build identity only. Never record provider content, credentials, tokens, usage, cookies, or screenshots containing private data.

Product semantics follow [Product doctrine](PRODUCT_DOCTRINE.md). This test must not convert model agreement, passing checks, no-change iteration, or review saturation into correctness claim.

## Build identity

Record:

```text
Source archive or commit:
Extension version:
Browser Bridge version:
VS Code version:
Browser version:
Operating system:
Test date:
```

## Preparation

- Build the exact recorded source from clean dependencies.
- Open a disposable trusted Git workspace.
- Sign in to current Codex, Claude Code, ChatGPT, and Claude accounts.
- For the Z.AI GLM section, export a Z.AI API key in the environment VS Code starts from. Without one, that section is recorded as blocked.
- Install and pair the recorded Browser Bridge build.

## Native providers

For Codex and Claude Code, verify:

- availability is reported correctly;
- a simple two-participant pipeline completes;
- streaming stays in the correct run;
- permissions and questions require explicit valid input;
- interrupt and session reset recover cleanly;
- a second iteration starts fresh sessions.

## Z.AI GLM

Requires a real Z.AI API key. This is the only Z.AI test that spends a model request; ordinary Doctor never does. With no credential, record `Blocked (no credential)` for every line below and never record a pass.

Export the key as the variable named by `bachata.zaiAuthTokenEnvironment` (default `ZAI_API_KEY`) in the environment VS Code starts from, set `bachata.zaiModel`, then verify:

- authentication succeeds against `bachata.zaiBaseUrl`, and a wrong or expired key produces an understandable, recoverable failure rather than a silent stall;
- the run contract, the Result Center, and Doctor all name Z.AI GLM and the selected model, never Anthropic Claude;
- a turn starts, streams, and completes;
- a second turn resumes the same provider session;
- cancellation stops the running turn;
- a tool-using turn requests permission through Bachata and honours the answer;
- a long answer completes without truncating the recorded result;
- malformed provider output fails the turn with a stated reason instead of being recorded as an answer;
- a rate-limit or provider error is reported with its provider-stated reason;
- a Codex or Claude Code agent running in the same window never receives the Z.AI credential.

Record the result in [Provider terms](PROVIDER_TERMS.md) and [Compatibility matrix](COMPATIBILITY_MATRIX.md). Technical compatibility is not a GLM Coding Plan entitlement claim.

## Webview UX

Verify:

- Runs drawer search and active selection;
- Chat / Execution run-view switching without losing the active run;
- structured/JSON pipeline switching;
- Structured mode exposes managed policy, managed role, resource ID, candidate agents, read/writable/protected paths, commit mode, verification checks, and agent capabilities;
- browser adapters hide unsupported CLI/model/permission fields and select browser conversations instead;
- Fixed and Until clean iteration modes preserve their configured hard maximum and required consecutive clean passes;
- editor controls lock while Save or Import is pending;
- invalid pipeline input remains open with errors;
- attachments enforce type, per-file, count, and total limits before upload;
- resource waiting is visible and cancellable;
- narrow-panel overflow and Inspector remain reachable;
- archived runs are read-only and unarchive restores controls.

## Browser providers

Complete the Browser Bridge repository’s `docs/LIVE_SMOKE_TEST.md`, then verify ChatGPT Browser, Claude Browser, and every claimed Generic target from Bachata. Confirm Bridge ownership transfers through Discover after its previous different-workspace owner closes cleanly.

For managed browser mode, verify an end-to-end Worker → context list/read/search/dependency requests → guarded patch/write/delete → controller verification → Lead review → bounded revision flow. Run Until clean with at least two required clean passes and confirm it stops only after consecutive completed iterations make no repository-state change, or at the hard maximum. Confirm UI calls this repository stability, never correctness. Verify protected evaluator paths cannot be mutated.

For a large disposable repository, verify files outside the resident context subset remain discoverable through full-workspace search, directory listing pagination works, ranged reads work for large files, repeated turns reuse the context cache, and Stop cancels repository indexing/search promptly.

## Recovery

Repeat the deterministic two-iteration reload and resume flow with real native providers and verify no prompt or iteration is duplicated.

## Result

```text
Extension Host: PASS | FAIL
Multi-window ownership: PASS | FAIL
Codex: PASS | FAIL
Claude Code: PASS | FAIL
ChatGPT Browser: PASS | FAIL
Claude Browser: PASS | FAIL
Generic Browser targets: PASS | FAIL
Grok via Generic: PASS | FAIL | NOT CLAIMED
Z.AI via Generic: PASS | FAIL | NOT CLAIMED
Until clean convergence: PASS | FAIL
Large-repository retrieval: PASS | FAIL
Recovery: PASS | FAIL
```

## Human direction and attention compression

Against same evolving feature, run two or more fresh comprehensive reviews with corrections between them.

Verify:

- new run independently inspects current codebase and does not inherit earlier confidence;
- top level shows current goal, active core decisions, unresolved disagreement, material assumptions, new material risks, and minimum evidence;
- routine chatter, repeated or resolved findings, and successful mechanics stay drill-down;
- raw Lead and Worker findings remain provisional until challenged or confirmed with evidence;
- pipeline-accepted routine findings become actionable without human ruling and pre-authorized routine fixes may proceed;
- material unresolved findings and direction, scope, acceptance, ambiguous identity, or irreversible choices block for human; rejected findings stay history;
- applied fix remains unverified until fresh independent review or evidence;
- repeated same-subject decision deduplicates;
- material change supersedes prior decision and shows delta;
- resolved decision reopens only on materially new evidence and says what changed;
- default saturation signal appears after two quiet fresh reviews add no material finding, prior material findings close, core decisions close, and required checks are current;
- human may continue or close before or after signal; UI never says another review is needed or claims correctness;
- human chooses stop and accepts residual uncertainty.

```text
Fresh review independence: PASS | FAIL
Current direction without transcripts: PASS | FAIL
Decision deduplication and lifecycle: PASS | FAIL
Review saturation semantics: PASS | FAIL
```

## Managed absolute deadline and bounded continuations

Verify with a deliberately small temporary `bachata.managedTaskTimeoutMs` and a large-context repository:

- the deadline begins before repository baseline/index preparation and is reused across Worker, Lead, and revision turns;
- provider activity does not extend the absolute deadline;
- deadline expiry cancels the active operation and the persisted checkpoint cannot continue past it;
- a fresh Worker start receives a new deadline;
- requesting many large files never produces a continuation above `bachata.managedContinuationMaxBytes`;
- omitted controller results can be retrieved in smaller bounded requests;
- a repository with no initial commit can prepare, patch, and verify without requiring `HEAD`;
- an inventory/metadata-truncated handoff reports the incomplete coverage and retains useful source context.

Record:

```text
Managed absolute deadline: PASS | FAIL
Continuation bound: PASS | FAIL
Unborn Git repository: PASS | FAIL
Large dirty metadata: PASS | FAIL
```


## Controller-owned project verification

With a throwaway Git workspace, exercise both autonomous verification operations. Confirm that `bachata:workspace-integrity` reports scope, restricted/generated paths, symlinks, conflict markers, whitespace errors, and HEAD drift; confirm that `bachata:project-checks` performs only its bounded controller-selected syntax/type checks with Bachata's pinned TypeScript compiler. Also submit direct shell commands, package scripts, nested wrappers, E2E commands, and Git-history commands as configured checks and confirm they are rejected before process launch.

```text
Workspace integrity: PASS | FAIL
Controller project checks: PASS | FAIL
Arbitrary command refusal: PASS | FAIL
Wrapper refusal: PASS | FAIL
E2E refusal: PASS | FAIL
No-commit evidence binding: PASS | FAIL
```


## Run contract and export privacy with live providers

Run one authenticated managed browser task and one authenticated local CLI run on the exact release artifacts.

Before submitting each run, read the run contract in the composer and confirm that it names the actual providers and models used, the working directory, the write scope and writable paths the run then respects, the commit policy, the controller verification operations, and the role authority for every managed role. For a generic browser conversation, confirm that readiness refuses the run until the bound session reports verified send, verified completion lifecycle, confirmed interruption, and confirmed conversation state.

After each run, export the run bundle and inspect the file. Confirm it contains no provider conversation URL path, no session identifier, no conversation identity, and no document token, that remaining links keep only their origin, and that the stated omissions match the file contents.

```text
Contract matches applied authority (browser): PASS | FAIL
Contract matches applied authority (local CLI): PASS | FAIL
Generic capability gate: PASS | FAIL
Export contains no conversation locator: PASS | FAIL
Export contains no session or conversation identity: PASS | FAIL
```

## Exact-build record

Every result from this document goes into `docs/RELEASE_VALIDATION_RECORD.md` section 2 and `docs/COMPATIBILITY_MATRIX.md`, with the artifact hash, the provider build identifier visible on the day, the date, and every limitation observed. A run whose artifact was rebuilt afterwards is void.

Also verify with a live provider:

- the outbound context preview in the run contract matches what the provider actually receives for that run;
- the inspect-and-apply handoff stages accepted work without creating a commit, and keeps the worktree on every refusal;
- Markdown and SARIF evidence exports are previewed before writing and carry no provider session or conversation identity.
