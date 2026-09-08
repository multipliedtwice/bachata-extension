# Choose a read-only pipeline

Run [Bachata: Setup](command:bachata.setup). The default journey offers three goals: **Review code**, **Plan change**, and **Fix bug**. TODO orchestration, browser providers, and custom pipelines stay behind **Advanced workflows**.

Pick **Review code**. It is read-only and writes nothing to your repository.

Setup then offers two ways to run it, and states the ready providers, the execution mode, the provider count, the iteration limit, and the verification policy for each:

- **Fast single agent** — one provider does the work.
- **Cross-checked pair** — two participants work separately and cross-check one pass.

If only one of the two is runnable, Setup tells you what the other one needs and offers to fix it. A read-only review runs a single pass, so Setup does not ask you for a completion policy.

One pass cannot prove that your code is correct. After you accept the corrections it produces, start another fresh comprehensive review against the updated codebase.

This step completes when a read-only pipeline is selected.
