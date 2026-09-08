# Moderated validation checklist

Human-only. Not performed. No result in this file is recorded.

Primary product question: can human direct iterative multi-agent work and understand current initiative direction without reading model transcripts? Current checklist validates software implementation only. See [Product doctrine](PRODUCT_DOCTRINE.md).

Run against the exact packaged artifact named in `RELEASE_VERDICT.md`. A session run
against any other build is void.

## Rules

- One moderator, one participant. Participant has not used Bachata before.
- Participant thinks aloud. Moderator does not teach, hint, or rescue.
- Record: task, start state, what the participant did, where they stopped, what they
  said the product was doing, and whether they finished without help.
- Record failure verbatim. Do not summarize a failure into a suggestion.
- Nothing in this file may be filled in by an agent. Every row is a human record.

## Result vocabulary

| Value | Meaning |
| --- | --- |
| `Not performed` | No session has run this task. Default. |
| `Unassisted` | Participant finished with no moderator help. |
| `Assisted` | Participant finished only after moderator help. Record the exact help. |
| `Failed` | Participant did not finish. |
| `Blocked` | Environment stopped the task before the participant could try. |

## Tasks

| # | Task | What counts as done | Result | Notes |
| --- | --- | --- | --- | --- |
| 1 | Installation to first review | From a fresh VS Code with the `.vsix` file, participant reaches a finished read-only review of a file they chose | `Not performed` | |
| 2 | Understand the run contract | Before sending, participant states in their own words what the run may read, may write, and may not do | `Not performed` | |
| 3 | Understand the outcome | After the run, participant states whether the result is accepted, rejected, or inconclusive, and why | `Not performed` | |
| 4 | Resolve a blocked state | With one provider deliberately unavailable, participant reaches a runnable state or correctly decides they cannot | `Not performed` | |
| 5 | Recheck the evidence | Participant reruns the approved checks and states which verification result is now current | `Not performed` | |
| 6 | Apply selected work | Participant applies a chosen subset of files or hunks and finds the staged change in Source Control | `Not performed` | |
| 7 | Interrupted-run recovery | After the run is interrupted, participant states what survived and either resumes or recovers the retained worktree | `Not performed` | |
| 8 | Keyboard and assistive technology | Participant completes task 1 with keyboard only, then again with the platform screen reader | `Not performed` | |
| 9 | State current direction | From top-level view only, participant states current goal, accepted core decisions, unresolved choices, and material risks without opening transcript | `Not performed` | |
| 10 | Resolve core decision | Participant compares options and evidence, records human choice, and sees item leave active decision view | `Not performed` | |
| 11 | Understand supersession | Participant identifies current decision, prior superseded decision, and material delta without duplicate confusion | `Not performed` | |
| 12 | Reopen on new evidence | Participant explains why resolved decision reopened and what evidence changed | `Not performed` | |
| 13 | Start fresh review | After correction applies, participant starts new comprehensive review against current codebase and understands it is separate refinement pass | `Not performed` | |
| 14 | Understand saturation | After two quiet fresh reviews, participant describes signal as optional stopping evidence, not proof or required stop, then can continue or close | `Not performed` | |
| 15 | Separate hypothesis from finding | Participant identifies raw Lead/Worker claims as provisional, acts only on accepted findings, and finds rejected debate in history | `Not performed` | |
| 16 | Reopen finding | Participant explains materially new evidence that reopened prior accepted or rejected finding and sees disposition delta | `Not performed` | |
| 17 | Complete the flagship loop | Without opening transcript, participant runs review, sees routine finding converge and fix proceed without per-finding ruling, inspects applied work, runs fresh review, and states what changed | `Not performed` | |
| 18 | Supervise by exception | Participant lets routine accepted finding proceed, then uses bubble to inspect or change semantic disposition; material unresolved finding still waits for judgment | `Not performed` | |
| 19 | Applied is not verified | With a fix applied but no fresh review yet, participant states that the finding is not yet verified and says what would verify it | `Not performed` | |
| 20 | Candidate drift | After a commit or an edit lands outside Bachata, participant states that the recorded checks no longer describe the current repository and rebaselines the cycle | `Not performed` | |
| 21 | Understand reconciled findings | Given two rounds describing one defect differently, participant sees automatic stable-identity merge and provenance; only ambiguous material mapping asks for judgment | `Not performed` | |
| 22 | Switch initiatives | Participant creates a second initiative for the same repository, switches between them, and states that neither shares the other's findings or decisions | `Not performed` | |
| 23 | Export and import | Participant exports an initiative, imports it in another workspace, and states that the import is a separate initiative and nothing was merged | `Not performed` | |
| 24 | Use bubble-up notifications | Participant changes notification level, reads concise unread event without transcript, and confirms fresh reviewer did not receive notification summary | `Not performed` | |

## Task 8 detail

Keyboard pass: no pointer at all. Record any control that cannot be reached, any focus
trap, and any action whose result is not announced.

Screen-reader pass: VoiceOver on macOS, NVDA on Windows, Orca on Linux. Record whether
the participant learns, by ear alone: the run status, the pending approval, the outcome,
the current verification state, and whether Apply is disabled and why.

## Recording a session

Append one block per session below. Do not overwrite the table default until a real
session produced the value.

```
Session:
Date:
Moderator:
Participant background:
Artifact hash under test:
Platform and OS version:
Assistive technology:
Task results:
Direction summary from top-level view:
Verbatim failures:
```

No session has been recorded.
