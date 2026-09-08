const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  CHECKLIST_EXECUTION_UNAVAILABLE,
  CHECKLIST_PREFLIGHT_UNAVAILABLE,
  checklistExecutionRefusal,
  conversationRuntimeShape,
} = require("../dist/conversations/conversationRuntimeOptions.js");

const shape = (overrides = {}) =>
  conversationRuntimeShape({
    conversationId: "run-1",
    sharedPipelineStorageDirectory: "/storage/pipelines",
    storageRoot: "/storage",
    ...overrides,
  });

test("a conversation owns its own runtime and the shared pipeline catalog", () => {
  assert.deepEqual(shape(), {
    ownerId: "run-1",
    pipelineStorageDirectory: "/storage/pipelines",
    managedWorkingDirectoryRoot: path.join("/storage", "orchestration"),
    unattendedOrchestration: false,
    startBridge: false,
    closeBridge: false,
    recordedRunSettings: undefined,
    rejectedRecordedRunSettings: undefined,
  });
});

test("no conversation starts or stops the bridge the manager owns for all of them", () => {
  const built = shape({ orchestrationTaskId: "task-1" });
  assert.equal(built.startBridge, false);
  assert.equal(built.closeBridge, false);
});

test("a TODO task runs unattended; a conversation a person opened does not", () => {
  assert.equal(shape({ orchestrationTaskId: "task-1" }).unattendedOrchestration, true);
  assert.equal(shape({ orchestrationTaskId: "" }).unattendedOrchestration, false);
  assert.equal(shape().unattendedOrchestration, false);
});

test("a pipeline scope root is carried only when the conversation has one", () => {
  assert.equal(shape({ pipelineScopeRoot: "/repo" }).pipelineScopeRoot, "/repo");
  assert.equal("pipelineScopeRoot" in shape(), false);
});

test("a replay reproduces the settings the earlier run was given, not this run's", () => {
  const replay = { schema: "bachata.run-settings.v1", values: { a: 1 }, recorded: {}, authority: {}, secretReferences: [] };
  const own = { schema: "bachata.run-settings.v1", values: { a: 2 }, recorded: {}, authority: {}, secretReferences: [] };
  assert.equal(shape({ replaySettings: replay, runSettings: own }).recordedRunSettings, replay);
  assert.equal(shape({ runSettings: own }).recordedRunSettings, own);
  assert.equal(shape().recordedRunSettings, undefined);
});

const refusal = (overrides = {}) =>
  checklistExecutionRefusal({
    hasHost: true,
    hostAbsence: CHECKLIST_EXECUTION_UNAVAILABLE,
    workingDirectory: "/repo",
    requiresWorkingDirectory: true,
    hasActiveRuntime: true,
    requiresActiveRuntime: true,
    ...overrides,
  });

test("a checklist is refused inside a TODO task, before anything else is asked", () => {
  assert.equal(
    refusal({ orchestrationTaskId: "task-1", hasHost: false, workingDirectory: undefined, hasActiveRuntime: false }),
    "Nested checklist orchestration is not supported inside a TODO task pipeline",
  );
});

test("a checklist needs a folder to run in, and says so before naming a missing host", () => {
  assert.equal(
    refusal({ workingDirectory: undefined, hasHost: false }),
    "Select a working folder before executing a checklist",
  );
  assert.equal(refusal({ workingDirectory: "", hasHost: true }), "Select a working folder before executing a checklist");
});

test("an absent host is named by the step that wanted it", () => {
  assert.equal(refusal({ hasHost: false }), CHECKLIST_EXECUTION_UNAVAILABLE);
  assert.equal(
    checklistExecutionRefusal({
      hasHost: false,
      hostAbsence: CHECKLIST_PREFLIGHT_UNAVAILABLE,
      requiresWorkingDirectory: false,
      hasActiveRuntime: true,
      requiresActiveRuntime: false,
    }),
    CHECKLIST_PREFLIGHT_UNAVAILABLE,
  );
});

test("execution needs a live runtime to suspend; preflight does not", () => {
  assert.equal(refusal({ hasActiveRuntime: false }), "The parent conversation runtime is unavailable");
  assert.equal(
    checklistExecutionRefusal({
      hasHost: true,
      hostAbsence: CHECKLIST_PREFLIGHT_UNAVAILABLE,
      requiresWorkingDirectory: false,
      hasActiveRuntime: false,
      requiresActiveRuntime: false,
    }),
    undefined,
  );
});

test("nothing in the way is no refusal", () => {
  assert.equal(refusal(), undefined);
});
