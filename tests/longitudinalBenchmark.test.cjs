const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { findingIdentity, foldFindingsIntoHistory } = require("../dist/longitudinal/lifecycle.js");

const root = path.join(__dirname, "..");
const home = path.join(root, "benchmarks", "longitudinal");
const load = () => import(`file://${path.join(root, "scripts", "lib", "longitudinalBenchmark.mjs")}`);

const tasks = fs.readdirSync(path.join(home, "tasks"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(fs.readFileSync(path.join(home, "tasks", name), "utf8")));

const task = () => {
  const found = tasks.find((item) => item.id === "retry-refinement");
  assert.ok(found, "missing longitudinal task retry-refinement");
  return found;
};

const identityOf = (id, file, line) =>
  findingIdentity({
    subject: id,
    message: `${id} at ${file}:${String(line)}`,
    location: { file },
  });

const finding = (item, overrides = {}) => ({
  id: item.id,
  file: item.file,
  line: item.line,
  identity: identityOf(item.id, item.file, item.line),
  disposition: "accepted",
  ...overrides,
});

test("every longitudinal task declares rounds, arms, metrics, and a committed fixture", async () => {
  const { validateLongitudinalTask, LONGITUDINAL_METRICS } = await load();
  assert.ok(tasks.length > 0, "no longitudinal task is committed");
  tasks.forEach((item) => {
    assert.deepEqual(validateLongitudinalTask(item), []);
    assert.ok(
      fs.existsSync(path.join(root, "benchmarks", item.fixture)),
      `${item.id} has no committed fixture`,
    );
    item.answerKey.requiredFindings.forEach((required) => {
      assert.ok(
        fs.existsSync(path.join(root, "benchmarks", item.fixture, required.file)),
        `${item.id} answer key points at a file that is not committed: ${required.file}`,
      );
    });
    assert.deepEqual([...LONGITUDINAL_METRICS].sort(), [...item.metrics].sort());
  });
});

test("an invalid longitudinal design is rejected instead of scored", async () => {
  const { validateLongitudinalTask, longitudinalVerdict } = await load();
  const broken = { ...task(), rounds: task().rounds.slice(0, 2), metrics: [] };
  const errors = validateLongitudinalTask(broken);
  assert.ok(errors.some((message) => message.includes("fewer than three rounds")));
  assert.ok(errors.some((message) => message.includes("does not declare the regressions metric")));
  assert.match(longitudinalVerdict([], errors), /supports no claim/u);
});

test("a recorded round without stable finding identity is refused", async () => {
  const { validateLongitudinalRunRecord } = await load();
  const errors = validateLongitudinalRunRecord(task(), "paired", {
    taskId: "retry-refinement",
    arm: "paired",
    rounds: [
      { index: 1, findings: [{ id: "retry.unbounded" }], decisionsShownToHuman: [] },
    ],
  });
  assert.ok(errors.some((message) => message.includes("no stable identity")));
  assert.ok(errors.some((message) => message.includes("the task declares 4")));
});

test("one answer-key finding cannot be multiplied with alternate identities", async () => {
  const { scoreLongitudinalRun, validateLongitudinalRunRecord } = await load();
  const current = task();
  const [required] = current.answerKey.requiredFindings;
  const rounds = current.rounds.map((round, index) => ({
    index: round.index,
    kind: round.kind,
    findings: index === 0
      ? [finding(required, { identity: "A" }), finding(required, { identity: "B" })]
      : [],
    decisionsShownToHuman: [],
  }));
  const record = { taskId: current.id, arm: "paired", rounds };
  const errors = validateLongitudinalRunRecord(current, "paired", record);
  assert.ok(errors.some((message) => message.includes("one finding location two identities")));
  const score = scoreLongitudinalRun(current, record);
  assert.equal(score.totals.newSupportedFindings, 1);
  assert.equal(score.totals.dispositions.accepted, 1);
});

test("one answer-key finding keeps one identity across rounds", async () => {
  const { validateLongitudinalRunRecord } = await load();
  const current = task();
  const [required] = current.answerKey.requiredFindings;
  const rounds = current.rounds.map((round, index) => ({
    index: round.index,
    kind: round.kind,
    findings: index < 2
      ? [finding(required, { identity: index === 0 ? "A" : "B" })]
      : [],
    decisionsShownToHuman: [],
  }));
  const errors = validateLongitudinalRunRecord(current, "paired", {
    taskId: current.id,
    arm: "paired",
    rounds,
  });
  assert.ok(errors.some((message) => message.includes("one finding location two identities")));
});

test("one identity cannot name different benchmark findings", async () => {
  const { validateLongitudinalRunRecord } = await load();
  const current = task();
  const [first, second] = current.answerKey.requiredFindings;
  const rounds = current.rounds.map((round, index) => ({
    index: round.index,
    kind: round.kind,
    findings: index === 0
      ? [finding(first, { identity: "shared" }), finding(second, { identity: "shared" })]
      : [],
    decisionsShownToHuman: [],
  }));
  const errors = validateLongitudinalRunRecord(current, "single", {
    taskId: current.id,
    arm: "single",
    rounds,
  });
  assert.ok(errors.some((message) => message.includes("reuses identity shared")));
});

test("longitudinal scoring separates new findings, repeats, regressions, and noise", async () => {
  const { scoreLongitudinalRun } = await load();
  const current = task();
  const [offByOne, sleepAfterLast, unbounded] = current.answerKey.requiredFindings;
  const routine = current.answerKey.routineInformation[0];
  const routineFinding = {
    id: routine.id,
    file: "src/retry.ts",
    line: 1,
    identity: identityOf(routine.id, "src/retry.ts", 1),
  };
  const score = scoreLongitudinalRun(current, {
    taskId: current.id,
    arm: "paired",
    rounds: [
      {
        index: 1,
        kind: "freshReview",
        findings: [
          finding(offByOne),
          finding(sleepAfterLast),
          finding(unbounded, { disposition: "unresolved" }),
          { ...routineFinding },
          { id: "retry.await-in-loop", file: "src/retry.ts", line: 13, identity: "FP1" },
        ],
        decisionsShownToHuman: ["retry.decision.unbounded-policy"],
      },
      {
        index: 2,
        kind: "correction",
        findings: [finding(offByOne), { ...routineFinding }],
        decisionsShownToHuman: [],
      },
      {
        index: 3,
        kind: "freshReview",
        findings: [finding(unbounded, { disposition: "unresolved" }), { ...routineFinding }],
        decisionsShownToHuman: ["retry.decision.backoff-shape", "not.a.core.decision"],
      },
      {
        index: 4,
        kind: "validation",
        findings: [finding(offByOne, { disposition: "accepted" })],
        decisionsShownToHuman: [],
      },
    ],
  });

  assert.equal(score.totals.newSupportedFindings, 3);
  assert.equal(score.rounds[0].newSupportedFindings, 3);
  assert.equal(score.rounds[1].newSupportedFindings, 0);
  assert.equal(score.rounds[1].repeatedSupportedFindings, 1);
  assert.equal(score.totals.falsePositives, 1);
  assert.equal(score.totals.humanVisibleCoreDecisions, 2);
  assert.equal(score.totals.routineOccurrences, 3);
  assert.equal(score.totals.routineTrackedIdentities, 1);
  assert.equal(score.routineCollapsed, true);
  assert.equal(score.rounds[3].regressions, 1);
  assert.equal(score.resolvedStayResolved, false);
  assert.deepEqual(score.totals.dispositions, { accepted: 4, rejected: 0, unresolved: 2 });
});

test("a resolved finding that returns with material evidence is a regression, not silent noise", async () => {
  const { scoreLongitudinalRun } = await load();
  const current = task();
  const [offByOne] = current.answerKey.requiredFindings;
  const score = scoreLongitudinalRun(current, {
    taskId: current.id,
    arm: "single",
    rounds: [
      { index: 1, kind: "freshReview", findings: [finding(offByOne)], decisionsShownToHuman: [] },
      { index: 2, kind: "freshReview", findings: [], decisionsShownToHuman: [] },
      {
        index: 3,
        kind: "freshReview",
        findings: [finding(offByOne, { materialDelta: ["A reproducing test now exists"] })],
        decisionsShownToHuman: [],
      },
      { index: 4, kind: "validation", findings: [], decisionsShownToHuman: [] },
    ],
  });
  assert.equal(score.totals.regressions, 1);
  assert.equal(score.resolvedStayResolved, true);
});

test("no longitudinal round is recorded, so the benchmark states it supports no claim", async () => {
  const { compareLongitudinalArms, longitudinalVerdict, LONGITUDINAL_NO_CLAIM } = await load();
  const recorded = tasks.flatMap((item) =>
    ["single", "paired"].filter((arm) =>
      fs.existsSync(path.join(home, "runs", item.id, `${arm}.json`))));
  assert.deepEqual(recorded, [], "a recorded longitudinal round appeared without a recorded claim review");
  assert.equal(compareLongitudinalArms(undefined, undefined).eligible, false);
  assert.equal(longitudinalVerdict(tasks.map(() => ({ eligible: false }))), LONGITUDINAL_NO_CLAIM);
  assert.match(LONGITUDINAL_NO_CLAIM, /supports no claim about accumulated refinement/u);
});

test("benchmark finding identity is the same identity the product uses across runs", () => {
  const current = task();
  const [offByOne] = current.answerKey.requiredFindings;
  const modelFinding = (runLocalId) => ({
    id: runLocalId,
    subject: offByOne.id,
    message: `${offByOne.id} at ${offByOne.file}:${String(offByOne.line)}`,
    disposition: "accepted",
    evidence: ["Both participants traced the bound"],
    challenges: ["The loop bound was inspected"],
    location: { file: offByOne.file, startLine: offByOne.line },
    provenance: {
      source: "pipelineDecision",
      stepId: "review-consensus",
      participantIds: ["codex", "claude"],
      decisionStatus: "accepted",
    },
  });
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [modelFinding("round-1-local-id")],
    freshReview: true,
  });
  const second = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: first.history,
    findings: [modelFinding("round-2-local-id")],
    freshReview: true,
  });
  assert.equal(second.history.length, 1);
  assert.deepEqual(second.newIdentities, []);
  assert.equal(second.history[0].occurrences, 2);
  assert.equal(
    second.history[0].identity,
    identityOf(offByOne.id, offByOne.file, offByOne.line),
  );
});
