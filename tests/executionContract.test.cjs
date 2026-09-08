const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildExecutionContract,
  executionSafetyLevel,
} = require("../dist/contract/executionContract.js");

const reviewPipeline = require("../presets/codex-review.pipeline.json");
const todoPipeline = require("../presets/todo-implementation.pipeline.json");
const masterPipeline = require("../presets/todo-master.pipeline.json");

const checklistPipeline = {
  version: 1,
  id: "checklist-run",
  name: "Checklist run",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" }],
  steps: [
    {
      id: "plan",
      name: "Plan",
      enabled: true,
      humanGate: "after",
      type: "checklist",
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      outputName: "checklist",
    },
    {
      id: "execute",
      name: "Execute",
      enabled: true,
      humanGate: "none",
      type: "executeChecklist",
      inputName: "checklist",
      pipelineId: "todo-implementation",
      allowedPaths: ["src", "tests"],
      checks: ["bachata:project-checks"],
      checkResources: ["port:4173"],
      retries: 1,
      maxConcurrency: 2,
    },
  ],
};

test("safety level follows what the pipeline is allowed to do", () => {
  assert.equal(executionSafetyLevel(reviewPipeline), "review");
  assert.equal(executionSafetyLevel(todoPipeline), "managed");
  assert.equal(executionSafetyLevel(masterPipeline), "review");
  assert.equal(executionSafetyLevel(checklistPipeline), "orchestration");
  assert.equal(
    executionSafetyLevel({
      version: 1,
      id: "interactive",
      name: "Interactive",
      agents: [{ id: "claude", name: "Claude", adapter: "claude-code", permissionMode: "acceptEdits" }],
      steps: [],
    }),
    "interactive",
  );
});

test("a review contract declares read-only scope and no commits", () => {
  const contract = buildExecutionContract({
    pipeline: reviewPipeline,
    maxIterations: 10,
    iterations: 1,
    workingDirectory: "/work/service",
    readiness: {
      pipelineId: "codex-review",
      status: "ready",
      findings: [{ id: "adapter.codex", label: "Codex", status: "ready", detail: "codex 1.0" }],
    },
    agentTurnTimeoutMs: 1_800_000,
    managedTaskTimeoutMs: 7_200_000,
  });

  assert.equal(contract.safetyLevel, "review");
  assert.equal(contract.scope.writeScope, "readOnly");
  assert.equal(contract.scope.workingDirectory, "/work/service");
  assert.equal(contract.commitPolicy, "never");
  assert.deepEqual(contract.verification, []);
  assert.equal(contract.limits.managedTaskTimeoutMs, undefined);
  assert.equal(contract.limits.agentTurnTimeoutMs, 1_800_000);
  assert.deepEqual(contract.providers[0].status, "ready");
  assert.equal(contract.providers[0].adapterLabel, "Codex CLI");
  assert.deepEqual(contract.blockers, []);
});

test("a managed contract declares scope, verification, fallback, and completion", () => {
  const contract = buildExecutionContract({
    pipeline: todoPipeline,
    maxIterations: 10,
    iterations: 1,
    managedTaskTimeoutMs: 7_200_000,
    browserOperationTimeoutMs: 1_800_000,
    readiness: {
      pipelineId: todoPipeline.id,
      status: "needsSetup",
      findings: [
        { id: "adapter.codex", label: "Codex", status: "ready", detail: "codex 1.0" },
        { id: "bridge.gpt-worker", label: "GPT Worker", status: "needsSetup", detail: "Connect the Browser Bridge" },
      ],
    },
  });

  assert.equal(contract.safetyLevel, "managed");
  assert.equal(contract.scope.writeScope, "task");
  assert.equal(contract.commitPolicy, "never");
  assert.deepEqual(contract.verification, ["bachata:workspace-integrity", "bachata:project-checks"]);
  assert.equal(contract.limits.maxRevisionCycles, 1);
  assert.equal(contract.limits.managedTaskTimeoutMs, 7_200_000);
  assert.equal(contract.limits.browserOperationTimeoutMs, 1_800_000);
  assert.ok(contract.fallbacks.some((entry) => entry.includes("→")));
  assert.ok(contract.completion.some((entry) => entry.includes("bachata:project-checks")));
  assert.ok(contract.completion.some((entry) => entry.includes("managed reviewer")));
  assert.deepEqual(contract.blockers, ["GPT Worker: Connect the Browser Bridge"]);
  const worker = contract.providers.find((provider) => provider.agentId === "gpt-worker");
  assert.equal(worker.status, "needsSetup");
  assert.ok(worker.roles.includes("worker"));
});

test("a checklist orchestration contract states scope, resources, and gates", () => {
  const contract = buildExecutionContract({
    pipeline: checklistPipeline,
    maxIterations: 10,
    iterations: 1,
  });
  assert.equal(contract.safetyLevel, "orchestration");
  assert.deepEqual(contract.scope.writablePaths, ["src", "tests"]);
  assert.deepEqual(contract.verification, ["bachata:project-checks"]);
  assert.deepEqual(contract.verificationResources, ["port:4173"]);
  assert.equal(contract.limits.checklistRetries, 1);
  assert.equal(contract.limits.checklistConcurrency, 2);
  assert.deepEqual(contract.humanGates, [{ stepId: "plan", stepName: "Plan", gate: "after" }]);
  assert.ok(contract.completion.some((entry) => entry.includes("human gate")));
});

test("role-level managed policy is reported as the authority the runtime applies", () => {
  const pipeline = {
    version: 1,
    id: "role-managed",
    name: "Role managed",
    agents: [
      { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "claude", name: "Claude", adapter: "claude-code", permissionMode: "acceptEdits" },
    ],
    roles: [
      {
        id: "worker",
        name: "Worker",
        instructions: "Implement",
        managed: true,
        managedRole: "worker",
        writeScope: "task",
        allowedPaths: ["src"],
        readPaths: ["docs"],
        protectedPaths: ["policy"],
        commitMode: "allow",
        verificationChecks: [{ id: "project", command: "bachata:project-checks" }],
        candidateAgentIds: ["claude"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        instructions: "Review",
        managed: true,
        managedRole: "lead",
        managedOptional: true,
        readOnly: true,
      },
    ],
    steps: [
      {
        id: "assign",
        name: "Assign",
        enabled: true,
        humanGate: "none",
        type: "assignRoles",
        roleAssignments: [{ role: "worker", agentId: "claude" }],
      },
    ],
  };

  const contract = buildExecutionContract({ pipeline, maxIterations: 10, iterations: 1 });

  assert.equal(contract.safetyLevel, "managed");
  assert.equal(contract.scope.writeScope, "task");
  assert.equal(contract.commitPolicy, "allow");
  assert.deepEqual(contract.scope.writablePaths, ["src"]);
  assert.deepEqual(contract.scope.readablePaths, ["docs"]);
  assert.deepEqual(contract.scope.protectedPaths, ["policy"]);

  const worker = contract.roles.find((role) => role.id === "worker");
  assert.equal(worker.managed, true);
  assert.equal(worker.writeScope, "task");
  assert.equal(worker.commitPolicy, "allow");
  assert.deepEqual(worker.verification, ["bachata:project-checks"]);
  assert.deepEqual(worker.candidateAgentIds, ["claude"]);

  const reviewer = contract.roles.find((role) => role.id === "reviewer");
  assert.equal(reviewer.readOnly, true);
  assert.equal(reviewer.optional, true);
  assert.equal(reviewer.writeScope, "readOnly");
  assert.equal(reviewer.commitPolicy, "never");
});

test("mixed managed policy and role checks show exactly what the runner executes", () => {
  const roleCheck = { id: "workspace", command: "bachata:workspace-integrity" };
  const policyCheck = { id: "project", command: "bachata:project-checks" };
  const pipelineWith = (managedPolicy, roleChecks) => ({
    version: 1,
    id: "mixed-verification",
    name: "Mixed verification",
    ...(managedPolicy ? { managedPolicy } : {}),
    agents: [{ id: "claude", name: "Claude", adapter: "claude-code", permissionMode: "acceptEdits" }],
    roles: [{
      id: "worker",
      name: "Worker",
      instructions: "Implement",
      managed: true,
      managedRole: "worker",
      ...(roleChecks ? { verificationChecks: roleChecks } : {}),
    }],
    steps: [],
  });

  const overridden = buildExecutionContract({
    pipeline: pipelineWith(
      { writeScope: "task", commitMode: "never", verificationChecks: [policyCheck] },
      [roleCheck],
    ),
    maxIterations: 10,
    iterations: 1,
  });
  assert.deepEqual(overridden.verification, ["bachata:project-checks"]);
  assert.deepEqual(overridden.roles[0].verification, ["bachata:project-checks"]);
  assert.ok(
    overridden.completion.includes("Controller verification passes: bachata:project-checks"),
    "completion criteria promised checks the runner does not execute",
  );

  const roleOnly = buildExecutionContract({
    pipeline: pipelineWith({ writeScope: "task", commitMode: "never" }, [roleCheck]),
    maxIterations: 10,
    iterations: 1,
  });
  assert.deepEqual(roleOnly.verification, ["bachata:workspace-integrity"]);
  assert.deepEqual(roleOnly.roles[0].verification, ["bachata:workspace-integrity"]);

  const policyOnly = buildExecutionContract({
    pipeline: pipelineWith(
      { writeScope: "task", commitMode: "never", verificationChecks: [policyCheck] },
      undefined,
    ),
    maxIterations: 10,
    iterations: 1,
  });
  assert.deepEqual(policyOnly.verification, ["bachata:project-checks"]);
});

test("until-clean runs state their completion rule", () => {
  const contract = buildExecutionContract({
    pipeline: reviewPipeline,
    maxIterations: 10,
    iterations: 4,
    iterationMode: "untilClean",
    requiredCleanPasses: 3,
  });
  assert.equal(contract.limits.requiredCleanPasses, 3);
  assert.ok(contract.completion.some((entry) => entry.includes("3 consecutive iterations")));
});

test("every contract states one assurance label derived from what it actually declares", () => {
  const { buildExecutionContract, executionAssurance } = require("../dist/contract/executionContract.js");

  assert.equal(
    executionAssurance({ safetyLevel: "review", writeScope: "readOnly", verification: [], crossChecked: true }),
    "readOnly",
  );
  assert.equal(
    executionAssurance({ safetyLevel: "interactive", writeScope: "workspace", verification: [], crossChecked: true }),
    "modelReviewed",
  );
  assert.equal(
    executionAssurance({ safetyLevel: "interactive", writeScope: "workspace", verification: [], crossChecked: false }),
    "unverified",
  );
  assert.equal(
    executionAssurance({
      safetyLevel: "managed",
      writeScope: "configured",
      verification: ["bachata:project-checks"],
      crossChecked: true,
    }),
    "controllerVerified",
  );
  assert.equal(
    executionAssurance({
      safetyLevel: "orchestration",
      writeScope: "task",
      verification: ["bachata:project-checks"],
      crossChecked: true,
    }),
    "isolatedApplicable",
  );

  const fs = require("node:fs");
  const path = require("node:path");
  const presets = path.join(__dirname, "..", "presets");
  const expected = {
    "review-only.pipeline.json": "readOnly",
    "managed-fix.pipeline.json": "controllerVerified",
    "debug.pipeline.json": "modelReviewed",
    "paired-managed-fix.pipeline.json": "isolatedApplicable",
  };
  Object.entries(expected).forEach(([file, assurance]) => {
    const pipeline = JSON.parse(fs.readFileSync(path.join(presets, file), "utf8"));
    const contract = buildExecutionContract({ pipeline, maxIterations: 10 });
    assert.equal(contract.assurance, assurance, `${file} resolved to ${contract.assurance}`);
    assert.ok(contract.assuranceStatement.length > 0);
    assert.doesNotMatch(contract.assuranceStatement, /accepted work/u);
  });
});

test("the contract discloses the whole run budget, not only its timeouts", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const debugPipeline = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "debug.pipeline.json"), "utf8"),
  );
  const contract = buildExecutionContract({ pipeline: debugPipeline, maxIterations: 10, iterations: 1 });
  assert.equal(
    contract.limits.maxConsensusRounds,
    undefined,
    "a blended consensus bound is still exported, so a consumer can restate the old misreport",
  );
  assert.equal(contract.limits.consensusRoundsExtendable, undefined);
  assert.equal(contract.limits.consensusRoundLimitRetryable, undefined);
  assert.equal(
    contract.limits.participantTurnsBounded,
    false,
    "a human-extendable consensus step means the turn count is not the whole-run ceiling",
  );
  assert.equal(
    contract.limits.maxParticipantTurns,
    2 + 2 * 10 + 1 + 2 * 15,
    "the worst-case participant turn count must include every consensus round",
  );
  assert.equal(contract.provenance.extensionVersion.length > 0, true);
  assert.match(contract.provenance.pipelineHash, /^[0-9a-f]{64}$/u);
  contract.providers.forEach((provider) => {
    assert.ok(["configured", "unreported"].includes(provider.modelSource));
    assert.ok(["detected", "unreported"].includes(provider.runtimeVersionSource));
  });
});

test("an unbounded checklist pipeline says its turn count is not the whole story", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const flagship = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "paired-managed-fix.pipeline.json"), "utf8"),
  );
  const contract = buildExecutionContract({ pipeline: flagship, maxIterations: 10, iterations: 1 });
  assert.equal(contract.limits.participantTurnsBounded, false);
  assert.deepEqual(
    contract.limits.consensusSteps.map((step) => step.maxRounds),
    [4],
  );
  assert.equal(
    contract.scope.writeScope,
    "task",
    "the flagship writes only inside isolated task worktrees, so the contract must not advertise workspace authority",
  );
  assert.equal(contract.limits.checklistRetries, 1);
  assert.equal(contract.limits.checklistConcurrency, 1);
});

test("a consensus step reports that a human can always raise its round bound", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const pipeline = {
    version: 1,
    id: "bounded-consensus",
    name: "Bounded consensus",
    agents: [
      { id: "a", name: "A", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "b", name: "B", adapter: "claude-code", permissionMode: "plan" },
    ],
    steps: [{
      id: "converge",
      name: "Converge",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["a", "b"],
      promptTemplate: "x",
      parallel: true,
      consensus: true,
      consensusConfig: { mode: "unanimous", maxRounds: 3, onMaxRounds: "fail" },
    }],
  };
  const contract = buildExecutionContract({ pipeline, maxIterations: 10, iterations: 1 });
  assert.deepEqual(
    contract.limits.consensusSteps.map((step) => [step.maxRounds, step.roundLimitRetryable]),
    [[3, false]],
  );
  assert.equal(contract.limits.participantTurnsBounded, false);
  assert.equal(contract.limits.maxParticipantTurns, 6);
});

test("a pipeline with no consensus step reports a final participant-turn ceiling", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const pipeline = {
    version: 1,
    id: "single-pass",
    name: "Single pass",
    agents: [{ id: "a", name: "A", adapter: "codex-app-server", permissionMode: "readOnly" }],
    steps: [{
      id: "review",
      name: "Review",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["a"],
      promptTemplate: "x",
      parallel: false,
      consensus: false,
    }],
  };
  const contract = buildExecutionContract({ pipeline, maxIterations: 10, iterations: 2 });
  assert.deepEqual(contract.limits.consensusSteps, []);
  assert.equal(contract.limits.participantTurnsBounded, true);
  assert.equal(contract.limits.maxParticipantTurns, 2);
});

test("a consensus-only pipeline never claims checklist sub-runs it cannot start", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const { renderContractExplanation } = require("../dist/contract/explain.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const debugPipeline = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "debug.pipeline.json"), "utf8"),
  );
  const contract = buildExecutionContract({ pipeline: debugPipeline, maxIterations: 10, iterations: 1 });
  assert.equal(contract.limits.executesChecklist, false);
  const explanation = renderContractExplanation(contract);
  assert.equal(
    explanation.includes("checklist task adds one bounded sub-run"),
    false,
    "a consensus-only pipeline advertised checklist sub-runs it never starts",
  );
  assert.match(explanation, /Retrying after an invalid round grants one more/u);
  assert.match(explanation, /retrying at the round limit grants another 15/u);
  assert.deepEqual(
    contract.limits.consensusSteps.map((step) => [step.stepId, step.maxRounds, step.roundLimitRetryable]),
    [["diagnosis-consensus", 10, true], ["verify", 15, true]],
    "consensus limits are not modelled per step",
  );

  const flagship = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "paired-managed-fix.pipeline.json"), "utf8"),
  );
  const checklistContract = buildExecutionContract({ pipeline: flagship, maxIterations: 10, iterations: 1 });
  assert.equal(checklistContract.limits.executesChecklist, true);
  assert.match(
    renderContractExplanation(checklistContract),
    /each checklist task adds one bounded sub-run/u,
  );
});

test("a consensus step that fails at its round limit is not advertised as retryable there", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const { renderContractExplanation } = require("../dist/contract/explain.js");
  const pipeline = {
    version: 1,
    id: "failing-consensus",
    name: "Failing consensus",
    agents: [
      { id: "a", name: "A", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "b", name: "B", adapter: "claude-code", permissionMode: "plan" },
    ],
    steps: [{
      id: "converge",
      name: "Converge",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["a", "b"],
      promptTemplate: "x",
      parallel: true,
      consensus: true,
      consensusConfig: { mode: "unanimous", maxRounds: 3, onMaxRounds: "fail" },
    }],
  };
  const contract = buildExecutionContract({ pipeline, maxIterations: 10, iterations: 1 });
  assert.deepEqual(
    contract.limits.consensusSteps.map((step) => [step.maxRounds, step.roundLimitRetryable]),
    [[3, false]],
  );
  const explanation = renderContractExplanation(contract);
  assert.match(explanation, /at the round limit this step does not offer a retry/u);
  assert.equal(
    explanation.includes("retrying at the round limit grants another"),
    false,
    "a fail-at-limit consensus step was advertised as retryable at its limit",
  );
});

test("a pipeline with two different consensus policies reports each step, not one blended bound", () => {
  const { buildExecutionContract } = require("../dist/contract/executionContract.js");
  const { renderContractExplanation } = require("../dist/contract/explain.js");
  const step = (id, name, maxRounds, onMaxRounds) => ({
    id,
    name,
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["a", "b"],
    promptTemplate: "x",
    parallel: true,
    consensus: true,
    consensusConfig: { mode: "unanimous", maxRounds, onMaxRounds },
  });
  const pipeline = {
    version: 1,
    id: "mixed-consensus",
    name: "Mixed consensus",
    agents: [
      { id: "a", name: "A", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "b", name: "B", adapter: "claude-code", permissionMode: "plan" },
    ],
    steps: [
      step("lenient", "Lenient", 9, "humanGate"),
      step("strict", "Strict", 2, "fail"),
    ],
  };
  const contract = buildExecutionContract({ pipeline, maxIterations: 10, iterations: 1 });
  assert.deepEqual(
    contract.limits.consensusSteps.map((entry) => [entry.stepId, entry.maxRounds, entry.roundLimitRetryable]),
    [["lenient", 9, true], ["strict", 2, false]],
  );
  const explanation = renderContractExplanation(contract);
  assert.match(explanation, /Consensus rounds, Lenient: at most 9 .*retrying at the round limit grants another 9/u);
  assert.match(explanation, /Consensus rounds, Strict: at most 2 .*this step does not offer a retry/u);
  assert.equal(
    /Consensus rounds, Strict: at most 2 [^\n]*grants another/u.test(explanation),
    false,
    "the strict step was advertised with the lenient step's retry policy",
  );
});
