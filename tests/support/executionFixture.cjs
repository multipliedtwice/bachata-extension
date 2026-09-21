const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { evidenceDigest } = require("../../dist/state/executionEvidence.js");
const { createLocalExecutionState } = require("../../dist/runtime/localExecutionState.js");
const { executionAllowedActions } = require("../../dist/pipeline/executionState.js");

const seed = (patch = {}) => ({
  runId: "run", taskId: "task", bundleId: "bundle", bundle: "immutable bundle",
  task: "Implement the declared change", instructions: "Obey declared scope and controller checks.",
  assignments: { planner: "lead", worker: "worker", reviewer: "lead" }, policyId: "policy",
  candidate: "c0", baseline: "baseline", checks: [{ id: "required", command: "controller-check" }], maxRevisions: 2,
  ...patch,
});
const fixture = async (t, patch = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-local-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = seed(patch);
  const controller = await createLocalExecutionState(root, input);
  return { root, input, controller };
};
const projectionFromPrompt = (prompt) => JSON.parse(prompt.split("Controller execution state:\n\n")[1].split("\n\nLatest observation")[0]);
const proposal = (state, result = "worked", operations = [{ type: "reportWork", planIds: ["p1"] }]) => ({
  version: 1, dispatchId: state.pending.id, baseRevision: state.revision,
  procedure: state.pending.procedure, operations, result: { status: result, summary: `${result} result` },
});
const planOperation = () => ({ type: "setPlan", items: [{ id: "p1", text: "Implement change" }], acceptance: ["Required behavior holds"] });
const pureState = (role = "worker") => {
  const ref = randomUUID();
  const state = {
    version: 1, projectionVersion: 1, mode: "localTodoStateV1", runId: "run", taskId: "task",
    bundleId: "bundle", bundleRef: ref, taskDigest: evidenceDigest("task"), task: "task", instructions: "instructions",
    assignments: { planner: "lead", worker: "worker", reviewer: "lead" }, revision: 0,
    phase: role === "planner" ? "planning" : role === "reviewer" ? "reviewing" : "working", candidate: "c0", baselineRef: ref, policyId: "policy",
    plan: role === "planner" ? [] : [{ id: "p1", text: "Change", status: "pending" }], acceptance: role === "planner" ? [] : ["Correct"], defects: [],
    checks: [{ id: "required", command: "check", status: "passed", candidate: "c0", evidence: ref }],
    changedPathsRef: null, pending: { id: randomUUID(), procedure: "procedure", role, agentId: role === "worker" ? "worker" : "lead", baseRevision: 0, candidate: "c0", status: "dispatched", promptRef: ref, answerRef: null },
    allowedActions: [], latestResult: "", latestAnswerRef: null, revisionsUsed: 0, repairAttempts: 0, maxRevisions: 2,
    workflowStep: "procedure", directive: null, consumedDirective: null, budgetDispatch: null, recall: [],
  };
  state.allowedActions = executionAllowedActions(state);
  return state;
};
module.exports = { seed, fixture, projectionFromPrompt, proposal, planOperation, pureState };
