const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createNotificationCenter } = require("../dist/notifications/center.js");
const { deriveNotifications } = require("../dist/notifications/derive.js");
const {
  notificationLevelFor,
  notificationMode,
  notificationVisible,
  NOTIFICATION_MODES,
} = require("../dist/notifications/types.js");

const emptyDirection = {
  decisionsNeedingHuman: [],
  findingsNeedingRuling: [],
  reconciliationQuestions: [],
  baselineDrift: [],
  fixRuns: [],
};

const source = (overrides = {}) => ({
  recordedAt: "2026-01-01T00:00:00.000Z",
  direction: { ...emptyDirection, ...(overrides.direction ?? {}) },
  results: overrides.results ?? [],
  retainedRuns: overrides.retainedRuns ?? [],
});

test("a converged round produces one compact line naming what changed", () => {
  const events = deriveNotifications(source({
    direction: {
      cycleId: "Y1",
      findingsNeedingRuling: [{ identity: "FH1", subject: "Retry loop" }],
      latestChange: {
        cycleId: "Y1",
        newMaterial: [{ identity: "FH2", subject: "Missing rate limit" }],
        regressed: [],
        resolved: [
          { identity: "FH3", subject: "Leak" },
          { identity: "FH4", subject: "Race" },
          { identity: "FH5", subject: "Deadlock" },
        ],
      },
    },
  }));
  const converged = events.find((event) => event.kind === "findingsConverged");
  assert.equal(
    converged.text,
    "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
  );
  assert.ok(converged.text.length < 120, "a bubble stays one short line");
  assert.equal(converged.level, "material");
});

test("every required event kind is derivable from recorded state alone", () => {
  const events = deriveNotifications(source({
    direction: {
      cycleId: "Y1",
      decisionsNeedingHuman: [{ id: "D1", subject: "Retry policy" }],
      latestChange: {
        cycleId: "Y1",
        newMaterial: [{ identity: "FH2", subject: "Missing rate limit" }],
        regressed: [],
        resolved: [],
      },
      fixRuns: [
        { identity: "FH9", subject: "Leak", runRef: "R1", state: "fixApplied" },
      ],
    },
    results: [
      {
        conversationId: "C1",
        title: "Review src",
        status: "completed",
        checks: [{ command: "bachata:project-checks", status: "failed" }],
        retainedWorktree: "/tmp/bachata-retained",
      },
      { conversationId: "C2", title: "Fix auth", status: "error", checks: [] },
    ],
  }));
  const kinds = new Set(events.map((event) => event.kind));
  [
    "humanDecisionRequired",
    "findingsConverged",
    "materialNewFinding",
    "fixReady",
    "verificationFailed",
    "providerBlocked",
    "retainedWorkAvailable",
  ].forEach((kind) => assert.ok(kinds.has(kind), `missing event kind: ${kind}`));
  events.forEach((event) => {
    assert.equal(event.level, notificationLevelFor[event.kind]);
  });
});

test("discard is offered only for retained work Bachata owns, and never for direct edits", () => {
  const retained = deriveNotifications(source({
    results: [{
      conversationId: "C1",
      title: "Managed fix",
      status: "completed",
      checks: [],
      retainedWorktree: "/tmp/bachata-retained",
    }],
  }));
  const retainedEvent = retained.find((event) => event.kind === "retainedWorkAvailable");
  assert.equal(retainedEvent.action, "discard");

  const direct = deriveNotifications(source({
    results: [{
      conversationId: "C1",
      title: "Debug run",
      status: "completed",
      checks: [],
    }],
  }));
  assert.equal(
    direct.find((event) => event.kind === "retainedWorkAvailable"),
    undefined,
    "a run that wrote straight into the workspace owns no reversible patch",
  );
  direct.forEach((event) => {
    assert.equal(event.action, "inspect");
    assert.doesNotMatch(event.text, /discard|restore|roll ?back|undo/iu);
  });
});

test("modes filter what the human sees and what the unread count reports", () => {
  assert.deepEqual([...NOTIFICATION_MODES], ["off", "decisions", "material", "all"]);
  assert.equal(notificationMode("nonsense"), "material");
  assert.equal(notificationMode("off"), "off");
  assert.equal(notificationVisible("off", "decision"), false);
  assert.equal(notificationVisible("decisions", "material"), false);
  assert.equal(notificationVisible("material", "routine"), false);
  assert.equal(notificationVisible("all", "routine"), true);

  const center = createNotificationCenter({ mode: "all" });
  center.publish(deriveNotifications(source({
    direction: {
      decisionsNeedingHuman: [{ id: "D1", subject: "Retry policy" }],
      latestChange: {
        cycleId: "Y1",
        newMaterial: [],
        regressed: [],
        resolved: [],
      },
    },
    retainedRuns: [{ runId: "T1", title: "TODO run", integrationWorktree: "/tmp/wt" }],
  })));

  assert.equal(center.state().events.length, 3);
  center.setMode("decisions");
  assert.deepEqual(center.state().events.map((event) => event.kind), ["humanDecisionRequired"]);
  assert.equal(center.state().unread, 1);
  center.setMode("material");
  assert.equal(center.state().events.length, 2);
  center.setMode("off");
  assert.deepEqual(center.state().events, []);
  assert.equal(center.state().unread, 0);
});

test("republishing unchanged state does not renew unread state, and clearing empties it", () => {
  const center = createNotificationCenter({ mode: "all" });
  const events = deriveNotifications(source({
    direction: { decisionsNeedingHuman: [{ id: "D1", subject: "Retry policy" }] },
  }));
  center.publish(events);
  assert.equal(center.state().unread, 1);
  center.markAllRead();
  assert.equal(center.state().unread, 0);
  center.publish(events);
  assert.equal(center.state().unread, 0, "the same state must not nag twice");

  center.publish(deriveNotifications(source({
    direction: {
      decisionsNeedingHuman: [
        { id: "D1", subject: "Retry policy" },
        { id: "D2", subject: "Storage layout" },
      ],
    },
  })));
  assert.equal(center.state().unread, 1, "a changed decision set is new information");
  center.clear();
  assert.deepEqual(center.state().events, []);
  assert.equal(center.state().unread, 0);
});

test("the session store is bounded and never becomes an archive", () => {
  const center = createNotificationCenter({ mode: "all", limit: 5 });
  for (let index = 0; index < 40; index += 1) {
    center.publish(deriveNotifications(source({
      direction: { decisionsNeedingHuman: [{ id: `D${String(index)}`, subject: "Subject" }] },
    })));
  }
  assert.equal(center.state().events.length, 5);
});

test("notification text never reaches a model prompt or outbound context", () => {
  const root = path.join(__dirname, "..");
  const sourceFiles = [];
  const walk = (directory) => {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) sourceFiles.push(full);
    });
  };
  walk(path.join(root, "src"));

  const importers = sourceFiles.filter((file) =>
    /from "[^"]*notifications\/(types|center|derive)"/u.test(fs.readFileSync(file, "utf8")));
  const relative = importers.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort();
  assert.deepEqual(
    relative,
    [
      "src/conversations/createConversationManager.ts",
      "src/webview/protocol.ts",
    ],
    "only the manager and the webview protocol may see notification text",
  );

  [
    "src/contract/outboundContext.ts",
    "src/contract/executionContract.ts",
    "src/pipeline/runner.ts",
    "src/context/index.ts",
  ].filter((file) => fs.existsSync(path.join(root, file)))
    .forEach((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      assert.doesNotMatch(text, /notification/iu, `${file} must not carry notification state`);
    });
});

const { notificationSourceFrom } = require("../dist/notifications/source.js");

// EX-3. The projection the centre is derived from. It used to read the conversation manager's own
// state from inside it, so which identity carries which subject, which conversation carries which
// title, and which of a result's optional fields travel could only be exercised by building a
// manager and driving a snapshot out of it.

const directionState = (overrides = {}) => ({
  direction: {
    decisionsNeedingHuman: [],
    findingsNeedingRuling: [],
    reconciliationQuestions: [],
    baselineDrift: [],
    ...(overrides.direction ?? {}),
  },
  findings: overrides.findings ?? [],
  fixRuns: overrides.fixRuns ?? [],
  summary: {},
  validationErrors: [],
});

test("the projection carries only what the notification rules read", () => {
  const projected = notificationSourceFrom({
    direction: directionState({
      direction: {
        currentCycle: { id: "Y1", sequence: 1 },
        decisionsNeedingHuman: [{ id: "D1", subject: "Ship it", extra: "dropped" }],
        findingsNeedingRuling: [{ identity: "FH1", subject: "Retry loop", extra: "dropped" }],
        reconciliationQuestions: [{ freshIdentity: "FH9", subject: "Same leak?", extra: "dropped" }],
        latestChange: {
          cycleId: "Y1",
          newMaterial: [{ identity: "FH2", subject: "Missing rate limit", extra: "dropped" }],
          regressed: [{ identity: "FH3", subject: "Leak" }],
          resolved: [{ identity: "FH4", subject: "Race" }],
        },
        baselineDrift: ["src/a.ts"],
      },
      findings: [{ identity: "FH2", subject: "Missing rate limit" }],
      fixRuns: [{ identity: "FH2", runRef: "R1", state: "running" }],
    }),
    conversations: [{ id: "run-1", title: "The run" }],
    results: {
      "run-1": {
        status: "completed",
        checks: [{ command: "npm test", status: "passed" }],
        retainedWorktree: "/work/wt",
        retainedRunId: "R7",
        applyBlockedReason: "verification did not pass",
      },
    },
    retainedRuns: [{ runId: "R7", title: "Kept", integrationWorktree: "/work/wt", extra: "dropped" }],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(projected.recordedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(projected.direction.cycleId, "Y1");
  assert.deepEqual(projected.direction.decisionsNeedingHuman, [{ id: "D1", subject: "Ship it" }]);
  assert.deepEqual(projected.direction.findingsNeedingRuling, [{ identity: "FH1", subject: "Retry loop" }]);
  assert.deepEqual(projected.direction.reconciliationQuestions, [{ freshIdentity: "FH9", subject: "Same leak?" }]);
  assert.deepEqual(projected.direction.latestChange, {
    cycleId: "Y1",
    newMaterial: [{ identity: "FH2", subject: "Missing rate limit" }],
    regressed: [{ identity: "FH3", subject: "Leak" }],
    resolved: [{ identity: "FH4", subject: "Race" }],
  });
  assert.deepEqual(projected.direction.baselineDrift, ["src/a.ts"]);
  // A fix run is named by the finding it is fixing, not by its identity string.
  assert.deepEqual(projected.direction.fixRuns, [
    { identity: "FH2", subject: "Missing rate limit", runRef: "R1", state: "running" },
  ]);
  assert.deepEqual(projected.results, [{
    conversationId: "run-1",
    title: "The run",
    status: "completed",
    checks: [{ command: "npm test", status: "passed" }],
    retainedWorktree: "/work/wt",
    retainedRunId: "R7",
    applyBlockedReason: "verification did not pass",
  }]);
  assert.deepEqual(projected.retainedRuns, [
    { runId: "R7", title: "Kept", integrationWorktree: "/work/wt" },
  ]);
});

test("what cannot be named is carried under its own id rather than dropped", () => {
  const projected = notificationSourceFrom({
    direction: directionState({
      fixRuns: [{ identity: "FH-unknown", runRef: "R2", state: "queued" }],
    }),
    conversations: [],
    results: { "run-missing": { status: "failed", checks: [] } },
    retainedRuns: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(projected.direction.cycleId, undefined, "a cycle nobody started was invented");
  assert.equal(projected.direction.latestChange, undefined);
  assert.deepEqual(projected.direction.fixRuns, [
    { identity: "FH-unknown", subject: "FH-unknown", runRef: "R2", state: "queued" },
  ]);
  assert.deepEqual(projected.results, [{
    conversationId: "run-missing",
    title: "run-missing",
    status: "failed",
    checks: [],
  }]);
  assert.equal("retainedWorktree" in projected.results[0], false, "an absent field travelled as undefined");
});

test("a projection with nothing in it says nothing", () => {
  const projected = notificationSourceFrom({
    direction: directionState({ direction: { findingsNeedingRuling: undefined } }),
    conversations: [],
    results: {},
    retainedRuns: [],
    recordedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(projected.direction.findingsNeedingRuling, []);
  assert.deepEqual(deriveNotifications(projected), []);
});
