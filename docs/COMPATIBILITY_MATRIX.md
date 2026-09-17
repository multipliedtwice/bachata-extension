# Compatibility matrix

Public, versioned record of what has actually been exercised against the exact packaged artifacts. Every row is one dated test of one combination. `Not tested` means no run exists; it is never inferred from a similar row.

Extension: Bachata 0.7.0. Browser protocol: v9. Bridge: bachata-browser-bridge 0.6.8.

Every row names the exact VS Code build it was exercised on, reported by `Code > About` as the `Version` field, for example `1.101.2`. `engines.vscode` declares the floor Bachata claims to support; a row is evidence only for the build it names. A recorded row with no exact version is not evidence and the release metadata gate refuses it.

Artifacts under test: Bachata VSIX `b747d340d83db77354b8eeeca9ce2a6475ab9ee39c0f529a4666fea009fa2b5b`, Browser Bridge ZIP `b0f2d7d9a2a4d9dab78a7bfd447fb8dc2ca12ca64cfbebbba8b2bdcc40f182bd`.

Every record in this file is void unless it names one of those hashes. A record produced from a rebuild is void.


## How a row is earned

1. Install the exact release VSIX in a clean VS Code profile.
2. Install the exact release Bridge ZIP in a clean browser profile, when the row needs one.
3. Run the checklist named in the row (`docs/HUMAN_E2E.md`, `docs/LIVE_SMOKE_TEST.md`, or both).
4. Record the result, the provider build identifier visible on the day, and every limitation observed.

A provider website can change on any day. A passing row is evidence for its date, not a forward guarantee.

## Local provider rows

| Extension | VS Code version | Provider | Provider version | OS | Checklist | Date | VSIX SHA-256 | Result | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7.0 | — | Codex app server | — | macOS | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Codex app server | — | Linux | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Codex app server | — | Windows | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Claude Code | — | macOS | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Claude Code | — | Linux | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Claude Code | — | Windows | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Z.AI GLM | — | macOS | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Z.AI GLM | — | Linux | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |
| 0.7.0 | — | Z.AI GLM | — | Windows | HUMAN_E2E + LIVE_SMOKE_TEST | — | — | Not tested | — |

## Browser provider rows

| Extension | VS Code version | Bridge | Provider | Browser | OS | Checklist | Date | VSIX SHA-256 | Bridge SHA-256 | Result | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7.0 | — | 0.6.8 | ChatGPT | Chrome | macOS | LIVE_SMOKE_TEST | — | — | — | Not tested | — |
| 0.7.0 | — | 0.6.8 | ChatGPT | Edge | Windows | LIVE_SMOKE_TEST | — | — | — | Not tested | — |
| 0.7.0 | — | 0.6.8 | Claude | Chrome | macOS | LIVE_SMOKE_TEST | — | — | — | Not tested | — |
| 0.7.0 | — | 0.6.8 | Claude | Edge | Windows | LIVE_SMOKE_TEST | — | — | — | Not tested | — |
| 0.7.0 | — | 0.6.8 | Generic target | Chrome | macOS | LIVE_SMOKE_TEST | — | — | — | Not tested | — |

## Local model endpoint rows

| Extension | VS Code version | Runtime | Model | OS | Checklist | Date | VSIX SHA-256 | Result | Known limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.7.0 | — | — | — | — | SEMANTIC_INTERPRETER fixtures | — | — | Not tested | — |

## Publication

This file is not packaged. It names the SHA-256 of the artifact it describes, so shipping it inside that artifact would change the hash it had just recorded. It lives in the repository, beside the release verdict, the validation record, and the provider terms.
