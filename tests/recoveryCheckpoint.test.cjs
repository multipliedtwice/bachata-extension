const assert = require("node:assert/strict");
const test = require("node:test");

const { recoveryCheckpointIsUsable } = require("../dist/runtime/recoveryCheckpoint.js");
const { createPipelineSnapshot } = require("../dist/pipeline/identity.js");

// EX-AUD-12. This judgement lived inside the runtime's initialization, where it could only
// be reached by constructing a whole runtime over a whole persisted value.

const definition = (id = "recovery-pipeline", steps = 2) => ({
  version: 1,
  id,
  name: "Recovery pipeline",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
  roles: [],
  steps: Array.from({ length: steps }, (_unused, index) => ({
    id: `step-${String(index)}`,
    name: `Step ${String(index)}`,
    enabled: true,
    participants: ["codex"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    humanGate: "none",
    type: "agent",
  })),
});

const usable = (overrides = {}) => {
  const pipeline = overrides.definition ?? definition();
  const snapshot = createPipelineSnapshot(pipeline, "builtin");
  return {
    checkpoint: {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      pipelineHash: snapshot.hash,
      pipelineSnapshot: snapshot,
      userPrompt: "Continue this run",
      attachmentIds: [],
      nextStepIndex: 1,
      totalSteps: pipeline.steps.length,
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides.checkpoint,
    },
    selectedSnapshot: Object.hasOwn(overrides, "selectedSnapshot")
      ? overrides.selectedSnapshot
      : snapshot,
    availableAttachmentIds: overrides.availableAttachmentIds ?? new Set(),
  };
};

test("a checkpoint for the selected pipeline at its own revision is resumable", () => {
  assert.equal(recoveryCheckpointIsUsable(usable()), true);
});

test("the first and last step boundaries are both resumable", () => {
  assert.equal(recoveryCheckpointIsUsable(usable({ checkpoint: { nextStepIndex: 0 } })), true);
  assert.equal(recoveryCheckpointIsUsable(usable({ checkpoint: { nextStepIndex: 2 } })), true);
});

test("a step index outside the pipeline is refused", () => {
  assert.equal(recoveryCheckpointIsUsable(usable({ checkpoint: { nextStepIndex: 3 } })), false);
  assert.equal(recoveryCheckpointIsUsable(usable({ checkpoint: { nextStepIndex: -1 } })), false);
});

test("a step total that no longer matches the pipeline is refused", () => {
  assert.equal(recoveryCheckpointIsUsable(usable({ checkpoint: { totalSteps: 3 } })), false);
});

test("a checkpoint whose recorded hash disagrees with its own snapshot is refused", () => {
  assert.equal(
    recoveryCheckpointIsUsable(usable({ checkpoint: { pipelineHash: "0".repeat(64) } })),
    false,
  );
});

test("a checkpoint for a pipeline that is no longer selected is refused", () => {
  const other = createPipelineSnapshot(definition("other-pipeline"), "builtin");
  assert.equal(recoveryCheckpointIsUsable(usable({ selectedSnapshot: other })), false);
});

test("a checkpoint with no selected pipeline at all is refused", () => {
  assert.equal(recoveryCheckpointIsUsable(usable({ selectedSnapshot: undefined })), false);
});

test("a checkpoint from another storage scope is refused even at the same revision", () => {
  const input = usable();
  const relocated = {
    ...input.selectedSnapshot,
    scopeRoot: "/some/other/root",
  };
  assert.equal(
    recoveryCheckpointIsUsable({ ...input, selectedSnapshot: relocated }),
    false,
  );
});

test("a checkpoint keeps every attachment it referenced or it is refused", () => {
  assert.equal(
    recoveryCheckpointIsUsable(
      usable({
        checkpoint: { attachmentIds: ["kept"] },
        availableAttachmentIds: new Set(["kept"]),
      }),
    ),
    true,
  );
  assert.equal(
    recoveryCheckpointIsUsable(
      usable({
        checkpoint: { attachmentIds: ["kept", "gone"] },
        availableAttachmentIds: new Set(["kept"]),
      }),
    ),
    false,
  );
});
