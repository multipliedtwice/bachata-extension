# Bachata UI/UX iteration

Scope: VS Code extension. Existing 0.7.0 runtime. Claude Opus leads; GPT-5.6-Sol implements.

Outcome: make configuring and running an assistant pipeline understandable on first use.
Keep configurability, roles, step sequence, handoffs and revision loops visible.

Inspect: setup, provider readiness, pipeline selection/editor, run start/progress,
approvals, failure recovery and retained results. Prioritize three concrete user
problems. Cite source and observed behavior; separate observations from assumptions.

Visual direction: restrained shadcn-like hierarchy using existing VS Code theme
tokens. Clear primary action, consistent spacing, readable labels, useful empty
states, keyboard focus. Reuse current components; add no UI framework dependency.
Check light/dark themes, narrow panels, overflow, expanded sections and keyboard use.
Use gray on the outer body of temporary preview pages to expose layout overflow.
Never treat a synthetic preview as proof of native VS Code behavior.

Flow: Opus audit/plan -> Sol implementation -> Opus review -> Sol bounded revision
-> Opus final assessment. Continue safe in-scope work. Stop only for material product
choice, missing authority/provider capability, or verified environment blocker.

Boundaries: work in this checkout. Preserve unrelated edits. UI sources and relevant
UI tests only; supporting text when required. No telemetry, dependency changes,
provider transport/security changes, release/version changes, commits or publication.
Keep all existing workflow capabilities. No general backlog cleanup.

Validation: inspect CPU, memory, disk and competing processes before tests. Run
npm run check-types, npm run lint, npm run format:check, npm run test:webview-layout,
and relevant interaction tests for changed behavior. Discover exact test names.
Do not invent passing checks or screenshots; report unavailable visual capabilities.
Keep generated build output ignored. TODO files contain open work only; remove or
rewrite only items implemented and verified in this checkout.

Final report: concrete UX problems fixed; files changed; actual visual evidence;
checks and results; unresolved issues; each TODO removal/rewrite. Human judges the
result inside VS Code before accepting it.
