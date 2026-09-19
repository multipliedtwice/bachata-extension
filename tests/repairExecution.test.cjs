const assert = require("node:assert/strict");
const test = require("node:test");
const { root, loadProduction } = require("./support/productionSource.cjs");
const lifecycle = require("../dist/conversations/conversationLifecycle.js");
const iteration = require("../dist/conversations/iterationExecution.js");
const plans = require("../dist/runtime/pipelineRunPlan.js");
const permissions = require("../dist/pipeline/permissionModes.js");
const { resolveWorkspaceWritePolicy } = require("../dist/adapters/workspacePolicyAudit.js");
const { setOptionalProperty } = require("../dist/state/optionalProperty.js");
const { failedRunWorkflowStatus } = require("../dist/runtime/recoveryTransition.js");

const scopeFixture = () => {
  const calls = [];
  const preflights = [];
  const entry = loadProduction("src/runtime/createRuntime.ts", ["runProgrammaticPipeline"], {
    disposed: false, awaitInitialization: async () => {}, ensureAdaptersReady: async () => {},
    preflightPipeline: async (_prompt, _attachments, options) => {
      preflights.push(options);
      return { disposeAttachments: async () => {}, pipelineSnapshot: { hash: "snapshot", definition: { id: "fix" } } };
    },
    disposeAttachmentSnapshot: async () => {}, calls, resolvedRunConstraints: plans.resolvedRunConstraints,
  }, `let lastPipelineResult; let programmaticAutoProvisioning = false;
    const programmaticResetBindings = new Map(); const managedFreshSessionKeys = new Set(); const managedTaskState = new Map();
    const runPipeline = async (_prompt, _attachments, options) => { calls.push(options); lastPipelineResult = { status: "completed" }; };`);
  const { participantOptions } = loadProduction("src/pipeline/runner.ts", ["resolveOption", "participantOptions"], permissions);
  const policyFor = (options) => {
    const participant = participantOptions("worker", "worker", { id: "work", permissionModes: { worker: "write" } },
      { id: "worker", adapter: "chatgpt-browser" }, { id: "worker", managed: true, managedRole: "worker" },
      "Inspect the repository", { writeScope: "workspace" }, options.allowedPaths, options.commitMode, options.writeScope);
    return resolveWorkspaceWritePolicy({ task: "Inspect the repository", workspaceRoot: root,
      writeScope: participant.writeScope, allowedPaths: participant.allowedPaths, readOnly: participant.readOnly, defaultScope: "workspace" });
  };
  return { ...entry, calls, preflights, policyFor };
};

for (const input of [{ writeScope: "readOnly", commitMode: "never" },
  { writeScope: "task", allowedPaths: ["src/allowed.ts"], commitMode: "never" }]) {
  test(`R1 preserves ${input.writeScope} restrictions through preflight and resolved participant authority`, async () => {
    const fixture = scopeFixture();
    await fixture.runProgrammaticPipeline("Inspect the repository", [], input);
    assert.equal(fixture.calls[0].writeScope, input.writeScope);
    assert.equal(fixture.calls[0].commitMode, "never");
    assert.equal(fixture.preflights[0].writeScope, input.writeScope);
    assert.deepEqual(fixture.policyFor(fixture.calls[0]), fixture.policyFor(input));
    if (input.writeScope === "readOnly") assert.deepEqual(fixture.policyFor(fixture.calls[0]), { writeScope: "readOnly", allowedPaths: [], readOnly: true });
    else assert.deepEqual(fixture.policyFor(fixture.calls[0]).allowedPaths, ["src/allowed.ts"]);
  });
}

const scenario = async ({ resume = false, mode = "untilClean", maximum = 5, required = 1, clean = 0, index = 1, results = [] } = {}) => {
  const snapshot = { hash: "accepted", definition: { id: "review", name: "Review", steps: [], roles: [] } };
  const changedSnapshot = { ...snapshot, hash: "different-live-catalog" };
  const plan = { iterationCount: maximum, iterationMode: mode, requiredCleanPasses: required, trackWorkspaceChanges: mode === "untilClean", iterationIndex: index, consecutiveCleanPasses: clean };
  const constraints = { writeScope: "task", allowedPaths: ["src/allowed.ts"], commitMode: "never" };
  const summary = { id: "conversation", runRef: "run", title: "Review", workingDirectory: "/workspace", iterationCount: maximum, activeIteration: index };
  const recovery = { userPrompt: "Review current changes", attachmentIds: [], pipelineHash: snapshot.hash };
  const state = { roles: {}, agents: {}, workingDirectory: "/workspace", selectedPipelineId: "review", selectedPipelineDefinition: snapshot.definition,
    selectedPipelineHash: snapshot.hash, running: false, workflowStatus: resume ? "interrupted" : "idle", ...(resume ? { resumableWorkflow: recovery } : {}) };
  const records = resume ? [{ iterationRef: `iteration-${index}`, index, status: "interrupted" }] : [];
  const calls = [];
  const reads = [];
  let resets = 0;
  const complete = () => {
    const next = results.shift() ?? {};
    const result = { status: "completed", workspaceChanged: false, answers: {}, outputs: {}, decisions: [], roles: {}, ...next };
    state.workflowStatus = result.status;
    state.running = false;
    if (result.status === "completed") delete state.resumableWorkflow;
    return result;
  };
  const slot = { runtime: {
    getState: () => state,
    getSelectedPipelineSnapshot: () => resume ? changedSnapshot : snapshot,
    preflightPipeline: async () => snapshot,
    getRecoveryPipelineSnapshot: () => { reads.push("snapshot"); return snapshot; },
    getRecoveryExecutionPlan: () => { reads.push("plan"); return plan; },
    getRecoveryRunConstraints: () => { reads.push("constraints"); return constraints; },
    resetSessions: async () => { resets += 1; },
    runPipeline: async (_prompt, _attachments, options) => { calls.push({ kind: "fresh", options }); return complete(); },
    resumePipeline: async (options) => { calls.push({ kind: "resume", options }); return complete(); },
  } };
  const noop = () => {};
  const catalog = {
    listIterations: () => records, getPairForIteration: () => undefined,
    createIteration: (item) => { const ref = `iteration-${records.length + 1}`; records.push({ ...item, iterationRef: ref }); return ref; },
    updateIteration: (ref, item) => Object.assign(records.find((record) => record.iterationRef === ref), item),
    appendEvent: noop,
  };
  const functions = loadProduction("src/conversations/createConversationManager.ts",
    ["executeConversationIteration", "finishConversationRun", "runConversationOwned", "resumeConversationOwned"], {
      ...lifecycle, ...iteration, setOptionalProperty, failedRunWorkflowStatus,
      ensureInitialized: async () => {}, findSummary: () => summary, ensureRuntime: async () => slot,
      maximumPipelineIterations: 10, defaultPipelineIterations: 1,
      runtimePipelineSnapshot: () => resume ? changedSnapshot : snapshot, runtimeProvidesPipelineSnapshot: () => true,
      rememberEvidenceExpectations: noop, bindConversationRun: noop, parseRunTitle: () => ({ title: "Review" }),
      formatRunTitle: (_input, value) => value, titleFromPrompt: (value) => value,
      terminalResults: new Map(), latestRechecks: new Map(), runtimeContexts: new Map(), pendingWorkingDirectories: new Map(),
      persist: async () => {}, emitSnapshot: noop, ensureContinuationExecutionLease: async () => {},
      syncAgentChat: noop, updateExecutionTerminalState: noop, runContractVerification: async () => {}, catalog,
    });
  const result = resume ? await functions.resumeConversationOwned(summary.id)
    : await functions.runConversationOwned(summary.id, recovery.userPrompt, [], maximum, { ...constraints, iterationMode: mode, requiredCleanPasses: required });
  return { result, calls, reads, resets, summary, plan, constraints, snapshot };
};

test("R2 fresh and resumed Until clean stop after the same unchanged pass", async () => {
  const fresh = await scenario();
  const resumed = await scenario({ resume: true });
  assert.equal(fresh.calls.length, 1);
  assert.equal(resumed.calls.length, 1);
  assert.deepEqual(resumed.reads, ["snapshot", "plan", "constraints"]);
});

test("R2 later resumed iterations preserve restrictions and the immutable snapshot", async () => {
  const fixture = await scenario({ resume: true, mode: "fixed", maximum: 4, index: 2 });
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.resets, 2);
  for (const call of fixture.calls.slice(1)) {
    for (const [key, value] of Object.entries(fixture.constraints)) assert.deepEqual(call.options[key], value);
    assert.deepEqual(call.options.pipelineSnapshot, fixture.snapshot);
    assert.equal(call.options.requireCurrentCatalog, false);
    assert.equal(call.options.executionPlan.iterationMode, "fixed");
    assert.equal(call.options.executionPlan.iterationCount, 4);
  }
  assert.deepEqual(fixture.calls.slice(1).map((call) => call.options.executionPlan.iterationIndex), [3, 4]);
});

test("R2 recovery restores consecutive-clean progress", async () => {
  const fixture = await scenario({ resume: true, required: 2, clean: 1, index: 2 });
  assert.equal(fixture.calls.length, 1);
});

test("R2 a changed interrupted iteration resets prior clean progress", async () => {
  const fixture = await scenario({ resume: true, required: 2, clean: 1, index: 2, maximum: 6,
    results: [{ workspaceChanged: true }, { workspaceChanged: false }, { workspaceChanged: false }] });
  assert.equal(fixture.calls.length, 3);
  assert.deepEqual(fixture.calls.slice(1).map((call) => call.options.executionPlan.consecutiveCleanPasses), [0, 1]);
});

for (const outcome of [{ status: "interrupted" }, { completionReason: "humanDecision" }]) {
  test(`R2 ${outcome.status ?? outcome.completionReason} does not start a later pass`, async () => {
    const fixture = await scenario({ resume: true, mode: "fixed", results: [outcome] });
    assert.equal(fixture.calls.length, 1);
  });
}

test("R2 changing iterations still stop at the hard maximum", async () => {
  const fixture = await scenario({ maximum: 3, results: Array.from({ length: 3 }, () => ({ workspaceChanged: true })) });
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.resets, 3);
});

test("R2 recovery wrappers restore tracking, constraints, and iteration position", async () => {
  const calls = [];
  const recorded = { userPrompt: "Review", attachmentIds: [], pipelineId: "review", pipelineSnapshot: { hash: "snapshot", definition: { id: "review" } },
    writeScope: "task", allowedPaths: ["src/allowed.ts"], commitMode: "never",
    executionPlan: { iterationCount: 5, iterationMode: "untilClean", requiredCleanPasses: 2, iterationIndex: 3, consecutiveCleanPasses: 1 },
    workspaceChangeBaseline: { isGitRepository: true, head: "a".repeat(40), entries: [] } };
  const functions = loadProduction("src/runtime/createRuntime.ts", ["restartProgrammaticPipeline", "resumeProgrammaticPipeline"], {
    disposed: false, workflowActive: false, awaitInitialization: async () => {}, ensureAdaptersReady: async () => {},
    adoptQueuedRecovery: async () => {}, reconcileQueueStartClaim: async () => {}, resumeRefusal: () => undefined, calls, recorded, resolvedRunConstraints: plans.resolvedRunConstraints,
  }, `let resumableWorkflowData = recorded; let lastPipelineResult; let programmaticAutoProvisioning = false;
    const programmaticResetBindings = new Map(); const managedFreshSessionKeys = new Set(); const managedTaskState = new Map();
    const setResumableWorkflow = async (value) => { resumableWorkflowData = value; };
    const runPipeline = async (_prompt, _attachments, options) => { calls.push(options); lastPipelineResult = { status: "completed" }; };`);
  await functions.restartProgrammaticPipeline();
  await functions.resumeProgrammaticPipeline();
  assert.ok(calls.every((call) => call.trackWorkspaceChanges === true));
  assert.equal(calls[0].executionPlan.iterationIndex, 1);
  assert.equal(calls[0].executionPlan.consecutiveCleanPasses, 0);
  assert.equal(calls[1].executionPlan.iterationIndex, 3);
  assert.equal(calls[1].executionPlan.consecutiveCleanPasses, 1);
  assert.equal(calls[0].writeScope, "task");
  assert.equal(calls[0].commitMode, "never");
  assert.equal(calls[1].resume, recorded);
});

test("R2 persisted measurement baseline is isolated from later mutation", () => {
  const baseline = { isGitRepository: true, head: "a".repeat(40), entries: [] };
  const saved = plans.resumableWorkflowFrom({ attemptId: "attempt", pipelineId: "review", pipelineName: "Review", pipelineHash: "hash", totalSteps: 1,
    userPrompt: "Review", attachmentIds: [], checkpoint: { nextStepIndex: 0 }, pipelineSnapshot: { hash: "hash", definition: {} },
    runSettings: {}, constraints: { writeScope: "readOnly", commitMode: "never" }, updatedAt: new Date().toISOString(),
    executionPlan: { iterationCount: 5, iterationMode: "untilClean", requiredCleanPasses: 2, iterationIndex: 3, consecutiveCleanPasses: 1 },
    workspaceChangeBaseline: baseline });
  baseline.entries.push({ path: "late.ts", fingerprint: "b".repeat(64) });
  assert.deepEqual(saved.workspaceChangeBaseline.entries, []);
  assert.deepEqual(plans.parseRunExecutionPlan(saved.executionPlan), { ...saved.executionPlan, trackWorkspaceChanges: true });
  assert.equal(plans.parseRunExecutionPlan({ ...saved.executionPlan, iterationIndex: 6 }), undefined);
});
