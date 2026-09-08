const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCodexAppServerAdapter } = require("../dist/adapters/codexAppServer.js");
const { createClaudeCodeAdapter } = require("../dist/adapters/claudeCode.js");
const { executePipeline } = require("../dist/pipeline/runner.js");
const { ProviderFailureError, isProviderFailureError } = require("../dist/adapters/providerFailure.js");
const todoPreset = require("../presets/todo-implementation.pipeline.json");

const fixtures = path.join(__dirname, "fixtures");
const mockCodex = path.join(fixtures, "mock-codex.cjs");
const mockClaude = path.join(fixtures, "mock-claude.cjs");

const collectAnswer = async (adapter, request) => {
  let answer = "";
  for await (const event of adapter.send(request, new AbortController().signal)) {
    if (event.type === "text") answer += event.text;
    if (event.type === "complete" && event.text) answer = event.text;
  }
  return { status: "completed", answer };
};

test("stock TODO pipeline transitions CLI exhaustion into the managed GPT Worker and Lead review block", async () => {
  const previousCodexQuota = process.env.MOCK_CODEX_QUOTA;
  const previousClaudeQuota = process.env.MOCK_CLAUDE_QUOTA;
  process.env.MOCK_CODEX_QUOTA = "1";
  process.env.MOCK_CLAUDE_QUOTA = "1";
  const codex = createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    resourceId: "codex-cli:default-account",
    requestApproval: async () => "accept",
    log: () => undefined,
  });
  const claude = createClaudeCodeAdapter({
    command: mockClaude,
    commandTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    resourceId: "claude-code:default-account",
    log: () => undefined,
  });
  const calls = [];
  const prompts = [];
  const roleUpdates = [];
  try {
    const result = await executePipeline(
      structuredClone(todoPreset),
      "TASK",
      [],
      async (agentId, prompt, step, options) => {
        calls.push(agentId);
        prompts.push({ agentId, stepId: step.id, prompt });
        if (agentId === "gpt-worker") {
          return {
            status: "completed",
            answer: "gpt-worker:implemented",
            managedState: { state: "LEAD_REVIEW", revisionCycles: 0, maxRevisionCycles: 1 },
          };
        }
        if (agentId === "gpt-lead") {
          if (step.id === "lead-review") {
            return {
              status: "completed",
              answer: "gpt-lead:approved",
              managedState: { state: "FINALIZE", revisionCycles: 0, maxRevisionCycles: 1 },
            };
          }
          return { status: "completed", answer: "gpt-lead:plan" };
        }
        const request = {
          sessionId: `fallback-${agentId}`,
          prompt,
          workingDirectory: os.tmpdir(),
          attachments: [],
          permissionMode: options.permissionMode,
          approvalPolicy: options.approvalPolicy,
        };
        return collectAnswer(agentId === "codex" ? codex : claude, request);
      },
      {
        onStep: () => undefined,
        onRoles: (roles) => roleUpdates.push({ ...roles }),
        waitForHumanGate: async () => ({ action: "continue" }),
      },
      undefined,
      undefined,
      { allowedPaths: ["src"], commitMode: "never" },
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(result.roles, { lead: "gpt-lead", worker: "gpt-worker", reviewer: "gpt-lead" });
    assert.deepEqual(calls, ["codex", "gpt-lead", "claude", "gpt-worker", "gpt-lead"]);
    assert.match(prompts.find((entry) => entry.stepId === "worker-implementation" && entry.agentId === "gpt-worker").prompt, /gpt-lead:plan/);
    assert.match(prompts.find((entry) => entry.stepId === "lead-review" && entry.agentId === "gpt-lead").prompt, /gpt-worker:implemented/);
    assert.equal(roleUpdates.some((roles) => roles.lead === "gpt-lead"), true);
    assert.equal(roleUpdates.at(-1).worker, "gpt-worker");
    assert.equal(roleUpdates.at(-1).reviewer, "gpt-lead");
  } finally {
    await codex.dispose();
    await claude.dispose();
    if (previousCodexQuota === undefined) delete process.env.MOCK_CODEX_QUOTA;
    else process.env.MOCK_CODEX_QUOTA = previousCodexQuota;
    if (previousClaudeQuota === undefined) delete process.env.MOCK_CLAUDE_QUOTA;
    else process.env.MOCK_CLAUDE_QUOTA = previousClaudeQuota;
  }
});

test("stock TODO pipeline can continue from unavailable ChatGPT Browser to bound Generic Worker and Lead candidates", async () => {
  const calls = [];
  const result = await executePipeline(
    structuredClone(todoPreset),
    "TASK",
    [],
    async (agentId, prompt, step) => {
      calls.push(agentId);
      if (agentId === "codex" || agentId === "claude" || agentId === "gpt-worker" || agentId === "gpt-lead") {
        throw new ProviderFailureError({
          code: "providerUnavailable",
          sideEffects: "none",
          message: `${agentId} provider unavailable`,
          provider: agentId,
          resourceId: `${agentId}:test`,
          retryable: true,
        });
      }
      if (agentId === "generic-worker") {
        return {
          status: "completed",
          answer: "generic-worker:implemented",
          managedState: { state: "LEAD_REVIEW", revisionCycles: 0, maxRevisionCycles: 1 },
        };
      }
      if (agentId === "generic-lead") {
        if (step.id === "lead-review") {
          return {
            status: "completed",
            answer: "generic-lead:approved",
            managedState: { state: "FINALIZE", revisionCycles: 0, maxRevisionCycles: 1 },
          };
        }
        return { status: "completed", answer: "generic-lead:plan" };
      }
      throw new Error(`Unexpected agent ${agentId}: ${prompt}`);
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
    undefined,
    undefined,
    { allowedPaths: ["src"], commitMode: "never" },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.roles, { lead: "generic-lead", worker: "generic-worker", reviewer: "generic-lead" });
  assert.equal(calls.includes("generic-worker"), true);
  assert.equal(calls.includes("generic-lead"), true);
});

const runRateLimitedPrimary = async (sideEffects) => {
  const calls = [];
  const roleUpdates = [];
  const run = executePipeline(
    structuredClone(todoPreset),
    "TASK",
    [],
    async (agentId, prompt, step) => {
      calls.push(agentId);
      if (agentId === "codex" || agentId === "claude" || agentId === "gpt-worker" || agentId === "gpt-lead") {
        throw new ProviderFailureError({
          code: "rateLimited",
          sideEffects,
          message: `${agentId} was rate limited`,
          provider: agentId,
          resourceId: `${agentId}:test`,
          retryable: true,
        });
      }
      if (agentId === "generic-worker") {
        return {
          status: "completed",
          answer: "generic-worker:implemented",
          managedState: { state: "LEAD_REVIEW", revisionCycles: 0, maxRevisionCycles: 1 },
        };
      }
      if (agentId === "generic-lead") {
        if (step.id === "lead-review") {
          return {
            status: "completed",
            answer: "generic-lead:approved",
            managedState: { state: "FINALIZE", revisionCycles: 0, maxRevisionCycles: 1 },
          };
        }
        return { status: "completed", answer: "generic-lead:plan" };
      }
      throw new Error(`Unexpected agent ${agentId}: ${prompt}`);
    },
    {
      onStep: () => undefined,
      onRoles: (roles) => roleUpdates.push({ ...roles }),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
    undefined,
    undefined,
    { allowedPaths: ["src"], commitMode: "never" },
  );
  return { run, calls, roleUpdates };
};

test("a rate-limited primary with no side effects still falls back to a bound alternate", async () => {
  const { run, calls } = await runRateLimitedPrimary("none");
  const result = await run;
  assert.equal(result.status, "completed");
  assert.equal(calls.includes("generic-worker"), true);
  assert.equal(calls.includes("generic-lead"), true);
});

test("a rate-limited primary that may have side effects is not retried on an alternate", async () => {
  const { run, calls, roleUpdates } = await runRateLimitedPrimary("possible");
  await assert.rejects(run, (error) => {
    assert.equal(isProviderFailureError(error), true);
    assert.equal(error.failure.code, "rateLimited");
    assert.equal(error.failure.sideEffects, "possible");
    return true;
  });
  assert.deepEqual(calls, ["codex"]);
  assert.equal(calls.includes("generic-worker"), false);
  assert.equal(calls.includes("generic-lead"), false);
  const switchedToAlternate = roleUpdates.some((roles) =>
    Object.values(roles).includes("generic-worker") || Object.values(roles).includes("generic-lead"));
  assert.equal(switchedToAlternate, false);
});
