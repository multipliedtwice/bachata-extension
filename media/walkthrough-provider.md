# Make one provider runnable

Bachata does not ship a model. It drives a provider you already have.

Install and sign in to Codex or Claude Code, then run [Bachata: Doctor](command:bachata.doctor).
Bachata probes Codex with an app-server handshake and Claude Code with `claude --version` in
your workspace root under a restricted environment. A CLI that exists only in an
interactive shell PATH is invisible: set `bachata.codexCommand` or `bachata.claudeCommand` to
its absolute path instead.

This step completes when a provider actually answers, not when you run a command.
