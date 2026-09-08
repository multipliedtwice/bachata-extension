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
| Windows source suite | Full suite and coverage remain pending in run 34263466590. All four early native Windows gates passed; they do not establish a full-suite pass. |
| Browser Bridge packaging `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Artifact run 34266310785: `test:source-distribution` (6) plus main suite (1204). All three platform gates also passed in run 34266259840 at source `6081387`. |
| Packaged macOS activation | Exact VSIX installed in a fresh VS Code 1.135.0 profile. Existing `e2e/activation/index.cjs` passed against installed files: all 29 pipelines rendered/selectable, custom pipeline creation and JSON round-trip, invalid-JSON recovery, menu hit/focus checks, zero global alerts. Automated smoke only; human checklist remains open. |
| Dependency audit | 2026-09-08 authorized registry audits reported zero vulnerabilities in both packages. Package manifests and lockfiles remain unchanged since those audits; candidate dependency closure verified during packaging. No fresh audit claimed. |

[Extension release gates 34263466590](https://github.com/multipliedtwice/bachata-extension/actions/runs/34263466590)
passed all gates on Linux and macOS at candidate source `eb489e2`. Windows full
suite and coverage remain pending. No pending or skipped gate counted as passed.
The early native checks cover the corrected safety boundaries; complete platform
validation remains required. Final paired verification must compare the accepted
VSIX with the final checkout and the new Bridge archive before deployment.

[Bridge release gates 34266259840](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34266259840)
passed on all three platforms at artifact source `6081387`.

Encrypted Bridge read token and Marketplace PAT configured; both expire
2026-10-08. Chrome OAuth client, secret and refresh token are encrypted in the
marketplace environment. Token refresh succeeded. OAuth app remains in Testing;
refresh token expires seven days after issue on 2026-09-08 UTC. Renew before
2026-09-15 UTC. Chrome publisher/item variables, acceptance verification and
deployment remain open.

Coverage policy: the floors, not these percentages, are the claim. Enforced floors
live in package.json. Source floors: 78 / 73 / 80 lines / branches / functions.
No percentage inferred from a prior build. Source measurements: BUILD_FACTS.md.
Maintained-source distribution: `npm run source:export` then `npm run source:verify`.

## Publication still blocked

- Finish the extension Windows full suite and coverage.
- Complete applicable RELEASE_VALIDATION_RECORD.md and COMPATIBILITY_MATRIX.md rows.
- Complete provider-terms review in PROVIDER_TERMS.md.
- Capture screenshots from this packaged build.
- Configure Chrome item and publisher/item variables; keep publishing credentials valid.
- Run `npm run release:verify`; human reviews bound evidence and owns verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features follow STABLE_RELEASE_GATE.md and TODO.md; no completion inferred.
