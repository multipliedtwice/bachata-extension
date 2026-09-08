# Apply the work you accepted

Retained work lives in a Git worktree. Nothing was applied to your branch and nothing was committed.

Before applying:

- read the diff for each changed file;
- read the verification state, and whether it came from the run or from a later recheck;
- rerun the approved checks if you want them proven against the current candidate.

Apply stages the work in your working tree on your current branch and creates no commit. You review it in Source Control and commit it yourself.

Bachata refuses to apply when verification is stale, failed, or cancelled. Applying an inconclusive run is an explicit override and Bachata does not treat that work as proven.

A subset of a verified run is not itself verified. When you apply a selection, Bachata reruns the run's checks against exactly the bytes you selected.
