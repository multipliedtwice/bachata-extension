# Product doctrine

This document fixes product direction. Other specs describe mechanics. If a mechanic conflicts with this doctrine, change the mechanic or record a human product decision.

Decision authority map:

- product mechanics: [Product spec](PRODUCT_SPEC.md);
- bubble-up behavior: [Interactions](INTERACTIONS.md);
- retention and local-only continuity: [State and history](STATE.md);
- provider identity and Z.AI GLM plan: [Providers](PROVIDERS.md);
- finite release blockers: [Stable release gate](STABLE_RELEASE_GATE.md);
- delivery timing and explicit non-goals: [Roadmap](ROADMAP.md);
- post-release language context: [Language-aware managed context](LANGUAGE_CONTEXT.md).

## Problem

LLM work is probabilistic. One capable model can produce a useful answer, design, plan, or implementation and still be wrong, incomplete, or irrelevant. Multiple models create useful challenge and specialization, but may repeat the same error or share the same blind spot. More agents also produce more text than a human can supervise.

Bachata is **human-directed agentic pipelines for software refinement**. Independent agents challenge candidate work, converge findings or artifacts, and repeat against changed project state. Pairing and antagonistic convergence are core mechanics, not the product category.

Human directs accumulated refinement. Bachata compresses agent output into few decisions needing human judgment. Breadth across workflow stages strengthens same lifecycle.

Bachata exists to improve precision of theoretical and practical problem solving through this human-directed antagonistic refinement.

Core coordination model is problem-general. Product remains a VS Code extension focused on software work. Custom pipelines may apply same model to other theoretical or practical problems. Do not build or market separate domain products unless human explicitly changes direction.

## Product model

Do not confuse initiative, cycle, and pipeline run.

- Initiative: durable human problem or desired outcome.
- Cycle: one goal-directed phase, such as framing, research, proposal, critique, planning, execution, validation, review, or debugging.
- Pipeline run: one bounded agent execution inside cycle.

One initiative can contain many cycle types. One cycle can require many fresh pipeline runs. A pipeline preset defines roles, artifact, challenge/revision method, escalation rules, and completion contract for one kind of pass. It does not define whole product.

## Universal refinement loop

Solution quality accumulates in accepted state and external evidence across cycles:

1. Human states problem, goal, constraints, and direction.
2. Human or product selects cycle preset and expected artifact.
3. Agents investigate, propose, challenge, revise, or implement according to cycle contract.
4. Material direction choices and unresolved claims bubble to human.
5. Accepted artifact updates shared solution state or authorizes domain execution.
6. External evidence, tools, or accountable experts test claims when problem requires them.
7. Next cycle inspects updated state and evidence with its own contract. Fresh runs do not inherit prior confidence.
8. Repeat until human authority accepts outcome and residual uncertainty.

Lead/Worker is a common execution shape, not universal semantics. Roles may include investigator, proposer, critic, synthesizer, executor, or verifier. Candidate artifact may be hypothesis, requirement, recommendation, decision, plan, design, protocol, patch, finding set, or a custom type. Convergence means artifact reached preset-defined disposition. It never means underlying goal or result is true.

Examples:

- Feature delivery: human explains problem → requirements and material choices → plan → implementation → review/revision → accepted feature → fresh product or code review.
- Refining/debugging: human selects scope → candidate findings → challenge/evidence → finding dispositions → accepted bug list → fixes → fresh review.
- Product review: human states product goal → independent assessments → challenged recommendations and assumptions → human direction decisions → accepted priorities → follow-up delivery cycles → fresh product review.
- Custom problem: human states goal → preset-defined artifacts and roles → challenge/evidence → human escalation when needed → accepted result → fresh cycle.

One pipeline is one pass. In-pipeline review catches many ordinary mistakes. It does not replace later fresh cycles against updated state. A strong result may require many sessions focused on same initiative.

Breadth supports this loop. Review, planning, implementation, debugging, `TODO.md`, browser work, and custom pipelines cover different refinement stages. Breadth is not a defect or apology.

## Human role

Human authority owns intent, direction, and acceptance. It may be one person or accountable expert team. Human is not assumed infallible; product keeps assumptions, evidence, disagreement, and reversibility visible so direction can change.

No pipeline, consensus rule, arbiter, or extra model can prove that models do not share a blind spot. None can detect that underlying goal or premise is misdirected when all participants accept it. Only human authority can correct direction. External evidence may falsify shared claims. Neither models nor consensus own intent.

Models may surface uncertainty. They must never claim that agreement proves direction or correctness. Consensus and Lead rulings coordinate one run; they do not establish truth.

Lead is not right because role is Lead. Worker is not right because Worker produced result. Their judgments about result remain claims until challenged and assigned a disposition under cycle contract.

Human should not supervise routine execution. Human should judge only information capable of changing direction or acceptance.

Human is product gate. Controller and models may recommend, converge, verify, or report evidence. They never own intent, direction, acceptance, continuation, or stop decision.

## Human attention contract

Top-level control surface shows current initiative direction without requiring transcript reading.

Bubble up only:

- accepted material outputs for current cycle, including actionable findings when cycle produces findings;
- direction-changing core decisions;
- material unresolved findings or disagreements that need human judgment;
- material assumptions whose failure changes solution;
- newly discovered risks that change scope, design, or acceptance;
- irreversible action;
- minimum evidence needed to judge each item;
- blocked choices that no model may resolve from existing human direction.

Keep in drill-down history:

- raw participant proposals and finding lists;
- rejected claims and challenge debate;
- routine investigation or execution chatter;
- repeated claims with no material delta;
- resolved items and completed revisions;
- successful mechanics, checks, retries, and permissions;
- raw participant output and full provenance.

Operational failure bubbles up only when it blocks refinement or needs a human decision. Successful operation does not compete with product decisions for attention.

Internal orchestration may be complex. Hide routine machinery and disclose detail progressively. Internal complexity is not user burden while top-level surface preserves human attention and drill-down remains available.

Bubble-up projection is session-lived and human-only. Controller derives concise notices deterministically from typed events, with no extra model call or token use by default. User may choose `off`, `decisions only`, `material`, or `all`. Human may inspect, reject, reopen, or restore semantic finding disposition. Fresh reviewer context never receives notification summaries. No durable notification archive exists.

## Refining/debugging finding discipline

This lifecycle belongs to finding-producing review and debugging presets. Do not impose bug-list semantics on feature delivery, product review, planning, or other cycles. Their presets define their own artifacts and convergence contracts.

Initial Lead and Worker findings are provisional competing hypotheses. They are often wrong. A raw finding list is never actionable and never top-level codebase state.

Within one pipeline, each finding moves through:

1. `proposed` by one participant;
2. `challenged` or `confirmed` with evidence by other participant;
3. `accepted`, `rejected`, or `unresolved` disposition.

There is no actual pipeline bug list before these competing claims converge on dispositions. Lead/Worker convergence may assign `accepted`, `rejected`, or `unresolved`. Only accepted findings enter the actionable list. Pipeline-accepted routine finding becomes actionable automatically. Routine fix may proceed under pipeline's pre-authorized execution contract. No per-finding human ruling or approval gate. Material unresolved finding bubbles to human. Rejected findings and debate remain provenance/history and do not pollute current codebase state.

Single-participant finding remains single-source and provisional until later challenge/convergence. Never label it bachata-accepted.

Convergence means current pipeline disposition, not truth. Lead has no automatic tie-breaking authority unless pipeline explicitly uses Lead ruling, and that ruling still remains one-run disposition. Later fresh review may reopen accepted or rejected finding only with materially new evidence and must show disposition delta.

Within-run convergence resolves duplicate descriptions before findings become actionable. Cross-run reconciliation happens only after fresh discovery output freezes. It maps final findings to prior stable identities by subject, evidence, and affected scope. Clear matches merge automatically and preserve provenance. Novel findings receive new identities. Only ambiguous matches or material conflicts need human judgment. Prior findings, summaries, and notifications never enter fresh discovery context.

## Core decision record

Each core decision needs:

- stable subject identity;
- question;
- why it is material;
- options and tradeoffs;
- recommendation and minimum supporting evidence;
- affected scope;
- status;
- provenance;
- human resolution when required.

Statuses: `proposed`, `accepted`, `rejected`, `deferred`, `superseded`.

Deduplicate by subject and affected scope, not wording. Repeated support updates occurrence history but does not create another top-level item. Newer decision supersedes older decision only when it changes recommendation, evidence, scope, or human resolution. Show current decision and delta; keep prior versions in history.

Resolved items leave top-level view. Reopen only on materially new evidence. Reopened item shows what changed since prior resolution.

## Review saturation

No automatic state means “quality achieved.” `until clean`, no-change, passing checks, agreement, and a completed pipeline describe run state only.

Bachata may report review saturation evidence when:

- two consecutive fresh comprehensive reviews produce no new material findings;
- prior material findings are resolved or explicitly accepted;
- core decisions are closed;
- required checks are current.

A default signal may appear after two consecutive quiet fresh reviews when other conditions hold. This is controller-reported evidence, not objective requirement. It never proves correctness, closes cycle, blocks continuation, or restricts human stop choice. Human may stop or continue before or after signal.

Copy states observed fact: `Two consecutive fresh reviews found no material change. Continue or close the cycle.` Never say another review is “needed” because threshold has not been reached.

Review saturation applies only to repeated review/debugging cycles. Other cycle types use their own evidence, acceptance, and continuation contracts.

## Custom problem types

Custom pipeline defines artifact, roles, challenge/revision flow, evidence, human escalation, and convergence for another problem type. Bachata does not need dedicated vertical features for each field.

More agents create more opportunities for correction. They do not automatically increase accuracy. Relevant evidence and human judgment remain part of system.

## Execution mechanics

Permissions, path limits, worktrees, immutable snapshots, deterministic checks, recovery, and repository policy keep runs operable and results inspectable. They are subordinate mechanics, not product value.

Finding reconciliation merges semantic finding identity, never Git branches. Bachata does not merge, commit, rebase, tag, or push Git automatically. Accepted retained work reaches current branch only through explicit human apply and remains staged without commit.

Do not add or tighten a restriction because stricter looks safer. Added friction needs a concrete failure mode, user need, or platform constraint. Prefer removing friction when a restriction does not improve refinement quality, human direction, recoverability, or required compatibility.

Security documentation must state real boundaries accurately. Public positioning must not sell execution restriction as reason to buy Bachata.

Persist workflow state as typed internal state. Do not generate repository specs or reports for routine workflow progress. Normal human-authored and agent-authored project documents remain allowed when work itself needs them.

Independent judgment stays independent. Human-facing evidence export remains valid. PR-facing LLM handoff and prior-run summary injection are non-goals because they bias fresh review.

Human supervises routine finding work by exception, not mandatory per-finding ruling. Human judgment blocks only material unresolved finding, direction-changing choice, scope or acceptance change, ambiguous cross-run identity, or irreversible action. Human still owns intent, direction, and final acceptance. Applied fix is never verification. Today one basis exists in runtime: a later fresh review that no longer reports the finding, which is model non-observation and is presented as such. Accepted external evidence is recorded against the initiative and does not yet transition a finding; a controller check supports only its own declared scope, never a named finding, until finding-linked evidence exists. Do not describe any of these as deterministic verification.

## Claims

Allowed:

- Bachata runs human-directed agentic pipelines for software refinement;
- independent agents challenge and converge candidate work;
- Bachata organizes Lead and Worker collaboration;
- Bachata uses problem-general initiative, cycle, pipeline-run, and artifact model;
- Bachata organizes durable initiatives across different problem-solving cycles;
- Bachata supports repeated fresh runs against updated state and evidence;
- Bachata preserves work and decisions across refinement;
- Bachata reduces human attention load by surfacing material decisions;
- repeated refinement can remove defects found by later reviews.

Forbidden:

- one Bachata run guarantees correctness;
- two models eliminate shared blind spots;
- more models automatically mean better answer;
- consensus or arbitration proves truth;
- no new findings proves no defects remain;
- execution security is primary product benefit;
- breadth weakens product;
- custom pipeline makes Bachata a validated specialist product for every field.

Public quality claims still need recorded evidence. Absence of validation remains absence, never proof.
