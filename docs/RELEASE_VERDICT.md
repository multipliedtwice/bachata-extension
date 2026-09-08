# Release verdict

Artifacts under test: Bachata VSIX `d7951ef2b346e8438d5586a1acf2e7fb3806bb99b1b27c2a0ca544c8ef165f18`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Exact-package graphical acceptance, authenticated-provider smoke, provider-terms
decisions and compatibility records remain open. No human acceptance inferred
from automated results. Earlier VSIX acceptance evidence does not cover this build.

## Verified candidate evidence

2026-09-08. VSIX source: `ed36658a04ffe3f1f646236e89a3521209b8d493`.
[Paired candidate run 34228223329](https://github.com/multipliedtwice/bachata-extension/actions/runs/34228223329)
passed on Linux with Node 22.13.0: authenticated Bridge artifact download, contract
digest and shared fixture parity, types, lint, format, tests, coverage, packaging
and source-drift check. VSCE 3.9.2 produced the exact downloaded VSIX.

GitHub artifact `10057413687` outer ZIP digest:
`73d93b0d9008a4f0a8b6f27397169ddd7afb54bae9b95435157d78e8530130a7`.
Download matches that digest. VSIX: 1,885 files, 11,951,404 bytes;
793 build-equivalent runtime files. Hosted verification compared source,
runtime and locked production dependencies, including VSCE's expected Markdown
link transformation. Local archive matches the hosted VSIX digest above.

Bridge source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
[Release artifact run 34200295838](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34200295838)
passed. ZIP matches all 58 hosted build files. Protocol contract and shared fixtures
match the extension's compatibility pin. Keep these exact bytes.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| Paired candidate `npm test` | 3023 tests, 3022 passed, 0 failed, 1 skip requiring Windows descendant cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3006); required artifact cases passed. |
| VSIX prepublish `npm test` | 3023 tests, 3022 passed, 0 failed, 1 skip requiring Windows descendant cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3006). |
| Linux source `npm test` | 3023 tests, 3019 passed, 0 failed, 4 skips: three archive cases covered by paired candidate plus Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3006). |
| Actual Windows VS Code 1.136.1 | Native provider-script, compiler and process checks passed in release run 34228016884. Full suite remains separate. |
| Browser Bridge `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Hosted `test:source-distribution` (6) plus main suite (1204). |
| Dependency audit | Zero reported vulnerabilities in both unchanged locked checkouts. Candidate dependency closure verified during packaging. |

Extension [release gates run 34228016884](https://github.com/multipliedtwice/bachata-extension/actions/runs/34228016884):
Linux and macOS passed all gates. Windows passed native process checks, actual
VS Code checks and UI layout, then exposed test-fixture path, permission and
cleanup assumptions. Its orchestration file exceeded the aggregate ten-minute
test budget after passing long scenarios. Fixture corrections and finite Windows
CI budget changes need a complete rerun. No pending gate counted as passed.

Bridge [release gates run 34199689556](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34199689556):
Ubuntu, macOS and Windows passed types, lint, format, tests, coverage, packaging
and source-drift checks.

Encrypted Bridge read token and Marketplace PAT configured; both expire
2026-10-08. Acceptance verification and deployment remain open.

Coverage policy: the floors, not these percentages, are the claim. Enforced floors
live in package.json. Source floors:
78 / 73 / 80 lines / branches / functions. No percentage inferred from a prior build.
Source measurements: BUILD_FACTS.md. Maintained-source distribution:
`npm run source:export` then `npm run source:verify`.

## Publication still blocked

- Complete applicable RELEASE_VALIDATION_RECORD.md and COMPATIBILITY_MATRIX.md rows.
- Complete provider-terms review in PROVIDER_TERMS.md.
- Capture screenshots from this packaged build.
- Configure Chrome item and deployment credentials.
- Pass corrected extension platform gates.
- Run `npm run release:verify`; human reviews bound evidence and owns verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features follow STABLE_RELEASE_GATE.md and TODO.md; no completion inferred.
