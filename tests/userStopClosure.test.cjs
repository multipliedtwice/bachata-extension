const assert = require("node:assert/strict");
const test = require("node:test");
const { executePipeline } = require("../dist/pipeline/runner.js");
const { UserStopError } = require("../dist/runtime/userStop.js");
const pipeline = {
  version: 1, id: "stop-policy", name: "Review lease ownership",
  agents: [{ id: "worker", name: "Worker", adapter: "codex-app-server" }, { id: "lead", name: "Lead", adapter: "claude-cli" }],
  steps: [{ id: "review", type: "agent", name: "Review", enabled: true, humanGate: "none", participants: ["worker", "lead"], promptTemplate: "{{userPrompt}}", parallel: true, consensus: false }],
};
const callbacks = { onStep: () => {}, onRoles: () => {}, waitForHumanGate: async () => ({ action: "continue" }) };
const run = (controller, send, extra = {}) => executePipeline(pipeline, "Inspect the resource lease boundary", [], send, { ...callbacks, ...extra }, controller.signal);

for (const provider of ["Codex", "Claude", "Browser Bridge"]) {
  test(`${provider}: accepted stop owns a later abort-shaped provider error`, async () => {
    const controller = new AbortController();
    const result = await run(controller, async () => {
      controller.abort(new UserStopError());
      throw new Error(`${provider} request aborted`);
    });
    assert.equal(result.status, "interrupted");
  });
}

test("provider failure committed before stop remains a failure", async () => {
  const controller = new AbortController();
  await assert.rejects(run(controller, async () => { throw new Error("Provider quota exceeded"); }), /quota exceeded/);
  controller.abort(new UserStopError());
});

test("timeout errors remain failures", async () => {
  const controller = new AbortController();
  await assert.rejects(run(controller, async () => {
    controller.abort(new Error("Deadline expired"));
    throw new Error("Deadline expired");
  }), /Deadline expired/);
});

test("stop during final checkpoint wins over later completion", async () => {
  const controller = new AbortController();
  const result = await run(controller, async () => ({ status: "completed", answer: "Lease scope inspected" }), {
    onCheckpoint: () => controller.abort(new UserStopError()),
  });
  assert.equal(result.status, "interrupted");
});

test("Bachata still schedules both parallel participants", async () => {
  const controller = new AbortController();
  const starts = [];
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const result = await run(controller, async (id) => {
    starts.push(id);
    if (starts.length === 2) release();
    await bothStarted;
    return { status: "completed", answer: "Lease scope inspected" };
  });
  assert.deepEqual(starts, ["worker", "lead"]);
  assert.equal(result.status, "completed");
});
