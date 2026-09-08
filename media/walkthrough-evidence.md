# Read material direction

Open the **Execution** view for a finished run. It leads with the information that can change your direction:

- accepted actionable findings, after they were challenged and evidenced;
- active core decisions and their status;
- material unresolved findings or disagreements that need your judgment;
- material assumptions and new material risks;
- the minimum evidence and the affected scope;
- what changed when a decision was superseded or reopened.

Routine chatter, repeated or resolved findings, successful mechanics, and raw output stay in the drill-down history.

The initial Lead and Worker finding lists are provisional. Rejected findings and the debate behind them stay in the history, and the Lead role alone never makes a finding true.

The run result summary at the top of the Execution view also shows the evidence for the run itself:

- **Run assessment** — whether the run was accepted, rejected, or inconclusive, and how that conclusion was reached. It is not a verdict on whether the software is correct.
- **Changed scope** — how much of your repository this run touched.
- **Verification** — the current check state, and whether it came from the run or from a later recheck.
- **Remaining risk** — the unresolved risks and the evidence gaps.
- **Next action** — what Bachata recommends you do now.

Below the decision, the evidence ledger keeps the full record: the changed files with a diff for each, every controller-owned check and its status, the final ruling and which provider ruled it, unresolved risks kept separate from recovered errors, evidence gaps that state what was not proven, and the retained worktree when a run is recoverable.

Consensus and a Lead ruling coordinate one pass. They do not prove that the direction is right, and they do not remove a blind spot the participants share. Only you can correct the direction, and a later fresh review inspects the updated codebase again.

**Rerun approved checks** proves the work again. The rerun result replaces the run's verification, survives a reload and a restart, and disables **Apply** while a required check is failed, timed out, cancelled, or missing.

Use **Export run bundle** to keep the whole record outside Bachata. The export is sanitized and carries no provider conversation URL, no session identifier, and no conversation identity.

This step completes when you open the evidence of a finished run.
