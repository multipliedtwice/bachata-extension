const assert = require("node:assert/strict");
const test = require("node:test");
const { createRunBundle } = require("../dist/export/runBundle.js");
const { forkPipelineDefinition } = require("../dist/pipeline/fork.js");
const {
  mergeRecheckedChecks,
  mergeRunResults,
  parseRunResult,
  projectRunResult,
  runHandoffRefusal,
} = require("../dist/results/projectResult.js");
const {
  pipelineEvidenceExpectations,
} = require("../dist/results/evidenceExpectations.js");
const {
  modelFindingsFromDecisionArtifact,
  modelFindingsFromStepOutputArtifact,
} = require("../dist/results/modelFindings.js");

test("result center labels missing evidence instead of inventing it", () => {
  const result = projectRunResult({ status: "completed", transcript: [] });
  assert.equal(result.changedFiles.length, 0);
  assert.equal(result.evidenceGaps.length, 3);
});

test("results record which provider produced the ruling", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    finalRuling: "Accepted",
    rulingBy: "claude",
    providers: [
      { name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" },
      { name: "Claude", adapter: "claude-code" },
    ],
  });
  assert.equal(result.rulingBy, "claude");
  assert.deepEqual(result.providers.map((provider) => provider.name), ["Codex", "Claude"]);
  assert.deepEqual(result.evidenceGaps, []);

  const missing = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: [],
    checks: [],
    finalRuling: "Accepted",
  });
  assert.deepEqual(missing.evidenceGaps, [
    "Expected but missing: no verification check was recorded",
    "The ruling provider was not recorded",
  ]);
});

test("only errors with recovery evidence are reported as recovered", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [
      { id: "1", kind: "error", agentId: "codex", step: "implement", text: "Adapter restart required", createdAt: "2026-01-01T00:00:00Z" },
      { id: "2", kind: "answer", agentId: "codex", step: "implement", text: "Implemented", createdAt: "2026-01-01T00:01:00Z" },
      { id: "3", kind: "error", agentId: "claude", step: "review", text: "Verification command exited with 1", createdAt: "2026-01-01T00:02:00Z" },
      { id: "4", kind: "answer", agentId: "codex", step: "implement", text: "Follow-up", createdAt: "2026-01-01T00:03:00Z" },
    ],
  });
  assert.deepEqual(result.unresolvedRisks, ["Verification command exited with 1"]);
  assert.deepEqual(result.recoveredErrors, ["Adapter restart required"]);
});

test("an unrelated later answer does not clear another unit's error", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [
      { id: "1", kind: "error", agentId: "codex", step: "implement", text: "Provider crashed", createdAt: "2026-01-01T00:00:00Z" },
      { id: "2", kind: "answer", agentId: "claude", step: "review", text: "Reviewed", createdAt: "2026-01-01T00:01:00Z" },
    ],
  });
  assert.deepEqual(result.unresolvedRisks, ["Provider crashed"]);
  assert.deepEqual(result.recoveredErrors, []);
});

test("recovery events only clear the unit they name", () => {
  const entry = (values) => ({ createdAt: "2026-01-01T00:00:00Z", ...values });
  const result = projectRunResult({
    status: "completed",
    transcript: [
      entry({ id: "1", kind: "error", agentId: "codex", step: "implement", text: "codex failed" }),
      entry({ id: "2", kind: "error", agentId: "claude", step: "review", text: "claude failed" }),
      entry({ id: "3", kind: "error", agentId: "codex", step: "verify", text: "codex verify failed" }),
      entry({ id: "4", kind: "event", eventType: "agent.recovered", agentId: "codex", step: "implement", text: "recovered" }),
    ],
  });
  assert.deepEqual(result.recoveredErrors, ["codex failed"]);
  assert.deepEqual(result.unresolvedRisks, ["claude failed", "codex verify failed"]);
});

test("run-scoped recovery clears only run-scoped errors", () => {
  const entry = (values) => ({ createdAt: "2026-01-01T00:00:00Z", ...values });
  const result = projectRunResult({
    status: "completed",
    transcript: [
      entry({ id: "1", kind: "error", text: "run interrupted" }),
      entry({ id: "2", kind: "error", agentId: "codex", step: "implement", text: "agent failed" }),
      entry({ id: "3", kind: "event", eventType: "run.resumed", text: "resumed" }),
    ],
  });
  assert.deepEqual(result.recoveredErrors, ["run interrupted"]);
  assert.deepEqual(result.unresolvedRisks, ["agent failed"]);
});

test("a provider fallback recovers only the failing provider's error", () => {
  const entry = (values) => ({ createdAt: "2026-01-01T00:00:00Z", ...values });
  const result = projectRunResult({
    status: "completed",
    transcript: [
      entry({ id: "1", kind: "error", agentId: "codex", step: "implement", text: "quota exhausted" }),
      entry({ id: "2", kind: "error", agentId: "gpt-worker", step: "implement", text: "browser refused" }),
      entry({ id: "3", kind: "event", eventType: "provider.fallback", agentId: "codex", step: "implement", text: "fell back" }),
    ],
  });
  assert.deepEqual(result.recoveredErrors, ["quota exhausted"]);
  assert.deepEqual(result.unresolvedRisks, ["browser refused"]);
});

test("merged results never classify one error as both unresolved and recovered", () => {
  const base = {
    status: "completed",
    changedFiles: [],
    checks: [],
    providers: [],
    unresolvedRisks: [],
    recoveredErrors: [],
    evidenceGaps: [],
  };

  const promoted = mergeRunResults(
    { ...base, unresolvedRisks: ["flaky provider", "still open"] },
    { ...base, recoveredErrors: ["flaky provider"] },
  );
  assert.deepEqual(promoted.recoveredErrors, ["flaky provider"]);
  assert.deepEqual(promoted.unresolvedRisks, ["still open"]);

  const demoted = mergeRunResults(
    { ...base, recoveredErrors: ["flaky provider"] },
    { ...base, unresolvedRisks: ["flaky provider"] },
  );
  assert.deepEqual(demoted.unresolvedRisks, ["flaky provider"]);
  assert.deepEqual(demoted.recoveredErrors, []);

  const disjoint = mergeRunResults(
    { ...base, unresolvedRisks: ["a"], recoveredErrors: ["b"] },
    { ...base, unresolvedRisks: ["c"], recoveredErrors: ["d"] },
  );
  assert.deepEqual(disjoint.unresolvedRisks, ["c", "a"]);
  assert.deepEqual(disjoint.recoveredErrors, ["d", "b"]);
  assert.equal(
    disjoint.unresolvedRisks.some((risk) => disjoint.recoveredErrors.includes(risk)),
    false,
  );
});

test("persisted terminal evidence merges with a thinner live projection", () => {
  const persisted = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    finalRuling: "Accepted",
    rulingBy: "claude",
    providers: [{ name: "Claude", adapter: "claude-code" }],
    retainedWorktree: "/runs/task-1",
  });
  const live = projectRunResult({
    status: "completed",
    transcript: [
      { id: "1", kind: "error", agentId: "codex", step: "implement", text: "Late failure", createdAt: "2026-01-01T00:00:00Z" },
    ],
  });

  const merged = mergeRunResults(persisted, live);
  assert.deepEqual(merged.changedFiles, ["src/a.ts"]);
  assert.deepEqual(merged.checks, [{ command: "bachata:project-checks", status: "passed" }]);
  assert.equal(merged.finalRuling, "Accepted");
  assert.equal(merged.rulingBy, "claude");
  assert.equal(merged.retainedWorktree, "/runs/task-1");
  assert.deepEqual(merged.providers.map((provider) => provider.name), ["Claude"]);
  assert.deepEqual(merged.unresolvedRisks, ["Late failure"]);
  assert.deepEqual(merged.evidenceGaps, []);
});

test("run bundle is deterministic, redacted, and bounded", () => {
  const input = { z: "ok", a: "Authorization: Bearer secret-value", missing: undefined };
  const first = createRunBundle(input, "2026-01-01T00:00:00Z");
  assert.equal(first, createRunBundle(input, "2026-01-01T00:00:00Z"));
  assert.doesNotMatch(first, /secret-value/u);
  assert.match(first, /"missing": null/u);
  assert.throws(() => createRunBundle(input, "2026-01-01T00:00:00Z", 10), /exceeds/u);
});

test("run bundle removes provider-prefixed catalog identity fields", () => {
  const bundle = JSON.parse(createRunBundle({
    chats: [{
      chatRef: "C1",
      agentId: "chatgpt",
      provider: "chatgpt",
      adapter: "chatgpt-browser",
      providerSessionId: "provider-session-7f21",
      providerConversationUrl: "https://chatgpt.com/c/1f0c2a44",
      providerConversationIdentity: "chatgpt:1f0c2a44",
      providerMessageCursor: "cursor-91",
      displayTitle: "Managed worker",
      status: "active",
    }],
    sessions: [{ documentToken: "document-token-1", tabId: 12, frameId: 0 }],
  }, "2026-01-01T00:00:00Z"));
  const chat = bundle.run.chats[0];
  assert.equal(chat.providerSessionId, "[EXCLUDED]");
  assert.equal(chat.providerConversationUrl, "[EXCLUDED]");
  assert.equal(chat.providerConversationIdentity, "[EXCLUDED]");
  assert.equal(chat.providerMessageCursor, "[EXCLUDED]");
  assert.equal(chat.displayTitle, "Managed worker");
  assert.equal(bundle.run.sessions[0].documentToken, "[EXCLUDED]");
  assert.equal(bundle.run.sessions[0].tabId, "[EXCLUDED]");
  assert.doesNotMatch(JSON.stringify(bundle), /provider-session-7f21|1f0c2a44|cursor-91|document-token-1/u);
});

test("run bundle sanitizes identity across every bundle section", () => {
  const bundle = JSON.parse(createRunBundle({
    schema: "bachata.run-bundle.v1",
    run: { runRef: "R1", workingDirectory: "/work" },
    transcript: [{
      id: "e1",
      kind: "event",
      eventType: "browser.session.selected",
      text: "bound to https://claude.ai/chat/aaaa-bbbb",
      data: { sessionId: "transcript-session", conversationIdentity: "claude:aaaa-bbbb" },
    }],
    events: [{
      id: 1,
      type: "browser.session.selected",
      payload: { providerSessionId: "event-session", providerConversationUrl: "https://claude.ai/chat/aaaa-bbbb" },
    }],
    structuredOutputs: [{
      stepId: "review",
      value: { citation: "https://claude.ai/chat/aaaa-bbbb", providerConversationIdentity: "claude:aaaa-bbbb" },
    }],
    interactions: [{
      interactionRef: "I1",
      context: { providerSessionId: "interaction-session", title: "Approve" },
    }],
    chats: [{ chatRef: "C1", providerMessageCursor: "cursor-1", displayTitle: "Worker" }],
    futureSection: [{ nested: { providerSessionId: "future-session", documentToken: "tok-1" } }],
  }, "2026-01-01T00:00:00Z"));

  const serialized = JSON.stringify(bundle);
  for (const secret of [
    "transcript-session",
    "event-session",
    "interaction-session",
    "future-session",
    "cursor-1",
    "tok-1",
    "aaaa-bbbb",
    "claude:aaaa-bbbb",
  ]) {
    assert.equal(serialized.includes(secret), false, `${secret} survived export`);
  }
  assert.equal(bundle.run.events[0].payload.providerSessionId, "[EXCLUDED]");
  assert.equal(bundle.run.interactions[0].context.providerSessionId, "[EXCLUDED]");
  assert.equal(bundle.run.interactions[0].context.title, "Approve");
  assert.equal(bundle.run.futureSection[0].nested.providerSessionId, "[EXCLUDED]");
  assert.equal(bundle.run.structuredOutputs[0].value.citation, "https://claude.ai/[REDACTED]");
  assert.equal(bundle.run.chats[0].displayTitle, "Worker");
});

test("run bundle removes provider session identity and conversation locators", () => {
  const input = {
    transcript: [{
      text: "bound to https://claude.ai/chat/8b1d2c33-aaaa-bbbb-cccc-ddddeeeeffff?tab=1",
      data: {
        sessionId: "sess-123",
        finalSessionId: "sess-456",
        conversationUrl: "https://claude.ai/chat/8b1d2c33-aaaa-bbbb-cccc-ddddeeeeffff",
        conversationIdentity: "claude:8b1d2c33-aaaa-bbbb-cccc-ddddeeeeffff",
        preferredTabId: 42,
        requestId: "request-1",
      },
    }],
  };
  const bundle = JSON.parse(createRunBundle(input, "2026-01-01T00:00:00Z"));
  const entry = bundle.run.transcript[0];
  assert.equal(entry.text, "bound to https://claude.ai/[REDACTED]");
  assert.equal(entry.data.sessionId, "[EXCLUDED]");
  assert.equal(entry.data.finalSessionId, "[EXCLUDED]");
  assert.equal(entry.data.conversationUrl, "[EXCLUDED]");
  assert.equal(entry.data.conversationIdentity, "[EXCLUDED]");
  assert.equal(entry.data.preferredTabId, "[EXCLUDED]");
  assert.equal(entry.data.requestId, "request-1");
});

test("pipeline fork keeps source immutable and assigns explicit identity", () => {
  const source = { version: 1, id: "source", name: "Source", agents: [], steps: [] };
  const fork = forkPipelineDefinition(source, "fork", "Fork");
  assert.equal(fork.id, "fork");
  assert.equal(source.id, "source");
});

test("a run handoff is refused unless the displayed result owns that exact run", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: ["src/a.ts"],
    retainedWorktree: "/work/.bachata/runs/run-a/integration",
    retainedRunId: "run-a",
  });
  assert.equal(result.retainedRunId, "run-a");
  assert.equal(runHandoffRefusal(result, "run-a"), undefined);
  assert.match(runHandoffRefusal(result, "run-b"), /belongs to run-a, not run-b/u);
  assert.match(
    runHandoffRefusal(undefined, "run-a"),
    /not bound to a retained orchestration run/u,
  );

  const unbound = projectRunResult({
    status: "completed",
    transcript: [],
    retainedWorktree: "/work/.bachata/runs/run-a/integration",
  });
  assert.equal(unbound.retainedRunId, undefined);
  assert.match(runHandoffRefusal(unbound, "run-a"), /not bound/u);
});

test("a persisted run keeps its own run binding when merged with a later projection", () => {
  const persisted = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: ["src/a.ts"],
    retainedWorktree: "/work/.bachata/runs/run-a/integration",
    retainedRunId: "run-a",
  });
  const live = projectRunResult({ status: "idle", transcript: [] });
  assert.equal(mergeRunResults(persisted, live).retainedRunId, "run-a");
});

const readOnlyExpectations = { changedFiles: false, verification: false, finalRuling: false };

test("a read-only review reports contract-aware evidence, never three gaps", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    expectations: readOnlyExpectations,
  });
  assert.deepEqual(result.evidenceGaps, []);
  assert.deepEqual(
    result.evidence.map((entry) => [entry.kind, entry.state]),
    [
      ["changedFiles", "notApplicable"],
      ["verification", "notApplicable"],
      ["finalRuling", "notApplicable"],
      ["rulingProvenance", "notApplicable"],
    ],
  );
});

test("expected-but-missing evidence stays a gap when the contract promises it", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  assert.deepEqual(
    result.evidence.filter((entry) => entry.state === "missing").map((entry) => entry.kind),
    ["changedFiles", "verification", "finalRuling"],
  );
  assert.equal(result.evidenceGaps.length, 3);
});

test("every run carries a typed final assessment with provider provenance", () => {
  const providers = [{ name: "Codex", adapter: "codex-app-server" }];
  const completed = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    expectations: readOnlyExpectations,
  });
  assert.equal(completed.finalAssessment.outcome, "completed");
  assert.equal(completed.finalAssessment.method, "singleProvider");
  assert.deepEqual(completed.finalAssessment.producedBy, providers);

  const verificationFailed = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    checks: [{ command: "bachata:project-checks", status: "failed" }],
    changedFiles: ["src/a.ts"],
    expectations: { changedFiles: true, verification: true, finalRuling: false },
  });
  assert.equal(verificationFailed.finalAssessment.outcome, "verificationFailed");
  assert.equal(verificationFailed.finalAssessment.method, "controller");

  const inconclusive = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    unresolvedRisks: ["Cancellation path is unproven"],
    expectations: readOnlyExpectations,
  });
  assert.equal(inconclusive.finalAssessment.outcome, "inconclusive");

  const ruledByOneProvider = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Accepted",
    rulingBy: "claude",
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  assert.equal(ruledByOneProvider.finalAssessment.method, "controller");
  assert.equal(ruledByOneProvider.finalAssessment.outcome, "completed");
});

test("consensus requires an explicit multi-provider consensus ruling", () => {
  const providers = [
    { name: "Codex", adapter: "codex-app-server" },
    { name: "Claude", adapter: "claude-code" },
  ];
  const consensus = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Models aligned",
    rulingBy: "claude",
    consensusRuling: true,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(consensus.finalAssessment.outcome, "completed");
  assert.equal(consensus.finalAssessment.method, "consensus");

  const verifiedConsensus = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    finalRuling: "Models aligned",
    rulingBy: "claude",
    consensusRuling: true,
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  assert.equal(verifiedConsensus.finalAssessment.outcome, "completed");
  assert.equal(verifiedConsensus.finalAssessment.method, "controller");
});

test("a later execution never inherits the previous execution's evidence", () => {
  const first = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E1",
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    finalRuling: "Accepted",
    rulingBy: "claude",
    unresolvedRisks: ["Left-over risk"],
    retainedWorktree: "/tmp/wt-1",
    retainedRunId: "run-1",
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  const second = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E2",
    changedFiles: [],
    checks: [],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  const merged = mergeRunResults(first, second);
  assert.equal(merged.executionRef, "E2");
  assert.deepEqual(merged.changedFiles, []);
  assert.deepEqual(merged.checks, []);
  assert.equal(merged.finalRuling, undefined);
  assert.equal(merged.rulingBy, undefined);
  assert.deepEqual(merged.unresolvedRisks, []);
  assert.equal(merged.retainedWorktree, undefined);
  assert.equal(merged.retainedRunId, undefined);
  assert.deepEqual(merged.evidenceGaps, [
    "Expected but missing: no verification check was recorded",
    "No final ruling was recorded",
  ]);
});

test("the same execution still merges persisted evidence with a thinner projection", () => {
  const persisted = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E7",
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    expectations: { changedFiles: true, verification: true, finalRuling: false },
  });
  const live = projectRunResult({
    status: "idle",
    transcript: [],
    executionRef: "E7",
    expectations: { changedFiles: true, verification: true, finalRuling: false },
  });
  const merged = mergeRunResults(persisted, live);
  assert.deepEqual(merged.changedFiles, ["src/a.ts"]);
  assert.equal(merged.checks.length, 1);
});

test("evidence expectations are read from the pipeline, not guessed", () => {
  const review = pipelineEvidenceExpectations({
    version: 1,
    id: "review-only",
    name: "Review only",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" }],
    steps: [{
      id: "review",
      name: "Review",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
    }],
  });
  assert.deepEqual(review, { changedFiles: false, verification: false, finalRuling: false });

  const managed = pipelineEvidenceExpectations({
    version: 1,
    id: "managed-fix",
    name: "Managed fix",
    managedPolicy: {
      writeScope: "configured",
      commitMode: "never",
      verificationChecks: [{ id: "checks", command: "bachata:project-checks" }],
    },
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
    roles: [{ id: "worker", name: "Worker", instructions: "", managed: true }],
    steps: [{
      id: "fix",
      name: "Fix",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["worker"],
      promptTemplate: "x",
      parallel: false,
      consensus: false,
    }],
  });
  assert.deepEqual(managed, { changedFiles: true, verification: true, finalRuling: false });

  assert.deepEqual(
    pipelineEvidenceExpectations(undefined),
    { changedFiles: true, verification: true, finalRuling: true },
  );
});

const verifiedExpectations = { changedFiles: true, verification: true, finalRuling: false };

const verifiedRun = (values) => projectRunResult({
  status: "completed",
  transcript: [],
  providers: [{ name: "Codex", adapter: "codex-app-server" }],
  changedFiles: ["src/a.ts"],
  expectations: verifiedExpectations,
  ...values,
});

test("expected verification that recorded nothing is a gap, never Recorded: 0 checks", () => {
  const result = verifiedRun({ checks: [] });
  const verification = result.evidence.find((item) => item.kind === "verification");
  assert.equal(verification.state, "missing");
  assert.match(verification.detail, /^Expected but missing/u);
  assert.equal(verification.detail.includes("0 check"), false);
  assert.equal(result.evidenceGaps.includes(verification.detail), true);
});

test("expected but missing verification never produces completed", () => {
  const missing = verifiedRun({ checks: [] });
  assert.equal(missing.finalAssessment.outcome, "inconclusive");

  const unrecorded = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    changedFiles: ["src/a.ts"],
    expectations: verifiedExpectations,
  });
  assert.equal(unrecorded.finalAssessment.outcome, "inconclusive");
});

test("cancelled verification is inconclusive and failed or timed-out verification fails", () => {
  const cancelled = verifiedRun({
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:tests", status: "cancelled" },
    ],
  });
  assert.equal(cancelled.finalAssessment.outcome, "inconclusive");
  assert.equal(cancelled.finalAssessment.method, "controller");
  assert.match(cancelled.finalAssessment.summary, /cancelled: bachata:tests/u);

  for (const status of ["failed", "timedOut"]) {
    const failed = verifiedRun({
      checks: [
        { command: "bachata:project-checks", status: "passed" },
        { command: "bachata:tests", status },
      ],
    });
    assert.equal(failed.finalAssessment.outcome, "verificationFailed");
    assert.equal(failed.finalAssessment.method, "controller");
  }
});

test("a failed check outranks a cancelled check", () => {
  const result = verifiedRun({
    checks: [
      { command: "bachata:tests", status: "cancelled" },
      { command: "bachata:project-checks", status: "failed" },
    ],
  });
  assert.equal(result.finalAssessment.outcome, "verificationFailed");
});

test("completed requires every recorded check to pass and no remaining evidence gap", () => {
  const completed = verifiedRun({
    checks: [{ command: "bachata:project-checks", status: "passed" }],
  });
  assert.equal(completed.finalAssessment.outcome, "completed");
  assert.deepEqual(completed.evidenceGaps, []);

  const gapped = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    expectations: verifiedExpectations,
  });
  assert.equal(gapped.evidenceGaps.length, 1);
  assert.equal(gapped.finalAssessment.outcome, "inconclusive");
  assert.match(gapped.finalAssessment.summary, /Required evidence is missing/u);
});

test("a failed recheck never leaves a merged run completed", () => {
  const passing = verifiedRun({
    executionRef: "E1",
    checks: [{ command: "bachata:project-checks", status: "passed" }],
  });
  assert.equal(passing.finalAssessment.outcome, "completed");

  const recheck = verifiedRun({
    executionRef: "E1",
    checks: [{ command: "bachata:project-checks", status: "failed" }],
  });
  const merged = mergeRunResults(passing, recheck);
  assert.deepEqual(merged.checks, [{ command: "bachata:project-checks", status: "failed" }]);
  assert.equal(merged.finalAssessment.outcome, "verificationFailed");
});

test("a run that has not completed has no completed assessment", () => {
  for (const status of ["interrupted", "error", "paused"]) {
    const result = verifiedRun({
      status,
      checks: [{ command: "bachata:project-checks", status: "passed" }],
    });
    assert.equal(result.finalAssessment.outcome, "inconclusive");
  }
  for (const status of ["idle", "running"]) {
    const result = verifiedRun({
      status,
      checks: [{ command: "bachata:project-checks", status: "passed" }],
    });
    assert.equal(result.finalAssessment.outcome, "notApplicable");
  }
});

test("an inconclusive run needs an explicit override, and a blocked run needs a fix first", () => {
  const completed = verifiedRun({
    checks: [{ command: "bachata:project-checks", status: "passed" }],
  });
  assert.equal(completed.finalAssessment.outcome, "completed");
  assert.equal(completed.applyBlockedReason, undefined);
  assert.equal(completed.applyOverrideReason, undefined);

  const risky = verifiedRun({
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    unresolvedRisks: ["Cancellation path is unproven"],
  });
  assert.equal(risky.finalAssessment.outcome, "inconclusive");
  assert.equal(risky.applyBlockedReason, undefined);
  assert.match(risky.applyOverrideReason, /unresolved risk/u);

  const gapped = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    expectations: verifiedExpectations,
  });
  assert.equal(gapped.finalAssessment.outcome, "inconclusive");
  assert.match(gapped.applyOverrideReason, /Required evidence is missing/u);

  const missingRuling = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  assert.match(missingRuling.applyOverrideReason, /no final ruling was recorded/u);

  const blocked = verifiedRun({
    checks: [{ command: "bachata:project-checks", status: "failed" }],
  });
  assert.match(blocked.applyBlockedReason, /Verification did not pass/u);
  assert.equal(
    blocked.applyOverrideReason,
    undefined,
    "a hard-blocked run must not offer an override",
  );

  const interrupted = verifiedRun({
    status: "interrupted",
    checks: [{ command: "bachata:project-checks", status: "passed" }],
  });
  assert.equal(interrupted.applyBlockedReason, undefined);
  assert.match(interrupted.applyOverrideReason, /interrupted/u);
});

test("apply state survives persistence and merge", () => {
  const risky = verifiedRun({
    executionRef: "E9",
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    unresolvedRisks: ["Cancellation path is unproven"],
  });
  const reloaded = JSON.parse(JSON.stringify(risky));
  const merged = mergeRunResults(risky, verifiedRun({
    executionRef: "E9",
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    unresolvedRisks: ["Cancellation path is unproven"],
  }));
  assert.match(merged.applyOverrideReason, /unresolved risk/u);
  assert.equal(reloaded.applyOverrideReason, risky.applyOverrideReason);
});

test("a recheck merges into the recorded evidence instead of replacing it", () => {
  const merged = mergeRecheckedChecks(
    [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:workspace-integrity", status: "passed" },
    ],
    [{ command: "bachata:project-checks", status: "passed" }],
  );
  assert.deepEqual(merged, [
    { command: "bachata:project-checks", status: "passed" },
    { command: "bachata:workspace-integrity", status: "passed", stale: true },
  ]);
});

test("a recheck that covers every recorded command leaves nothing stale", () => {
  const commands = ["bachata:project-checks", "bachata:workspace-integrity"];
  const merged = mergeRecheckedChecks(
    commands.map((command) => ({ command, status: "passed" })),
    commands.map((command) => ({ command, status: "passed" })),
  );
  assert.equal(merged.some((check) => check.stale === true), false);
});

test("stale verification blocks Apply and is never a passing final assessment", () => {
  const stale = verifiedRun({
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:workspace-integrity", status: "passed", stale: true },
    ],
  });
  assert.match(stale.applyBlockedReason, /stale and was not re-run/u);
  assert.match(stale.applyBlockedReason, /bachata:workspace-integrity/u);
  assert.equal(stale.finalAssessment.outcome, "inconclusive");

  const fresh = verifiedRun({
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:workspace-integrity", status: "passed" },
    ],
  });
  assert.equal(fresh.applyBlockedReason, undefined);
  assert.equal(fresh.finalAssessment.outcome, "completed");
});

test("verification evidence that is entirely stale is reported as missing", () => {
  const result = verifiedRun({
    checks: [{ command: "bachata:project-checks", status: "passed", stale: true }],
  });
  const verification = result.evidence.find((item) => item.kind === "verification");
  assert.equal(verification.state, "missing");
  assert.match(verification.detail, /predates the current candidate/u);
});

test("a partially stale ledger says how many checks were not re-run", () => {
  const result = verifiedRun({
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:workspace-integrity", status: "passed", stale: true },
    ],
  });
  const verification = result.evidence.find((item) => item.kind === "verification");
  assert.equal(verification.state, "recorded");
  assert.match(verification.detail, /1 of them not re-run against the current candidate/u);
});

test("typed finding dispositions survive parse and merge without escalation or duplication", () => {
  const finding = {
    id: "finding-stable",
    subject: "Cancellation guard",
    message: "Guard is missing",
    disposition: "accepted",
    severity: "warning",
    location: { file: "src/a.ts", startLine: 9 },
    evidence: ["Both reviewers traced the missing branch"],
    challenges: ["Existing cleanup was inspected"],
    provenance: {
      source: "pipelineDecision",
      stepId: "review-consensus",
      participantIds: ["codex", "claude"],
      decisionStatus: "accepted",
    },
  };
  const first = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E12",
    findings: [finding],
    providers: [
      { name: "Codex", adapter: "codex-app-server" },
      { name: "Claude", adapter: "claude-code" },
    ],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
  });
  const restored = parseRunResult(JSON.parse(JSON.stringify(first)));
  assert.equal(restored.findings[0].disposition, "accepted");
  const merged = mergeRunResults(restored, projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E12",
    findings: [{ ...finding, message: "Guard is still missing" }],
    providers: first.providers,
    expectations: first.expectations,
  }));
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.findings[0].message, "Guard is still missing");
});

test("invalid dispositions fail closed and a single model cannot assign terminal dispositions", () => {
  const base = {
    subject: "Possible leak",
    message: "A resource may leak",
    evidence: ["One trace suggests a leak"],
    challenges: ["Cleanup behavior was checked"],
    provenance: {
      source: "stepOutput",
      stepId: "review",
      participantIds: ["codex"],
    },
  };
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    findings: [
      { ...base, id: "single-accepted", disposition: "accepted" },
      { ...base, id: "single-rejected", disposition: "rejected" },
      { ...base, id: "single-unresolved", disposition: "unresolved" },
      { ...base, id: "unknown", disposition: "approved" },
    ],
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
  });
  assert.deepEqual(result.findings.map((finding) => finding.disposition), [
    "proposed",
    "proposed",
    "proposed",
  ]);
});

test("typed pipeline artifacts project findings without trusting model-written provenance", () => {
  const candidate = {
    findings: [{
      id: "artifact-finding",
      subject: "Retry bound",
      message: "Retry count is off by one",
      disposition: "accepted",
      evidence: ["Both traces reach one extra retry"],
      challenges: ["Zero-retry behavior was checked"],
      provenance: { source: "stepOutput", stepId: "invented", participantIds: ["invented"] },
    }],
  };
  const decision = modelFindingsFromDecisionArtifact({
    stepId: "converge",
    status: "accepted",
    candidate,
    participants: [{ agentId: "codex" }, { agentId: "claude" }],
  });
  assert.equal(decision[0].disposition, "accepted");
  assert.deepEqual(decision[0].provenance.participantIds, ["codex", "claude"]);
  assert.equal(decision[0].provenance.stepId, "converge");

  const unchallenged = modelFindingsFromDecisionArtifact({
    stepId: "converge",
    status: "accepted",
    candidate: {
      findings: [{
        ...candidate.findings[0],
        id: "unchallenged-finding",
        challenges: [],
      }],
    },
    participants: [{ agentId: "codex" }, { agentId: "claude" }],
  });
  assert.equal(unchallenged[0].disposition, "proposed");

  const single = modelFindingsFromStepOutputArtifact({
    stepId: "review",
    agentId: "codex",
    value: candidate,
  });
  assert.equal(single[0].disposition, "proposed");
  assert.equal(single[0].provenance.source, "stepOutput");
});

test("terminal dispositions require a challenged multi-participant decision", () => {
  const terminalFindings = ["accepted", "rejected", "unresolved"].map((disposition) => ({
    id: `terminal-${disposition}`,
    subject: `Terminal ${disposition}`,
    message: `The claim is ${disposition}`,
    disposition,
    evidence: ["Repository evidence was inspected"],
    challenges: ["A peer challenged the claim"],
  }));
  const decision = (participants, findings = terminalFindings) => modelFindingsFromDecisionArtifact({
    stepId: "converge",
    status: "accepted",
    candidate: { findings },
    participants: participants.map((agentId) => ({ agentId })),
  });

  assert.deepEqual(
    decision(["codex", "claude"]).map((finding) => finding.disposition),
    ["accepted", "rejected", "unresolved"],
  );
  assert.deepEqual(
    decision(["codex"]).map((finding) => finding.disposition),
    ["proposed", "proposed", "proposed"],
  );
  assert.deepEqual(
    decision(["codex", "claude"], terminalFindings.map((finding) => ({
      ...finding,
      id: `empty-${finding.disposition}`,
      evidence: [],
      challenges: [],
    }))).map((finding) => finding.disposition),
    ["proposed", "proposed", "proposed"],
  );
});

test("an unresolved typed finding makes the run inconclusive without becoming accepted", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    findings: [{
      id: "needs-human",
      subject: "Product behavior",
      message: "Two behaviors remain viable",
      disposition: "unresolved",
      evidence: ["Both options satisfy current checks"],
      challenges: ["No existing direction selects one"],
      provenance: {
        source: "pipelineDecision",
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        decisionStatus: "accepted",
      },
    }],
    providers: [
      { name: "Codex", adapter: "codex-app-server" },
      { name: "Claude", adapter: "claude-code" },
    ],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
  });
  assert.equal(result.finalAssessment.outcome, "inconclusive");
  assert.match(result.finalAssessment.summary, /needs human resolution/u);
});

// EX-AUD-12. The run-patch merge, characterized. `mergeRunResults(persisted, live)` folds a live
// projection onto what was stored, and the question at every field is which side owns it. These
// are the rules the manager depends on, and none of them was pinned before.

const mergeBase = {
  status: "completed",
  changedFiles: [],
  checks: [],
  providers: [],
  findings: [],
  unresolvedRisks: [],
  recoveredErrors: [],
  evidenceGaps: [],
};

test("a patch for another execution replaces what was stored rather than merging into it", () => {
  // Two different executions have nothing to say about each other. Merging them would attribute
  // one run's checks to another run's changed files, which is the worst possible evidence.
  const merged = mergeRunResults(
    { ...mergeBase, executionRef: "run-1", changedFiles: ["src/a.ts"], finalRuling: "Accepted" },
    { ...mergeBase, executionRef: "run-2" },
  );
  assert.equal(merged.executionRef, "run-2");
  assert.deepEqual(merged.changedFiles, []);
  assert.equal(merged.finalRuling, undefined, "an older run's ruling survived onto a new run");
});

test("a patch that names no execution is folded in rather than treated as another run", () => {
  const merged = mergeRunResults(
    { ...mergeBase, executionRef: "run-1", changedFiles: ["src/a.ts"] },
    { ...mergeBase },
  );
  assert.equal(merged.executionRef, "run-1");
  assert.deepEqual(merged.changedFiles, ["src/a.ts"]);
});

test("a field the patch does not carry keeps what was stored", () => {
  const merged = mergeRunResults(
    {
      ...mergeBase,
      changedFiles: ["src/a.ts"],
      checks: [{ command: "bachata:project-checks", status: "passed" }],
      providers: [{ name: "Claude", adapter: "claude-code" }],
      finalRuling: "Accepted",
      retainedWorktree: "/runs/task-1",
      retainedRunId: "retained-1",
    },
    { ...mergeBase },
  );
  assert.deepEqual(merged.changedFiles, ["src/a.ts"]);
  assert.equal(merged.checks.length, 1);
  assert.equal(merged.finalRuling, "Accepted");
  assert.equal(merged.retainedWorktree, "/runs/task-1");
  assert.equal(merged.retainedRunId, "retained-1");
  assert.deepEqual(merged.providers.map((provider) => provider.name), ["Claude"]);
});

test("a field the patch does carry replaces what was stored", () => {
  const merged = mergeRunResults(
    { ...mergeBase, changedFiles: ["src/old.ts"], finalRuling: "Rejected", retainedWorktree: "/runs/old" },
    { ...mergeBase, changedFiles: ["src/new.ts"], finalRuling: "Accepted", retainedWorktree: "/runs/new" },
  );
  assert.deepEqual(merged.changedFiles, ["src/new.ts"]);
  assert.equal(merged.finalRuling, "Accepted");
  assert.equal(merged.retainedWorktree, "/runs/new");
});

test("checks and their provenance move together, so a ruling never cites the wrong run's checks", () => {
  const merged = mergeRunResults(
    {
      ...mergeBase,
      checks: [{ command: "old", status: "passed" }],
      verificationProvenance: { source: "persisted" },
    },
    {
      ...mergeBase,
      checks: [{ command: "new", status: "failed" }],
      verificationProvenance: { source: "live" },
    },
  );
  assert.deepEqual(merged.checks.map((check) => check.command), ["new"]);
  assert.deepEqual(merged.verificationProvenance, { source: "live" });

  const kept = mergeRunResults(
    {
      ...mergeBase,
      checks: [{ command: "old", status: "passed" }],
      verificationProvenance: { source: "persisted" },
    },
    { ...mergeBase, verificationProvenance: { source: "live" } },
  );
  assert.deepEqual(kept.checks.map((check) => check.command), ["old"]);
  assert.deepEqual(
    kept.verificationProvenance,
    { source: "persisted" },
    "checks stayed with the stored run but their provenance came from the patch",
  );
});

test("a ruling brings its own attribution, never the stored run's", () => {
  const merged = mergeRunResults(
    { ...mergeBase, finalRuling: "Rejected", rulingBy: "claude" },
    { ...mergeBase, finalRuling: "Accepted", rulingBy: "codex" },
  );
  assert.equal(merged.finalRuling, "Accepted");
  assert.equal(merged.rulingBy, "codex", "a new ruling kept the old run's author");

  const kept = mergeRunResults(
    { ...mergeBase, finalRuling: "Rejected", rulingBy: "claude" },
    { ...mergeBase, rulingBy: "codex" },
  );
  assert.equal(kept.finalRuling, "Rejected");
  assert.equal(kept.rulingBy, "claude", "a stored ruling was reattributed to whoever patched it");
});

test("an idle patch does not overwrite a status the stored run had reached", () => {
  // A projection with nothing in it reports idle. Letting that overwrite a finished run would
  // walk a completed run backwards every time a thin projection arrived.
  assert.equal(
    mergeRunResults({ ...mergeBase, status: "completed" }, { ...mergeBase, status: "idle" }).status,
    "completed",
  );
  assert.equal(
    mergeRunResults({ ...mergeBase, status: "completed" }, { ...mergeBase, status: "error" }).status,
    "error",
  );
});

test("retained output is never dropped by a patch that does not mention it", () => {
  // What the retained worktree holds is the only copy of the run's output before Apply, so a
  // thin projection must not be able to forget where it is.
  const merged = mergeRunResults(
    { ...mergeBase, retainedWorktree: "/runs/task-1", retainedRunId: "retained-1" },
    { ...mergeBase },
  );
  assert.equal(merged.retainedWorktree, "/runs/task-1");
  assert.equal(merged.retainedRunId, "retained-1");
});

test("a run with no retained output does not grow an empty one", () => {
  const merged = mergeRunResults({ ...mergeBase }, { ...mergeBase });
  assert.equal("retainedWorktree" in merged, false);
  assert.equal("retainedRunId" in merged, false);
  assert.equal("executionRef" in merged, false);
});

test("a legacy consensus flag survives a patch, until provenance says otherwise", () => {
  // Older runs recorded consensus as a bare flag with no provenance behind it. That flag is
  // carried forward rather than silently dropped, because dropping it would rewrite a recorded
  // ruling as never having been unanimous.
  assert.equal(
    mergeRunResults({ ...mergeBase, consensusRuling: true }, { ...mergeBase }).consensusRuling,
    true,
  );
  // Once either side carries provenance, provenance decides and the flag stops mattering.
  assert.equal(
    mergeRunResults(
      { ...mergeBase, consensusRuling: true },
      { ...mergeBase, finalRuling: "Accepted", rulingProvenance: { kind: "singleProvider", participants: [] } },
    ).consensusRuling,
    undefined,
    "a bare flag outvoted the provenance that superseded it",
  );
  assert.equal(
    mergeRunResults(
      { ...mergeBase },
      { ...mergeBase, finalRuling: "Accepted", rulingProvenance: { kind: "unanimousConsensus", participants: [] } },
    ).consensusRuling,
    true,
  );
});
