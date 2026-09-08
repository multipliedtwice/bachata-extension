# Fix an actionable finding

A read-only review produces no work to apply. A fix run is what produces the change.

A finding becomes actionable when the pipeline accepted it and more than one participant took part in challenging it. That happens without you: Bachata does not ask you to re-accept work two participants already argued over and agreed on. You supervise by exception, not by ruling on every finding.

In the **Direction** view, a finding reaches you in one of two ways:

- **Waiting on your ruling** — the participants did not converge. The finding is unresolved, more than one participant challenged it, and no rule can settle it for you.
- **Accepted, still needs a fix** — the pipeline accepted it, or you did. It stays here until a later fresh review no longer observes it.

You can still reject, defer, reopen, or supersede any finding. Doing so records your resolution and overrides the pipeline's. What you never have to do is confirm a finding the pipeline already accepted before work can start on it.

Select **Fix this finding**, or run the next action while an accepted finding is outstanding. Bachata opens a new conversation with a write-capable pipeline and a prompt scoped to that one finding: its subject, its message, its location, the evidence recorded for it, and the challenges raised against it. The prompt states that the finding was already accepted and names what accepted it, so the fix run does not re-argue whether it is real.

Bachata chooses the fix pipeline in this order: the pipeline named by `bachata.fixPipelineId`, then the pipeline selected in the source conversation, then the built-in `managed-fix`. A read-only pipeline is refused, because it cannot implement anything.

The fix run is bound to the current cycle and linked to the finding. The finding's state follows the work:

- `awaitingFix` — it is actionable and no fix has started.
- `fixRunning` — a bounded fix run is open for it.
- `fixApplied` — the run's work was applied to your branch. This is not proof.
- `verified` — internal lifecycle state for a later fresh review that no longer observed it;
  the UI labels this as model non-observation, not a deterministic check.

The last state records fresh-review evidence, not controller verification. An applied fix
stays unverified until a fresh review against the current repository state stops reporting
the finding.

If the review produced nothing to fix, this step is already done.
