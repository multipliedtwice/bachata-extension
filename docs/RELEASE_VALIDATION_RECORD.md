# Release validation record

One file, one release. It records the exact artifacts and the human validation that automated tests cannot replace. `Not performed` blocks the release metadata gate.

Artifacts under test: Bachata VSIX `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03`, Browser Bridge ZIP `d531ebb5f4988b99a78fd00c06e82f7e2c8cfbb10bf3b7b3a2f5f4f904af7fc5`.

Every record in this file is void unless it names one of those hashes. A record produced from a rebuild is void.


## Artifacts under test

| Artifact | Version | SHA-256 | Recorded |
| --- | --- | --- | --- |
| Bachata VSIX | 0.7.0 | `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03` | yes |
| Browser Bridge ZIP | 0.6.7 | `d531ebb5f4988b99a78fd00c06e82f7e2c8cfbb10bf3b7b3a2f5f4f904af7fc5` | yes |

## 1. Graphical Extension Host validation

Install the exact VSIX in a clean VS Code profile and complete `docs/HUMAN_E2E.md` end to end: activation, view rendering, navigation, dialogs, focus behaviour, settings, and the Result Center evidence checks.

| OS | VS Code version | VSIX SHA-256 | Date | Operator | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| macOS | — | — | — | — | Not performed | — |
| Linux | — | — | — | — | Not performed | — |
| Windows | — | — | — | — | Not performed | — |

## 2. Authenticated live-provider smoke

Complete `docs/LIVE_SMOKE_TEST.md` against real, signed-in providers using the exact artifacts. Mocked adapters do not satisfy this section.

Local providers need the VSIX only. Browser providers also need the exact Browser Bridge ZIP, so they are recorded separately and every row must name both artifacts.

| Provider | Provider build seen | Auth state | Date | VSIX SHA-256 | Result | Completion detection | Interruption | Conversation continuity | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex app server | — | — | — | — | Not performed | — | — | — | — |
| Claude Code | — | — | — | — | Not performed | — | — | — | — |
| Z.AI GLM | — | — | — | — | Not performed | — | — | — | — |

| Provider | Provider build seen | Auth state | Date | VSIX SHA-256 | Bridge SHA-256 | Result | Completion detection | Interruption | Conversation continuity | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT browser | — | — | — | — | — | Not performed | — | — | — | — |
| Claude browser | — | — | — | — | — | Not performed | — | — | — | — |
| Generic browser target | — | — | — | — | — | Not performed | — | — | — | — |

## 3. Browser Bridge live validation

Load the exact Bridge ZIP in a clean browser profile. Structure tests and unit tests do not cover any row here.

| Step | Date | VSIX SHA-256 | Bridge SHA-256 | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| Install from verified ZIP | — | — | — | Not performed | — |
| Pair with the local endpoint | — | — | — | Not performed | — |
| Reconnect after bridge restart | — | — | — | Not performed | — |
| Tab refresh keeps the binding | — | — | — | Not performed | — |
| Interruption stops the running turn | — | — | — | Not performed | — |
| Completion detection on a long answer | — | — | — | Not performed | — |
| Stale binding recovery after tab close | — | — | — | Not performed | — |

## 4. Cross-platform suite

Run the full release suite from `docs/STABLE_RELEASE_GATE.md` on each clean environment. Record skipped tests explicitly; a skipped platform-specific test is not a pass.

| OS | Node version | Git version | VSIX SHA-256 | Suite result | Skipped tests | Graphical checklist | Date | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| macOS | 22.13.0 | 2.55.0 | `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03` | Automated gates passed at source `eb489e2`, run 34263466590; 3061 tests, 3050 passed, 0 failed | 11: seven Linux-only descendant cases, three archive cases covered by the paired candidate, one Windows-only cleanup case | Not performed | 2026-09-08 | Not performed |
| Linux | 22.13.0 | 2.55.0 | `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03` | Automated gates passed at source `eb489e2`, run 34263466590; 3061 tests, 3057 passed, 0 failed | 4: three archive cases covered by the paired candidate, one Windows-only cleanup case | Not performed | 2026-09-08 | Not performed |
| Windows | 22.13.0 | 2.55.0.windows.5 | `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03` | Full tests passed at `eb489e2`, run 34263466590: 3061 tests, 3028 passed, 0 failed. All 43 coverage gates and metadata identity/source-drift checks passed at `32d439a`, run 34312578589. Source and critical each: 3044 tests, 3011 passed, 0 failed, 0 cancelled. Other 41 coverage gates: 890 passed, zero failures, cancellations or skips | 33 per full source/critical suite: three archive cases covered by paired candidate and 30 platform-specific cases; skips are not passes | Not performed | 2026-09-09 | Not performed |

## 5. Responsiveness under synchronous state access

Unconfirmed risk, not a defect. The state store is synchronous and waits on a lock during contention. Reproduce or clear it before a stable claim.

| Scenario | Date | VSIX SHA-256 | Result | Longest blocked interval | Notes |
| --- | --- | --- | --- | --- | --- |
| Graphical cold start on a large state file | — | — | Not performed | — | — |
| Two VS Code windows contending for one repository | — | — | Not performed | — | — |
| Lock timeout and recovery | — | — | Not performed | — | — |
| State recovery after a forced Extension Host restart | — | — | Not performed | — | — |

## 6. Dependency audit

| Check | Date | VSIX SHA-256 | Result | Notes |
| --- | --- | --- | --- | --- |
| Network-backed dependency audit | 2026-09-08 | `b2de4cafc69281279c4bf08434da644b842da8293f351d4b669b5619d4d7ec03` | Pass | Authorized registry audits: zero vulnerabilities for extension and Bridge. Package manifests and lockfiles unchanged since those audits; current candidate dependency closure verified during packaging. This records the original audit, not a fresh registry request. |
