const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTROLLER_VERIFICATION_NON_PASSING,
  controllerVerificationAuthorizes,
  controllerVerificationEvidence,
  controllerVerificationForCandidate,
  controllerVerificationOutcome,
  controllerVerificationPrompt,
  renderControllerVerificationEvidence,
  requiredControllerChecks,
} = require("../dist/runtime/controllerVerification.js");

const preset = require("../presets/feature-delivery.pipeline.json");

// P3. Controller-owned verification, for every managed turn that declares checks. The shipped
// preset declares two, and until now only a managed browser turn ever executed one.

test("the required checks are the ones the run's own snapshot declares", () => {
  assert.deepEqual(
    requiredControllerChecks(preset.managedPolicy.verificationChecks),
    [
      { id: "workspace-integrity", command: "bachata:workspace-integrity" },
      { id: "project-checks", command: "bachata:project-checks" },
    ],
  );
  assert.deepEqual(requiredControllerChecks(undefined), []);
  assert.deepEqual(requiredControllerChecks([]), []);
});

test("a check named twice is one check, and a check with no id is none", () => {
  assert.deepEqual(
    requiredControllerChecks([
      { id: "a", command: "bachata:project-checks" },
      { id: "a", command: "bachata:workspace-integrity" },
      { id: "", command: "bachata:project-checks" },
      { command: "bachata:project-checks" },
    ]),
    [{ id: "a", command: "bachata:project-checks" }],
  );
});

test("the required checks are copies, so a run cannot edit the policy it was given", () => {
  const declared = [{ id: "a", command: "bachata:project-checks" }];
  const required = requiredControllerChecks(declared);
  required[0].command = "bachata:workspace-integrity";
  assert.equal(declared[0].command, "bachata:project-checks");
});

const required = [
  { id: "workspace-integrity", command: "bachata:workspace-integrity" },
  { id: "project-checks", command: "bachata:project-checks" },
];

const passing = (fingerprint) => required.map((check) => ({
  id: check.id,
  status: "passed",
  workspaceFingerprint: fingerprint,
}));

test("every required check passing against this candidate authorizes it", () => {
  assert.deepEqual(
    controllerVerificationAuthorizes({
      required,
      records: passing("a".repeat(64)),
      workspaceFingerprint: "a".repeat(64),
    }),
    { authorized: true, issues: [] },
  );
});

test("a check that never ran is named, not omitted", () => {
  const authorization = controllerVerificationAuthorizes({
    required,
    records: [{ id: "workspace-integrity", status: "passed", workspaceFingerprint: "a".repeat(64) }],
    workspaceFingerprint: "a".repeat(64),
  });
  assert.deepEqual(authorization, { authorized: false, issues: ["project-checks: not run"] });
});

test("no status that is not a pass authorizes a candidate, in the check's own word", () => {
  for (const status of CONTROLLER_VERIFICATION_NON_PASSING) {
    const authorization = controllerVerificationAuthorizes({
      required,
      records: [
        { id: "workspace-integrity", status: "passed", workspaceFingerprint: "a".repeat(64) },
        { id: "project-checks", status, workspaceFingerprint: "a".repeat(64) },
      ],
      workspaceFingerprint: "a".repeat(64),
    });
    assert.deepEqual(authorization.issues, [`project-checks: ${status}`], status);
    assert.equal(authorization.authorized, false);
  }
});

test("a newly changed candidate invalidates every result an older one earned", () => {
  const records = passing("a".repeat(64));
  assert.equal(
    controllerVerificationAuthorizes({ required, records, workspaceFingerprint: "a".repeat(64) }).authorized,
    true,
  );
  const authorization = controllerVerificationAuthorizes({
    required,
    records,
    workspaceFingerprint: "b".repeat(64),
  });
  assert.deepEqual(authorization.issues, [
    "workspace-integrity: stale",
    "project-checks: stale",
  ]);
  // And a candidate with no fingerprint at all authorizes nothing.
  assert.equal(
    controllerVerificationAuthorizes({ required, records, workspaceFingerprint: undefined }).authorized,
    false,
  );
});

test("results from an earlier candidate are dropped rather than carried forward", () => {
  const records = [
    { id: "project-checks", status: "passed", workspaceFingerprint: "a".repeat(64) },
    { id: "workspace-integrity", status: "passed", workspaceFingerprint: "b".repeat(64) },
  ];
  assert.deepEqual(
    controllerVerificationForCandidate(records, "b".repeat(64)).map((record) => record.id),
    ["workspace-integrity"],
  );
  assert.deepEqual(controllerVerificationForCandidate(records, undefined), []);
});

test("the Lead is given the controller's own fields for every required check", () => {
  const evidence = controllerVerificationEvidence({
    required,
    records: [
      {
        id: "project-checks",
        status: "failed",
        exitCode: 2,
        summary: "syntax error in src/feature.ts",
        workspaceFingerprint: "a".repeat(64),
      },
    ],
    workspaceFingerprint: "a".repeat(64),
  });
  assert.deepEqual(evidence, [
    { id: "workspace-integrity", command: "bachata:workspace-integrity", status: "not run", output: "" },
    {
      id: "project-checks",
      command: "bachata:project-checks",
      status: "failed",
      exitCode: 2,
      output: "syntax error in src/feature.ts",
    },
  ]);
});

test("a result from another candidate is reported as not run, not as its old status", () => {
  const evidence = controllerVerificationEvidence({
    required,
    records: passing("a".repeat(64)),
    workspaceFingerprint: "b".repeat(64),
  });
  assert.deepEqual(evidence.map((line) => line.status), ["not run", "not run"]);
});

test("check output is bounded, and the bound is the caller's", () => {
  const evidence = controllerVerificationEvidence({
    required: [required[0]],
    records: [
      {
        id: "workspace-integrity",
        status: "failed",
        summary: "x".repeat(100),
        workspaceFingerprint: "a".repeat(64),
      },
    ],
    workspaceFingerprint: "a".repeat(64),
    maxOutputBytes: 10,
  });
  assert.equal(evidence[0].output, "x".repeat(10));
  const unbounded = controllerVerificationEvidence({
    required: [required[0]],
    records: [
      {
        id: "workspace-integrity",
        status: "failed",
        summary: "y".repeat(20_000),
        workspaceFingerprint: "a".repeat(64),
      },
    ],
    workspaceFingerprint: "a".repeat(64),
  });
  assert.equal(unbounded[0].output.length, 8_192);
  assert.equal(
    controllerVerificationEvidence({
      required: [required[0]],
      records: [],
      workspaceFingerprint: undefined,
      maxOutputBytes: -1,
    })[0].output,
    "",
  );
});

test("rendered evidence names the check, the command, the status and the exit information", () => {
  const rendered = renderControllerVerificationEvidence([
    { id: "project-checks", command: "bachata:project-checks", status: "failed", exitCode: 1, output: "boom" },
    { id: "workspace-integrity", command: "bachata:workspace-integrity", status: "not run", output: "" },
  ]);
  assert.match(rendered, /check: project-checks\ncommand: bachata:project-checks\nstatus: failed\nexit: 1\noutput: boom/u);
  // A check with no process behind it says so rather than inventing an exit code, and an empty
  // output is stated rather than left blank for a reader to interpret.
  assert.match(rendered, /check: workspace-integrity[\s\S]*exit: n\/a\noutput: \(none\)/u);
});

test("a verified candidate advances, whichever role produced it", () => {
  for (const role of ["worker", "lead"]) {
    assert.deepEqual(
      controllerVerificationOutcome({ role, authorized: true, attemptsUsed: 9, maxRevisionCycles: 1 }),
      { outcome: "advance" },
      role,
    );
  }
});

test("a Worker repairs its own work until its revision budget is used up", () => {
  const worker = { role: "worker", authorized: false, maxRevisionCycles: 2 };
  assert.deepEqual(controllerVerificationOutcome({ ...worker, attemptsUsed: 0 }), { outcome: "revise", attempt: 1 });
  assert.deepEqual(controllerVerificationOutcome({ ...worker, attemptsUsed: 1 }), { outcome: "revise", attempt: 2 });
  assert.deepEqual(controllerVerificationOutcome({ ...worker, attemptsUsed: 2 }), { outcome: "blocked" });
  // A budget of zero is no repair attempt, not an unbounded one.
  assert.deepEqual(
    controllerVerificationOutcome({ role: "worker", authorized: false, attemptsUsed: 0, maxRevisionCycles: 0 }),
    { outcome: "blocked" },
  );
  assert.deepEqual(
    controllerVerificationOutcome({ role: "worker", authorized: false, attemptsUsed: 0, maxRevisionCycles: -3 }),
    { outcome: "blocked" },
  );
});

test("a Lead never repairs anything: it declines to approve", () => {
  assert.deepEqual(
    controllerVerificationOutcome({ role: "lead", authorized: false, attemptsUsed: 0, maxRevisionCycles: 5 }),
    { outcome: "blocked" },
  );
});

test("the agent is told which checks failed, in the controller's own words", () => {
  const evidence = [
    { id: "project-checks", command: "bachata:project-checks", status: "failed", exitCode: 1, output: "boom" },
  ];
  const worker = controllerVerificationPrompt({
    role: "worker",
    issues: ["project-checks: failed"],
    evidence,
  });
  assert.match(worker, /Required verification: project-checks: failed/u);
  assert.match(worker, /check: project-checks/u);
  assert.match(worker, /Repair the implementation so every declared check passes/u);
  const lead = controllerVerificationPrompt({ role: "lead", issues: ["project-checks: failed"], evidence });
  assert.match(lead, /Do not approve this candidate/u);
});
