# Release validation record

One file, one release. It records the exact artifacts and the human validation that automated tests cannot replace. `Not performed` blocks the release metadata gate.

Artifacts under test: Bachata VSIX `e5d3ab17e2e52a087b1e8e86b7321a288227669e481b0ab002ed38428ce45dca`, Browser Bridge ZIP `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b`.

Every record in this file is void unless it names one of those hashes. A record produced from a rebuild is void.


## Artifacts under test

| Artifact | Version | SHA-256 | Recorded |
| --- | --- | --- | --- |
| Bachata VSIX | 0.7.0 | `e5d3ab17e2e52a087b1e8e86b7321a288227669e481b0ab002ed38428ce45dca` | yes |
| Browser Bridge ZIP | 0.6.7 | `e50b147fd1eab3dd1e277e7211d75c347cb965d29d4670414bbd01dd2c71b80b` | yes |

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
| macOS | — | — | — | — | — | — | — | Not performed |
| Linux | — | — | — | — | — | — | — | Not performed |
| Windows | — | — | — | — | — | — | — | Not performed |

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
| Network-backed dependency audit | 2026-09-08 | `e5d3ab17e2e52a087b1e8e86b7321a288227669e481b0ab002ed38428ce45dca` | Passed | Authorized npm audit against each locked checkout: extension and Bridge each report zero vulnerabilities. |
