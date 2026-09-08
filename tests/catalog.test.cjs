const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { createStateCatalog } = require("../dist/state/catalog.js");
const { createDeadlineScheduler } = require("../dist/state/deadlineScheduler.js");
const {
  formatProviderChatTitle,
  parseProviderChatTitle,
  isReference,
} = require("../dist/state/identifiers.js");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("catalog allocates short references, retries collisions, and stores compact run bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-"));
  const values = [
    "R23456789",
    "R23456789",
    "RABCDEFGH",
    "I23456789",
    "P23456789",
    "C23456789",
  ];
  try {
    const catalog = createStateCatalog(root, {
      referenceFactory: () => values.shift(),
    });
    const first = catalog.createRun({ title: "First", input: "review src" });
    const second = catalog.createRun({ title: "Second" });
    assert.equal(first.runRef, "R23456789");
    assert.equal(second.runRef, "RABCDEFGH");
    assert.equal(isReference(first.runRef, "R"), true);
    const iterationRef = catalog.createIteration({ runRef: first.runRef, index: 1 });
    const pairRef = catalog.createPair({
      runRef: first.runRef,
      iterationRef,
      taskId: "ISSUE-1",
      workingRoot: "/workspace",
      scope: ["src"],
    });
    const title = formatProviderChatTitle(first.runRef, "C23456789", "Lead", "Review src/job-workers");
    const chat = catalog.createChat({
      runRef: first.runRef,
      iterationRef,
      pairRef,
      role: "Lead",
      provider: "chatgpt",
      adapter: "browserChatGpt",
      displayTitle: title,
      status: "ready",
    });
    assert.equal(chat.chatRef, "C23456789");
    assert.deepEqual(parseProviderChatTitle(title), {
      runRef: first.runRef,
      chatRef: chat.chatRef,
      title: "Lead · Review src/job-workers",
    });
    catalog.appendEvent({ runRef: first.runRef, type: "step.started", title: "Review" });
    assert.equal(catalog.listEvents(first.runRef).length, 1);
    assert.equal(catalog.listChats(first.runRef)[0].displayTitle, title);
    catalog.close();

    const database = new DatabaseSync(path.join(root, "bachata-state.sqlite"));
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => row.name);
    assert.equal(tables.includes("messages"), false);
    assert.equal(tables.includes("full_answers"), false);
    assert.equal(tables.includes("runs"), true);
    assert.equal(tables.includes("chats"), true);
    const pair = database.prepare("SELECT * FROM pairs WHERE pair_ref = ?").get(pairRef);
    assert.equal(pair.working_root, "/workspace");
    assert.deepEqual(JSON.parse(pair.scope_json), ["src"]);
    database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog validates workspace ownership before every mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-ownership-"));
  let writable = true;
  try {
    const catalog = createStateCatalog(root, {
      assertWritable: () => {
        if (!writable) {
          throw new Error("workspace lease lost");
        }
      },
    });
    const run = catalog.createRun({ title: "Owned" });
    writable = false;
    assert.throws(
      () => catalog.appendEvent({ runRef: run.runRef, type: "blocked" }),
      /workspace lease lost/u,
    );
    assert.equal(catalog.listEvents(run.runRef).length, 0);
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog fencing rejects writes from a replaced workspace owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-fence-"));
  try {
    const first = createStateCatalog(root, {
      writerFence: { resourceKey: "workspace-state-writer:test", token: 1 },
    });
    const run = first.createRun({ title: "First owner" });
    const second = createStateCatalog(root, {
      writerFence: { resourceKey: "workspace-state-writer:test", token: 2 },
    });
    second.upsertRun({ ...run, title: "Second owner" });
    assert.equal(second.getRun(run.runRef).title, "Second owner");
    assert.throws(
      () => first.upsertRun({ ...run, title: "Stale owner" }),
      /workspace writer lease is stale/u,
    );
    assert.throws(
      () => first.setActiveRunRef(run.runRef),
      /workspace writer lease is stale/u,
    );
    first.close();
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog fencing distinguishes equal tokens from different resource identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-fence-identity-"));
  try {
    const first = createStateCatalog(root, {
      writerFence: { resourceKey: "workspace-state-writer:first", token: 1 },
    });
    const run = first.createRun({ title: "First owner" });
    const second = createStateCatalog(root, {
      writerFence: { resourceKey: "workspace-state-writer:second", token: 1 },
    });
    second.upsertRun({ ...run, title: "Second owner" });
    assert.throws(
      () => first.upsertRun({ ...run, title: "Stale owner" }),
      /workspace writer lease is stale/u,
    );
    first.close();
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog persists orchestration bindings used to restore Bachata metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-orchestration-bindings-"));
  try {
    const catalog = createStateCatalog(root);
    const run = catalog.createRun({
      title: "ORCH-4",
      workingRoot: "/workspace/.bachata/worktrees/ORCH-4",
      orchestrationRunId: "todo-run-1",
      orchestrationTaskId: "ORCH-4",
      orchestrationBranch: "bachata/task/orch-4",
      orchestrationBaseCommit: "abc123",
      orchestrationPaths: ["src/orchestrator", "tests"],
    });
    catalog.close();

    const reopened = createStateCatalog(root);
    assert.deepEqual(reopened.getRun(run.runRef), {
      ...run,
      orchestrationBranch: "bachata/task/orch-4",
      orchestrationBaseCommit: "abc123",
      orchestrationPaths: ["src/orchestrator", "tests"],
    });
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interaction engagement pauses the absolute deadline and resume preserves remaining time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-interaction-"));
  let current = Date.parse("2026-08-03T00:00:00.000Z");
  try {
    const catalog = createStateCatalog(root, { now: () => new Date(current) });
    const run = catalog.createRun({ title: "Timer" });
    const interaction = catalog.createInteraction({
      runRef: run.runRef,
      kind: "executionChecklist",
      prompt: "Pick issues",
      timeoutMs: 10_000,
    });
    assert.equal(interaction.status, "pending");
    current += 3_000;
    const paused = catalog.updateInteractionDraft(interaction.interactionRef, {
      selected: ["ISSUE-1"],
      pauseReason: "userEngaged",
    });
    assert.equal(paused.status, "paused");
    assert.equal(paused.remainingMs, 7_000);
    assert.equal(paused.deadlineAt, undefined);
    current += 50_000;
    const resumed = catalog.resumeInteraction(interaction.interactionRef);
    assert.equal(resumed.status, "pending");
    assert.equal(Date.parse(resumed.deadlineAt), current + 7_000);
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one deadline scheduler resolves every overdue tab and handles each timeout once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-deadlines-"));
  let current = Date.parse("2026-08-03T00:00:00.000Z");
  const handled = [];
  try {
    const catalog = createStateCatalog(root, { now: () => new Date(current) });
    const firstRun = catalog.createRun({ title: "First" });
    const secondRun = catalog.createRun({ title: "Second" });
    const first = catalog.createInteraction({
      runRef: firstRun.runRef,
      kind: "executionChecklist",
      prompt: "Checklist",
      options: [
        { id: "ISSUE-1", label: "First" },
        { id: "ISSUE-2", label: "Second" },
      ],
      timeoutMs: 1_000,
    });
    const second = catalog.createInteraction({
      runRef: secondRun.runRef,
      kind: "semanticQuestion",
      prompt: "Question",
      timeoutMs: 2_000,
    });
    current += 5_000;
    const scheduler = createDeadlineScheduler(catalog, {
      now: () => current,
      onTimeout: async (interaction) => {
        handled.push(interaction.interactionRef);
      },
    });
    scheduler.start();
    await nextTurn();
    await nextTurn();
    assert.deepEqual(handled.sort(), [first.interactionRef, second.interactionRef].sort());
    assert.deepEqual(catalog.getInteraction(first.interactionRef).resolution, {
      selected: [],
      freeText: "",
    });
    assert.deepEqual(catalog.getInteraction(second.interactionRef).resolution, {
      selected: [],
      freeText: "",
      fallback: true,
    });
    scheduler.wake();
    await nextTurn();
    assert.equal(handled.length, 2);
    scheduler.dispose();
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider title parser ignores markers that are not anchored", () => {
  const title = "Something [bachata:R23456789:C23456789] Lead · Task-with-hyphens — ภาษาไทย";
  assert.equal(parseProviderChatTitle(title), undefined);
  const anchored = "[bachata:R23456789:C23456789] Lead · Task-with-hyphens — ภาษาไทย";
  assert.deepEqual(parseProviderChatTitle(anchored), {
    runRef: "R23456789",
    chatRef: "C23456789",
    title: "Lead · Task-with-hyphens — ภาษาไทย",
  });
});

test("interaction occurrences reuse only the exact unresolved payload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-interaction-occurrence-"));
  let current = Date.parse("2026-08-03T00:00:00.000Z");
  try {
    const catalog = createStateCatalog(root, { now: () => new Date(current) });
    const run = catalog.createRun({ title: "Occurrences" });
    const first = catalog.createInteraction({
      runRef: run.runRef,
      kind: "humanGate",
      sourceKey: "gate:review",
      prompt: "Continue?",
      context: { payloadHash: "payload-1" },
    });
    const pendingReuse = catalog.createInteraction({
      runRef: run.runRef,
      kind: "humanGate",
      sourceKey: "gate:review",
      prompt: "Continue?",
      context: { payloadHash: "payload-1" },
    });
    assert.equal(pendingReuse.interactionRef, first.interactionRef);

    catalog.resolveInteraction(first.interactionRef, "user", {
      selected: ["continue"],
      freeText: "",
    });
    const resolvedReuse = catalog.createInteraction({
      runRef: run.runRef,
      kind: "humanGate",
      sourceKey: "gate:review",
      prompt: "Continue?",
      context: { payloadHash: "payload-1" },
    });
    assert.equal(resolvedReuse.interactionRef, first.interactionRef);

    catalog.markInteractionHandled(first.interactionRef);
    current += 1;
    const second = catalog.createInteraction({
      runRef: run.runRef,
      kind: "humanGate",
      sourceKey: "gate:review",
      prompt: "Continue again?",
      context: { payloadHash: "payload-1" },
    });
    assert.notEqual(second.interactionRef, first.interactionRef);
    assert.equal(second.sourceKey, "gate:review#2");

    const third = catalog.createInteraction({
      runRef: run.runRef,
      kind: "humanGate",
      sourceKey: "gate:review",
      prompt: "Changed gate",
      context: { payloadHash: "payload-2" },
    });
    assert.equal(third.sourceKey, "gate:review#3");
    assert.equal(catalog.getInteraction(second.interactionRef).status, "resolved");
    assert.equal(catalog.getInteraction(second.interactionRef).resolutionSource, "superseded");
    assert.ok(catalog.getInteraction(second.interactionRef).handledAt);
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checklist items persist exact issue data and follow draft and final selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-checklist-items-"));
  try {
    const catalog = createStateCatalog(root);
    const run = catalog.createRun({ title: "Checklist" });
    const interaction = catalog.createInteraction({
      runRef: run.runRef,
      kind: "executionChecklist",
      sourceKey: "checklist:prepare",
      prompt: "Select work",
      context: { payloadHash: "checklist-payload" },
    });
    catalog.replaceChecklistItems(interaction.interactionRef, [
      {
        issueId: "ISSUE_A",
        title: "Fix A",
        details: "Keep compatibility.",
        dependencies: [],
        paths: ["src/a.ts"],
      },
      {
        issueId: "ISSUE_B",
        title: "Test B",
        details: "Cover A.",
        dependencies: ["ISSUE_A"],
        paths: ["tests/a.test.ts"],
      },
    ]);
    assert.deepEqual(catalog.listChecklistItems(interaction.interactionRef), [
      {
        issueId: "ISSUE_A",
        title: "Fix A",
        details: "Keep compatibility.",
        dependencies: [],
        paths: ["src/a.ts"],
        selected: false,
        position: 0,
      },
      {
        issueId: "ISSUE_B",
        title: "Test B",
        details: "Cover A.",
        dependencies: ["ISSUE_A"],
        paths: ["tests/a.test.ts"],
        selected: false,
        position: 1,
      },
    ]);

    catalog.updateInteractionDraft(interaction.interactionRef, {
      selected: ["ISSUE_B"],
      freeText: "Draft note",
    });
    assert.deepEqual(
      catalog.listChecklistItems(interaction.interactionRef).map((item) => item.selected),
      [false, true],
    );

    catalog.resolveInteraction(interaction.interactionRef, "user", {
      selected: ["ISSUE_A"],
      freeText: "Final note",
    });
    assert.deepEqual(
      catalog.listChecklistItems(interaction.interactionRef).map((item) => item.selected),
      [true, false],
    );
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog retention bounds stored run history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-retention-"));
  try {
    const catalog = createStateCatalog(root, {
      retention: {
        eventsPerRun: 2,
        outputsPerRun: 2,
        handledInteractionsPerRun: 2,
        completedAttemptsPerRun: 2,
      },
    });
    const run = catalog.createRun({ title: "Retention" });
    for (let index = 0; index < 4; index += 1) {
      catalog.appendEvent({ runRef: run.runRef, type: `event-${String(index)}` });
      catalog.saveStructuredOutput({
        runRef: run.runRef,
        name: `output-${String(index)}`,
        contentHash: `hash-${String(index)}`,
        value: { index },
      });
      const interaction = catalog.createInteraction({
        runRef: run.runRef,
        kind: "singleSelect",
        sourceKey: `interaction-${String(index)}`,
        prompt: "Choose",
      });
      catalog.resolveInteraction(interaction.interactionRef, "user", {
        selected: [],
        freeText: "",
      });
      catalog.markInteractionHandled(interaction.interactionRef);
    }

    const database = new DatabaseSync(catalog.path);
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM events WHERE run_ref = ?").get(run.runRef).count),
      2,
    );
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM structured_outputs WHERE run_ref = ?").get(run.runRef).count),
      2,
    );
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM interactions WHERE run_ref = ?").get(run.runRef).count),
      2,
    );
    database.close();
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("catalog initialization and migrations are retry-safe across simultaneous fresh processes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-startup-"));
  const modulePath = path.resolve(__dirname, "../dist/state/catalog.js");
  const childSource = `
    const { createStateCatalog } = require(${JSON.stringify(modulePath)});
    try {
      const catalog = createStateCatalog(process.argv[1]);
      catalog.close();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  `;
  try {
    const start = (index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", childSource, root], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => code === 0
        ? resolve()
        : reject(new Error(`catalog process ${String(index)} exited ${String(code)}: ${stderr}`)));
    });
    await Promise.all(Array.from({ length: 6 }, (_, index) => start(index)));
    const catalog = createStateCatalog(root);
    assert.equal(catalog.listRuns().length, 0);
    catalog.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run participants persist across catalog reopen and survive legacy databases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-participants-"));
  try {
    const catalog = createStateCatalog(root);
    const created = catalog.createRun({
      title: "Participants",
      participants: [
        { name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" },
        { name: "Reviewer", adapter: "claude-code" },
      ],
    });
    assert.deepEqual(created.participants, [
      { name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" },
      { name: "Reviewer", adapter: "claude-code" },
    ]);

    catalog.upsertRun({
      ...created,
      participants: [{ name: "Solo", adapter: "claude-code", model: "claude-sonnet-5" }],
    });
    assert.deepEqual(catalog.getRun(created.runRef).participants, [
      { name: "Solo", adapter: "claude-code", model: "claude-sonnet-5" },
    ]);

    const plain = catalog.createRun({ title: "No participants" });
    assert.deepEqual(plain.participants, []);
    catalog.close();

    const reopened = createStateCatalog(root);
    assert.deepEqual(reopened.getRun(created.runRef).participants, [
      { name: "Solo", adapter: "claude-code", model: "claude-sonnet-5" },
    ]);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a catalog created before participants existed migrates without losing runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-migrate-"));
  try {
    const first = createStateCatalog(root);
    const run = first.createRun({ title: "Legacy run" });
    first.close();

    const database = new DatabaseSync(path.join(root, "bachata-state.sqlite"));
    database.exec("DELETE FROM schema_migrations WHERE version = 6");
    database.exec("ALTER TABLE runs DROP COLUMN participants_json");
    database.close();

    const migrated = createStateCatalog(root);
    const restored = migrated.getRun(run.runRef);
    assert.equal(restored.title, "Legacy run");
    assert.deepEqual(restored.participants, []);
    migrated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution identity rotates on every run.started and survives reopen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-catalog-execution-"));
  let catalog;
  try {
    catalog = createStateCatalog(root);
    const run = catalog.createRun({ title: "Fix cancellation" });
    assert.equal(catalog.latestExecutionRef(run.runRef), undefined);
    catalog.appendEvent({ runRef: run.runRef, type: "run.started", status: "running" });
    const first = catalog.latestExecutionRef(run.runRef);
    assert.match(first, /^E\d+$/u);
    catalog.appendEvent({ runRef: run.runRef, type: "run.resumed", status: "running" });
    assert.equal(catalog.latestExecutionRef(run.runRef), first);
    catalog.appendEvent({ runRef: run.runRef, type: "run.started", status: "running" });
    const second = catalog.latestExecutionRef(run.runRef);
    assert.notEqual(second, first);
    catalog.close();
    catalog = undefined;
    catalog = createStateCatalog(root);
    assert.equal(catalog.latestExecutionRef(run.runRef), second);
  } finally {
    catalog?.close();
    await rm(root, { recursive: true, force: true });
  }
});
