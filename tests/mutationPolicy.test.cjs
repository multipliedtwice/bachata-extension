const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertWorkspacePathAllowed,
  commitPolicyRefusesToolRequest,
  isCommitLikeCommand,
  isGitStateMutationCommand,
  toolRequestShellCommand,
  isRestrictedWorkspacePath,
} = require("../dist/browser/mutationPolicy.js");

test("exact-file allowedPaths do not authorize descendants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-scope-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/parser.ts"), "export {};\n");
    await assertWorkspacePathAllowed(root, "src/parser.ts", { allowedPaths: ["src/parser.ts"] });
    await assert.rejects(
      assertWorkspacePathAllowed(root, "src/parser.ts/child.ts", { allowedPaths: ["src/parser.ts"] }),
      /outside the task scope/,
    );
    await assertWorkspacePathAllowed(root, "src/parser.ts", { allowedPaths: ["src"] });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("explicit missing-directory allowedPaths authorize future descendants without widening missing-file scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-future-scope-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await assertWorkspacePathAllowed(root, "src/new-feature/file.ts", { allowedPaths: ["src/new-feature/"] });
    await assertWorkspacePathAllowed(root, "src/future-file.ts", { allowedPaths: ["src/future-file.ts"] });
    await assert.rejects(
      assertWorkspacePathAllowed(root, "src/future-file.ts/child.ts", { allowedPaths: ["src/future-file.ts"] }),
      /outside the task scope/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("env example is readable policy input while real env files remain restricted", () => {
  assert.equal(isRestrictedWorkspacePath(".env.example"), false);
  assert.equal(isRestrictedWorkspacePath(".env"), true);
  assert.equal(isRestrictedWorkspacePath(".env.local"), true);
  assert.equal(isRestrictedWorkspacePath("config/.env.production"), true);
});

test("commit command detector unwraps aliases and eval", () => {
  assert.equal(isCommitLikeCommand("git commit -m x"), true);
  assert.equal(isCommitLikeCommand("G=git; $G commit -m x"), true);
  assert.equal(isCommitLikeCommand("eval 'git commit -m x'"), true);
  assert.equal(isCommitLikeCommand("python3 -c 'import os; os.system(\"git commit -am x\")'"), true);
  assert.equal(isCommitLikeCommand("node -e 'require(\"node:child_process\").execSync(\"git commit -am x\")'"), true);
  assert.equal(isCommitLikeCommand("git status --short"), false);
  assert.equal(isCommitLikeCommand("echo 'git commit -m example'"), false);
});

test("verification Git-state detector rejects staging and patch mutations", () => {
  assert.equal(isGitStateMutationCommand("git status --short"), false);
  assert.equal(isGitStateMutationCommand("git diff --check"), false);
  assert.equal(isGitStateMutationCommand("git add src/a.ts"), true);
  assert.equal(isGitStateMutationCommand("git apply update.patch"), true);
  assert.equal(isGitStateMutationCommand("git checkout -- src/a.ts"), true);
});

// EX-2. Unwrapping a nested interpreter used to return only that expansion, discarding every
// sibling segment, so appending any shell wrapper erased the command in front of it.
test("a nested shell does not erase the sibling commands around it", () => {
  assert.equal(isCommitLikeCommand("git commit -m x; sh -c true"), true);
  assert.equal(isCommitLikeCommand("git push; sh -c true"), true);
  assert.equal(isCommitLikeCommand("git checkout -- a; bash -c :"), true);
  assert.equal(isCommitLikeCommand("sh -c true; git commit -m x"), true);
  assert.equal(isCommitLikeCommand("git commit -m x && sh -c \"true\""), true);
  assert.equal(isGitStateMutationCommand("git add a; sh -c true"), true);
  assert.equal(isGitStateMutationCommand("git apply p.patch; bash -c :"), true);
});

test("accumulating nested expansions does not start flagging read-only commands", () => {
  assert.equal(isCommitLikeCommand("git status --short; sh -c true"), false);
  assert.equal(isCommitLikeCommand("echo 'git commit -m example'; sh -c true"), false);
  assert.equal(isCommitLikeCommand("sh -c 'git status'"), false);
  assert.equal(isGitStateMutationCommand("git diff --check; sh -c true"), false);
});

test("a quoted interpreter payload is still read as one command", () => {
  assert.equal(isCommitLikeCommand("bash -lc 'git commit -m x'"), true);
  assert.equal(isCommitLikeCommand("bash -lc \"git commit -m x\""), true);
  assert.equal(isCommitLikeCommand("bash -lc 'git status'"), false);
});

// EX-AUD-02. The option scan stopped at the first token that did not start with `-`, so a
// Bash option operand (`-O extglob`, `-o pipefail`) hid the `-c` behind it, and `--rcfile`
// matched on the `c` inside its own name and returned the file path instead of the payload.
// Each of these reached the workspace with its command string never classified.
test("bash option operands do not hide a commit payload behind -c", () => {
  const hidden = [
    'bash -O extglob -c "git commit -m x"',
    'bash +O extglob -c "git commit -m x"',
    'bash -o pipefail -c "git commit -m x"',
    'bash --rcfile /tmp/rc -c "git commit -m x"',
    'bash --init-file /tmp/rc -c "git commit -m x"',
    'sh -O extglob -c "git push"',
    'bash -O extglob -o pipefail -c "git commit -m x"',
  ];
  for (const command of hidden) {
    assert.equal(isCommitLikeCommand(command), true, `${command} was not classified as a commit`);
  }
});

test("ordinary and combined bash forms keep classifying as before", () => {
  assert.equal(isCommitLikeCommand('bash -c "git commit -m x"'), true);
  assert.equal(isCommitLikeCommand('bash -xc "git commit -m x"'), true);
  assert.equal(isCommitLikeCommand('bash -lc "git commit -m x"'), true);
  assert.equal(isCommitLikeCommand('bash --posix -c "git commit -m x"'), true);
  assert.equal(isCommitLikeCommand('bash --rcfile=/tmp/rc -c "git commit -m x"'), true);
});

test("a read-only payload behind an option operand is still read-only", () => {
  assert.equal(isCommitLikeCommand('bash -O extglob -c "git status"'), false);
  assert.equal(isCommitLikeCommand('bash --rcfile /tmp/rc -c "git diff"'), false);
});

test("malformed and terminated option forms never lose the command in front of them", () => {
  assert.equal(isCommitLikeCommand("bash -- git commit"), true);
  assert.equal(isCommitLikeCommand("bash - git commit"), true);
  assert.equal(isCommitLikeCommand('bash -O'), false);
  assert.equal(isCommitLikeCommand('bash --rcfile'), false);
  assert.equal(isCommitLikeCommand('git commit -m x; bash -O extglob -c "git status"'), true);
});

// EX-AUD-02, prevention half. Under `commitMode: "never"` the only enforcement was a
// post-run HEAD comparison, which reports a commit that already happened. The approval path
// now refuses the command before the tool runs, and it reads the same option-aware parse,
// so an operand-hidden `-c` payload cannot walk through the broker either.
test("a commit-mode-never run refuses a commit tool request before it runs", () => {
  const hidden = [
    { command: "git commit -m x" },
    { command: 'bash -O extglob -c "git commit -m x"' },
    { command: 'bash --rcfile /tmp/rc -c "git commit -m x"' },
    { cmd: 'bash -o pipefail -c "git push"' },
    { script: "git commit --amend" },
  ];
  for (const toolInput of hidden) {
    assert.equal(
      commitPolicyRefusesToolRequest("never", toolInput),
      true,
      `${JSON.stringify(toolInput)} was not refused under commitMode never`,
    );
  }
});

test("commit-mode allow and read-only commands are not refused", () => {
  assert.equal(commitPolicyRefusesToolRequest("allow", { command: "git commit -m x" }), false);
  assert.equal(commitPolicyRefusesToolRequest(undefined, { command: "git commit -m x" }), false);
  assert.equal(commitPolicyRefusesToolRequest("never", { command: "git status" }), false);
  assert.equal(commitPolicyRefusesToolRequest("never", { command: 'bash -O extglob -c "git diff"' }), false);
  assert.equal(commitPolicyRefusesToolRequest("never", {}), false);
  assert.equal(commitPolicyRefusesToolRequest("never", { command: "   " }), false);
});

test("a tool command is read from whichever field carries it", () => {
  assert.equal(toolRequestShellCommand({ command: "a" }), "a");
  assert.equal(toolRequestShellCommand({ cmd: "b" }), "b");
  assert.equal(toolRequestShellCommand({ script: "c" }), "c");
  assert.equal(toolRequestShellCommand({ other: "d" }), undefined);
  assert.equal(toolRequestShellCommand({ command: 42 }), undefined);
});
