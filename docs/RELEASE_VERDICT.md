# Release verdict

Artifacts under test: Bachata VSIX `75f1c873a210b48ac373081d17c9ed655e829815542fea2bb628d3d3395ef59a`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Exact-package graphical acceptance, authenticated-provider smoke, provider-terms
decisions and compatibility records remain open. No human acceptance inferred
from automated results. Earlier VSIX acceptance evidence does not cover this build.

Codex recovery can discard ownership of a failed transport before cleanup is
confirmed. The Windows adapter test bodies finish without file completion; this
source-backed defect is consistent with that hang. Fix transport ownership,
validate native recovery and replace this VSIX before acceptance or publication.

## Verified candidate evidence

2026-09-08. VSIX source: `407bec706bd1885747e3887af44162c7efb14279`.
[Paired candidate run 34245180082](https://github.com/multipliedtwice/bachata-extension/actions/runs/34245180082)
passed on Linux with Node 22.13.0: authenticated Bridge artifact download, contract
digest and shared fixture parity, types, lint, format, tests, coverage, packaging
and source-drift check. VSCE 3.9.2 produced the exact downloaded VSIX.

GitHub artifact `10064557035` outer ZIP digest:
`66991d178b471c0efbc54dc3099aa36c98b27cc094f31b7081ac632b6b9c1e74`.
Download matches that digest. VSIX: 1,885 files, 11,952,820 bytes;
793 build-equivalent runtime files. Hosted verification compared source,
runtime and locked production dependencies, including VSCE's expected Markdown
link transformation. Local archive matches the hosted VSIX digest above.

This VSIX includes the Windows executable-lookup, scoped missing-command,
trusted-shell and sealed-file corrections. Prior VSIX artifacts are superseded.
No prior graphical or provider acceptance transferred.

Bridge source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
[Release artifact run 34200295838](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34200295838)
passed. ZIP matches all 58 hosted build files. Protocol contract and shared fixtures
match the extension's compatibility pin. Keep these exact bytes.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| Paired candidate `npm test` | 3035 tests, 3034 passed, 0 failed, 1 skip requiring Windows descendant cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3018); required artifact cases passed. |
| VSIX prepublish `npm test` | 3035 tests, 3034 passed, 0 failed, 1 skip requiring Windows descendant cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3018). |
| Actual Windows VS Code 1.136.1 | Native process, provider, compiler and Git checks passed in release run 34246639736 at `b595f26`. Full suite remains separate. |
| Native Windows release safety | Process completion, trusted shell, secret isolation and sealed-file symbolic-link rejection checks passed in run 34246639736. |
| Linux source `npm test` | 3035 tests, 3031 passed, 0 failed, 4 skips: three archive cases covered by paired candidate plus Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3018). Run 34246639736 at `b595f26` passed all gates, including coverage. |
| macOS source `npm test` | 3035 tests, 3024 passed, 0 failed, 11 skips: seven Linux-only descendant cases, three archive cases covered by paired candidate and Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3018). Run 34246639736 at `b595f26` passed all gates, including coverage. |
| Windows source gates | Run 34246639736 cancelled after all 49 adapter test bodies passed at 15:55:51 UTC without file completion by 16:21:38 UTC. Full suite and coverage did not complete. |
| Browser Bridge `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Hosted `test:source-distribution` (6) plus main suite (1204). |
| Dependency audit | Zero reported vulnerabilities in both unchanged locked checkouts. Candidate dependency closure verified during packaging. |

[Release gates run 34246639736](https://github.com/multipliedtwice/bachata-extension/actions/runs/34246639736)
validates `b595f26d0dcc913917e517acc5d8022917d7c76a` on Ubuntu, macOS and
Windows. Changes after candidate source `407bec7` affect only a native Git test's
scratch cleanup and BUILD_FACTS.md; neither is packaged. Linux and macOS passed
all gates. Native Windows steps passed; its full suite stalled in adapter cleanup
and was cancelled. These results predate the Codex transport-ownership correction.
Corrected platform gates and a replacement VSIX remain required. Final paired
verification must compare the accepted VSIX with the final checkout before deployment.

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
