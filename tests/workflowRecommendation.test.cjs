const assert = require("node:assert/strict");
const test = require("node:test");

const {
  recommendWorkflow,
  workflowRecommendationStatement,
  workflowShapeLabels,
} = require("../dist/workflows/recommendation.js");

const consequence = (overrides = {}) => ({
  writesWorkspace: false,
  isolatedRetainedWork: true,
  openDecisions: 0,
  regressions: 0,
  outstandingAcceptedFindings: 0,
  unresolvedExternalClaims: 0,
  staleExternalClaims: 0,
  contestedExternalClaims: 0,
  ...overrides,
});

test("a read-only run with nothing contested is recommended as a single agent", () => {
  const recommendation = recommendWorkflow({ consequence: consequence() });
  assert.equal(recommendation.shape, "singleAgent");
  assert.equal(recommendation.label, workflowShapeLabels.singleAgent);
  assert.equal(recommendation.humanChoiceRequired, true);
  assert.match(recommendation.consequences.join(" "), /Nothing cross-checks it/u);
});

test("work that writes to the workspace is recommended as a cross-checked pair", () => {
  const recommendation = recommendWorkflow({
    consequence: consequence({ writesWorkspace: true, isolatedRetainedWork: false }),
  });
  assert.equal(recommendation.shape, "paired");
  assert.match(recommendation.reasons.join("; "), /writes your selected workspace directly and Bachata does not roll it back/u);
});

test("a regression or an open decision is enough to prefer a pair", () => {
  assert.equal(recommendWorkflow({ consequence: consequence({ regressions: 2 }) }).shape, "paired");
  assert.equal(recommendWorkflow({ consequence: consequence({ openDecisions: 1 }) }).shape, "paired");
});

test("an unsettled claim from outside the repository outranks everything else", () => {
  const recommendation = recommendWorkflow({
    consequence: consequence({
      writesWorkspace: true,
      regressions: 3,
      unresolvedExternalClaims: 1,
    }),
  });
  assert.equal(recommendation.shape, "externalEvidenceHeavy");
  assert.match(recommendation.reasons.join("; "), /nobody has ruled on/u);
  assert.match(recommendation.consequences.join(" "), /no amount of reading the code settles them/u);
});

test("a contested or stale external claim counts the same as an unruled one", () => {
  assert.equal(
    recommendWorkflow({ consequence: consequence({ contestedExternalClaims: 1 }) }).shape,
    "externalEvidenceHeavy",
  );
  assert.equal(
    recommendWorkflow({ consequence: consequence({ staleExternalClaims: 1 }) }).shape,
    "externalEvidenceHeavy",
  );
});

test("the same consequences always produce the same recommendation", () => {
  const input = {
    consequence: consequence({ writesWorkspace: true, openDecisions: 2, regressions: 1 }),
    availability: { singleAgent: "ready", paired: "ready" },
  };
  const first = recommendWorkflow(input);
  const second = recommendWorkflow(input);
  assert.deepEqual(first, second);
  assert.deepEqual(
    recommendWorkflow(input).reasons,
    [
      "this work writes to a retained worktree you apply from",
      "1 finding regressed since the last round",
      "2 decisions is still open",
    ],
  );
});

test("a recommendation is never for a shape that cannot run, and says it substituted", () => {
  const recommendation = recommendWorkflow({
    consequence: consequence({ writesWorkspace: true }),
    availability: { singleAgent: "ready", paired: "needsSetup" },
  });
  assert.equal(recommendation.shape, "singleAgent");
  assert.equal(recommendation.substituted.preferred, "paired");
  assert.match(recommendation.substituted.because, /not runnable here/u);
});

test("the statement always ends by leaving the choice with the human", () => {
  const statement = workflowRecommendationStatement(
    recommendWorkflow({ consequence: consequence({ writesWorkspace: true }) }),
  );
  assert.match(statement, /^Bachata suggests Cross-checked pair because /u);
  assert.match(statement, /· you choose$/u);
});

test("a recommendation carries no command and applies nothing on its own", () => {
  const recommendation = recommendWorkflow({ consequence: consequence() });
  assert.equal("command" in recommendation, false);
  assert.equal("apply" in recommendation, false);
  assert.equal(recommendation.humanChoiceRequired, true);
});

test("isolated retained work is never described as a direct workspace write", () => {
  const isolated = recommendWorkflow({
    consequence: consequence({ writesWorkspace: true, isolatedRetainedWork: true }),
  });
  assert.match(isolated.reasons.join("; "), /retained worktree you apply from/u);
  assert.doesNotMatch(isolated.reasons.join("; "), /roll it back/u);
  const direct = recommendWorkflow({
    consequence: consequence({ writesWorkspace: true, isolatedRetainedWork: false }),
  });
  assert.doesNotMatch(direct.reasons.join("; "), /reversible|retained worktree/u);
});
