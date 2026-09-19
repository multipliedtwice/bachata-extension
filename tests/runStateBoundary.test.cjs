const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { deferred, loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");
const { createPipelineSnapshot } = require("../dist/pipeline/identity.js");
const { finalAssessmentFor, resultStatusOf } = require("../dist/results/projectResult.js");

// One run, one state. A live run exposes no way back into anything; a run that ended exposes the
// checkpoint it left, labelled with how it ended; a stop is an interruption and a provider error is
// a failure; and a precondition every participant shares is checked once, before any of them runs.
// Everything below drives the real runtime and the real pipeline runner; only the host and the
// provider transport are doubles.

const agentStep = (id, name, participants, promptTemplate) => ({
  id,
  name,
  enabled: true,
  participants,
  promptTemplate,
  parallel: participants.length > 1,
  consensus: false,
  humanGate: "none",
  type: "agent",
});

const pipelineDefinition = (agents, steps) => ({
  version: 1,
  id: "cross-reference-development",
  name: "State boundary",
  agents,
  steps,
});

const writingPair = () => pipelineDefinition(
  [
    { id: "codex", name: "Codex", adapter: "codex-app-server" },
    { id: "claude", name: "Claude", adapter: "claude-code" },
  ],
  [
    agentStep("review", "Review", ["codex", "claude"], "Review: {{userPrompt}}"),
    agentStep("fix", "Fix", ["codex"], "Fix: {{userPrompt}}"),
  ],
);

const readOnlyPair = () => pipelineDefinition(
  [
    { id: "codex", name: "Usability reviewer", adapter: "codex-app-server", permissionMode: "readOnly" },
    { id: "claude", name: "Accessibility reviewer", adapter: "claude-code", permissionMode: "plan" },
  ],
  [agentStep("inspect", "Inspect", ["codex", "claude"], "Inspect: {{userPrompt}}")],
);

const readOnlySingle = () => pipelineDefinition(
  [{ id: "codex", name: "Reviewer", adapter: "codex-app-server", permissionMode: "readOnly" }],
  [agentStep("review", "Review", ["codex"], "Review: {{userPrompt}}")],
);

/**
 * A runtime over one preset. `provider.mode` decides what a send does: answer, throw, or hold until
 * the test releases it or the run is stopped. Every prompt a provider was actually handed is kept.
 */
const startHarness = (definition, options = {}) => {
  const extensionRoot = scratchRootSync("bachata-state-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, "presets", "cross-reference.pipeline.json"), JSON.stringify(definition));
  const provider = { mode: "answer", prompts: [], entered: deferred(), gate: deferred() };
  let harness;
  harness = loadRuntimeHarness({
    extensionRoot,
    onAdapterSend: async ({ request, signal }) => {
      provider.prompts.push(request.prompt);
      harness?.adapterControlHistory.forEach((control) => control.release.resolve());
      if (provider.mode === "throw") throw new Error("The provider refused this request");
      if (provider.mode === "hold") {
        provider.entered.resolve();
        await Promise.race([
          provider.gate.promise,
          new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
        ]);
      }
      return { answer: "done" };
    },
    ...options,
  });
  return { ...harness, extensionRoot, provider };
};

const closeHarness = async (harness) => {
  harness.provider.gate.resolve();
  harness.adapterControlHistory.forEach((control) => control.release.resolve());
  await harness.runtime.dispose();
  harness.cleanup();
  removeScratchSync(harness.extensionRoot);
};

const sends = (harness) => harness.adapterControlHistory.reduce((total, control) => total + control.sendCount, 0);
const errors = (harness) => harness.transcript.filter((entry) => entry.kind === "error");
const persistedRecovery = (harness) => harness.workspaceState.get("bachata.runtimeState.v5")?.resumableWorkflow;

// Owner decision, docs/PRODUCT_DOCTRINE.md: a folder that is not a Git repository is a valid
// project, so a writing pipeline runs there. Do not reintroduce a Git refusal for it.
test("a writing pipeline runs in a folder that is not a Git repository", async () => {
  const harness = startHarness(writingPair());
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.runPipeline("Change the retry guard", [], { allowedPaths: ["src"] });
    assert.equal(sends(harness), 3);
    assert.deepEqual(errors(harness), []);
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
  } finally {
    await closeHarness(harness);
  }
});

// The shared precondition below is a project folder that cannot be resolved: it disappears before
// the run starts. That still refuses every participant once, before any of them runs.
test("a precondition every participant shares refuses the run once, before any participant runs", async () => {
  const harness = startHarness(writingPair());
  const moved = `${harness.workspaceDirectory}-moved`;
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    fs.renameSync(harness.workspaceDirectory, moved);
    await assert.rejects(
      harness.runtime.runPipeline("Change the retry guard", [], { allowedPaths: ["src"] }),
      /^Error: Bachata could not resolve the project/u,
    );
    assert.equal(sends(harness), 0, "a participant was invoked although the run could not be validated");
    assert.deepEqual(harness.transcript.filter((entry) => entry.agentId !== undefined), [], "a participant was given an entry");
    const [failure, ...duplicates] = errors(harness);
    assert.deepEqual(duplicates, [], "the shared refusal was recorded more than once");
    assert.equal(failure.eventType, "workflow.preflightFailed");
    assert.equal(failure.agentId, undefined);
    assert.match(failure.text, /so it did not start Codex in “Review”, Claude in “Review” and 1 more participant\.$/u);
    assert.equal(failure.data.reason, "unresolved");
    assert.deepEqual(failure.data.participants, [
      { participant: "Codex", step: "Review" },
      { participant: "Claude", step: "Review" },
      { participant: "Codex", step: "Fix" },
    ]);
    const state = harness.runtime.getState();
    assert.equal(state.running, false);
    assert.equal(state.workflowStatus, "error");
    assert.equal(state.resumableWorkflow.outcome, "failed");
    assert.equal(state.resumableWorkflow.failureScope, "run", "a run that never started a participant offered a step to retry");
    assert.equal(state.resumableWorkflow.nextStepIndex, 0);
    assert.ok(Object.values(state.agents).every((agent) => agent.status !== "error"), "a participant that never started is shown as failed");

    fs.renameSync(moved, harness.workspaceDirectory);
    await harness.runtime.restartPipeline();
    assert.deepEqual(
      harness.provider.prompts.slice().sort(),
      ["Fix: Change the retry guard", "Review: Change the retry guard", "Review: Change the retry guard"],
      "the restart did not rerun from the beginning once the folder was back",
    );
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
    assert.equal(harness.runtime.getState().resumableWorkflow, undefined);
  } finally {
    await closeHarness(harness);
  }
});

test("read-only participants run outside a Git worktree", async () => {
  const harness = startHarness(readOnlyPair());
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.runPipeline("review extension/", [], { allowedPaths: ["src"] });
    assert.deepEqual(harness.provider.prompts.slice().sort(), ["Inspect: review extension/", "Inspect: review extension/"]);
    assert.deepEqual(errors(harness), []);
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
  } finally {
    await closeHarness(harness);
  }
});

test("a provider that fails after dispatch is one failure, attributed to its participant, with a step to retry", async () => {
  const harness = startHarness(readOnlySingle());
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.provider.mode = "throw";
    await assert.rejects(harness.runtime.runPipeline("Review the change"), /The provider refused this request/u);
    assert.equal(sends(harness), 1);
    const [failure, ...duplicates] = errors(harness);
    assert.deepEqual(duplicates, [], "the participant's failure was recorded again without the participant");
    assert.equal(failure.agentId, "codex");
    assert.equal(failure.step, "Review");
    const state = harness.runtime.getState();
    assert.equal(state.workflowStatus, "error");
    assert.equal(state.resumableWorkflow.outcome, "failed");
    assert.equal(state.resumableWorkflow.failureScope, "step");
    assert.equal(state.resumableWorkflow.stepName, "Review");

    // The failed run's checkpoint must not read as recovery while the restart it offers is running.
    const failedAttempt = state.resumableWorkflow.attemptId;
    harness.provider.mode = "hold";
    const restarting = harness.runtime.restartPipeline();
    await harness.provider.entered.promise;
    const live = harness.runtime.getState();
    assert.equal(live.running, true);
    assert.equal(live.workflowStatus, "running");
    assert.equal(live.resumableWorkflow, undefined, "a stale checkpoint was exposed during a newer active run");
    assert.equal(persistedRecovery(harness).outcome, "running");
    assert.notEqual(persistedRecovery(harness).attemptId, failedAttempt, "the active run kept the failed run's identity");
    harness.provider.gate.resolve();
    await restarting;
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
    assert.equal(harness.runtime.getState().resumableWorkflow, undefined);
  } finally {
    await closeHarness(harness);
  }
});

test("a stop by the user is an interruption that offers Resume, never a failure", async () => {
  const harness = startHarness(readOnlySingle());
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.provider.mode = "hold";
    const running = harness.runtime.runPipeline("Review the change");
    await harness.provider.entered.promise;
    assert.equal(harness.runtime.getState().resumableWorkflow, undefined);
    await harness.runtime.handleMessage({ type: "run.interrupt" });
    const result = await running;
    assert.equal(result.status, "interrupted");
    const state = harness.runtime.getState();
    assert.equal(state.workflowStatus, "interrupted");
    assert.equal(state.resumableWorkflow.outcome, "stoppedByUser");
    assert.equal(state.resumableWorkflow.failureScope, undefined);
    assert.deepEqual(errors(harness), [], "a stop was recorded as an error");
  } finally {
    await closeHarness(harness);
  }
});

const persistedRecord = (definition, overrides) => {
  const pipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  return {
    selectedPipelineId: definition.id,
    selectedPipelineSnapshot: pipelineSnapshot,
    taskDirty: true,
    agents: {},
    attachments: [],
    queuedMessages: [],
    queuePaused: false,
    resumableWorkflow: {
      attemptId: "attempt-restored",
      pipelineId: definition.id,
      pipelineName: definition.name,
      pipelineHash: pipelineSnapshot.hash,
      pipelineSnapshot,
      userPrompt: "Recover this request",
      attachmentIds: [],
      nextStepIndex: 0,
      totalSteps: definition.steps.length,
      updatedAt: new Date().toISOString(),
      checkpoint: {
        version: 1,
        nextStepIndex: 0,
        snapshot: {
          roles: {},
          answers: {},
          latestAnswers: {},
          previousStepAnswers: { order: [], values: {} },
          latestInterventions: { order: [], values: {} },
        },
      },
      ...overrides,
    },
  };
};

test("a restored checkpoint keeps how its run ended, and one left running by a lost host is an interruption", async () => {
  for (const [persisted, status, outcome] of [
    [{ outcome: "running" }, "interrupted", "interrupted"],
    [{ outcome: "stoppedByUser" }, "interrupted", "stoppedByUser"],
    [{ outcome: "failed", failureScope: "step" }, "error", "failed"],
    [{}, "interrupted", "interrupted"],
  ]) {
    const definition = readOnlySingle();
    const harness = startHarness(definition, {
      initialWorkspaceState: { "bachata.runtimeState.v5": persistedRecord(definition, persisted) },
    });
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      const state = harness.runtime.getState();
      assert.equal(state.workflowStatus, status, JSON.stringify(persisted));
      assert.equal(state.resumableWorkflow.outcome, outcome, JSON.stringify(persisted));
    } finally {
      await closeHarness(harness);
    }
  }
});

test("choosing a project folder keeps a run that never started ready to restart there", async () => {
  let harness;
  harness = startHarness(writingPair(), {
    showOpenDialog: () => [{ fsPath: path.join(harness.workspaceDirectory, "project") }],
    showWarningMessage: () => "Change and reset",
  });
  const moved = `${harness.workspaceDirectory}-moved`;
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    fs.renameSync(harness.workspaceDirectory, moved);
    await assert.rejects(
      harness.runtime.runPipeline("Change the retry guard", [], { allowedPaths: ["src"] }),
      /Bachata could not resolve the project/u,
    );
    fs.renameSync(moved, harness.workspaceDirectory);
    fs.mkdirSync(path.join(harness.workspaceDirectory, "project"), { recursive: true });
    await harness.runtime.handleMessage({ type: "workingDirectory.pick" });
    const state = harness.runtime.getState();
    assert.equal(state.workingDirectory, fs.realpathSync(path.join(harness.workspaceDirectory, "project")));
    assert.equal(state.workflowStatus, "error");
    assert.equal(state.resumableWorkflow?.failureScope, "run", "the folder change dropped the only way back into the run");
    await harness.runtime.restartPipeline();
    assert.equal(sends(harness), 3);
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
  } finally {
    await closeHarness(harness);
  }
});

const mixedRolePipeline = (chosenAgentId) => ({
  version: 1,
  id: "cross-reference-development",
  name: "Mixed role",
  agents: [
    { id: "reader", name: "Reader", adapter: "codex-app-server", permissionMode: "readOnly" },
    { id: "writer", name: "Writer", adapter: "claude-code" },
  ],
  roles: [{ id: "builder", name: "Builder", instructions: "Build what was asked.", candidateAgentIds: ["reader", "writer"] }],
  steps: [
    { id: "assign", name: "Assign", enabled: true, humanGate: "none", type: "assignRoles", roleAssignments: [{ agentId: chosenAgentId, role: "builder" }] },
    agentStep("build", "Build", ["builder"], "Build: {{userPrompt}}"),
  ],
});

for (const [chosen, writes] of [["writer", true], ["reader", false]]) {
  test(`a role with a reading and a writing candidate is checked for the agent it resolves to: ${chosen}`, async () => {
    const harness = startHarness(mixedRolePipeline(chosen));
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      const run = harness.runtime.runPipeline("Change the retry guard", [], { allowedPaths: ["src"] });
      // Outside Git both candidates run; which one writes no longer decides whether the run starts.
      assert.ok(typeof writes === "boolean");
      await run;
      assert.deepEqual(harness.provider.prompts.map((prompt) => prompt.split("\n").at(-1)), ["Build: Change the retry guard"]);
      assert.deepEqual(errors(harness), []);
      assert.equal(harness.runtime.getState().workflowStatus, "completed");
    } finally {
      await closeHarness(harness);
    }
  });
}

test("a folder lookup that fails is an unresolved project with its reason, not a missing folder", async () => {
  const definition = pipelineDefinition(
    [{ id: "writer", name: "Writer", adapter: "claude-code", workingDirectory: "missing-subfolder" }],
    [agentStep("build", "Build", ["writer"], "Build: {{userPrompt}}")],
  );
  const harness = startHarness(definition);
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.runPipeline("Change the retry guard", [], { allowedPaths: ["src"] }),
      /^Error: Bachata could not resolve the project folder, so it did not start Writer in “Build”\.$/u,
    );
    assert.equal(sends(harness), 0);
    const [failure] = errors(harness);
    assert.equal(failure.data.reason, "unresolved");
    assert.equal(failure.data.folder, undefined);
    assert.match(failure.data.detail, /ENOENT|no such file/u, "the lookup's own reason was not kept as the diagnostic");
  } finally {
    await closeHarness(harness);
  }
});

test("a result exists only for a run that ended, and a stop is never assessed as a failure", () => {
  for (const status of ["idle", "running", "paused"]) {
    assert.equal(resultStatusOf(status), undefined, `${status} was given a result status`);
  }
  for (const status of ["idle", "running", "paused"]) {
    assert.equal(resultStatusOf(status, "completed"), undefined, `a live ${status} run surfaced an earlier result`);
  }
  for (const status of ["completed", "interrupted", "error"]) {
    assert.equal(resultStatusOf(status), status);
    assert.equal(resultStatusOf("idle", status), undefined, "persisted evidence must not turn idle into a terminal status");
  }
  const base = {
    checks: [],
    providers: [],
    unresolvedRisks: [],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
    evidenceGaps: [],
  };
  const failure = { error: "The provider aborted", agentId: "codex" };
  const stopped = finalAssessmentFor({ ...base, status: "interrupted", failure });
  assert.equal(stopped.outcome, "inconclusive");
  assert.equal(stopped.failure, undefined);
  assert.equal(stopped.summary, "Stopped before a final assessment was produced");
  assert.equal(finalAssessmentFor({ ...base, status: "error", failure }).outcome, "failedBeforeRuling");
  assert.equal(finalAssessmentFor({ ...base, status: "error" }).summary, "The run failed before a final assessment was produced");
});
