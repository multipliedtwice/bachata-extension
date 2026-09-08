# Privacy

No telemetry. `NO_TELEMETRY.md` is authoritative.

Privacy is operating boundary, not product positioning. Human attention surface may compress model output into core decisions, while complete drill-down history and provenance remain available under retention rules. See [Product doctrine](PRODUCT_DOCTRINE.md).

Bachata sends no analytics, crash reports, usage metrics, fingerprints, install IDs, or remote logs.

Stored locally: SQLite deterministic state, compact previews, bounded per-run recovery records, custom pipelines, attachments, TODO ledgers, and extension-created worktrees and branches.

Provider sessions remain full conversation history. Bachata may store a minimal provider conversation locator so supported history can be reached on demand, and states per run whether it can be: `available`, `unavailable`, or `unknown`. Exports strip provider session and conversation locators.

No permanent full-answer or durable evidence-snapshot table exists. Compact typed output, provenance, hashes, and bounded operational transcript or recovery data remain until their documented retention boundary. No silent unlimited response cache.

Prompts, selected files, and answers go only to providers selected by the pipeline. Browser cookies and authenticated asset URLs stay inside the Browser Bridge.

Network use is limited to selected providers, the loopback Browser Bridge, and an optional user-configured semantic interpreter. Remote semantic interpretation is off by default.

Full transcript export is explicit and local.

## Before a run: outbound context preview

The run contract states, per provider, exactly what will be sent: your composer message, the step instructions, the role instructions, each attachment by name, type, and size, and the repository excerpts. Entries the controller selects at run time are labelled as such, with the byte bounds that apply.

Each manifest also states what is never sent, and one thing plainly: outbound text is sent as written. Bachata does not rewrite what you ask a provider. Redaction applies to stored transcripts and exports, not to what the provider receives.

## Where local data lives

`Bachata: Local Data` lists every local store with its exact path and size:

| Store | Location |
| --- | --- |
| Run catalog and metadata | `<extension storage>/bachata-state.sqlite` |
| Transcripts and per-run storage | `<extension storage>/conversations/<run>/` |
| Attachments | `<extension storage>/attachments/` |
| Pipeline snapshots | `<extension storage>/pipelines/` |
| Retained Git worktrees | reported per retained run |

Each entry states what deleting it removes and what it keeps. The distinctions matter: deleting transcripts keeps catalog metadata and history search; deleting attachments keeps their names, sizes, and types in the catalog; deleting worktrees keeps your repository and its commits.

## Retention

`bachata.localDataRetentionDays` is 0 by default, which keeps everything. Set it to a number of days and `Bachata: Local Data` offers to delete stored transcripts and attachments of archived, idle runs older than that. Bachata never deletes local data on its own; cleanup is always an explicit confirmed action that lists the runs first.

## Export

Every export is previewed before it is written. Bachata opens the exact bytes in an editor, then asks for confirmation with the applied redaction rules and the size.

Three formats: run bundle (JSON), evidence report (Markdown), and evidence findings (SARIF 2.1.0) for review tooling. All are produced locally from data already on this machine; no format uploads anything.

A repository may add its own rules in `.bachata/export-policy.json`:

```json
{
  "version": 1,
  "redactLiterals": ["ACME-INTERNAL"],
  "excludePathPrefixes": ["private"]
}
```

Literals are replaced with `[REDACTED]` and matching changed-file paths are dropped from evidence exports. A policy file that fails validation is ignored, and the preview says so rather than applying a partial file.

Redaction is heuristic. It cannot guarantee that every secret or sensitive value was removed. The preview exists so a human reads the file before sharing it.

## Reading a bundle someone sends you

A run bundle records a SHA-256 digest of its version, its export time, and the run section it carries. `Bachata: Inspect Run Bundle` reads a bundle without creating a run: it recomputes the digest, states whether it matches, and then reports the run identity, providers, verification, changed files, evidence ledger, unresolved risks, and final assessment as recorded. A bundle whose digest does not match is reported as such and cannot be replayed; a bundle with no digest is reported as unrecorded, never as verified.

The digest is self-declared and detects accidental change: a truncated download, a corrupted copy, a careless edit. It is not a signature and not tamper-proofing. Anyone who edits the bundle can recompute the digest, and it says nothing about who produced the file. Treat a bundle you did not export yourself as untrusted input regardless of what its digest says.
