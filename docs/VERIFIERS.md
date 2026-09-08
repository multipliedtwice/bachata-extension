# Repository verifiers

<!-- generated:verification-policy -->
Autonomous verification runs `bachata:workspace-integrity` and `bachata:project-checks` by default. A `bachata:verifier:<id>` descriptor declared in `.bachata/verifiers.json` is refused before any process starts unless one workspace-level approval has been recorded and the run was started by the Improve command; every other run refuses every descriptor. That approval says a human accepted these executables, not that they are safe: a descriptor names an executable and Bachata cannot reason about what that executable does, and an ordinary script can start a browser E2E runner from inside itself. Direct E2E command forms are still classified on the executable, argument vector and the package scripts of the stated working directory, and refused, as defense in depth. That classification does not follow a manager's `--prefix` or `--workspace` into another package, and it is not a proof that arbitrary code cannot launch E2E. `tests/humanE2ePolicy.test.cjs` asserts these boundaries at runtime, and this generated block records the declaration only.
<!-- /generated:verification-policy -->

<!-- generated:verification-operations -->
| Operation | Owner | Declared in |
| --- | --- | --- |
| `bachata:workspace-integrity` | controller | built in |
| `bachata:project-checks` | controller | built in |
| `bachata:verifier:<id>` | repository | `.bachata/verifiers.json` |
<!-- /generated:verification-operations -->

Verifiers are execution evidence, not software-quality proof. Passing command can confirm only behavior command checks. It cannot find shared model blind spots, validate product direction, or replace fresh review runs. See [Product doctrine](PRODUCT_DOCTRINE.md).

`bachata:workspace-integrity` proves the workspace matches the fingerprint the run started from and that no change escaped the declared scope. `bachata:project-checks` proves the controller's own project checks pass for the changed files.

A model never writes a command. It selects a descriptor id that already exists in the repository. Everything a verifier runs is fixed by the descriptor, reviewed like any other file in the repository, and versioned with it.

## Workspace approval

A declared descriptor still runs nothing on its own. One workspace-level approval, recorded the
first time you run `Bachata: Improve This Project` in a repository that declares descriptors, is
what lets Bachata start them — and only during an Improve run. `Bachata: Run TODO.md` refuses every
descriptor whether or not the approval exists.

What the approval means: a human read what these descriptors run and accepted that Bachata may
start them unattended in this workspace.

What it does not mean:

- It is not proof that those executables are safe. A descriptor fixes an executable and an
  argument vector; it says nothing about what that process does once it starts. Trusted
  arbitrary code can launch other processes, including a browser E2E runner, from inside
  itself.
- Classification is not proof either. Bachata still refuses a resolved plan whose executable,
  arguments, or package scripts read as direct E2E, but that check reads a command line, not a
  process tree.
- It grants nothing to any other command, pipeline, or workspace.

The approval is stored in VS Code workspace state and is re-read on every run and resume; a
value written into a run ledger by hand grants nothing. Remove it by running
`Bachata: Repository Verifiers` and choosing `Remove this workspace's approval`; every descriptor is
refused again immediately.

A generated plan that names a `bachata:verifier:<id>` this repository does not declare, or that this
workspace has not approved, is refused before any worker starts rather than failing after the
work is done.

## Registry file

`.bachata/verifiers.json`:

```json
{
  "version": 1,
  "verifiers": [
    {
      "id": "unit-tests",
      "description": "Node test runner over tests/",
      "executable": "npm",
      "args": ["run", "test:unit"],
      "workingDirectory": ".",
      "environmentAllowlist": ["CI"],
      "timeoutMs": 600000,
      "maxOutputBytes": 262144,
      "expect": { "exitCode": 0 }
    }
  ]
}
```

## Descriptor fields

| Field | Rule |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the file. Referenced as `bachata:verifier:<id>`. |
| `description` | Required. States what a pass proves. |
| `executable` | Required. No `;`, `&`, `|`, `<`, `>`, `^`, `"`, `%`, `$`, backtick, or control characters. Shell and process wrappers are refused by name: `sh`, `bash`, `zsh`, `cmd`, `powershell`, `pwsh`, `env`, `xargs`, `sudo`, `ssh`, and the rest of that family. |
| `args` | Fixed array of strings. No `&`, `|`, `<`, `>`, `^`, `"`, `%`, or control characters. Never assembled at run time. The process is spawned directly, never through a shell, so remaining punctuation reaches the program literally. |
| `workingDirectory` | Repository-relative. No absolute paths, no `..`. Defaults to the repository root. |
| `environmentAllowlist` | UPPER_SNAKE_CASE names. Only these variables are added to the restricted base environment. Everything else is dropped. |
| `timeoutMs` | Integer, 1000 to 3600000. The run also applies its own ceiling; the smaller wins. |
| `maxOutputBytes` | Integer, 1024 to 8388608. Output beyond the bound is truncated, not buffered. |
| `expect.exitCode` | Integer 0 to 255. Default 0. |
| `expect.stdoutIncludes` | Optional. A pass also requires this substring in stdout. |
| `expect.stdoutExcludes` | Optional. A pass also requires this substring to be absent. |

Unknown keys are refused. At most 64 descriptors. A registry that fails validation is refused whole: no descriptor from a bad file runs.

## Execution boundary

- `.bachata/` is a restricted path for managed and autonomous mutation, so a running agent cannot add or edit a verifier and then select it.
- The descriptor is fixed data. No string interpolation, no shell, no argument assembly from model output.
- The environment is the same restricted base used elsewhere, plus the named allowlist only.
- Preflight fails closed: a TODO run that names a descriptor which does not exist, or whose registry does not validate, is blocked before any provider starts, with the exact reason.

## Using one

`TODO.md`:

```md
- [ ] [API-1] Fix cancellation
  - Paths: src/api
  - Verify: bachata:verifier:unit-tests
  - Verify Final: bachata:workspace-integrity
```

A declared descriptor records intent. `Bachata: Run TODO.md` refuses it before any process
starts. It can execute only during an explicitly started `Bachata: Improve This Project` run
after this workspace records verifier approval.

Pipeline `executeChecklist` steps and managed checks accept the same form.

## Limits

A verifier proves what its command proves. It is not a sandbox: it runs a real process from your repository with your PATH. Declare only commands you would run yourself, and keep the registry under review like any other executable content in the repository.

E2E harnesses stay human-only. They are never started by autonomous verification, whether or not a descriptor names them.

## Authoring and discovery

`Bachata: Repository Verifiers` lists the descriptors this repository declares and copies the `bachata:verifier:<id>` command for the one you pick. When `.bachata/verifiers.json` does not exist, it offers to create one from a template.

`Bachata: Bootstrap Verifiers and Repository Policy` proposes descriptors from what the repository already declares, and nothing else:

| Source | Proposed |
| --- | --- |
| `package.json` scripts named `test`, `lint`, `typecheck`, `check-types`, `build`, or `check` | `npm test` or `npm run <script>` |
| `Cargo.toml` | `cargo test --locked`, `cargo clippy --locked -- -D warnings` |
| `go.mod` | `go test ./...`, `go vet ./...` |
| `pyproject.toml` | `pytest -q`, and `ruff check .` when the project configures ruff |

A script that resolves to browser acceptance testing is never proposed; it is listed as skipped, because that verification stays human-only. Proposals from a project file rather than an explicit script are labelled as convention, not declaration.

Nothing is written until you have seen it. You choose which proposals to keep, Bachata renders the exact `.bachata/verifiers.json` in an editor, validates it against the rules above, and writes it only after you confirm. It then offers a curated `.bachata/policy.json` profile — read-only repository, verified changes only, or isolated changes only — with the same preview-then-confirm step. An existing file is never replaced without a second explicit confirmation.

While `.bachata/verifiers.json`, `.bachata/policy.json`, or `.bachata/export-policy.json` is open, every validation error appears in Problems on the line that carries the offending key. The same rules run headlessly: `npm run validate:local <repository>`.
