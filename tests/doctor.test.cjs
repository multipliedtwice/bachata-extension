const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateGitVersionSupport } = require("../dist/process/gitVersionSupport.js");
const { runDoctorChecks } = require("../dist/process/doctorChecks.js");
const {
  doctorCommandOptions,
  selectDoctorWorkspace,
} = require("../dist/commands/doctorDependencies.js");

test("selectDoctorWorkspace uses the active folder in a multi-root workspace", () => {
  const folders = [
    { name: "one", fsPath: "/work/one" },
    { name: "two", fsPath: "/work/two" },
  ];
  assert.deepEqual(selectDoctorWorkspace(folders, "/work/two"), folders[1]);
  assert.equal(selectDoctorWorkspace(folders), undefined);
  assert.deepEqual(selectDoctorWorkspace([folders[0]]), folders[0]);
});

test("Doctor probes use the selected cwd and restricted production environments", () => {
  const previousSecret = process.env.BACHATA_DOCTOR_SECRET;
  const previousForwarded = process.env.BACHATA_DOCTOR_FORWARDED;
  process.env.BACHATA_DOCTOR_SECRET = "must-not-leak";
  process.env.BACHATA_DOCTOR_FORWARDED = "allowed";
  try {
    const git = doctorCommandOptions("git", "/work/two", 1234);
    assert.equal(git.workingDirectory, "/work/two");
    assert.equal(git.environment.PWD, "/work/two");
    assert.equal(git.environment.BACHATA_DOCTOR_SECRET, undefined);
    assert.equal(git.environment.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(git.environment.GIT_TERMINAL_PROMPT, "0");

    const provider = doctorCommandOptions(
      "provider",
      "/work/two",
      1234,
      ["BACHATA_DOCTOR_FORWARDED"],
    );
    assert.equal(provider.workingDirectory, "/work/two");
    assert.equal(provider.environment.PWD, "/work/two");
    assert.equal(provider.environment.BACHATA_DOCTOR_SECRET, undefined);
    assert.equal(provider.environment.BACHATA_DOCTOR_FORWARDED, "allowed");
  } finally {
    if (previousSecret === undefined) delete process.env.BACHATA_DOCTOR_SECRET;
    else process.env.BACHATA_DOCTOR_SECRET = previousSecret;
    if (previousForwarded === undefined) delete process.env.BACHATA_DOCTOR_FORWARDED;
    else process.env.BACHATA_DOCTOR_FORWARDED = previousForwarded;
  }
});

test("evaluateGitVersionSupport accepts versions above the minimum", () => {
  const support = evaluateGitVersionSupport("git version 2.39.5 (Apple Git-128)");
  assert.equal(support.supported, true);
  assert.equal(support.parsable, true);
  assert.equal(support.requirementText, "");
});

test("evaluateGitVersionSupport accepts the exact minimum boundary", () => {
  const support = evaluateGitVersionSupport("git version 2.32.0");
  assert.equal(support.supported, true);
  assert.equal(support.parsable, true);
});

test("evaluateGitVersionSupport rejects below-minimum versions with the recorded message", () => {
  const support = evaluateGitVersionSupport("git version 2.15.0");
  assert.equal(support.supported, false);
  assert.equal(
    support.requirementText,
    "Bachata requires Git 2.32 or newer for deterministic worktree orchestration; found git version 2.15.0",
  );
});

test("evaluateGitVersionSupport rejects the version directly under the boundary", () => {
  const support = evaluateGitVersionSupport("git version 2.31.9");
  assert.equal(support.supported, false);
});

test("evaluateGitVersionSupport fails closed when the version cannot be parsed", () => {
  const support = evaluateGitVersionSupport("some-custom-git-wrapper");
  assert.equal(support.supported, false);
  assert.equal(support.parsable, false);
  assert.match(support.requirementText, /could not verify Git 2\.32 or newer/u);
});

test("evaluateGitVersionSupport rejects embedded version-like output", () => {
  const support = evaluateGitVersionSupport("wrapper 9.9; git version 2.39.5");
  assert.equal(support.supported, false);
  assert.equal(support.parsable, false);
});

test("runDoctorChecks reports every check as passing on a healthy machine", async () => {
  const checks = await runDoctorChecks({
    workspaceLabel: "demo",
    gitVersion: async () => "git version 2.39.5",
    providerVersion: async (command) => `${command} version 1.0.0`,
    codexCommand: "codex",
    claudeCommand: "claude",
  });
  assert.equal(checks.length, 4);
  assert.deepEqual(
    checks.map((check) => [check.name, check.ok]),
    [
      ["Workspace", true],
      ["Git", true],
      ["Codex", true],
      ["Claude Code", true],
    ],
  );
});

test("runDoctorChecks fails closed without an open workspace folder", async () => {
  const checks = await runDoctorChecks({
    workspaceLabel: undefined,
    gitVersion: async () => "git version 2.39.5",
    providerVersion: async () => "ok",
    codexCommand: "codex",
    claudeCommand: "claude",
  });
  const workspace = checks.find((check) => check.name === "Workspace");
  assert.equal(workspace.ok, false);
  assert.equal(workspace.detail, "No folder is open");
});

test("runDoctorChecks surfaces an unsupported git version as a failing check", async () => {
  const checks = await runDoctorChecks({
    workspaceLabel: "demo",
    gitVersion: async () => "git version 2.15.0",
    providerVersion: async () => "ok",
    codexCommand: "codex",
    claudeCommand: "claude",
  });
  const git = checks.find((check) => check.name === "Git");
  assert.equal(git.ok, false);
  assert.match(git.detail, /requires Git 2\.32 or newer/u);
});

test("runDoctorChecks surfaces a git probe failure without throwing", async () => {
  const checks = await runDoctorChecks({
    workspaceLabel: "demo",
    gitVersion: async () => {
      throw new Error("spawn git ENOENT");
    },
    providerVersion: async () => "ok",
    codexCommand: "codex",
    claudeCommand: "claude",
  });
  const git = checks.find((check) => check.name === "Git");
  assert.equal(git.ok, false);
  assert.equal(git.detail, "spawn git ENOENT");
});

test("runDoctorChecks reports each unavailable provider independently", async () => {
  const checks = await runDoctorChecks({
    workspaceLabel: "demo",
    gitVersion: async () => "git version 2.39.5",
    providerVersion: async (command) => {
      if (command === "missing-claude") {
        throw new Error("spawn missing-claude ENOENT");
      }
      return `${command} version 1.0.0`;
    },
    codexCommand: "codex",
    claudeCommand: "missing-claude",
  });
  const codex = checks.find((check) => check.name === "Codex");
  const claude = checks.find((check) => check.name === "Claude Code");
  assert.equal(codex.ok, true);
  assert.equal(claude.ok, false);
  assert.equal(claude.blocking, false);
  assert.equal(claude.remediationId, "provider.install.claude");
  assert.equal(claude.detail, "missing-claude unavailable: spawn missing-claude ENOENT");
});
