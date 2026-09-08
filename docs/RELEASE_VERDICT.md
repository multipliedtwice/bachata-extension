# Release verdict

Artifacts under test: Bachata VSIX `8873b19ea4de1757363f2f83c3c18f8676f83c370608ac94209d600b83fb1967`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Human verdict retained. Candidate archives exist and pass byte verification.
Marketplace submission, exact-package graphical acceptance, authenticated-provider
smoke, provider-terms decisions and compatibility records remain open.
No human acceptance inferred from automated results.

## Verified candidate evidence

2026-09-08. VSIX source: `57a816d6` revision prefix; Node 22.13.1 on macOS.
VSCE 3.9.2 created the VSIX after prepublish checks passed. Final verification
accepts VSCE's expected Markdown link transformation and still compares exact bytes.
VSIX: 1,885 files, 11,949,660 bytes; 793 build-equivalent runtime files.
Installation in an isolated VS Code 1.135.0 macOS profile passed. The subsequent
packaged activation smoke failed when opening a run menu after advanced options.
The UI correction and Windows process changes require a replacement candidate;
this bound artifact is not approved for publication.
Production dependency closure matches the locked checkout.

Bridge source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
[Release artifact run 34200295838](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34200295838)
succeeded. Downloaded ZIP matches all 58 hosted build files. Protocol contract and
shared fixtures match the extension's compatibility pin. Keep these exact bytes.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| VS Code `npm test` | 3003 tests, 2996 passed, 0 failed, 7 skips. Prepublish chain: `test:source-distribution` (17) plus `test:unit` (2986). Skips require Linux setsid; Linux source CI passed separately. |
| Browser Bridge `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Hosted package chain: `test:source-distribution` (6) plus main suite (1204). |
| Paired-artifact regression | 63 passed, zero skips, with BACHATA_REQUIRE_RELEASE_ARTIFACTS=1 and the hosted Bridge ZIP staged. |
| VSIX verifier regression | 8 passed, zero skips. |
| Dependency audit | Zero reported vulnerabilities in both locked checkouts; exact VSIX binding in RELEASE_VALIDATION_RECORD.md. |

Extension [release gates run 34200339377](https://github.com/multipliedtwice/bachata-extension/actions/runs/34200339377):
Linux and macOS passed all gates. Windows was canceled after managed-worktree
checks made slow progress for 39 minutes. Timeout and fixture fixes require a new run.
Bridge [release gates run 34199689556](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34199689556):
Ubuntu, macOS and Windows passed types, lint, format, tests, coverage, packaging and
source-drift checks.

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
- Configure Chrome item and marketplace deployment credentials.
- Finish hosted extension gates and paired workflow proof.
- Run `npm run release:verify`; human reviews bound evidence and owns the verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features are governed by STABLE_RELEASE_GATE.md and TODO.md, not inferred as done.
