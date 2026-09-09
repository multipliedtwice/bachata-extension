# Release verdict

Artifacts under test: Bachata VSIX `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03`, Browser Bridge ZIP `d531ebb5f4988b99a78fd00c06e82f7e2c8cfbb10bf3b7b3a2f5f4f904af7fc5`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Exact-package graphical acceptance, authenticated-provider smoke, provider-terms
and compatibility records remain open. No human acceptance inferred from automated
results. Earlier VSIX acceptance evidence does not cover this build.

The named artifacts are the current verified candidates. Keep these exact bytes;
acceptance and final paired verification remain open.

## Current candidate evidence

2026-09-08. VSIX source: `eb489e26a3424252cab8da1588f171eddf871f58`.
[Paired candidate run 34264153634](https://github.com/multipliedtwice/bachata-extension/actions/runs/34264153634)
passed on Linux with Node 22.13.0: authenticated Bridge download, contract digest
and shared fixture parity, types, lint, format, artifact-required tests, coverage,
packaging and source-drift check. VSCE 3.9.2 produced the exact downloaded VSIX.

GitHub artifact `10071730090` outer ZIP digest:
`11a5afa8929adf1f1d3054d8925e6996c6c8f3f7146920f16550a816f3d77541`.
Download matches that digest. VSIX: 1,885 files, 11,955,251 bytes;
793 build-equivalent runtime files. Hosted verification compared source, runtime
and locked production dependencies, including VSCE's expected Markdown link
transformation. Local archive matches the hosted VSIX digest above.

This VSIX includes trusted Windows executable and shell resolution, bounded
missing-command handling, sealed-file identity checks, and confirmed Codex
transport cleanup before recovery. It also includes independent filesystem-root
volume proof for zero-device Windows pathname metadata, attachment and artifact
no-follow reads, and failed SQLite activation cleanup. Prior VSIX artifacts are
superseded.

Bridge source: `608138788ea398003ae478acdf916e3a304ed80b`.
[Artifact run 34266310785](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34266310785)
passed. ZIP: 58 files, 1,052,383 bytes; every file matches the hosted build. The
replacement removes only the redundant `activeTab` permission from the prior ZIP.
Protocol contract and both shared fixture tables remain unchanged and match the
extension's compatibility pin, so the verified VSIX remains applicable. The VSIX
candidate run used the prior Bridge archive; local byte and contract verification
covers the replacement. Final paired verification must check this new pair.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| Paired candidate `npm test` | 3061 tests, 3060 passed, 0 failed, 1 skip: Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3044); required artifact cases passed. |
| VSIX prepublish `npm test` | 3061 tests, 3060 passed, 0 failed, 1 skip: Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3044). |
| Linux source `npm test` | 3061 tests, 3057 passed, 0 failed, 4 skips: three archive cases covered by paired candidate plus Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3044). All release gates passed. |
| macOS source `npm test` | 3061 tests, 3050 passed, 0 failed, 11 skips: seven Linux-only descendant cases, three archive cases covered by paired candidate and Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3044). All release gates passed. |
| Windows source `npm test` | 3061 tests, 3028 passed, 0 failed, 33 skips: three archive cases covered by paired candidate and 30 platform-specific cases. Commands: `test:source-distribution` (17) plus `test:unit` (3044). |
| Windows source coverage (failed) | 3044 tests, 3010 passed, 1 failed, 0 cancelled, 33 skips. Retained-work inspection fixture failed before its expected verification refusal. Critical and subsequent coverage gates did not run. |
| Browser Bridge packaging `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Artifact run 34266310785: `test:source-distribution` (6) plus main suite (1204). All three platform gates also passed in run 34266259840 at source `6081387`. |
| Packaged macOS activation | Exact VSIX installed in a fresh VS Code 1.135.0 profile. Existing `e2e/activation/index.cjs` passed against installed files: all 29 pipelines rendered/selectable, custom pipeline creation and JSON round-trip, invalid-JSON recovery, menu hit/focus checks, zero global alerts. Automated smoke only; human checklist remains open. |
| Dependency audit | 2026-09-08 authorized registry audits reported zero vulnerabilities in both packages. Package manifests and lockfiles remain unchanged since those audits; candidate dependency closure verified during packaging. No fresh audit claimed. |

[Extension release gates 34263466590](https://github.com/multipliedtwice/bachata-extension/actions/runs/34263466590)
passed all gates on Linux and macOS at candidate source `eb489e2`. Windows full
tests and four early native gates passed. Source coverage failed one fixture in
`orchestratedFeatureDelivery.test.cjs`; investigation and a corrected run remain
open. The fixture expected a completed run but received another status; the underlying
run error was not printed. Coverage completed normally, without a
timeout; critical and later coverage gates did not run. No skipped gate counted
as passed. Final paired verification must compare the accepted
VSIX with the final checkout and the new Bridge archive before deployment.

[Focused Windows coverage run 34293903164](https://github.com/multipliedtwice/bachata-extension/actions/runs/34293903164)
passed on 2026-09-09 at source `da916e5`: 61 preflight tests, three isolated
retained-case repetitions, and all 19 feature-delivery tests. Zero failures,
cancellations or skips. Original full-suite failure remains unreproduced;
this focused result does not clear the remaining Windows gates.

[Concurrent Windows coverage run 34297997079](https://github.com/multipliedtwice/bachata-extension/actions/runs/34297997079)
failed on 2026-09-09 at source `6175f43`: 122 tests, 119 passed, one failed,
two platform-specific skips, zero cancellations. Original retained-run case passed.
The verification-command sequencing fixture exceeded its five-second deadline
after printing `ok`; cleanup was confirmed. Its Windows-only allowance is now
30 seconds, with explicit output and cleanup assertions. Production deadlines
and the separate intentional-timeout test remain unchanged.

[Complete Windows coverage run 34300890741](https://github.com/multipliedtwice/bachata-extension/actions/runs/34300890741)
failed on 2026-09-09 at source `39872fd`. Preflight passed 61 tests; early native
sequencing and intentional-timeout coverage passed both tests, zero failures,
cancellations or skips. Source coverage then exceeded the aggregate 3,600,000 ms
command limit while tests were still completing. Partial output: 2,472 passed,
24 skipped, no observed assertion failures; no completed suite summary. Original
retained-run, sequencing and intentional-timeout cases passed in that source run.
Critical and subsequent coverage, identity and drift gates did not run. Windows
CI coverage commands now allow 7,200,000 ms; production deadlines, individual
test deadlines and coverage floors remain unchanged. Complete verification is open.

[Bridge release gates 34266259840](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34266259840)
passed on all three platforms at artifact source `6081387`.

Encrypted Bridge read token and Marketplace PAT configured; both expire
2026-10-08. Chrome OAuth client, secret and refresh token are encrypted in the
marketplace environment. Token refresh succeeded. OAuth app remains in Testing;
refresh token expires seven days after issue on 2026-09-08 UTC. Renew before
2026-09-15 UTC. Chrome publisher/item variables match the supplied draft item
`pkjbokfimenacagphechjmlogogghaip`. Publisher reported Chrome Store submission
for review on 2026-09-09. Google review outcome and live publication remain
unverified. Submission does not establish exact-artifact acceptance or a
stable-release verdict. VS Code deployment and final paired verification remain open.

Coverage policy: the floors, not these percentages, are the claim. Enforced floors
live in package.json. Source floors: 78 / 73 / 80 lines / branches / functions.
No percentage inferred from a prior build. Source measurements: BUILD_FACTS.md.
Maintained-source distribution: `npm run source:export` then `npm run source:verify`.

## Publication still blocked

- Resolve the Windows retained-work coverage failure; pass remaining Windows gates.
- Complete applicable RELEASE_VALIDATION_RECORD.md and COMPATIBILITY_MATRIX.md rows.
- Complete provider-terms review in PROVIDER_TERMS.md.
- Capture screenshots from this packaged build.
- Await Chrome review outcome and confirm live publication; keep publishing credentials valid.
- Run `npm run release:verify`; human reviews bound evidence and owns verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features follow STABLE_RELEASE_GATE.md and TODO.md; no completion inferred.
