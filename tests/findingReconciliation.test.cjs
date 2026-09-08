const assert = require("node:assert/strict");
const test = require("node:test");

const {
  reconcileFindings,
  reconciliationCandidate,
} = require("../dist/longitudinal/reconciliation.js");
const { findingIdentity } = require("../dist/longitudinal/lifecycle.js");

const finding = (overrides) => ({
  id: "F1",
  subject: "",
  message: "",
  disposition: "accepted",
  evidence: [],
  challenges: [],
  provenance: { source: "stepOutput", stepId: "step", participantIds: ["lead"] },
  ...overrides,
});

const historyEntry = (overrides) => ({
  schemaVersion: 1,
  identity: "FH0",
  initiativeId: "I1",
  subject: "",
  message: "",
  messageHistory: [],
  state: "accepted",
  notObservedCycleIds: [],
  firstCycleId: "Y1",
  lastCycleId: "Y1",
  firstSeenAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  occurrences: 1,
  evidence: [],
  challenges: [],
  challengeHistory: [],
  materialDelta: [],
  actionable: false,
  resolutionHistory: [],
  ...overrides,
});

const trackedFrom = (subject, location, overrides = {}) =>
  historyEntry({
    identity: findingIdentity({ subject, location }),
    subject,
    location,
    ...overrides,
  });

test("a paraphrase of a tracked finding in the same place merges automatically", () => {
  const prior = trackedFrom(
    "Timing-unsafe password comparison in the login handler",
    { file: "src/auth/login.ts", startLine: 44, endLine: 46 },
    {
      message: "Password comparison uses === and leaks timing information about the hash.",
      evidence: ["src/auth/login.ts:44"],
    },
  );
  const fresh = finding({
    id: "N1",
    subject: "Password comparison is not constant time",
    message: "The login handler compares the password hash with ===, which leaks timing information.",
    location: { file: "src/auth/login.ts", startLine: 42, endLine: 48 },
    evidence: ["src/auth/login.ts:42"],
  });

  const outcome = reconcileFindings({ findings: [fresh], history: [prior] });
  assert.deepEqual(outcome.questions, [], "a clear match must never ask the human anything");
  assert.equal(outcome.assignments.length, 1);
  assert.equal(outcome.assignments[0].kind, "merged");
  assert.equal(outcome.assignments[0].identity, prior.identity);
  assert.equal(outcome.aliases.length, 1);
  assert.equal(outcome.aliases[0].canonicalIdentity, prior.identity);
  assert.equal(
    outcome.aliases[0].aliasIdentity,
    findingIdentity({ subject: fresh.subject, location: fresh.location }),
    "the alias preserves the wording the fresh reviewer actually used",
  );
  // The score blends location, subject and body overlap, so the surface must not call it
  // description overlap.
  assert.match(outcome.aliases[0].reason, /match score of \d+/u);
  assert.equal(/description overlap/u.test(outcome.aliases[0].reason), false);
});

test("the same subject in a different file is a different finding", () => {
  const prior = trackedFrom(
    "Timing-unsafe password comparison in the login handler",
    { file: "src/auth/login.ts", startLine: 44 },
  );
  const fresh = finding({
    id: "N1",
    subject: "Timing-unsafe password comparison in the login handler",
    location: { file: "src/admin/login.ts", startLine: 44 },
  });

  assert.equal(reconciliationCandidate(fresh, prior), undefined);
  const outcome = reconcileFindings({ findings: [fresh], history: [prior] });
  assert.deepEqual(outcome.aliases, []);
  assert.deepEqual(outcome.questions, []);
  assert.equal(outcome.assignments[0].kind, "new");
});

test("an unrelated finding in the same file gets its own identity and asks nothing", () => {
  const prior = trackedFrom(
    "Missing rate limit on the login handler",
    { file: "src/auth/login.ts", startLine: 44 },
    { message: "The login handler accepts unlimited attempts." },
  );
  const fresh = finding({
    id: "N1",
    subject: "Password comparison is not constant time",
    message: "The login handler compares the password hash with ===.",
    location: { file: "src/auth/login.ts", startLine: 42, endLine: 48 },
  });

  const outcome = reconcileFindings({ findings: [fresh], history: [prior] });
  assert.deepEqual(outcome.aliases, []);
  assert.deepEqual(outcome.questions, [], "a false match must not become human work");
  assert.equal(outcome.assignments[0].kind, "new");
});

test("one fresh finding that fits two tracked findings equally bubbles up instead of guessing", () => {
  const left = trackedFrom(
    "Unbounded retry loop in the worker queue",
    { file: "src/queue/worker.ts", startLine: 20 },
    { message: "Worker retries forever." },
  );
  const right = trackedFrom(
    "Unbounded retry loop in the worker poller",
    { file: "src/queue/worker.ts", startLine: 22 },
    { message: "Poller retries forever." },
  );
  const fresh = finding({
    id: "N1",
    subject: "Unbounded retry loop in the worker",
    message: "The worker retries forever.",
    location: { file: "src/queue/worker.ts", startLine: 21 },
  });

  const outcome = reconcileFindings({ findings: [fresh], history: [left, right] });
  assert.deepEqual(outcome.aliases, [], "an ambiguous mapping never merges on its own");
  assert.equal(outcome.questions.length, 1);
  assert.equal(outcome.questions[0].kind, "ambiguous");
  assert.deepEqual(
    outcome.questions[0].candidates.map((candidate) => candidate.identity).sort(),
    [left.identity, right.identity].sort(),
  );
  assert.equal(outcome.assignments[0].kind, "new");
});

test("a partial match below the clear threshold bubbles up and stays separate", () => {
  const prior = trackedFrom(
    "Retry limit ignores queue depth",
    { file: "src/queue/retry.ts", startLine: 10, endLine: 20 },
    { message: "The retry limit is fixed and ignores how deep the queue is." },
  );
  const fresh = finding({
    id: "N1",
    subject: "Retry backoff drops jitter",
    message: "The retry backoff no longer applies jitter, so the queue synchronises.",
    location: { file: "src/queue/retry.ts", startLine: 12, endLine: 18 },
  });

  const candidate = reconciliationCandidate(fresh, prior);
  assert.notEqual(candidate, undefined);
  assert.ok(candidate.subjectOverlap < 34, "this fixture must sit below the clear-match gate");
  const outcome = reconcileFindings({ findings: [fresh], history: [prior] });
  assert.deepEqual(outcome.aliases, []);
  assert.equal(outcome.questions.length, 1);
  assert.equal(outcome.questions[0].kind, "ambiguous");
});

test("a split description does not steal the identity another finding already claimed", () => {
  const subject = "Unbounded retry loop in the worker queue";
  const location = { file: "src/queue/worker.ts", startLine: 20, endLine: 30 };
  const prior = trackedFrom(subject, location, { message: "Worker retries forever." });
  const exact = finding({ id: "E1", subject, location, message: "Worker retries forever." });
  const split = finding({
    id: "P1",
    subject: "Retry loop in the worker queue is unbounded",
    message: "The worker queue retries forever.",
    location: { file: "src/queue/worker.ts", startLine: 22, endLine: 28 },
  });

  const outcome = reconcileFindings({ findings: [exact, split], history: [prior] });
  const byFinding = new Map(outcome.assignments.map((item) => [item.findingId, item]));
  assert.equal(byFinding.get("E1").kind, "exact");
  assert.equal(byFinding.get("E1").identity, prior.identity);
  assert.equal(byFinding.get("P1").kind, "new");
  assert.equal(outcome.questions.length, 1);
  assert.equal(outcome.questions[0].kind, "split");
  assert.deepEqual(outcome.aliases, []);
});

test("a match against a finding you rejected is never folded into your ruling", () => {
  const subject = "Unbounded retry loop in the worker queue";
  const location = { file: "src/queue/worker.ts", startLine: 20, endLine: 30 };
  const prior = trackedFrom(subject, location, {
    state: "rejected",
    message: "Worker retries forever.",
    humanResolution: {
      action: "reject",
      resolvedBy: "you",
      resolvedAt: "2026-01-02T00:00:00.000Z",
      reason: "the queue is bounded upstream",
    },
  });
  const fresh = finding({
    id: "P1",
    subject: "Retry loop in the worker queue is unbounded",
    message: "The worker queue retries forever, and the upstream bound was removed.",
    location: { file: "src/queue/worker.ts", startLine: 22, endLine: 28 },
  });

  const outcome = reconcileFindings({ findings: [fresh], history: [prior] });
  assert.deepEqual(outcome.aliases, []);
  assert.equal(outcome.questions.length, 1);
  assert.equal(outcome.questions[0].kind, "conflict");
  assert.equal(outcome.assignments[0].kind, "new");
});

test("an existing alias resolves a fresh wording to its canonical identity without a new question", () => {
  const canonical = trackedFrom(
    "Timing-unsafe password comparison in the login handler",
    { file: "src/auth/login.ts", startLine: 44 },
  );
  const fresh = finding({
    id: "N1",
    subject: "Password comparison is not constant time",
    location: { file: "src/auth/login.ts", startLine: 42 },
  });
  const aliasIdentity = findingIdentity({ subject: fresh.subject, location: fresh.location });
  const outcome = reconcileFindings({
    findings: [fresh],
    history: [canonical],
    aliases: new Map([[aliasIdentity, canonical.identity]]),
  });
  assert.deepEqual(outcome.questions, []);
  assert.deepEqual(outcome.aliases, [], "a recorded alias needs no second alias");
  assert.equal(outcome.assignments[0].kind, "exact");
  assert.equal(outcome.assignments[0].identity, canonical.identity);
});

const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createStateCatalog } = require("../dist/state/catalog.js");
const { createLongitudinalService } = require("../dist/longitudinal/service.js");

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

const withService = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-reconcile-"));
  const catalog = createStateCatalog(root);
  try {
    const service = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: "/work/repo",
      now: clock(),
      createId: idFactory(),
    });
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    await body(service, catalog);
  } finally {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
};

const proposed = (overrides) => finding({ disposition: "proposed", challenges: [], ...overrides });

test("a later round folds a paraphrase into the tracked finding and records why", async () => {
  await withService(async (service) => {
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    const first = proposed({
      id: "f1",
      subject: "Timing-unsafe password comparison in the login handler",
      message: "Password comparison uses === and leaks timing information about the hash.",
      location: { file: "src/auth/login.ts", startLine: 44, endLine: 46 },
      evidence: ["src/auth/login.ts:44"],
    });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [first],
      freshReview: true,
    });
    const canonical = findingIdentity({ subject: first.subject, location: first.location });
    assert.equal(service.summary().findings.length, 1);

    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    const paraphrase = proposed({
      id: "f2",
      subject: "Password comparison is not constant time",
      message: "The login handler compares the password hash with ===, which leaks timing information.",
      location: { file: "src/auth/login.ts", startLine: 42, endLine: 48 },
      evidence: ["src/auth/login.ts:42"],
    });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [paraphrase],
      freshReview: true,
    });

    const summary = service.summary();
    assert.equal(summary.findings.length, 1, "a paraphrase must not create a second finding");
    assert.equal(summary.findings[0].identity, canonical);
    assert.equal(summary.findings[0].occurrences, 2);
    assert.ok(
      summary.findings[0].messageHistory.includes(paraphrase.message),
      "the absorbed wording stays in the finding's history",
    );
    const aliases = service.findingAliases();
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].canonicalIdentity, canonical);
    assert.equal(aliases[0].createdBy, "controller");
    assert.deepEqual(summary.reconciliation.questions, []);
    assert.deepEqual(summary.direction.reconciliationQuestions, []);
  });
});

test("an ambiguous mapping reaches the direction view and the next action", async () => {
  await withService(async (service) => {
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [
        proposed({
          id: "f1",
          subject: "Unbounded retry loop in the worker queue",
          message: "Worker retries forever.",
          location: { file: "src/queue/worker.ts", startLine: 20 },
        }),
        proposed({
          id: "f2",
          subject: "Unbounded retry loop in the worker poller",
          message: "Poller retries forever.",
          location: { file: "src/queue/worker.ts", startLine: 22 },
        }),
      ],
      freshReview: true,
    });

    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [
        proposed({
          id: "f3",
          subject: "Unbounded retry loop in the worker",
          message: "The worker retries forever.",
          location: { file: "src/queue/worker.ts", startLine: 21 },
        }),
      ],
      freshReview: true,
    });

    const summary = service.summary();
    assert.equal(summary.reconciliation.questions.length, 1);
    assert.equal(summary.direction.reconciliationQuestions.length, 1);
    assert.equal(summary.direction.reconciliationQuestions[0].kind, "ambiguous");
    assert.equal(summary.direction.nextAction.kind, "reconcileFindings");
    assert.equal(service.findingAliases().length, 0);
    assert.equal(summary.findings.length, 3, "the unmatched wording keeps its own identity");
  });
});
