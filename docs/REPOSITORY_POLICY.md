# Repository policy

Repository policy is optional execution configuration, not product doctrine or reason to buy Bachata. It does not improve model reasoning, correct shared blind spots, or validate product direction. Human-directed iterative refinement remains product. See [Product doctrine](PRODUCT_DOCTRINE.md).

Current only-tightening semantics below are implementation facts. Any expansion needs concrete failure evidence or platform need. Product roadmap must review whether each refusal protects recoverability or mainly adds friction.

`.bachata/policy.json` is the repository's own limit on what any Bachata run may do inside it. It is a normal file: reviewed, versioned, and diffed like source.

Local settings and pipeline definitions can only narrow it. Nothing in a user's settings, a pipeline preset, or a model's output can widen it.

## File

```json
{
  "version": 1,
  "approvedPipelineIds": ["codex-review", "managed-fix"],
  "maxWriteScope": "configured",
  "commitMode": "never",
  "allowedVerifiers": ["bachata:project-checks", "bachata:workspace-integrity"],
  "protectedPaths": [".git", ".bachata", "infra"],
  "requireHumanGate": true
}
```

Every key is optional except `version`. An absent key places no limit.

| Key | Rule |
| --- | --- |
| `version` | Must be `1`. |
| `approvedPipelineIds` | Only these pipeline ids may run in this repository. |
| `maxWriteScope` | `readOnly`, `task`, `configured`, or `workspace`. A run that resolves to a wider scope is refused. |
| `commitMode` | `never` forbids commit authority regardless of what a pipeline declares. |
| `allowedVerifiers` | Only these verification operations may run. Any other resolved check is refused. |
| `protectedPaths` | Each path must appear in the run's declared protected paths. |
| `requireHumanGate` | The run must declare at least one human gate. |

Unknown keys, a wrong `version`, an unrecognised scope, and a non-string list entry are all errors. An invalid policy file is reported and the run is refused; it is never silently ignored.

## Enforcement

The policy is read from the run's working directory before every run. Its refusals appear in the execution contract under **Repository policy refuses this run**, and they also enter the contract's blockers, so the composer explains them like any other blocker. Preflight then refuses to start the run.

Run `npm run validate:local <repository>` to check a repository's policy, TODO file, pipelines, verifier registry, export policy, and every resolved contract without starting a run.

## Curated profiles

`Bachata: Bootstrap Verifiers and Repository Policy` offers three starting profiles. Each one only narrows authority, and each is shown in full before it is written.

| Profile | What it allows |
| --- | --- |
| Read-only repository | Only review and planning pipelines. `maxWriteScope` is `readOnly`, so no pipeline may write. |
| Verified changes only | Writes inside a declared scope, never committed, and only through controller-owned verification and the repository's own verifier descriptors. |
| Isolated changes only | Only workflows that keep their work in an isolated worktree. `maxWriteScope` is `task`, so nothing writes into your branch until you apply it. |

Every profile sets `commitMode` to `never`, requires a human gate, and protects `.git`, `.bachata`, and `.github`. Edit the written file like any other repository file; it is versioned with your code.
