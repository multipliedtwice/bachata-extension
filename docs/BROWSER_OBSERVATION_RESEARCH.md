# Browser observation handles: first research probe

Status: scripted measurement, retrieval prototype and model-driven research runner,
2026-09-28. No runtime feature or
default change. The local bounded-state pilot remains frozen.

## Question and initial decision

Can controller-owned observation handles reduce input in managed browser workflows while
preserving exact evidence and controller authority?

The first probe supports selective exploration for large source reads. It does not support
packing every result. Small messages are dominated by repeated protocol instructions. Full
recall can cost more than sending the original text. A representative model-driven trajectory
is still required before enabling handles in the managed runtime.

## What Bachata owns

`src/browser/managedTurn.ts` prepares the handoff, executes the managed control envelope, and
renders the next controller result prompt. `src/runtime/createRuntime.ts` sends that prompt
through Browser Bridge and performs conversation rollover when the byte budget is reached.

The managed actions expose workspace source, directory/search context, mutations and
controller verification. There is no DOM-observation tool in this loop today. This probe
therefore measures source reads and verification records. It does not fabricate DOM traffic.

Each continuation carries new controller results and the managed control protocol. Bachata
does not re-send the whole previous transcript on each iteration. The website retains its own
conversation history, which Bachata cannot rewrite in place. Historical text can be removed
from future conversation context only by an explicit fresh-conversation handoff.

The related [SoL-Pi ObservationPack mechanism](https://arxiv.org/html/2609.20519v1) changes
observation exposure inside a harness-owned model context. Its reported savings cannot be
transferred to this browser conversation architecture without measurement.

## Measurement

Run the real controller renderer with scripted read requests:

```powershell
node scripts/context-mode-benchmark.cjs browser-observations --fixture --output C:\Users\multi\bachata\local-experiments\browser-observations\controller-probe.json
```

The compiled controller in `dist` must match the source being investigated. Run `npm run
build:emit` if the runtime changed. The collector records hashes of the four relevant compiled
modules and its three source files, plus the checkout revision. These identify the executed
collector and renderer even when the checkout has uncommitted research changes.

Analyze a native Bachata transcript export or its JSONL store:

```powershell
node scripts/context-mode-benchmark.cjs browser-observations --trace C:\path\transcript.json --output C:\path\observation-summary.json
```

The report contains byte counts, categories and numeric turn records. Source text, previews,
workspace paths, task prompts and evidence digests are not copied into the report. Trace mode
selects managed provider prompts, excluding user messages and ordinary local-provider prompts.
It does not infer provider sessions or claim that separate tasks share one model context.

Metrics:

- Sent prompt bytes: actual UTF-8 size of the recognized controller prompts.
- Controller JSON bytes: the exact JSON block inside each prompt.
- Observation text wire bytes: serialized string values for source, diff, command output and
  verification summaries, including JSON escaping and quotes. Keys and structural metadata
  remain outside this category.
- Large observation bytes: those values whose decoded UTF-8 text is at least 8 KiB.
- Repeated observation bytes: exact repeated text within one handoff scope. Fresh handoffs
  reset this measure. This is potential reuse, not an instruction to suppress a requested read.
- Protocol/wrapper bytes: prompt bytes outside the controller JSON block.
- Growth checkpoints: cumulative sent prompt bytes at 10, 50, 100 and 200 prompts. Recorded
  answer bytes are reported separately; they never become a billed-input estimate.

These are byte measurements. They are not token counts, cache savings, provider input totals,
cost, latency, or task quality. No runtime counters or telemetry were added.

## Workload

Three scripted trajectories each contain one actual initial handoff and 199 controller result
prompts. All use the same reproducible, Unicode-containing fixture workspace outside Git.
Requests are read-only; the approval callback rejects mutation candidates.

- Metadata: scope requests with an integrity verification request every 25 iterations.
- Small reads: eight source lines, metadata every five iterations, verification every 25.
- Large reads: 240 source lines, with the same metadata and verification cadence.

The source-read trajectories have 160 file reads, 32 metadata requests and seven verification
requests after the handoff. This deliberately isolates an observation-heavy case. It is not a
claim about the frequency of repeated reads in real model work. The initial handoff includes
selected source in every arm, including the metadata-only arm.

## First result

The probe used the controller built for source revision `558b234` (Bachata 0.7.8). The numeric
report is retained outside the repository at
`C:\Users\multi\bachata\local-experiments\browser-observations\controller-probe-v1.json`.
The subsequent inline-once comparison is in `controller-probe-v2.json` in the same directory.

| 200-prompt trajectory | Sent prompt bytes | Observation text share | Large text share | Protocol/wrapper bytes |
| --- | ---: | ---: | ---: | ---: |
| Metadata | 628,159 | 5.65% | 5.35% | 545,716 |
| Small reads | 714,879 | 10.51% | 4.70% | 545,716 |
| Large reads | 6,055,359 | 89.42% | 89.39% | 545,716 |

In the large-read trajectory, cumulative sent prompt bytes were 338,268 at 10 prompts,
1,541,661 at 50, 3,046,227 at 100 and 6,055,359 at 200. Actual controller output was already
bounded and no omission flags appeared in these fixtures. Current bounds were preserved.

The available local conversation trace contained zero eligible managed-browser prompts. It
provides no evidence of observation dominance in representative model-driven work.

## Offline retrieval prototype

`scripts/lib/browserObservationPrototype.cjs` retains exact immutable strings in memory,
deduplicates within one scope, and replaces only large observation strings with opaque
handles, byte lengths, an incomplete flag, and up to 512 UTF-8 bytes from each end. Status,
verification state, file versions and existing truncation metadata stay inline.

Recall returns exact UTF-8 slices with offsets and total byte length, limited to 16 KiB per
request. Unknown handles, oversized pages and offsets splitting Unicode characters refuse.
Store admission is bounded to 1,024 objects and 16 MiB; a new handoff creates a new store.
The runner verifies both partial slices and full reconstruction against independent source
buffers. It does not ask a model to choose which slice is sufficient.

The prototype is an offline counterfactual with three recall policies:

- No recall: an optimistic lower bound. No task-quality claim.
- Partial recall: one middle slice of about 10% per packed exposure, capped at 16 KiB.
- Full recall: enough bounded pages to reconstruct every packed exposure.

Each simulated recall pays for its JSON result plus the current prompt's protocol/wrapper
and the prototype's retrieval instructions. Provider request output, latency, hidden system
prompts and retained website context are not priced. Extra calls are reported explicitly.

For the large-read trajectory, partial recall reduced sent bytes by about **68%**, adding
**161 calls** to the 200 baseline prompts. Full recall increased sent bytes by about **21%**,
adding **322 calls**. The no-recall bound reduced sent bytes by about **85%**, but does not
establish that the model can finish without the omitted content. Small-read gains were only
about **4%** under partial recall, coming from the one large initial handoff.

### Prefer full first exposure, then receipts

A second projection policy, `inline-once`, sends each large string in full the first time in
the current scope. Later identical exposures use receipts marked as previously exposed in
that scope. This uses the history the browser already retains. A fresh handoff resets the
assumption; a different source string is exposed in full again.

| Large-read trajectory policy | Sent prompt bytes | Added recall calls | Difference from baseline |
| --- | ---: | ---: | ---: |
| Existing controller | 6,055,359 | 0 | — |
| Inline once; reuse retained history | 924,639 | 0 | −84.73% |
| Inline once; recall a middle slice per receipt | 1,971,839 | 160 | −67.44% |
| Inline once; fully recall every receipt | 7,321,439 | 320 | +20.91% |

The metadata and small-read arms remained byte-identical under inline-once because they had
no repeated large strings. Prefer this conservative policy for the next model-driven research
arm. The zero-recall result assumes the model can use previously exposed evidence; that is
still an experimental assumption, not a proven capability or a provider token saving.

## Candidate integration contract

If a representative trajectory justifies integration:

1. Reuse `src/state/executionEvidence.ts` for exact post-redaction evidence admission,
   durability, digest checks, reader permissions and export. Do not add a parallel production
   evidence store. The research store is deliberately disposable.
2. Bind the handle catalog to task, participant/role, candidate revision and conversation
   generation. A receipt references historical evidence; it never authorizes a mutation or
   substitutes for the controller's current verification verdict.
3. Expose the first large observation in full in each conversation generation. Use receipts
   only for exact unchanged text already exposed in that scope. Keep paths, status, failure
   codes, freshness, fileVersion and completeness inline. Store
   exactly the text currently admitted to the prompt. A handle to a truncated source excerpt
   must not be represented as a complete file.
4. Propose a strict `context.recallObservation` operation with id, offsetBytes and maxBytes.
   Unknown keys, wrong scope, missing evidence and invalid pages refuse. Extend/version the
   managed control envelope explicitly; the current v1 parser rejects this operation.
   Browser Protocol v9's capture transport need not change for this textual control experiment.
5. Admit evidence before publishing its handle. Persist the catalog before sending a prompt;
   recovery resolves the same exact evidence. On uncertainty, retain evidence and stop the
   dispatch. Do not silently fall back to an invented excerpt.
6. Pin an experimental mode per run. Fresh-conversation rollover explicitly carries permitted
   handles and current state. It does not re-admit old evidence as current or silently discard
   audit history. Existing byte, round, action and scope limits still apply.

## Model-driven follow-up

`scripts/browser-observation-model.cjs` lets models choose their context reads through the
real compiled, read-only managed controller. The fixture is a generated 128-entry source
catalog with four planted policy violations. A second phase asks for an exact deployment
detail from the middle of the source, a successful current file-version lookup and another
controller integrity check. It never edits a user's source tree.

Both arms retain chat history. The baseline exposes existing controller prompts; the
candidate applies `inline-once`. The research runner alone accepts scoped observation
recalls. The production v1 control parser remains unchanged.

The decision bar is fixed before calls: correct facts in the requested report, controller
checks in each phase, fewer sent prompt bytes, and at most two additional requests for the
two-phase pair. Each phase is bounded to eight requests. A history byte guard and local
context-token guard prevent claiming savings from silent context truncation. This is one
small workload, not a general provider-quality benchmark.

Run the installed local Qwen and Ministral models:

```powershell
node scripts/browser-observation-model.cjs --output C:\Users\multi\bachata\local-experiments\browser-observations\model-driven.json
```

The runner also exports `runBrowserPair(bridge, output)` for the existing local evaluation
companion's `withBrowserBridge` callback. It opens a fresh ChatGPT conversation for each arm,
binds and releases its own owner, and requires matching Bridge submission and response
events. It does not touch an existing user conversation. Provider model identity is marked
unverified because Bridge does not expose the visible model selector.

Summary reports and raw generated prompts, model answers and browser captures must stay
outside the extension checkout. Local-model reports distinguish newly appended prompt
bytes from full-history bytes submitted to Ollama. Browser runs do not report the latter or
invent provider token usage. Ollama's reported token counts are local API observations;
they are not browser billing or cache savings.

The exploratory local probe did not establish a usable baseline. The local models were
acting as managed reviewers, not as the normal semantic segment interpreter; these failures
do not assess their production interpreter role. Qwen returned invalid
control proposals and exhausted its guarded history while retrieving source. Ministral
identified all four planted findings, but its audit report was malformed JSON, and its
follow-up failed the control contract. These results do not justify integrating handles and
do not establish that the mechanism loses on a capable browser provider. An earlier setup
attempt advertised recalls before any receipt existed; that attempt is excluded.

The live Bridge pair started through the local companion on 2026-09-28. The main VS Code
window had changed to the extension checkout, where the companion did not find its
evaluation folder. Opening that folder in a dedicated VS Code window activated the
companion, which shared the existing authenticated Bridge server. No pairing reset or UI
reload was required. The companion's freshly imported format adapter supports an explicitly
tagged research request for this local compatibility path.

### Completed live observation comparison

`browser-model-v5.json` records the completed 2026-09-28 pair. Both baseline and inline-once
passed the audit and inventory, with exact values, a controller integrity check in each phase
and a successful current file-version lookup. Each sent **42,425 bytes in five prompts**.
The candidate produced **zero receipts and zero recalls**, giving **zero byte reduction**:
the model used the source supplied in the initial handoff without requesting it again.
Observation handles are not justified for this workload and remain research-only.

Earlier live setup attempts are excluded: response correlation, exact fenced JSON capture,
provider readiness between sends, and rich-composer URL serialization required fixes in the
local runner. Escaping soliduses only inside controller JSON prevented URL auto-link spans;
decoding the transmitted JSON is asserted equivalent to the original evidence. No source
literal or answer is normalized to make the quality oracle pass. The successful report counts
actual wire prompt bytes, including this escaping and the request marker. Category attribution
uses standard JSON serialization and is approximate when extra solidus escapes are present.

### Protocol framing experiment

The successful baseline repeated the 2,557-byte control protocol in three continuation
prompts. `scripts/lib/browserProtocolFraming.cjs` investigates a narrower reduction: send the
full contract on the handoff and replace only the exact known protocol suffix in subsequent
controller prompts with a compact reminder. Controller JSON, permissions, versions, failure
results and completeness remain byte-identical. Unknown wrappers, repair prompts and every
fresh handoff keep the full contract. One helper instance belongs to one browser conversation.
The reminder is limited to this read-only experiment; it is not a production mutation contract.

`browser-framing-v1.json` uses the already completed baseline, checking matching fixture,
compiled-controller hashes, acceptance criteria and a successful quality result before reuse.
It records the previous report hash, runner hash and the new helper hash and snapshots. The
candidate runs in a fresh chat. This sequential pilot cannot control an unreported provider
model or changes in provider conditions. The byte comparison does not estimate billed tokens,
cache use or general task quality. The same predeclared correctness and added-request bar
applies.

The live candidate completed both phases correctly with **36,668 sent bytes and five
prompts**, versus **42,425 bytes and five prompts** in the recorded baseline. It compacted
three protocol suffixes, had zero invalid responses, and passed every exact-fact, file-version
and controller-check requirement. That is **5,757 fewer bytes (13.57%) with no extra calls**
on this workload. It meets the predeclared pilot bar; it is not a general token, cost or latency
claim. Production rendering and defaults remain unchanged.

### Recovery and fresh-conversation workload

The `recovery-rollover` scenario runs a new matched baseline and framing candidate; it does
not reuse the easier pilot's baseline. It plans two faults per arm:

- Add an unknown action field to a captured valid proposal. The production validator must
  refuse the injected copy before any action executes. The original captured response is
  preserved, and the next repair sends the full protocol. This is harness fault injection,
  not evidence that the provider naturally generated an invalid proposal.
- Withhold approval for the first inventory file-version lookup. The actual controller must
  return a rejected action. Its next prompt explicitly grants permission to retry that lookup;
  a refused lookup never satisfies the current-version requirement.

After completing the audit, the fixture coordinator changes entry080's region and releaseTag
in its owned scratch source, prepares new controller state and opens a fresh browser chat.
The inventory must report the new exact values and obtain its own successful version lookup
and integrity verdict. Old snippets, version references and verification are not carried
into the new controller turn. Both arms send a full handoff and reviewer instructions in the
new generation. Summary checks require two distinct final browser conversation identities,
both full handoffs, the full repair, the actual rejection and successful current answers.

The complete sequence includes all dispatch bytes, repair messages and fresh handoffs, with
the same eight-request phase limit and at most two added candidate requests. Browser identity
and billing limitations remain those of the first pilot. Raw captured proposals, injected
copies, controller prompts and code responses remain outside Git.

The first attempt (`browser-framing-recovery-v1.json`) is excluded: the evaluation VS Code
window exited during the first submission, before any model answer was captured. The runner
was revised to grant explicit retry permission after the planned approval denial, and the
evaluation window was reopened against the existing connection.

The completed matched v2 comparison passed every audit, inventory and recovery requirement:

| Recovery sequence | Sent wire bytes | Prompts | Compact suffixes | Invalid provider replies |
| --- | ---: | ---: | ---: | ---: |
| Full protocol baseline | 80,377 | 7 | 0 | 0 |
| Framing once per conversation | 72,701 | 7 | 4 | 0 |

The candidate sent **7,676 fewer bytes (9.55%) with no added calls**, including the full repair
and both full handoffs. Both arms recorded one injected validator rejection, one actual
approval rejection, two full handoffs, one full repair and two distinct final conversation
identities. Both inventory answers used `eu-west-3` and `release-ญ-rollover`, with an actual
successful current version lookup and integrity verdict in that fresh controller turn.
The two planted faults are reported separately from naturally invalid provider replies.

The fresh-generation sequence is controlled by the research runner through Bridge; it does
not exercise the runtime's automatic byte-budget trigger or restart recovery. A focused check
uses the production rollover composer and confirms that the framing helper retains its
combined handoff and continuation contracts in full after prior exposure. Those production
lifecycle paths still need verification when implementing an option.

## Production pilot

The checkout now implements `bachata.browserManagedCompactProtocol`, default `false`, pinned
per run and restricted to read-only managed browser turns. The controller renders a full and
compact suffix from one admitted result body. `src/browser/managedPromptSession.ts` selects
the dispatched variant, tracks actual prompt and answer bytes, and binds full-contract
exposure to confirmed provider, tab, frame, document and conversation identity. Repairs and
verification-gate prompts remain full. Unknown or failed sessions cannot qualify for compact
exposure, and a changed or uncertain generation after known exposure forces fresh rehydration.
Generation changes during a send are handled before the next dispatch.

Exposure is not persisted. A restored operation starts with a fresh full handoff through the
existing managed-session path. Settings restoration keeps the recorded option; a recorded
snapshot missing this new key stays off, including runs recorded before settings snapshots.
Mutation-capable and ordinary unmanaged operations keep full framing.

Focused checks drive the real runtime, pipeline runner and managed controller with scripted
provider transports. They cover default and enabled operation, actual automatic rollover
at the supported 256 KiB minimum, full control repair, a document change during dispatch,
restored opt-in settings and an older snapshot without the option. Separate controller
checks compare the exact admitted body for source containing protocol-looking text, file
versions, failures and denied actions. No automatic rollover or restart result is claimed
from the earlier live research pair itself.

## Next research decision

### Longer installed-runtime attempt

The longer real-source review uses the installed local 0.7.8 pilot and the actual managed
pipeline API. It requests version/read pairs for six Thai Slider source and harness files,
then workspace integrity verification and a source-grounded final review. Raw dispatches,
captures, source hashes and excluded failure reports remain outside Git.

This production run has not passed. The attempts exposed two runtime defects that are now
fixed in the local v3 pilot:

- A blank native chat binding was reused as a fresh-conversation identity. Fresh managed
  handoffs now discard provisional native bindings while preserving stable identities and
  configured generic website bindings.
- A long rendered user message differed from its sent source, so submission matching timed
  out even though the browser produced the first answer. Managed prompts now carry unique
  `BACHATA_REQUEST_ID` markers already supported by Bridge. The sender includes the marker
  in actual prompt-byte limits, rollover decisions and accounting.

Focused runtime checks cover both fixes. The installed v3 attempt was blocked before its
first prompt: the earlier uncertain submission quarantined ChatGPT's shared blank-route
identity, and subsequent newly created blank tabs inherited that verdict. Bridge status
reports those pages as `failed` with `conversationState: uncertain`, despite an idle composer
in the UI. A built Bridge correction scopes blank-route holds to their actual tab while
retaining legacy holds and background-owned proof of independently created tabs. Focused
authority, worker-restart and background-provisioning checks cover this boundary. The
browser extension still needs reloading before another live run can exercise that fix.
No quarantine is cleared merely to make a run pass.

The first answer visible in the browser is diagnostic evidence of submission, not a completed
production audit. No production byte savings, automatic rollover or successful long-review
claim follows from these excluded attempts.

The format-selection research has progressed separately; see
[`BROWSER_DELIVERABLE_RESEARCH.md`](BROWSER_DELIVERABLE_RESEARCH.md).

Retain the observation prototype without integrating it. Both protocol-framing workloads met
their declared bars. The default-off read-only production pilot follows these boundaries:

1. Render the compact reminder from typed controller state rather than stripping arbitrary
   prompt text. Keep controller JSON, permission changes, failures, versions and completeness
   inline and unchanged. Mutation-capable turns continue using the full contract.
2. Bind contract exposure to participant, task, role and confirmed conversation generation.
   Every new handoff, repair, unknown contract, rollover or uncertain/recovered generation
   sends the full contract. A setting change must not reinterpret an active run silently.
3. Integrate where `sendManagedContinuation` chooses and accounts for the actual dispatched
   prompt. Preserve existing byte limits, approval decisions and verification requirements.
   Recompute actual size after any full rollover handoff; a reminder never authorizes a tool.
4. Exercise actual budget-triggered rollover and restored operation state in the integration. Keep
   the option experimental; these small generated ChatGPT workloads do not establish broad
   provider compatibility, mutation correctness, billed-token savings or cost savings.

Next, use the production pilot in a longer real read-only workflow and record useful work,
repairs and actual dispatch bytes. Separately, the next product R&D area is the semantic
interpreter's output contract: selecting ZIP artifacts, Markdown listings and diffs should
retain exact provenance and explicit completeness rather than depend on free-form summaries.

Do not add a general default-on packing layer from these synthetic results. For small-result
workflows, investigate repeated protocol framing separately. For large-result workflows, the
main question is whether useful decisions need small slices or most of the original text.
