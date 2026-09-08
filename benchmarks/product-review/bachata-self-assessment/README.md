# Bachata self-assessment fixture

Qualitative fixture. Not proof Bachata works.

Two models reviewed Bachata as product. Ten rounds. Human moved every message,
held state, decided what lived. `ledger.json` holds result: 13 withdrawn, 22
accepted, 3 open owner decisions, 3 claims one investigator could not reproduce.

No measurement runs here. No telemetry. Human reads and judges.

## What fixture for

Acceptance test for product-review cycle Bachata does not ship yet.

Give two participants independent product-review assignments on this repository.
Let Bachata reconcile. Compare Bachata Direction view against `ledger.json`.

Bachata pass when human can state accepted claims and open owner decisions
**without reading either full assessment**, and spends less attention than
manual run did.

## Direction view acceptance

- every accepted claim appears with its evidence;
- withdrawn claims leave top level, stay in history, keep reason;
- 3 open owner decisions bubble up, none buried;
- verification state per claim correct: verified, or not reproduced by whom;
- absence-search failures visible as pattern, not one-by-one;
- no duplicate claim identity for same subject.

## Freeze boundary

Rounds 1-2: independent first pass. Frozen.

Round 3: reconciliation. Peer answers exposed on purpose. Matches
`presets/review-only.pipeline.json` shape: independent discovery, then
cross-reference. **Not** contamination.

Rounds 4-10: meta-rounds. Each inherited everything before. No freeze. **Not** a
valid fresh longitudinal cycle. Do not use as one.

Compare on ledger. Never on prose.

## Comparison arms

Run arm 2 first. Arm 2 can kill orchestration product.

1. one strong agent, one pass;
2. same agent, two fresh passes, outputs withheld until both done;
3. two models, independent outputs, no Bachata convergence;
4. Bachata within-run convergence;
5. Bachata full loop: review, challenged finding, isolated verified fix, fresh
   review, material delta.

Report raw quality **and** quality per provider turn. More inference alone must
not read as better result.

## Measures

Human counts these. No automated collection.

- accepted-claim precision;
- false positives surviving challenge;
- claims found only in later cycle;
- regressions introduced by fixes;
- elapsed time and provider turns per accepted claim;
- human reading time, intervention count.

## What this run showed

- Challenge worked. 13 claims died against repository evidence.
- All 13 withdrawals were Claude-side. Zero GPT-side.
- 3 of 13 were absence-search failures: claim of absence from one search
  pattern. Tagged row by row as `failureMode: absence-search`. Earlier round
  said 9 of 13. Tagging does not support 9. Figure withdrawn.
- Other failure modes: reasoning 4, partial-read 2, overstatement 1,
  unsourced-assertion 1, unverified-presence 1, misattribution 1.
- Highest-severity findings landed late. `A-14` (disclosure exceeded
  enforcement) round 5. `A-20` and `O-03` (Codex protocol has no readable-root
  capability at all) round 8-9, and only because a live provider was tried.
  Weak support for longitudinal thesis. No support for within-run convergence.
- Mock fixtures hid `A-20` from 1424 passing tests. Mock agreement is not
  provider agreement.
- Human carried identity matching, provenance and state by hand. That work is
  what Bachata claims to remove.

## Row fields

`id` `subject` `claim` `disposition` `provenance` `materiality` `affectedScope`
`supportingEvidence` `refutingEvidence` `verificationState` `failureMode`
`ownerDecision` `supersessionHistory`

`disposition`: `accepted` | `withdrawn` | `unresolved`.

`verificationState.verifiedBy` lists investigators who checked against the tree.
`verificationState.notReproducedBy` lists investigators who could not. Empty
`verifiedBy` means nobody verified. Not same thing as false.
