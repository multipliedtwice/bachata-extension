# Providers

What each provider needs, how Bachata detects it, and what fixes it. Doctor opens the matching section as numbered steps with direct actions.

Provider is role implementation, not quality guarantee. Different providers may add useful perspective, but no provider count solves shared blindness or misdirection. Precision comes from human-directed cycles, challenge, domain evidence, and repeated fresh work against updated state. See [Product doctrine](PRODUCT_DOCTRINE.md).

Official documentation URLs live in one place: `src/readiness/providerDocs.ts`. A placeholder URL is never shown in the UI, and `npm run check:release-metadata` fails while any of them is still a placeholder.

## How Bachata probes a provider

Bachata runs the probe in the selected workspace root with a restricted environment. It does not source your shell profile, so a CLI that only exists in an interactive shell PATH is invisible to Bachata. Set the absolute path in settings instead.

| Provider | Setting | Probe | Credentials |
| --- | --- | --- | --- |
| Codex | `bachata.codexCommand` | app-server handshake, see below | Held by the Codex CLI itself |
| Claude Code | `bachata.claudeCommand` | `claude --version` | Held by the Claude Code CLI itself |
| Git | none | `git --version` | none |

An answer from `--version` proves an executable exists. It does not prove that executable
speaks the protocol Bachata sends. For Codex it is not the probe.

## Codex

1. Install the Codex CLI.
2. Sign in with the CLI's own login flow.
3. If it is installed but not found, set `bachata.codexCommand` to the absolute path.
4. Recheck Codex from Doctor. Doctor reruns only that probe.

### What the Codex probe actually does

Bachata starts `codex app-server`, completes the `initialize` handshake, and then asks the
server to accept each payload a run would send: both sandbox modes on `thread/resume`,
and both sandbox policies on `turn/start`. Every probe carries a thread id that cannot
name a thread. The server rejects unparseable parameters before it parses the id, so an
unsupported payload is refused and an accepted payload stops at the id. No thread is
created, no turn starts, and no model is called. Codex is reported available only when
every payload was accepted.

If the installed CLI rejects one, Bachata reports the server's own message and refuses to
run Codex. It does not silently move the work to another provider.

### What Codex cannot do, stated plainly

The installed Codex app-server protocol has no per-path readable-root capability. Its
sandbox policy carries no readable-root field — `readOnly.access` and
`workspaceWrite.readOnlyAccess` were removed — and the only selectable permission
profiles are `:read-only`, `:workspace` and `:danger-full-access`. A Codex turn reads the
whole working directory.

Bachata withholds version-control, credential and bachata-internal paths from every other
provider. It cannot make Codex withhold them, and it will not pretend otherwise:

- A run that declares its own read paths or its own protected paths is refused for Codex,
  whatever the settings say. That promise is made per run and Bachata cannot keep it.
- Every other Codex run is refused until `bachata.codexWorkspaceScope` is set to
  `wholeWorkingDirectory`, which records that you accept Codex reading the entire working
  directory. The default, `refuseNarrowedScope`, refuses and explains.

Write scope is expressible: Bachata sends the exact writable roots, and excludes the
temporary directories the protocol would otherwise make writable.

File approval binds to the current thread, turn and proposed item. The prompt lists proposed
paths, including rename targets. Scope checks run before the prompt and after the answer;
stale or out-of-scope proposals are refused. Workspace-policy approvals apply once.
Native writes inside the CLI sandbox may run without an approval request; these checks do
not establish coverage of Git-ignored writes (EX-G6-09).

Bachata still computes its own narrowed read scope
(`resolveReadableWorkspaceRoots` in `src/browser/mutationPolicy.ts`). No shipped provider
consumes it today. It is kept because it is the exact meaning of Bachata's read exclusions, and
a provider that gains the capability must be given that set rather than a new interpretation
of it.

## Choosing and disabling providers

`Bachata: Setup` has a **Providers** entry. It states what each provider's probe found, lets
you name the provider you prefer, and lets you disable providers outright.

- `bachata.preferredProvider` — a stated preference outranks readiness, so a workflow never
  silently runs on a provider you did not choose.
- `bachata.disabledProviders` — a disabled provider is refused before any turn starts, and
  Setup never offers a workflow bound to it.

## Claude Code

1. Install the Claude Code CLI.
2. Sign in with the CLI's own login flow.
3. Confirm `claude --version` answers in the workspace root.
4. If it is installed but not found, set `bachata.claudeCommand` to the absolute path.
5. Recheck Claude Code from Doctor.

## Z.AI GLM

Bachata ships GLM through Z.AI as the distinct provider identity `zai-glm`. It reuses the Claude Code process transport, because Z.AI documents Claude Code support through its Anthropic-compatible endpoint. It is not Anthropic Claude, and Bachata never labels it as Claude. Generic Browser Z.AI remains a separate provider path.

Setup:

1. Install the Claude Code CLI. `bachata.zaiCommand` selects the executable and defaults to `claude`.
2. Create a Z.AI API key and export it as `ZAI_API_KEY` in the environment VS Code starts from. `bachata.zaiAuthTokenEnvironment` renames that variable. Bachata reads its value at spawn time, passes it to the Z.AI process only as `ANTHROPIC_AUTH_TOKEN`, and never stores, exports, or logs it.
3. `bachata.zaiBaseUrl` defaults to `https://api.z.ai/api/anthropic` and is passed as `ANTHROPIC_BASE_URL` to the Z.AI process only.
4. Set `bachata.zaiModel` to the GLM model you want. A pipeline agent's own `model` wins over it. With neither set, Z.AI picks its own default and recorded evidence cannot name the model.
5. `bachata.zaiEnvironmentVariables` forwards extra variable names to the Z.AI process only.
6. Run Doctor. It reports the command, the endpoint, whether the credential variable is set, and the selected model. It never prints the credential and never sends a model request.

Environment isolation is by ownership. `ANTHROPIC_*` and `CLAUDE_*` reach Claude Code only, `OPENAI_*` and `CODEX_*` reach Codex only, and `ZAI_*`, `ZHIPUAI_*`, and `GLM_*` reach Z.AI only, whichever provider names them in `bachata.providerEnvironmentVariables`. A Z.AI token therefore cannot reach Codex or Claude Code, and an inherited `ANTHROPIC_AUTH_TOKEN` is never reused as a Z.AI credential.

Provider contract:

- provider-scoped environment and credentials;
- never forward Z.AI token to Codex, Anthropic Claude, or unrelated provider;
- configurable model; never hardcode current GLM release;
- report Z.AI and selected GLM identity, not Anthropic Claude identity;
- never persist, log, or export credential values;
- ordinary Doctor performs local non-billing checks only;
- live authentication and session smoke is explicit user action.

Explicit live smoke covers authentication, selected model identity, start, resume, cancellation, tool use, long output, malformed output, expired credentials, and rate-limit reporting. It is a human action against real credentials. Missing credentials report a blocked test, never a pass. Deterministic provider-isolation, identity, configuration, and Doctor-redaction tests run in `tests/providerIsolation.test.cjs` and need no credential.

Official Z.AI Claude Code setup uses `ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic` and `ANTHROPIC_AUTH_TOKEN`: [GLM Coding Plan quick start](https://docs.z.ai/devpack/quick-start).

Technical compatibility and Coding Plan entitlement are separate claims. Do not market Coding Plan support until current terms explicitly cover Bachata's integration mode and review is recorded in [Provider terms](PROVIDER_TERMS.md).

## Git

Bachata requires Git 2.32 or newer for deterministic worktree orchestration. An unparseable or older version fails closed.

1. Install or upgrade Git.
2. Confirm `git --version` answers in the workspace root.
3. If Git is installed but Bachata cannot see it, add it to the PATH of the environment VS Code was launched from and restart VS Code.
4. Recheck Git from Doctor.

## Browser providers

See `docs/BROWSER_BRIDGE_INSTALL.md`. Browser providers need a local VS Code window, the Bridge extension, a signed-in provider tab, and a bound conversation per browser role.

## Terms

See `docs/PROVIDER_TERMS.md` for the integration mode and usage-terms review status of every advertised provider.
