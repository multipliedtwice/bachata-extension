const assert = require("node:assert/strict");
const test = require("node:test");

const { executePipeline } = require("../dist/pipeline/runner.js");
const {
  verificationGateHolds,
  verificationIssues,
} = require("../dist/runtime/verificationGate.js");
const { pipelineEvidenceExpectations } = require("../dist/results/evidenceExpectations.js");

const preset = require("../presets/feature-delivery.pipeline.json");

// P3. The Feature Delivery pipeline, driven end to end through the real eight-step preset with
// controlled adapters. `verificationGate.ts` was unit-tested against invented check ids; nothing
// asserted that the pipeline this product ships actually carries those checks to the roles that
// have to satisfy them, in the order that makes them mean anything.

const definition = () => structuredClone(preset);

// The consensus step accepts a structured candidate both participants agree on. This is the
// smallest candidate the shipped `featureRequirementSet` shape accepts, so the run converges on
// the first round instead of stopping at an invalid-consensus gate.
const agreedCandidate = {
  title: "Add the feature",
  summary: "One requirement, agreed by both participants.",
  evidence: ["src/runtime/createRuntime.ts"],
  requirements: [
    {
      id: "requirement-1",
      disposition: "accepted",
      statement: "The feature is delivered behind the declared write scope.",
      acceptanceCriteria: ["The declared checks pass against the candidate."],
      evidence: ["presets/feature-delivery.pipeline.json"],
      challenges: [],
      priority: "must",
    },
  ],
};

const consensusAnswer = JSON.stringify({
  candidate: agreedCandidate,
  accepted: true,
  objections: [],
  unresolvedRisks: [],
});

// The three recorded steps produce structured artifacts against the shipped shapes. These are
// the smallest documents those shapes accept, so the run exercises the real validation rather
// than a step that happens to declare no output.
const stepAnswers = {
  "requirement-consensus": consensusAnswer,
  "requirement-record": JSON.stringify(agreedCandidate),
  "design-record": JSON.stringify({
    title: "Deliver the feature",
    summary: "One step, inside the declared write scope.",
    scope: ["src"],
    evidence: ["presets/feature-delivery.pipeline.json"],
    steps: [
      {
        id: "design-step-1",
        intent: "Implement the accepted requirement.",
        files: ["src/feature.ts"],
        verification: "project-checks",
      },
    ],
  }),
  "core-decisions": JSON.stringify({
    decisions: [
      {
        subject: "Verification ownership",
        question: "Who runs the declared checks for a managed local turn?",
        affectedScope: ["src/runtime/createRuntime.ts"],
        evidence: ["presets/feature-delivery.pipeline.json"],
      },
    ],
  }),
};

/**
 * Run the preset with a recording adapter. Every gate continues, so what the run proves is the
 * order and the options, not what a person would have done at a gate.
 */
const runFeatureDelivery = async (overrides = {}) => {
  const turns = [];
  const steps = [];
  const gates = [];
  const result = await executePipeline(
    overrides.pipeline ?? definition(),
    overrides.prompt ?? "Add the feature",
    [],
    async (agentId, prompt, step, options) => {
      turns.push({ agentId, stepId: step.id, options: structuredClone(options), prompt });
      if (overrides.runAgent) {
        return await overrides.runAgent({ agentId, step, options });
      }
      return {
        status: "completed",
        answer: stepAnswers[step.id] ?? `${agentId} answered ${step.id}`,
      };
    },
    {
      onStep: (step, index) => steps.push({ id: step.id, index }),
      onRoles: () => undefined,
      waitForHumanGate: async (request) => {
        gates.push({ stepId: request.step.id, reason: request.reason });
        return overrides.gateDecision
          ? await overrides.gateDecision(request)
          : { action: "continue" };
      },
    },
  );
  return { result, turns, steps, gates };
};

test("the shipped Feature Delivery pipeline runs its eight steps in order", async () => {
  const { result, steps } = await runFeatureDelivery();
  assert.equal(result.status, "completed");
  // `onStep` is reported per participant, so the same step arrives more than once on a parallel
  // step. What the run proves is the order of the steps, not how many turns each one took.
  const order = steps
    .map((step) => step.id)
    .filter((id, index, all) => all[index - 1] !== id);
  assert.deepEqual(
    order,
    [
      "requirements",
      "requirement-consensus",
      "requirement-record",
      "design-record",
      "assign-roles",
      "implement",
      "lead-review",
      "core-decisions",
    ],
  );
});

test("Lead review happens after the implementation, never before it", async () => {
  const { turns } = await runFeatureDelivery();
  const order = turns.map((turn) => turn.stepId);
  assert.ok(order.indexOf("implement") >= 0, order.join(", "));
  assert.ok(
    order.indexOf("lead-review") > order.indexOf("implement"),
    `lead-review did not follow implement: ${order.join(", ")}`,
  );
  // And the two roles are different agents: a lead reviewing its own work reviews nothing.
  const worker = turns.find((turn) => turn.stepId === "implement");
  const lead = turns.find((turn) => turn.stepId === "lead-review");
  assert.equal(worker.options.managedRole, "worker");
  assert.equal(lead.options.managedRole, "lead");
  assert.notEqual(worker.agentId, lead.agentId);
});

test("the implementation step is the one a person is asked about before it starts", async () => {
  const { gates } = await runFeatureDelivery();
  assert.deepEqual(
    gates.filter((gate) => gate.reason === "beforeStep").map((gate) => gate.stepId),
    ["implement"],
  );
});

test("every turn in the run is handed the pipeline's declared verification checks", async () => {
  const { turns } = await runFeatureDelivery();
  const declared = preset.managedPolicy.verificationChecks;
  assert.ok(declared.length > 0, "the shipped preset declares no verification checks");
  for (const stepId of ["implement", "lead-review"]) {
    const turn = turns.find((item) => item.stepId === stepId);
    assert.deepEqual(
      turn.options.verificationChecks,
      declared,
      `${stepId} was not handed the declared checks`,
    );
  }
  // The policy is the pipeline's, not the role's, so an unmanaged step carries it too. Whether
  // a step can act on it is a separate question, decided by whether its turn is a managed one.
  assert.deepEqual(
    turns.find((item) => item.stepId === "requirements").options.verificationChecks,
    declared,
  );
  // The checks are copies: a step cannot edit the policy the next step will be given.
  const worker = turns.find((item) => item.stepId === "implement");
  assert.notEqual(worker.options.verificationChecks, preset.managedPolicy.verificationChecks);
  // And the pipeline says out loud that it expects verification evidence, because it declared
  // checks. A run that produced none would be a run with a gap, not a run with nothing to show.
  assert.equal(pipelineEvidenceExpectations(preset).verification, true);
});

test("the write scope the Worker is given is the pipeline's, not the whole workspace", async () => {
  const { turns } = await runFeatureDelivery();
  const worker = turns.find((turn) => turn.stepId === "implement");
  assert.equal(worker.options.writeScope, preset.managedPolicy.writeScope);
  assert.deepEqual(worker.options.allowedPaths, preset.managedPolicy.allowedPaths);
  assert.deepEqual(worker.options.protectedPaths, preset.managedPolicy.protectedPaths);
  // Never a commit: the controller owns Git.
  assert.equal(worker.options.commitMode, "never");
  assert.equal(turns.find((turn) => turn.stepId === "lead-review").options.commitMode, "never");
  assert.equal(turns.find((turn) => turn.stepId === "lead-review").options.readOnly, true);
});

// --- the gate, against the checks this pipeline actually declares --------------------------

const declaredChecks = preset.managedPolicy.verificationChecks;
const fingerprint = "workspace-abc";

const held = (issues, role = "worker", terminalObjections = []) =>
  verificationGateHolds({
    terminal: true,
    hasEnvelope: true,
    envelopeStatus: "done",
    issues,
    role,
    terminalObjections,
  });

test("a Worker that declares itself done with no check records at all is held", () => {
  const issues = verificationIssues(declaredChecks, [], fingerprint);
  assert.deepEqual(
    issues,
    declaredChecks.map((check) => `${check.id}: not run`),
  );
  assert.equal(held(issues), true);
});

test("no check outcome but a pass can reach the Lead as a finished turn", () => {
  for (const status of ["failed", "skipped", "inconclusive", "errored", "cancelled"]) {
    const records = declaredChecks.map((check) => ({
      id: check.id,
      status,
      workspaceFingerprint: fingerprint,
    }));
    const issues = verificationIssues(declaredChecks, records, fingerprint);
    // Reported in the check's own word rather than flattened to "failed".
    assert.deepEqual(issues, declaredChecks.map((check) => `${check.id}: ${status}`), status);
    assert.equal(held(issues), true, status);
  }
  const passing = declaredChecks.map((check) => ({
    id: check.id,
    status: "passed",
    workspaceFingerprint: fingerprint,
  }));
  assert.deepEqual(verificationIssues(declaredChecks, passing, fingerprint), []);
  assert.equal(held([]), false);
});

test("one missing check is enough, even when the other one passed", () => {
  const [first, second] = declaredChecks;
  const issues = verificationIssues(
    declaredChecks,
    [{ id: first.id, status: "passed", workspaceFingerprint: fingerprint }],
    fingerprint,
  );
  assert.deepEqual(issues, [`${second.id}: not run`]);
  assert.equal(held(issues), true);
});

test("a check result from another workspace is stale, not evidence for this one", () => {
  const records = declaredChecks.map((check) => ({
    id: check.id,
    status: "passed",
    workspaceFingerprint: "workspace-before-the-change",
  }));
  const issues = verificationIssues(declaredChecks, records, fingerprint);
  assert.deepEqual(issues, declaredChecks.map((check) => `${check.id}: stale`));
  assert.equal(held(issues), true);
  // A record with no fingerprint at all is stale too: it says nothing about which tree it ran on.
  assert.deepEqual(
    verificationIssues(
      declaredChecks,
      declaredChecks.map((check) => ({ id: check.id, status: "passed" })),
      fingerprint,
    ),
    declaredChecks.map((check) => `${check.id}: stale`),
  );
});

test("a rerun bound to the current candidate replaces the stale evidence", () => {
  const stale = declaredChecks.map((check) => ({
    id: check.id,
    status: "passed",
    workspaceFingerprint: "workspace-before-the-change",
  }));
  assert.equal(held(verificationIssues(declaredChecks, stale, fingerprint)), true);
  // The rerun's records carry the current fingerprint; the earlier ones are replaced by id.
  const rerun = declaredChecks.map((check) => ({
    id: check.id,
    status: "passed",
    workspaceFingerprint: fingerprint,
  }));
  assert.deepEqual(verificationIssues(declaredChecks, rerun, fingerprint), []);
  assert.equal(held([]), false);
  // And a rerun that binds only one of them leaves the other stale rather than green.
  const partial = [rerun[0], stale[1]];
  assert.deepEqual(
    verificationIssues(declaredChecks, partial, fingerprint),
    [`${declaredChecks[1].id}: stale`],
  );
});

test("the Lead is handed the check ids and the issues, not a summary of them", () => {
  // What the runtime puts on a gated turn: the required ids, and one issue per problem naming
  // the check and its own status word. A rewritten summary would carry neither.
  const records = [
    { id: declaredChecks[0].id, status: "failed", workspaceFingerprint: fingerprint },
  ];
  const issues = verificationIssues(declaredChecks, records, fingerprint);
  const payload = {
    requiredVerificationIds: declaredChecks.map((check) => check.id),
    issues,
  };
  assert.deepEqual(payload.requiredVerificationIds, ["workspace-integrity", "project-checks"]);
  assert.deepEqual(payload.issues, [
    "workspace-integrity: failed",
    "project-checks: not run",
  ]);
  for (const issue of payload.issues) {
    assert.ok(
      payload.requiredVerificationIds.some((id) => issue.startsWith(`${id}: `)),
      issue,
    );
  }
});

test("a Lead that has written down its own objections is not silenced by the checks", () => {
  const issues = verificationIssues(declaredChecks, [], fingerprint);
  assert.equal(held(issues, "lead", []), true);
  // A lead reporting a problem is reporting a problem; holding it would suppress the finding.
  assert.equal(held(issues, "lead", ["The design record does not match the change"]), false);
  // A worker's claim is "done and verified", so its objections do not excuse missing checks.
  assert.equal(held(issues, "worker", ["I could not run the checks"]), true);
});

test("a turn that is not claiming success is not gated", () => {
  const issues = verificationIssues(declaredChecks, [], fingerprint);
  assert.equal(
    verificationGateHolds({
      terminal: false,
      hasEnvelope: true,
      envelopeStatus: "done",
      issues,
      role: "worker",
      terminalObjections: [],
    }),
    false,
  );
  assert.equal(
    verificationGateHolds({
      terminal: true,
      hasEnvelope: true,
      envelopeStatus: "blocked",
      issues,
      role: "worker",
      terminalObjections: [],
    }),
    false,
  );
  assert.equal(
    verificationGateHolds({
      terminal: true,
      hasEnvelope: false,
      issues,
      role: "worker",
      terminalObjections: [],
    }),
    false,
  );
});

// --- the declared checks, executed for real on a local adapter ------------------------------
//
// P3. Everything above drives `executePipeline` and proves the preset hands its declared checks
// to every turn. What follows drives the runtime itself, over a real Git repository, with the
// local adapters this preset actually prefers: the point is that the checks run, and that a
// candidate they do not authorize cannot reach the Lead.

const fs = require("node:fs");
const path = require("node:path");

const { createRepository, gitWorktreeSkip } = require("./support/orchestration.cjs");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { removeScratch, scratchRoot } = require("./support/scratch.cjs");

/**
 * The shipped preset's managed half: its policy, its agents, its roles and the three steps that
 * assign the pair and run it. The recorded steps before them are driven above; repeating them
 * here would only lengthen the run without exercising anything this file is about.
 */
const managedFeatureDelivery = () => {
  const shipped = definition();
  const managedStepIds = new Set(["assign-roles", "implement", "lead-review"]);
  return {
    ...shipped,
    id: "feature-delivery-managed",
    name: "Feature Delivery (managed steps)",
    // The shipped Worker template reads the requirement and design records the earlier steps
    // produce. Those steps are driven above; here they would only lengthen the run, so that one
    // prompt is replaced with the same instruction the role already carries.
    //
    // The Lead's template is not replaced. It reads `{{peerAnswersTagged}}`, and the Worker's
    // answer is where the controller's own check results are carried — so a clone that dropped it
    // would take the evidence out of the Lead's request while every assertion about the recorded
    // answer still passed. That is exactly what this harness used to do.
    steps: shipped.steps
      .filter((step) => managedStepIds.has(step.id))
      .map((step) => ({
        ...step,
        humanGate: "none",
        ...(step.type === "agent"
          ? {
              promptTemplate: step.id === "lead-review"
                // The shipped Lead template with the one reference the dropped steps would have
                // filled removed, and `{{peerAnswersTagged}}` kept.
                ? step.promptTemplate.replace("{{outputs.featureRequirements}}\n\n", "")
                : "{{userPrompt}}",
            }
          : {}),
      })),
  };
};

const writeCustomPipeline = (workspaceRoot, pipeline) => {
  const directory = path.join(workspaceRoot, ".bachata", "pipelines");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${pipeline.id}.pipeline.json`),
    `${JSON.stringify(pipeline, null, 2)}\n`,
  );
};

/**
 * Run the managed half against a real repository with controlled local adapters.
 *
 * `worker` is called for each Worker turn and may write into the repository, which is what makes
 * the controller's checks have something to judge. Nothing about the adapters is a browser: that
 * is the point.
 */
const runManagedFeatureDelivery = async ({ worker, lead }) => {
  const root = await scratchRoot("bachata-feature-delivery-");
  const repository = await createRepository(root, undefined, {
    "src/feature.ts": "export const feature = 1;\n",
    "README.md": "# fixture\n",
  });
  const pipeline = managedFeatureDelivery();
  writeCustomPipeline(repository, pipeline);
  const turns = [];
  let harness;
  harness = loadRuntimeHarness({
    workspaceDirectories: [repository],
    runtimeOptions: { unattendedOrchestration: true },
    onAdapterSend: ({ agentId, request, sendCount }) => {
      harness.adapterControls.get(agentId)?.release.resolve();
      turns.push({ agentId, sendCount, prompt: request.prompt });
      const candidate = /^Candidate: ([0-9a-f]{64})$/mu.exec(request.prompt)?.[1] ?? "";
      const answer = agentId === "codex"
        ? worker?.({ repository, sendCount, prompt: request.prompt })
        : lead?.({ repository, sendCount, prompt: request.prompt, candidate });
      // P3. A managed local Lead answers with a structured verdict; prose is not a verdict and
      // fails the task. The default here is the acceptance a Lead with no objection would return.
      return { answer: answer ?? (agentId === "codex" ? `${agentId} finished` : leadAccepts(candidate)) };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.refreshPipelines();
    await harness.runtime.handleMessage({ type: "pipeline.select", pipelineId: pipeline.id });
    const snapshot = harness.runtime.getSelectedPipelineSnapshot();
    assert.equal(snapshot?.definition.id, pipeline.id);
    const outcome = await harness.runtime
      .runPipeline("Deliver the feature", [], { pipelineSnapshot: snapshot })
      .then((result) => ({ result }), (error) => ({ error }));
    return {
      ...outcome,
      turns,
      repository,
      transcript: [...harness.transcript],
      verification: harness.transcript.filter((entry) => entry.eventType === "verification.controller"),
      revisionPrompts: harness.transcript.filter(
        (entry) => entry.eventType === "verification.controller.revision",
      ),
      agentAnswers: harness.transcript.filter((entry) => entry.kind === "answer"),
    };
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    await removeScratch(root);
  }
};

const {
  MANAGED_LEAD_REVIEW_MARKER,
} = require("../dist/runtime/managedLeadReview.js");

/** The acceptance a managed local Lead with nothing to object to returns. */
const leadAccepts = (candidate, summary = "The implementation is ready.") =>
  JSON.stringify({ candidate, review: { verdict: "accept", summary, defects: [] } });

const declaredCheckIds = preset.managedPolicy.verificationChecks.map((check) => check.id);

test("the declared checks are executed for a managed turn on a local adapter", gitWorktreeSkip, async () => {
  const run = await runManagedFeatureDelivery({
    worker: ({ repository }) => {
      fs.writeFileSync(
        path.join(repository, "src", "feature.ts"),
        "export const feature = 2;\n",
        "utf8",
      );
      return "Implemented the feature.";
    },
  });
  assert.equal(run.error, undefined, String(run.error?.message ?? ""));
  assert.equal(run.result.status, "completed");
  // Both turns ran the controller's checks. Neither adapter is a browser adapter.
  assert.ok(run.verification.length >= 2, `no controller verification ran: ${String(run.verification.length)}`);
  for (const entry of run.verification) {
    assert.deepEqual(entry.data.requiredVerificationIds, declaredCheckIds);
    assert.deepEqual(entry.data.issues, []);
    assert.match(String(entry.data.workspaceFingerprint), /^[0-9a-f]{64}$/u);
  }
});

test("the Lead is handed the controller's own result for every declared check", gitWorktreeSkip, async () => {
  const run = await runManagedFeatureDelivery({
    worker: ({ repository }) => {
      fs.writeFileSync(path.join(repository, "src", "feature.ts"), "export const feature = 3;\n", "utf8");
      return "Implemented the feature.";
    },
  });
  assert.equal(run.error, undefined, String(run.error?.message ?? ""));
  // What the run records for the step is what the next step reads, so that is where the Lead's
  // evidence has to be.
  const workerAnswer = run.result.answers["implement"]?.codex ?? "";
  // Exact evidence, not a summary of it: the id it was declared under, the command the
  // controller ran, the status it produced and its exit information.
  for (const check of preset.managedPolicy.verificationChecks) {
    assert.match(workerAnswer, new RegExp(`check: ${check.id}`, "u"), workerAnswer.slice(0, 400));
    assert.match(workerAnswer, new RegExp(`command: ${check.command.replace(":", ":")}`, "u"));
  }
  assert.match(workerAnswer, /status: passed/u);
  assert.match(workerAnswer, /exit: /u);
  // The Lead's own request carries the same exact evidence for the candidate it is reviewing, so
  // what reaches the review is the controller's result rather than a report of it.
  //
  // The request, not the recorded answer. The answer a run records for `lead-review` is
  // augmented with the controller's evidence after the provider returns, so a test that read it
  // would pass whether or not the Lead ever saw a single check — which is what this test used to
  // do. What has to carry the evidence is the prompt the adapter was handed.
  // In this pipeline the Lead is `claude` and the Worker is `codex`, so the Lead's turn is the
  // claude turn — and there is exactly one, which is itself part of the claim.
  const leadTurns = run.turns.filter((turn) => turn.agentId === "claude");
  assert.equal(leadTurns.length, 1, JSON.stringify(run.turns.map((turn) => turn.agentId)));
  const leadTurn = leadTurns[0];
  assert.ok(leadTurn, "the Lead never ran");
  const leadPrompt = leadTurn.prompt;
  assert.match(leadPrompt, /^check: project-checks$/mu, leadPrompt.slice(-600));
  assert.match(leadPrompt, /^command: bachata:project-checks$/mu);
  assert.match(leadPrompt, /^status: passed$/mu);
  // Counted inside the controller's own block, not across the whole prompt: the Worker's recorded
  // answer carries the same evidence, so counting both copies would prove neither.
  const marker = leadPrompt.indexOf(MANAGED_LEAD_REVIEW_MARKER);
  assert.ok(marker >= 0, "the Lead was not handed the controller's own review block");
  const block = leadPrompt.slice(marker);
  // And a summary cannot stand in for it: the id, the command and the status are the
  // controller's own fields, printed per check rather than folded into a sentence.
  assert.equal((block.match(/^check: /gmu) ?? []).length, declaredCheckIds.length);
  assert.equal((block.match(/^status: passed$/gmu) ?? []).length, declaredCheckIds.length);
  // The candidate the Lead is judging is named, and it is the fingerprint the controller's own
  // verification was bound to.
  assert.match(block, /^Candidate: [0-9a-f]{64}$/mu);
  assert.equal(
    /^Candidate: ([0-9a-f]{64})$/mu.exec(block)[1],
    String(run.verification.at(-1).data.workspaceFingerprint),
  );
});

test("a candidate the declared checks refuse never reaches the Lead", gitWorktreeSkip, async () => {
  const run = await runManagedFeatureDelivery({
    worker: ({ repository }) => {
      fs.writeFileSync(path.join(repository, "src", "feature.ts"), "export const feature = (\n", "utf8");
      return "Implemented the feature.";
    },
  });
  assert.notEqual(run.error, undefined, "a candidate that fails its declared checks completed");
  assert.match(run.error.message, /required verification is not passing/u);
  assert.match(run.error.message, /project-checks/u);
  // The Lead never ran: the run stopped at the Worker rather than asking for a review of work
  // the controller could not verify.
  assert.equal(run.turns.some((turn) => turn.agentId === "claude"), false);
  // And the failure was recorded with the exact evidence rather than a summary of it.
  const failing = run.verification.find((entry) => entry.data.issues.length > 0);
  assert.ok(failing, "no failing verification was recorded");
  assert.ok(
    failing.data.evidence.some((line) => line.id === "project-checks" && line.status === "failed"),
    JSON.stringify(failing.data.evidence),
  );
});

test("a Worker repairs its own work through one revision turn, and the run then advances", gitWorktreeSkip, async () => {
  const run = await runManagedFeatureDelivery({
    worker: ({ repository, sendCount }) => {
      fs.writeFileSync(
        path.join(repository, "src", "feature.ts"),
        sendCount === 1 ? "export const feature = (\n" : "export const feature = 4;\n",
        "utf8",
      );
      return sendCount === 1 ? "Implemented the feature." : "Repaired the implementation.";
    },
  });
  assert.equal(run.error, undefined, String(run.error?.message ?? ""));
  assert.equal(run.result.status, "completed");
  // One revision turn, prompted with the controller's own failing evidence.
  assert.equal(run.revisionPrompts.length, 1);
  assert.match(run.revisionPrompts[0].text, /Required verification: project-checks/u);
  assert.match(run.revisionPrompts[0].text, /check: project-checks/u);
  // And the Lead did run, once the repaired candidate passed.
  assert.equal(run.turns.some((turn) => turn.agentId === "claude"), true);
});
