const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
  gitWorktreeRequired,
  probeWorkspaceRepository,
  selectedWriteScope,
} = require("../dist/adapters/workspacePolicyAudit.js");
const {
  participantRequiresGitWorktree,
  projectPreflightDetail,
  projectPreflightError,
  projectPreflightFailure,
  projectPreflightFailureOf,
} = require("../dist/runtime/projectPreflight.js");
const { pipelineParticipantPlans } = require("../dist/pipeline/runner.js");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");

// The UI/UX review failed with "requires a Git worktree" while `extension/` is a Git worktree.
// The run's recorded working root was its parent, which is not; and the refusal applied to two
// read-only reviewers, after both had already worked for five minutes. These tests pin the three
// separate rules that replaced it: how a folder resolves, which participant needs Git at all, and
// what a refusal made before any participant starts says.

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.email=bachata@example.invalid", "-c", "user.name=Bachata", ...args], {
    cwd,
    encoding: "utf8",
  });

const gitProject = () => {
  const root = scratchRootSync("bachata-preflight-repo-");
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, "README.txt"), "tracked\n");
  git(root, "add", "README.txt");
  git(root, "commit", "-q", "-m", "init");
  return root;
};

const request = (workingDirectory, policy) => ({
  prompt: "p",
  workingDirectory,
  attachments: [],
  ...(policy === undefined ? {} : { workspacePolicy: { commitMode: "never", ...policy } }),
});

const writingPolicy = { readOnly: false, writeScope: "task", allowedPaths: ["src"], automated: true };

test("a worktree root, a nested folder, a dirty tree, a trailing slash and a symlink resolve to one worktree", async () => {
  const repo = gitProject();
  const links = scratchRootSync("bachata-preflight-link-");
  try {
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repo, "README.txt"), "changed\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
    const link = path.join(links, "project");
    fs.symlinkSync(repo, link, "dir");
    const repositoryRoot = fs.realpathSync(repo);
    for (const folder of [repo, path.join(repo, "src", "deep"), `${repo}${path.sep}`, link, path.join(link, "src")]) {
      assert.deepEqual(await probeWorkspaceRepository(folder), { kind: "worktree", repositoryRoot }, folder);
    }
    const dirty = request(path.join(repo, "src"), writingPolicy);
    const snapshot = await captureWorkspacePolicyAudit(dirty);
    assert.equal(snapshot.isGitRepository, true);
    assert.ok(Object.keys(snapshot.entries).length >= 2, "the dirty tree was not recorded as dirty");
    await assert.doesNotReject(assertWorkspacePolicyAudit(dirty, snapshot), "a dirty worktree was refused");
  } finally {
    removeScratchSync(links);
    removeScratchSync(repo);
  }
});

test("a folder outside Git is not a worktree, and a probe that could not run is unresolved, not 'not a repository'", async () => {
  const plain = scratchRootSync("bachata-preflight-plain-");
  try {
    assert.equal((await probeWorkspaceRepository(plain)).kind, "notWorktree");
    const unlaunchable = await probeWorkspaceRepository(path.join(plain, "missing", "folder"));
    assert.equal(unlaunchable.kind, "unresolved");
    assert.ok(unlaunchable.detail.length > 0, "an unresolved probe carries no diagnostic");
    await assert.rejects(
      captureWorkspacePolicyAudit(request(path.join(plain, "missing"), { readOnly: true, writeScope: "readOnly", automated: true })),
    );
  } finally {
    removeScratchSync(plain);
  }
});

// Owner decision, docs/PRODUCT_DOCTRINE.md: a folder that is not a Git repository is a valid
// project. Bachata may run tasks that are not software, so a participant that may write runs there
// too, without Git-based change tracking.
test("outside Git every participant may run, including one that may write", async () => {
  const plain = scratchRootSync("bachata-preflight-plain-");
  try {
    const readOnly = request(plain, { readOnly: true, writeScope: "readOnly", automated: true });
    const before = await captureWorkspacePolicyAudit(readOnly);
    assert.equal(before.isGitRepository, false);
    await assert.doesNotReject(assertWorkspacePolicyAudit(readOnly, before));
    const writing = request(plain, writingPolicy);
    await assert.doesNotReject(assertWorkspacePolicyAudit(writing, await captureWorkspacePolicyAudit(writing)));
  } finally {
    removeScratchSync(plain);
  }
});

test("only an automated turn that may write inside a bounded scope needs Git", () => {
  assert.equal(selectedWriteScope({ readOnly: true, defaultScope: "task" }), "readOnly");
  assert.equal(selectedWriteScope({ writeScope: "readOnly", readOnly: false, defaultScope: "workspace" }), "readOnly");
  assert.equal(selectedWriteScope({ readOnly: true, writeScope: "task", defaultScope: "workspace" }), "task");
  assert.equal(selectedWriteScope({ defaultScope: "configured" }), "configured");
  for (const [policy, expected] of [
    [{ automated: true, readOnly: false, writeScope: "task" }, true],
    [{ automated: true, readOnly: false, writeScope: "configured" }, true],
    [{ automated: true, readOnly: false, writeScope: "workspace" }, false],
    [{ automated: true, readOnly: true, writeScope: "task" }, false],
    [{ automated: true, readOnly: true, writeScope: "readOnly" }, false],
    [{ automated: false, readOnly: false, writeScope: "task" }, false],
    [{ readOnly: false, writeScope: "task" }, false],
  ]) {
    assert.equal(gitWorktreeRequired(policy), expected, JSON.stringify(policy));
  }
});

test("a participant's requirement follows its own options, not the pipeline it sits in", () => {
  for (const [options, unattended, expected] of [
    [{ participant: "reviewer", readOnly: true, writeScope: "task" }, false, false],
    [{ participant: "builder", readOnly: false, writeScope: "task" }, false, true],
    [{ participant: "builder", allowedPaths: ["src"] }, false, true],
    [{ participant: "builder" }, false, false],
    [{ participant: "worker", managed: true, managedRole: "worker" }, false, true],
    [{ participant: "lead", managed: true, managedRole: "lead" }, false, false],
    [{ writeScope: "task" }, false, false],
    [{ writeScope: "configured", allowedPaths: ["docs"] }, true, true],
  ]) {
    assert.equal(participantRequiresGitWorktree(options, unattended), expected, JSON.stringify(options));
  }
});

test("the UI/UX review pipeline is read-only for every participant, so it needs no Git worktree", () => {
  const pipeline = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "ui-ux-review.pipeline.json"), "utf8"),
  );
  const plans = pipelineParticipantPlans(pipeline, "review extension/", {
    fromStepIndex: 0,
    roles: {},
    executionPolicy: { writeScope: "task" },
  });
  assert.deepEqual(
    plans.map((plan) => [plan.stepName, plan.participant, plan.candidates.map((candidate) => candidate.participantName)]),
    [
      ["Inspect the interface independently", "codex", ["Usability reviewer"]],
      ["Inspect the interface independently", "claude", ["Accessibility reviewer"]],
      ["Reconcile UI/UX findings", "codex", ["Usability reviewer"]],
      ["Reconcile UI/UX findings", "claude", ["Accessibility reviewer"]],
    ],
  );
  for (const plan of plans) {
    for (const candidate of plan.candidates) {
      assert.equal(candidate.options.readOnly, true, `${plan.stepName} ${plan.participant}`);
      assert.equal(participantRequiresGitWorktree(candidate.options, false), false, `${plan.stepName} ${plan.participant}`);
    }
  }
});

test("participant plans start where the run starts, skip steps that invoke nobody, and resolve roles", () => {
  const agentStep = (id, participants, enabled = true) => ({
    id,
    name: id,
    enabled,
    type: "agent",
    participants,
    promptTemplate: "{{userPrompt}}",
    parallel: participants.length > 1,
    consensus: false,
    humanGate: "none",
  });
  const pipeline = {
    version: 1,
    id: "plans",
    name: "Plans",
    agents: [
      { id: "writer", name: "Writer", adapter: "claude-code" },
      { id: "reader", name: "Reader", adapter: "codex-app-server", permissionMode: "readOnly" },
    ],
    roles: [
      { id: "builder", name: "Builder", instructions: "Build", candidateAgentIds: ["writer"] },
      { id: "open", name: "Open role", instructions: "Any" },
    ],
    steps: [
      agentStep("plan", ["reader"]),
      { id: "assign", name: "assign", enabled: true, type: "assignRoles", humanGate: "none", roleAssignments: [] },
      agentStep("off", ["writer"], false),
      agentStep("build", ["builder", "open"]),
    ],
  };
  const all = pipelineParticipantPlans(pipeline, "task", { fromStepIndex: 0, roles: {} });
  assert.deepEqual(
    all.map((plan) => [plan.stepName, plan.participant, plan.candidates.map((candidate) => candidate.agentId)]),
    [
      ["plan", "reader", ["reader"]],
      ["build", "builder", ["writer"]],
      ["build", "open", ["writer", "reader"]],
    ],
  );
  assert.equal(all[1].candidates[0].participantName, "Builder");
  const resumed = pipelineParticipantPlans(pipeline, "task", {
    fromStepIndex: 3,
    roles: { open: "reader" },
    executionPolicy: { writeScope: "task" },
  });
  assert.deepEqual(resumed.map((plan) => [plan.participant, plan.candidates.map((candidate) => candidate.agentId)]), [
    ["builder", ["writer"]],
    ["open", ["reader"]],
  ]);
  assert.equal(participantRequiresGitWorktree(resumed[0].candidates[0].options, false), true);
  assert.equal(participantRequiresGitWorktree(resumed[1].candidates[0].options, false), false);
  const ghost = pipelineParticipantPlans(
    { ...pipeline, roles: [{ id: "builder", name: "Builder", instructions: "b", candidateAgentIds: ["ghost"] }] },
    "task",
    { fromStepIndex: 3, roles: {} },
  );
  assert.deepEqual(ghost[0].candidates.map((candidate) => candidate.agentId), ["writer", "reader"]);
});

test("a refusal names the folder, the participants that would have written, and that nobody started", () => {
  const participants = [
    { participant: "Builder", step: "Implement", workingDirectory: "/work" },
    { participant: "Reviewer", step: "Review", workingDirectory: "/work" },
  ];
  assert.equal(projectPreflightFailure({ participants: [], probes: new Map() }), undefined);
  assert.equal(
    projectPreflightFailure({ participants, probes: new Map([["/work", { kind: "worktree", repositoryRoot: "/work" }]]) }),
    undefined,
  );
  assert.equal(
    projectPreflightFailure({ participants, probes: new Map([["/work", { kind: "notWorktree", detail: "fatal: not a git repository" }]]) }),
    undefined,
    "a folder that is not a Git repository was refused",
  );
  const quiet = projectPreflightFailure({
    participants: participants.slice(0, 1),
    probes: new Map([["/work", { kind: "unresolved", detail: "  " }]]),
  });
  assert.equal("detail" in quiet, false, "an empty diagnostic was kept");
  assert.deepEqual(
    projectPreflightFailure({ participants: [{ participant: "Builder", step: "Implement", workingDirectory: undefined }], probes: new Map() }),
    {
      reason: "noFolder",
      participants: [{ participant: "Builder", step: "Implement" }],
      message: "Choose a project folder. No project folder is selected, and Builder in “Implement” may change files, so Bachata did not start them.",
    },
  );
  assert.deepEqual(
    projectPreflightFailure({
      participants: [
        { participant: "Builder", step: "Implement", workingDirectory: undefined, lookupError: "Trust the VS Code workspace before launching agents" },
        { participant: "Reviewer", step: "Review", workingDirectory: undefined },
      ],
      probes: new Map(),
    }),
    {
      reason: "unresolved",
      detail: "Trust the VS Code workspace before launching agents",
      participants: [{ participant: "Builder", step: "Implement" }],
      message: "Bachata could not resolve the project folder, so it did not start Builder in “Implement”.",
    },
    "a folder lookup that threw was reported as no folder selected",
  );
  assert.deepEqual(
    projectPreflightFailure({
      participants: participants.slice(0, 1),
      probes: new Map([["/work", { kind: "unresolved", detail: "spawn git ENOENT" }]]),
    }),
    {
      reason: "unresolved",
      folder: "/work",
      detail: "spawn git ENOENT",
      participants: [{ participant: "Builder", step: "Implement" }],
      message: "Bachata could not resolve the project at /work, so it did not start Builder in “Implement”.",
    },
  );
  const unchecked = projectPreflightFailure({ participants: participants.slice(0, 1), probes: new Map() });
  assert.equal(unchecked.reason, "unresolved");
  assert.equal(unchecked.detail, "The project folder was not checked.");
});

test("a refusal speaks for one folder at a time and summarises a long participant list", () => {
  const many = ["A", "B", "C", "D"].map((participant) => ({ participant, step: "S", workingDirectory: "/work" }));
  const probes = new Map([
    ["/work", { kind: "unresolved", detail: "" }],
    ["/other", { kind: "unresolved", detail: "" }],
  ]);
  assert.match(projectPreflightFailure({ participants: many, probes }).message, /did not start A in “S”, B in “S” and 2 more participants\./u);
  assert.match(projectPreflightFailure({ participants: many.slice(0, 3), probes }).message, /did not start A in “S”, B in “S” and 1 more participant\./u);
  assert.match(projectPreflightFailure({ participants: [many[0], many[0]], probes }).message, /did not start A in “S”\./u);
  const split = projectPreflightFailure({
    participants: [{ participant: "Other", step: "S", workingDirectory: "/other" }, many[0]],
    probes,
  });
  assert.equal(split.folder, "/other");
  assert.deepEqual(split.participants, [{ participant: "Other", step: "S" }]);
});

test("a preflight refusal travels as an ordinary error that still carries its record", () => {
  const failure = projectPreflightFailure({
    participants: [{ participant: "B", step: "S", workingDirectory: undefined }],
    probes: new Map(),
  });
  const error = projectPreflightError(failure);
  assert.ok(error instanceof Error);
  assert.equal(error.message, failure.message);
  assert.equal(projectPreflightFailureOf(error), failure);
  assert.equal(projectPreflightFailureOf(new Error(failure.message)), undefined);
  assert.equal(projectPreflightFailureOf("text"), undefined);
  assert.deepEqual(projectPreflightDetail(failure), { reason: "noFolder", participants: [{ participant: "B", step: "S" }] });
  assert.deepEqual(
    projectPreflightDetail({ ...failure, folder: "/w", detail: "d" }),
    { reason: "noFolder", folder: "/w", detail: "d", participants: [{ participant: "B", step: "S" }] },
  );
});
