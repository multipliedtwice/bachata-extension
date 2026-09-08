const assert = require("node:assert/strict");
const { mkdtemp, readFile, rename, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createOrchestrationStore } = require("../dist/orchestrator/store.js");
const { createResourceBroker } = require("../dist/concurrency/resourceBroker.js");
const {
  completedPipeline,
  createController,
  createFakeConversationManager,
  createRepository,
  gitWorktreeSkip,
  reviewPipeline,
  workerPipeline,
} = require("./support/orchestration.cjs");

const integrationTodo = [
  "- [ ] [T1] Integrate one file",
  "  - Paths: src/one.txt",
  "  - Verify: none",
  "",
  "- [ ] [T2] Fail after T1",
  "  - Depends on: T1",
  "  - Paths: src/two.txt",
  "  - Verify: none",
  "",
].join("\n");

// The worker integrates T1 and then fails T2, which leaves a resumable run whose ledger records
// one task as accepted and integrated.
const integrateThenFail = () => async ({ options }) => {
  if (options.orchestrationTaskId === "T1") {
    await writeFile(path.join(options.workingDirectory, "src", "one.txt"), "after\n", "utf8");
    return completedPipeline();
  }
  throw new Error("T2 failed");
};

const failedIntegrationRun = async (root) => {
  const repository = await createRepository(root, integrationTodo, {
    "src/one.txt": "before\n",
    "src/two.txt": "before\n",
  });
  const manager = createFakeConversationManager(integrateThenFail());
  const controller = createController(root, repository, manager, {
    todoRetries: 0,
    todoMaxConcurrency: 1,
  });
  const failed = await controller.start();
  assert.equal(failed.status, "failed");
  assert.equal(failed.tasks.T1.status, "done");
  assert.equal(failed.tasks.T1.integrationRollbackCommit, undefined);
  await controller.dispose();
  return { repository, manager, failed };
};

// The rollback marker is written before a task integrates and cleared when it integrates. A
// ledger that records `done` while it still names one is a state resume cannot read: resetting
// the integration tree would discard work the ledger, the UI and the final record all report as
// accepted, and nothing re-runs a task that is already `done`.
test("resume refuses a ledger that records a task done while it still names a rollback commit", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-rollback-done-"));
  let second;
  try {
    const { repository, manager, failed } = await failedIntegrationRun(root);
    const store = createOrchestrationStore(path.join(root, "storage"));
    const stored = await store.load(failed.runId);
    stored.tasks.T1.integrationRollbackCommit = stored.baselineCommit;
    await store.save(stored);

    second = createController(root, repository, manager, { todoRetries: 0, todoMaxConcurrency: 1 });
    await assert.rejects(
      second.resumeIfAvailable(),
      /records T1 as done while still naming an integration rollback commit/u,
    );
    assert.equal(
      await readFile(path.join(stored.integrationWorktree, "src", "one.txt"), "utf8"),
      "after\n",
      "the accepted task's integrated work was discarded by a resume that reset the tree",
    );
    const afterRefusal = await store.load(failed.runId);
    assert.equal(afterRefusal.tasks.T1.status, "done");
    assert.equal(afterRefusal.tasks.T1.integrationRollbackCommit, stored.baselineCommit);
  } finally {
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// Integration is serialized and each task clears its own marker, so two live markers carry no
// ordering: `Object.values` order decided which one won, regardless of which was newer.
test("resume refuses a ledger naming a rollback commit for more than one task", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-rollback-ambiguous-"));
  let second;
  try {
    const { repository, manager, failed } = await failedIntegrationRun(root);
    const store = createOrchestrationStore(path.join(root, "storage"));
    const stored = await store.load(failed.runId);
    stored.tasks.T1.status = "blocked";
    stored.tasks.T1.integrationRollbackCommit = stored.baselineCommit;
    stored.tasks.T2.integrationRollbackCommit = stored.baselineCommit;
    await store.save(stored);

    second = createController(root, repository, manager, { todoRetries: 0, todoMaxConcurrency: 1 });
    await assert.rejects(
      second.resumeIfAvailable(),
      /rollback commit for more than one task \(T1, T2\)/u,
    );
    assert.equal(
      await readFile(path.join(stored.integrationWorktree, "src", "one.txt"), "utf8"),
      "after\n",
    );
  } finally {
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// Anything that stops the process between two saves persists the state the first one left, so
// `done` and the marker's removal have to be the same persisted step.
test("no persisted ledger state pairs a done task with an integration rollback commit", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-rollback-single-save-"));
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Integrate one file",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const store = createOrchestrationStore(path.join(root, "storage"));
    // Every save reads what the previous one left on disk, so this is every state a lost
    // workspace lease or a killed window could have stopped the run on.
    const persisted = [];
    controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      beforeOrchestrationOperation: async (operation, detail) => {
        if (operation !== "save") return;
        const state = await store.load(detail.runId).catch(() => undefined);
        if (state) persisted.push(state);
      },
    });
    const result = await controller.start();
    assert.equal(result.status, "completed", result.error ?? "");
    persisted.push(await store.load(result.runId));

    assert.ok(
      persisted.some((state) => state.tasks.T1.integrationRollbackCommit !== undefined),
      "the marker must still be persisted before the task integrates",
    );
    assert.deepEqual(
      persisted.flatMap((state) => Object.values(state.tasks)
        .filter((task) => task.status === "done" && task.integrationRollbackCommit !== undefined)
        .map((task) => task.spec.id)),
      [],
      "a persisted ledger recorded a done task that still names a rollback commit",
    );
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// A marker on a blocked task outlives the task that wrote it: the rollback failure blocks that
// task and the run carries on with its siblings, so a later task can integrate and be accepted
// after the marker was written. Resetting to the older point then discards that accepted work,
// which the `done` refusal above never sees because the marker sits on a blocked task.
test("resume refuses a rollback marker written before another task's work was accepted", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-rollback-stale-"));
  let second;
  try {
    const { repository, manager, failed } = await failedIntegrationRun(root);
    const store = createOrchestrationStore(path.join(root, "storage"));
    const stored = await store.load(failed.runId);
    assert.equal(stored.acceptedIntegrations, 1, "an accepted integration must be counted");
    // What the rollback-failure path leaves behind: the marker names the integration point as it
    // was before T1 was accepted, and the task holding it is blocked rather than done.
    stored.tasks.T2.status = "blocked";
    stored.tasks.T2.integrationRollbackCommit = stored.baselineCommit;
    stored.tasks.T2.integrationRollbackSequence = 0;
    await store.save(stored);

    second = createController(root, repository, manager, { todoRetries: 0, todoMaxConcurrency: 1 });
    await assert.rejects(
      second.resumeIfAvailable(),
      /rollback commit for T2 and records T1 as accepted/u,
    );
    assert.equal(
      await readFile(path.join(stored.integrationWorktree, "src", "one.txt"), "utf8"),
      "after\n",
      "resume reset the integration tree past work the ledger reports as accepted",
    );
    const afterRefusal = await store.load(failed.runId);
    assert.equal(afterRefusal.tasks.T2.integrationRollbackCommit, stored.baselineCommit);
  } finally {
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// The counts are what separate a stale marker from a legitimate recovery. A marker written after
// every acceptance the ledger records names a point that still contains all of it, so recovering
// to it throws nothing away and the run stays resumable.
test("resume recovers a rollback marker written after the accepted work it contains", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-rollback-current-"));
  let second;
  try {
    const { repository, manager, failed } = await failedIntegrationRun(root);
    const store = createOrchestrationStore(path.join(root, "storage"));
    const stored = await store.load(failed.runId);
    stored.tasks.T2.status = "blocked";
    stored.tasks.T2.integrationRollbackCommit = stored.integrationTree;
    stored.tasks.T2.integrationRollbackSequence = stored.acceptedIntegrations;
    await store.save(stored);

    second = createController(root, repository, manager, { todoRetries: 0, todoMaxConcurrency: 1 });
    const resumed = await second.resumeIfAvailable();
    assert.ok(resumed, "a marker that names the current integration point must stay resumable");
    assert.equal(resumed.tasks.T2.integrationRollbackCommit, undefined);
    assert.equal(
      await readFile(path.join(stored.integrationWorktree, "src", "one.txt"), "utf8"),
      "after\n",
      "the recovery discarded the accepted work its own marker contained",
    );
  } finally {
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// A ledger written before the count existed records no ordering at all. It cannot be read as
// "nothing was accepted after the marker", so it is recovered only while the run has accepted
// nothing there is anything to lose.
test("resume recovers a rollback marker with no recorded ordering when nothing was accepted", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-rollback-legacy-"));
  let second;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Integrate one file",
      "  - Paths: src/one.txt",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/one.txt": "before\n" });
    const manager = createFakeConversationManager(async () => {
      throw new Error("T1 failed");
    });
    const controller = createController(root, repository, manager, {
      todoRetries: 0,
      todoMaxConcurrency: 1,
    });
    const failed = await controller.start();
    assert.equal(failed.status, "failed");
    await controller.dispose();

    const store = createOrchestrationStore(path.join(root, "storage"));
    const stored = await store.load(failed.runId);
    // The shape a ledger written by the previous build has: a marker, and nothing ordering it.
    stored.tasks.T1.status = "blocked";
    stored.tasks.T1.integrationRollbackCommit = stored.integrationTree;
    delete stored.tasks.T1.integrationRollbackSequence;
    delete stored.acceptedIntegrations;
    await store.save(stored);

    second = createController(root, repository, manager, { todoRetries: 0, todoMaxConcurrency: 1 });
    const resumed = await second.resumeIfAvailable();
    assert.ok(resumed, "a ledger written by the previous build must still be recoverable");
    assert.equal(resumed.tasks.T1.integrationRollbackCommit, undefined);
  } finally {
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

const brokerRefusingVerificationRelease = (underlying, quarantines, onAcquire = async () => undefined) => ({
  ownerId: underlying.ownerId,
  listQuarantine: underlying.listQuarantine,
  clearQuarantine: underlying.clearQuarantine,
  dispose: underlying.dispose,
  acquire: async (request) => {
    const lease = await underlying.acquire(request);
    if (!String(request.label ?? "").startsWith("TODO verification ")) {
      return lease;
    }
    const restore = await onAcquire();
    return {
      ...lease,
      release: async () => {
        await restore?.();
        throw new Error("resource database refused the release");
      },
      quarantine: async (reason) => {
        quarantines.push(reason);
        await lease.quarantine(reason);
      },
    };
  },
});

const checkedTodo = [
  "- [ ] [T1] Verify one file",
  "  - Paths: src",
  "  - Verify: bachata:workspace-integrity",
  "",
].join("\n");

// A release that rejects leaves the physical keys held for the rest of the session. Every other
// lease site quarantines on that, and this one deleted the lease from `activeCheckLeases` before
// releasing, so nothing else would ever reach it.
test("a verification lease whose release is refused is quarantined rather than left held", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-check-lease-release-"));
  const underlying = createResourceBroker({
    databasePath: path.join(root, "global", "resources.sqlite"),
    ownerId: "release-refusal",
    pollIntervalMs: 10,
  });
  let controller;
  const quarantines = [];
  try {
    const repository = await createRepository(root, checkedTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    controller = createController(
      root,
      repository,
      manager,
      { todoRetries: 0, todoCheckSlotTimeoutMs: 1000 },
      brokerRefusingVerificationRelease(underlying, quarantines),
    );
    const result = await controller.start();
    assert.equal(result.status, "failed");
    assert.match(result.tasks.T1.lastError ?? "", /resource database refused the release/u);
    assert.equal(
      quarantines.filter((reason) => /Verification lease release was not confirmed/u.test(reason)).length,
      1,
      "an unconfirmed release must quarantine the lease it could not settle",
    );
  } finally {
    await controller?.dispose().catch(() => undefined);
    await underlying.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// The release runs in a `finally`, so a rejection there used to replace whatever the checks
// themselves had failed with: the caller was told the lease could not be released and never why
// verification failed.
test("a refused verification lease release keeps the failure the checks raised", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-check-lease-aggregate-"));
  const storageRoot = path.join(root, "storage");
  const underlying = createResourceBroker({
    databasePath: path.join(root, "global", "resources.sqlite"),
    ownerId: "release-refusal-aggregate",
    pollIntervalMs: 10,
  });
  let controller;
  let sabotagedPath;
  let backupPath;
  const quarantines = [];
  try {
    const repository = await createRepository(root, checkedTodo, { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    // The verification checkpoint save fails inside the check body, which is the failure the
    // release must not erase.
    const sabotage = async () => {
      const active = JSON.parse(await readFile(
        path.join(storageRoot, "orchestration", "active-run.json"),
        "utf8",
      ));
      sabotagedPath = path.join(storageRoot, "orchestration", "runs", active.runId);
      backupPath = `${sabotagedPath}.backup`;
      await rename(sabotagedPath, backupPath);
      await writeFile(sabotagedPath, "not a directory", "utf8");
      return async () => {
        await rm(sabotagedPath, { force: true });
        await rename(backupPath, sabotagedPath);
      };
    };
    controller = createController(
      root,
      repository,
      manager,
      { todoRetries: 0, todoCheckSlotTimeoutMs: 1000 },
      brokerRefusingVerificationRelease(underlying, quarantines, sabotage),
    );
    const result = await controller.start();
    assert.equal(result.status, "failed");
    assert.match(
      result.tasks.T1.lastError ?? "",
      /and its resource lease could not be released/u,
      "the release failure replaced the failure the checks raised",
    );
    assert.equal(
      quarantines.filter((reason) => /Verification lease release was not confirmed/u.test(reason)).length,
      1,
    );
  } finally {
    if (sabotagedPath && backupPath) {
      await rm(sabotagedPath, { force: true }).catch(() => undefined);
      await rename(backupPath, sabotagedPath).catch(() => undefined);
    }
    await controller?.dispose().catch(() => undefined);
    await underlying.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// A revision overwrites `task.conversationId`, so the implementation room it replaced used to
// stay in the active set for the life of the orchestrator: a Stop, or a lost workspace lease,
// then spends its bounded budget interrupting rooms that finished long before.
test("a bounded revision leaves no finished conversation in the active set", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-revision-room-leak-"));
  const workspaceLeaseLost = new AbortController();
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Bound the retry loop",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "  - Verify Final: bachata:project-checks",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    let reviews = 0;
    let revisions = 0;
    const manager = createFakeConversationManager(
      async ({ options }) => {
        await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
        return workerPipeline("Rewrote src/value.txt.");
      },
      undefined,
      undefined,
      {
        "self-improvement-review": async () => {
          reviews += 1;
          return reviewPipeline(reviews === 1
            ? {
                verdict: "reject",
                summary: "Not yet.",
                defects: [{
                  id: "D1",
                  severity: "major",
                  statement: "The budget is still unbounded.",
                  requiredChange: "Bound it.",
                  evidence: [],
                }],
              }
            : undefined);
        },
        "self-improvement-revision": async () => {
          revisions += 1;
          return workerPipeline("Bounded the budget.");
        },
      },
    );
    controller = createController(
      root,
      repository,
      manager,
      { todoRetries: 0, improveMaxRevisionCycles: 1 },
      undefined,
      {
        workspaceLease: {
          signal: workspaceLeaseLost.signal,
          assertValid: () => undefined,
          isValid: () => true,
          release: async () => undefined,
          quarantine: async () => undefined,
        },
      },
    );
    const improved = await controller.improve();
    assert.equal(improved.ledger.status, "completed", improved.ledger.error ?? "");
    assert.equal(reviews, 2);
    assert.equal(revisions, 1);

    // Losing the workspace lease interrupts everything the orchestrator still counts as active.
    workspaceLeaseLost.abort();
    assert.deepEqual(
      manager.interrupted,
      [],
      "a finished conversation was still counted as active after the run completed",
    );
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
