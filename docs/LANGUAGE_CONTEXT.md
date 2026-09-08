# Future language-aware managed context

Status: post-release specification. Not release blocker.

## Goal

Extend graph-backed managed-browser context beyond TypeScript and JavaScript.
Keep exact language semantics, bounded controller context, hash evidence, path safety,
and explicit uncertainty.

This work affects managed browser context only. Codex and Claude Code keep own
repository tools. Antagonistic pipeline behavior stays unchanged.

## Current baseline

- All supported text files remain inventory, search, tree, list, and read candidates.
- TypeScript and JavaScript add resolved imports, re-exports, dependency promotion,
  reverse dependents, exported symbols, and syntax checks.
- Other languages get readable inventory without graph claims.
- `context.dependencies` means direct resolved workspace-local source dependencies.
- `context.dependents` means reverse file importers or references. Never call graph.
- Full-file hashes authorize mutation. Range hashes never authorize mutation.

## Locked rules

- No regex import extraction.
- No filename guessing.
- No repository code execution.
- No repository compiler, language server, package manager, build script, shell, or network execution.
- No automatic dependency install.
- No file outside normalized readable inventory.
- No symlink or realpath-boundary weakening.
- No unbounded file, byte, time, depth, or cursor work.
- No telemetry.
- No language support claim from readable inventory alone.
- Mixed-language repository allowed. Unsupported cross-language edge stays unsupported.

## Architecture

Extract language-neutral graph engine before adding language.

```text
guarded inventory + reads + cache + budgets
  -> language registry selects adapter by path and verified project config
  -> pure parser returns declarations and dependency references
  -> pure resolver maps references to guarded inventory paths
  -> generic graph engine owns scoring, promotion, dependents, cursors, coverage
```

Use functional adapter registry. Adapter gets normalized relative paths and controller-read
text only. Adapter gets no raw filesystem, absolute path, process, credentials, or network.

Proposed contracts:

```text
ContextLanguageAdapter
  id
  version
  sourcePaths
  configPaths
  parse(path, text)
  createResolutionState(configFiles)
  resolve(fromPath, reference, inventory, state)

ContextFileSemantics
  language
  declarations with exact line ranges
  public symbols when language defines them
  dependency references with kind

ContextResolution
  resolved workspace path
  unresolved
  external
  ambiguous
  unsupported
```

Generic engine rejects adapter output outside readable inventory.

## Exact semantics

Each shipped adapter must:

- use pinned in-process grammar parser or compiler-front-end library;
- follow documented project and module-resolution precedence;
- resolve only proven workspace-local source dependencies;
- distinguish resolved, unresolved, external, ambiguous, and unsupported references;
- state coverage per file and request: `complete`, `partial`, or `unavailable`;
- fingerprint file hashes, index revision, adapter version, and relevant config;
- invalidate graph and cursors after source or config change;
- expose unsupported platform, conditional, macro, reflection, dynamic-load, generated-code,
  framework-DI, and build-output behavior instead of guessing;
- keep cancellation and all existing budgets.

Keep existing request actions. Add bounded response metadata:

```json
{
  "language": "python",
  "coverage": "partial",
  "results": [],
  "unresolved": [
    { "specifier": "example", "reason": "ambiguous" }
  ]
}
```

Handoff manifest may add optional `language` and `publicSymbols`. Do not silently change
existing `exports` meaning. Version handoff if consumer compatibility requires it.

## Fallback

- No adapter: keep inventory, list, tree, read, and search. Graph says `unavailable`.
- Unsupported project config: disable graph for affected scope only.
- Parse failure: keep file readable and searchable. File graph says `unavailable`.
- Partial support: return proven edges plus exact omission reasons.
- Timeout, budget, or cancellation: never reuse incomplete state as complete.
- Config mutation: invalidate adapter state, graph results, and cursors before next request.
- Initial context promotion skips unavailable edges and tells model graph coverage incomplete.

## Language admission gate

Do not name language supported until all pass:

1. Deterministic resolution runs in-process from pinned code.
2. No repository or toolchain execution needed.
3. Common project and monorepo config works through guarded reads.
4. Parser and resolver license, package closure, VSIX size, and cross-platform behavior fit.
5. Fixed fixtures cover aliases, nested projects, conditionals, ambiguity, config changes,
   and unsupported dynamic forms.
6. Acceptance corpus has zero false edges. Missing edges carry explicit partial coverage.
7. Existing file, byte, time, depth, cancellation, and path bounds stay enforceable.
8. Recorded post-release user need exists. No telemetry needed.

No first language selected now. Python, Go, Rust, JVM, and .NET resolution each has hard
runtime, workspace, feature, build, or classpath semantics. Popularity alone not enough.

## Phases

### Phase 0: extraction

- Extract generic graph engine.
- Wrap current TypeScript and JavaScript behavior in first adapter.
- Require exact behavior parity.

### Phase 1: conformance

- Add adapter conformance harness.
- Add coverage metadata.
- Enable no new language.

### Phase 2: one spike

- Select one language through admission gate.
- Build fixed resolver corpus.
- Stop if correct resolution needs forbidden execution or guessing.

### Phase 3: one release

- Ship one adapter only after complete fixture matrix and managed browser smoke.
- State exact supported and unsupported semantics.

### Phase 4: repeat

- Repeat independently per language.
- Never add generic import parser.

## Required tests

- TypeScript and JavaScript parity: selection, promotion, dependencies, dependents,
  aliases, packages, cache invalidation.
- Parser coverage for every supported syntax form.
- Resolver coverage for nested config, aliases, module roots, monorepos, conditionals,
  ambiguity, external dependencies, and unsupported forms.
- Zero guessed edges.
- Mixed-language repository and unsupported cross-language reference.
- File, byte, resident-file, depth, search, timeout, and cancellation bounds.
- Source and config change invalidates graph and cursors.
- Read scope, traversal, symlink, restricted path, generated path, dependency directory,
  and realpath-race rejection.
- Adapter result cannot escape guarded inventory.
- Full-file and range-hash mutation rules unchanged.
- Existing protocol actions remain compatible.
- Handoff manifest remains byte-capped.
- No shell, network, dependency install, or telemetry path.
- End-to-end managed Worker context request, guarded patch, verification, Lead review.

## Non-goals

- Symbol call graph.
- Runtime, reflection, macro, generated-code, or framework inference.
- External package source indexing.
- Language-specific verification or typechecking.
- Cross-language graph without separate specification.
- Framework adapters.
- User toolchain execution.

## Stop conditions

Stop candidate when:

- correct resolution needs forbidden execution;
- resolver produces known false workspace edge;
- unsupported state cannot be surfaced;
- adapter can escape guarded read scope;
- cancellation, budget, hash, or config invalidation regresses;
- package or cross-platform behavior remains unresolved;
- TypeScript or JavaScript behavior regresses;
- acceptance corpus incomplete.

## Verification

```sh
npm run build
node scripts/run-test-files.mjs tests/contextLanguageAdapter.test.cjs tests/contextDependencyExpansion.test.cjs tests/contextSearchBudget.test.cjs tests/contextIgnoreScopes.test.cjs tests/contextEvidence.test.cjs tests/controlProtocol.test.cjs tests/managedDeveloperLoop.test.cjs tests/managedContinuation.test.cjs tests/workspaceActions.test.cjs tests/runtimeSafety.test.cjs
npm run check:no-telemetry
npm test
npm run package
```
