# Interactions

One persisted broker handles choices, free text, checklists, human gates, permissions, secrets, provider questions, and browser handoffs.

Interaction is transport, not product priority. [Product doctrine](PRODUCT_DOCTRINE.md) requires human attention to stay on initiative direction.

## Attention routing

Bubble interaction to top-level decision view only when it contains:

- direction-changing core decision;
- unresolved disagreement needing human judgment;
- material assumption or new material risk;
- blocked choice not resolved by existing human direction.

Routine permission, successful mechanic, provider question answered from existing direction, repeated finding, and resolved revision stay in run history. Operational failure bubbles only when it blocks refinement or needs human choice.

## Bubble-up notifications

Notifications are concise, session-lived, human-only projection of typed events. Controller generates wording without LLM call. Default generation costs no model tokens.

Surface:

- bell with unread count;
- optional one-line chat or activity bubble;
- levels `off`, `decisions only`, `material`, `all`;
- events for human decision, finding convergence, material new finding, fix ready or applied, failed or stale verification, blocked provider, and reversible retained work.

No durable notification archive. No notification summary enters provider prompt or fresh reviewer context. Future external or CI renderer may show same event as concise annotation, but is not current release feature and never feeds model context.

Offer `Discard` or `Restore` only when controller owns exact reversible retained work. Otherwise offer `Inspect`.

Finding bubble may offer `Inspect`, `Reject`, `Reopen`, or `Restore disposition`. These change semantic finding state. Routine pipeline-accepted finding does not require human response before pre-authorized work continues. Material unresolved finding, direction or scope change, acceptance change, ambiguous cross-run identity, or irreversible action creates blocking human decision.

Material decision uses stable subject and scope. Repeated wording does not create new item. Materially changed evidence or recommendation supersedes current item and shows delta. Resolved item closes. Material new evidence reopens it.

## Occurrences

Every visit has an occurrence identity.

- Recovery reopens only the exact unresolved occurrence and payload.
- Revisiting the same step creates a new occurrence.
- A resolved answer is consumed once.
- A changed prompt or option set supersedes an old pending occurrence.

## Submission

- Permission and human-gate cards require exactly one valid option.
- Questions require one valid option or allowed nonempty free text.
- Secrets require nonempty input.
- Execution checklists may explicitly continue with no selected work.
- Archived runs reject interaction changes until unarchived.

The webview blocks invalid submission, disables the full card immediately after submission, and renders provider approval cards in the conversation flow. The manager repeats the same validation before resolving persisted state. Repeated interaction and approval responses are idempotent.

## Timers

SQLite stores absolute deadlines. One extension-host scheduler owns all deadlines. The webview countdown is display-only.

Editing a choice or free-text field, pressing Pause, or pressing toast Pause pauses the timer. Only Resume restarts it.

## Timeout

- Execution checklist: select nothing and interrupt before orchestration.
- Semantic question: ask configured Lead when allowed.
- Human gate: use pipeline fallback.
- Permission: use deterministic policy.
- Secret: fail or continue without it; never send it to another model.

Timeout and submit race through one atomic state transition.

## Human-gate instructions

Additional instructions are available only when a Lead exists. Submitted text is an explicit intervention addressed to Lead.

Human gate must not substitute for Lead making routine in-scope decisions. Ask human only when choice can change intent, product direction, affected scope, or acceptance and existing direction does not resolve it.

## Toasts

`Open` reveals the exact run and interaction. `Pause` pauses that exact interaction. Routing uses stored IDs, never title parsing.
