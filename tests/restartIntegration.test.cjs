const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { loadManagerHarness } = require("./support/runtimeHarness.cjs");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");

// Restart, through the route the editor actually takes.
//
// `tests/runtimeBehavior.test.cjs` drives `workflow.restart` straight at a runtime, and
// `tests/conversationManager.test.cjs` drives it at a manager whose runtime is a double. Neither
// covers the join: the manager preflights a restart through the runtime's public preflight, and
// while a recovery checkpoint exists an ordinary preflight refuses — so the restart the reader
// presses could never reach `restartPipeline` at all, and no test could see it.
//
// Nothing here stands in for the manager, the runtime or the pipeline runner. The doubles are the
// extension host and the provider transport, and the workflow is a real preset file on disk.

const twoStepPipelineDefinition = (overrides = {}) => ({
  version: 1,
  id: "cross-reference-development",
  name: "Two-step pipeline",
  longitudinalIntent: "runLocal",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
  steps: [
    {
      id: "implementation",
      name: "Implementation",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      attachments: "selected",
      parallel: false,
      consensus: false,
      humanGate: "none",
      type: "agent",
    },
    {
      id: "review",
      name: "Review",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "Review: {{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
      type: "agent",
    },
  ],
  ...overrides,
});

const createPipelineRoot = (definition = twoStepPipelineDefinition()) => {
  const extensionRoot = scratchRootSync("bachata-restart-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "cross-reference.pipeline.json"),
    JSON.stringify(definition),
  );
  return extensionRoot;
};

/**
 * A manager, a runtime and a pipeline runner over one preset, with the review step refusing until
 * a test says otherwise.
 *
 * `prompts` is what the provider was actually handed, which is the only evidence that distinguishes
 * a restart from a resume: a resume opens at the review step, a restart opens at step one.
 */
const startHarness = (options = {}) => {
  const extensionRoot = createPipelineRoot(options.definition ?? twoStepPipelineDefinition());
  const prompts = [];
  const attachmentPathsSeen = [];
  const state = { failReview: true };
  let harness;
  const releaseAll = () => {
    harness?.adapterControlHistory.forEach((control) => control.release.resolve());
  };
  harness = loadManagerHarness({
    extensionRoot,
    resolvePaths: async (_attachments, attachmentIds) => ({
      paths: attachmentIds.map((id) => `/attachments/${id}.txt`),
      dispose: async () => undefined,
    }),
    onAdapterSend: async ({ request }) => {
      prompts.push(request.prompt);
      attachmentPathsSeen.push([...(request.attachments ?? [])]);
      releaseAll();
      if (state.failReview && request.prompt.startsWith("Review: ")) {
        throw new Error("provider refused the review step");
      }
      await options.onSend?.({ request, prompts });
      return { answer: "done" };
    },
    ...options.harnessOptions,
  });
  return { ...harness, extensionRoot, prompts, attachmentPathsSeen, state, releaseAll };
};

const closeHarness = async (harness) => {
  harness.releaseAll();
  await harness.manager.dispose();
  harness.cleanup();
  removeScratchSync(harness.extensionRoot);
};

const conversationEvents = (harness, conversationId) =>
  (harness.manager.getState().eventsByConversation[conversationId] ?? []).map(
    (event) => event.type,
  );

/**
 * The runtime's own persisted record for one conversation.
 *
 * The manager does not hand its runtimes out, and it should not: what a restart owes the reader is
 * a durable checkpoint, so the durable checkpoint is what this reads.
 */
const persistedRuntimeState = (harness, conversationId) =>
  harness.workspaceState.get(`bachata.conversationRuntime.v2.${conversationId}`);

test("restart from the editor reaches the runtime's restart and replays from step one", async () => {
  const harness = startHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Restart me",
      pipelineId: "cross-reference-development",
      workingDirectory: harness.workspaceDirectory,
    });
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Build the thing", ["a1"]),
      /provider refused the review step/u,
    );
    const recorded = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.ok(recorded, "the failed run left no checkpoint to restart");
    assert.equal(
      recorded.nextStepIndex,
      1,
      "the run must have failed after step one for this regression to mean anything",
    );
    assert.deepEqual(recorded.attachmentIds, ["a1"], "the checkpoint lost the run's attachments");

    harness.state.failReview = false;
    harness.prompts.length = 0;
    harness.attachmentPathsSeen.length = 0;
    harness.releaseAll();

    // The exact message the webview sends. An ordinary interrupted-workflow refusal here is the
    // defect this test exists for.
    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: conversation.id,
      message: { type: "workflow.restart" },
    });

    assert.deepEqual(
      harness.prompts,
      ["Build the thing", "Review: Build the thing"],
      "the restart did not rerun from the first enabled step",
    );
    assert.deepEqual(
      harness.attachmentPathsSeen[0],
      ["/attachments/a1.txt"],
      "the restart ran without the attachments the recorded run was given",
    );
    const replayed = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.equal(
      replayed === undefined || replayed.pipelineHash === recorded.pipelineHash,
      true,
      "the restart executed a different pipeline revision than the one recorded",
    );
    const transcript = harness.transcript;
    assert.equal(
      transcript.filter((entry) => entry.eventType === "user.message").length,
      1,
      "the restart wrote the reader's request into the chat a second time",
    );
    assert.ok(
      transcript.some((entry) => entry.eventType === "workflow.restarted"),
      "the chat does not say the run was restarted",
    );
    const types = conversationEvents(harness, conversation.id);
    assert.ok(types.includes("run.restarted"), "the catalog recorded no restart");
    assert.ok(
      !types.includes("run.restart.failed"),
      "the restart was refused instead of run",
    );
  } finally {
    await closeHarness(harness);
  }
});

test("a restart refused before its own checkpoint is durable leaves the previous one usable", async () => {
  let failRecoveryWrite = false;
  const harness = startHarness({
    harnessOptions: {
      beforeWorkspaceStateUpdate: ({ value }) => {
        if (failRecoveryWrite && value?.resumableWorkflow?.nextStepIndex === 0) {
          throw new Error("restart checkpoint persistence failed");
        }
      },
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Refused restart",
      pipelineId: "cross-reference-development",
      workingDirectory: harness.workspaceDirectory,
    });
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Build the thing"),
      /provider refused the review step/u,
    );
    const before = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.ok(before);

    harness.state.failReview = false;
    failRecoveryWrite = true;
    harness.releaseAll();
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: conversation.id,
        message: { type: "workflow.restart" },
      }),
      /restart checkpoint persistence failed/u,
    );

    const after = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.ok(after, "a refused restart destroyed the recovery the reader had");
    assert.equal(after.nextStepIndex, before.nextStepIndex);
    assert.equal(after.userPrompt, before.userPrompt);

    // And the recovery is still usable: with persistence working again, the same restart runs.
    failRecoveryWrite = false;
    harness.prompts.length = 0;
    harness.releaseAll();
    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: conversation.id,
      message: { type: "workflow.restart" },
    });
    assert.deepEqual(
      harness.prompts,
      ["Build the thing", "Review: Build the thing"],
      "the checkpoint a refused restart left behind could not be restarted",
    );
  } finally {
    await closeHarness(harness);
  }
});

test("starting an unrelated new run while a recovery exists is still refused", async () => {
  const harness = startHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Guarded",
      pipelineId: "cross-reference-development",
      workingDirectory: harness.workspaceDirectory,
    });
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Build the thing"),
      /provider refused the review step/u,
    );
    harness.state.failReview = false;
    harness.releaseAll();
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Something else entirely"),
      /Resume, restart, or discard the interrupted workflow/u,
      "the guard against starting an unrelated run over a recovery was weakened",
    );
  } finally {
    await closeHarness(harness);
  }
});

test("restarting an until-clean run replays its stopping policy, not the fixed default", async () => {
  const harness = startHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Until clean",
      pipelineId: "cross-reference-development",
      workingDirectory: harness.workspaceDirectory,
    });
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Build the thing", [], 5, {
        iterationMode: "untilClean",
        requiredCleanPasses: 3,
      }),
      /provider refused the review step/u,
    );
    const recorded = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.deepEqual(
      recorded?.executionPlan,
      {
        iterationCount: 5,
        iterationMode: "untilClean",
        requiredCleanPasses: 3,
        trackWorkspaceChanges: true,
      },
      "the recorded run plan is not the plan the run was started under",
    );

    // The restart fails the same way, so what it recorded for the next reader is visible. Under the
    // defect this replaced, the replay silently became two fixed passes.
    harness.releaseAll();
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: conversation.id,
        message: { type: "workflow.restart" },
      }),
      /provider refused the review step/u,
    );
    const replayed = persistedRuntimeState(harness, conversation.id)?.resumableWorkflow;
    assert.deepEqual(
      replayed?.executionPlan,
      recorded?.executionPlan,
      "the restart ran under a different stopping policy than the run it replays",
    );
    assert.equal(
      replayed?.nextStepIndex,
      1,
      "the restart did not run the recorded pipeline from step one",
    );
  } finally {
    await closeHarness(harness);
  }
});
