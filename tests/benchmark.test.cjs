const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const load = () => import(`file://${path.join(root, "scripts", "lib", "benchmark.mjs")}`);

const tasks = fs.readdirSync(path.join(root, "benchmarks", "tasks"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(
    fs.readFileSync(path.join(root, "benchmarks", "tasks", name), "utf8"),
  ));

const taskById = (id) => {
  const task = tasks.find((item) => item.id === id);
  assert.ok(task, `missing benchmark task ${id}`);
  return task;
};

test("the benchmark covers review, planning, and bounded-fix tasks with committed fixtures", () => {
  assert.deepEqual(
    [...new Set(tasks.map((task) => task.kind))].sort(),
    ["fix", "plan", "review"],
  );
  tasks.forEach((task) => {
    const fixture = path.join(root, "benchmarks", task.fixture);
    assert.ok(fs.existsSync(fixture), `${task.id} has no committed fixture`);
    assert.ok(task.answerKey.requiredFindings.length > 0, `${task.id} has no required finding`);
    assert.ok(task.answerKey.forbiddenFindings.length > 0, `${task.id} names no false positive`);
    assert.ok(task.arms.single.pipelineIds.length > 0 && task.arms.paired.pipelineIds.length > 0);
    task.answerKey.requiredFindings.forEach((finding) => {
      assert.ok(
        fs.existsSync(path.join(fixture, finding.file)),
        `${task.id} answer key points at a file that is not committed: ${finding.file}`,
      );
    });
  });
});

test("no run is recorded, so the benchmark states that it supports no pairing claim", async () => {
  const { benchmarkVerdict } = await load();
  const recorded = tasks.flatMap((task) =>
    ["single", "paired"].filter((arm) =>
      fs.existsSync(path.join(root, "benchmarks", "runs", task.id, `${arm}.json`))));
  assert.deepEqual(recorded, [], "a recorded run appeared without a recorded claim review");
  assert.match(
    benchmarkVerdict(tasks.map(() => "incomplete")),
    /no eligible result in both arms\. This benchmark supports no claim about pairing/u,
  );
});

test("scoring counts supported findings, false positives, and verification honestly", async () => {
  const { scoreRun } = await load();
  const task = taskById("review-retry");
  const perfect = scoreRun(task, {
    taskId: task.id,
    arm: "paired",
    pipelineId: "review-only",
    findings: task.answerKey.requiredFindings.map((finding) => ({
      id: finding.id,
      file: finding.file,
      line: finding.line,
    })),
    verification: [],
    changedFiles: [],
    completion: "completed",
  });
  assert.equal(perfect.supportedFindings, 3);
  assert.equal(perfect.falsePositives, 0);
  assert.equal(perfect.verificationOutcome, "notApplicable");
  assert.equal(perfect.correct, true);

  const noisy = scoreRun(task, {
    taskId: task.id,
    arm: "single",
    findings: [
      { id: "retry.unbounded", file: "src/retry.ts", line: 23 },
      { id: "retry.await-in-loop", file: "src/retry.ts", line: 13 },
      { id: "invented.finding", file: "src/retry.ts", line: 1 },
    ],
    verification: [],
    changedFiles: [],
    completion: "completed",
  });
  assert.equal(noisy.supportedFindings, 1);
  assert.equal(noisy.falsePositives, 2);
  assert.equal(noisy.correct, false);

  const misplaced = scoreRun(task, {
    taskId: task.id,
    arm: "single",
    findings: [{ id: "retry.unbounded", file: "src/retry.ts", line: 1 }],
    verification: [],
    changedFiles: [],
    completion: "completed",
  });
  assert.equal(misplaced.supportedFindings, 0);
  assert.equal(misplaced.misplacedFindings, 1);
  assert.equal(misplaced.falsePositives, 0);
});

const matched = { referenceMatch: true };

test("a fix task is correct only with a held scope, passing verification, and a reference match", async () => {
  const { scoreRun } = await load();
  const task = taskById("fix-window");
  const base = {
    taskId: task.id,
    arm: "single",
    findings: [{ id: "window.exclusive-bound", file: "src/window.ts", line: 3 }],
    changedFiles: ["src/window.ts"],
    completion: "completed",
  };

  assert.equal(
    scoreRun(task, { ...base, verification: [{ command: "bachata:project-checks", status: "passed" }] }, matched).correct,
    true,
  );
  assert.equal(
    scoreRun(task, { ...base, verification: [{ command: "bachata:project-checks", status: "passed" }] }, { referenceMatch: false }).correct,
    false,
    "a fix that does not match the reference implementation scored as correct",
  );
  assert.equal(
    scoreRun(task, { ...base, verification: [{ command: "bachata:project-checks", status: "passed" }] }).correct,
    false,
    "a fix with no reference comparison scored as correct",
  );
  assert.equal(scoreRun(task, { ...base, verification: [] }, matched).verificationOutcome, "missing");
  assert.equal(scoreRun(task, { ...base, verification: [] }, matched).correct, false);
  assert.equal(
    scoreRun(task, { ...base, verification: [{ command: "bachata:project-checks", status: "cancelled" }] }, matched).verificationOutcome,
    "cancelled",
  );
  const outOfScope = scoreRun(task, {
    ...base,
    changedFiles: ["src/window.ts", "package.json"],
    verification: [{ command: "bachata:project-checks", status: "passed" }],
  }, matched);
  assert.deepEqual(outOfScope.outOfScopeFiles, ["package.json"]);
  assert.equal(outOfScope.correct, false);
  assert.equal(
    scoreRun(task, {
      ...base,
      completion: "interrupted",
      verification: [{ command: "bachata:project-checks", status: "passed" }],
    }, matched).correct,
    false,
  );
});

test("a review or plan task that changed a file never scores as correct", async () => {
  const { scoreRun } = await load();
  const task = taskById("plan-cache");
  const scored = scoreRun(task, {
    taskId: task.id,
    arm: "single",
    findings: task.answerKey.requiredFindings.map((finding) => ({
      id: finding.id,
      file: finding.file,
      line: finding.line,
    })),
    verification: [],
    changedFiles: ["src/cache.ts"],
    completion: "completed",
  });
  assert.equal(scored.changedScopeHeld, false);
  assert.equal(scored.correct, false);
});

const armResult = (values = {}) => ({
  supportedFindings: 3,
  falsePositives: 0,
  completion: "completed",
  changedScopeHeld: true,
  verificationOutcome: "passed",
  eligible: true,
  correct: true,
  ...values,
});

test("a pairing claim needs every preregistered task, and one single-agent win kills it", async () => {
  const { benchmarkVerdict, compareArms } = await load();

  assert.equal(
    compareArms(armResult({ supportedFindings: 1 }), armResult({ supportedFindings: 3 })),
    "pairedBetter",
  );
  assert.equal(
    compareArms(armResult({ supportedFindings: 3 }), armResult({ supportedFindings: 1, correct: false })),
    "singleBetter",
  );
  assert.equal(
    compareArms(armResult({ falsePositives: 2, correct: false }), armResult({ falsePositives: 1 })),
    "pairedBetter",
  );
  assert.equal(compareArms(armResult(), armResult()), "tie");
  assert.equal(compareArms(undefined, armResult()), "incomplete");

  assert.match(benchmarkVerdict(["pairedBetter", "pairedBetter"]), /support a claim that pairing improved/u);
  assert.match(benchmarkVerdict(["pairedBetter", "singleBetter"]), /do not support a claim/u);
  assert.match(benchmarkVerdict(["pairedBetter", "tie"]), /support no claim/u);
  assert.match(benchmarkVerdict(["incomplete"]), /no eligible result in both arms/u);
  assert.match(benchmarkVerdict([]), /No task is preregistered/u);
});

test("an ineligible or incorrect paired arm can never produce a positive claim", async () => {
  const { benchmarkVerdict, compareArms } = await load();
  const weakSingle = armResult({ supportedFindings: 1 });

  const ineligible = [
    { completion: "error", eligible: false },
    { changedScopeHeld: false, eligible: false },
    { verificationOutcome: "missing", eligible: false },
    { verificationOutcome: "failed", eligible: false },
    { verificationOutcome: "cancelled", eligible: false },
  ];
  ineligible.forEach((values) => {
    assert.equal(
      compareArms(weakSingle, armResult(values)),
      "incomplete",
      `${JSON.stringify(values)} was treated as a comparable paired arm`,
    );
  });

  assert.equal(
    compareArms(weakSingle, armResult({ falsePositives: 2, correct: false })),
    "tie",
    "an incorrect paired arm won on findings alone",
  );

  assert.match(
    benchmarkVerdict([compareArms(weakSingle, armResult({ completion: "error", eligible: false }))]),
    /no eligible result in both arms/u,
  );
  assert.match(
    benchmarkVerdict([compareArms(weakSingle, armResult({ falsePositives: 2, correct: false }))]),
    /support no claim/u,
  );
  assert.match(
    benchmarkVerdict(["pairedBetter", "incomplete"]),
    /1 of 2 tasks have no eligible result/u,
  );
});

test("scoring marks a run ineligible before it can be compared", async () => {
  const { scoreRun } = await load();
  const task = taskById("fix-window");
  const base = {
    taskId: task.id,
    arm: "single",
    findings: [{ id: "window.exclusive-bound", file: "src/window.ts", line: 3 }],
    changedFiles: ["src/window.ts"],
    verification: [{ command: "bachata:project-checks", status: "passed" }],
    completion: "completed",
  };
  assert.equal(scoreRun(task, base, matched).eligible, true);
  assert.equal(scoreRun(task, { ...base, completion: "error" }, matched).eligible, false);
  assert.equal(scoreRun(task, { ...base, verification: [] }, matched).eligible, false);
  assert.equal(scoreRun(task, { ...base, changedFiles: ["other.ts"] }, matched).eligible, false);
});

test("the paired Fix arm is a cross-checked pipeline that the controller still verifies", () => {
  const task = taskById("fix-window");
  assert.deepEqual(task.arms.paired.pipelineIds, ["paired-managed-fix"]);
  assert.equal(task.arms.paired.pipelineIds.includes("managed-fix"), false);
  assert.equal(task.arms.single.pipelineIds.includes("managed-fix"), true);

  const paired = JSON.parse(fs.readFileSync(
    path.join(root, "presets", `${task.arms.paired.pipelineIds[0]}.pipeline.json`),
    "utf8",
  ));
  assert.ok(
    paired.steps.some((step) => step.consensus === true),
    "the paired arm's pipeline declares no consensus step",
  );
  const execution = paired.steps.find((step) => step.type === "executeChecklist");
  assert.ok(execution, "the paired arm's pipeline does not execute its work in isolation");
  assert.ok(
    execution.checks.includes("bachata:project-checks"),
    "the paired arm's pipeline declares no controller-owned project check",
  );
  const worker = JSON.parse(fs.readFileSync(
    path.join(root, "presets", `${execution.pipelineId}.pipeline.json`),
    "utf8",
  ));
  assert.equal(worker.managedPolicy.commitMode, "never");
  assert.equal(worker.managedPolicy.writeScope, "task");

  const single = JSON.parse(fs.readFileSync(path.join(root, "presets", "managed-fix.pipeline.json"), "utf8"));
  assert.equal(single.roles.length, 1, "managed-fix stopped being a single-Worker pipeline");
});

test("both arms of a fix task are held to the same controller verification", async () => {
  const { armVerification, scoreRun, validateTaskDesign } = await load();
  const task = taskById("fix-window");
  assert.deepEqual(armVerification(task, "single"), ["bachata:project-checks"]);
  assert.deepEqual(armVerification(task, "paired"), ["bachata:project-checks"]);
  assert.deepEqual(validateTaskDesign(task), []);

  const base = {
    taskId: task.id,
    pipelineId: "managed-fix",
    findings: [{ id: "window.exclusive-bound", file: "src/window.ts", line: 3 }],
    changedFiles: ["src/window.ts"],
    completion: "completed",
    verification: [],
  };
  ["single", "paired"].forEach((arm) => {
    assert.equal(scoreRun(task, { ...base, arm }, matched).verificationOutcome, "missing");
    assert.equal(scoreRun(task, { ...base, arm }, matched).correct, false);
  });
});

test("a task whose arms are held to different proof is refused before it is scored", async () => {
  const { validateTaskDesign } = await load();
  const task = taskById("fix-window");
  const lopsided = JSON.parse(JSON.stringify(task));
  lopsided.arms.paired.requiredVerification = [];
  assert.ok(
    validateTaskDesign(lopsided).some((error) => /different required verification per arm/u.test(error)),
    "arms held to different proof were accepted as comparable",
  );

  const unverified = JSON.parse(JSON.stringify(task));
  unverified.arms.single.requiredVerification = [];
  unverified.arms.paired.requiredVerification = [];
  assert.ok(
    validateTaskDesign(unverified).some((error) => /requires no controller verification/u.test(error)),
  );

  const unreferenced = JSON.parse(JSON.stringify(task));
  delete unreferenced.answerKey.referenceFile;
  assert.ok(
    validateTaskDesign(unreferenced).some((error) => /no answerKey\.referenceFile/u.test(error)),
  );

  tasks.forEach((item) => {
    assert.deepEqual(validateTaskDesign(item), [], `${item.id} is not a comparable benchmark task`);
  });
});

test("a fix run must commit the files it produced so the reference can be checked", async () => {
  const { validateRunRecord } = await load();
  const task = taskById("fix-window");
  const record = {
    taskId: task.id,
    arm: "paired",
    pipelineId: "paired-managed-fix",
    provenance: {
      extensionVersion: "0.6.12",
      artifactSha256: "b".repeat(64),
      artifactPath: "bachata-vscode-0.6.12.vsix",
      fixtureSha256: "a".repeat(64),
      providers: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
      runBundle: "runs/fix-window/paired.bundle.json",
    },
    findings: [],
    verification: [{ command: "bachata:project-checks", status: "passed" }],
    changedFiles: ["src/window.ts"],
    completion: "completed",
  };
  const context = {
    extensionVersion: "0.6.12",
    fixtureSha256: "a".repeat(64),
    artifact: { inside: true, exists: true, sha256: "b".repeat(64) },
    bundle: {
      inside: true,
      exists: true,
      tracked: true,
      value: {
        run: {
          run: {
            selectedPipelineId: "paired-managed-fix",
            participants: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
          },
          result: {
            status: "completed",
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            changedFiles: ["src/window.ts"],
          },
        },
      },
    },
    produced: {},
  };
  assert.ok(
    validateRunRecord(task, "paired", record, context)
      .some((error) => /records no producedFiles map/u.test(error)),
  );
  assert.ok(
    validateRunRecord(task, "paired", { ...record, producedFiles: { "src/window.ts": "runs/fix-window/paired/window.ts" } }, {
      ...context,
      produced: { "src/window.ts": { inside: true, exists: false } },
    }).some((error) => /which is not committed/u.test(error)),
  );
  assert.deepEqual(
    validateRunRecord(task, "paired", { ...record, producedFiles: { "src/window.ts": "runs/fix-window/paired/window.ts" } }, {
      ...context,
      produced: { "src/window.ts": { inside: true, exists: true, tracked: true } },
    }),
    [],
  );
});

const goodBundle = (task) => ({
  schema: "bachata.run-bundle.v1",
  run: {
    run: { selectedPipelineId: task.arms.paired.pipelineIds[0], participants: [
      { name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" },
    ] },
    result: { status: "completed", checks: [], changedFiles: [] },
  },
});

const provenanceContext = (task, overrides = {}) => ({
  extensionVersion: "0.6.12",
  fixtureSha256: "a".repeat(64),
  artifact: { inside: true, exists: true, sha256: "b".repeat(64) },
  bundle: { inside: true, exists: true, tracked: true, value: goodBundle(task) },
  ...overrides,
});

const goodRecord = (task) => ({
  taskId: task.id,
  arm: "paired",
  pipelineId: task.arms.paired.pipelineIds[0],
  recordedAt: "2026-08-24T00:00:00.000Z",
  provenance: {
    extensionVersion: "0.6.12",
    artifactSha256: "b".repeat(64),
    artifactPath: "bachata-vscode-0.6.12.vsix",
    fixtureSha256: "a".repeat(64),
    providers: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    runBundle: "runs/review-retry/paired.bundle.json",
  },
  findings: [],
  verification: [],
  changedFiles: [],
  completion: "completed",
});

test("a recorded run is bound to pipeline, extension, artifact, fixture, provider, and bundle", async () => {
  const { validateRunRecord } = await load();
  const task = taskById("review-retry");

  assert.deepEqual(validateRunRecord(task, "paired", goodRecord(task), provenanceContext(task)), []);

  const withProvenance = (values) => ({ provenance: { ...goodRecord(task).provenance, ...values } });
  const cases = [
    [{ pipelineId: "codex-review" }, /not an paired pipeline/u],
    [{ provenance: undefined }, /records no provenance block/u],
    [withProvenance({ extensionVersion: "0.6.11" }), /produced by extension 0\.6\.11/u],
    [withProvenance({ artifactSha256: "short" }), /no sha256 of the extension artifact/u],
    [withProvenance({ artifactPath: undefined }), /does not name the extension artifact/u],
    [withProvenance({ fixtureSha256: "c".repeat(64) }), /different fixture/u],
    [withProvenance({ providers: [] }), /no provider identity/u],
    [withProvenance({ providers: [{ name: "Codex", adapter: "codex-app-server" }] }), /does not record name, adapter, and model/u],
    [withProvenance({ runBundle: "" }), /does not name a preserved run bundle/u],
  ];
  cases.forEach(([patch, pattern]) => {
    const errors = validateRunRecord(task, "paired", { ...goodRecord(task), ...patch }, provenanceContext(task));
    assert.ok(errors.length > 0, `${JSON.stringify(patch)} was accepted`);
    assert.ok(errors.some((error) => pattern.test(error)), `${JSON.stringify(patch)} gave ${errors.join("; ")}`);
  });
});

test("a self-asserted artifact hash and an escaping bundle path are both refused", async () => {
  const { validateRunRecord } = await load();
  const task = taskById("review-retry");
  const record = goodRecord(task);

  const contexts = [
    [{ artifact: { inside: false, exists: false } }, /artifact outside this checkout/u],
    [{ artifact: { inside: true, exists: false } }, /which is not present/u],
    [{ artifact: { inside: true, exists: true, sha256: "d".repeat(64) } }, /artifact sha256 does not match/u],
    [{ bundle: { inside: false, exists: false } }, /run bundle outside benchmarks\//u],
    [{ bundle: { inside: true, exists: false } }, /which is not committed/u],
    [{ bundle: { inside: true, exists: true, tracked: false } }, /Git does not track/u],
    [{ bundle: { inside: true, exists: true, tracked: undefined } }, /Git is unavailable/u],
    [{ bundle: { inside: true, exists: true, tracked: true, value: undefined } }, /not readable JSON/u],
  ];
  contexts.forEach(([overrides, pattern]) => {
    const errors = validateRunRecord(task, "paired", record, provenanceContext(task, overrides));
    assert.ok(errors.some((error) => pattern.test(error)), `${JSON.stringify(overrides)} gave ${errors.join("; ")}`);
  });
});

test("the run bundle must corroborate the pipeline, providers, verification, and result", async () => {
  const { crossCheckBundle, validateRunRecord } = await load();
  const task = taskById("review-retry");
  const record = goodRecord(task);
  const where = "record";

  assert.deepEqual(crossCheckBundle(record, goodBundle(task), where), []);

  const mutate = (mutator) => {
    const bundle = JSON.parse(JSON.stringify(goodBundle(task)));
    mutator(bundle);
    return bundle;
  };

  const mismatches = [
    [mutate((bundle) => { bundle.run.run.selectedPipelineId = "codex-review"; }), /ran pipeline codex-review/u],
    [mutate((bundle) => { bundle.run.run.participants = []; }), /records no participants/u],
    [mutate((bundle) => { bundle.run.run.participants[0].model = "other-model"; }), /do not match the run bundle participants/u],
    [mutate((bundle) => { bundle.run.result.checks = [{ command: "bachata:project-checks", status: "passed" }]; }), /verification does not match/u],
    [mutate((bundle) => { bundle.run.result.changedFiles = ["src/a.ts"]; }), /changed files do not match/u],
    [mutate((bundle) => { bundle.run.result.status = "interrupted"; }), /does not match the run bundle status/u],
    [{ not: "a bundle" }, /not a Bachata run bundle/u],
  ];
  mismatches.forEach(([bundle, pattern]) => {
    const errors = crossCheckBundle(record, bundle, where);
    assert.ok(errors.some((error) => pattern.test(error)), `bundle gave ${errors.join("; ")}`);
    assert.ok(
      validateRunRecord(task, "paired", record, provenanceContext(task, {
        bundle: { inside: true, exists: true, tracked: true, value: bundle },
      })).length > 0,
    );
  });
});

test("a run that fails provenance can never produce a pairing claim", async () => {
  const { benchmarkVerdict } = await load();
  assert.match(
    benchmarkVerdict(["pairedBetter", "pairedBetter"], ["runs/fix-window/paired.json names pipeline managed-fix"]),
    /failed provenance validation. This benchmark supports no claim/u,
  );
});

test("one task cannot be settled from the committed fixture and hands both arms the same outside access", async () => {
  const { taskExternalAccess, validateTaskDesign, validateRunRecord } = await load();
  const boundary = tasks.filter((task) => taskExternalAccess(task).length > 0);
  assert.equal(boundary.length > 0, true, "no benchmark task requires evidence outside the fixture");
  boundary.forEach((task) => {
    assert.deepEqual(validateTaskDesign(task), []);
    assert.equal(typeof task.boundary, "string");
    assert.equal(task.arms.single.externalAccess, undefined);
    assert.equal(task.arms.paired.externalAccess, undefined);
  });

  const task = boundary[0];
  assert.deepEqual(
    validateTaskDesign({
      ...task,
      arms: { ...task.arms, single: { ...task.arms.single, externalAccess: ["extra"] } },
    }).length > 0,
    true,
    "an arm-specific access grant must be refused",
  );
  assert.equal(
    validateTaskDesign({ ...task, boundary: undefined }).length > 0,
    true,
    "declared external access with no stated boundary must be refused",
  );
});

test("a boundary run that does not record the access it was given is not scored", async () => {
  const { taskExternalAccess, validateRunRecord } = await load();
  const task = tasks.find((item) => taskExternalAccess(item).length > 0);
  const context = {
    extensionVersion: "0.7.0",
    fixtureSha256: "a".repeat(64),
    artifact: { inside: true, exists: true, sha256: "b".repeat(64) },
    bundle: {
      inside: true,
      exists: true,
      tracked: true,
      value: {
        schema: "bachata.run-bundle.v1",
        run: {
          run: {
            selectedPipelineId: task.arms.single.pipelineIds[0],
            participants: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
          },
          result: { status: "completed", checks: [], changedFiles: [] },
        },
      },
    },
  };
  const record = {
    taskId: task.id,
    arm: "single",
    pipelineId: task.arms.single.pipelineIds[0],
    provenance: {
      extensionVersion: "0.7.0",
      artifactPath: "bachata-vscode-0.7.0.vsix",
      artifactSha256: "b".repeat(64),
      fixtureSha256: "a".repeat(64),
      providers: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
      runBundle: `runs/${task.id}/single.bundle.json`,
    },
    findings: [],
    verification: [],
    changedFiles: [],
    completion: "completed",
  };
  assert.match(
    validateRunRecord(task, "single", record, context).join("; "),
    /does not record which declared external access this arm was given/u,
  );
  assert.match(
    validateRunRecord(task, "single", { ...record, externalAccessUsed: ["something else"] }, context).join("; "),
    /is not the access the task declares for both arms/u,
  );
  assert.deepEqual(
    validateRunRecord(
      task,
      "single",
      { ...record, externalAccessUsed: [...taskExternalAccess(task)] },
      context,
    ),
    [],
  );
});
