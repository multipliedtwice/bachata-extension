const assert = require("node:assert/strict");
const test = require("node:test");

const { unattendedPipelineSafetyErrors } = require("../dist/security/unattendedPipeline.js");

const pipeline = (agentMode, stepMode) => ({
  version: 1,
  id: "todo",
  name: "TODO",
  agents: [
    {
      id: "claude",
      name: "Claude",
      adapter: "claude-code",
      ...(agentMode ? { permissionMode: agentMode } : {}),
    },
  ],
  steps: [
    {
      id: "implement",
      name: "Implement",
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["claude"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      ...(stepMode ? { permissionModes: { claude: stepMode } } : {}),
    },
  ],
});

test("unattended pipelines reject bypassPermissions on agents and steps", () => {
  assert.deepEqual(unattendedPipelineSafetyErrors(pipeline("bypassPermissions")), [
    "Agent claude uses bypassPermissions",
  ]);
  assert.deepEqual(unattendedPipelineSafetyErrors(pipeline(undefined, "bypassPermissions")), [
    "Step implement participant claude uses bypassPermissions",
  ]);
  assert.deepEqual(unattendedPipelineSafetyErrors(pipeline("acceptEdits", "acceptEdits")), []);
});
