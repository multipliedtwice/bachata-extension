const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { createRepository, git, gitWorktreeSkip } = require("./support/orchestration.cjs");
const { loadManagerHarness } = require("./support/runtimeHarness.cjs");
const { makeScratchChild, removeScratch, scratchRoot } = require("./support/scratch.cjs");

const featureDelivery = require("../presets/feature-delivery.pipeline.json");
const todoImplementation = require("../presets/todo-implementation.pipeline.json");
const {
  MANAGED_LEAD_REVIEW_MARKER,
  MANAGED_WORKER_REVISION_MARKER,
} = require("../dist/runtime/managedLeadReview.js");

// P3. One harness, the whole chain.
//
// `tests/retentionLifecycle.test.cjs` drives the worktree manager and the orchestrator against a
// real repository with a fake conversation manager. `tests/featureDelivery.test.cjs` drives the
// runtime with local adapters and no orchestrator. Each stands in for what the other is about, so
// neither could show that a run whose review is a real runtime turn is the run that is then held
// as a retained orchestration worktree, verified, and applied.
//
// This file has no fake conversation manager and no fake runtime. `createTodoOrchestrator` drives
// the real `createConversationManager`, which builds a real `createRuntime` per conversation,
// which runs the real `executePipeline` over a shipped preset, inside worktrees the real
// `createWorktreeManager` owns, against a real Git repository. What is doubled is the extension
// host, the provider transports, and the answers a human would give at a gate — and nothing else.

const scratch = async () => await scratchRoot("bachata-orchestrated-");

const todoSource = (checks = [
  "  - Verify: bachata:workspace-integrity",
  "  - Verify Final: bachata:project-checks",
]) => [
  "- [ ] [T1] Deliver the feature",
  "  - Paths: src",
  ...checks,
  "",
].join("\n");

/** The role a turn is addressed to, read from the prompt the provider is actually handed. */
const roleOf = (prompt) => /^Role: ([^(\n]+)/u.exec(prompt)?.[1]?.trim() ?? "";

// A revision turn carries no role header: it is the controller handing the same participant its
// own failing evidence and asking for a repair. Recognising it by that evidence, rather than by
// counting sends, is what keeps the classification honest.
const isRevision = (prompt) => /^Required verification: /mu.test(prompt);

// A Lead rejection takes the other route: the run leaves the Lead step and re-enters the Worker
// step, so the Worker's turn does carry a role header. What identifies it is the controller's own
// revision block, which only a rejected candidate produces.
const isLeadRevision = (prompt) => prompt.includes(MANAGED_WORKER_REVISION_MARKER);

/** The candidate the controller told the Lead it is judging. */
const candidateOf = (prompt) => /^Candidate: ([0-9a-f]{64})$/mu.exec(prompt)?.[1] ?? "";

// P3. A managed local Lead answers with a verdict, not with prose. These build the two valid
// answers; every test that wants an unusable one writes it out in full, so what "unusable" means
// is visible at the point it is asserted rather than hidden in a helper.
const leadAccepts = (candidate, summary = "The implementation is ready.") =>
  JSON.stringify({ candidate, review: { verdict: "accept", summary, defects: [] } });

const leadRejects = (candidate, defects) =>
  JSON.stringify({
    candidate,
    review: { verdict: "reject", summary: "The candidate is not ready.", defects },
  });

/**
 * Drive one orchestration run through the real chain.
 *
 * `worker` is called for each Worker turn with the directory that turn was given, so a test can
 * write what a Worker would write and nothing else decides where it lands. Every turn's exact
 * request is recorded, because what the Lead was handed is a different question from what the run
 * recorded afterwards.
 */
const combinedRun = async (root, options = {}) => {
  const repository = await createRepository(root, options.todo ?? todoSource(), {
    "src/feature.mjs": "export const feature = 1;\n",
    "README.md": "# fixture\n",
    ...options.files,
  });
  const requests = [];
  const gates = [];
  const lastRole = new Map();
  let harness;
  harness = loadManagerHarness({
    workspaceDirectories: [repository],
    ...(options.storageDirectory === undefined ? {} : { storageDirectory: options.storageDirectory }),
    showInformationMessage: async () => "Open",
    onAdapterSend: ({ agentId, request, sendCount }) => {
      harness.adapterControls.get(agentId)?.release.resolve();
      const workingDirectory = request.workingDirectory ?? repository;
      const declared = roleOf(request.prompt);
      const revision = declared === "" && isRevision(request.prompt);
      const role = declared === "" ? lastRole.get(agentId) ?? "" : declared;
      if (declared !== "") lastRole.set(agentId, declared);
      requests.push({
        agentId,
        sendCount,
        role,
        revision,
        leadRevision: isLeadRevision(request.prompt),
        workingDirectory,
        prompt: request.prompt,
      });
      if (role === "Master") {
        return { answer: JSON.stringify({ status: "continue", deviations: [] }) };
      }
      if (role === "Worker") {
        const turn = requests.filter((entry) => entry.role === "Worker").length;
        const leadRevision = isLeadRevision(request.prompt);
        options.worker?.({ workingDirectory, turn, revision, leadRevision, repository, prompt: request.prompt });
        return { answer: `Worker finished turn ${String(turn)}.` };
      }
      if (role === "Lead Reviewer") {
        const turn = requests.filter((entry) => entry.role === "Lead Reviewer").length;
        const candidate = candidateOf(request.prompt);
        return {
          answer: options.lead?.({ turn, candidate, prompt: request.prompt }) ?? leadAccepts(candidate),
        };
      }
      return { answer: `${role} finished.` };
    },
    managerOptions: {
      // The only human input this harness supplies. An unattended orchestration pipeline has no
      // human gates by construction — that is what makes it unattended — so nothing here answers
      // one in practice; what this covers is any other interaction the runtime opens, which would
      // otherwise hang the run until its timeout instead of failing with a reason.
      focusInteraction: ({ interactionRef }) => {
        gates.push(interactionRef);
        void harness.manager
          .handleMessage({ type: "interaction.submit", interactionRef, selected: ["continue"], freeText: "" })
          .catch(() => undefined);
      },
    },
  });
  await harness.manager.handleMessage({
    type: "initiative.create",
    title: "Deliver the feature",
    goal: "Deliver the feature behind the declared checks.",
  });
  // Loaded through the harness so the orchestrator, the manager and the runtime are one module
  // graph over one set of host doubles.
  const { createTodoOrchestrator } = harness.requireWithVscode("../../dist/orchestrator/controller.js");
  const controller = createTodoOrchestrator({
    storageRoot: harness.storageDirectory,
    workspaceRoot: () => repository,
    isWorkspaceTrusted: () => true,
    configuration: () => ({ get: (key, fallback) => (key === "todoRetries" ? 0 : fallback) }),
    output: { appendLine: () => undefined },
    manager: harness.manager,
  });
  const run = await controller.start().then((value) => ({ run: value }), (error) => ({ error }));
  return {
    ...run,
    repository,
    requests,
    gates,
    controller,
    harness,
    storageDirectory: harness.storageDirectory,
    dispose: async () => {
      harness.adapterControlHistory.forEach((control) => control.release.resolve());
      await controller.dispose();
      await harness.manager.dispose();
      harness.cleanup();
    },
  };
};

const workspaceState = (repository) => ({
  feature: fs.readFileSync(path.join(repository, "src/feature.mjs"), "utf8"),
  status: git(repository, "status", "--porcelain"),
  head: git(repository, "rev-parse", "HEAD"),
});

test("one run through the real chain, from the Worker's own worktree to Apply", gitWorktreeSkip, async (t) => {
  // One orchestration run, asserted from every angle it has to answer for. Driving a separate
  // run per claim would repeat the same seven provider turns and the same Git worktree setup for
  // each; what differs between the claims is what is read afterwards, not what happened.
  const root = await scratch();
  // The storage root outlives both controllers on purpose: a reload has to find what was
  // persisted, and a harness that owned the directory would delete it on the way out.
  const storage = await makeScratchChild(root, "storage");
  const session = await combinedRun(root, {
    storageDirectory: storage,
    worker: ({ workingDirectory }) => {
      fs.writeFileSync(path.join(workingDirectory, "src/feature.mjs"), "export const feature = 2;\n", "utf8");
    },
  });
  const { repository, storageDirectory } = session;
  let reloadedHarness;
  let reloaded;
  let disposed = false;
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", session.run.error ?? "");
    const runId = session.run.runId;

    await t.test("the shipped pipeline's own steps ran, in its own order", () => {
      // The step order observed through the turns the providers were actually sent. Only
      // `executePipeline` produces this sequence, and only from the definition the manager
      // resolved for the task.
      const taskRoles = session.requests.filter((entry) => entry.role !== "Master").map((entry) => entry.role);
      assert.deepEqual(taskRoles, ["Lead Planner", "Worker", "Lead Reviewer"]);
      assert.deepEqual(
        todoImplementation.steps.map((step) => step.id),
        ["assign-roles", "lead-plan", "worker-implementation", "lead-review"],
        "the shipped pipeline this run drove is not the one asserted here",
      );
    });

    await t.test("every task turn ran inside the worktree the controller owns", () => {
      const taskWorktrees = new Set(
        session.requests.filter((entry) => entry.role !== "Master").map((entry) => entry.workingDirectory),
      );
      assert.equal(taskWorktrees.size, 1, JSON.stringify([...taskWorktrees]));
      const [taskWorktree] = [...taskWorktrees];
      assert.equal(
        taskWorktree.startsWith(path.join(storageDirectory, "orchestration", "runs")),
        true,
        taskWorktree,
      );
      assert.ok(/[/\\]tasks[/\\]T1-/u.test(taskWorktree), taskWorktree);
      assert.notEqual(taskWorktree, repository);
    });

    await t.test("the selected workspace is untouched, and the work is retained instead", () => {
      const state = workspaceState(repository);
      assert.equal(state.feature, "export const feature = 1;\n", "the run wrote the selected workspace");
      assert.equal(state.status, "", "the run left the selected workspace dirty");
      assert.equal(fs.existsSync(session.run.integrationWorktree), true);
      assert.equal(
        fs.readFileSync(path.join(session.run.integrationWorktree, "src/feature.mjs"), "utf8"),
        "export const feature = 2;\n",
        "the accepted work never reached the retained integration worktree",
      );
    });

    await t.test("each check result is bound to the fingerprint of the candidate it judged", () => {
      const verification = session.harness.transcript.filter(
        (entry) => entry.eventType === "verification.controller",
      );
      assert.ok(verification.length >= 2, `controller verification ran ${String(verification.length)} times`);
      const fingerprints = new Set();
      for (const entry of verification) {
        assert.deepEqual(
          entry.data.requiredVerificationIds,
          todoImplementation.managedPolicy.verificationChecks.map((check) => check.id),
        );
        assert.deepEqual(entry.data.issues, []);
        assert.match(String(entry.data.workspaceFingerprint), /^[0-9a-f]{64}$/u);
        fingerprints.add(entry.data.workspaceFingerprint);
      }
      assert.equal(fingerprints.size, 1, "the Worker and the Lead were judged against different candidates");
    });

    await t.test("the request the Lead is handed already carries those results", () => {
      // The request, not the recorded answer: the answer is augmented after the provider returns,
      // so asserting on it proves what the run wrote down rather than what the Lead read.
      const leadRequest = session.requests.find((entry) => entry.role === "Lead Reviewer");
      assert.ok(leadRequest, "the Lead never ran");
      const declared = todoImplementation.managedPolicy.verificationChecks;
      // The controller's own block, isolated from the Worker's recorded answer — which also
      // carries the evidence, because the Worker's answer was augmented with it. Asserting over
      // the whole prompt would count both copies and prove neither.
      const marker = leadRequest.prompt.indexOf(MANAGED_LEAD_REVIEW_MARKER);
      assert.ok(marker >= 0, "the Lead was not handed the controller's own review block");
      assert.equal(
        leadRequest.prompt.split(MANAGED_LEAD_REVIEW_MARKER).length - 1,
        1,
        "the controller's review block was delivered more than once",
      );
      const block = leadRequest.prompt.slice(marker);
      for (const check of declared) {
        assert.match(block, new RegExp(`^check: ${check.id}$`, "mu"), block.slice(0, 800));
        assert.match(block, new RegExp(`^command: ${check.command}$`, "mu"));
      }
      // Per check and exact: the id, the command, the status, the exit information and a bounded
      // output field, each on its own line rather than folded into a sentence.
      assert.equal((block.match(/^check: /gmu) ?? []).length, declared.length);
      assert.equal((block.match(/^status: passed$/gmu) ?? []).length, declared.length);
      assert.equal((block.match(/^exit: /gmu) ?? []).length, declared.length);
      assert.equal((block.match(/^output: /gmu) ?? []).length, declared.length);
      // And the candidate those results belong to, which is what the Lead's verdict must name.
      const verification = session.harness.transcript.filter(
        (entry) => entry.eventType === "verification.controller",
      );
      assert.match(block, /^Candidate: [0-9a-f]{64}$/mu);
      assert.equal(candidateOf(block), String(verification[0].data.workspaceFingerprint));
      const order = session.requests.filter((entry) => entry.role !== "Master").map((entry) => entry.role);
      assert.ok(order.indexOf("Worker") < order.indexOf("Lead Reviewer"), JSON.stringify(order));
    });

    await t.test("the accepted verdict is recorded as the decision that let the run finish", () => {
      const decisions = session.harness.transcript.filter(
        (entry) => entry.eventType === "review.managedLead",
      );
      assert.equal(decisions.length, 1, JSON.stringify(decisions.map((entry) => entry.data)));
      assert.equal(decisions[0].data.decision, "accept");
      // The tree the Lead judged is the tree that still existed when it finished: a Lead that had
      // edited files would have moved the fingerprint and the acceptance would have been refused.
      assert.equal(decisions[0].data.candidate, decisions[0].data.currentCandidate);
    });

    await t.test("Apply is refused before the workspace is touched at all", async () => {
      // The run's checks ran against a task worktree that no longer exists, so the candidate a
      // person would apply has no complete evidence yet. That is missing evidence, not an absence
      // of bad news.
      const before = workspaceState(repository);
      await assert.rejects(
        session.controller.applyRetained(runId),
        /Required verification: bachata:workspace-integrity: not run/u,
      );
      assert.deepEqual(workspaceState(repository), before, "a refused Apply changed the workspace");
      assert.equal(fs.existsSync(session.run.integrationWorktree), true);
    });

    await t.test("the run and its evidence survive disposal and reload", async () => {
      assert.deepEqual(
        session.controller.getSnapshot().retainedRuns.map((entry) => entry.runId),
        [runId],
      );
      // Everything that held the run in memory goes away.
      await session.dispose();
      disposed = true;
      // A second manager and a second orchestrator over the same storage find the run by what was
      // persisted. The recheck covers the complete recorded command set — a rerun that covered the
      // final checks alone would authorize an Apply nothing verified.
      reloadedHarness = loadManagerHarness({
        workspaceDirectories: [repository],
        storageDirectory,
        onAdapterSend: () => ({ answer: "unused" }),
      });
      const { createTodoOrchestrator } = reloadedHarness.requireWithVscode("../../dist/orchestrator/controller.js");
      reloaded = createTodoOrchestrator({
        storageRoot: storageDirectory,
        workspaceRoot: () => repository,
        isWorkspaceTrusted: () => true,
        configuration: () => ({ get: (key, fallback) => (key === "todoRetries" ? 0 : fallback) }),
        output: { appendLine: () => undefined },
        manager: reloadedHarness.manager,
      });
      const rechecked = await reloaded.rerunRetainedChecks(runId);
      assert.deepEqual(
        rechecked.map((check) => check.command).sort(),
        ["bachata:project-checks", "bachata:workspace-integrity"],
        "a rerun must cover every command the run declared",
      );
      rechecked.forEach((check) => assert.equal(check.status, "passed", check.stderr));
    });

    await t.test("passing evidence authorizes an Apply that stages and never commits", async () => {
      const before = workspaceState(repository);
      const applied = await reloaded.applyRetained(runId);
      assert.equal(applied.applied, true, applied.reason ?? "");
      assert.equal(
        fs.readFileSync(path.join(repository, "src/feature.mjs"), "utf8"),
        "export const feature = 2;\n",
      );
      assert.equal(git(repository, "rev-parse", "HEAD"), before.head, "Apply created a commit");
      assert.equal(git(repository, "rev-list", "--count", "HEAD"), "1");
      assert.match(git(repository, "status", "--porcelain"), /^M {2}src\/feature\.mjs$/mu);
      assert.equal(applied.stagedFiles.includes("README.md"), false, JSON.stringify(applied.stagedFiles));
      // And the same retained work cannot be applied a second time.
      const second = await reloaded.applyRetained(runId);
      assert.equal(second.applied, false, "the same retained work was applied twice");
    });
  } finally {
    await reloaded?.dispose();
    await reloadedHarness?.manager.dispose();
    reloadedHarness?.cleanup();
    if (!disposed) await session.dispose();
    await removeScratch(root);
  }
});

test("a candidate the declared checks refuse is repaired through one revision and then reviewed", gitWorktreeSkip, async () => {
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory, turn }) => {
      fs.writeFileSync(
        path.join(workingDirectory, "src/feature.mjs"),
        turn === 1 ? "export const feature = (\n" : "export const feature = 4;\n",
        "utf8",
      );
    },
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", session.run.error ?? "");

    // Two Worker turns, one Lead review: the Worker repaired its own work, and the Lead was not
    // asked to review a candidate the controller could not verify.
    const workerTurns = session.requests.filter((entry) => entry.role === "Worker");
    const leadTurns = session.requests.filter((entry) => entry.role === "Lead Reviewer");
    assert.equal(workerTurns.length, 2, JSON.stringify(session.requests.map((entry) => entry.role)));
    assert.equal(leadTurns.length, 1);

    // The revision turn carried the controller's own failing evidence, with a real exit code and
    // bounded output from the command that produced it.
    const revision = workerTurns[1];
    assert.match(revision.prompt, /^check: project-checks$/mu);
    assert.match(revision.prompt, /^status: failed$/mu);
    // Exit information is the controller's own field for a check it aggregates rather than
    // spawns, and the output is the failing check's real diagnostics, bounded.
    assert.match(revision.prompt, /^exit: (?:n\/a|[0-9]+)$/mu);
    assert.match(revision.prompt, /^output: src\/feature\.mjs:1: /mu);
    assert.match(revision.prompt, /^Required verification: project-checks: failed$/mu);

    // And the Lead saw the repaired candidate passing, not the failure. Counted inside the
    // controller's own review block: the Worker's recorded answer carries the same evidence, so
    // counting the whole prompt would count both copies and prove neither.
    const leadBlock = leadTurns[0].prompt.slice(leadTurns[0].prompt.indexOf(MANAGED_LEAD_REVIEW_MARKER));
    assert.equal((leadBlock.match(/^status: passed$/gmu) ?? []).length, 2);
    assert.equal(
      fs.readFileSync(path.join(session.run.integrationWorktree, "src/feature.mjs"), "utf8"),
      "export const feature = 4;\n",
    );
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("a Worker write outside the accepted scope is refused, named, and repairable", gitWorktreeSkip, async () => {
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory, revision }) => {
      fs.writeFileSync(path.join(workingDirectory, "src/feature.mjs"), "export const feature = 5;\n", "utf8");
      const outside = path.join(workingDirectory, "README.md");
      if (revision) {
        // The repair: put back what the task never accepted permission to change.
        fs.writeFileSync(outside, "# fixture\n", "utf8");
        return;
      }
      // Outside `Paths: src`, which is the whole of what this task accepted.
      fs.writeFileSync(outside, "# rewritten by the worker\n", "utf8");
    },
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", session.run.error ?? "");

    // The out-of-scope write did not pass verification: the controller's own workspace-integrity
    // check failed, and the Worker was handed that exact failure rather than a summary of it.
    const workerTurns = session.requests.filter((entry) => entry.role === "Worker");
    assert.equal(workerTurns.length, 2, JSON.stringify(session.requests.map((entry) => entry.role)));
    assert.equal(workerTurns[1].revision, true);
    assert.match(workerTurns[1].prompt, /^Required verification: workspace-integrity: failed$/mu);
    assert.match(workerTurns[1].prompt, /^check: workspace-integrity$/mu);
    assert.match(workerTurns[1].prompt, /^status: failed$/mu);

    // And what the accepted candidate holds is the in-scope change and nothing else.
    assert.equal(
      fs.readFileSync(path.join(session.run.integrationWorktree, "src/feature.mjs"), "utf8"),
      "export const feature = 5;\n",
    );
    assert.equal(
      fs.readFileSync(path.join(session.run.integrationWorktree, "README.md"), "utf8"),
      "# fixture\n",
      "an out-of-scope change was retained",
    );
    // The selected workspace saw none of it either way.
    assert.equal(git(session.repository, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(session.repository, "README.md"), "utf8"), "# fixture\n");
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("a Worker that never comes back into scope fails the run and retains nothing", gitWorktreeSkip, async () => {
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory }) => {
      fs.writeFileSync(path.join(workingDirectory, "src/feature.mjs"), "export const feature = 5;\n", "utf8");
      fs.writeFileSync(path.join(workingDirectory, "README.md"), "# rewritten by the worker\n", "utf8");
    },
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "failed");
    // The Lead was never asked to review work the controller could not verify.
    assert.equal(session.requests.some((entry) => entry.role === "Lead Reviewer"), false);
    assert.deepEqual(session.controller.getSnapshot().retainedRuns, []);
    // And the selected workspace is exactly as it was.
    assert.equal(git(session.repository, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(session.repository, "README.md"), "utf8"), "# fixture\n");
    assert.equal(
      fs.readFileSync(path.join(session.repository, "src/feature.mjs"), "utf8"),
      "export const feature = 1;\n",
    );
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("work that was never verified stays inspectable, and discarding is what removes it", gitWorktreeSkip, async () => {
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory }) => {
      fs.writeFileSync(path.join(workingDirectory, "src/feature.mjs"), "export const feature = 7;\n", "utf8");
    },
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", JSON.stringify({
      error: session.run.error,
      tasks: Object.values(session.run.tasks).map(({ spec, status, lastError, result }) => ({
        id: spec.id,
        status,
        lastError,
        result,
      })),
      finalChecks: session.run.finalChecks,
      output: session.harness.outputLines.slice(-20),
      failures: session.harness.transcript.filter((entry) =>
        /error|failed|interrupt/iu.test(`${entry.eventType} ${entry.message}`)).slice(-10),
    }, null, 2));
    const runId = session.run.runId;
    await assert.rejects(session.controller.applyRetained(runId), /Required verification/u);
    // Refused, and still there to read: the retained worktree, its changed paths and its patch.
    assert.equal(fs.existsSync(session.run.integrationWorktree), true);
    assert.equal(git(session.repository, "status", "--porcelain"), "");
    assert.equal(
      fs.readFileSync(path.join(session.run.integrationWorktree, "src/feature.mjs"), "utf8"),
      "export const feature = 7;\n",
    );

    await session.controller.cleanupRetained(runId);
    assert.equal(fs.existsSync(session.run.integrationWorktree), false, "discard left the worktree behind");
    assert.deepEqual(session.controller.getSnapshot().retainedRuns, []);
    // Discarding changed nothing in the workspace.
    assert.equal(git(session.repository, "status", "--porcelain"), "");
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

// P3. What a local Lead's own decision does to the run.
//
// The combined harness already proved that a local Lead is handed the controller's authoritative
// results before it answers. It did not prove that its answer controls anything, and it did not,
// because a local Lead's result carried no `managedState` and `managedTransition` moves a run only
// when one is present. A Lead could refuse a candidate in plain English and the run would advance,
// integrate it and offer it for Apply. These tests are about the answer, not about the evidence.

const oneDefect = [
  {
    id: "missing-guard",
    severity: "blocker",
    statement: "The exported value is the placeholder, not the delivered feature.",
    requiredChange: "Export the delivered value.",
    evidence: ["src/feature.mjs:1"],
  },
];

test("a Lead rejection sends the task back to the Worker and only the accepted revision is retained", gitWorktreeSkip, async () => {
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory, turn }) => {
      fs.writeFileSync(
        path.join(workingDirectory, "src/feature.mjs"),
        turn === 1 ? "export const feature = 2;\n" : "export const feature = 3;\n",
        "utf8",
      );
    },
    lead: ({ turn, candidate }) =>
      turn === 1 ? leadRejects(candidate, oneDefect) : leadAccepts(candidate),
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", session.run.error ?? "");

    const workerTurns = session.requests.filter((entry) => entry.role === "Worker");
    const leadTurns = session.requests.filter((entry) => entry.role === "Lead Reviewer");
    // The rejection moved the run: a second Worker turn exists, and it exists because the Lead
    // said so rather than because a check failed.
    assert.equal(workerTurns.length, 2, JSON.stringify(session.requests.map((entry) => entry.role)));
    assert.equal(leadTurns.length, 2);
    assert.equal(workerTurns[0].leadRevision, false);
    assert.equal(workerTurns[1].leadRevision, true, "the second Worker turn was not a Lead revision");
    assert.equal(workerTurns[1].revision, false, "the Lead rejection was routed as a failing-check revision");

    // The Worker was handed the Lead's exact defect, and the controller's own results for the
    // candidate the Lead judged, kept apart from each other.
    const revision = workerTurns[1].prompt;
    assert.match(revision, /^1\. \[missing-guard\] \(blocker\) The exported value is the placeholder, not the delivered feature\.$/mu);
    assert.match(revision, /^ {3}required change: Export the delivered value\.$/mu);
    assert.match(revision, /^ {3}evidence cited: src\/feature\.mjs:1$/mu);
    assert.match(revision, /Defects the Lead named \(the Lead's own words, not a check result\)/u);
    assert.match(revision, /Bachata controller verification against that same candidate \(authoritative, run by the controller\)/u);
    const revisionBlock = revision.slice(revision.indexOf(MANAGED_WORKER_REVISION_MARKER));
    assert.equal((revisionBlock.match(/^check: /gmu) ?? []).length, 2);
    assert.equal((revisionBlock.match(/^status: passed$/gmu) ?? []).length, 2);

    // Both Worker turns wrote the same worktree, and it is the one the controller owns.
    assert.equal(workerTurns[0].workingDirectory, workerTurns[1].workingDirectory);
    assert.notEqual(workerTurns[0].workingDirectory, session.repository);

    // The checks ran again over the revision, and the second Lead judged that revision rather
    // than the candidate it had already refused.
    const verification = session.harness.transcript.filter(
      (entry) => entry.eventType === "verification.controller",
    );
    assert.equal(verification.length, 4, JSON.stringify(verification.map((entry) => entry.message)));
    verification.forEach((entry) => assert.deepEqual(entry.data.issues, []));
    const rejected = candidateOf(leadTurns[0].prompt);
    const revised = candidateOf(leadTurns[1].prompt);
    assert.match(rejected, /^[0-9a-f]{64}$/u);
    assert.notEqual(revised, rejected, "the final Lead was shown the candidate it had already refused");

    const decisions = session.harness.transcript.filter(
      (entry) => entry.eventType === "review.managedLead",
    );
    assert.deepEqual(decisions.map((entry) => entry.data.decision), ["reject", "accept"]);
    assert.deepEqual(decisions[0].data.defects, ["missing-guard"]);

    // Only the accepted revision reaches the retained tree, and the selected workspace saw none
    // of it.
    assert.equal(
      fs.readFileSync(path.join(session.run.integrationWorktree, "src/feature.mjs"), "utf8"),
      "export const feature = 3;\n",
      "the retained tree does not hold the revision the Lead accepted",
    );
    assert.equal(git(session.repository, "status", "--porcelain"), "");
    assert.equal(
      fs.readFileSync(path.join(session.repository, "src/feature.mjs"), "utf8"),
      "export const feature = 1;\n",
    );
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("a Lead that keeps rejecting runs out of the task's own revision budget and retains nothing", gitWorktreeSkip, async () => {
  // The budget is the managed policy's `maxRevisionCycles`, which is the same one a failing check
  // spends. A second counter for Lead rejections would be a second, unbounded budget.
  const root = await scratch();
  const session = await combinedRun(root, {
    worker: ({ workingDirectory, turn }) => {
      fs.writeFileSync(
        path.join(workingDirectory, "src/feature.mjs"),
        `export const feature = ${String(turn + 1)};\n`,
        "utf8",
      );
    },
    lead: ({ candidate }) => leadRejects(candidate, oneDefect),
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "failed");
    assert.equal(todoImplementation.managedPolicy.maxRevisionCycles, 1);
    // One rejection is affordable; the second exhausts the budget and fails the task.
    const leadTurns = session.requests.filter((entry) => entry.role === "Lead Reviewer");
    assert.equal(leadTurns.length, 2, JSON.stringify(session.requests.map((entry) => entry.role)));
    // The run records why: two rejections, and the second one had no budget left to spend.
    const decisions = session.harness.transcript.filter(
      (entry) => entry.eventType === "review.managedLead",
    );
    assert.deepEqual(decisions.map((entry) => entry.data.decision), ["reject", "reject"]);
    const failure = session.harness.transcript.find(
      (entry) => entry.kind === "error" && /revision budget/u.test(String(entry.text ?? "")),
    );
    assert.ok(failure, JSON.stringify(session.harness.transcript.filter((entry) => entry.kind === "error").map((entry) => entry.text)));
    assert.deepEqual(session.controller.getSnapshot().retainedRuns, []);
    assert.equal(git(session.repository, "status", "--porcelain"), "");
    assert.equal(
      fs.readFileSync(path.join(session.repository, "src/feature.mjs"), "utf8"),
      "export const feature = 1;\n",
    );
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("each task gets its own revision budget, and one task's rejection does not spend another's", gitWorktreeSkip, async () => {
  // WHAT THIS PINS, AND WHY IT IS NOT OBVIOUS FROM READING THE CODE. The revision budget and the
  // pending Lead directive live in `managedTaskState.ts`, which holds the state of ONE task and
  // discards it when the task changes or ends. Two things follow, and only the second is visible
  // from that module alone: nothing accumulates across tasks, and no task can read another task's
  // budget. Whether the SECOND of those actually holds through the real runner depends on the
  // task id changing between tasks, which is decided hundreds of lines away, so it is asserted
  // here rather than assumed.
  //
  // Two tasks, one run, one runtime: each is rejected once and accepted once. The budget is 1, so
  // if the second task inherited the first task's spent cycle its own first rejection would
  // exhaust the budget and fail the run.
  const root = await scratch();
  const twoTasks = [
    "- [ ] [T1] Deliver the feature",
    "  - Paths: src",
    "  - Verify: bachata:workspace-integrity",
    "  - Verify Final: bachata:project-checks",
    "- [ ] [T2] Deliver the second feature",
    "  - Paths: src",
    "  - Verify: bachata:workspace-integrity",
    "  - Verify Final: bachata:project-checks",
    "",
  ].join("\n");
  const session = await combinedRun(root, {
    todo: twoTasks,
    worker: ({ workingDirectory, turn }) => {
      fs.writeFileSync(
        path.join(workingDirectory, "src/feature.mjs"),
        `export const feature = ${String(turn + 1)};\n`,
        "utf8",
      );
    },
    // Every task's first review rejects and its second accepts.
    lead: ({ turn, candidate }) =>
      turn % 2 === 1 ? leadRejects(candidate, oneDefect) : leadAccepts(candidate),
  });
  try {
    assert.equal(session.error, undefined, String(session.error?.message ?? ""));
    assert.equal(session.run.status, "completed", session.run.error ?? "");
    assert.equal(todoImplementation.managedPolicy.maxRevisionCycles, 1);

    // Four Lead turns: two tasks, each reviewed twice. A shared budget would have stopped at three.
    const leadTurns = session.requests.filter((entry) => entry.role === "Lead Reviewer");
    assert.equal(leadTurns.length, 4, JSON.stringify(session.requests.map((entry) => entry.role)));
    const workerTurns = session.requests.filter((entry) => entry.role === "Worker");
    assert.equal(workerTurns.length, 4);
    // And the second task's second Worker turn really was a Lead revision, so the second task
    // spent a revision cycle of its own rather than being waved through.
    assert.deepEqual(
      workerTurns.map((entry) => entry.leadRevision),
      [false, true, false, true],
    );
    // No task failed for want of budget.
    const exhausted = session.harness.transcript.filter(
      (entry) => entry.kind === "error" && /revision budget/u.test(String(entry.text ?? "")),
    );
    assert.deepEqual(exhausted, []);
  } finally {
    await session.dispose();
    await removeScratch(root);
  }
});

test("a Lead verdict that is not usable fails the task rather than approving it", gitWorktreeSkip, async () => {
  // Every way of not answering, driven through the real chain one at a time. None of them may
  // advance the run, and none of them may leave work retained or integrated.
  const unusable = [
    ["prose instead of a verdict", () => "The implementation is ready."],
    ["no verdict field", ({ candidate }) => JSON.stringify({ candidate, review: { summary: "fine", defects: [] } })],
    ["a verdict that is neither accept nor reject", ({ candidate }) =>
      JSON.stringify({ candidate, review: { verdict: "maybe", summary: "fine", defects: [] } })],
    ["an acceptance that lists defects", ({ candidate }) =>
      JSON.stringify({ candidate, review: { verdict: "accept", summary: "fine", defects: oneDefect } })],
    ["a rejection that names no defect", ({ candidate }) =>
      JSON.stringify({ candidate, review: { verdict: "reject", summary: "no", defects: [] } })],
    ["a verdict about a different candidate", () =>
      JSON.stringify({ candidate: "0".repeat(64), review: { verdict: "accept", summary: "fine", defects: [] } })],
    ["a defect with no required change", ({ candidate }) =>
      JSON.stringify({
        candidate,
        review: { verdict: "reject", summary: "no", defects: [{ id: "x", statement: "wrong" }] },
      })],
  ];
  for (const [name, lead] of unusable) {
    const root = await scratch();
    const session = await combinedRun(root, {
      worker: ({ workingDirectory }) => {
        fs.writeFileSync(path.join(workingDirectory, "src/feature.mjs"), "export const feature = 9;\n", "utf8");
      },
      lead,
    });
    try {
      assert.equal(session.error, undefined, `${name}: ${String(session.error?.message ?? "")}`);
      assert.equal(session.run.status, "failed", name);
      const decisions = session.harness.transcript.filter(
        (entry) => entry.eventType === "review.managedLead",
      );
      assert.deepEqual(decisions.map((entry) => entry.data.decision), ["invalid"], name);
      assert.ok(decisions[0].data.problems.length > 0, name);
      const failure = session.harness.transcript.find(
        (entry) => entry.kind === "error" && /usable review verdict/u.test(String(entry.text ?? "")),
      );
      assert.ok(failure, name);
      assert.deepEqual(session.controller.getSnapshot().retainedRuns, [], name);
      assert.equal(git(session.repository, "status", "--porcelain"), "", name);
      assert.equal(
        fs.readFileSync(path.join(session.repository, "src/feature.mjs"), "utf8"),
        "export const feature = 1;\n",
        name,
      );
    } finally {
      await session.dispose();
      await removeScratch(root);
    }
  }
});

test("the shipped Feature Delivery preset cannot be an unattended orchestration task", () => {
  const { unattendedPipelineSafetyErrors } = require("../dist/security/unattendedPipeline.js");
  const { createPipelineSnapshot } = require("../dist/pipeline/identity.js");
  // Recorded here rather than in a report, because it is the reason this suite drives the
  // shipped `todo-implementation` preset instead. Feature Delivery is the attended path: three of
  // its eight steps stop for a person, and an unattended orchestration task may not stop for
  // anyone. Running it as a task would need either the preset to drop its gates or the safety
  // rule to admit an attended orchestration mode, and both are product decisions.
  const errors = unattendedPipelineSafetyErrors(featureDelivery);
  assert.deepEqual(errors, [
    "Step requirement-consensus requires a human gate (after)",
    "Step requirement-consensus consensus can fall back to a human gate",
    "Step design-record requires a human gate (after)",
    "Step implement requires a human gate (before)",
  ]);
  assert.equal(featureDelivery.steps.length, 8);
  // The pipeline this suite does drive is shipped, unmodified, and unattended-safe: an exact
  // snapshot of the preset file, not a clone written for a test.
  assert.deepEqual(unattendedPipelineSafetyErrors(todoImplementation), []);
  const snapshot = createPipelineSnapshot(structuredClone(todoImplementation), "builtin");
  assert.deepEqual(snapshot.definition, todoImplementation);
  assert.deepEqual(
    todoImplementation.managedPolicy.verificationChecks.map((check) => check.command),
    ["bachata:workspace-integrity", "bachata:project-checks"],
  );
});
