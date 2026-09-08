# Choose the next action

The Direction view names one next useful action. It is derived, not guessed:

1. state the goal, if none is recorded;
2. resolve decisions that need human judgment;
3. review regressions;
4. act on accepted findings that are still outstanding;
5. run the required checks against the current candidate;
6. run another fresh review;
7. close the cycle and choose what comes next.

Bachata reports saturation only when several consecutive fresh reviews added nothing material, every prior accepted finding is resolved or explicitly accepted, core decisions are closed, and the required checks are current.

Saturation means repeated fresh review stopped producing material findings. It is not a correctness proof.

Closing a cycle records what triggered the next one. Cycles, artifacts, decisions, and finding history persist across restarts.
