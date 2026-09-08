# Development

[Product doctrine](PRODUCT_DOCTRINE.md) controls feature direction. Prefer accumulated refinement and lower human attention cost. Execution hardening needs concrete failure mode, user need, or platform constraint.

## Requirements

- Node.js >=22.13.0. `node:sqlite` is a hard dependency of the local catalog, broker and
  mutation fence, and it is only available unflagged from that release onwards. VS Code
  1.101 ships Node 22.15.1, so the declared `engines.vscode` floor already satisfies it.
- npm
- VS Code 1.101+

## Commands

```bash
npm install
npm run check-types
npm test
npm run test:coverage
```

A normal development/release checkout may keep a complete package-manager lock and
use it to validate VSIX packaging from an empty dependency directory:

```bash
rm -rf node_modules
npm ci
npm run check:lockfile
npm run package
```

The maintained-source distribution carries the package's own `package-lock.json`, so an
extracted distribution installs the same dependency closure continuous integration
installs, with `npm ci`. Only the package-root lockfile is maintained source: a lockfile
created by a nested install below the root is refused by both the exporter and
`npm run source:verify`, and other package managers' lock files are refused everywhere.

One run owns this worktree at a time. Build, watch, the unit suite, the coverage gates,
packaging and the gates that load `dist` all take the same lock, and a run releases it when
its work finishes. Ownership is never transferred: a lock left behind by a crash or by a
signal the run did not handle stays until an operator clears it, because a dead wrapper
process is no proof that the compilers and test runners it started have stopped. To clear
one, confirm nothing from that run is still working here, read the `token` field from
`.bachata-worktree.lock`, and run the command below with `LOCK_TOKEN` replaced by that token:

```bash
npm run worktree:unlock -- LOCK_TOKEN
```

Coverage excludes test files and enforces separate thresholds for loaded extension source, critical deterministic modules, the central runtime, the webview behavior module used by the shipped UI, and a browserless smoke test against the compiled webview renderer. Normal Node test files are discovered in deterministic sorted order and run sequentially in isolated processes. They must exit naturally; a bounded watchdog terminates and fails a file that leaks timers, servers, SQLite handles, worktrees, or child processes. Coverage commands also use bounded watchdogs. The two broad coverage passes use concurrency two; focused runtime and webview gates remain serial. The guarded Extension Host E2E remains the final validation for the real VS Code DOM and lifecycle.

`npm run package` resolves the locally installed `@vscode/vsce` development dependency, requires exact version `3.9.2`, verifies the CLI version, then creates a VSIX. It never downloads VSCE through `npx` or modifies dependency metadata during packaging.

Windows command scopes use a kill-on-close Job Object. POSIX command scopes use a dedicated process group plus an inherited scope token to find ordinary descendants that create a new session. This cleanup boundary is not a sandbox against a command that deliberately removes its tracking environment before detaching.

Browser adapters require a local extension host. Remote SSH, WSL, Codespaces, and other remote extension hosts are unsupported.

## Build output

`npm run build:emit` compiles extension code, the tested webview behavior module, and the main webview into `dist/`.

Prism is installed from the pinned `prismjs` package. `scripts/build.mjs` copies only the required language components, theme, and license into `dist/vendor/prism`. Do not commit generated Prism files.

## Source archive

Remove `dist/`, `node_modules/`, coverage output, generated packages, and VCS metadata before delivery.

## Manual checks

- Extension Host E2E: `HUMAN_E2E.md`
- Authenticated providers: `LIVE_SMOKE_TEST.md`
- Multi-session and shared-resource behavior: `CONCURRENCY.md`


## Source distribution

Never archive the working directory directly. Export the maintained-source allowlist
and validate that result:

```bash
npm run source:export -- /absolute/path/to/new/bachata-vscode-source
npm run source:verify -- /absolute/path/to/new/bachata-vscode-source
```

The destination must not already exist and must be outside this package. The exporter keeps
this package's root `package-lock.json`, but excludes nested and other package-manager locks,
dependencies, build/test/runtime/cache output,
coverage and test artifacts, logs, nested archives, generated verification reports,
VCS metadata, and symlinks. The protocol compatibility manifest is maintained source
and is named `protocol/browser-bridge.compatibility.json` rather than a lock file.

An extracted distribution runs `npm ci` and then the commands under **Commands** above. All of
them pass there.

### Which facts and gates need a Git checkout

The distribution carries no VCS metadata, so anything enumerated with `git ls-files` cannot be
measured inside one. That is stated rather than worked around:

- `BUILD_FACTS.md` rows whose names say **(Git-tracked)** report `not enumerable without Git`
  where there is no checkout. `npm run check:build-facts` then compares every fact the tree can
  measure, fails on any that drifted, and names the ones it could not verify. In a checkout it
  compares the whole section byte for byte, as before.
- The Git half of `tests/sourceDistribution.test.cjs` — that the tracked enumeration is exactly
  the maintained tree filtered by Git — is checkout-only. Without one, the enumeration must be
  the whole maintained tree, and that is what is asserted instead.
- The Git half of `tests/buildFacts.test.cjs` — that regenerating reproduces the committed
  section, and that a drifted Git-tracked row is reported — is checkout-only for the same reason.
  Drift in facts measurable anywhere is still asserted in both.

`npm run lint` and `npm run format:check` enumerate their candidates with Git and refuse to run
without a checkout rather than reporting success over a tree they never read. Run them in a
checkout.
