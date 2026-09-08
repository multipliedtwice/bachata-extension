# Resolve what the review produced

Open the **Direction** view. It states the goal, the accepted direction, what materially changed in the latest round, which artifacts are accepted, which decisions need you, and which accepted findings are still outstanding. You never need to read a transcript to answer those questions.

A finding is actionable only after it was challenged by more than one participant and then accepted. That acceptance can come from the pipeline itself; it does not wait on you. Provisional and rejected claims stay in history.

A review round that reaches a ruled consensus persists that ruled finding set as a proposed `findingSet` artifact. An artifact stays proposed until you accept it; accepted artifacts are listed separately from proposed ones and from superseded revisions. A later round with a different ruled set supersedes the previous revision instead of overwriting it.

A core decision is only recorded when a pipeline produced a typed decision: a subject, the actual question, the affected scope, and evidence. Options, trade-offs, and a recommendation appear only when the pipeline supplied them. A provider error, a task blocker, or an evidence gap is operational evidence, not a decision, and never appears here.

Decisions are deduplicated by subject **and** affected scope, so the same question about two different areas stays two decisions. An identical repeat raises the occurrence count and keeps your resolution. A decision whose question, scope, options, trade-offs, recommendation, or evidence materially changed is a different decision: Bachata supersedes the old one, records what changed, and asks you again. Your earlier approval is never carried onto changed material.

Model output can propose a replacement for an accepted artifact, but it cannot revoke one. An accepted artifact stays accepted and current until you accept its replacement; only then is the earlier revision superseded.

Only the resolutions a record's current state allows are offered. A superseded record is history and offers none. A deferred decision stays in the queue. Reopen applies to a record you closed, not to one still waiting on you.

If a finding changes materially after you closed it — new or withdrawn evidence, a new challenge, a changed message, severity, or location — Bachata reopens it and keeps your earlier resolution in its history. That round is never counted as quiet.

You are asked for a resolution only where one is needed: a finding the participants left unresolved, a proposed artifact, or a core decision. An accepted finding needs no ruling from you before work starts on it. Where you do choose to resolve a record, these are the resolutions:

- **Accept** — this is real and Bachata should act on it.
- **Reject** — this is not real. It leaves the active surface and stays in history.
- **Defer** — real, but not now.
- **Supersede** — a later record replaces this one. Bachata requires an existing replacement in this initiative and refuses a record that supersedes itself.
- **Reopen** — a closed item is live again. Bachata requires both a written reason and at least one material evidence delta, and refuses the reopen without them.

Resolved items leave the active surface. Nothing is deleted.
