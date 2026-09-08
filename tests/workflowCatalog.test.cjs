const assert = require("node:assert/strict");
const test = require("node:test");

const { completeSetup, parseSetupState, resolveWorkflowCards, setupVersion, workflowCards } = require("../dist/workflows/catalog.js");

test("workflow cards keep common goals visible and custom advanced", () => {
  const cards = workflowCards();
  assert.deepEqual(
    cards.slice(0, 7).map((card) => card.id),
    ["review", "productReview", "plan", "featureDelivery", "fix", "todo", "browser"],
  );
  assert.equal(cards.at(-1).id, "custom");
  assert.equal(cards.at(-1).advanced, true);
});

test("workflow card projection selects only the best runnable candidate", () => {
  const cards = resolveWorkflowCards(workflowCards(), [
    { pipelineId: "codex-review", status: "needsSetup", findings: [{ status: "needsSetup", detail: "Codex missing" }] },
    { pipelineId: "claude-review", status: "ready", findings: [] },
    { pipelineId: "plan", status: "blocked", findings: [{ status: "blocked", detail: "Workspace untrusted" }] },
  ], { "claude-review": "Claude review" });
  assert.equal(cards[0].status, "ready");
  assert.equal(cards[0].pipelineId, "claude-review");
  assert.match(cards[0].readinessDetail, /Claude review/u);
  assert.equal(cards[1].status, "blocked");
  assert.equal(cards.at(-1).pipelineId, undefined);
});

test("setup state is versioned, persisted-shaped, and rejects stale versions", () => {
  const state = completeSetup("review", "claude-review", new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(parseSetupState(state), state);
  assert.equal(state.version, setupVersion);
  assert.equal(parseSetupState({ ...state, version: setupVersion + 1 }), undefined);
});

const reviewCard = (readiness, names = {}) =>
  resolveWorkflowCards(workflowCards(), readiness, names)
    .find((card) => card.id === "review");

const modeOf = (card, mode) => card.modes.find((item) => item.mode === mode);

test("an equally ready paired pipeline is never silently lost to a single-provider one", () => {
  const card = reviewCard([
    { pipelineId: "codex-review", status: "ready", findings: [] },
    { pipelineId: "claude-review", status: "ready", findings: [] },
    { pipelineId: "review-only", status: "ready", findings: [] },
  ], { "codex-review": "Codex review", "review-only": "Review only" });

  assert.equal(card.status, "ready");
  assert.equal(card.pipelineId, "review-only");
  assert.deepEqual(card.modes.map((mode) => mode.mode), ["paired", "single"]);
  assert.equal(modeOf(card, "paired").status, "ready");
  assert.equal(modeOf(card, "paired").pipelineId, "review-only");
  assert.equal(modeOf(card, "paired").label, "Cross-checked pair");
  assert.equal(modeOf(card, "single").status, "ready");
  assert.equal(modeOf(card, "single").pipelineId, "codex-review");
  assert.equal(modeOf(card, "single").label, "Fast single agent");
});

test("one ready provider still offers both modes and names what the pair needs", () => {
  const card = reviewCard([
    { pipelineId: "codex-review", status: "ready", findings: [] },
    { pipelineId: "claude-review", status: "needsSetup", findings: [{ status: "needsSetup", detail: "claude unavailable" }] },
    { pipelineId: "review-only", status: "needsSetup", findings: [{ status: "needsSetup", detail: "claude unavailable" }] },
  ], { "review-only": "Review only" });

  assert.equal(card.status, "ready");
  assert.equal(card.pipelineId, "codex-review");
  assert.equal(modeOf(card, "single").status, "ready");
  assert.equal(modeOf(card, "paired").status, "needsSetup");
  assert.match(modeOf(card, "paired").readinessDetail, /Review only: claude unavailable/u);
});

test("a blocked paired pipeline never becomes the card's selection when a single agent is ready", () => {
  const card = reviewCard([
    { pipelineId: "claude-review", status: "ready", findings: [] },
    { pipelineId: "review-only", status: "blocked", findings: [{ status: "blocked", detail: "Workspace untrusted" }] },
  ], { "review-only": "Review only", "claude-review": "Claude review" });

  assert.equal(card.status, "ready");
  assert.equal(card.pipelineId, "claude-review");
  assert.equal(modeOf(card, "paired").status, "blocked");
  assert.match(modeOf(card, "paired").readinessDetail, /Workspace untrusted/u);
});

test("neither mode ready keeps the card blocked and still states both causes", () => {
  const card = reviewCard([
    { pipelineId: "codex-review", status: "blocked", findings: [{ status: "blocked", detail: "codex unavailable" }] },
    { pipelineId: "claude-review", status: "blocked", findings: [{ status: "blocked", detail: "claude unavailable" }] },
    { pipelineId: "review-only", status: "blocked", findings: [{ status: "blocked", detail: "both providers unavailable" }] },
  ], {});

  assert.equal(card.status, "blocked");
  assert.equal(card.modes.every((mode) => mode.status === "blocked"), true);
  assert.match(modeOf(card, "single").readinessDetail, /codex unavailable/u);
  assert.match(modeOf(card, "paired").readinessDetail, /both providers unavailable/u);
});

test("TODO, browser, and custom stay advanced while the product journey stays in front", () => {
  const cards = workflowCards();
  assert.deepEqual(
    cards.filter((card) => card.advanced !== true).map((card) => card.id),
    ["review", "productReview", "plan", "featureDelivery", "fix"],
  );
  assert.deepEqual(
    cards.filter((card) => card.advanced === true).map((card) => card.id),
    ["todo", "browser", "custom"],
  );
});

test("Fix offers managed-fix as a single agent and paired-managed-fix as the cross-checked pair", () => {
  const fix = workflowCards().find((card) => card.id === "fix");
  assert.deepEqual(fix.modePipelineIds.single, ["managed-fix", "codex-fix", "claude-fix"]);
  assert.deepEqual(
    fix.modePipelineIds.paired,
    ["paired-managed-fix", "debug"],
    "the paired Fix mode must prefer the controller-verified paired pipeline",
  );
  assert.equal(fix.modePipelineIds.paired.includes("managed-fix"), false);

  const resolved = resolveWorkflowCards(workflowCards(), [
    { pipelineId: "managed-fix", status: "ready", findings: [] },
    { pipelineId: "paired-managed-fix", status: "ready", findings: [] },
    { pipelineId: "debug", status: "ready", findings: [] },
  ], {
    "managed-fix": "Managed fix",
    "paired-managed-fix": "Paired managed fix",
    debug: "Debug",
  }).find((card) => card.id === "fix");
  assert.equal(
    resolved.modes.find((mode) => mode.mode === "paired").pipelineId,
    "paired-managed-fix",
  );
  assert.equal(resolved.modes.find((mode) => mode.mode === "single").pipelineId, "managed-fix");
});

test("the flagship paired fix pipeline pairs diagnosis, isolates writes, and keeps controller verification", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const presets = path.join(__dirname, "..", "presets");
  const pipeline = JSON.parse(fs.readFileSync(path.join(presets, "paired-managed-fix.pipeline.json"), "utf8"));
  assert.equal(pipeline.id, "paired-managed-fix");
  assert.deepEqual(
    pipeline.agents.map((agent) => agent.adapter).sort(),
    ["claude-code", "codex-app-server"],
    "the flagship fix must be genuinely paired",
  );

  const consensusSteps = pipeline.steps.filter((step) => step.consensus === true);
  assert.equal(consensusSteps.length, 1, "the diagnosis must be cross-checked before any write");
  consensusSteps.forEach((step) => {
    assert.ok(
      Number.isInteger(step.consensusConfig.maxRounds) && step.consensusConfig.maxRounds > 0,
      "every consensus step must bound its rounds",
    );
  });
  pipeline.steps
    .filter((step) => step.type === "agent")
    .forEach((step) => {
      Object.values(step.permissionModes ?? {}).forEach((mode) => {
        assert.ok(
          ["readOnly", "plan"].includes(mode),
          `${step.id} lets a provider write outside the isolated execution step`,
        );
      });
    });

  const execution = pipeline.steps.find((step) => step.type === "executeChecklist");
  assert.ok(execution, "the flagship fix does not execute its work in isolation");
  assert.equal(execution.pipelineId, "todo-implementation");
  assert.deepEqual(
    execution.checks.sort(),
    ["bachata:project-checks", "bachata:workspace-integrity"],
    "the isolated execution declares no controller-owned verification",
  );
  assert.ok(execution.allowedPaths.length > 0, "the isolated execution declares no path scope");

  const worker = JSON.parse(fs.readFileSync(path.join(presets, "todo-implementation.pipeline.json"), "utf8"));
  assert.equal(worker.managedPolicy.writeScope, "task", "the executed sub-pipeline is not isolated per task");
  assert.equal(worker.managedPolicy.commitMode, "never");
  assert.deepEqual(
    worker.roles.map((role) => role.id).sort(),
    ["lead", "reviewer", "worker"],
    "the executed sub-pipeline no longer plans, implements, and reviews with distinct roles",
  );
});

test("the product-review and feature-delivery goals are first-class, not advanced", () => {
  const cards = workflowCards();
  const product = cards.find((card) => card.id === "productReview");
  const feature = cards.find((card) => card.id === "featureDelivery");
  assert.deepEqual(product.pipelineIds, ["product-review"]);
  assert.deepEqual(feature.pipelineIds, ["feature-delivery"]);
  assert.equal(product.advanced, undefined);
  assert.equal(feature.advanced, undefined);
});

test("a stated provider preference outranks readiness when a goal offers a choice", () => {
  const cards = resolveWorkflowCards(
    workflowCards(),
    [
      { pipelineId: "codex-review", status: "needsSetup", findings: [{ status: "needsSetup", detail: "Codex missing" }] },
      { pipelineId: "claude-review", status: "ready", findings: [] },
    ],
    { "codex-review": "Codex review", "claude-review": "Claude review" },
    {},
    {
      pipelineProviders: {
        "codex-review": ["codex-app-server"],
        "claude-review": ["claude-code"],
      },
      preferredProvider: "codex-app-server",
    },
  );
  assert.equal(cards[0].pipelineId, "codex-review");
  assert.equal(cards[0].status, "needsSetup");
});

test("no stated preference leaves readiness in charge", () => {
  const cards = resolveWorkflowCards(
    workflowCards(),
    [
      { pipelineId: "codex-review", status: "needsSetup", findings: [{ status: "needsSetup", detail: "Codex missing" }] },
      { pipelineId: "claude-review", status: "ready", findings: [] },
    ],
    { "claude-review": "Claude review" },
    {},
    { preferredProvider: "auto" },
  );
  assert.equal(cards[0].pipelineId, "claude-review");
});
