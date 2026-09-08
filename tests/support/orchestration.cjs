// Shared orchestration fixtures. One definition of the repository, pipeline and conversation
// doubles that both the TODO controller tests and the self-improvement tests drive.
const { execFileSync } = require("node:child_process");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const { createTodoOrchestrator } = require("../../dist/orchestrator/controller.js");
const { createPipelineSnapshot } = require("../../dist/pipeline/identity.js");
const { evaluateGitVersionSupport } = require("../../dist/process/gitVersionSupport.js");

const todoMasterDefinition = require("../../presets/todo-master.pipeline.json");
const todoImplementationDefinition = require("../../presets/todo-implementation.pipeline.json");
const selfImprovementDefinition = require("../../presets/self-improvement.pipeline.json");
const selfImprovementReviewDefinition = require("../../presets/self-improvement-review.pipeline.json");
const selfImprovementRevisionDefinition = require("../../presets/self-improvement-revision.pipeline.json");
const selfImprovementDiscoveryDefinition = require("../../presets/self-improvement-discovery.pipeline.json");
const selfImprovementConvergenceDefinition = require("../../presets/self-improvement-convergence.pipeline.json");

const definitions = {
  "todo-master": todoMasterDefinition,
  "todo-implementation": todoImplementationDefinition,
  "self-improvement": selfImprovementDefinition,
  "self-improvement-review": selfImprovementReviewDefinition,
  "self-improvement-revision": selfImprovementRevisionDefinition,
  "self-improvement-discovery": selfImprovementDiscoveryDefinition,
  "self-improvement-convergence": selfImprovementConvergenceDefinition,
};

const pipelineDefinitionFor = (pipelineId) =>
  definitions[pipelineId]
    ? structuredClone(definitions[pipelineId])
    : {
        ...structuredClone(todoImplementationDefinition),
        id: pipelineId,
        name: `Pipeline ${pipelineId}`,
      };

const pipelineSnapshotFor = (pipelineId) =>
  createPipelineSnapshot(pipelineDefinitionFor(pipelineId), "builtin");

const gitVersionSupport = (() => {
  try {
    return evaluateGitVersionSupport(execFileSync("git", ["--version"], { encoding: "utf8" }));
  } catch (error) {
    return { supported: false, requirementText: `Git is unavailable: ${String(error)}` };
  }
})();

const gitWorktreeSkip = {
  skip: gitVersionSupport.supported ? false : gitVersionSupport.requirementText,
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const createRepository = async (root, todoSource, files = {}) => {
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  git(root, "init", repository);
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.invalid");
  if (todoSource !== undefined) {
    await writeFile(path.join(repository, "TODO.md"), todoSource, "utf8");
  }
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(repository, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
  git(repository, "add", "--all");
  git(repository, "commit", "-m", "initial");
  return repository;
};

const completedPipeline = () => ({
  status: "completed",
  roles: {},
  answers: {},
  outputs: {},
  decisions: {},
});

const workerPipeline = (report) => ({
  status: "completed",
  roles: {},
  answers: { "worker-implementation": { claude: report } },
  outputs: {},
  decisions: {},
});

const masterPipeline = (decision = { status: "continue", deviations: [] }) => ({
  status: "completed",
  roles: { master: "codex" },
  answers: { "watch-execution": { codex: JSON.stringify(decision) } },
  outputs: {
    "watch-execution": {
      codex: {
        stepId: "watch-execution",
        agentId: "codex",
        name: "masterDecision",
        value: decision,
        hash: "master-hash",
        validationErrors: [],
      },
    },
  },
  decisions: {},
});

const reviewPipeline = (
  review = { verdict: "accept", summary: "Ready to integrate.", defects: [] },
) => ({
  status: "completed",
  roles: {},
  answers: { "lead-review": { codex: JSON.stringify(review) } },
  outputs: {
    "lead-review": {
      codex: {
        stepId: "lead-review",
        agentId: "codex",
        name: "taskReview",
        value: review,
        hash: "review-hash",
        validationErrors: [],
      },
    },
  },
  decisions: {},
});

const auditOf = (overrides = {}) => ({
  status: "assessed",
  inspected: ["src/value.txt"],
  findings: [{
    subject: "Retry budget",
    statement: "The budget is unbounded.",
    evidence: ["src/value.txt"],
  }],
  ...overrides,
});

// The audit step is a validated structured output per participant, so a doubled fixture must
// carry one artifact per agent exactly as the runner would.
const auditPipeline = (audits = {}) => {
  const values = {
    codex: audits.codex ?? auditOf(),
    claude: audits.claude ?? auditOf(),
  };
  const present = Object.entries(values).filter(([, value]) => value !== null);
  return {
    status: "completed",
    roles: {},
    answers: Object.fromEntries(present.map(([agentId, value]) => [
      "independent-audit",
      { [agentId]: JSON.stringify(value) },
    ])),
    outputs: {
      "independent-audit": Object.fromEntries(present.map(([agentId, value]) => [
        agentId,
        {
          stepId: "independent-audit",
          agentId,
          name: "repositoryAudit",
          value,
          hash: `audit-${agentId}`,
          validationErrors: audits.validationErrors?.[agentId] ?? [],
        },
      ])),
    },
    decisions: {},
  };
};

const convergencePipeline = (candidate, options = {}) => ({
  status: "completed",
  roles: {},
  answers: {
    "plan-convergence": { codex: JSON.stringify({ candidate, accepted: true }) },
  },
  outputs: {},
  decisions: {
    "plan-convergence": [
      {
        stepId: "plan-convergence",
        round: 1,
        policy: "arbiter",
        status: options.status ?? "accepted",
        candidateId: options.candidateId ?? "DTESTCANDIDATE001",
        candidateHash: options.candidateHash ?? "test-candidate-hash",
        candidate,
        participants: [],
        objections: [],
        unresolvedRisks: [],
      },
    ],
  },
});

const scopeResolutions = [];

const createFakeConversationManager = (
  run,
  runMaster = async () => masterPipeline(),
  resolveSnapshot = async ({ pipelineId }) => pipelineSnapshotFor(pipelineId),
  runNamed = {},
) => {
  const rooms = new Map();
  const runs = [];
  const archived = [];
  const interrupted = [];
  const closed = [];
  let sequence = 0;
  return {
    rooms,
    runs,
    archived,
    interrupted,
    closed,
    handleMessage: async () => undefined,
    attachWebview: () => ({ dispose: () => undefined }),
    getState: () => ({ conversations: [], activeConversationId: "" }),
    createConversation: async (options = {}) => {
      sequence += 1;
      const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
      let cursor = sequence;
      let suffix = "";
      while (cursor > 0) {
        suffix = `${alphabet[cursor % alphabet.length]}${suffix}`;
        cursor = Math.floor(cursor / alphabet.length);
      }
      const id = `R${suffix.padStart(8, "2")}`;
      rooms.set(id, options);
      return {
        id,
        runRef: id,
        title: options.title ?? id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      };
    },
    resolvePipelineSnapshot: async (conversationId, pipelineId, options = {}) =>
      structuredClone(await resolveSnapshot({ conversationId, pipelineId, options })),
    resolvePipelineSnapshotInScope: async (pipelineScopeRoot, pipelineId, options = {}) => {
      scopeResolutions.push({ pipelineScopeRoot, pipelineId });
      return structuredClone(await resolveSnapshot({ pipelineScopeRoot, pipelineId, options }));
    },
    configurePipelineSnapshot: async (conversationId, pipelineSnapshot) => {
      const options = rooms.get(conversationId);
      if (!options) {
        throw new Error(`Unknown conversation ${conversationId}`);
      }
      rooms.set(conversationId, {
        ...options,
        pipelineId: pipelineSnapshot.definition.id,
        pipelineSnapshot: structuredClone(pipelineSnapshot),
      });
    },
    runConversation: async (conversationId, prompt, attachmentIds = [], iterationCount = 1, runOptions = {}) => {
      const options = rooms.get(conversationId);
      const context = { conversationId, prompt, options, attachmentIds, iterationCount, runOptions };
      runs.push({
        conversationId,
        pipelineId: options?.pipelineId,
        prompt,
        workingDirectory: options?.workingDirectory,
        writeScope: runOptions.writeScope,
      });
      const named = runNamed[options?.pipelineId];
      const pipeline = options?.pipelineId === "todo-master"
        ? await runMaster(context)
        : named
          ? await named(context)
          : options?.pipelineId === "self-improvement-review"
            ? reviewPipeline()
            : await run(context);
      return { conversationId, pipeline, iterations: [pipeline] };
    },
    interruptConversation: async (conversationId) => {
      interrupted.push(conversationId);
    },
    archiveConversation: async (conversationId) => {
      archived.push(conversationId);
    },
    closeConversation: async (conversationId) => {
      closed.push(conversationId);
      rooms.delete(conversationId);
    },
    dispose: async () => undefined,
  };
};

const createController = (
  root,
  repository,
  manager,
  values = {},
  resourceBroker,
  overrides = {},
) => createTodoOrchestrator({
  storageRoot: path.join(root, "storage"),
  workspaceRoot: () => repository,
  isWorkspaceTrusted: () => true,
  configuration: () => ({
    get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback,
  }),
  output: { appendLine: () => undefined },
  manager,
  resourceBroker,
  ...overrides,
});

module.exports = {
  completedPipeline,
  createController,
  createFakeConversationManager,
  auditOf,
  auditPipeline,
  convergencePipeline,
  createRepository,
  git,
  gitVersionSupport,
  gitWorktreeSkip,
  masterPipeline,
  pipelineDefinitionFor,
  pipelineSnapshotFor,
  reviewPipeline,
  scopeResolutions,
  workerPipeline,
};
