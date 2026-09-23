# Bachata

<p align="center">
  <img src="https://raw.githubusercontent.com/multipliedtwice/bachata-extension/main/media/readme-demo.gif" alt="Choosing the Code review and refinement pipeline, assigning a model to each role, and following the Implementer and Independent reviewer as they exchange findings, a fix, and a review" width="720">
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Rememo.bachata-vscode"><img src="https://img.shields.io/badge/VS_Code_Marketplace-Bachata-007ACC?style=flat-square" alt="Bachata on the Visual Studio Marketplace"></a>
  <a href="#requirements"><img src="https://img.shields.io/badge/VS_Code-1.101%2B-007ACC?style=flat-square" alt="Requires VS Code 1.101 or newer"></a>
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/docs/RELEASE_VERDICT.md"><img src="https://img.shields.io/badge/status-alpha_candidate-C46A3A?style=flat-square" alt="Status: alpha candidate"></a>
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/docs/DEVELOPMENT.md"><img src="https://img.shields.io/badge/coverage-enforced_floors-586069?style=flat-square" alt="Coverage: enforced thresholds; see development checks"></a>
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-586069?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install-and-run-a-first-review"><strong>Get started</strong></a> ·
  <a href="https://multipliedtwice.github.io/bachata-extension/">Documentation</a> ·
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PIPELINES.md">Configure pipelines</a> ·
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PROVIDERS.md">Choose assistants</a> ·
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/docs/BROWSER_BRIDGE_INSTALL.md">Browser Bridge</a> ·
  <a href="https://github.com/multipliedtwice/bachata-extension/blob/main/CHANGELOG.md">What’s new</a>
</p>

## Build your own AI workflow for software work

Bachata lets you decide how AI assistants work together: choose the assistants,
give each a job, and arrange the steps. It runs inside Visual Studio Code, an app
used to write software. An AI assistant is a tool you can ask, in everyday language,
to help with tasks such as planning a feature, writing code, or finding bugs.

For example, you can have one assistant make a plan, another challenge it, then
have them write, review, and revise the code. Bachata calls this sequence a
**pipeline**. You choose the instructions, who handles each step, how results pass
between steps, and when to repeat a review or ask for your decision.

Start with a ready-made pipeline or edit one to fit how you work. Use a short
sequence for a quick review, or a longer one for a change that needs planning and
several rounds of feedback. Save your pipeline and use it again on the next task.
Bachata coordinates the handoffs and keeps the results together.

You can:

- **Shape the workflow:** choose roles, instructions, step order, and review rounds.
- **Choose who does the work:** assign tools such as Codex and Claude Code to the
  roles in your pipeline.
- **Reuse and adapt:** start from built-in pipelines, edit them, or create your own.
- **Follow the result:** return to saved goals, decisions, findings, and changes;
  see which checks actually ran and which results remain unverified.

Bachata uses AI tools you install and sign in to separately. It does not include
an AI service or subscription. The optional
[Browser Bridge](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/BROWSER_BRIDGE_INSTALL.md) lets pipelines use conversations
on websites such as ChatGPT and Claude.

Some workflows only review files. Others edit your selected folder or keep changes
in a separate working copy for you to apply. Bachata shows this before you start
and never creates a Git commit. AI can make mistakes, even when assistants agree.

Bachata works with files on your computer. Selected code and messages go to the AI
provider you choose. There is no Bachata account, hosted service, or telemetry.

## Requirements

- VS Code 1.101.0 or newer.
- A folder opened in a trusted local VS Code window. It does not need to be a Git
  repository; only task-list (TODO) execution does, because it builds each task in a
  Git worktree.
- Codex or Claude Code installed and signed in separately. Install both if you want
  two agents to cross-check each other.

Using AI chat websites is an optional advanced workflow. They additionally need the
separate Browser Bridge and a local VS Code Extension Host. See
[Browser Bridge install](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/BROWSER_BRIDGE_INSTALL.md).

## Install and run a first review

1. Install [Bachata from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Rememo.bachata-vscode), or install a
   supplied `.vsix` with **Extensions: Install from VSIX...**.
2. Open the folder you want to work on in a trusted local VS Code window.
3. Install and sign in to Codex or Claude Code. Install both to use a pair.
4. Run **Bachata: Setup**.
5. Choose **Review code**, then choose one AI assistant or two that check each other’s work.
6. Describe what you want reviewed and inspect what the run may access.
7. Start the review and inspect the result.

This first review is read-only. Run **Bachata: Doctor** if Codex or Claude Code is
not ready. Run later reviews in fresh sessions against the updated codebase, and do
not treat a first clean report as proof that no defects remain.

## What can Bachata help you do?

### Review code

Ask one or two AI assistants to inspect a file, selection, commit, branch, or local
changes. Review runs are read-only. They cannot change the repository.

### Plan a change

Create an implementation plan without changing files. The Lead can review the
Worker's plan, challenge missing steps, and bubble material choices up to you.

### Fix a bug

Let an AI assistant diagnose and implement a fix inside declared boundaries. You can use
a second AI assistant to review the diagnosis and change. Some workflows can also run
approved repository checks after the work.

**Paired managed fix** combines independent diagnosis, implementation, Lead
review, bounded revision, and declared checks. Work waits in a retained worktree.
You can apply whole files or single hunks. Bachata reruns declared checks against
exact selected bytes before staging a partial selection.

### Complete larger tasks

Break structured `TODO.md` work into bounded tasks. Bachata can run tasks in
isolated Git worktrees, keep the results for inspection, and let you choose what
to apply.

### Work with browser LLM conversations

Bachata can coordinate two separate browser conversations as Worker and Lead. One
conversation works on the task. The other reviews it and can request a bounded
revision. These are LLM conversations, not local coding agents. Bachata passes them
selected context and controls any allowed code changes.

Two optional features can use a local Ollama or LM Studio model with browser
conversations. Both are off by default, and each is checked on its own task before
use:

- **Browser action interpreter** reads plain-language action requests in a browser
  model's answer. Without it, Bachata uses explicit `bachata-action` blocks and its
  built-in pattern matching.
- **Selector healing** lets the Browser Bridge recover a page control when a saved
  selector stops matching.

The interpreter also has an internal, optional typed-decision adapter seam for testing
decision runtimes such as Laya. It is not a shipped Laya backend: no checkpoint, Python
runtime or endpoint is included, normal Qwen/Ollama and LM Studio behavior is unchanged,
and invalid or uncertain adapter output falls back to the existing path. See the
[Laya compatibility boundary](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/SEMANTIC_INTERPRETER.md#laya-compatibility-seam-only-not-an-available-backend).

With a pipeline selected, turn either one on under **Agents → Local models**. See
[Local models](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/SEMANTIC_INTERPRETER.md).

## Why use Bachata?

LLM work is probabilistic. One session can produce a useful requirement, plan,
change, or review and still be incomplete or wrong. Repeated fresh cycles refine
the project state. Software quality improves in the codebase and in the accepted
decisions, not in one perfect conversation.

LLMs also produce more text than a human can supervise. Bachata keeps the run history
and the drill-down evidence, but the top-level control surface should show only
accepted material outputs, direction-changing core decisions, unresolved
disagreements, material assumptions, new material risks, and the minimum evidence
needed to judge them. Routine chatter, repeated or resolved claims, successful
mechanics, and raw outputs belong in the drill-down history.

Bachata helps you:

- direct Lead and Worker LLMs without reading every turn;
- keep core decisions and current codebase direction visible across runs;
- run fresh comprehensive reviews after earlier corrections land;
- expose unresolved assumptions, disagreements, and material risks;
- use review, planning, fixing, `TODO.md`, and browser workflows across one
  refinement lifecycle;
- inspect detailed output and checks when a decision needs evidence.

Routine orchestration stays hidden behind progressive disclosure. Session-lived
bubble-up notifications show concise decisions, material changes, failures, or
reversible retained work. A bell with an unread count and one optional inline
line carry them. Bachata writes those lines from recorded state with no extra LLM
call. `bachata.notificationMode` chooses `off`, decisions only, material events, or
all. Notifications never enter fresh reviewer context and are never archived.

No run guarantees correctness. Two consecutive quiet fresh reviews may produce a
saturation signal, which is neither proof nor a required stop. You may continue or
close the cycle, and in closing it you accept the residual uncertainty.

## What this does not prove

One pipeline is only one pass. A second LLM can catch ordinary mistakes made by the first,
but two models can share the same blind spot or follow the same wrong premise. No consensus
rule and no arbiter fixes misdirection. Only a human can correct direction.

Repeated refinement is the product. Accepted specifications, decisions, plans, changes, and
corrections accumulate across cycles, and quality accrues in that accepted state rather than
in one perfect conversation.

In a refining or debugging preset, initial Lead and Worker findings are competing hypotheses, not actionable truth. The pipeline challenges each finding and
records a disposition. There is no pipeline bug list before that convergence. A
challenged, pipeline-accepted routine finding becomes actionable without another
human ruling, and a pre-authorized pipeline may fix it. Material unresolved
findings, direction or scope changes, ambiguous identity, and irreversible actions
still stop for you. Rejected claims and the debate behind them stay in the history.
The Lead is not right by virtue of its role. Other presets converge on different
artifacts, not on bug lists.

A pipeline-accepted finding carries its own state: awaiting a fix, a fix running,
a fix applied, or verified. Verification can come from a fresh, independent review
against the current repository state that no longer reports the applied finding,
or from explicitly accepted, finding-specific external verification evidence.
An applied fix is not a verified fix. You supervise by exception: inspect,
reject, reopen, or restore a semantic disposition. Discard and restore appear only
for reversible retained work that Bachata owns.

To record a human verification, run **Bachata: Record External Evidence**, select
a saved local evidence copy, choose the finding, and select **Evidence that this
finding is fixed**. State the acceptance criterion and verification environment.
Bachata binds that record to the current repository candidate. Accept it in
**Direction** to resolve the finding; changed candidates, unavailable or ignored
scope, expired evidence, and unresolved challenges refuse the transition.
An ordinary citation records evidence without closing the finding. This flow
records your verification; it does not execute the reproduction or turn a failed
provider run into a successful one. Evidence copies must be regular local files
of at most 4 MiB. The copy stays local.

A cycle is bound to one repository candidate: the commit, the branch, and a
digest of the working tree at the moment it was baselined. Recorded checks belong
to that candidate. If the repository moves underneath it — a new commit, a
different branch, an edited working tree — Bachata marks the recorded checks stale
and asks you to rebaseline. Which run tab you happen to have open never changes
any of this.

Bachata can use local coding tools such as Codex and Claude Code. As an advanced
option, it can also coordinate separate ChatGPT, Claude, or other supported LLM
conversations in your browser. Bachata does not ship an LLM.

## Refinement loop

1. You state the durable goal and direction.
2. You select a cycle: feature, planning, implementation, product review, code
   review, debugging, or another explicit preset.
3. The preset defines the expected artifact, the agent roles, the challenge and
   revision method, the escalation rules, and the completion contract.
4. You review only core decisions, direction changes, and material unresolved
   claims.
5. The accepted artifact updates the project state.
6. The next cycle starts fresh against the updated state without inheriting
   confidence.
7. Repeat until you accept the outcome and its residual uncertainty.

An initiative can contain many cycle types. A cycle can contain many fresh
pipeline runs. A pipeline run is one bounded execution, not the whole lifecycle.

Direction names one next action and can run it. An accepted finding opens a
bounded fix scoped to that finding. A drifted candidate rebaselines the cycle, and
stale checks are rerun. After two quiet fresh reviews, Bachata may report that no
material change was found; you may continue or close. You never rebuild the
workflow, the scope, or the prompt by hand.

Not every artifact type is produced yet. A ruled review round persists a typed
`findingSet`. A converged plan persists a typed `plan`. Applying retained work
persists a typed `patch` naming the staged files and the findings it was scoped
to. Which further artifact types the shipped presets declare is measured, not
restated here: read `Declared artifact promotion types` in
[BUILD_FACTS.md](https://github.com/multipliedtwice/bachata-extension/blob/main/BUILD_FACTS.md). A declaration says what a preset asks to
persist, never that a run produced it.

A repository can hold more than one initiative. You create, switch, pause,
complete, or abandon them explicitly; only one is active at a time, and each
keeps its own cycles, findings, decisions, and artifacts.

Two review rounds can describe one defect in different words. Within-run
convergence owns duplicates inside one pass. Fresh review completes independent
discovery first; only then does Bachata reconcile the final findings against prior
stable identities. Clear matches merge automatically and keep both wordings in
the finding's history. Novel findings receive new identities. Only genuinely
ambiguous mappings, split descriptions, and matches against a finding you
rejected reach you, and leaving them separate is a valid answer. Bachata never asks
you to confirm an obvious duplicate.

Different providers, or separate conversations with the same provider, may fill
the Lead and Worker roles. Independent-first pipelines remain useful inside one
pass. Agreement coordinates the result; it never proves the result or the
direction correct.

Initiative state is local to this VS Code workspace and its storage identity. It is
not stored in the repository and not synchronised. Moving or re-cloning a
repository to a different path can require a new initiative. Bachata
does not claim portable or repository-backed initiative history. An initiative
can be exported to a JSON bundle and imported elsewhere as a separate
initiative; import does not combine or synchronise initiative state.
See [State and history](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/STATE.md).

Finding reconciliation is not Git integration. Bachata never merges Git branches
automatically. Accepted retained work reaches current branch only after explicit
human apply, and Bachata stages it without commit, rebase, tag, push, or automatic
merge.

See [Product doctrine](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PRODUCT_DOCTRINE.md) for mandatory boundaries.

## Execution mechanics

Before a run, Bachata states the authority that workflow holds. After a run, it keeps
the changed files, the recorded checks, the decisions, and the remaining risks.
These mechanics make refinement inspectable. Execution restriction is not itself
product value, and new friction needs a concrete failure mode or platform
requirement behind it.

The exact protection depends on the workflow. Every run contract states one of
five assurance labels before the run starts:

| Assurance | What it means |
| --- | --- |
| Read-only | No file is changed. |
| Unverified | The run can write, and neither a second LLM nor Bachata checks the result. |
| Model-reviewed | A second LLM challenges the work. Bachata runs no check of its own. |
| Controller-checked: *checks* | Bachata runs exactly the named checks itself and records the result. Changes land in your selected workspace and Bachata does not roll them back. |
| Controller-checked, isolated and applicable: *checks* | Bachata runs exactly the named checks, keeps the retained work in a retained worktree, and applies only what you select. |

The two controller-checked labels always name the checks they ran, because the
checks differ per workflow. `bachata:project-checks` is workspace integrity, JSON
parsing, per-language syntax checks and a TypeScript build — **it runs no
repository test suite**. A repository test suite runs only where a
`bachata:verifier:<id>` descriptor declared in `.bachata/verifiers.json` is named, and
then the label says so by id.

Which assurance a given workflow resolves to is derived per run from its
pipeline, its write scope and its declared checks. The run contract states it
before the run starts; this document does not restate it, because a restated
table is the kind of claim that outlives the behaviour it described.

A `TODO.md` task may declare `Verify: none`. Bachata then records no check for it
and the Result Center shows the verification as missing, not as passing.

Read-only and model-reviewed are not controller checking. A model saying
"the tests pass" is never recorded as a passing check. A controller check that
ran syntax and type checking is never presented as a passing test suite.

Bachata never creates a commit. Only the isolated workflows keep their work
outside your current branch until you apply it; the others change the selected
workspace directly. The run contract and the run summary both tell you which
behaviour applies.

Missing evidence stays missing. A model summary is not a repository check.
Consensus, Lead ruling, passing checks, and `until clean` completion are run
facts, not correctness claims.

## Local control and privacy

Bachata runs against your local Git checkout. There is no Bachata account, no hosted
Bachata service, and no telemetry.

Prompts, selected code, and answers still go to the LLM providers you choose.
Optional local-model features send bounded evidence only to the Ollama or LM Studio
endpoint they use. That endpoint is on this machine unless you separately allow a
remote interpreter endpoint.
Bachata shows the planned outbound context before a run. Provider credentials stay
with the provider's CLI or browser session.

Read [Privacy](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PRIVACY.md), [Security](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/SECURITY.md), and
[No telemetry](https://github.com/multipliedtwice/bachata-extension/blob/main/NO_TELEMETRY.md) for the full boundaries.

## Efficient context — experimental

Frozen. An offline pilot found no saving: after one framing fix, every recorded run was correct
in both modes, and efficient mode's median provider input was equal or higher. See
[Token-efficient harness](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/TOKEN_EFFICIENT_HARNESS.md#pilot-result).

Off by default, and the **Efficient context · Experimental** control is hidden while it is off.
The Advanced setting `bachata.executionContextMode` still opts in. While it is on, the control
appears in the Runs composer **Agents** menu so it can be turned off. It works only with serial TODO
Implementation, local Claude/Codex, a workspace folder and no attachments. Active, resumed and restarted runs keep their recorded mode.

## Current status

Bachata is currently a closed-alpha candidate, not a stable public release.
Automated checks exist, but exact-build provider, platform, browser, and
graphical validation is still incomplete. The
[support matrix](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/SUPPORT_MATRIX.md) records what is known.

Recorded longitudinal evidence for cross-run core-decision compression and review saturation
remains a roadmap requirement. The current one-run benchmark has no recorded result
and supports no quality claim. See [Roadmap](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/ROADMAP.md) and
[benchmark limits](https://github.com/multipliedtwice/bachata-extension/blob/main/benchmarks/README.md).

The local TODO context pilot ships in source. Compact peer handoffs and browser changes
remain proposals. Project release gates remain pending. See
the [public documentation](https://multipliedtwice.github.io/bachata-extension/#token-efficiency)
and [technical design](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/TOKEN_EFFICIENT_HARNESS.md).

Bubble-up notifications, automatic post-discovery finding reconciliation, and
the first-class Z.AI GLM provider identity ship in this build. Z.AI GLM is
documented as a technical configuration only: Bachata makes no GLM Coding Plan
entitlement claim, and its live provider smoke is a recorded human test, not an
automated one. Language-aware context beyond TypeScript/JavaScript is
post-release.

The release verdict, validation record, provider terms, and compatibility
matrix are deliberately **not** packaged: each one names the SHA-256 of the
artifact it describes, so shipping them inside that artifact would change the
hash they had just recorded. Read them in the repository.

## Learn more

- [Release and deployment](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/DEPLOYMENT.md)

- [Product doctrine](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PRODUCT_DOCTRINE.md)
- [Product and workflow design](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PRODUCT_SPEC.md)
- [Providers and setup](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PROVIDERS.md)
- [Pipelines](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/PIPELINES.md)
- [Token-efficient harness design](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/TOKEN_EFFICIENT_HARNESS.md)
- [Repository policy](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/REPOSITORY_POLICY.md)
- [Repository verifiers](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/VERIFIERS.md)
- [`TODO.md` orchestration](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/ORCHESTRATION.md)
- [Browser Bridge installation](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/BROWSER_BRIDGE_INSTALL.md)
- [Local models: action interpreter and selector healing](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/SEMANTIC_INTERPRETER.md)
- [Development and testing](https://github.com/multipliedtwice/bachata-extension/blob/main/docs/DEVELOPMENT.md)

<div hidden>
<!-- generated:verification-policy -->
Autonomous verification runs `bachata:workspace-integrity` and `bachata:project-checks` by default. A `bachata:verifier:<id>` descriptor declared in `.bachata/verifiers.json` is refused before any process starts unless one workspace-level approval has been recorded and the run was started by the Improve command; every other run refuses every descriptor. That approval says a human accepted these executables, not that they are safe: a descriptor names an executable and Bachata cannot reason about what that executable does, and an ordinary script can start a browser E2E runner from inside itself. Direct E2E command forms are still classified on the executable, argument vector and the package scripts of the stated working directory, and refused, as defense in depth. That classification does not follow a manager's `--prefix` or `--workspace` into another package, and it is not a proof that arbitrary code cannot launch E2E. `tests/humanE2ePolicy.test.cjs` asserts these boundaries at runtime, and this generated block records the declaration only.
<!-- /generated:verification-policy -->
</div>
