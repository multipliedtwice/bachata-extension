const assert = require("node:assert/strict");
const test = require("node:test");
const { pipelineImplementationRefusal } = require("../dist/conversations/resultContinuation.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const { parseTranscriptEntry } = require("../dist/webview/protocol.js");

const definition = () => ({
  version: 1,
  id: "implementation",
  name: "Implementation",
  agents: [{ id: "worker", name: "Worker", adapter: "codex-app-server", permissionMode: "workspaceWrite" }],
  steps: [{
    id: "write",
    name: "Implement",
    type: "agent",
    enabled: true,
    participants: ["worker"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    humanGate: "none",
  }],
});

const assignRole = (role, agentId, id = "assign") => ({
  id,
  name: "Assign responsibility",
  type: "assignRoles",
  enabled: true,
  humanGate: "none",
  roleAssignments: [{ role, agentId }],
});

const assignedImplementation = () => {
  const pipeline = definition();
  pipeline.agents.push({ id: "reviewer", name: "Planner and reviewer", adapter: "claude-code", permissionMode: "plan" });
  pipeline.roles = [{ id: "implementer", name: "Implementation worker", instructions: "Implement the confirmed findings", candidateAgentIds: ["reviewer", "worker"] }];
  const implementation = { ...pipeline.steps[0], participants: ["implementer"] };
  pipeline.steps = [
    { ...implementation, id: "plan", name: "Plan changes", participants: ["reviewer"] },
    assignRole("implementer", "worker"),
    implementation,
    { ...implementation, id: "review", name: "Review changes", participants: ["reviewer"] },
  ];
  return pipeline;
};

test("implementation authority uses an enabled participant's effective write options", () => {
  assert.equal(pipelineImplementationRefusal(definition()), undefined);
  const disabled = definition();
  disabled.steps[0].enabled = false;
  assert.match(pipelineImplementationRefusal(disabled), /no enabled participant/u);
});

test("a managed read-only scope remains read-only despite writable provider permissions", () => {
  const pipeline = definition();
  pipeline.managedPolicy = { writeScope: "readOnly" };
  assert.match(pipelineImplementationRefusal(pipeline), /read-only workflows cannot implement/i);
});

test("an explicit step permission overrides its agent's writable default", () => {
  const pipeline = definition();
  pipeline.steps[0].permissionModes = { worker: "read" };
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("missing or unknown provider permission does not prove write authority", () => {
  const pipeline = definition();
  delete pipeline.agents[0].permissionMode;
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.agents[0].permissionMode = "unknown-mode";
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("an unused writable agent does not turn a review step into an implementation step", () => {
  const pipeline = definition();
  pipeline.agents.push({ id: "reviewer", name: "Reviewer", adapter: "claude-code", permissionMode: "plan" });
  pipeline.steps[0].participants = ["reviewer"];
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("managed Lead participants cannot satisfy write capability", () => {
  const pipeline = definition();
  pipeline.roles = [{ id: "lead", name: "Lead", instructions: "Review", managed: true, managedRole: "lead", readOnly: true, candidateAgentIds: ["worker"] }];
  pipeline.steps[0].participants = ["lead"];
  pipeline.steps.unshift(assignRole("lead", "worker"));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  pipeline.managedPolicy = { writeScope: "workspace" };
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("role read-only authority cannot be overridden by a write scope or step permission", () => {
  const pipeline = definition();
  pipeline.roles = [{ id: "reviewer", name: "Reviewer", instructions: "Review", managed: true, managedRole: "worker", readOnly: true, candidateAgentIds: ["worker"] }];
  pipeline.steps[0].participants = ["reviewer"];
  pipeline.steps[0].permissionModes = { reviewer: "write" };
  pipeline.steps.unshift(assignRole("reviewer", "worker"));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  pipeline.managedPolicy = { writeScope: "workspace" };
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("a managed worker with task scope is write-capable", () => {
  const pipeline = definition();
  pipeline.roles = [{ id: "implementer", name: "Implementer", instructions: "Implement", managed: true, managedRole: "worker", candidateAgentIds: ["worker"] }];
  pipeline.steps[0].participants = ["implementer"];
  pipeline.steps.unshift(assignRole("implementer", pipeline.agents[0].id));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("ambiguous role candidates do not prove implementation authority", () => {
  const pipeline = definition();
  pipeline.agents.push({ id: "reviewer", name: "Reviewer", adapter: "claude-code", permissionMode: "plan" });
  pipeline.roles = [{ id: "implementer", name: "Implementer", instructions: "Implement", candidateAgentIds: ["worker", "reviewer"] }];
  pipeline.steps[0].participants = ["implementer"];
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("a configured write scope needs writable paths", () => {
  const pipeline = definition();
  pipeline.managedPolicy = { writeScope: "configured", allowedPaths: [] };
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.managedPolicy.allowedPaths = ["node_modules", ".", "../outside"];
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.managedPolicy.allowedPaths = ["src"];
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("an unmanaged browser answer is not an implementation writer", () => {
  const pipeline = definition();
  pipeline.agents[0] = { id: "browser", name: "Browser", adapter: "chatgpt-browser" };
  pipeline.steps[0].participants = ["browser"];
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.roles = [{ id: "implementer", name: "Implementer", instructions: "Implement", managed: true, managedRole: "worker", candidateAgentIds: ["browser"] }];
  pipeline.steps[0].participants = ["implementer"];
  pipeline.steps.unshift(assignRole("implementer", pipeline.agents[0].id));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("transcript parsing retains authoritative step IDs without manufacturing them for older entries", () => {
  const entry = { id: "answer", kind: "answer", text: "Participant response", createdAt: "2026-09-14T00:00:00.000Z", stepId: "recorded-step", step: "Recorded name" };
  assert.equal(parseTranscriptEntry(entry).stepId, "recorded-step");
  const legacy = { ...entry };
  delete legacy.stepId;
  assert.equal(Object.hasOwn(parseTranscriptEntry(legacy), "stepId"), false);
  assert.equal(Object.hasOwn(parseTranscriptEntry({ ...entry, stepId: " " }), "stepId"), false);
  assert.equal(Object.hasOwn(parseTranscriptEntry({ ...entry, stepId: 123 }), "stepId"), false);
});

test("deterministic worker assignment proves authority with a read-only planner and reviewer", () => {
  const pipeline = assignedImplementation();
  const before = structuredClone(pipeline);
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
  assert.deepEqual(pipeline, before);
});

test("deterministic read-only assignment refuses the writable alternative candidate", () => {
  const pipeline = assignedImplementation();
  pipeline.steps[1].roleAssignments[0].agentId = "reviewer";
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("disabled assignments do not override a preceding read-only assignment", () => {
  const pipeline = assignedImplementation();
  const disabled = { ...assignRole("implementer", "worker", "disabled"), enabled: false };
  pipeline.steps[1].roleAssignments[0].agentId = "reviewer";
  pipeline.steps.splice(2, 0, disabled);
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("disabled read-only assignments do not erase a preceding writable assignment", () => {
  const pipeline = assignedImplementation();
  pipeline.steps.splice(2, 0, { ...assignRole("implementer", "reviewer", "disabled"), enabled: false });
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("a later writable binding cannot grant authority to an earlier read-only step", () => {
  const pipeline = assignedImplementation();
  pipeline.steps[1].roleAssignments[0].agentId = "reviewer";
  pipeline.steps.push(assignRole("implementer", "worker", "later"));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("a later read-only binding cannot erase authority used by an earlier implementation step", () => {
  const pipeline = assignedImplementation();
  pipeline.steps.push(assignRole("implementer", "reviewer", "later"));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("the latest enabled binding before the implementation step controls its authority", () => {
  const pipeline = assignedImplementation();
  pipeline.steps.splice(2, 0, assignRole("implementer", "reviewer", "reassign"));
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.steps[2].roleAssignments[0].agentId = "worker";
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
});

test("an unresolved mixed role remains refused when its assignment is disabled", () => {
  const pipeline = assignedImplementation();
  pipeline.steps[1].enabled = false;
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  assert.match(pipelineImplementationRefusal(pipeline), /invalid workflow definition/u);
});

test("a role cannot use an assignment that follows its invocation", () => {
  const pipeline = assignedImplementation();
  const assignment = pipeline.steps.splice(1, 1)[0];
  pipeline.steps.push(assignment);
  assert.match(pipelineImplementationRefusal(pipeline), /invalid workflow definition/u);
});

test("assignment alone never makes an unused writable agent an implementation participant", () => {
  const pipeline = assignedImplementation();
  pipeline.steps[2].enabled = false;
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("deterministic assignment does not override read-only roles or managed Lead authority", () => {
  const pipeline = assignedImplementation();
  pipeline.roles[0].readOnly = true;
  pipeline.steps[2].permissionModes = { implementer: "write" };
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.roles[0].managed = true;
  pipeline.roles[0].managedRole = "lead";
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("an assigned worker must still have valid configured writable paths", () => {
  const pipeline = assignedImplementation();
  pipeline.managedPolicy = { writeScope: "configured", allowedPaths: ["node_modules", "../outside"] };
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.managedPolicy.allowedPaths = ["src"];
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
  pipeline.managedPolicy.writeScope = "readOnly";
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

test("an assigned browser participant counts only through its managed worker contract", () => {
  const pipeline = assignedImplementation();
  pipeline.agents[0] = { id: "worker", name: "Browser worker", adapter: "chatgpt-browser" };
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
  pipeline.roles[0].managed = true;
  assert.match(pipelineImplementationRefusal(pipeline), /invalid workflow definition/u);
  pipeline.roles[0].managedRole = "worker";
  assert.equal(validatePipelineDefinition(pipeline).success, true);
  assert.equal(pipelineImplementationRefusal(pipeline), undefined);
  pipeline.roles[0].readOnly = true;
  assert.match(pipelineImplementationRefusal(pipeline), /effective write authority/u);
});

for (const [name, corrupt] of [
  ["missing agents", (pipeline) => { delete pipeline.agents; }],
  ["unknown assignment target", (pipeline) => { pipeline.steps[1].roleAssignments[0].agentId = "missing"; }],
  ["unknown candidate", (pipeline) => { pipeline.roles[0].candidateAgentIds.push("missing"); }],
  ["duplicate assignment", (pipeline) => { pipeline.steps[1].roleAssignments.push({ role: "implementer", agentId: "reviewer" }); }],
  ["duplicate step identity", (pipeline) => { pipeline.steps[2].id = pipeline.steps[0].id; }],
  ["shadowed agent identity", (pipeline) => { pipeline.roles[0].id = "worker"; }],
  ["contradictory managed role", (pipeline) => { pipeline.roles[0].managedRole = "worker"; }],
  ["managed Lead without read-only declaration", (pipeline) => { pipeline.roles[0].managed = true; pipeline.roles[0].managedRole = "lead"; }],
  ["duplicate resolved participant", (pipeline) => { pipeline.steps[2].participants.push("worker"); }],
  ["invalid write scope", (pipeline) => { pipeline.managedPolicy = { writeScope: "unknown" }; }],
]) {
  test(`malformed pipeline refuses implementation authority: ${name}`, () => {
    const pipeline = assignedImplementation();
    corrupt(pipeline);
    assert.match(pipelineImplementationRefusal(pipeline), /invalid workflow definition/u);
  });
}
