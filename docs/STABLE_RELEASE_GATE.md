# Stable release gate

A Bachata build is stable only when every applicable gate below passes for the exact source revision being packaged.

Release blockers are finite:

- accidental public metadata or asset placeholders;
- packaged extension does not install;
- onboarding or core review path fails;
- claimed provider smoke contract fails;
- authentication or configuration failure is not understandable and recoverable;
- existing contract, safety, no-telemetry, packaging, or release check fails;
- known limitation is inaccurate or omitted.

Owner-supplied publisher identity, public URLs, assets, credentials, terms decisions, and exact-build records stay explicit inputs. Never invent replacement values. Missing credential may block that provider's live claim; it does not invent source defect.

Do not add speculative release gate. New blocker needs reproducible failure in list above. Do not create telemetry, measurement service, or new validation infrastructure. Fixed local fixtures and existing human exact-build records remain enough.

## Automated source and build gates

Run from a clean dependency installation:

```text
npm run check:lockfile
npm run check:release-metadata:identity
npm run check:no-telemetry
npm run check:managed-fallback
npm run test:source-distribution
npm run build
npm run test:managed-modules
npm run test:managed-worktree
npm run test:unit
npm run test:coverage
npm run source:export -- <fresh-export-directory>
npm run source:verify -- <fresh-export-directory>
```

A failure blocks release. Full metadata and artifact checks follow candidate validation below.
Maintained-source exports exclude generated build, dependency, lock, coverage, cache, test, and runtime artifacts.

## Product-direction and claim gate

Implemented behavior and public copy must match [Product doctrine](PRODUCT_DOCTRINE.md), not only execution mechanics. Public claim needs matching evidence. Unclaimed future behavior does not block candidate installation or unrelated capability release.

Human must be able to:

- state current codebase goal and direction without reading transcripts;
- see only challenged, evidence-backed accepted findings as actionable;
- keep provisional and rejected findings out of current codebase state while preserving history;
- see only active core decisions, unresolved disagreements, material assumptions, new material risks, and minimum judgment evidence at top level;
- inspect routine output, repeated and resolved findings, successful mechanics, and provenance on demand;
- resolve, defer, reject, supersede, and reopen decisions with stable identity and visible delta;
- start fresh comprehensive review after corrections land;
- distinguish review saturation from correctness.

Moderated exact-build sessions validate public claims about attention compression and saturation. Missing session blocks those claims, not candidate installation or unrelated release capability. Pipeline consensus, passing checks, `until clean`, or no new finding in one run cannot substitute for claim evidence.

## Run-contract and evidence gate

Before any provider starts, the resolved execution contract must state the providers, working directory, write scope, writable/readable/protected paths, per-role managed authority, commit policy, controller verification operations and their shared resources, run limits, provider fallback, human decisions, and completion criteria. The aggregate scope and commit policy must never be narrower than any role the runner will actually apply.

`Bachata: Run TODO.md` must resolve the same contract for unattended orchestration, refuse to start on any blocking preflight finding, and start only after explicit confirmation.

Result evidence must survive an Extension Host restart: changed files, executed checks, ruling and ruling provider, unresolved risks separated from recovered errors, retained worktree, and explicit evidence gaps. Recovered errors require same-unit success or an explicit recovery event.

Exported run bundles must contain no provider conversation URL path, session identifier, conversation identity, or document token, and their stated omissions must match their contents.

## Managed browser gate

The managed Worker/Lead path must prove:

- one persisted absolute task deadline across context preparation, Worker, Lead, and revision turns;
- bounded initial handoff metadata with explicit omitted counts and controller-paged recovery through `context.readTask` / `context.readMetadata`;
- bounded continuation payloads and retrievable omitted context;
- no duplicate unbounded snippet reinjection;
- safe operation in a Git repository before its first commit;
- independent readable `readPaths` and writable `allowedPaths`, with read access never silently expanding mutation scope;
- explicit user-mentioned file/directory retrieval seeds and bounded promotion of nonresident local TypeScript/JavaScript dependencies;
- controller-owned bounded `context.tree`, `context.dependencies`, and paged `context.dependents` actions plus guarded patch/write/delete mutations;
- controller-owned mutation scope, expected hashes, typed stale/scope failures, rollback, and `commitMode: never`;
- workspace-integrity and controller-project-check evidence bound to the exact workspace fingerprint;
- autonomous verification accepts only controller-owned operations and never launches arbitrary repository commands or wrappers;
- blocking approvals and gates remain visible from Chat and Execution;
- ruling navigation reaches the participant transcript across views;
- every managed task uses fresh role-specific browser conversations and repository content is explicitly treated as untrusted task data;

## Browser-provider gate

Complete `HUMAN_E2E.md`, `LIVE_SMOKE_TEST.md`, and the matching Browser Bridge stable gate. Managed Generic sessions must publish `verifiedSend`, `verifiedLifecycle`, `confirmed` interruption, and a `confirmed` conversation state. Manual-only or uncertain sessions are rejected for unattended managed execution.

ChatGPT, Claude, Grok, Z.AI, or another browser provider is claimed only at the support level demonstrated by the exact current target.

## Local interpreter gate

Before unattended semantic interpretation or selector healing is enabled for a configured local model, run the bounded candidate fixtures against the exact runtime, endpoint, and model intended for release. Validate controller-candidate-only selection, malformed-output abstention, unknown-ID rejection, bounded retries, loopback policy, and recovery without uncontrolled loops.

LM Studio, Ollama, Bonsai, Qwen, and DeepSeek compatibility is not inferred from protocol similarity. Each claimed configuration needs its own passing result.

## Public distribution gate

The gate runs in three stages, because human evidence can only be produced by testing an artifact that does not exist until the candidate is built:

| Stage | Command | When | What it checks |
| --- | --- | --- | --- |
| identity | `npm run check:release-metadata:identity` | `vscode:prepublish`, so it blocks candidate creation | Marketplace identity, URLs, provider documentation URLs, Bridge acquisition URL |
| evidence | `npm run check:release-metadata:evidence` | after the candidate has been validated by a human | every record row is complete and terminal, and the README's screenshots of the packaged build exist; artifact SHA-256 cells may still be empty |
| artifact | `npm run check:release-metadata` (`--stage=all`) | `npm run release:verify`, the publication gate | the binding lines, the artifact tables, and every recorded hash match the staged artifacts, each in a column that names its artifact |

Screenshots are evidence, not identity: they are captured from the candidate, so they cannot gate its creation. `media/screenshots/` is therefore not packaged, and adding a screenshot never changes the artifact it proves.

`npm run release:verify` copies the VSIX and the pinned Browser Bridge ZIP into a private snapshot and runs every check against that snapshot: the record check, the packaged-byte check, and the Bridge structural check. The staged copies are compared with the snapshot afterwards, so an archive replaced or repacked while verification runs is refused rather than half-verified. The Bridge is resolved from `browserBridgeVersion` in `protocol/browser-bridge.compatibility.json`; an unpinned version beside the repository is refused.

The order is: build the candidate, validate it, `npm run release:bind`, then `npm run release:verify`. `npm run package` creates a candidate and nothing more; it is not a release.

Tracked workflows: `.github/workflows/release-gates.yml` runs three-OS source gates;
`.github/workflows/paired-release.yml` verifies paired artifacts. Neither workflow's presence
proves a hosted pass. Run local gates in the order above; record hosted commit, job and artifact
evidence only after an authorized run. Paired verification also needs the Bridge repository,
successful artifact run and `BRIDGE_ARTIFACT_READ_TOKEN`.

Across the three stages the gate fails while any of the following is still a placeholder or unrecorded:

- Marketplace publisher identity, repository URL, homepage, issue tracker, Q&A, and support URL in `package.json`;
- the canonical display name `Bachata`;
- screenshots under `media/screenshots/` referenced by `README.md`, captured from the exact packaged build;
- a real public Browser Bridge acquisition URL in `docs/BROWSER_BRIDGE_INSTALL.md`;
- any `Not performed` row in `docs/RELEASE_VALIDATION_RECORD.md`;
- any `Not reviewed` row in `docs/PROVIDER_TERMS.md`;
- any `Not tested` row in `docs/COMPATIBILITY_MATRIX.md`.

The gate parses each record file structurally, not by string matching. Every evidence row must fill every column, carry an ISO `YYYY-MM-DD` date, end in a terminal verdict, and name a SHA-256 that equals the staged artifact. Each record file must also carry one `Artifacts under test:` line naming the staged Bachata VSIX and Browser Bridge ZIP hashes; a record produced from any other artifact is void. The gate hashes the staged artifacts itself and refuses when they are missing, when `package.json` version and VSIX version disagree, or when the artifact table names a different hash or version.

The record files carry the human evidence that automated tests cannot produce: graphical Extension Host validation, authenticated live-provider smoke, exact Bridge ZIP validation, per-platform suite results, and responsiveness under state contention.

They do not yet record human attention compression or longitudinal review saturation. Those public claims remain blocked until moderated validation records outcomes against exact build. Installation and release of accurately limited functionality do not depend on unclaimed outcomes.

### What is still open in this tree

These are owner inputs. Nothing in the source can supply them, and the gate stays red until a human records them.

| Item | Where | Current value |
| --- | --- | --- |
| Marketplace publisher identity | `package.json` `publisher` | `todo-release-publisher` |
| Repository URL | `package.json` `repository.url` | `https://todo-release.invalid/bachata-vscode.git` |
| Homepage | `package.json` `homepage` | `https://todo-release.invalid/bachata-vscode` |
| Issue tracker | `package.json` `bugs.url` | `https://todo-release.invalid/bachata-vscode/issues` |
| Q&A | `package.json` `qna` | `https://todo-release.invalid/bachata-vscode/discussions` |
| Support | `package.json` `sponsor.url` | `https://todo-release.invalid/bachata-vscode/support` |
| Provider documentation URLs | `src/readiness/providerDocs.ts` | Bridge acquisition URL placeholder remains |
| Browser Bridge acquisition URL | `docs/BROWSER_BRIDGE_INSTALL.md` | no public URL |
| Screenshots of the packaged build | `media/screenshots/` | none present, and `README.md` references none |
| Graphical, live-provider, Bridge, cross-platform, and contention evidence | `docs/RELEASE_VALIDATION_RECORD.md` | every row `Not performed` |
| Provider terms review | `docs/PROVIDER_TERMS.md` | every row `Not reviewed` |
| Compatibility rows | `docs/COMPATIBILITY_MATRIX.md` | every row `Not tested` |
| Z.AI API key for the live GLM smoke | environment variable named by `bachata.zaiAuthTokenEnvironment` | not present in this environment |
| Z.AI terms decision for the integration mode Bachata actually uses | `docs/PROVIDER_TERMS.md` | `Not reviewed` |

The Z.AI credential blocks only the Z.AI live smoke row. Its deterministic provider-identity, configuration, environment-isolation, and Doctor-redaction tests run without a credential in `tests/providerIsolation.test.cjs`, and a missing key is recorded as `Blocked (no credential)`, never as a pass.

## No telemetry

Execution byte limits, action counts, and deadlines are request-local control-flow bounds. They are not persisted as usage history or reported remotely. A release must not add analytics, crash reporting, remote diagnostics, installation identifiers, provider-success metrics, prompt-size history, response-duration history, or other telemetry.
