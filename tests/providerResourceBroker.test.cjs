const assert = require("node:assert/strict");
const test = require("node:test");

const { classifyProviderFailure } = require("../dist/adapters/providerFailure.js");
const { ProviderResourceBroker } = require("../dist/runtime/providerResourceBroker.js");

test("provider resource capacity covers supported TODO concurrency", async () => {
  const broker = new ProviderResourceBroker();
  broker.configure("codex-cli:test", 1, 32);
  const first = await broker.acquire("codex-cli:test");
  const controllers = Array.from({ length: 20 }, () => new AbortController());
  const waiting = controllers.map((controller) => broker.acquire("codex-cli:test", controller.signal).catch((error) => error));
  assert.equal(broker.snapshot("codex-cli:test").queued, 20);
  controllers.forEach((controller) => controller.abort());
  first.release();
  const outcomes = await Promise.all(waiting);
  assert.equal(outcomes.every((value) => value instanceof Error && value.name === "AbortError"), true);
});

test("provider resource circuits recover after their reset deadline", () => {
  const broker = new ProviderResourceBroker();
  broker.reportFailure({
    code: "quotaExhausted",
    message: "weekly quota exhausted",
    provider: "codex",
    resourceId: "codex-cli:test",
    retryable: false,
    sideEffects: "none",
    resetAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const snapshot = broker.snapshot("codex-cli:test");
  assert.equal(snapshot.circuit, "closed");
  assert.equal(snapshot.failure, undefined);
});

test("provider queue saturation is classified as retryable rate limiting", () => {
  const failure = classifyProviderFailure(
    new Error("Provider resource queue is full: claude-code:test"),
    "claude-code",
    "claude-code:test",
    "none",
  );
  assert.equal(failure.code, "rateLimited");
  assert.equal(failure.retryable, true);
  assert.equal(failure.sideEffects, "none");
});

test("provider resource circuits replace malformed reset deadlines", () => {
  const broker = new ProviderResourceBroker();
  broker.reportFailure({
    code: "authenticationRequired",
    message: "login required",
    provider: "codex",
    resourceId: "codex-cli:test",
    retryable: false,
    sideEffects: "none",
    resetAt: "not-a-date",
  });
  const snapshot = broker.snapshot("codex-cli:test");
  assert.equal(snapshot.circuit, "open");
  assert.equal(Number.isFinite(Date.parse(snapshot.failure.resetAt)), true);
});


test("provider resource circuits bound future reset deadlines", () => {
  const before = Date.now();
  const broker = new ProviderResourceBroker();
  broker.reportFailure({
    code: "quotaExhausted",
    message: "weekly quota exhausted",
    provider: "codex",
    resourceId: "codex-cli:test",
    retryable: false,
    sideEffects: "none",
    resetAt: "2099-01-01T00:00:00.000Z",
  });
  const resetAt = Date.parse(broker.snapshot("codex-cli:test").failure.resetAt);
  assert.equal(resetAt >= before, true);
  assert.equal(resetAt <= before + 301_000, true);
});
