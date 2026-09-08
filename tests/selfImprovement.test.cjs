const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  auditGateErrors,
  planRepositoryErrors,
  parseSelfImprovementPlan,
  parseSelfImprovementReview,
  renderExecutableTodo,
  selfImprovementIssues,
  buildDiscoveryPrompt,
  buildLeadReviewPrompt,
  buildRevisionPacket,
  buildWorkerPacket,
} = require("../dist/orchestrator/selfImprovement.js");
const { parseTodoDocument } = require("../dist/orchestrator/todoParser.js");
const { resolveCandidateShape } = require("../dist/pipeline/candidateShapes.js");
const { validateJsonOutput } = require("../dist/pipeline/output.js");
const { unattendedPipelineSafetyErrors } = require("../dist/security/unattendedPipeline.js");
const {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
  resolveWorkspaceWritePolicy,
} = require("../dist/adapters/workspacePolicyAudit.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");

const {
  createController,
  createFakeConversationManager,
  auditOf,
  auditPipeline,
  convergencePipeline,
  createRepository,
  git,
  gitWorktreeSkip,
  pipelineDefinitionFor,
  reviewPipeline,
  workerPipeline,
} = require("./support/orchestration.cjs");

const discoveryDefinition = pipelineDefinitionFor("self-improvement-discovery");
const convergenceDefinition = pipelineDefinitionFor("self-improvement-convergence");

const planTask = (overrides = {}) => ({
  id: "T1",
  outcome: "Bound the retry loop",
  details: "src/retry.ts retries forever; stop after the declared budget.",
  paths: ["src"],
  dependsOn: [],
  checks: ["bachata:workspace-integrity"],
  finalChecks: ["bachata:project-checks"],
  priority: 10,
  retries: 0,
  evidence: ["src/value.txt"],
  ...overrides,
});

const plan = (overrides = {}) => ({
  title: "Bound the retry loop",
  summary: "One confirmed defect in the retry path.",
  evidence: ["src/value.txt"],
  blockers: [],
  tasks: [planTask()],
  ...overrides,
});

const improveTodo = [
  "- [ ] [T1] Bound the retry loop",
  "  - Paths: src",
  "  - Verify: bachata:workspace-integrity",
  "  - Verify Final: bachata:project-checks",
  "",
].join("\n");

const writingWorker = (contents = "after\n") => async ({ options }) => {
  await writeFile(path.join(options.workingDirectory, "src", "value.txt"), contents, "utf8");
  return workerPipeline("Rewrote src/value.txt.");
};

// ---------------------------------------------------------------------------
// Plan validation, rendering, and the shapes the agents must answer in
// ---------------------------------------------------------------------------

test("convergence drops a finding no repository path supports", () => {
  const unsupported = parseSelfImprovementPlan(
    plan({ tasks: [planTask({ evidence: [] })] }),
    { retries: 1 },
  );
  assert.equal(unsupported.plan, undefined);
  assert.ok(
    unsupported.errors.some((error) => /cites no repository evidence/u.test(error)),
    unsupported.errors.join("; "),
  );

  const supported = parseSelfImprovementPlan(plan(), { retries: 1 });
  assert.deepEqual(supported.errors, []);
  assert.equal(supported.plan.tasks.length, 1);
  assert.deepEqual(supported.plan.tasks[0].evidence, ["src/value.txt"]);
});

test("a generated plan is refused before rendering when it is not executable", () => {
  const cases = [
    [plan({ tasks: [planTask({ id: "1bad id" })] }), /tasks\[0\]\.id must match/u],
    [plan({ tasks: [planTask(), planTask()] }), /Duplicate generated task id/u],
    [plan({ tasks: [planTask({ dependsOn: ["missing"] })] }), /depends on unknown task/u],
    [plan({ tasks: [planTask({ dependsOn: ["T1"] })] }), /depends on itself/u],
    [plan({ tasks: [planTask({ paths: [] })] }), /declares no path scope/u],
    [plan({ tasks: [planTask({ checks: [] })] }), /declares no Verify command/u],
    [plan({ tasks: [planTask({ checks: ["npm test"] })] }), /verification command Bachata cannot name/u],
    [plan({ tasks: [planTask({ finalChecks: ["bash -c 'rm -rf /'"] })] }), /verification command Bachata cannot name/u],
    [plan({ tasks: [] }), /neither a confirmed task nor a named blocker/u],
  ];
  cases.forEach(([candidate, pattern]) => {
    const parsed = parseSelfImprovementPlan(candidate, { retries: 1 });
    assert.equal(parsed.plan, undefined, `expected refusal for ${pattern.source}`);
    assert.ok(parsed.errors.some((error) => pattern.test(error)), parsed.errors.join("; "));
  });
});

test("the rendered TODO parses back through the executable TODO parser", () => {
  const parsed = parseSelfImprovementPlan(plan(), { retries: 1 }).plan;
  const source = renderExecutableTodo(parsed, {
    pipelineId: "self-improvement",
    candidate: { repositoryRoot: "/repo", baselineCommit: "abc123" },
  });
  const document = parseTodoDocument("/repo/BACHATA_IMPROVE.md", source, {
    pipelineId: "self-improvement",
    retries: 1,
    requirePaths: true,
    requireControllerVerification: true,
  });
  assert.deepEqual(document.tasks.map((task) => task.id), ["T1"]);
  const task = document.tasks[0];
  assert.equal(task.pipelineId, "self-improvement");
  assert.deepEqual(task.paths, ["src"]);
  assert.deepEqual(task.checks, ["bachata:workspace-integrity"]);
  assert.deepEqual(task.finalChecks, ["bachata:project-checks"]);
  assert.equal(task.priority, 10);
  assert.equal(task.retries, 0);
  assert.match(source, /Evidence: src\/value\.txt/u);
  assert.match(source, /repository candidate abc123/u);
});

test("a task declaring several checks renders one Verify line per command", () => {
  const parsed = parseSelfImprovementPlan(
    plan({
      tasks: [planTask({
        checks: ["bachata:workspace-integrity", "bachata:project-checks"],
        finalChecks: ["bachata:workspace-integrity", "bachata:project-checks"],
        paths: ["src/clamp.mjs", "tests/clamp.test.mjs"],
      })],
    }),
    { retries: 1 },
  ).plan;
  const source = renderExecutableTodo(parsed, {
    pipelineId: "self-improvement",
    candidate: { repositoryRoot: "/repo", baselineCommit: "abc123" },
  });
  // The parser reads Verify one command per line; a comma-joined line is one unknown command.
  assert.equal((source.match(/^ {2}- Verify: /gmu) ?? []).length, 2);
  assert.equal((source.match(/^ {2}- Verify Final: /gmu) ?? []).length, 2);
  const task = parseTodoDocument("/repo/BACHATA_IMPROVE.md", source, {
    pipelineId: "self-improvement",
    retries: 1,
    requirePaths: true,
    requireControllerVerification: true,
  }).tasks[0];
  assert.deepEqual(task.checks, ["bachata:workspace-integrity", "bachata:project-checks"]);
  assert.deepEqual(task.finalChecks, ["bachata:workspace-integrity", "bachata:project-checks"]);
  assert.deepEqual(task.paths, ["src/clamp.mjs", "tests/clamp.test.mjs"]);
});

test("the plan and review shapes are the contract the agents are asked to answer in", () => {
  const planShape = resolveCandidateShape("selfImprovementTaskPlan");
  assert.ok(planShape);
  assert.deepEqual(validateJsonOutput(plan(), planShape, "$"), []);
  assert.ok(
    validateJsonOutput({ ...plan(), tasks: [{ ...planTask(), extra: true }] }, planShape, "$").length > 0,
    "an undeclared field must be refused",
  );

  const reviewShape = resolveCandidateShape("taskReviewVerdict");
  assert.ok(reviewShape);
  assert.deepEqual(
    validateJsonOutput({ verdict: "accept", summary: "ok", defects: [] }, reviewShape, "$"),
    [],
  );
  assert.ok(
    validateJsonOutput({ verdict: "maybe", summary: "ok", defects: [] }, reviewShape, "$").length > 0,
  );
});

test("a rejection without an actionable defect is not a usable review decision", () => {
  assert.equal(
    parseSelfImprovementReview({ verdict: "reject", summary: "no", defects: [] }).review,
    undefined,
  );
  const usable = parseSelfImprovementReview({
    verdict: "reject",
    summary: "One defect remains.",
    defects: [{
      id: "D1",
      severity: "blocker",
      statement: "The budget is still unbounded.",
      requiredChange: "Stop after spec.retries attempts.",
      evidence: ["src/retry.ts"],
    }],
  });
  assert.equal(usable.review.verdict, "reject");
  assert.equal(usable.review.defects.length, 1);
  assert.equal(parseSelfImprovementReview({ verdict: "accept" }).review, undefined);
});

// ---------------------------------------------------------------------------
// Discovery contract
// ---------------------------------------------------------------------------

test("a plan naming a verifier the repository does not declare is refused before rendering", () => {
  const candidate = parseSelfImprovementPlan(
    plan({ tasks: [planTask({ checks: ["bachata:verifier:not-declared"] })] }),
    { retries: 1 },
  ).plan;
  assert.ok(candidate, "the shape alone cannot know what the repository declares");

  const approvedWithout = planRepositoryErrors(candidate, {
    declaredVerifierIds: ["something-else"],
    repositoryVerifiersApproved: true,
    pathExists: () => true,
  });
  assert.ok(
    approvedWithout.some((error) => /\.bachata\/verifiers\.json does not declare/u.test(error)),
    approvedWithout.join("; "),
  );

  const unapproved = planRepositoryErrors(candidate, {
    declaredVerifierIds: ["not-declared"],
    repositoryVerifiersApproved: false,
    pathExists: () => true,
  });
  assert.ok(
    unapproved.some((error) => /approved no repository verifier/u.test(error)),
    unapproved.join("; "),
  );

  assert.deepEqual(
    planRepositoryErrors(candidate, {
      declaredVerifierIds: ["not-declared"],
      repositoryVerifiersApproved: true,
      pathExists: () => true,
    }),
    [],
  );
});

test("evidence must name a path the repository actually has", () => {
  const candidate = parseSelfImprovementPlan(
    plan({
      blockers: [{ subject: "s", question: "q?", evidence: ["docs/ghost.md"] }],
      tasks: [planTask({ evidence: ["src/retry.ts:12", "src/missing.ts"] })],
    }),
    { retries: 1 },
  ).plan;
  const errors = planRepositoryErrors(candidate, {
    declaredVerifierIds: [],
    repositoryVerifiersApproved: false,
    pathExists: (relative) => relative === "src/retry.ts",
  });
  assert.ok(errors.some((error) => /does not contain: src\/missing\.ts/u.test(error)), errors.join("; "));
  assert.ok(errors.some((error) => /does not contain: docs\/ghost\.md/u.test(error)), errors.join("; "));
  assert.equal(
    errors.some((error) => /src\/retry\.ts:12/u.test(error)),
    false,
    "a line reference is still a path the repository has",
  );
});

test("an accept that still names a defect is not a usable decision", () => {
  const parsed = parseSelfImprovementReview({
    verdict: "accept",
    summary: "Good enough.",
    defects: [{
      id: "D1",
      severity: "minor",
      statement: "The guard is still missing.",
      requiredChange: "Add it.",
      evidence: [],
    }],
  });
  assert.equal(parsed.review, undefined, "accept and reject cannot both be the answer");
  assert.ok(parsed.errors.some((error) => /still naming 1 defect: D1/u.test(error)), parsed.errors.join("; "));
  assert.equal(
    parseSelfImprovementReview({ verdict: "accept", summary: "Ready.", defects: [] }).review.verdict,
    "accept",
  );
});

test("both audits get one identical prompt and see no other participant's answer", () => {
  const audit = discoveryDefinition.steps[0];
  assert.deepEqual(audit.participants, ["codex", "claude"]);
  assert.equal(audit.parallel, true);
  assert.equal(audit.consensus, false);
  assert.equal(
    audit.promptTemplate,
    "{{userPrompt}}",
    "the first pass may carry nothing but the shared prompt",
  );
  assert.doesNotMatch(audit.promptTemplate, /peerAnswers/u);
  // An audit is a validated structured answer, so "no audit possible" cannot pass as completion.
  assert.equal(audit.output.shape, "repositoryAudit");
  assert.equal(
    discoveryDefinition.steps.length,
    1,
    "discovery must not converge in the same run as the audits it gates on",
  );

  const convergence = convergenceDefinition.steps[0];
  assert.equal(convergence.consensusConfig.mode, "arbiter");
  assert.equal(convergence.consensusConfig.arbiter, "codex");
  assert.equal(convergence.consensusConfig.candidateShape, "selfImprovementTaskPlan");
  assert.equal(convergence.consensusConfig.onMaxRounds, "requestArbiterRuling");
});

test("an audit that read nothing is not an audit", () => {
  const assessed = { agentId: "codex", status: "assessed", inspected: ["src/a.ts"], findings: [] };
  assert.deepEqual(auditGateErrors([assessed, { ...assessed, agentId: "claude" }]), []);

  const blocked = auditGateErrors([
    assessed,
    { agentId: "claude", status: "blocked", blockedReason: "Repository unreadable this session", inspected: [], findings: [] },
  ]);
  assert.ok(blocked.some((error) => /claude could not audit the candidate/u.test(error)), blocked.join("; "));
  assert.ok(blocked.some((error) => /Repository unreadable this session/u.test(error)), blocked.join("; "));

  const empty = auditGateErrors([assessed, { agentId: "claude", status: "assessed", inspected: [], findings: [] }]);
  assert.ok(
    empty.some((error) => /cited no repository path it read/u.test(error)),
    empty.join("; "),
  );

  const single = auditGateErrors([assessed]);
  assert.ok(single.some((error) => /needs two audits and produced 1/u.test(error)), single.join("; "));
});

test("the audit prompt names the tree to read and refuses an empty assessed answer", () => {
  const prompt = buildDiscoveryPrompt({
    candidate: {
      repositoryRoot: "/logical/repo",
      baselineCommit: "abc123",
      candidateWorktree: "/runs/R1/integration",
    },
    pipelineId: "self-improvement",
    retries: 1,
    controllerChecks: ["bachata:workspace-integrity"],
    approvedVerifierCommands: [],
  });
  assert.match(prompt, /Read this tree: \/runs\/R1\/integration/u);
  assert.match(prompt, /It is your session's working directory/u);
  assert.match(prompt, /Logical repository \(identity only, do not try to open it\): \/logical\/repo/u);
  assert.match(prompt, /"inspected":\[repository-relative paths you opened\]/u);
  assert.match(prompt, /Bachata stops discovery on a blocked audit/u);
  assert.match(prompt, /empty inspected list is refused/u);
});

test("every self-improvement preset is valid and safe for an unattended run", () => {
  ["self-improvement", "self-improvement-discovery", "self-improvement-review", "self-improvement-revision"]
    .forEach((pipelineId) => {
      const definition = pipelineDefinitionFor(pipelineId);
      const validated = validatePipelineDefinition(definition);
      assert.deepEqual(validated.errors ?? [], [], pipelineId);
      assert.deepEqual(unattendedPipelineSafetyErrors(definition), [], pipelineId);
    });
});

test("Codex leads and reviews, Claude implements and revises", () => {
  const task = pipelineDefinitionFor("self-improvement");
  assert.deepEqual(
    task.steps.find((step) => step.id === "assign-roles").roleAssignments,
    [{ agentId: "codex", role: "lead" }, { agentId: "claude", role: "worker" }],
  );
  assert.equal(
    task.agents.find((agent) => agent.id === "codex").permissionMode,
    "readOnly",
  );
  const review = pipelineDefinitionFor("self-improvement-review");
  assert.deepEqual(review.agents.map((agent) => agent.adapter), ["codex-app-server"]);
  assert.equal(review.steps[0].output.shape, "taskReviewVerdict");
  const revision = pipelineDefinitionFor("self-improvement-revision");
  assert.deepEqual(revision.agents.map((agent) => agent.adapter), ["claude-code"]);
});

test("no prompt or preset claims more containment than the runtime enforces", () => {
  const prompts = [
    buildDiscoveryPrompt({
      candidate: { repositoryRoot: "/repo", baselineCommit: "abc" },
      pipelineId: "self-improvement",
      retries: 1,
      controllerChecks: ["bachata:workspace-integrity"],
      approvedVerifierCommands: [],
    }),
    buildWorkerPacket({
      taskId: "T1",
      outcome: "o",
      details: "d",
      paths: ["src"],
      evidence: ["src/retry.ts"],
      dependencies: "None",
      checks: ["bachata:workspace-integrity"],
      worktreePath: "/w",
      integrationBranch: "b",
      attempt: 1,
      lockedDecisions: ["Nothing is committed or pushed."],
      baselineFailures: [],
    }),
    buildRevisionPacket({
      taskId: "T1",
      outcome: "o",
      details: "d",
      paths: ["src"],
      worktreePath: "/w",
      review: { verdict: "reject", summary: "s", defects: [{ id: "D1", severity: "major", statement: "s", requiredChange: "c", evidence: [] }] },
      checks: [],
    }),
    buildLeadReviewPrompt({
      taskId: "T1",
      outcome: "o",
      details: "d",
      paths: ["src"],
      candidate: { repositoryRoot: "/repo", baselineCommit: "abc" },
      taskTree: "tree",
      changedFiles: ["src/a.ts"],
      patch: "diff",
      checks: [],
      workerReport: "done",
      final: false,
    }),
    ...["self-improvement", "self-improvement-discovery", "self-improvement-convergence", "self-improvement-review", "self-improvement-revision"]
      .map((id) => JSON.stringify(pipelineDefinitionFor(id))),
  ].join("\n");
  assert.doesNotMatch(prompts, /cannot (?:launch|start|run) E2E/u);
  assert.doesNotMatch(prompts, /guarantee[sd]? (?:safe|safety)/u);
  assert.doesNotMatch(prompts, /repository tests? (?:passed|pass)/u);
  assert.match(prompts, /do not run acceptance, integration, E2E, database, Docker, browser/iu);
});

test("the worker packet carries the whole assignment in one message", () => {
  const packet = buildWorkerPacket({
    taskId: "T1",
    outcome: "Bound the retry loop",
    details: "Stop after the declared budget.",
    paths: ["src"],
    evidence: ["src/retry.ts"],
    dependencies: "None",
    checks: ["bachata:workspace-integrity"],
    worktreePath: "/w",
    integrationBranch: "bachata/integration/run",
    attempt: 1,
    lockedDecisions: ["Functional style."],
    baselineFailures: ["tests/legacy.test.cjs already fails on main"],
  });
  [
    /## What must become true/u,
    /## Source evidence this task was derived from/u,
    /## Allowed scope/u,
    /## Locked decisions/u,
    /## Checks the controller will run on your result/u,
    /## Known baseline failures/u,
    /## Stop conditions/u,
    /## Control boundary/u,
    /## Final report/u,
    /src\/retry\.ts/u,
    /tests\/legacy\.test\.cjs already fails on main/u,
  ].forEach((pattern) => assert.match(packet, pattern));
});

test("the lead review packet names the exact candidate, its checks, and its diff", () => {
  const prompt = buildLeadReviewPrompt({
    taskId: "T1",
    outcome: "Bound the retry loop",
    details: "Stop after the declared budget.",
    paths: ["src"],
    candidate: { repositoryRoot: "/repo", baselineCommit: "abc123", inputTree: "def456" },
    taskTree: "tree789",
    changedFiles: ["src/retry.ts"],
    patch: "--- a\n+++ b\n",
    checks: [{ command: "bachata:project-checks", status: "passed", exitCode: 0, stdout: "ok", stderr: "" }],
    workerReport: "Bounded the loop.",
    final: false,
  });
  [/abc123/u, /def456/u, /tree789/u, /src\/retry\.ts/u, /bachata:project-checks/u, /exit 0/u, /Bounded the loop\./u, /```diff/u]
    .forEach((pattern) => assert.match(prompt, pattern));
  assert.match(prompt, /"verdict":"accept"\|"reject"/u);
  assert.doesNotMatch(prompt, /This is the final review/u);
  assert.match(
    buildLeadReviewPrompt({
      taskId: "T1", outcome: "o", details: "d", paths: ["src"],
      candidate: { repositoryRoot: "/repo", baselineCommit: "abc" },
      taskTree: "t", changedFiles: [], patch: "", checks: [], workerReport: "", final: true,
    }),
    /This is the final review/u,
  );
});

test("an automated turn bounded to a task is refused outside a Git worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-audit-nonrepo-"));
  try {
    const request = {
      prompt: "p",
      workingDirectory: root,
      attachments: [],
      workspacePolicy: {
        readOnly: true,
        writeScope: "readOnly",
        commitMode: "never",
        automated: true,
      },
    };
    const before = await captureWorkspacePolicyAudit(request);
    assert.equal(before.isGitRepository, false);
    await assert.rejects(
      assertWorkspacePolicyAudit(request, before),
      /requires a Git worktree for authoritative post-turn validation/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The Master watches controller state from Bachata's own storage directory, which is deliberately
// not a Git worktree. Leaving its scope unset resolved to readOnly, which the audit above
// refuses, so every unattended run failed at its first Master check.
test("the Master role resolves to a scope its own working directory can satisfy", () => {
  const master = pipelineDefinitionFor("todo-master").roles.find((role) => role.id === "master");
  assert.equal(master.readOnly, true);
  const resolved = resolveWorkspaceWritePolicy({
    task: "watch execution",
    workspaceRoot: "/not/a/repository",
    writeScope: master.writeScope,
    readOnly: true,
    defaultScope: "workspace",
  });
  assert.equal(resolved.writeScope, "workspace");
  assert.equal(resolved.readOnly, true);
  assert.notEqual(resolved.writeScope, "readOnly", "a bounded scope needs a worktree the Master has not got");
});

// ---------------------------------------------------------------------------
// Controller behaviour
// ---------------------------------------------------------------------------

const improveController = async (root, repository, manager, values = {}, overrides = {}) =>
  createController(root, repository, manager, { todoRetries: 0, ...values }, undefined, overrides);

test("an executable TODO runs unchanged and never starts discovery", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-existing-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.path, "existingTodo");
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.equal(result.ledger.sourceKind, "todoFile");
    assert.equal(result.ledger.mode, "selfImprovement");
    assert.equal(result.ledger.generatedTodo, undefined);
    assert.equal(
      manager.runs.some((entry) => entry.pipelineId === "self-improvement-discovery"),
      false,
      "an executable TODO must not trigger discovery",
    );
    assert.match(
      await readFile(path.join(result.ledger.integrationWorktree, "TODO.md"), "utf8"),
      /- \[x\] \[T1\]/u,
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing TODO starts two hidden audits and executes the converged plan", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-missing-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    const order = [];
    const manager = createFakeConversationManager(
      async (context) => {
        order.push(context.options.pipelineId);
        return writingWorker()(context);
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async ({ prompt, options }) => {
          order.push("self-improvement-discovery");
          assert.match(
            options.workingDirectory,
            /integration$/u,
            "both audits must read the same checked-out candidate tree",
          );
          // The prompt must point at the tree the session is rooted at, not the logical root.
          assert.match(prompt, new RegExp(`Read this tree: ${options.workingDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
          assert.match(prompt, /Baseline commit: [0-9a-f]{40}/u);
          assert.match(prompt, /do not try to open it/u);
          return auditPipeline();
        },
        "self-improvement-convergence": async ({ prompt }) => {
          order.push("self-improvement-convergence");
          assert.match(prompt, /## First-pass audits/u);
          return convergencePipeline(plan());
        },
        "self-improvement-review": async () => {
          order.push("self-improvement-review");
          return reviewPipeline();
        },
      },
    );
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.path, "generatedPlan");
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.equal(result.ledger.sourceKind, "generatedChecklist");
    assert.equal(result.ledger.mode, "selfImprovement");
    assert.equal(result.ledger.generatedTodo.candidateHash, "test-candidate-hash");
    assert.equal(result.ledger.generatedTodo.ruling, "accepted");
    // Discovery reads the candidate and writes nothing, so the post-turn audit can prove it.
    assert.equal(
      manager.runs.find((entry) => entry.pipelineId === "self-improvement-discovery").writeScope,
      "readOnly",
    );
    assert.match(result.ledger.generatedTodo.source, /- \[ \] \[T1\]/u);
    assert.deepEqual(Object.keys(result.ledger.tasks), ["T1"]);
    assert.equal(result.ledger.tasks.T1.status, "done");
    assert.deepEqual(result.ledger.tasks.T1.spec.checks, ["bachata:workspace-integrity"]);

    assert.equal(
      manager.runs.filter((entry) => entry.pipelineId === "self-improvement-discovery").length,
      1,
      "discovery runs once per run",
    );
    assert.equal(
      order.indexOf("self-improvement-discovery") < order.indexOf("self-improvement-convergence"),
      true,
      "the audits must settle before convergence sees them",
    );
    assert.equal(
      order.indexOf("self-improvement-convergence") < order.indexOf("self-improvement"),
      true,
      "discovery must settle before any worker starts",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable second audit starts neither convergence nor a worker", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-blindaudit-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let convergences = 0;
    let workerStarts = 0;
    const manager = createFakeConversationManager(
      async () => {
        workerStarts += 1;
        return workerPipeline("should not run");
      },
      undefined,
      undefined,
      {
        // Exactly what Claude reported in the first real run: transport completed, zero bytes read.
        "self-improvement-discovery": async () => auditPipeline({
          claude: auditOf({
            status: "blocked",
            blockedReason: "Repository unreadable this session. No audit possible.",
            inspected: [],
            findings: [],
          }),
        }),
        "self-improvement-convergence": async () => {
          convergences += 1;
          return convergencePipeline(plan());
        },
      },
    );
    const controller = await improveController(root, repository, manager);
    await assert.rejects(
      controller.improve(),
      /claude could not audit the candidate: Repository unreadable this session/u,
    );
    assert.equal(convergences, 0, "a blocked audit must stop discovery before convergence");
    assert.equal(workerStarts, 0);
    assert.equal(controller.getSnapshot().run, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an audit that cites nothing it read stops discovery too", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-emptyaudit-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let convergences = 0;
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-discovery": async () => auditPipeline({
        claude: auditOf({ inspected: [], findings: [] }),
      }),
      "self-improvement-convergence": async () => {
        convergences += 1;
        return convergencePipeline(plan());
      },
    });
    const controller = await improveController(root, repository, manager);
    await assert.rejects(controller.improve(), /cited no repository path it read/u);
    assert.equal(convergences, 0);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two audits that actually read the candidate proceed to convergence", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-goodaudits-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let convergences = 0;
    let auditPrompt;
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-discovery": async ({ prompt }) => {
        auditPrompt = prompt;
        return auditPipeline();
      },
      "self-improvement-convergence": async ({ prompt }) => {
        convergences += 1;
        // Convergence sees what each participant actually read, not just its prose.
        assert.match(prompt, /### codex/u);
        assert.match(prompt, /### claude/u);
        assert.match(prompt, /Inspected: src\/value\.txt/u);
        return convergencePipeline(plan());
      },
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.equal(convergences, 1);
    assert.match(auditPrompt, /Read this tree: /u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the accepted candidate becomes the tasks, with no restating step in between", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-exact-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    const accepted = plan({
      tasks: [planTask({ id: "EXACT", outcome: "Exact outcome", details: "Exact details." })],
    });
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () => convergencePipeline(accepted, { candidateHash: "hash-of-exact" }),
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.generatedTodo.candidateHash, "hash-of-exact");
    assert.deepEqual(result.ledger.generatedTodo.tasks, accepted.tasks);
    assert.equal(result.ledger.tasks.EXACT.spec.title, "Exact outcome");
    assert.equal(result.ledger.tasks.EXACT.spec.description, "Exact details.");
    assert.equal(
      manager.runs.filter((entry) => entry.pipelineId === "self-improvement-convergence").length,
      1,
      "the controller must not ask an agent to restate the accepted candidate",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid generated plan stops before any worker starts", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-invalid-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let workerStarts = 0;
    const manager = createFakeConversationManager(
      async () => {
        workerStarts += 1;
        return workerPipeline("should not run");
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () =>
          convergencePipeline(plan({ tasks: [planTask({ checks: ["npm test"] })] })),
      },
    );
    const controller = await improveController(root, repository, manager);
    await assert.rejects(
      controller.improve(),
      /verification command Bachata cannot name: npm test/u,
    );
    assert.equal(workerStarts, 0);
    assert.equal(controller.getSnapshot().run, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan that names a human-owned decision stops before implementation", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-blocked-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let workerStarts = 0;
    const manager = createFakeConversationManager(
      async () => {
        workerStarts += 1;
        return workerPipeline("should not run");
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () => convergencePipeline(plan({
          blockers: [{
            subject: "Public product identity",
            question: "Which searchable name ships?",
            evidence: ["src/value.txt"],
          }],
        })),
      },
    );
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "blocked");
    assert.match(result.ledger.error, /Which searchable name ships\?/u);
    assert.match(result.ledger.error, /src\/value\.txt/u);
    assert.equal(workerStarts, 0, "implementation must not start while a human owns a decision");
    assert.match(result.ledger.generatedTodo.source, /Human-owned decisions/u);
    assert.equal(result.ledger.humanDecisionBlockers.length, 1);
    await controller.dispose();

    // Resuming would restart the question as work, so it is refused rather than cleared.
    const resumed = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(
      resumed.resume(),
      /stopped on a decision Bachata does not own, so it cannot be resumed/u,
    );
    assert.equal(workerStarts, 0, "resume must not start work the blocker stopped");
    await resumed.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan that is only a human-owned decision is persisted, not thrown away", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-blockeronly-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let workerStarts = 0;
    const manager = createFakeConversationManager(
      async () => {
        workerStarts += 1;
        return workerPipeline("should not run");
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () => convergencePipeline(plan({
          tasks: [],
          blockers: [{
            subject: "Distribution model",
            question: "Open source, paid local, or support-funded?",
            evidence: ["src/value.txt"],
          }],
        })),
      },
    );
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "blocked");
    assert.deepEqual(Object.keys(result.ledger.tasks), []);
    assert.equal(result.ledger.humanDecisionBlockers.length, 1);
    assert.match(result.ledger.error, /Open source, paid local, or support-funded\?/u);
    assert.equal(workerStarts, 0);
    await controller.dispose();

    // The question survives a restart of the extension, so it is not lost with the process.
    const reloaded = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(reloaded.resume(), /cannot be resumed/u);
    await reloaded.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plan naming an undeclared verifier never reaches a worker", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-badverifier-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    let workerStarts = 0;
    const manager = createFakeConversationManager(
      async () => {
        workerStarts += 1;
        return workerPipeline("should not run");
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () =>
          convergencePipeline(plan({ tasks: [planTask({ checks: ["bachata:verifier:not-declared"] })] })),
      },
    );
    const controller = await improveController(root, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    await assert.rejects(
      controller.improve(),
      /bachata:verifier:not-declared, which \.bachata\/verifiers\.json does not declare/u,
    );
    assert.equal(workerStarts, 0, "an undeclared verifier must be caught before implementation");
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing TODO.md is generated at that exact path, and its task ends up checked", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-missingtodo-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-discovery": async () => auditPipeline(),
      "self-improvement-convergence": async () => convergencePipeline(plan()),
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.equal(
      result.ledger.generatedTodoPath,
      "TODO.md",
      "a missing configured TODO is the file the human asked for and does not have",
    );

    // The controller owns this file, so an accepted task is checked off in it.
    const written = await readFile(path.join(result.ledger.integrationWorktree, "TODO.md"), "utf8");
    assert.match(written, /- \[x\] \[T1\]/u);
    assert.doesNotMatch(written, /- \[ \] \[T1\]/u);
    // The as-generated plan stays the immutable record of what was accepted.
    assert.match(result.ledger.generatedTodo.source, /- \[ \] \[T1\]/u);

    const patch = await controller.retainedRunPatch(result.ledger.runId);
    assert.match(patch, /TODO\.md/u);
    // P3. Apply needs every declared check to have passed on this candidate.
    (await controller.rerunRetainedChecks(result.ledger.runId)).forEach((check) =>
      assert.equal(check.status, "passed", check.stderr),
    );
    await controller.applyRetained(result.ledger.runId);
    const applied = await readFile(path.join(repository, "TODO.md"), "utf8");
    assert.match(applied, /- \[x\] \[T1\]/u, "the applied checklist must show the work as done");
    await assert.rejects(readFile(path.join(repository, "BACHATA_IMPROVE.md"), "utf8"), /ENOENT/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-executable TODO.md is preserved and the plan goes beside it", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-prosetodo-"));
  try {
    const prose = "# Notes\n\nProse the human still wants. Not executable.\n";
    const repository = await createRepository(root, prose, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-discovery": async () => auditPipeline(),
      "self-improvement-convergence": async () => convergencePipeline(plan()),
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.equal(result.ledger.generatedTodoPath, "BACHATA_IMPROVE.md");
    assert.equal(
      await readFile(path.join(result.ledger.integrationWorktree, "TODO.md"), "utf8"),
      prose,
      "the human's own file must survive untouched",
    );
    assert.match(
      await readFile(path.join(result.ledger.integrationWorktree, "BACHATA_IMPROVE.md"), "utf8"),
      /- \[x\] \[T1\]/u,
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a worker may not edit the controller-owned generated checklist", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-ownedfile-"));
  try {
    const repository = await createRepository(root, undefined, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(
      async ({ options }) => {
        await writeFile(path.join(options.workingDirectory, "TODO.md"), "- [x] [T1] done\n", "utf8");
        return workerPipeline("Edited the checklist.");
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => auditPipeline(),
        "self-improvement-convergence": async () =>
          convergencePipeline(plan({ tasks: [planTask({ paths: ["."] })] })),
      },
    );
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "failed");
    assert.match(result.ledger.tasks.T1.lastError, /changed controller-owned file TODO\.md/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an Improve run defaults its tasks to the review-free pipeline", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-default-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager);
    const ready = await controller.inspectImproveReadiness();
    assert.deepEqual(ready.contract.taskPipelineIds, ["self-improvement"]);
    assert.deepEqual(
      ready.taskPipelinesWithOwnSteps,
      [],
      "the default Improve task pipeline declares no review of its own",
    );
    const result = await controller.improve();
    assert.equal(result.ledger.tasks.T1.spec.pipelineId, "self-improvement");
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a task naming its own pipeline is reported, not silently claimed review-free", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-ownpipeline-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Bound the retry loop",
      "  - Paths: src",
      "  - Pipeline: todo-implementation",
      "  - Verify: bachata:workspace-integrity",
      "  - Verify Final: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager);
    const ready = await controller.inspectImproveReadiness();
    assert.deepEqual(ready.taskPipelinesWithOwnSteps, ["todo-implementation"]);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checks run before the lead review, and a rejection buys exactly one revision", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-revision-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const order = [];
    let reviews = 0;
    let revisions = 0;
    const manager = createFakeConversationManager(
      async (context) => {
        order.push("worker");
        return writingWorker("first\n")(context);
      },
      undefined,
      undefined,
      {
        "self-improvement-review": async ({ prompt }) => {
          reviews += 1;
          order.push(`review:${String(reviews)}`);
          assert.match(prompt, /## Controller check results/u);
          assert.match(prompt, /bachata:workspace-integrity/u);
          assert.match(prompt, /Status: passed/u);
          if (reviews === 1) {
            assert.doesNotMatch(prompt, /This is the final review/u);
            return reviewPipeline({
              verdict: "reject",
              summary: "The value is still wrong.",
              defects: [{
                id: "D1",
                severity: "blocker",
                statement: "src/value.txt still reads first.",
                requiredChange: "Write second instead.",
                evidence: ["src/value.txt"],
              }],
            });
          }
          assert.match(prompt, /This is the final review/u);
          return reviewPipeline();
        },
        "self-improvement-revision": async ({ prompt, options }) => {
          revisions += 1;
          order.push("revision");
          assert.match(prompt, /src\/value\.txt still reads first\./u);
          assert.match(prompt, /Write second instead\./u);
          assert.match(prompt, /only revision this task gets/u);
          await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "second\n", "utf8");
          return workerPipeline("Fixed D1.");
        },
      },
    );
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.deepEqual(order, ["worker", "review:1", "revision", "review:2"]);
    assert.equal(revisions, 1);
    assert.equal(result.ledger.tasks.T1.revisionCycles, 1);
    assert.deepEqual(
      result.ledger.tasks.T1.reviews.map((review) => `${review.phase}:${review.verdict}`),
      ["review:reject", "finalReview:accept"],
    );
    assert.equal(
      await readFile(path.join(result.ledger.integrationWorktree, "src", "value.txt"), "utf8"),
      "second\n",
      "the accepted revision must be what integrates",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exhausted revision budget fails the task honestly instead of integrating", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-exhausted-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    let reviews = 0;
    const reject = () => reviewPipeline({
      verdict: "reject",
      summary: "Still wrong.",
      defects: [{
        id: "D1",
        severity: "blocker",
        statement: "The outcome is not met.",
        requiredChange: "Meet it.",
        evidence: ["src/value.txt"],
      }],
    });
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-review": async () => {
        reviews += 1;
        return reject();
      },
      "self-improvement-revision": async () => workerPipeline("Tried again."),
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "failed");
    assert.equal(reviews, 2, "one review, one bounded revision, one final review");
    assert.equal(result.ledger.tasks.T1.status, "failed");
    assert.match(result.ledger.tasks.T1.lastError, /revision budget is exhausted/u);
    assert.match(result.ledger.tasks.T1.lastError, /The outcome is not met\./u);
    assert.equal(
      await readFile(path.join(result.ledger.integrationWorktree, "src", "value.txt"), "utf8"),
      "before\n",
      "a rejected candidate must never reach the integration tree",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run that allows no revision fails on the first rejection", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-norevision-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    let reviews = 0;
    let revisions = 0;
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-review": async () => {
        reviews += 1;
        return reviewPipeline({
          verdict: "reject",
          summary: "No.",
          defects: [{ id: "D1", severity: "major", statement: "s", requiredChange: "c", evidence: [] }],
        });
      },
      "self-improvement-revision": async () => {
        revisions += 1;
        return workerPipeline("unused");
      },
    });
    const controller = await improveController(root, repository, manager, { improveMaxRevisionCycles: 0 });
    const result = await controller.improve();
    assert.equal(result.ledger.status, "failed");
    assert.equal(reviews, 1);
    assert.equal(revisions, 0);
    assert.match(result.ledger.tasks.T1.lastError, /allows no revision/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final checks run against the integration tree and the result is retained for one Apply", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-retained-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.deepEqual(
      result.ledger.finalChecks.map((check) => `${check.command}:${check.status}`),
      ["bachata:project-checks:passed"],
    );

    const retained = controller.getSnapshot().retainedRuns;
    assert.deepEqual(retained.map((run) => run.runId), [result.ledger.runId]);
    const patch = await controller.retainedRunPatch(result.ledger.runId);
    assert.match(patch, /src\/value\.txt/u);
    assert.equal(
      await readFile(path.join(repository, "src", "value.txt"), "utf8"),
      "before\n",
      "nothing may reach the working tree before Apply",
    );
    // P3. Apply is bound to the run's declared verification: the final checks verified the
    // candidate, and the task-level check ran against a task worktree that no longer exists, so
    // Apply is refused until every declared check has passed on the candidate itself.
    await assert.rejects(
      controller.applyRetained(result.ledger.runId),
      /Required verification: bachata:workspace-integrity: not run/u,
    );
    (await controller.rerunRetainedChecks(result.ledger.runId)).forEach((check) =>
      assert.equal(check.status, "passed", check.stderr),
    );
    await controller.applyRetained(result.ledger.runId);
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "after\n");
    assert.equal(git(repository, "rev-parse", "HEAD"), git(repository, "rev-parse", "HEAD"));
    assert.equal(
      git(repository, "log", "--oneline").split("\n").length,
      1,
      "Apply must not create a commit",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CLI failure fails the task and retains resumable state", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-cli-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => {
      throw new Error("codex exited with 127");
    });
    const controller = await improveController(root, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.status, "failed");
    assert.equal(result.ledger.tasks.T1.status, "failed");
    assert.match(result.ledger.tasks.T1.lastError, /codex exited with 127/u);
    await controller.dispose();

    const resumed = createController(root, repository, manager, { todoRetries: 0 });
    const snapshot = await resumed.resumeIfAvailable();
    assert.ok(snapshot, "a failed run must stay resumable");
    await resumed.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing check fails the task before the lead is asked to review", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-checkfail-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Bound the retry loop",
      "  - Paths: src",
      "  - Verify: bachata:verifier:always-fails",
      "  - Verify Final: none",
      "",
    ].join("\n"), {
      "src/value.txt": "before\n",
      "tools/fail.mjs": "process.exit(3);\n",
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "always-fails",
          description: "A repository check that always fails",
          executable: process.execPath,
          args: ["tools/fail.mjs"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    let reviews = 0;
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-review": async () => {
        reviews += 1;
        return reviewPipeline();
      },
    });
    const controller = await improveController(root, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    const result = await controller.improve();
    assert.equal(result.ledger.status, "failed");
    assert.equal(reviews, 0, "a failing check must stop the task before the review");
    assert.match(result.ledger.tasks.T1.lastError, /bachata:verifier:always-fails/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository verifier is refused without approval and runs with it", gitWorktreeSkip, async () => {
  const source = [
    "- [ ] [T1] Bound the retry loop",
    "  - Paths: src",
    "  - Verify: bachata:verifier:consistency",
    "  - Verify Final: none",
    "",
  ].join("\n");
  const files = {
    "src/value.txt": "before\n",
    "tools/check.mjs": 'console.log("consistent");\n',
    ".bachata/verifiers.json": `${JSON.stringify({
      version: 1,
      verifiers: [{
        id: "consistency",
        description: "A benign repository check",
        executable: process.execPath,
        args: ["tools/check.mjs"],
        workingDirectory: ".",
        timeoutMs: 60_000,
        maxOutputBytes: 65_536,
        expect: { exitCode: 0 },
      }],
    }, undefined, 2)}\n`,
  };

  const refusedRoot = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-refused-"));
  try {
    const repository = await createRepository(refusedRoot, source, files);
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(refusedRoot, repository, manager);
    const result = await controller.improve();
    assert.equal(result.ledger.repositoryVerifierAuthority, "refused");
    assert.equal(result.ledger.status, "failed");
    assert.match(result.ledger.tasks.T1.lastError, /never starts one unattended without approval/u);
    await controller.dispose();
  } finally {
    await rm(refusedRoot, { recursive: true, force: true });
  }

  const approvedRoot = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-approved-"));
  try {
    const repository = await createRepository(approvedRoot, source, files);
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(approvedRoot, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    const result = await controller.improve();
    assert.equal(result.ledger.repositoryVerifierAuthority, "humanApproved");
    assert.equal(result.ledger.status, "completed", result.ledger.error ?? "");
    assert.deepEqual(
      result.ledger.tasks.T1.result.checks.map((check) => `${check.command}:${check.status}`),
      ["bachata:verifier:consistency:passed"],
    );
    await controller.dispose();
  } finally {
    await rm(approvedRoot, { recursive: true, force: true });
  }
});

test("an approved workspace still refuses a directly named E2E descriptor", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-e2e-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Bound the retry loop",
      "  - Paths: src",
      "  - Verify: bachata:verifier:acceptance",
      "  - Verify Final: none",
      "",
    ].join("\n"), {
      "src/value.txt": "before\n",
      "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "cypress run" } }),
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "acceptance",
          description: "Runs the repository acceptance suite",
          executable: "npm",
          args: ["run", "verify"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    const result = await controller.improve();
    assert.equal(result.ledger.repositoryVerifierAuthority, "humanApproved");
    assert.equal(result.ledger.status, "failed");
    assert.match(result.ledger.tasks.T1.lastError, /human-only/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bachata: Run TODO.md keeps refusing repository verifiers in an approved workspace", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-compat-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Bound the retry loop",
      "  - Paths: src",
      "  - Verify: bachata:verifier:consistency",
      "  - Verify Final: none",
      "",
    ].join("\n"), {
      "src/value.txt": "before\n",
      "tools/check.mjs": 'console.log("consistent");\n',
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "consistency",
          description: "A benign repository check",
          executable: process.execPath,
          args: ["tools/check.mjs"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    let reviews = 0;
    const manager = createFakeConversationManager(writingWorker(), undefined, undefined, {
      "self-improvement-review": async () => {
        reviews += 1;
        return reviewPipeline();
      },
    });
    const controller = await improveController(root, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    const ledger = await controller.start();
    assert.equal(ledger.mode, "todo");
    assert.equal(ledger.repositoryVerifierAuthority, "refused");
    assert.equal(ledger.status, "failed");
    assert.equal(reviews, 0, "the plain TODO run must not gain the controller review");
    assert.match(ledger.tasks.T1.lastError, /never starts one unattended without approval/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped run resumes without repeating discovery or completed work", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-resume-"));
  try {
    const repository = await createRepository(root, undefined, {
      "src/one.txt": "before\n",
      "src/two.txt": "before\n",
    });
    const twoTaskPlan = plan({
      tasks: [
        planTask({ id: "T1", paths: ["src/one.txt"], evidence: ["src/one.txt"], finalChecks: [], priority: 20 }),
        planTask({ id: "T2", paths: ["src/two.txt"], evidence: ["src/two.txt"], dependsOn: ["T1"], finalChecks: [], priority: 10 }),
      ],
    });
    let discoveries = 0;
    let controller;
    const started = [];
    const manager = createFakeConversationManager(
      async ({ options }) => {
        const taskId = options.orchestrationTaskId;
        started.push(taskId);
        const file = taskId === "T1" ? "src/one.txt" : "src/two.txt";
        await writeFile(path.join(options.workingDirectory, file), "after\n", "utf8");
        if (taskId === "T2" && started.filter((id) => id === "T2").length === 1) {
          await controller.stop();
        }
        return workerPipeline(`Wrote ${file}.`);
      },
      undefined,
      undefined,
      {
        "self-improvement-discovery": async () => {
          discoveries += 1;
          return auditPipeline({
            codex: auditOf({ inspected: ["src/one.txt", "src/two.txt"] }),
            claude: auditOf({ inspected: ["src/one.txt", "src/two.txt"] }),
          });
        },
        "self-improvement-convergence": async () => convergencePipeline(twoTaskPlan),
      },
    );
    controller = await improveController(root, repository, manager);
    const first = await controller.improve();
    assert.equal(discoveries, 1);
    assert.equal(first.ledger.tasks.T1.status, "done");
    assert.notEqual(first.ledger.status, "completed");
    await controller.dispose();

    const resumedController = createController(root, repository, manager, { todoRetries: 0 });
    const resumed = await resumedController.resume();
    assert.equal(discoveries, 1, "resume must not repeat accepted discovery");
    assert.equal(resumed.status, "completed", resumed.error ?? "");
    assert.equal(
      started.filter((id) => id === "T1").length,
      1,
      "resume must not repeat a completed task",
    );
    assert.equal(resumed.generatedTodo.candidateHash, "test-candidate-hash");
    assert.equal(resumed.tasks.T2.status, "done");
    // The controller-owned checklist is what proves completed work is not re-run.
    const checklist = await readFile(
      path.join(resumed.integrationWorktree, resumed.generatedTodoPath),
      "utf8",
    );
    assert.match(checklist, /- \[x\] \[T1\]/u);
    assert.match(checklist, /- \[x\] \[T2\]/u);
    await resumedController.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("improve readiness reports which path it would take without starting anything", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-readiness-"));
  try {
    const repository = await createRepository(root, improveTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager);
    const ready = await controller.inspectImproveReadiness();
    assert.equal(ready.todoExecutable, true);
    assert.equal(ready.repositoryVerifiers, "refused");
    assert.deepEqual(ready.bootstrapPipelineIds, [
      "self-improvement",
      "self-improvement-discovery",
      "self-improvement-convergence",
      "self-improvement-review",
      "self-improvement-revision",
    ]);
    assert.equal(controller.getSnapshot().run, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("improve readiness reports the discovery path when the TODO is not executable", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-improve-readiness-missing-"));
  try {
    const repository = await createRepository(root, "# Notes\n\nNothing executable here.\n", {
      "src/value.txt": "before\n",
    });
    const manager = createFakeConversationManager(writingWorker());
    const controller = await improveController(root, repository, manager, {}, {
      approvedRepositoryVerifiers: () => true,
    });
    const ready = await controller.inspectImproveReadiness();
    assert.equal(ready.todoExecutable, false);
    assert.match(ready.todoDiagnostic, /No checkbox tasks|declares no incomplete task/u);
    assert.equal(ready.repositoryVerifiers, "humanApproved");
    assert.equal(controller.getSnapshot().run, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
