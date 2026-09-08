# Release verdict

Artifacts under test: Bachata VSIX `e5d3ab17e2e52a087b1e8e86b7321a288227669e481b0ab002ed38428ce45dca`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Existing NO-SHIP verdict retained. Candidate archives exist and pass byte verification.
Marketplace submission, exact-package graphical acceptance, authenticated-provider
smoke, provider-terms decisions and compatibility records remain open.
No human acceptance inferred from automated results.

## Verified candidate evidence

2026-09-08. VSIX source: `c705b0ae` revision prefix; Node 22.13.1 on macOS.
VSCE 3.9.2 created the replacement VSIX after prepublish checks passed. Verification
accepts VSCE's expected Markdown link transformation and compares exact bytes.
VSIX: 1,885 files, 11,950,356 bytes; 793 build-equivalent runtime files.
Installed in a fresh VS Code 1.135.0 macOS profile. Exact-package automated activation
passed: all 29 shipped pipelines, custom pipeline save and JSON roundtrip, invalid
JSON recovery, advanced options and run menu interaction. Full human checklist
remains open. macOS refused window screenshot capture; no screenshot recorded.
Production dependency closure matches the locked checkout.

Bridge source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
[Release artifact run 34200295838](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34200295838)
succeeded. Downloaded ZIP matches all 58 hosted build files. Protocol contract and
shared fixtures match the extension's compatibility pin. Keep these exact bytes.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| VS Code `npm test` | 3010 tests, 3003 passed, 0 failed, 7 skips. Prepublish chain: `test:source-distribution` (17) plus `test:unit` (2993). Skips require Linux setsid; Linux source CI passed separately. |
| Browser Bridge `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Hosted package chain: `test:source-distribution` (6) plus main suite (1204). |
| Paired-artifact and record regression | 98 passed, zero skips: release binding, metadata and build-facts suites, with BACHATA_REQUIRE_RELEASE_ARTIFACTS=1 and the replacement VSIX plus hosted Bridge ZIP staged. |
| VSIX verifier regression | 8 passed, zero skips. |
| Dependency audit | Zero reported vulnerabilities in both locked checkouts; exact VSIX binding in RELEASE_VALIDATION_RECORD.md. |

Extension [release gates run 34206924699](https://github.com/multipliedtwice/bachata-extension/actions/runs/34206924699):
Linux and macOS passed the corrected layout checks in PR run 34208925507.
Windows native process completion passes in run 34224114646 after restricting the
helper to built-in PowerShell modules and restoring the target's original module path.
Managed worktree checks complete. Native descendant cleanup passes in run 34225649798.
That run's Windows layout check failed during Chrome startup; Linux exposed a recursive
test-runner fixture context. Corrections and complete suite proof remain required.
Source review also found filtered environments removed Electron's required Node mode.
Scoped helper, provider-script and compiler corrections need actual VS Code runtime proof.
Bridge [release gates run 34199689556](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34199689556):
Ubuntu, macOS and Windows passed types, lint, format, tests, coverage, packaging and
source-drift checks.

[Paired candidate run 34221932974](https://github.com/multipliedtwice/bachata-extension/actions/runs/34221932974)
passed: authenticated Bridge artifact download, contract digest and shared fixture
parity, source gates, packaging and source-drift check. Acceptance verification and
deployment remain open. Encrypted Bridge read token and Marketplace PAT configured;
both expire 2026-10-08.

Coverage policy: the floors, not these percentages, are the claim.
Source floors: 78 / 73 / 80 lines / branches / functions. Remaining enforced floors
live in package.json. No new percentage inferred from a prior build.

Machine-derived source identity and package measurements: BUILD_FACTS.md.
Maintained-source distribution: `npm run source:export` then `npm run source:verify`.
Neither source identity nor an automated pass replaces exact-artifact acceptance.

## Publication still blocked

- Complete applicable rows in RELEASE_VALIDATION_RECORD.md and COMPATIBILITY_MATRIX.md.
- Complete provider-terms review in PROVIDER_TERMS.md.
- Capture screenshots from the packaged build.
- Configure Chrome item and Chrome deployment credentials.
- Finish hosted extension gates and paired workflow proof.
- Run `npm run release:verify`; human reviews bound evidence and owns the verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features are governed by STABLE_RELEASE_GATE.md and TODO.md, not inferred as done.
