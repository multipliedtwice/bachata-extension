# Compare the round against recorded history

A single fresh review proves nothing on its own. The comparison is what carries information, and it needs at least two recorded rounds in the same review cycle.

Bachata persists every round it accepts: the initiative, the cycle, the run reference, the execution reference, whether the round was a fresh review, and the material counts it produced. Rounds are stored, not held in memory, so the comparison survives an Extension Host restart, and replaying the same execution changes nothing.

When a second round lands in the same cycle, the Direction view reports what materially changed:

- new material findings;
- repeated findings;
- resolved findings;
- regressions, where a resolved finding came back;
- findings reopened on new evidence;
- findings not observed this round, which stay open;
- accepted findings still outstanding;
- decision state changes.

Finding identity is stable across runs and does not depend on wording, so the same finding reported twice — even paraphrased — is one tracked item with two occurrences, not two bugs.

A finding with no applied fix that a review does not mention is recorded as **not observed**, not as resolved. Once a fix has been applied, non-observation by a later fresh review advances the fix lifecycle, and the view says plainly that this is model non-observation rather than a deterministic check.

This step completes when a fresh review round is compared against an earlier round of the same cycle. Opening the view does not complete it, and neither does a first round with nothing to compare against.

Saturation counts consecutive fresh rounds that added no material finding and no regression. It means repeated fresh review stopped producing material findings. It is not a correctness proof.
