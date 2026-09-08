# Release verdict

Artifacts under test: Bachata VSIX `ce1e4b6753d2d877a78b617e7b4308789500d6051695a0cc358c9ac2cb42b97d`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

## Verdict

**NO-SHIP as a stable release. The source tree is a closed-alpha candidate.**

Exact-package graphical acceptance, authenticated-provider smoke, provider-terms
and compatibility records remain open. No human acceptance inferred from automated
results. Earlier VSIX acceptance evidence does not cover this build.

The VSIX named above is superseded by the Windows sealed-file identity correction.
Do not publish it. Replacement packaging and acceptance remain open.

## Superseded candidate evidence

2026-09-08. VSIX source: `be015c4058f5cfed31d24dd6343f3f3138ae1d34`.
[Paired candidate run 34251453740](https://github.com/multipliedtwice/bachata-extension/actions/runs/34251453740)
passed on Linux with Node 22.13.0: authenticated Bridge download, contract digest
and shared fixture parity, types, lint, format, artifact-required tests, coverage,
packaging and source-drift check. VSCE 3.9.2 produced the exact downloaded VSIX.

GitHub artifact `10066888048` outer ZIP digest:
`72f229e6cba994b81b89bafed6f34e3be3636018e30211cedb3da8cd8379e47b`.
Download matches that digest. VSIX: 1,885 files, 11,953,354 bytes;
793 build-equivalent runtime files. Hosted verification compared source, runtime
and locked production dependencies, including VSCE's expected Markdown link
transformation. Local archive matches the hosted VSIX digest above.

This VSIX includes trusted Windows executable and shell resolution, bounded
missing-command handling, sealed-file identity checks, and confirmed Codex
transport cleanup before recovery. Prior VSIX artifacts are superseded.

Bridge source: `5ae4436107bf5b4d14ccd4ac8d1a9865febc366a`.
[Artifact run 34200295838](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34200295838)
passed. ZIP matches all 58 hosted build files. Protocol contract and shared
fixtures match the extension's compatibility pin. Keep these exact bytes.

Test counts: every `node --test` invocation the package's `npm test` chain
runs, summed, with contributing commands named. Platform skips are not passes.

| Gate | Result |
| --- | --- |
| Paired candidate `npm test` | 3040 tests, 3039 passed, 0 failed, 1 skip: Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3023); required artifact cases passed. |
| VSIX prepublish `npm test` | 3040 tests, 3039 passed, 0 failed, 1 skip: Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3023). |
| Linux source `npm test` | 3040 tests, 3036 passed, 0 failed, 4 skips: three archive cases covered by paired candidate plus Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3023). All release gates passed. |
| macOS source `npm test` | 3040 tests, 3029 passed, 0 failed, 11 skips: seven Linux-only descendant cases, three archive cases covered by paired candidate and Windows-only cleanup. Commands: `test:source-distribution` (17) plus `test:unit` (3023). All release gates passed. |
| Native Windows safety | Actual VS Code 1.136.1 process checks and the early release safety step passed. Full suite found concurrent Git test-shim writes failing with a Windows file-sharing error and two normal sealed-file cases rejected by mismatched volume-ID widths. Remaining tests continue; coverage has not run. |
| Browser Bridge `npm test` | 1210 tests, 1210 passed, 0 failed, 0 skips. Hosted `test:source-distribution` (6) plus main suite (1204). |
| Packaged macOS activation | Exact VSIX installed in a fresh VS Code 1.135.0 profile. Existing `e2e/activation/index.cjs` passed against installed files: all 29 pipelines rendered/selectable, custom pipeline creation and JSON round-trip, invalid-JSON recovery, menu hit/focus checks, zero global alerts. Automated smoke only; human checklist remains open. |
| Dependency audit | Zero reported vulnerabilities in both unchanged locked checkouts. Candidate dependency closure verified during packaging. |

[Extension release gates 34251412987](https://github.com/multipliedtwice/bachata-extension/actions/runs/34251412987)
validate the candidate source revision on Ubuntu, macOS and Windows. Linux and
macOS passed all gates. Windows remains blocked by the test-shim and sealing failures
and unfinished checks. No pending gate counted as passed. Final paired verification must
compare the accepted VSIX with the final checkout before deployment.

Follow-up fixture correction writes one record per Git invocation, preserving
argument, environment and cleanup assertions under concurrent calls. The complete
four-test file passed against rebuilt source on macOS; native Windows validation
remains pending. The file now runs in the early Windows safety step. These test,
workflow and evidence changes do not alter packaged bytes.

The sealing correction follows libuv 1.51's Windows volume-ID normalization while
retaining full inode precision, exact path-to-path identity and replacement guards.
Build, 240 managed-fallback checks and seven focused tests passed on macOS with
Node 22.13.1 and Git 2.55.0; zero skips. Native run 34259408093 still rejected the
two normal sealed-file cases. Its identity matrix and replacement checks passed;
the normalization alone did not resolve the failure. A native fixture reports
the exact compared file identities to establish the remaining cause. Replacement
packaging stays blocked until native sealing passes.

[Bridge release gates 34249800393](https://github.com/multipliedtwice/bachata-browser-bridge/actions/runs/34249800393)
passed on all three platforms at `68d5ba1`. Changes after the Bridge artifact source
are documentation only; the verified archive is unchanged.

Encrypted Bridge read token and Marketplace PAT configured; both expire
2026-10-08. Acceptance verification and deployment remain open.

Coverage policy: the floors, not these percentages, are the claim. Enforced floors
live in package.json. Source floors: 78 / 73 / 80 lines / branches / functions.
No percentage inferred from a prior build. Source measurements: BUILD_FACTS.md.
Maintained-source distribution: `npm run source:export` then `npm run source:verify`.

## Publication still blocked

- Finish corrected extension platform gates and build a replacement VSIX.
- Complete applicable RELEASE_VALIDATION_RECORD.md and COMPATIBILITY_MATRIX.md rows.
- Complete provider-terms review in PROVIDER_TERMS.md.
- Capture screenshots from this packaged build.
- Configure Chrome item and publishing credentials.
- Run `npm run release:verify`; human reviews bound evidence and owns verdict.

Moderated validation and benchmark claims remain unproved. Unclaimed future
features follow STABLE_RELEASE_GATE.md and TODO.md; no completion inferred.
