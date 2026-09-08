const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const commandRunner = require("../dist/orchestrator/commandRunner.js");
const {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
} = require("../dist/adapters/workspacePolicyAudit.js");
const { validateClaudeWorkspaceToolUse } = require("../dist/adapters/claudeCode.js");
const { createRepository, gitWorktreeSkip } = require("./support/orchestration.cjs");

const auditRequest = (workingDirectory, workspacePolicy = {}) => ({
  prompt: "p",
  workingDirectory,
  attachments: [],
  workspacePolicy: {
    readOnly: true,
    writeScope: "readOnly",
    commitMode: "never",
    ...workspacePolicy,
  },
});

const execution = (stdout, overrides = {}) => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  cancelled: false,
  cleanupConfirmed: true,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

// The audit is the only caller of runProcess in these tests, so replacing the export answers for
// git without a repository and counts exactly how many processes a capture would spawn.
const withStubbedGit = async (respond, run) => {
  const original = commandRunner.runProcess;
  const calls = [];
  commandRunner.runProcess = async (command, args, options) => {
    calls.push(args);
    return respond(command, args, options);
  };
  try {
    return await run(calls);
  } finally {
    commandRunner.runProcess = original;
  }
};

const gitStub = (statusOutput, indexOutput, indexOverrides = {}) => (_command, args, options) => {
  if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return execution("true\n");
  // EX-A5-R13. Porcelain names are relative to the repository root, so the audit resolves that
  // root before it reads anything. These stubs have no repository, so the root is the directory
  // the audit was pointed at.
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return execution(`${options.cwd}\n`);
  if (args[0] === "rev-parse" && args[1] === "HEAD") return execution("0123456789abcdef\n");
  if (args[0] === "status") return execution(statusOutput);
  if (args[0] === "ls-files") return execution(indexOutput, indexOverrides);
  throw new Error(`unexpected git invocation: ${args.join(" ")}`);
};

const indexRecord = (mode, object, filePath) => `${mode} ${object} 0\t${filePath}\0`;

const temporaryDirectory = async (prefix) =>
  mkdtemp(path.join(os.tmpdir(), prefix));

// A cancelled probe returns no exit code at all, which the audit read as "this is not a Git
// repository". The baseline was then a fabricated empty snapshot, and the post-turn audit — which
// runs without the signal — failed the interrupted turn as a repository identity change.
test("an interrupted repository probe refuses instead of recording the workspace as not a repository", async () => {
  const root = await temporaryDirectory("bachata-audit-cancelled-");
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      captureWorkspacePolicyAudit(auditRequest(root), controller.signal),
      /Command cancelled|Unable to determine whether the workspace is a Git repository/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe that times out refuses rather than answering no", async () => {
  const root = await temporaryDirectory("bachata-audit-timeout-");
  try {
    await withStubbedGit(
      () => execution("", { exitCode: undefined, stderr: "", timedOut: true }),
      async () => {
        await assert.rejects(
          captureWorkspacePolicyAudit(auditRequest(root)),
          /Unable to determine whether the workspace is a Git repository/u,
        );
      },
    );
    await withStubbedGit(
      () => execution("true\n", { cleanupConfirmed: false, stderr: "Process scope cleanup could not be confirmed" }),
      async () => {
        await assert.rejects(
          captureWorkspacePolicyAudit(auditRequest(root)),
          /cleanup could not be confirmed/u,
        );
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The snapshot the cancelled probe used to fabricate, shown reaching the misreport it caused.
test("an empty baseline against a live worktree is what the identity-change refusal reports", gitWorktreeSkip, async () => {
  const root = await temporaryDirectory("bachata-audit-identity-");
  try {
    const repository = await createRepository(root, undefined, { "src/a.ts": "one\n" });
    await assert.rejects(
      assertWorkspacePolicyAudit(
        auditRequest(repository, { automated: false }),
        { isGitRepository: false, head: "", entries: {} },
      ),
      /Workspace repository identity changed during the agent turn/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// One `git ls-files` per capture, not one per dirty path. The per-path fingerprint must still be
// the index state of that path alone, so a listing hashed wholesale would fail this too.
test("the index is read with a single git process however many paths are dirty", async () => {
  const root = await temporaryDirectory("bachata-audit-batch-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "one\n", "utf8");
    const untracked = Array.from({ length: 40 }, (_value, index) => `generated/file-${String(index)}.txt`);
    const statusOutput = [
      " M src/a.ts\0",
      ...untracked.map((relative) => `?? ${relative}\0`),
      "?? pkg\0",
    ].join("");
    const listing = (object) => [
      indexRecord("100644", "aaaaaaa", "src/a.ts"),
      indexRecord("100644", "ccccccc", "src/c.ts"),
      indexRecord("100644", object, "pkg/inner.ts"),
    ].join("");

    const first = await withStubbedGit(gitStub(statusOutput, listing("ddddddd")), async (calls) => {
      const snapshot = await captureWorkspacePolicyAudit(auditRequest(root));
      assert.equal(calls.filter((args) => args[0] === "ls-files").length, 1);
      assert.equal(calls.length, 5);
      assert.equal(Object.keys(snapshot.entries).length, 42);
      return snapshot;
    });

    const second = await withStubbedGit(gitStub(statusOutput, listing("eeeeeee")), async () => {
      return captureWorkspacePolicyAudit(auditRequest(root));
    });

    // Only the path whose index entry moved has a new fingerprint, and a directory named by the
    // status output still carries the index state of everything beneath it.
    assert.notEqual(first.entries.pkg, second.entries.pkg);
    assert.equal(first.entries["src/a.ts"], second.entries["src/a.ts"]);
    assert.equal(first.entries["generated/file-0.txt"], second.entries["generated/file-0.txt"]);
    assert.notEqual(first.entries["src/a.ts"], first.entries["generated/file-0.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R13. Porcelain status names paths from the repository root whatever directory Git ran
// in, and the audit resolved and hashed them from the selected working directory instead. Open a
// nested package and every path is resolved one level too deep: an already-dirty file mutated
// during the turn keeps its fingerprint, so the change is invisible, and the first authorized
// edit is refused as out of scope because its name is measured against the wrong root.
test("a nested working directory audits the repository's own paths", gitWorktreeSkip, async () => {
  const root = await temporaryDirectory("bachata-audit-nested-");
  try {
    const repository = await createRepository(root, undefined, {
      "packages/app/index.ts": "one\n",
      "README.md": "readme\n",
    });
    const nested = path.join(repository, "packages", "app");
    await writeFile(path.join(nested, "index.ts"), "two\n", "utf8");

    const before = await captureWorkspacePolicyAudit(auditRequest(nested));
    assert.equal(before.isGitRepository, true);
    assert.deepEqual(Object.keys(before.entries), ["packages/app/index.ts"]);
    assert.notEqual(
      before.entries["packages/app/index.ts"],
      "missing",
      "the audit resolved the dirty path from the nested directory, so it read nothing",
    );

    await writeFile(path.join(nested, "index.ts"), "three\n", "utf8");
    const after = await captureWorkspacePolicyAudit(auditRequest(nested));
    assert.notEqual(
      before.entries["packages/app/index.ts"],
      after.entries["packages/app/index.ts"],
      "a mutation to an already-dirty file left the fingerprint unchanged",
    );

    // The turn was allowed to write exactly this file, named as the agent sees it from its own
    // working directory.
    await assert.doesNotReject(assertWorkspacePolicyAudit(
      auditRequest(nested, {
        readOnly: false,
        writeScope: "configured",
        allowedPaths: ["index.ts"],
        commitMode: "never",
      }),
      before,
    ));

    // A change outside the working directory is still refused, whatever the policy allows inside.
    await writeFile(path.join(repository, "README.md"), "changed\n", "utf8");
    const outside = await captureWorkspacePolicyAudit(auditRequest(nested));
    assert.ok(Object.keys(outside.entries).includes("README.md"));
    await assert.rejects(assertWorkspacePolicyAudit(
      auditRequest(nested, {
        readOnly: false,
        writeScope: "configured",
        allowedPaths: ["index.ts"],
        commitMode: "never",
      }),
      before,
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean worktree reads no index at all", async () => {
  const root = await temporaryDirectory("bachata-audit-clean-");
  try {
    await withStubbedGit(gitStub("", ""), async (calls) => {
      const snapshot = await captureWorkspacePolicyAudit(auditRequest(root));
      assert.deepEqual(snapshot.entries, {});
      assert.equal(snapshot.isGitRepository, true);
      assert.equal(calls.filter((args) => args[0] === "ls-files").length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an index listing that failed, was truncated or is malformed refuses", async () => {
  const root = await temporaryDirectory("bachata-audit-listing-");
  try {
    const statusOutput = "?? note.txt\0";
    await withStubbedGit(
      gitStub(statusOutput, "", { exitCode: 128, stderr: "fatal: not a git repository" }),
      async () => {
        await assert.rejects(captureWorkspacePolicyAudit(auditRequest(root)), /not a git repository/u);
      },
    );
    await withStubbedGit(
      gitStub(statusOutput, indexRecord("100644", "aaaaaaa", "note.txt"), { stdoutTruncated: true }),
      async () => {
        await assert.rejects(captureWorkspacePolicyAudit(auditRequest(root)), /Unable to inspect Git index state/u);
      },
    );
    await withStubbedGit(
      gitStub(statusOutput, "100644 aaaaaaa 0 note.txt\0"),
      async () => {
        await assert.rejects(captureWorkspacePolicyAudit(auditRequest(root)), /invalid index listing output/u);
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The batched listing is parsed here, so a real `git ls-files -s -z` proves the parse, not a stub.
test("a staged change is still visible through the batched index listing", gitWorktreeSkip, async () => {
  const root = await temporaryDirectory("bachata-audit-real-");
  try {
    const repository = await createRepository(root, undefined, { "src/a.ts": "one\n", "src/b.ts": "two\n" });
    const git = (...args) =>
      execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    await writeFile(path.join(repository, "src", "a.ts"), "one changed\n", "utf8");
    await writeFile(path.join(repository, "untracked.txt"), "u\n", "utf8");
    const request = auditRequest(repository);
    const before = await captureWorkspacePolicyAudit(request);
    assert.equal(before.isGitRepository, true);
    assert.deepEqual(Object.keys(before.entries).sort(), ["src/a.ts", "untracked.txt"]);
    git("add", "src/a.ts");
    const after = await captureWorkspacePolicyAudit(request);
    assert.notEqual(before.entries["src/a.ts"], after.entries["src/a.ts"]);
    assert.equal(before.entries["untracked.txt"], after.entries["untracked.txt"]);
    assert.equal(before.head, after.head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// `mcp__fs__search_replace` splits to [mcp, fs, search, replace]; `search` alone used to win the
// read classification, and a read on a run that declares no readPaths is validated against the
// whole workspace, so the declared allowedPaths never applied to it.
test("a mutating tool whose name merely contains a read word is refused, not treated as a read", async () => {
  const root = await temporaryDirectory("bachata-tool-category-");
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
    const requestData = {
      prompt: "x",
      workingDirectory: root,
      attachments: [],
      workspacePolicy: {
        readOnly: false,
        writeScope: "configured",
        allowedPaths: ["src"],
        commitMode: "never",
      },
    };
    const escaped = await validateClaudeWorkspaceToolUse(requestData, {
      toolName: "mcp__fs__search_replace",
      toolInput: { path: "docs/notes.md" },
    });
    assert.equal(escaped.behavior, "deny");
    assert.match(escaped.message, /Unclassified Claude tool is disabled for scoped autonomous execution/u);

    // The declared read tools are untouched.
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Read",
        toolInput: { file_path: path.join(root, "src", "app.ts") },
      })).behavior,
      "allow",
    );
    assert.equal(
      (await validateClaudeWorkspaceToolUse(requestData, {
        toolName: "Grep",
        toolInput: { path: path.join(root, "src"), pattern: "const" },
      })).behavior,
      "allow",
    );
    // And a mutating name is still classified as a mutation rather than falling through.
    const write = await validateClaudeWorkspaceToolUse(requestData, {
      toolName: "mcp__fs__write_file",
      toolInput: { path: "docs/notes.md" },
    });
    assert.equal(write.behavior, "deny");
    assert.doesNotMatch(write.message, /Unclassified/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
