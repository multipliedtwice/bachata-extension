const assert = require("node:assert/strict");
const test = require("node:test");
const { ProviderFailureError } = require("../dist/adapters/providerFailure.js");

const { executePipeline } = require("../dist/pipeline/runner.js");

const pipeline = {
  version: 1,
  id: "runner-test",
  name: "Runner test",
  agents: [
    { id: "a", name: "A", adapter: "mock", permissionMode: "read" },
    { id: "b", name: "B", adapter: "mock", permissionMode: "plan" },
  ],
  steps: [
    {
      id: "inspect",
      type: "agent",
      name: "Inspect",
      enabled: true,
      participants: ["a", "b"],
      promptTemplate: "{{userPrompt}}",
      parallel: true,
      consensus: false,
      humanGate: "none",
      attachments: "selected",
    },
    {
      id: "exchange",
      type: "agent",
      name: "Exchange",
      enabled: true,
      participants: ["a", "b"],
      promptTemplate: "peer={{peerAnswer}}",
      parallel: true,
      consensus: false,
      humanGate: "none",
    },
    {
      id: "consensus",
      type: "agent",
      name: "Consensus",
      enabled: true,
      participants: ["a", "b"],
      promptTemplate: "round peer={{peerAnswer}}",
      parallel: true,
      consensus: true,
      consensusConfig: {
        mode: "unanimous",
        maxRounds: 3,
        resultFormat: "json",
        resultField: "consensus",
        acceptedValue: true,
      },
      humanGate: "after",
    },
    {
      id: "roles",
      type: "assignRoles",
      name: "Roles",
      enabled: true,
      humanGate: "none",
      roleAssignments: [
        { agentId: "a", role: "lead" },
        { agentId: "b", role: "worker" },
      ],
    },
    {
      id: "implement",
      type: "agent",
      name: "Implement",
      enabled: true,
      participants: ["worker"],
      promptTemplate: "Implement it.",
      parallel: false,
      consensus: false,
      humanGate: "none",
      permissionModes: { worker: "write" },
    },
  ],
};

test("generic pipeline runner executes JSON order, exchanges answers, loops consensus, assigns roles, and gates", async () => {
  const calls = [];
  const gates = [];
  const roles = [];
  let consensusRound = 0;

  const result = await executePipeline(
    pipeline,
    "TASK",
    ["/tmp/screen.png"],
    async (agentId, prompt, step, options, attachments) => {
      calls.push({ agentId, prompt, step: step.id, options, attachments });
      if (step.id === "inspect") {
        return { status: "completed", answer: `inspect-${agentId}` };
      }
      if (step.id === "exchange") {
        return { status: "completed", answer: `exchange-${agentId}` };
      }
      if (step.id === "consensus") {
        if (agentId === "a") {
          consensusRound += 1;
        }
        return {
          status: "completed",
          answer: JSON.stringify({
            consensus: consensusRound >= 2,
            answer: `round-${consensusRound}`,
          }),
        };
      }
      return { status: "completed", answer: `implemented-${agentId}` };
    },
    {
      onStep: () => undefined,
      onRoles: (value) => roles.push(value),
      waitForHumanGate: async (request) => {
        gates.push(request);
        return { action: "continue" };
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.roles, { lead: "a", worker: "b" });
  assert.equal(roles.length, 1);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].reason, "afterStep");

  const inspectCalls = calls.filter((call) => call.step === "inspect");
  assert.equal(inspectCalls.length, 2);
  assert.equal(inspectCalls[0].prompt, "TASK");
  assert.deepEqual(inspectCalls[0].attachments, ["/tmp/screen.png"]);
  assert.deepEqual(inspectCalls[1].attachments, ["/tmp/screen.png"]);

  const exchangeA = calls.find(
    (call) => call.step === "exchange" && call.agentId === "a",
  );
  const exchangeB = calls.find(
    (call) => call.step === "exchange" && call.agentId === "b",
  );
  assert.equal(exchangeA.prompt, "peer=inspect-b");
  assert.equal(exchangeB.prompt, "peer=inspect-a");
  assert.deepEqual(exchangeA.attachments, []);

  const consensusCalls = calls.filter((call) => call.step === "consensus");
  assert.equal(consensusCalls.length, 4);
  const implementation = calls.find((call) => call.step === "implement");
  assert.equal(implementation.agentId, "b");
  assert.equal(implementation.options.permissionMode, "write");
});

test("generic pipeline runner stops after an interrupted participant", async () => {
  const calls = [];
  const result = await executePipeline(
    {
      ...pipeline,
      steps: pipeline.steps.slice(0, 2),
    },
    "TASK",
    [],
    async (agentId, _prompt, step) => {
      calls.push({ agentId, step: step.id });
      return {
        status: step.id === "inspect" && agentId === "a" ? "interrupted" : "completed",
        answer: agentId,
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );
  assert.equal(result.status, "interrupted");
  assert.equal(calls.some((call) => call.step === "exchange"), false);
});

test("human gate can skip a step", async () => {
  const calls = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "gate",
      name: "Gate",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "one",
      type: "agent",
          name: "One",
          enabled: true,
          participants: ["a"],
          promptTemplate: "one",
          parallel: false,
          consensus: false,
          humanGate: "before",
        },
        {
          id: "two",
      type: "agent",
          name: "Two",
          enabled: true,
          participants: ["a"],
          promptTemplate: "two",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (_agentId, prompt) => {
      calls.push(prompt);
      return { status: "completed", answer: prompt };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "skip" }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["two"]);
});


test("parallel answers are exchanged in declared participant order", async () => {
  const prompts = [];
  const orderedPipeline = {
    version: 1,
    id: "ordered",
    name: "Ordered",
    agents: [
      { id: "a", name: "A", adapter: "mock" },
      { id: "b", name: "B", adapter: "mock" },
      { id: "c", name: "C", adapter: "mock" },
    ],
    steps: [
      {
        id: "inspect",
      type: "agent",
        name: "Inspect",
        enabled: true,
        participants: ["a", "b", "c"],
        promptTemplate: "inspect",
        parallel: true,
        consensus: false,
        humanGate: "none",
      },
      {
        id: "exchange",
      type: "agent",
        name: "Exchange",
        enabled: true,
        participants: ["a"],
        promptTemplate: "{{peerAnswers}}",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
    ],
  };

  await executePipeline(
    orderedPipeline,
    "TASK",
    [],
    async (agentId, prompt, step) => {
      if (step.id === "inspect") {
        const delay = agentId === "b" ? 30 : agentId === "c" ? 5 : 15;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return { status: "completed", answer: agentId.toUpperCase() };
      }
      prompts.push(prompt);
      return { status: "completed", answer: "done" };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );

  assert.deepEqual(prompts, ["B\n\nC"]);
});

test("runner rejects multiple role participants resolving to one agent", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "duplicate-resolved",
        name: "Duplicate resolved",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            id: "roles",
      type: "assignRoles",
            name: "Roles",
            enabled: true,
            humanGate: "none",
            roleAssignments: [
              { agentId: "a", role: "lead" },
              { agentId: "a", role: "reviewer" },
            ],
          },
          {
            id: "review",
      type: "agent",
            name: "Review",
            enabled: true,
            participants: ["lead", "reviewer"],
            promptTemplate: "review",
            parallel: true,
            consensus: false,
            humanGate: "none",
          },
        ],
      },
      "TASK",
      [],
      async () => ({ status: "completed", answer: "done" }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
      },
    ),
    /resolves more than one participant to the same agent/,
  );
});

test("after-step gates reject skip decisions", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "after-gate",
        name: "After gate",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            id: "one",
      type: "agent",
            name: "One",
            enabled: true,
            participants: ["a"],
            promptTemplate: "one",
            parallel: false,
            consensus: false,
            humanGate: "after",
          },
        ],
      },
      "TASK",
      [],
      async () => ({ status: "completed", answer: "done" }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async (request) => {
          assert.deepEqual(request.allowedActions, ["continue", "rerunStep", "rollback", "cancel"]);
          return { action: "skip" };
        },
      },
    ),
    /Action skip is not allowed for afterStep/,
  );
});

test("attachments are routed only to steps that explicitly select them", async () => {
  const received = [];
  await executePipeline(
    {
      version: 1,
      id: "attachments",
      name: "Attachments",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "plain",
      type: "agent",
          name: "Plain",
          enabled: true,
          participants: ["a"],
          promptTemplate: "plain",
          parallel: false,
          consensus: false,
          humanGate: "none",
          attachments: "none",
        },
        {
          id: "selected",
      type: "agent",
          name: "Selected",
          enabled: true,
          participants: ["a"],
          promptTemplate: "selected",
          parallel: false,
          consensus: false,
          humanGate: "none",
          attachments: "selected",
        },
      ],
    },
    "TASK",
    ["/tmp/screen.png"],
    async (_agentId, _prompt, step, _options, attachments) => {
      received.push({ step: step.id, attachments });
      return { status: "completed", answer: step.id };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );
  assert.deepEqual(received, [
    { step: "plain", attachments: [] },
    { step: "selected", attachments: ["/tmp/screen.png"] },
  ]);
});

test("discarding invalid consensus does not leak invalid answers", async () => {
  const prompts = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "discard-invalid-consensus",
      name: "Discard invalid consensus",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
      ],
      steps: [
        {
          type: "agent",
          id: "consensus",
          name: "Consensus",
          enabled: true,
          participants: ["a", "b"],
          promptTemplate: "consensus",
          parallel: true,
          consensus: true,
          consensusConfig: {
            mode: "unanimous",
            maxRounds: 1,
            resultFormat: "json",
            resultField: "consensus",
            acceptedValue: true,
          },
          humanGate: "none",
        },
        {
          type: "agent",
          id: "next",
          name: "Next",
          enabled: true,
          participants: ["a"],
          promptTemplate: "peer={{peerAnswer}}|previous={{previousAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (_agentId, prompt, step) => {
      if (step.id === "consensus") {
        return { status: "completed", answer: "not json" };
      }
      prompts.push(prompt);
      return { status: "completed", answer: "done" };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async (request) => {
        assert.equal(request.reason, "invalidConsensus");
        return { action: "discardStep" };
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(prompts, ["peer=|previous="]);
  assert.deepEqual(result.answers.consensus, {});
});

test("invalid consensus cannot be accepted as raw output", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "reject-raw-consensus",
        name: "Reject raw consensus",
        agents: [
          { id: "a", name: "A", adapter: "mock" },
          { id: "b", name: "B", adapter: "mock" },
        ],
        steps: [
          {
            type: "agent",
            id: "consensus",
            name: "Consensus",
            enabled: true,
            participants: ["a", "b"],
            promptTemplate: "consensus",
            parallel: true,
            consensus: true,
            consensusConfig: {
              mode: "unanimous",
              maxRounds: 1,
              resultFormat: "json",
              resultField: "consensus",
              acceptedValue: true,
            },
            humanGate: "none",
          },
        ],
      },
      "TASK",
      [],
      async (agentId) => ({ status: "completed", answer: `raw-${agentId}` }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async (request) => {
          assert.deepEqual(request.allowedActions, ["retry", "discardStep", "cancel"]);
          return { action: "acceptRawResults" };
        },
      },
    ),
    /Action acceptRawResults is not allowed/,
  );
});

test("after-gate rerun replaces the step result before advancing", async () => {
  const calls = [];
  let gateCount = 0;
  await executePipeline(
    {
      version: 1,
      id: "rerun",
      name: "Rerun",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          type: "agent",
          id: "work",
          name: "Work",
          enabled: true,
          participants: ["a"],
          promptTemplate: "work",
          parallel: false,
          consensus: false,
          humanGate: "after",
        },
        {
          type: "agent",
          id: "next",
          name: "Next",
          enabled: true,
          participants: ["a"],
          promptTemplate: "{{previousAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (_agentId, prompt, step) => {
      calls.push({ step: step.id, prompt });
      const runs = calls.filter((call) => call.step === "work").length;
      return {
        status: "completed",
        answer: step.id === "work" ? `work-${runs}` : "done",
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => {
        gateCount += 1;
        return { action: gateCount === 1 ? "rerunStep" : "continue" };
      },
    },
  );
  assert.deepEqual(calls, [
    { step: "work", prompt: "work" },
    { step: "work", prompt: "work" },
    { step: "next", prompt: "work-2" },
  ]);
});

test("the first before-step gate does not offer rollback without a target", async () => {
  await executePipeline(
    {
      version: 1,
      id: "first-before-gate",
      name: "First before gate",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          type: "agent",
          id: "one",
          name: "One",
          enabled: true,
          participants: ["a"],
          promptTemplate: "one",
          parallel: false,
          consensus: false,
          humanGate: "before",
        },
      ],
    },
    "TASK",
    [],
    async () => ({ status: "completed", answer: "done" }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async (request) => {
        assert.deepEqual(request.allowedActions, ["continue", "skip", "cancel"]);
        assert.deepEqual(request.rollbackTargets, []);
        return { action: "continue" };
      },
    },
  );
});

test("gate intervention becomes deterministic input when the step is rerun", async () => {
  const prompts = [];
  let gateCount = 0;
  await executePipeline(
    {
      version: 1,
      id: "intervention-rerun",
      name: "Intervention rerun",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          type: "agent",
          id: "work",
          name: "Work",
          enabled: true,
          participants: ["a"],
          promptTemplate: "work={{interventionAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "after",
        },
        {
          type: "agent",
          id: "next",
          name: "Next",
          enabled: true,
          participants: ["a"],
          promptTemplate: "{{previousStepAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (_agentId, prompt, step) => {
      prompts.push({ step: step.id, prompt });
      return {
        status: "completed",
        answer: step.id === "work" ? `answer:${prompt}` : "done",
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => {
        gateCount += 1;
        if (gateCount === 1) {
          return {
            action: "rerunStep",
            interventions: [
              {
                id: "intervention-1",
                agentId: "a",
                prompt: "visual correction",
                answer: "corrected implementation",
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          };
        }
        return { action: "continue" };
      },
    },
  );
  assert.deepEqual(prompts, [
    { step: "work", prompt: "work=" },
    { step: "work", prompt: "work=corrected implementation" },
    {
      step: "next",
      prompt: "answer:work=corrected implementation",
    },
  ]);
});

test("repeat consensus uses the completed consensus answers as the next source", async () => {
  const prompts = [];
  let afterGateCount = 0;
  const runs = { a: 0, b: 0 };
  await executePipeline(
    {
      version: 1,
      id: "repeat-consensus",
      name: "Repeat consensus",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
      ],
      steps: [
        {
          type: "agent",
          id: "consensus",
          name: "Consensus",
          enabled: true,
          participants: ["a", "b"],
          promptTemplate: "peer={{peerAnswer}}",
          parallel: true,
          consensus: true,
          consensusConfig: {
            mode: "unanimous",
            maxRounds: 2,
            resultFormat: "json",
            resultField: "consensus",
            acceptedValue: true,
          },
          humanGate: "after",
        },
      ],
    },
    "TASK",
    [],
    async (agentId, prompt) => {
      prompts.push({ agentId, prompt });
      runs[agentId] += 1;
      return {
        status: "completed",
        answer: JSON.stringify({
          consensus: true,
          answer: `round-${runs[agentId]}`,
        }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => {
        afterGateCount += 1;
        return {
          action: afterGateCount === 1 ? "repeatConsensus" : "continue",
        };
      },
    },
  );
  assert.deepEqual(prompts.slice(0, 2), [
    { agentId: "a", prompt: "peer=" },
    { agentId: "b", prompt: "peer=" },
  ]);
  assert.match(prompts[2].prompt, /\"answer\":\"round-1\"/);
  assert.match(prompts[3].prompt, /\"answer\":\"round-1\"/);
});


test("retrying invalid consensus runs another round before max-round handling", async () => {
  let round = 0;
  const gates = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "retry-invalid-consensus",
      name: "Retry invalid consensus",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
      ],
      steps: [
        {
          type: "agent",
          id: "consensus",
          name: "Consensus",
          enabled: true,
          participants: ["a", "b"],
          promptTemplate: "consensus",
          parallel: true,
          consensus: true,
          consensusConfig: {
            mode: "unanimous",
            maxRounds: 1,
            resultFormat: "json",
            resultField: "consensus",
            acceptedValue: true,
          },
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (agentId) => {
      if (agentId === "a") {
        round += 1;
      }
      return {
        status: "completed",
        answer:
          round === 1
            ? "not json"
            : JSON.stringify({ consensus: true, answer: "fixed" }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async (request) => {
        gates.push(request.reason);
        return { action: "retry" };
      },
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(round, 2);
  assert.deepEqual(gates, ["invalidConsensus"]);
});

test("custom QA and UX roles can use independent agents of the same provider adapter", async () => {
  const customPipeline = {
    version: 1,
    id: "custom-specialists",
    name: "Custom specialists",
    roles: [
      {
        id: "qa",
        name: "Quality Assurance",
        instructions: "Reproduce defects and verify evidence.",
        requiredCapabilities: ["repositoryTools"],
        preferredAdapters: ["chatgpt-browser"],
      },
      {
        id: "ux",
        name: "User Experience",
        instructions: "Review interaction design and accessibility.",
        preferredAdapters: ["chatgpt-browser"],
      },
    ],
    agents: [
      { id: "gpt-qa", name: "GPT QA", adapter: "chatgpt-browser" },
      { id: "gpt-ux", name: "GPT UX", adapter: "chatgpt-browser" },
    ],
    steps: [
      {
        id: "assign",
        type: "assignRoles",
        name: "Assign specialists",
        enabled: true,
        humanGate: "none",
        roleAssignments: [
          { role: "qa", agentId: "gpt-qa" },
          { role: "ux", agentId: "gpt-ux" },
        ],
      },
      {
        id: "review",
        type: "agent",
        name: "Specialist review",
        enabled: true,
        participants: ["qa", "ux"],
        promptTemplate:
          "participant={{currentParticipant}} name={{roleName}} instructions={{roleInstructions}} task={{userPrompt}}",
        parallel: true,
        consensus: false,
        humanGate: "none",
      },
    ],
  };
  const calls = [];

  const result = await executePipeline(
    customPipeline,
    "Review the settings screen",
    [],
    async (agentId, prompt, step) => {
      calls.push({ agentId, prompt, step: step.id });
      return { status: "completed", answer: `${agentId}-complete` };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.roles, { qa: "gpt-qa", ux: "gpt-ux" });
  assert.equal(calls.length, 2);
  const qa = calls.find((call) => call.agentId === "gpt-qa");
  const ux = calls.find((call) => call.agentId === "gpt-ux");
  assert.match(qa.prompt, /^Role: Quality Assurance \(qa\)/);
  assert.match(qa.prompt, /Reproduce defects and verify evidence\./);
  assert.equal(
    qa.prompt.match(/Reproduce defects and verify evidence\./g)?.length,
    1,
  );
  assert.match(qa.prompt, /participant=qa name=Quality Assurance/);
  assert.match(ux.prompt, /^Role: User Experience \(ux\)/);
  assert.match(ux.prompt, /Review interaction design and accessibility\./);
  assert.equal(
    ux.prompt.match(/Review interaction design and accessibility\./g)?.length,
    1,
  );
  assert.match(ux.prompt, /participant=ux name=User Experience/);
});

test("contradictory accepted candidates do not count as unanimous consensus", async () => {
  const decisions = [];
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "contradictory",
        name: "Contradictory",
        agents: [
          { id: "a", name: "A", adapter: "mock" },
          { id: "b", name: "B", adapter: "mock" },
        ],
        steps: [
          {
            id: "decision",
            type: "agent",
            name: "Decision",
            enabled: true,
            participants: ["a", "b"],
            promptTemplate: "decide",
            parallel: true,
            consensus: true,
            consensusConfig: {
              mode: "unanimous",
              maxRounds: 1,
              candidateField: "candidate",
              acceptedField: "accepted",
              onMaxRounds: "fail",
            },
            humanGate: "none",
          },
        ],
      },
      "TASK",
      [],
      async (agentId) => ({
        status: "completed",
        answer: JSON.stringify({ accepted: true, candidate: agentId === "a" ? "Use A" : "Use B" }),
      }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        onDecision: (decision) => decisions.push(decision),
        waitForHumanGate: async () => ({ action: "cancel" }),
      },
    ),
    /maximum rounds/,
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "pending");
  assert.notEqual(decisions[0].participants[0].candidateHash, decisions[0].participants[1].candidateHash);
});

test("typed step output is validated and exposed by name", async () => {
  const outputs = [];
  const prompts = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "typed-output",
      name: "Typed output",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "produce",
          type: "agent",
          name: "Produce",
          enabled: true,
          participants: ["a"],
          promptTemplate: "produce",
          parallel: false,
          consensus: false,
          humanGate: "none",
          output: {
            name: "issues",
            format: "json",
            schema: {
              type: "object",
              required: ["items"],
              additionalProperties: false,
              properties: {
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        {
          id: "consume",
          type: "agent",
          name: "Consume",
          enabled: true,
          participants: ["a"],
          promptTemplate: "{{outputs.issues}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (_agentId, prompt, step) => {
      if (step.id === "produce") {
        return { status: "completed", answer: JSON.stringify({ items: ["one"] }) };
      }
      prompts.push(prompt);
      return { status: "completed", answer: "done" };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onOutput: (output) => outputs.push(output),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(outputs[0].value, { items: ["one"] });
  assert.deepEqual(outputs[0].validationErrors, []);
  assert.equal(prompts[0], '{"items":["one"]}');
});

test("invalid typed step output stops the pipeline", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "invalid-output",
        name: "Invalid output",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            id: "produce",
            type: "agent",
            name: "Produce",
            enabled: true,
            participants: ["a"],
            promptTemplate: "produce",
            parallel: false,
            consensus: false,
            humanGate: "none",
            output: {
              name: "issues",
              format: "json",
              schema: { type: "object", required: ["items"] },
            },
          },
        ],
      },
      "TASK",
      [],
      async () => ({ status: "completed", answer: JSON.stringify({ wrong: [] }) }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
      },
    ),
    /output is invalid/,
  );
});

test("configured arbiter publishes one canonical ruling", async () => {
  const decisions = [];
  let arbiterCalls = 0;
  const result = await executePipeline(
    {
      version: 1,
      id: "arbiter",
      name: "Arbiter",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
      ],
      steps: [
        {
          id: "decision",
          type: "agent",
          name: "Decision",
          enabled: true,
          participants: ["a", "b"],
          promptTemplate: "decide",
          parallel: true,
          consensus: true,
          consensusConfig: {
            mode: "arbiter",
            maxRounds: 1,
            candidateField: "candidate",
            acceptedField: "accepted",
            arbiter: "b",
            onMaxRounds: "requestArbiterRuling",
          },
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (agentId) => {
      if (agentId === "b") {
        arbiterCalls += 1;
      }
      const ruling = agentId === "b" && arbiterCalls > 1;
      return {
        status: "completed",
        answer: JSON.stringify({
          accepted: ruling,
          candidate: ruling ? "Canonical" : agentId,
        }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onDecision: (decision) => decisions.push(decision),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );
  assert.equal(result.status, "completed");
  assert.equal(decisions.at(-1).status, "ruled");
  assert.equal(decisions.at(-1).ruledBy, "b");
  assert.equal(decisions.at(-1).candidate, "Canonical");
});

// EX-G6-13. The participant list for a step is resolved once, from the role map as it stood then.
// A provider fallback reassigns the role mid-step, and the arbiter round then resolves the
// arbiter's agent fresh from the updated map while matching it against that stale list — so the
// arbiter it had just reassigned was reported as not being a participant at all, and the step
// failed. The declared identity and the agent that actually ran both have to travel.
test("an arbiter that fell back to another provider is still its step's arbiter", async () => {
  const decisions = [];
  const ran = [];
  const roleUpdates = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "arbiter-fallback",
      name: "Arbiter fallback",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
        { id: "b-standby", name: "B standby", adapter: "mock" },
      ],
      roles: [
        {
          id: "judge",
          name: "Judge",
          instructions: "",
          candidateAgentIds: ["b-standby"],
        },
      ],
      steps: [
        {
          id: "assign",
          type: "assignRoles",
          name: "Assign",
          enabled: true,
          humanGate: "none",
          roleAssignments: [{ role: "judge", agentId: "b" }],
        },
        {
          id: "decision",
          type: "agent",
          name: "Decision",
          enabled: true,
          participants: ["a", "judge"],
          promptTemplate: "decide",
          parallel: false,
          consensus: true,
          consensusConfig: {
            mode: "arbiter",
            maxRounds: 1,
            candidateField: "candidate",
            acceptedField: "accepted",
            arbiter: "judge",
            onMaxRounds: "requestArbiterRuling",
          },
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (agentId) => {
      ran.push(agentId);
      if (agentId === "b") {
        // The declared agent for the judge role is out of quota, which is a fallback-eligible
        // failure with no side effects.
        throw new ProviderFailureError({
          code: "quotaExhausted",
          message: "B is out of quota",
          provider: "mock",
          resourceId: "mock",
          sideEffects: "none",
        });
      }
      const ruling = agentId === "b-standby" && ran.filter((id) => id === "b-standby").length > 1;
      return {
        status: "completed",
        answer: JSON.stringify({
          accepted: ruling,
          candidate: ruling ? "Canonical" : agentId,
        }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: (roles) => roleUpdates.push({ ...roles }),
      onDecision: (decision) => decisions.push(decision),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(result.status, "completed", result.error ?? "");
  assert.deepEqual(roleUpdates.at(-1), { judge: "b-standby" }, "the role was never reassigned");
  assert.equal(decisions.at(-1).status, "ruled");
  assert.equal(
    decisions.at(-1).ruledBy,
    "b-standby",
    "the ruling was attributed to the provider that did not run it",
  );
});

// EX-A5-R14. Two halves of the same mistake: what a step knows about who ran is fixed before
// the step runs, and a provider fallback changes it mid-flight.
//
// The arbiter round resolves its agent from the role map and then reads that round's result back
// under the same name. When the fallback happens inside the ruling itself, the agent that
// answered is the standby, and the lookup by the declared agent threw
// `Ordered run results are missing agent b` — the whole step failed on a fallback it had already
// performed correctly.
test("an arbiter that falls back during its own ruling still returns a ruling", async () => {
  const decisions = [];
  const ran = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "arbiter-fallback-mid-ruling",
      name: "Arbiter fallback mid ruling",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
        { id: "b-standby", name: "B standby", adapter: "mock" },
      ],
      roles: [{ id: "judge", name: "Judge", instructions: "", candidateAgentIds: ["b-standby"] }],
      steps: [
        {
          id: "assign",
          type: "assignRoles",
          name: "Assign",
          enabled: true,
          humanGate: "none",
          roleAssignments: [{ role: "judge", agentId: "b" }],
        },
        {
          id: "decision",
          type: "agent",
          name: "Decision",
          enabled: true,
          participants: ["a", "judge"],
          promptTemplate: "decide",
          parallel: false,
          consensus: true,
          consensusConfig: {
            mode: "arbiter",
            maxRounds: 1,
            candidateField: "candidate",
            acceptedField: "accepted",
            arbiter: "judge",
            onMaxRounds: "requestArbiterRuling",
          },
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async (agentId) => {
      ran.push(agentId);
      // B answers the consensus round and only then runs out of quota, so the fallback happens
      // inside the arbiter round rather than before it.
      if (agentId === "b" && ran.filter((id) => id === "b").length > 1) {
        throw new ProviderFailureError({
          code: "quotaExhausted",
          message: "B is out of quota",
          provider: "mock",
          resourceId: "mock",
          sideEffects: "none",
        });
      }
      const ruling = agentId === "b-standby";
      return {
        status: "completed",
        answer: JSON.stringify({ accepted: ruling, candidate: ruling ? "Canonical" : agentId }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onDecision: (decision) => decisions.push(decision),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(result.status, "completed", result.error ?? "");
  assert.equal(ran.filter((id) => id === "b-standby").length, 1, "the standby never ran the ruling");
  assert.equal(decisions.at(-1).status, "ruled");
  assert.equal(
    decisions.at(-1).ruledBy,
    "b-standby",
    "the ruling was attributed to the provider that did not run it",
  );
});

// The other half: a step's declared output records which participant produced it, and that map
// was built from the pre-execution participant list. A fallback agent is in no such list, so its
// artifact carried no declared role at all and anything promoting by role could not find it.
test("an output produced after a fallback still carries its declared role", async () => {
  const outputs = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "output-fallback",
      name: "Output fallback",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "a-standby", name: "A standby", adapter: "mock" },
      ],
      roles: [{ id: "worker", name: "Worker", instructions: "", candidateAgentIds: ["a-standby"] }],
      steps: [
        {
          id: "assign",
          type: "assignRoles",
          name: "Assign",
          enabled: true,
          humanGate: "none",
          roleAssignments: [{ role: "worker", agentId: "a" }],
        },
        {
          id: "plan",
          type: "agent",
          name: "Plan",
          enabled: true,
          participants: ["worker"],
          promptTemplate: "plan",
          parallel: false,
          consensus: false,
          humanGate: "none",
          output: {
            name: "plan",
            schema: {
              type: "object",
              required: ["summary"],
              properties: { summary: { type: "string" } },
              additionalProperties: false,
            },
          },
        },
      ],
    },
    "TASK",
    [],
    async (agentId) => {
      if (agentId === "a") {
        throw new ProviderFailureError({
          code: "quotaExhausted",
          message: "A is out of quota",
          provider: "mock",
          resourceId: "mock",
          sideEffects: "none",
        });
      }
      return { status: "completed", answer: JSON.stringify({ summary: "the plan" }) };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onOutput: (artifact) => outputs.push(artifact),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
    undefined,
    undefined,
    undefined,
  );
  assert.equal(result.status, "completed", result.error ?? "");
  assert.equal(outputs.length, 1, JSON.stringify(outputs));
  assert.equal(outputs[0].agentId, "a-standby");
  assert.equal(
    outputs[0].participant,
    "worker",
    "a fallback agent's artifact lost the role it was produced for",
  );
});

test("checklist step validates issues and persists user selection with free text", async () => {
  const outputs = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "checklist-runner",
      name: "Checklist runner",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          type: "agent",
          id: "review",
          name: "Review",
          enabled: true,
          participants: ["a"],
          promptTemplate: "{{userPrompt}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
        {
          type: "checklist",
          id: "prepare-execution",
          name: "Prepare execution checklist",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Turn this into issues: {{previousStepAnswer}}",
          outputName: "execution",
          timeoutMs: 5000,
          humanGate: "none",
        },
      ],
    },
    "Review src/jobs",
    [],
    async (_agentId, prompt, step) => {
      if (step.id === "review") {
        return { status: "completed", answer: "Two confirmed issues" };
      }
      assert.match(prompt, /Two confirmed issues/);
      assert.match(prompt, /Return JSON only/);
      return {
        status: "completed",
        answer: JSON.stringify({
          issues: [
            {
              id: "ISSUE-1",
              title: "Fix cancellation",
              details: "Stop late integration",
              dependencies: [],
              paths: ["src/jobs"],
            },
            {
              id: "ISSUE-2",
              title: "Add regression coverage",
              details: "Cover the stopped run",
              dependencies: ["ISSUE-1"],
              paths: ["tests/jobs"],
            },
          ],
        }),
      };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onOutput: (artifact) => outputs.push(artifact),
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async (request) => {
        assert.equal(request.step.timeoutMs, 5000);
        assert.deepEqual(request.issues.map((issue) => issue.id), ["ISSUE-1", "ISSUE-2"]);
        return {
          selectedIssueIds: ["ISSUE-2"],
          userNote: "Keep compatibility",
          source: "user",
        };
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].value.selectedIssueIds, ["ISSUE-1", "ISSUE-2"]);
  assert.equal(outputs[0].value.userNote, "Keep compatibility");
  assert.deepEqual(result.outputs["prepare-execution"].a.value, outputs[0].value);
});

test("checklist step rejects dependency cycles", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "checklist-cycle",
        name: "Checklist cycle",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            type: "checklist",
            id: "prepare-execution",
            name: "Prepare execution checklist",
            enabled: true,
            participants: ["a"],
            promptTemplate: "Prepare issues",
            outputName: "execution",
            humanGate: "none",
          },
        ],
      },
      "Review",
      [],
      async () => ({
        status: "completed",
        answer: JSON.stringify({
          issues: [
            { id: "A", title: "A", details: "A", dependencies: ["B"], paths: ["src/a"] },
            { id: "B", title: "B", details: "B", dependencies: ["A"], paths: ["src/b"] },
          ],
        }),
      }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
        waitForExecutionChecklist: async () => ({
          selectedIssueIds: ["A", "B"],
          userNote: "",
          source: "user",
        }),
      },
    ),
    /dependency cycle/,
  );
});

test("checklist step validates issues, waits for selection, and exposes selected work", async () => {
  const outputs = [];
  const prompts = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "checklist",
      name: "Checklist",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "prepare",
          type: "checklist",
          name: "Prepare execution checklist",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Summarize {{userPrompt}}",
          outputName: "executionChecklist",
          humanGate: "none",
          attachments: "none",
        },
        {
          id: "consume",
          type: "agent",
          name: "Consume selection",
          enabled: true,
          participants: ["a"],
          promptTemplate: "{{outputs.executionChecklist}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
        },
      ],
    },
    "review result",
    [],
    async (_agentId, prompt, step) => {
      if (step.id === "prepare") {
        assert.match(prompt, /Return JSON only/);
        return {
          status: "completed",
          answer: JSON.stringify({
            issues: [
              {
                id: "ISSUE-1",
                title: "Fix cancellation",
                details: "Block late repository mutations.",
                dependencies: [],
                paths: ["src/orchestrator"],
              },
              {
                id: "ISSUE-2",
                title: "Add regression coverage",
                details: "Cover cancellation behavior.",
                dependencies: ["ISSUE-1"],
                paths: ["tests"],
              },
            ],
          }),
        };
      }
      prompts.push(prompt);
      return { status: "completed", answer: "done" };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onOutput: (output) => outputs.push(output),
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async ({ issues }) => {
        assert.equal(issues.length, 2);
        return {
          selectedIssueIds: ["ISSUE-2"],
          userNote: "Keep the test focused.",
          source: "user",
        };
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].value.selectedIssueIds, ["ISSUE-1", "ISSUE-2"]);
  assert.equal(outputs[0].value.userNote, "Keep the test focused.");
  assert.match(prompts[0], /"selectedIssueIds":\["ISSUE-1","ISSUE-2"\]/);
});

test("execute checklist step delegates selected work after dependency expansion", async () => {
  const executed = [];
  const steps = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "checklist-execution",
      name: "Checklist execution",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "prepare",
          type: "checklist",
          name: "Prepare",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Prepare issues",
          outputName: "executionChecklist",
          humanGate: "none",
        },
        {
          id: "execute",
          type: "executeChecklist",
          name: "Execute selected work",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
          retries: 1,
          maxConcurrency: 2,
        },
      ],
    },
    "Review",
    [],
    async () => ({
      status: "completed",
      answer: JSON.stringify({
        issues: [
          { id: "A", title: "A", details: "A", dependencies: [], paths: ["src/a"] },
          { id: "B", title: "B", details: "B", dependencies: ["A"], paths: ["src/b"] },
        ],
      }),
    }),
    {
      onStep: (step) => steps.push(step.id),
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async () => ({
        selectedIssueIds: ["B"],
        userNote: "Keep compatibility",
        source: "user",
      }),
      executeChecklist: async (request) => {
        executed.push(request);
        return {
          runRef: "RTEST",
          status: "completed",
          workingDirectory: "/tmp/worktree",
          integrationBranch: "bachata/integration/RTEST",
        };
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(steps, ["prepare", "execute"]);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].checklist.selectedIssueIds, ["A", "B"]);
  assert.equal(executed[0].checklist.userNote, "Keep compatibility");
});

test("execute checklist step completes without starting a child run when nothing is selected", async () => {
  let executions = 0;
  const result = await executePipeline(
    {
      version: 1,
      id: "empty-checklist-execution",
      name: "Empty checklist execution",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "prepare",
          type: "checklist",
          name: "Prepare",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Prepare issues",
          outputName: "executionChecklist",
          humanGate: "none",
        },
        {
          id: "execute",
          type: "executeChecklist",
          name: "Execute selected work",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          allowedPaths: ["src"],
          checks: [],
          allowNoChecks: true,
          retries: 1,
          maxConcurrency: 2,
        },
      ],
    },
    "Review",
    [],
    async () => ({
      status: "completed",
      answer: JSON.stringify({
        issues: [{ id: "A", title: "A", details: "A", dependencies: [], paths: ["src/a"] }],
      }),
    }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async () => ({
        selectedIssueIds: [],
        userNote: "",
        source: "user",
      }),
      executeChecklist: async () => {
        executions += 1;
        throw new Error("empty selection must not start orchestration");
      },
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(executions, 0);
});

test("execute checklist step interrupts when the child TODO run stops", async () => {
  const result = await executePipeline(
    {
      version: 1,
      id: "stopped-checklist-execution",
      name: "Stopped checklist execution",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "prepare",
          type: "checklist",
          name: "Prepare",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Prepare issues",
          outputName: "executionChecklist",
          humanGate: "none",
        },
        {
          id: "execute",
          type: "executeChecklist",
          name: "Execute selected work",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
        },
      ],
    },
    "Review",
    [],
    async () => ({
      status: "completed",
      answer: JSON.stringify({
        issues: [{ id: "A", title: "A", details: "A", dependencies: [], paths: ["src/a"] }],
      }),
    }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async () => ({
        selectedIssueIds: ["A"],
        userNote: "",
        source: "user",
      }),
      executeChecklist: async () => ({
        runRef: "RSTOP",
        status: "stopped",
        workingDirectory: "/tmp/worktree",
      }),
    },
  );

  assert.equal(result.status, "interrupted");
});

test("checklist step rejects duplicate ids and dependency cycles", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "invalid-checklist",
        name: "Invalid checklist",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            id: "prepare",
            type: "checklist",
            name: "Prepare",
            enabled: true,
            participants: ["a"],
            promptTemplate: "prepare",
            outputName: "executionChecklist",
            humanGate: "none",
          },
        ],
      },
      "TASK",
      [],
      async () => ({
        status: "completed",
        answer: JSON.stringify({
          issues: [
            {
              id: "ISSUE-1",
              title: "One",
              details: "One",
              dependencies: ["ISSUE-2"],
              paths: ["src/one"],
            },
            {
              id: "ISSUE-2",
              title: "Two",
              details: "Two",
              dependencies: ["ISSUE-1"],
              paths: ["src/two"],
            },
          ],
        }),
      }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
        waitForExecutionChecklist: async () => ({
          selectedIssueIds: [],
          userNote: "",
          source: "user",
        }),
      },
    ),
    /dependency cycle/,
  );
});

test("checklist output rejects model-generated verification commands", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "checklist-command-rejection",
        name: "Checklist command rejection",
        agents: [{ id: "a", name: "A", adapter: "mock" }],
        steps: [
          {
            id: "prepare",
            type: "checklist",
            name: "Prepare",
            enabled: true,
            participants: ["a"],
            promptTemplate: "Prepare issues",
            outputName: "executionChecklist",
            humanGate: "none",
          },
        ],
      },
      "Review",
      [],
      async () => ({
        status: "completed",
        answer: JSON.stringify({
          issues: [
            {
              id: "ISSUE_A",
              title: "Fix A",
              details: "Fix it.",
              dependencies: [],
              paths: ["src/a.ts"],
              checks: ["rm -rf ."],
            },
          ],
        }),
      }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
        waitForExecutionChecklist: async () => ({
          selectedIssueIds: ["ISSUE_A"],
          userNote: "",
          source: "user",
        }),
      },
    ),
    /checks|additional/u,
  );
});

test("resuming a pending checklist reuses the exact checkpointed issues", async () => {
  const checklistPipeline = {
    version: 1,
    id: "checkpointed-checklist",
    name: "Checkpointed checklist",
    agents: [{ id: "a", name: "A", adapter: "mock" }],
    steps: [
      {
        id: "prepare",
        type: "checklist",
        name: "Prepare",
        enabled: true,
        participants: ["a"],
        promptTemplate: "Prepare issues",
        outputName: "executionChecklist",
        humanGate: "none",
      },
    ],
  };
  let modelCalls = 0;
  let checkpoint;
  await assert.rejects(
    executePipeline(
      checklistPipeline,
      "Review",
      [],
      async () => {
        modelCalls += 1;
        return {
          status: "completed",
          answer: JSON.stringify({
            issues: [
              {
                id: "ISSUE_A",
                title: "Fix A",
                details: "Exact persisted issue.",
                dependencies: [],
                paths: ["src/a.ts"],
              },
            ],
          }),
        };
      },
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        onCheckpoint: async (value) => {
          checkpoint = structuredClone(value);
        },
        waitForHumanGate: async () => ({ action: "continue" }),
        waitForExecutionChecklist: async () => {
          throw new Error("simulated restart");
        },
      },
    ),
    /simulated restart/u,
  );
  assert.equal(modelCalls, 1);
  assert.deepEqual(checkpoint.snapshot.pendingChecklists.prepare.issues, [
    {
      id: "ISSUE_A",
      title: "Fix A",
      details: "Exact persisted issue.",
      dependencies: [],
      paths: ["src/a.ts"],
    },
  ]);

  const result = await executePipeline(
    checklistPipeline,
    "Review",
    [],
    async () => {
      modelCalls += 1;
      throw new Error("model must not be called after resume");
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async ({ issues }) => {
        assert.deepEqual(issues, checkpoint.snapshot.pendingChecklists.prepare.issues);
        return {
          selectedIssueIds: ["ISSUE_A"],
          userNote: "",
          source: "user",
        };
      },
    },
    undefined,
    checkpoint,
  );
  assert.equal(result.status, "completed");
  assert.equal(modelCalls, 1);
});

test("resuming rejects a corrupted pending checklist before user approval", async () => {
  const checklistPipeline = {
    version: 1,
    id: "corrupted-checklist",
    name: "Corrupted checklist",
    agents: [{ id: "a", name: "A", adapter: "mock" }],
    steps: [
      {
        id: "prepare",
        type: "checklist",
        name: "Prepare",
        enabled: true,
        participants: ["a"],
        promptTemplate: "Prepare issues",
        outputName: "executionChecklist",
        humanGate: "none",
      },
    ],
  };
  const checkpoint = {
    version: 1,
    nextStepIndex: 0,
    snapshot: {
      roles: {},
      answers: {},
      latestAnswers: {},
      previousStepAnswers: { order: [], values: {} },
      latestInterventions: { order: [], values: {} },
      outputs: {},
      decisions: {},
      namedOutputs: {},
      pendingChecklists: {
        prepare: {
          agentId: "a",
          answer: "persisted",
          issues: [
            {
              id: "ISSUE/A",
              title: "Invalid persisted issue",
              details: "This id must not be accepted after restart.",
              dependencies: [],
              paths: ["src/a.ts"],
            },
          ],
        },
      },
    },
  };
  let interactionCalls = 0;
  await assert.rejects(
    executePipeline(
      checklistPipeline,
      "Review",
      [],
      async () => {
        throw new Error("model must not be called for a pending checklist");
      },
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
        waitForExecutionChecklist: async () => {
          interactionCalls += 1;
          return { selectedIssueIds: [], userNote: "", source: "user" };
        },
      },
      undefined,
      checkpoint,
    ),
    /saved checklist is invalid/u,
  );
  assert.equal(interactionCalls, 0);
});

test("resumed before-step gates advertise only restorable rollback targets", async () => {
  const rollbackPipeline = {
    version: 1,
    id: "restart-rollback-targets",
    name: "Restart rollback targets",
    agents: [{ id: "a", name: "A", adapter: "mock" }],
    steps: [
      {
        id: "first",
        type: "agent",
        name: "First",
        enabled: true,
        participants: ["a"],
        promptTemplate: "first",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
      {
        id: "second",
        type: "agent",
        name: "Second",
        enabled: true,
        participants: ["a"],
        promptTemplate: "second",
        parallel: false,
        consensus: false,
        humanGate: "before",
      },
    ],
  };
  let checkpoint;
  let firstCalls = 0;
  await assert.rejects(
    executePipeline(
      rollbackPipeline,
      "Task",
      [],
      async (_agentId, prompt) => {
        firstCalls += 1;
        return { status: "completed", answer: prompt };
      },
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        onCheckpoint: async (value) => {
          checkpoint = structuredClone(value);
        },
        waitForHumanGate: async () => {
          throw new Error("simulated restart before gate");
        },
      },
    ),
    /simulated restart before gate/u,
  );
  assert.equal(firstCalls, 1);
  assert.equal(checkpoint.nextStepIndex, 1);

  const result = await executePipeline(
    rollbackPipeline,
    "Task",
    [],
    async (_agentId, prompt) => ({ status: "completed", answer: prompt }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async (request) => {
        assert.deepEqual(request.rollbackTargets, []);
        assert.deepEqual(request.allowedActions, ["continue", "skip", "cancel"]);
        return { action: "continue" };
      },
    },
    undefined,
    checkpoint,
  );
  assert.equal(result.status, "completed");
});

test("a timed-out execution checklist interrupts before orchestration", async () => {
  let executed = false;
  const result = await executePipeline(
    {
      version: 1,
      id: "checklist-timeout",
      name: "Checklist timeout",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          id: "prepare",
          type: "checklist",
          name: "Prepare",
          enabled: true,
          participants: ["a"],
          promptTemplate: "Prepare issues",
          outputName: "executionChecklist",
          humanGate: "none",
        },
        {
          id: "execute",
          type: "executeChecklist",
          name: "Execute",
          enabled: true,
          inputName: "executionChecklist",
          pipelineId: "worker",
          allowedPaths: ["src"],
          checks: ["npm test"],
          humanGate: "none",
        },
      ],
    },
    "Review",
    [],
    async () => ({
      status: "completed",
      answer: JSON.stringify({
        issues: [
          {
            id: "ISSUE_A",
            title: "Fix A",
            details: "Fix it.",
            dependencies: [],
            paths: ["src/a.ts"],
          },
        ],
      }),
    }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
      waitForExecutionChecklist: async () => ({
        selectedIssueIds: ["ISSUE_A"],
        userNote: "",
        source: "timeout",
      }),
      executeChecklist: async () => {
        executed = true;
        return { runRef: "run", summary: "executed" };
      },
    },
  );

  assert.equal(result.status, "interrupted");
  assert.equal(executed, false);
});
