# Browser deliverable selection research

## Decision

Route explicit ZIP, Markdown, plain listing and diff representations in the controller.
Use an interpreter to select captured references only when the representation is ambiguous.
The controller determines coverage and required-path completeness; the interpreter does not
rewrite content or decide that an incomplete reply is complete.

The typed contract now lives in `src/browser/deliverableSelection.ts`. Production deliverable
preparation accepts an explicit caller-owned `selectionRequirement`; research replays use
the same compiled resolver through `scripts/lib/browserDeliverableSelection.cjs`. This code
is built in the checkout. An agent step can declare `browserDeliverable`; the pipeline validates
and copies that exact format/path manifest into the runtime and managed handoff. Steps without
this declaration retain their existing automatic format handling.

## Contract

The caller supplies a format and an exact required path manifest. A bounded Bridge capture
must have contiguous segments covering its complete rendered text, unique assets, a request
identity, a session identity and a final conversation identity.

The controller hashes the capture and requirement into `captureId`, then exposes eligible
candidate IDs. An interpreter returns exactly three fields:

```json
{"protocol":"bachata-deliverable-selection-v2","captureId":"<digest>","selectedIds":["segment:1"]}
```

Unknown IDs, extra fields, duplicate selections and decisions for a changed capture or
requirement are refused. An empty selection is an abstention. JSON Schema constrains the
protocol, digest and IDs when supported by the local model transport.

| Format | Authoritative representation | Controller checks |
| --- | --- | --- |
| ZIP | One downloadable generated artifact | Sequenced transfer, size and SHA-256; archive CRC, path and size limits; exact requested manifest |
| Markdown | Explicit `FILE path` label followed by a Markdown code block | Unique path coverage; original captured UTF-8 bytes |
| Plain listing | Plain text with one `FILE path` record per line | Safe unique paths; exact requested manifest; original captured bytes |
| Diff | One labeled or sole diff code block | Target manifest and read-only Git syntax inspection; original capture provenance |

ZIP preview text never substitutes for downloaded files. Quotations and unrelated examples
are not candidates. Ambiguous or incomplete explicit representations abstain locally.

Rendered diff blocks can omit their final line delimiter. If Git rejects the raw block,
the controller may append exactly one LF and must then obtain a successful Git syntax check.
It retains the original capture digest and offsets, records this transformation, and records
the prepared digest. Malformed hunks remain refused. No content lines are rewritten.

Every selected result keeps request, provider, initial/final session, conversation, capture
segment offsets and byte digests. Downloaded archives also keep per-entry digests. A complete
requested manifest is not proof of task correctness: the result explicitly reports provider
fidelity as `bestEffort` and task correctness as `unverified`.

## Recorded experiment

The experiment reuses saved real ChatGPT Bridge captures for Markdown, a plain listing,
a diff and a ZIP. A fifth case adds a required listing path absent from the capture and must
abstain or refuse. The ZIP transfer is reconstructed from saved download bytes; it is not a
new live download. There are five cases per local interpreter:

| Route / interpreter | Passed cases |
| --- | ---: |
| Deterministic explicit routing | 15 / 15 |
| Qwen `qwen3.5:4b-q4_K_M` | 5 / 5 |
| Ministral `ministral-3:8b-instruct-2512-q4_K_M` | 5 / 5 |
| Bonsai `digitsflow/bonsai-8b:latest` | 3 / 5 |

These are the current controller's revalidation results from
`deliverable-selection-controller-v6.json`, using the decisions recorded in the strict-schema
model experiment `deliverable-selection-schema-v3.json`. Revalidation sent no new model or
browser prompts, verified unchanged capture hashes and did not rewrite the recorded decisions.
The report records hashes of the compiled resolver, transfer, archive and path-policy modules,
as well as the research entry point.
Bonsai abstained on valid Markdown and diff cases. Earlier experiment results used a different
contract or expected the unterminated diff to be refused; they do not supersede this table.

The small sample supports deterministic routing of these explicit formats. It does not
establish general model compatibility, GLM or Claude web compatibility, semantic correctness,
or safe application of changes across providers. Raw prompts, responses, captures, ZIPs and model reports stay
outside Git under `local-experiments/browser-observations`.

## Production preparation

Explicit preparation routes locally unless the caller supplies a selection decision. Missing,
ambiguous or incomplete representations produce a correction without changes. Markdown, ZIP
and diff selections enter the existing scope and file-version checks and create a candidate
for the existing approval and execution gates. ZIP paths retain the exact requested manifest;
this route never guesses an archive root. A plain listing returns evidence without creating
a workspace action or asserting that the listed files exist.

Focused checks cover exact multilingual bytes, diff delimiter provenance, ZIP manifest
refusal, stale or missing file versions, restricted paths, read-only policy and mixed control
actions. The existing executor applies admitted Markdown and diff candidates with version
checks. Input is snapshotted before external downloads or syntax inspection, and download
chunks are copied before hashing to preserve bytes if a producer reuses its buffer.

Example agent-step declaration:

```json
"browserDeliverable": {"format":"markdown","paths":["notes/result.md"]}
```

The declaration accepts ZIP, Markdown, listing or diff with safe unique paths and an 8 KiB
manifest budget. It requires a Browser Bridge participant and a non-consensus step without a
JSON output contract. It does not grant write permission or widen readable scope. Context and
verification controls remain available in separate replies; direct mutation controls cannot
replace the requested representation. Managed rollover handoffs retain the exact manifest.

Runtime checks exercise context → delivery → verification → completion for all four formats.
A listing records evidence without creating an action. An unchanged deliverable requires no
write; a change satisfies the delivery requirement only after the existing executor reports
success. Missing deliverables exhaust a bounded correction budget, and a response without a
Bridge capture cannot satisfy the requirement. These checks use a simulated provider through
the real runtime; they do not prove live provider compatibility.

## Installed live captures (28 September 2026)

ChatGPT plus Qwen produced fresh listing, Markdown and diff captures through the connected
Bridge. The installed selection/preparation code accepted their exact captured references.
The installed workspace executor applied Markdown and diff to isolated fixtures outside Git;
the listing produced evidence without creating files. These runs reused an existing test chat
and do not establish fresh provisioning, the full pipeline audit or GLM compatibility.

The new ZIP run confirmed submission and captured the reply, but captured no asset. Read-only
inspection found ChatGPT rendered `source-smoke.zip` as a `span[role="button"]` with
`data-file-reference="true"` and `data-markdown-copy-text="source-smoke.zip"`, without a link,
transfer URL or provider file ID. The current asset discovery requires a provider ID for
button-only controls. The ZIP run failed before interpretation, download or workspace mutation.
The temporary inspection tab was closed. No native download bytes were admitted or fabricated.

## Next implementation

1. Exercise the declared manifest through the installed runtime and real Bridge captures,
   preserving approval, candidate and verification gates. Diff syntax acceptance alone must
   never authorize application.
2. Use live provider replies containing competing examples, missing paths and stale
   selections to decide whether an interpreter adds value for ambiguous cases.
3. Support the observed ChatGPT file-reference control with a verified transfer path and
   response-bound identity; a filename or a download label alone cannot prove ZIP bytes.

The separate longer compact-protocol production run remains incomplete; see
`BROWSER_OBSERVATION_RESEARCH.md`. Its Bridge provisioning failure is not a passed result
for this deliverable contract.
