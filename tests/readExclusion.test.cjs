const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_READABLE_ROOTS,
  isDisclosedReadExclusion,
  resolveReadableWorkspaceRoots,
} = require("../dist/browser/mutationPolicy.js");
const { createCodexAppServerAdapter } = require("../dist/adapters/codexAppServer.js");
const { validateClaudeWorkspaceToolUse } = require("../dist/adapters/claudeCode.js");

const mockCodex = path.join(__dirname, "fixtures", "mock-codex.cjs");

const createWorkspace = () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-read-exclusion-")));
  fs.mkdirSync(path.join(root, ".bachata"));
  fs.writeFileSync(path.join(root, ".bachata", "policy.json"), "{\"secret\":true}");
  fs.mkdirSync(path.join(root, ".git"));
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=1");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;");
  fs.mkdirSync(path.join(root, "packages", "inner"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "inner", "index.ts"), "export const b = 2;");
  fs.writeFileSync(path.join(root, "packages", "inner", ".env.production"), "SECRET=2");
  fs.mkdirSync(path.join(root, "packages", "inner", ".bachata"));
  fs.writeFileSync(path.join(root, "packages", "inner", ".bachata", "nested.json"), "{}");
  return root;
};

const isReadable = (roots, target) =>
  roots.some((root) => root === target || target.startsWith(`${root}${path.sep}`));

test("resolved readable roots exclude .bachata, VCS internals and environment files at every depth", async () => {
  const root = createWorkspace();
  try {
    const roots = await resolveReadableWorkspaceRoots(root, []);
    assert.equal(isReadable(roots, path.join(root, "package.json")), true);
    assert.equal(isReadable(roots, path.join(root, "src", "app.ts")), true);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", "index.ts")), true);
    assert.equal(isReadable(roots, path.join(root, ".bachata", "policy.json")), false);
    assert.equal(isReadable(roots, path.join(root, ".git", "config")), false);
    assert.equal(isReadable(roots, path.join(root, ".env")), false);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", ".env.production")), false);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", ".bachata", "nested.json")), false);
    assert.equal(roots.includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("declared protected paths are removed from readable roots", async () => {
  const root = createWorkspace();
  try {
    const roots = await resolveReadableWorkspaceRoots(root, ["src"]);
    assert.equal(isReadable(roots, path.join(root, "src", "app.ts")), false);
    assert.equal(isReadable(roots, path.join(root, "package.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symlinks are never granted as readable roots", async () => {
  const root = createWorkspace();
  try {
    fs.symlinkSync(path.join(root, ".bachata"), path.join(root, "link-to-pair"), "dir");
    fs.symlinkSync(os.homedir(), path.join(root, "link-to-home"), "dir");
    const roots = await resolveReadableWorkspaceRoots(root, []);
    assert.equal(isReadable(roots, path.join(root, "link-to-pair")), false);
    assert.equal(isReadable(roots, path.join(root, "link-to-home")), false);
    assert.equal(isReadable(roots, path.join(root, "src", "app.ts")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary generated directories stay readable", () => {
  assert.equal(isDisclosedReadExclusion("node_modules/pkg/index.js"), false);
  assert.equal(isDisclosedReadExclusion("dist/extension.js"), false);
  assert.equal(isDisclosedReadExclusion(".env.example"), false);
  assert.equal(isDisclosedReadExclusion("src/app.ts"), false);
  assert.equal(isDisclosedReadExclusion(".bachata/policy.json"), true);
  assert.equal(isDisclosedReadExclusion("nested/.git/config"), true);
  assert.equal(isDisclosedReadExclusion("config/credentials.json"), true);
});

test("a policy-bearing Codex run is refused instead of promising a read scope Codex cannot keep", async () => {
  const root = createWorkspace();
  const recordPath = path.join(os.tmpdir(), `mock-codex-read-exclusion-${process.pid}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    requestApproval: async () => "accept",
    log: () => undefined,
  });
  try {
    await assert.rejects(
      (async () => {
        for await (const event of adapter.send({
          prompt: "REVIEW",
          workingDirectory: root,
          attachments: [],
          permissionMode: "readOnly",
          workspacePolicy: { readOnly: true, writeScope: "readOnly", allowedPaths: [], commitMode: "never" },
        }, new AbortController().signal)) {
          void event;
        }
      })(),
      (error) => {
        assert.equal(error.failure.code, "scopeUnsupported");
        assert.equal(error.failure.sideEffects, "none");
        assert.match(error.message, /has no per-path readable-root capability/u);
        assert.match(error.message, /bachata\.codexWorkspaceScope/u);
        return true;
      },
    );
    const records = fs.existsSync(recordPath)
      ? fs.readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.deepEqual(
      records,
      [],
      "a refused run must not reach the provider at all, not even to hand it an initialize",
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) delete process.env.MOCK_RECORD_PATH;
    else process.env.MOCK_RECORD_PATH = previous;
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude shell execution fails closed while path-scoped reads remain available", async () => {
  const root = createWorkspace();
  const requestData = {
    prompt: "x",
    workingDirectory: root,
    attachments: [],
    workspacePolicy: { readOnly: false, writeScope: "workspace", allowedPaths: [], commitMode: "never" },
  };
  const decide = async (command) =>
    validateClaudeWorkspaceToolUse(requestData, { toolName: "Bash", toolInput: { command } });
  try {
    for (const command of [
      "cat src/app.ts",
      "npm test",
      "python3 -c \"open('.bachata/policy.json').read()\"",
      "git show HEAD:.bachata/policy.json",
      "target=.bachata/policy.json; cat $target",
      "cat $(echo .bachata/policy.json)",
      "sh -c 'cat src/app.ts'",
      `cat ${path.join(root, ".bachata", "policy.json")}`,
    ]) {
      const decision = await decide(command);
      assert.equal(decision.behavior, "deny", command);
      assert.match(decision.message, /cannot enforce workspace read exclusions/u);
    }
    assert.equal((await validateClaudeWorkspaceToolUse(
      requestData,
      { toolName: "Read", toolInput: { file_path: path.join(root, "src", "app.ts") } },
    )).behavior, "allow");
    assert.equal((await validateClaudeWorkspaceToolUse(
      requestData,
      { toolName: "Read", toolInput: { file_path: path.join(root, ".bachata", "policy.json") } },
    )).behavior, "deny");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// EX-A5-R11. The recursive-read guard asked only about the run's *configured* restricted paths,
// and those are the smaller half of the policy. `.env`, private keys and credential files are
// refused by name and by pattern wherever they sit — a direct read of one is rejected — so a
// search rooted above one handed back exactly what the direct read could not.
test("a recursive read rooted above a built-in exclusion is refused even with nothing configured", async () => {
  const root = createWorkspace();
  const requestData = {
    prompt: "x",
    workingDirectory: root,
    attachments: [],
    workspacePolicy: {
      readOnly: false,
      writeScope: "workspace",
      allowedPaths: [],
      commitMode: "never",
      restrictedPaths: [],
    },
  };
  try {
    // A direct read of the file is refused.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Read",
        toolInput: { file_path: path.join(root, ".env") },
      })).behavior,
      "deny",
    );
    for (const toolName of ["Grep", "Glob", "Search"]) {
      const decision = await validateClaudeWorkspaceToolUse(requestData, {
        toolName,
        toolInput: { path: root, pattern: "TOKEN" },
      });
      assert.equal(decision.behavior, "deny", toolName);
      assert.match(decision.message, /cannot enforce workspace read exclusions/u, toolName);
    }
    // A recursive read with no root at all defaults to the working directory, and is judged the
    // same way rather than skipping the guard for want of a path argument.
    const implicit = await validateClaudeWorkspaceToolUse(requestData, {
      toolName: "Grep",
      toolInput: { pattern: "TOKEN" },
    });
    assert.equal(implicit.behavior, "deny");
    // A root that holds nothing excluded is still available.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Grep",
        toolInput: { path: path.join(root, "src"), pattern: "token" },
      })).behavior,
      "allow",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// EX-G6-07. Grep and Glob are recursive: the only thing the tool-use hook sees is the search
// root, and the only thing it checks is that the root is readable. Everything the tool then
// returns from below that root is unfiltered, so a run that withholds a path can hand the model
// the contents of that path as long as an allowed ancestor was named.
test("a recursive read rooted above a withheld path is refused", async () => {
  const root = createWorkspace();
  const requestData = {
    prompt: "x",
    workingDirectory: root,
    attachments: [],
    workspacePolicy: {
      readOnly: false,
      writeScope: "workspace",
      allowedPaths: [],
      commitMode: "never",
      restrictedPaths: ["packages/inner"],
    },
  };
  try {
    // The read tools this build classifies as recursive. `Find` is in the recursive set too but
    // is not a classified read tool today, so it never reaches this branch.
    for (const toolName of ["Grep", "Glob", "Search"]) {
      const decision = await validateClaudeWorkspaceToolUse(requestData, {
        toolName,
        toolInput: { path: path.join(root, "packages"), pattern: "token" },
      });
      assert.equal(decision.behavior, "deny", toolName);
      assert.match(decision.message, /cannot enforce workspace read exclusions/u);
      assert.match(decision.message, /packages\/inner/u);
    }

    // The same tool, rooted where nothing is withheld below it, is still available.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Grep",
        toolInput: { path: path.join(root, "src"), pattern: "token" },
      })).behavior,
      "allow",
    );
    // And a single-file read of an allowed path is untouched by this rule.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Read",
        toolInput: { file_path: path.join(root, "src", "app.ts") },
      })).behavior,
      "allow",
    );
    // A recursive read of the withheld path itself was already refused, and still is.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Grep",
        toolInput: { path: path.join(root, "packages", "inner"), pattern: "token" },
      })).behavior,
      "deny",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("declared read paths are recursively filtered, not granted whole", async () => {
  const root = createWorkspace();
  try {
    const declared = [path.join(root, "packages")];
    const roots = await resolveReadableWorkspaceRoots(root, [], declared);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", "index.ts")), true);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", ".env.production")), false);
    assert.equal(isReadable(roots, path.join(root, "packages", "inner", ".bachata", "nested.json")), false);
    assert.equal(roots.includes(path.join(root, "packages")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a declared read path that cannot be resolved fails the run closed", async () => {
  const root = createWorkspace();
  try {
    await assert.rejects(
      resolveReadableWorkspaceRoots(root, [], [path.join(root, "does-not-exist")]),
      /Declared read path cannot be resolved/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an acknowledged Codex workspace-write run names its writable roots and keeps no read exclusion", async () => {
  const root = createWorkspace();
  const recordPath = path.join(os.tmpdir(), `mock-codex-write-roots-${process.pid}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    workspaceScope: "wholeWorkingDirectory",
    requestApproval: async () => "accept",
    log: () => undefined,
  });
  try {
    for await (const _event of adapter.send({
      prompt: "FIX",
      workingDirectory: root,
      attachments: [],
      permissionMode: "workspaceWrite",
      workspacePolicy: { readOnly: false, writeScope: "workspace", allowedPaths: ["."], commitMode: "never" },
    }, new AbortController().signal)) {
      void _event;
    }
    const records = fs.readFileSync(recordPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const policy = records.find((record) => record.type === "turn").params.sandboxPolicy;
    assert.equal(policy.writableRoots.includes(root), true);
    assert.equal(policy.excludeTmpdirEnvVar, true);
    assert.equal(policy.excludeSlashTmp, true);
    assert.equal(
      Object.keys(policy).some((key) => key.toLowerCase().includes("read")),
      false,
      "the protocol carries no readable-root field, so Bachata must not appear to send one",
    );
    assert.equal(
      isReadable(policy.writableRoots, path.join(root, ".bachata", "policy.json")),
      true,
      "an acknowledged whole-directory run keeps no read exclusion; that is what the acknowledgement records",
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) delete process.env.MOCK_RECORD_PATH;
    else process.env.MOCK_RECORD_PATH = previous;
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude shell is denied under a read-only workspace policy as well", async () => {
  const decision = await validateClaudeWorkspaceToolUse({
    prompt: "x",
    workingDirectory: "/workspace",
    attachments: [],
    workspacePolicy: { readOnly: true, writeScope: "readOnly", allowedPaths: [], commitMode: "never" },
  }, { toolName: "Bash", toolInput: { command: "npm test" } });
  assert.equal(decision.behavior, "deny");
});

test("direct adapter use without a workspace policy is not a production guarantee", async () => {
  const decision = await validateClaudeWorkspaceToolUse({
    prompt: "x",
    workingDirectory: "/workspace",
    attachments: [],
  }, { toolName: "Bash", toolInput: { command: "cat .bachata/policy.json" } });
  assert.equal(
    decision.behavior,
    "allow",
    "Bachata always constructs a workspace policy in production; this asserts the bare-adapter path, not a shipped boundary",
  );
});

test("no built-in preset prompt tells a Claude participant to run repository commands (regex audit, not a complete invariant)", () => {
  const presetDir = path.join(__dirname, "..", "presets");
  const shellAssumption = /\brun (?:the )?(?:npm|yarn|pnpm|pytest|make|cargo|go|the tests|the test suite|repository commands)\b/iu;
  const offenders = [];
  for (const file of fs.readdirSync(presetDir).filter((name) => name.endsWith(".json"))) {
    const pipeline = JSON.parse(fs.readFileSync(path.join(presetDir, file), "utf8"));
    const claudeAgents = new Set((pipeline.agents ?? [])
      .filter((agent) => agent.adapter === "claude-code" || agent.adapter === "zai-glm")
      .map((agent) => agent.id));
    if (claudeAgents.size === 0) continue;
    const assigned = new Map();
    for (const step of pipeline.steps ?? []) {
      if (step.type === "assignRoles") {
        for (const assignment of step.roleAssignments ?? []) assigned.set(assignment.role, assignment.agentId);
      }
    }
    const candidateRoles = new Set((pipeline.roles ?? [])
      .filter((role) => (role.candidateAgentIds ?? []).some((id) => claudeAgents.has(id)))
      .map((role) => role.id));
    for (const step of pipeline.steps ?? []) {
      if (step.type !== "agent" || typeof step.promptTemplate !== "string") continue;
      const participants = step.participants ?? [];
      const involvesClaude = participants.length === 0 || participants.some((participant) =>
        claudeAgents.has(participant) ||
        claudeAgents.has(assigned.get(participant)) ||
        candidateRoles.has(participant));
      if (!involvesClaude) continue;
      const negated = /do not run repository commands|do not produce commands/iu.test(step.promptTemplate);
      if (!negated && shellAssumption.test(step.promptTemplate)) {
        offenders.push(`${file}:${step.id}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "regex audit over shipped preset prompts; it cannot prove no preset assumes shell, only that none phrases it these ways",
  );
});

const createBudgetWorkspace = (fileCount) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-read-budget-")));
  const wide = path.join(root, "wide");
  fs.mkdirSync(wide);
  // One excluded file keeps the directory unclean, so every sibling becomes its own root
  // instead of collapsing into a single directory root.
  fs.writeFileSync(path.join(wide, ".env"), "TOKEN=1");
  for (let index = 0; index < fileCount; index += 1) {
    fs.writeFileSync(path.join(wide, `file-${String(index).padStart(5, "0")}.ts`), "export const a = 1;");
  }
  return { root, wide };
};

test("readable-root expansion accepts a workspace that fits the limit exactly", async () => {
  const { root, wide } = createBudgetWorkspace(MAX_READABLE_ROOTS);
  try {
    const roots = await resolveReadableWorkspaceRoots(root, [], [wide]);
    assert.equal(roots.length, MAX_READABLE_ROOTS);
    assert.equal(roots.includes(path.join(wide, ".env")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readable-root expansion fails closed with an actionable error past the limit", async () => {
  const { root, wide } = createBudgetWorkspace(MAX_READABLE_ROOTS + 1);
  try {
    await assert.rejects(
      resolveReadableWorkspaceRoots(root, [], [wide]),
      (error) => {
        assert.equal(error.name, "MutationPolicyError");
        assert.equal(error.code, "POLICY_VIOLATION");
        assert.match(error.message, /readable-root limit/u);
        assert.match(error.message, /Declare explicit read paths for this run/u);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readable-root expansion stops at the limit instead of walking the rest of the workspace", {
  skip: process.platform === "win32" ? "POSIX directory permissions are required" : false,
}, async () => {
  const { root, wide } = createBudgetWorkspace(MAX_READABLE_ROOTS + 1);
  const unreadable = path.join(root, "unreadable");
  fs.mkdirSync(unreadable);
  fs.writeFileSync(path.join(unreadable, "keep.ts"), "export const b = 2;");
  fs.chmodSync(unreadable, 0o000);
  try {
    // The over-budget target is declared first. A traversal that kept walking would reach
    // the unreadable target and report an enumeration failure instead of the budget refusal.
    await assert.rejects(
      resolveReadableWorkspaceRoots(root, [], [wide, unreadable]),
      /readable-root limit/u,
    );
  } finally {
    fs.chmodSync(unreadable, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the limit is reached inside the directory that exceeds it, before any sibling is opened", {
  skip: process.platform === "win32" ? "POSIX directory permissions are required" : false,
}, async () => {
  const { root, wide } = createBudgetWorkspace(MAX_READABLE_ROOTS + 1);
  const unreadable = path.join(wide, "unreadable");
  fs.mkdirSync(unreadable);
  fs.writeFileSync(path.join(unreadable, "keep.ts"), "export const b = 2;");
  fs.chmodSync(unreadable, 0o000);
  try {
    // The over-budget files and the unopenable directory are siblings in one directory.
    // Whichever order the filesystem lists them in, the retained files exceed the limit
    // first, so Bachata must report the limit rather than the enumeration failure.
    await assert.rejects(
      resolveReadableWorkspaceRoots(root, [], [wide]),
      (error) => {
        assert.equal(error.code, "POLICY_VIOLATION");
        assert.match(error.message, /readable-root limit/u);
        assert.equal(/Cannot enumerate/u.test(error.message), false, "the budget must trip before the sibling is opened");
        return true;
      },
    );
  } finally {
    fs.chmodSync(unreadable, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unopenable directory inside a within-budget workspace still fails closed", {
  skip: process.platform === "win32" ? "POSIX directory permissions are required" : false,
}, async () => {
  const { root, wide } = createBudgetWorkspace(4);
  const unreadable = path.join(wide, "unreadable");
  fs.mkdirSync(unreadable);
  fs.chmodSync(unreadable, 0o000);
  try {
    await assert.rejects(
      resolveReadableWorkspaceRoots(root, [], [wide]),
      /Cannot enumerate/u,
    );
  } finally {
    fs.chmodSync(unreadable, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean workspace still collapses to directory roots without spending the budget", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-read-clean-")));
  try {
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    for (let index = 0; index < 2_000; index += 1) {
      fs.writeFileSync(path.join(root, "src", "nested", `file-${String(index)}.ts`), "export const a = 1;");
    }
    const roots = await resolveReadableWorkspaceRoots(root, []);
    assert.deepEqual(roots, [root]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
