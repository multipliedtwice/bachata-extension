# Run a fresh review

A fresh review starts an independent review against the current repository state. Bachata opens a new run for it, resets provider sessions exactly once, and executes through the same preflight, ownership, and verification path as any other run.

A fresh review only runs a pipeline that satisfies the review contract:

- every enabled step is read-only and no step executes a checklist;
- some enabled step actually produces review findings — a `proposedModelFindingSet` typed output, or a consensus step whose accepted candidate is a `ruledModelFindingSet`.

The second rule matters as much as the first. A planning or decision pipeline is read-only but reports no findings, so its rounds would add nothing material and two of them would falsely read as saturation. Bachata refuses those by name.

If the selected pipeline does not qualify, Bachata refuses and says why. Set `bachata.freshReviewPipelineId` to a qualifying pipeline to have Bachata use that one instead. Bachata never substitutes a pipeline on its own, and never launches implementation or checklist authority through a fresh review.

The pipeline is resolved against the current catalog, validated once, and then that exact immutable snapshot is what executes. If the pipeline changes between validation and execution, Bachata refuses the run rather than executing authority it did not check.

- The initiative goal, scope, and constraints are preserved.
- No prior confidence and no prior conclusion is carried into the provider prompts. Provider sessions are reset first.
- Prior findings stay available for comparison after the review, never before it.

This step is done as soon as the round is recorded. Repeated fresh reviews stay rounds of the same review cycle, and reading one round against the rounds before it is the next step.
