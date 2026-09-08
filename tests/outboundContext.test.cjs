const assert = require("node:assert/strict");
const test = require("node:test");

const { buildOutboundContext } = require("../dist/contract/outboundContext.js");
const { buildExecutionContract } = require("../dist/contract/executionContract.js");

const reviewPipeline = () => ({
  version: 1,
  id: "codex-review",
  name: "Review code",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex", permissionMode: "readOnly" }],
  steps: [{ id: "review", name: "Review", type: "agent", enabled: true, participants: ["codex"] }],
});

const managedPipeline = () => ({
  version: 1,
  id: "browser-pair",
  name: "Browser pair",
  agents: [{ id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser", model: "browser" }],
  roles: [{
    id: "worker",
    name: "Worker",
    instructions: "Implement the task inside the declared paths.",
    managed: true,
    managedRole: "worker",
    candidateAgentIds: ["chatgpt"],
  }],
  managedPolicy: {
    writeScope: "task",
    allowedPaths: ["src"],
    readPaths: ["src", "tests"],
    protectedPaths: ["infra"],
    commitMode: "never",
  },
  steps: [{ id: "work", name: "Work", type: "agent", enabled: true, participants: ["worker"] }],
});

test("a review provider manifest names the prompt, the steps, and the attachments", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [{ name: "screen.png", mimeType: "image/png", size: 2048 }],
    promptBytes: 512,
  });
  assert.equal(manifest.agentId, "codex");
  assert.match(manifest.transport, /local provider process/u);
  const labels = manifest.entries.map((entry) => entry.label);
  assert.ok(labels.includes("Your composer message"));
  assert.ok(labels.includes("Step instructions"));
  assert.ok(labels.includes("screen.png"));
  assert.match(
    manifest.entries.find((entry) => entry.label === "Step instructions").detail,
    /Review/u,
  );
  assert.match(
    manifest.entries.find((entry) => entry.label === "Your composer message").detail,
    /0\.5 KiB/u,
  );
  assert.ok(manifest.exclusions.some((line) => line.includes("/work/repo")));
  assert.ok(manifest.exclusions.some((line) => /This participant is read-only/u.test(line) && line.includes(".bachata")));
  assert.ok(manifest.exclusions.some((line) => /does not verify that the provider applied that list/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /sandbox enforces/u.test(line)), false);
  assert.equal(manifest.exclusions.some((line) => /never read or sent/u.test(line)), false);
});

test("a read-only participant is told the exclusion is resolved before the run", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: ["infra"],
    attachments: [],
    promptBytes: 0,
  });
  const statement = manifest.exclusions.find((line) => /read-only/u.test(line));
  assert.match(statement, /explicit readable-root list/u);
  assert.match(statement, /your protected paths/u);
  assert.match(statement, /symbolic links/u);
  assert.ok(manifest.exclusions.some((line) => line.includes("Protected paths declared for this run: infra")));
});

test("a write-capable participant is told its writable root is also readable", () => {
  const pipeline = reviewPipeline();
  pipeline.agents[0].permissionMode = "workspaceWrite";
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: ["."],
    writeScope: "workspace",
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /at least one write-capable step/u.test(line)));
  assert.ok(manifest.exclusions.some((line) => /declares workspace write scope/u.test(line)));
  assert.ok(manifest.exclusions.some((line) => /writable root is also readable/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /This participant is read-only/u.test(line)), false);
});

test("a bounded writer describes its bounded roots, not the whole workspace", () => {
  const pipeline = reviewPipeline();
  pipeline.agents[0].permissionMode = "workspaceWrite";
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: ["src", "tests"],
    writeScope: "configured",
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) =>
    /This run declares bounded writable paths: src, tests/u.test(line)));
  assert.ok(manifest.exclusions.some((line) => /resolved when that step executes/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /writes inside src, tests/u.test(line)), false);
});

test("a Z.AI participant is described through the Claude boundary it actually uses", () => {
  const pipeline = reviewPipeline();
  pipeline.agents[0] = { id: "glm", name: "Z.AI GLM", adapter: "zai-glm", permissionMode: "plan" };
  pipeline.steps[0].participants = ["glm"];
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /Shell execution is denied/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /readable-root list/u.test(line)), false);
});

test("a role-keyed permission override decides the disclosure, not the agent id", () => {
  const pipeline = {
    version: 1,
    id: "role-scoped",
    name: "Role scoped",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "workspaceWrite" }],
    roles: [{ id: "reviewer", name: "Reviewer", instructions: "", readOnly: true, candidateAgentIds: ["codex"] }],
    steps: [
      { id: "assign", name: "Assign", type: "assignRoles", enabled: true, roleAssignments: [{ role: "reviewer", agentId: "codex" }] },
      {
        id: "review",
        name: "Review",
        type: "agent",
        enabled: true,
        participants: ["reviewer"],
        permissionModes: { reviewer: "readOnly", codex: "workspaceWrite" },
      },
    ],
  };
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /This participant is read-only/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /write-capable/u.test(line)), false);
});

test("a step that grants write to a read-only agent makes the participant write-capable", () => {
  const pipeline = reviewPipeline();
  pipeline.steps[0].permissionModes = { codex: "workspaceWrite" };
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /write-capable/u.test(line)));
});

test("a Claude participant is told shell is denied and tools are path-scoped", () => {
  const pipeline = reviewPipeline();
  pipeline.agents[0] = { id: "claude", name: "Claude Code", adapter: "claude-code", permissionMode: "plan" };
  pipeline.steps[0].participants = ["claude"];
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /Shell execution is denied/u.test(line)));
  assert.ok(manifest.exclusions.some((line) => /path-scoped tools that refuse/u.test(line)));
});

test("every manifest states that Bachata reads .bachata itself and sends selected pipeline instructions", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) =>
    /Bachata itself reads repository-owned configuration under \.bachata/u.test(line)));
  assert.ok(manifest.exclusions.some((line) =>
    /\.bachata\/pipelines are rendered into this prompt on purpose/u.test(line)));
});

test("a managed browser manifest states the run-time selection and its byte bounds", () => {
  const [manifest] = buildOutboundContext({
    pipeline: managedPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: ["src", "tests"],
    writablePaths: ["src"],
    protectedPaths: ["infra"],
    attachments: [],
    promptBytes: 0,
    handoffMaxBytes: 262_144,
    continuationMaxBytes: 524_288,
  });
  assert.match(manifest.transport, /browser conversation/u);
  const excerpts = manifest.entries.find((entry) => entry.kind === "repositoryFile");
  assert.equal(excerpts.exact, false);
  assert.match(excerpts.detail, /src, tests/u);
  assert.match(excerpts.detail, /256 KiB/u);
  assert.match(excerpts.detail, /512 KiB/u);
  assert.ok(manifest.entries.some((entry) => entry.label === "Role instructions: Worker"));
  assert.ok(manifest.entries.some((entry) => entry.label === "Task metadata"));
  assert.ok(manifest.exclusions.some((line) => line.includes("infra")));
});

test("redaction notes never claim outbound text is rewritten", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 10,
  });
  assert.ok(manifest.redactions.some((line) => line.includes("sent as written")));
  assert.ok(manifest.redactions.some((line) => line.includes("not in what the provider receives")));
  assert.ok(manifest.exclusions.some((line) => line.includes("no repository content is sent")));
});

test("the execution contract carries one outbound manifest per provider", () => {
  const contract = buildExecutionContract({
    pipeline: managedPipeline(),
    maxIterations: 10,
    workingDirectory: "/work/repo",
    attachments: [],
    promptBytes: 0,
  });
  assert.equal(contract.outboundContext.length, 1);
  assert.equal(contract.outboundContext[0].agentId, "chatgpt");
});

test("role assignment is read at the step where it applies, not from the final map", () => {
  const pipeline = {
    version: 1,
    id: "reassigned",
    name: "Reassigned",
    agents: [
      { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "other", name: "Other", adapter: "codex-app-server", permissionMode: "readOnly" },
    ],
    roles: [{ id: "worker", name: "Worker", instructions: "", candidateAgentIds: ["codex", "other"] }],
    steps: [
      { id: "assign-a", name: "Assign A", type: "assignRoles", enabled: true, roleAssignments: [{ role: "worker", agentId: "codex" }] },
      { id: "write", name: "Write", type: "agent", enabled: true, participants: ["worker"], permissionModes: { worker: "workspaceWrite" } },
      { id: "assign-b", name: "Assign B", type: "assignRoles", enabled: true, roleAssignments: [{ role: "worker", agentId: "other" }] },
    ],
  };
  const manifests = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  const codex = manifests.find((manifest) => manifest.agentId === "codex");
  const other = manifests.find((manifest) => manifest.agentId === "other");
  assert.ok(codex.exclusions.some((line) => /at least one write-capable step/u.test(line)));
  assert.ok(other.exclusions.some((line) => /This participant is read-only/u.test(line)));
});

test("a disabled assignRoles step never binds a role", () => {
  const pipeline = {
    version: 1,
    id: "disabled-assign",
    name: "Disabled assign",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" }],
    roles: [{ id: "worker", name: "Worker", instructions: "", candidateAgentIds: ["codex"] }],
    steps: [
      { id: "assign", name: "Assign", type: "assignRoles", enabled: false, roleAssignments: [{ role: "worker", agentId: "codex" }] },
      { id: "write", name: "Write", type: "agent", enabled: true, participants: ["worker"], permissionModes: { worker: "workspaceWrite" } },
    ],
  };
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) => /This participant is read-only/u.test(line)));
});

test("the credential statement does not claim tokens never leave the machine", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.equal(manifest.exclusions.some((line) => /never leave this machine/u.test(line)), false);
  assert.ok(manifest.exclusions.some((line) =>
    /uses them to authenticate with the provider/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /provider configuration are separate/u.test(line)), false);
});

test("task write scope never claims workspace-wide access when no path is declared yet", () => {
  const pipeline = reviewPipeline();
  pipeline.agents[0].permissionMode = "workspaceWrite";
  const [manifest] = buildOutboundContext({
    pipeline,
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    writeScope: "task",
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) =>
    /derived from the task by the controller when execution begins/u.test(line)));
  assert.ok(manifest.exclusions.some((line) => /refuses if none resolve/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /cover the working directory/u.test(line)), false);
  assert.equal(manifest.exclusions.some((line) => /declares no bounded writable path/u.test(line)), false);
});

test("the working-directory line does not present attachments as an exhaustive local list", () => {
  const [manifest] = buildOutboundContext({
    pipeline: reviewPipeline(),
    workingDirectory: "/work/repo",
    readablePaths: [],
    writablePaths: [],
    protectedPaths: [],
    attachments: [],
    promptBytes: 0,
  });
  assert.ok(manifest.exclusions.some((line) =>
    /may come from outside this working directory/u.test(line)));
  assert.equal(manifest.exclusions.some((line) => /other thing that leaves this machine/u.test(line)), false);
});
