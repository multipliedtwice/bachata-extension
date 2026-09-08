const assert = require("node:assert/strict");
const test = require("node:test");

const {
  pipelineFactIndexes,
  pipelineNameIndex,
  pipelineProviderIndex,
  providerReadinessFrom,
  providerVersionsAfter,
  requestedPipelineIds,
} = require("../dist/readiness/readinessReport.js");

test("a provider that answered is available, and its version is kept", () => {
  assert.deepEqual(
    providerReadinessFrom("codex-app-server", {
      outcome: "version",
      command: "codex",
      version: "1.2.3",
    }),
    {
      readiness: { type: "codex-app-server", available: true, detail: "codex: 1.2.3" },
      version: "1.2.3",
    },
  );
});

test("a provider missing its token is refused before anything is run, and names both ends", () => {
  const result = providerReadinessFrom("zai-glm", {
    outcome: "missingToken",
    tokenVariable: "ZAI_API_KEY",
    endpoint: "https://api.z.ai/anthropic",
  });
  assert.equal(result.readiness.available, false);
  assert.equal(
    result.readiness.detail,
    "ZAI_API_KEY is not set, so Bachata cannot reach https://api.z.ai/anthropic",
  );
  assert.equal("version" in result, false);
});

test("a probe that did not answer reports why and claims no version", () => {
  assert.deepEqual(
    providerReadinessFrom("claude-code", {
      outcome: "failed",
      command: "claude",
      error: new Error("ENOENT"),
    }).readiness,
    { type: "claude-code", available: false, detail: "claude unavailable: ENOENT" },
  );
  assert.match(
    providerReadinessFrom("claude-code", { outcome: "failed", command: "claude", error: "gone" })
      .readiness.detail,
    /claude unavailable: gone/u,
  );
});

test("a version nobody just confirmed is dropped rather than left standing", () => {
  assert.deepEqual(
    providerVersionsAfter({ "codex-app-server": "1.0.0", "claude-code": "2.0.0" }, "claude-code", undefined),
    { "codex-app-server": "1.0.0" },
  );
});

test("a confirmed version replaces what was recorded and leaves the others alone", () => {
  const before = { "codex-app-server": "1.0.0" };
  assert.deepEqual(providerVersionsAfter(before, "codex-app-server", "1.1.0"), {
    "codex-app-server": "1.1.0",
  });
  assert.deepEqual(providerVersionsAfter(before, "claude-code", "2.0.0"), {
    "codex-app-server": "1.0.0",
    "claude-code": "2.0.0",
  });
  assert.deepEqual(before, { "codex-app-server": "1.0.0" });
});

test("naming no pipeline asks about the whole catalog", () => {
  assert.deepEqual(requestedPipelineIds(undefined, ["a", "b"]), ["a", "b"]);
  assert.deepEqual(requestedPipelineIds([], ["a", "b"]), ["a", "b"]);
});

test("naming the same pipeline twice asks about it once, in the order asked", () => {
  assert.deepEqual(requestedPipelineIds(["b", "a", "b"], ["a", "b", "c"]), ["b", "a"]);
});

test("a pipeline's providers are named once each, in a stable order", () => {
  assert.deepEqual(
    pipelineProviderIndex([
      {
        id: "review",
        agents: [
          { adapter: "zai-glm" },
          { adapter: "codex-app-server" },
          { adapter: "claude-code" },
          { adapter: "codex-app-server" },
        ],
      },
      { id: "empty", agents: [] },
    ]),
    { review: ["claude-code", "codex-app-server", "zai-glm"], empty: [] },
  );
});

test("pipeline names are indexed by id", () => {
  assert.deepEqual(pipelineNameIndex([{ id: "review", name: "Review" }]), { review: "Review" });
});

test("a pipeline the catalog does not have gets no safety level and no guardrail summary", () => {
  assert.deepEqual(
    pipelineFactIndexes([
      { pipelineId: "review", safetyLevel: "guarded", guardrails: { checks: 2 } },
      { pipelineId: "missing" },
    ]),
    { safetyLevels: { review: "guarded" }, guardrails: { review: { checks: 2 } } },
  );
});

test("a pipeline can carry one fact without the other", () => {
  assert.deepEqual(
    pipelineFactIndexes([
      { pipelineId: "a", safetyLevel: "open" },
      { pipelineId: "b", guardrails: { checks: 0 } },
    ]),
    { safetyLevels: { a: "open" }, guardrails: { b: { checks: 0 } } },
  );
});

test("no pipelines is two empty indexes, not a missing one", () => {
  assert.deepEqual(pipelineFactIndexes([]), { safetyLevels: {}, guardrails: {} });
});
