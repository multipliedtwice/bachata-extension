# Screenshots

**This directory is empty. None of the six required screenshots has been captured yet, so the repository README and the marketplace listing currently show no picture of the product.** Producing them needs a human at a real VS Code window, and it stays that person's task: nothing in the build can generate them. Every shot must be taken from the packaged Bachata VSIX installed in a clean VS Code profile, and that VSIX must be the one whose SHA-256 is recorded in `docs/RELEASE_VALIDATION_RECORD.md`. If a later build supersedes that VSIX, the whole set has to be captured again from the new one. Mockups, composites, images from an older build, and edited images are not acceptable, and a placeholder must never be committed here.

`scripts/check-release-metadata.mjs` reports a finding while this directory holds no image, and a second finding while the repository README references no screenshot under `media/screenshots/`. Both findings are open. Do not add the README references until the matching image files exist, because a reference to a missing file produces a third finding instead of clearing the first two.

## Still to capture

| File | What the shot must show |
| --- | --- |
| `setup-wizard.png` | Workflow setup with every field resolved: the human goal, the Lead and Worker roles, the selected providers, the path scope, the declared checks, and the completion policy. |
| `run-contract.png` | The resolved run contract as it appears immediately before a run starts, including its assurance label and the outbound context the run may read. |
| `execution-view.png` | The Execution view of a finished run, showing the workflow stages, the gates, and the task runs. |
| `result-center.png` | The run result summary: accepted actionable findings, core decisions, the current direction, material unresolved items, and one expanded drill-down showing provenance. |
| `apply-handoff.png` | The inspect-and-apply handoff, including the failure path in which the working tree is restored and the worktree is kept. |
| `doctor.png` | Doctor findings with the per-finding remediation action visible on at least one blocking finding. |

## How to capture them

Capture at 1280x800 or larger. The default light theme and the default dark theme are both acceptable, but use one theme for the whole set. No personal repository content, no provider account identity, and no conversation URLs may be visible in any frame.

Once every file above exists, reference at least `execution-view.png` and `result-center.png` from the repository README, above the "What this does not prove" section, and rerun `scripts/check-release-metadata.mjs`.
