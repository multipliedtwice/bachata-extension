# Support matrix

Compatibility evidence says path ran on recorded build. It does not prove software-quality improvement or model correctness. See [Product doctrine](PRODUCT_DOCTRINE.md).

Version: Bachata 0.7.0. Browser Protocol: v9.

“Automated” means controlled adapters, mocks, and repository fixtures pass. It does not prove current provider authentication or website compatibility.

| Path | Local VS Code | Remote Extension Host | Automated evidence | Human exact-build evidence |
| --- | --- | --- | --- | --- |
| Codex app server | Designed | Designed | Required release tests | Pending |
| Claude Code | Designed | Designed | Required release tests | Pending |
| Z.AI GLM | Designed | Designed | Provider identity, configuration, environment isolation, and Doctor redaction tests | Pending; live smoke needs a Z.AI API key |
| ChatGPT Browser | Designed | Unsupported | Bridge protocol and mock tests | Pending |
| Claude Browser | Designed | Unsupported | Bridge protocol and mock tests | Pending |
| Generic Browser | Designed | Unsupported | Bridge protocol and target fixtures | Pending for each claimed site |
| Managed TODO worktrees | Designed | Designed | Git fixture tests | Pending on Linux, macOS, and Windows |

## Stable release blockers

Each blocker below has one machine-checked record. The gate runs in three stages: `check:release-metadata:identity` runs before the candidate is packaged, `check:release-metadata:evidence` validates the human records produced by testing that candidate, and `npm run release:verify` checks identity, evidence, and artifact binding together before publication. Evidence about the candidate is never gated before the candidate exists.

| Blocker | Record | Checked by |
| --- | --- | --- |
| Authenticated Codex, Claude Code, Z.AI GLM, ChatGPT, and Claude runs on the exact packaged build | `docs/RELEASE_VALIDATION_RECORD.md` section 2 | no `Not performed` row |
| Graphical Extension Host run from `docs/HUMAN_E2E.md` | `docs/RELEASE_VALIDATION_RECORD.md` section 1 | no `Not performed` row |
| Browser Bridge human smoke run from its exact release ZIP | `docs/RELEASE_VALIDATION_RECORD.md` section 3 | no `Not performed` row |
| Linux, macOS, and Windows suite plus graphical checklist | `docs/RELEASE_VALIDATION_RECORD.md` section 4 | no `Not performed` row |
| Marketplace publisher identity, repository, homepage, issues, support, screenshots | `package.json`, `media/screenshots/` | `scripts/check-release-metadata.mjs` |
| Public Browser Bridge acquisition path | `docs/BROWSER_BRIDGE_INSTALL.md` | non-placeholder https URL |
| Provider usage-terms review | `docs/PROVIDER_TERMS.md` | no `Not reviewed` row |
| Public compatibility evidence | `docs/COMPATIBILITY_MATRIX.md` | no `Not tested` row |
| Synchronous state responsiveness under contention | `docs/RELEASE_VALIDATION_RECORD.md` section 5 | no `Not performed` row |

Do not mark a pending cell as supported from protocol similarity or an older build.
