# Roadmap

[Product doctrine](PRODUCT_DOCTRINE.md) controls priority. Next work must improve accumulated refinement or reduce human attention cost. Execution hardening needs a concrete defect, user need, or platform constraint.

Open work only. Current contracts: [Product spec](PRODUCT_SPEC.md).

## Release acceptance

- Validate initiative/cycle persistence, direction and decision views, fresh-review comparison,
  outcome-based onboarding, and inspect/apply against the exact candidate. Follow
  [Human E2E](HUMAN_E2E.md); source tests do not prove rendered usability.
- Fill [Compatibility matrix](COMPATIBILITY_MATRIX.md) from exact-build platform/provider runs.
- Run [Moderated validation](MODERATED_VALIDATION.md). Establish whether people can hold
  direction, resolve material choices, and continue review without reading transcripts.
- Keep quality and provider claims within recorded evidence.

## Remaining feature decisions and implementation

- P2: choose the evidence authority, then connect accepted external evidence to finding-specific
  verification and state transitions. Remaining contract and dependencies: [TODO](../TODO.md).
- P3: choose attended retained isolation for Feature Delivery, then implement it while preserving
  requirement, design and implementation gates. Remaining options: [TODO](../TODO.md).
- Choose release inclusion before implementing the bounded-execution-state pilot or other
  scope-undecided features. Their open designs remain in [TODO](../TODO.md).

## Product validation

- Add the deferred record/score command over the
  [longitudinal fixtures](../benchmarks/longitudinal/README.md), subject to the scope and
  no-telemetry constraints in [TODO](../TODO.md).
- Record exact-build rounds for both arms of each claimed task. Human evidence required.
- Publish no comparative quality claim before the required recorded rounds exist.

Use committed local fixtures and human-recorded runs. No telemetry or new measurement layer.

## Product constraints

- Keep core schema problem-general and built-in workflows software-focused. No domain-specific
  adapter or integration without a product decision. Finding lifecycle stays finding-specific.
- Keep routine output in history. Surface material direction, unresolved choices and minimum
  judgment evidence. Lead ruling grants no correctness.
- Fresh discovery receives no prior findings, summaries or confidence. Reconcile after discovery
  freezes. A saturation signal never proves correctness, requires another review, auto-closes,
  or blocks continuation.
- Lead/Worker, independent-pair and single-agent pipelines remain valid. No topology proves
  correctness. Complete safe authorized phases without artificial approval stops.

## Restrictions and friction

Do not add security, permission, policy, verification, or isolation work as independent product goals. Existing mechanisms remain documented implementation boundaries.

Review current only-tightening rules against real workflows. Keep rule when it prevents concrete loss, corruption, incompatible execution, or unrecoverable state. Simplify or remove rule when it mainly interrupts Lead/Worker refinement without material benefit. Record product decision before changing repository-wide behavior.

## Provider and workflow breadth

Breadth supports refinement lifecycle. Review, planning, implementation, debugging, `TODO.md`, browser, and custom pipelines are not competing products.

Add provider when it unlocks useful role, fresh-session workflow, or user environment. Do not add provider only to increase count. CLI and API-backed providers remain preferred where available. Browser providers remain advanced fallback because exact conversation binding and provider DOM compatibility need separate validation.

Constraints on the `zai-glm` provider (GLM through Z.AI, a distinct provider identity): it reuses the Claude Code transport, scopes credentials per provider by variable ownership, keeps the model configurable, and reports the real provider and model. Ordinary Doctor stays local and non-billing; live smoke is an explicit human action. Coding Plan entitlement stays unclaimed until a terms review confirms Bachata's integration mode. Generic Browser Z.AI stays separate.

## Boundary: initiative state stays local

Initiative state is local to this VS Code workspace and storage identity. Moving or re-cloning a repository to a different path can require a new initiative. Bachata does not claim portable or repository-backed initiative history.

A JSON bundle can export one initiative and import it as a **separate** initiative elsewhere. That moves history once. It does not share, combine, or synchronize initiative state. No portable continuity work is planned.

This local-state boundary is not finding reconciliation or Git integration. Clear finding identities reconcile automatically after independent discovery freezes. Git branches never merge automatically; human explicitly applies accepted retained work, which remains staged without commit.

## Boundaries: state and independent judgment

Keep workflow progress in typed internal state. Do not generate repository specs or reports for routine state. Normal task-required project documents remain allowed.

Keep minimal provider conversation locators and compact typed evidence. Reconstruct full provider chat on demand when supported; otherwise report `unavailable`. Do not add durable full-output snapshots or unlimited caches. Strip locators from exports.

PR-facing LLM handoff is not planned. Human evidence export remains. Fresh independent reviewers receive no prior summary or notification context.

Hosting, deployment, accounts, central CI integration, and telemetry remain out of scope. Surface-neutral typed events may gain future external or CI renderer, but no such renderer ships in current release and its output never enters model context.

## Later: language-aware context

Managed browser context has graph-backed TypeScript and JavaScript dependency discovery. Other languages use readable inventory.

Add one language at time with correct resolution rules and tests. Wrong dependency context can misdirect a review, so do not ship shallow import guesses.

Future contract: [Language-aware managed context](LANGUAGE_CONTEXT.md).

## Ongoing: moderated usability

Automated accessibility tests prove structure, not comprehension.

Test with people, moderated, no telemetry:

- state current codebase direction without reading transcripts;
- resolve one core decision;
- distinguish new material finding from repeated finding;
- understand superseded and reopened decisions;
- start another fresh comprehensive review;
- interpret review saturation without calling it correctness;
- recover blocked or interrupted work;
- inspect and apply accepted work.

## Open risks, not defects

- **Synchronous state access under contention.** State store is synchronous and waits on lock. It could block Extension Host. No unacceptable delay has been reproduced. `docs/RELEASE_VALIDATION_RECORD.md` section 5 is record.
- **Real-provider and browser reliability.** Structural fragility is known. Failure rate is unknown because authenticated live-provider testing is incomplete. Claim neither reliability nor unreliability until exact-build records exist.
- **Attention compression is not validated.** Direction, core-decision and notification views do not prove a human can maintain direction without reading transcripts. Moderated validation must establish this ([Moderated usability validation](MODERATED_VALIDATION.md)).
