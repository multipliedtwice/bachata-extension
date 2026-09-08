const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStateCatalog } = require("../dist/state/catalog.js");
const { createLongitudinalService } = require("../dist/longitudinal/service.js");
const {
  QUIET_FRESH_REVIEW_SIGNAL,
  SATURATION_DISCLAIMER,
  quietFreshReviewStatement,
  saturationReport,
} = require("../dist/longitudinal/comparison.js");
const { directionView } = require("../dist/longitudinal/direction.js");

const REPOSITORY_ROOT = "/work/repo";

const idFactory = () => {
  const counters = { N: 0, Y: 0, T: 0, D: 0 };
  return (prefix) => {
    counters[prefix] += 1;
    return `${prefix}${String(counters[prefix]).padStart(8, "0")}`;
  };
};

const clock = (start = Date.UTC(2026, 0, 1)) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start + tick * 1000);
  };
};

const withCatalog = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-saturation-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const report = (quietFreshReviews) =>
  saturationReport({
    quietFreshReviews,
    history: [],
    decisions: [],
    checks: [],
    verificationExpected: false,
  });

test("the quiet-review signal is a default evidence signal, not a required count", () => {
  assert.equal(QUIET_FRESH_REVIEW_SIGNAL, 2);
  const none = report(0);
  const partial = report(1);
  const reached = report(2);

  assert.equal(none.signalReached, false);
  assert.equal(partial.signalReached, false);
  assert.equal(reached.signalReached, true);
  assert.equal(reached.quietReviewSignal, 2);

  [none, partial, reached].forEach((entry) => {
    entry.reasons.forEach((reason) => {
      assert.doesNotMatch(reason, /needed|required review|must run/iu);
    });
  });
  assert.deepEqual(
    partial.reasons.filter((reason) => reason.includes("consecutive fresh reviews")),
    ["1 of 2 consecutive fresh reviews found no material change"],
  );
});

test("the quiet-review statement states the fact and offers both continuing and closing", () => {
  assert.equal(
    quietFreshReviewStatement(report(2)),
    "Two consecutive fresh reviews found no material change. Continue or close the cycle.",
  );
  assert.equal(
    quietFreshReviewStatement(report(1)),
    "One of 2 consecutive fresh reviews found no material change. Continue or close the cycle.",
  );
  assert.match(quietFreshReviewStatement(report(0)), /Continue or close the cycle\./u);
});

test("the saturation disclaimer refuses correctness and refuses a required review count", () => {
  assert.match(SATURATION_DISCLAIMER, /not a correctness proof/u);
  assert.match(SATURATION_DISCLAIMER, /No review count is required/u);
  assert.match(SATURATION_DISCLAIMER, /close this cycle whenever you decide/u);
});

test("closing the cycle stays available before and after the quiet-review signal", () => {
  const initiative = { goal: "Goal", acceptanceCriteria: [], constraints: [], status: "active" };
  const cycle = {
    id: "Y00000001",
    sequence: 1,
    type: "review",
    completion: "open",
    runRefs: [],
  };
  const before = directionView({
    initiative,
    currentCycle: cycle,
    decisions: [],
    history: [],
    saturation: report(0),
  });
  const after = directionView({
    initiative,
    currentCycle: cycle,
    decisions: [],
    history: [],
    saturation: report(2),
  });

  assert.equal(before.closeCycleAvailable, true);
  assert.equal(after.closeCycleAvailable, true);
  assert.equal(before.nextAction.kind, "freshReview");
  assert.equal(after.nextAction.kind, "closeCycle");
  assert.doesNotMatch(before.nextAction.detail, /needed/iu);
  assert.match(before.quietReviewStatement, /Continue or close the cycle\./u);
  assert.match(after.quietReviewStatement, /Two consecutive fresh reviews/u);

  const closed = directionView({
    initiative,
    currentCycle: { ...cycle, completion: "completed" },
    decisions: [],
    history: [],
    saturation: report(0),
  });
  assert.equal(closed.closeCycleAvailable, false, "a closed cycle is already closed");
});

test("the human can close a cycle with no quiet fresh review recorded at all", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: REPOSITORY_ROOT,
      now: clock(),
      createId: idFactory(),
    });
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    const before = service.summary();
    assert.equal(before.saturation.saturated, false);
    assert.equal(before.saturation.signalReached, false);
    assert.equal(before.direction.closeCycleAvailable, true);

    const closed = service.closeCycle("human decided the evidence was enough");
    assert.equal(closed.id, cycle.id);
    assert.equal(closed.completion, "completed");
    assert.equal(service.summary().direction.closeCycleAvailable, false);
    catalog.close();
  });
});
