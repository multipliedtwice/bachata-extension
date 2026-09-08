import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { acquireWorktreeLock } from "./lib/worktreeLock.mjs";

// This gate loads the built tree, so it holds the same worktree lock the build takes.
// The lock is held for the whole gate and released explicitly below. Nothing releases
// it on a signal: a run that dies without reaching the release leaves the lock for an
// operator, because its child processes may still be working in this worktree.
const worktreeLock = await acquireWorktreeLock({ label: "managed module checks" });
try {
  const root = process.cwd();
  const require = createRequire(import.meta.url);
  const load = (relative) => require(path.join(root, "dist", relative));

  const mutation = load("browser/mutationPolicy.js");
  assert.equal(mutation.isRestrictedWorkspacePath(".env"), true);
  assert.equal(mutation.isRestrictedWorkspacePath(".env.example"), false);
  assert.equal(mutation.isRestrictedWorkspacePath(".git/config"), true);
  assert.equal(mutation.isRestrictedWorkspacePath(".ssh/config"), true);
  assert.equal(mutation.isRestrictedWorkspacePath(".git-credentials"), true);
  assert.equal(mutation.isRestrictedWorkspacePath(".netrc"), true);
  assert.equal(mutation.isRestrictedWorkspacePath(".kube/config.yaml"), true);
  assert.equal(mutation.isRestrictedWorkspacePath("certs/private.pem"), true);
  assert.equal(mutation.isRestrictedWorkspacePath("src/index.ts"), false);
  assert.equal(mutation.isAllowedWorkspacePath("src/index.ts", ["."]), true);
  assert.equal(mutation.isCommitLikeCommand("git commit -m test"), true);
  assert.equal(mutation.isCommitLikeCommand("git status && git commit -m test"), true);
  assert.equal(mutation.isCommitLikeCommand("git commit-tree HEAD^{tree}"), true);
  assert.equal(mutation.isCommitLikeCommand("git am change.patch"), true);
  assert.equal(mutation.isCommitLikeCommand("git revert HEAD"), true);
  assert.equal(mutation.isCommitLikeCommand("git pull"), true);
  assert.equal(mutation.isCommitLikeCommand('bash -c "git commit -m test"'), true);
  assert.equal(mutation.isCommitLikeCommand('/bin/bash -c "git commit -m test"'), true);
  assert.equal(mutation.isCommitLikeCommand('/bin/sh -lc "git push origin main"'), true);
  assert.equal(mutation.isCommitLikeCommand('/usr/bin/zsh -c "git tag release"'), true);
  assert.equal(mutation.isCommitLikeCommand('C:\\Windows\\System32\\cmd.exe /c "git commit -m test"'), true);
  assert.equal(mutation.isCommitLikeCommand('"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git push origin main"'), true);
  assert.equal(mutation.isCommitLikeCommand("env A=1 git -C . push origin main"), true);
  assert.equal(mutation.isCommitLikeCommand("G=git; $G commit -m test"), true);
  assert.equal(mutation.isCommitLikeCommand("eval 'git commit -m test'"), true);
  assert.equal(mutation.isCommitLikeCommand("git status --short"), false);
  assert.equal(mutation.isCommitLikeCommand("git ci -m hidden-alias"), true);
  assert.equal(mutation.isCommitLikeCommand("git fetch origin"), true);
  assert.equal(mutation.isCommitLikeCommand("git config alias.ci commit"), true);
  assert.throws(() => mutation.assertWorkspaceActionAllowed({ kind: "workspace.write", path: ".env" }));
  assert.throws(() => mutation.assertWorkspaceActionAllowed({ kind: "workspace.write", path: "other/a.ts" }, { readOnly: false, allowedPaths: ["src"] }));
  assert.throws(() => mutation.assertWorkspaceActionAllowed({ kind: "workspace.read", path: "other/a.ts" }, { readOnly: false, allowedPaths: ["src"] }));
  assert.throws(() => mutation.assertWorkspaceActionAllowed({ kind: "workspace.write", path: "src/a.ts" }, { readOnly: true, allowedPaths: ["src"] }));
  assert.throws(() => mutation.assertWorkspaceActionAllowed({ kind: "shell.run", command: "git commit -m test" }, { commitMode: "never" }));
  assert.doesNotThrow(() => mutation.assertWorkspaceActionAllowed({ kind: "workspace.write", path: "src/index.ts" }, { commitMode: "never", readOnly: false, allowedPaths: ["src"] }));

  const scopeRoot = fs.mkdtempSync(path.join(root, ".bachata-managed-scope-"));
  try {
    fs.mkdirSync(path.join(scopeRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(scopeRoot, "private"), { recursive: true });
    fs.writeFileSync(path.join(scopeRoot, "src", "ok.txt"), "ok\n");
    fs.writeFileSync(path.join(scopeRoot, "private", "secret.txt"), "secret\n");
    fs.symlinkSync(
      process.platform === "win32" ? path.join(scopeRoot, "private") : "../private",
      path.join(scopeRoot, "src", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mutation.assertWorkspacePathAllowed(scopeRoot, "src/ok.txt", { allowedPaths: ["src"] });
    await mutation.assertWorkspacePathAllowed(scopeRoot, "src/ok.txt", { allowedPaths: ["src/ok.txt"] });
    await assert.rejects(
      mutation.assertWorkspacePathAllowed(scopeRoot, "src/ok.txt/child", { allowedPaths: ["src/ok.txt"] }),
      /outside the task scope/,
    );
    await assert.rejects(
      mutation.assertWorkspacePathAllowed(scopeRoot, "src/link/secret.txt", { allowedPaths: ["src"] }),
      /outside the task scope/,
    );
    await assert.rejects(
      mutation.assertWorkspacePathAllowed(scopeRoot, "src/link/new.txt", { allowedPaths: ["src"] }),
      /outside the task scope/,
    );
  } finally {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
  }

  const workspacePolicy = load("adapters/workspacePolicyAudit.js");
  const taskScoped = workspacePolicy.resolveWorkspaceWritePolicy({
    task: "fix bug in talents-backend/src/routes",
    workspaceRoot: root,
    writeScope: "task",
    defaultScope: "task",
  });
  assert.equal(taskScoped.writeScope, "task");
  assert.deepEqual(taskScoped.allowedPaths, ["talents-backend/src/routes"]);
  assert.throws(() => workspacePolicy.resolveWorkspaceWritePolicy({
    task: "fix the bug",
    workspaceRoot: root,
    writeScope: "task",
    defaultScope: "task",
  }), /explicit file or directory path/);
  assert.deepEqual(workspacePolicy.resolveWorkspaceWritePolicy({
    task: "refactor repository",
    workspaceRoot: root,
    writeScope: "workspace",
    defaultScope: "task",
  }), { writeScope: "workspace", allowedPaths: ["."], readOnly: false });

  const verificationPolicy = load("orchestrator/verificationPolicy.js");
  assert.equal(verificationPolicy.autonomousVerificationRefusal("bachata:workspace-integrity"), undefined);
  assert.equal(verificationPolicy.autonomousVerificationRefusal("bachata:project-checks"), undefined);
  assert.match(verificationPolicy.autonomousVerificationRefusal("npm run verify-wrapper"), /controller-owned/);
  assert.match(verificationPolicy.autonomousVerificationRefusal("./scripts/check.sh"), /controller-owned/);

  const todoParser = load("orchestrator/todoParser.js");
  assert.throws(() => todoParser.parseTodoDocument("TODO.md", "- [ ] [BUG-1] Fix bug\n  - Verify: bachata:workspace-integrity\n", {
    pipelineId: "todo-implementation",
    retries: 1,
    requirePaths: true,
    requireControllerVerification: true,
  }), /Paths is required/);
  const wholeWorkspaceTodo = todoParser.parseTodoDocument("TODO.md", "- [ ] [BUG-1] Fix bug\n  - Paths: .\n  - Verify: bachata:workspace-integrity\n", {
    pipelineId: "todo-implementation",
    retries: 1,
    requirePaths: true,
    requireControllerVerification: true,
  });
  assert.deepEqual(wholeWorkspaceTodo.tasks[0].paths, [""]);

  const claude = load("adapters/claudeCode.js");
  const claudeScope = fs.mkdtempSync(path.join(root, ".bachata-claude-scope-"));
  try {
    fs.mkdirSync(path.join(claudeScope, "src", "routes"), { recursive: true });
    fs.mkdirSync(path.join(claudeScope, "other"), { recursive: true });
    fs.writeFileSync(path.join(claudeScope, "src", "routes", "a.ts"), "export {};\n");
    fs.writeFileSync(path.join(claudeScope, "other", "b.ts"), "export {};\n");
    const request = {
      prompt: "fix src/routes/a.ts",
      workingDirectory: claudeScope,
      attachments: [],
      workspacePolicy: {
        readOnly: false,
        writeScope: "task",
        readPaths: ["src"],
        allowedPaths: ["src/routes"],
        commitMode: "never",
        disableShell: true,
        disableNetwork: true,
        automated: true,
      },
    };
    assert.equal((await claude.validateClaudeWorkspaceToolUse(request, { toolName: "Write", toolInput: { filePath: "src/routes/a.ts" } })).behavior, "allow");
    assert.equal((await claude.validateClaudeWorkspaceToolUse(request, { toolName: "mcp__filesystem__write_file", toolInput: { path: "other/b.ts" } })).behavior, "deny");
    assert.equal((await claude.validateClaudeWorkspaceToolUse(request, { toolName: "Bash", toolInput: { command: "npm test" } })).behavior, "deny");
    assert.equal((await claude.validateClaudeWorkspaceToolUse(request, { toolName: "Read", toolInput: { filePath: ".env" } })).behavior, "deny");
  } finally {
    fs.rmSync(claudeScope, { recursive: true, force: true });
  }

  const revision = load("browser/workspaceRevision.js");
  const firstFingerprint = revision.actionFingerprint({ kind: "workspace.read", path: "src/a.ts" }, 0);
  const secondFingerprint = revision.actionFingerprint({ kind: "workspace.read", path: "src/a.ts" }, 1);
  assert.notEqual(firstFingerprint, secondFingerprint);
  assert.deepEqual(revision.validateExpectedHashes({ "src/a.ts": "new" }, { "src/a.ts": "old" }), { valid: false, stalePaths: ["src/a.ts"] });

  const control = load("browser/controlProtocol.js");
  const validControl = {
    protocol: "bachata-browser-turn-v1",
    status: "applyPatch",
    actions: [{ kind: "workspace.applyPatch", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n", expectedFiles: [{ path: "src/a.ts", sha256: "a".repeat(64) }] }],
    summary: "patch",
    objections: [],
    unresolved: [],
  };
  assert.deepEqual(control.validateBrowserControlEnvelope(validControl), validControl);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, extra: true }), undefined);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, actions: [{ ...validControl.actions[0], expectedFiles: [{ path: "src/a.ts", sha256: "bad" }] }] }), undefined);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, actions: [validControl.actions[0], validControl.actions[0]] }), undefined);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, status: "done", actions: [{ kind: "context.read", snippetIds: ["s1"] }] }), undefined);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, status: "needContext", actions: [] }), undefined);
  assert.deepEqual(control.validateBrowserControlEnvelope({
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.search", query: "createRuntime" }],
  }), {
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.search", query: "createRuntime" }],
  });
  assert.deepEqual(control.validateBrowserControlEnvelope({
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.list", path: "src" }, { kind: "context.readFile", path: "package.json" }],
  }), {
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.list", path: "src" }, { kind: "context.readFile", path: "package.json" }],
  });
  assert.deepEqual(control.validateBrowserControlEnvelope({
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.tree", path: "src", depth: 3, limit: 100 }],
  }), {
    ...validControl,
    status: "needContext",
    actions: [{ kind: "context.tree", path: "src", depth: 3, limit: 100 }],
  });
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, status: "needContext", actions: [{ kind: "context.read", snippetIds: [] }] }), undefined);
  assert.equal(control.validateBrowserControlEnvelope({ ...validControl, status: "verify", actions: [{ kind: "verification.run", checkIds: [] }] }), undefined);
  const earlier = JSON.stringify({ ...validControl, status: "needContext", actions: [] });
  const later = JSON.stringify({ ...validControl, status: "done", actions: [], summary: "done" });
  assert.equal(control.extractBrowserControlEnvelope(`\`\`\`bachata-control\n${earlier}\n\`\`\`\n\`\`\`bachata-control\n${later}\n\`\`\``).status, "done");
  assert.equal(control.extractBrowserControlEnvelope(`Example only:\n\`\`\`json\n${later}\n\`\`\``), undefined);
  assert.equal(control.extractBrowserControlEnvelope(later), undefined);
  assert.equal(control.extractBrowserControlEnvelope(`\`\`\`bachata-control\n${later}\n\`\`\`\nTrailing prose`), undefined);

  const managed = load("orchestrator/managedPair.js");
  const fixedManagedDeadline = Date.now() + 60_000;
  const managedWorkspace = (value, marker) => {
    const repositoryBaseline = {
      isGitRepository: true,
      head: "a".repeat(40),
      entries: [{ path: "src/a.ts", fingerprint: marker.repeat(64) }],
    };
    return {
      repositoryBaseline,
      workspaceFingerprint: managed.computeManagedWorkspaceFingerprint({
        taskHash: value.taskHash,
        repositoryBaseline,
      }),
    };
  };
  const verificationEvent = (value, marker = "b") => {
    const workspace = managedWorkspace(value, marker);
    return {
      type: "verificationCompleted",
      verification: [{
        id: "build",
        status: "passed",
        summary: "ok",
        workspaceFingerprint: workspace.workspaceFingerprint,
      }],
      ...workspace,
    };
  };
  let checkpoint = managed.createManagedPairCheckpoint({ taskId: "task", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", allowedPaths: ["src"], requiredVerificationCheckIds: ["build"], deadlineAt: fixedManagedDeadline });
  assert.equal(checkpoint.deadlineAt, fixedManagedDeadline);
  assert.equal(checkpoint.policy.commitMode, "never");
  assert.equal(checkpoint.policy.leadReadOnly, true);
  assert.equal(checkpoint.policy.maxRevisionCycles, 1);
  assert.equal(checkpoint.policy.writeScope, "task");
  assert.throws(() => managed.createManagedPairCheckpoint({ taskId: "unscoped", originalTask: "fix bug", worktreePath: "/tmp/work" }), /explicit file or directory path/);
  const workspaceCheckpoint = managed.createManagedPairCheckpoint({ taskId: "workspace", originalTask: "Refactor repository", worktreePath: "/tmp/work", writeScope: "workspace" });
  assert.equal(workspaceCheckpoint.policy.writeScope, "workspace");
  assert.deepEqual(workspaceCheckpoint.policy.allowedPaths, ["."]);
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "prepared" });
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "workerRequestedPatch" });
  const firstWorkspace = managedWorkspace(checkpoint, "b");
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "patchApplied", changedFiles: ["src/a.ts"], diffSummary: "diff", ...firstWorkspace });
  checkpoint = managed.advanceManagedPair(checkpoint, verificationEvent(checkpoint, "b"));
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "workerDone" });
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "leadRequestedRevision", objections: ["fix"] });
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "workerRequestedPatch" });
  const secondWorkspace = managedWorkspace(checkpoint, "c");
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "revisionApplied", changedFiles: ["src/a.ts"], diffSummary: "diff2", ...secondWorkspace });
  checkpoint = managed.advanceManagedPair(checkpoint, verificationEvent(checkpoint, "c"));
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "workerDone" });
  checkpoint = managed.advanceManagedPair(checkpoint, { type: "leadAccepted" });
  assert.equal(checkpoint.state, "FINALIZE");
  assert.equal(managed.validateManagedCompletion(checkpoint).valid, true);
  const noOpCompletion = managed.validateManagedCompletion({
    ...checkpoint,
    changedFiles: [],
    diffSummary: "",
  });
  assert.equal(noOpCompletion.valid, true);
  let recovery = managed.createManagedPairCheckpoint({ taskId: "recovery", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", requiredVerificationCheckIds: ["build"] });
  recovery = managed.advanceManagedPair(recovery, { type: "prepared" });
  recovery = managed.advanceManagedPair(recovery, { type: "workerRequestedPatch" });
  recovery = managed.advanceManagedPair(recovery, { type: "patchApplied", changedFiles: ["src/a.ts"], diffSummary: "diff", ...managedWorkspace(recovery, "d") });
  assert.equal(recovery.state, "WORKER_VERIFY");
  recovery = managed.advanceManagedPair(recovery, { type: "workerNeedsContext" });
  assert.equal(recovery.state, "WORKER_NEEDS_CONTEXT");
  let zeroRevision = managed.createManagedPairCheckpoint({ taskId: "zero", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", maxRevisionCycles: 0, requiredVerificationCheckIds: ["build"] });
  zeroRevision = managed.advanceManagedPair(zeroRevision, { type: "prepared" });
  zeroRevision = managed.advanceManagedPair(zeroRevision, verificationEvent(zeroRevision, "e"));
  zeroRevision = managed.advanceManagedPair(zeroRevision, { type: "workerDone" });
  assert.equal(zeroRevision.state, "LEAD_FINAL_REVIEW");
  let twoRevisions = managed.createManagedPairCheckpoint({ taskId: "two", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", maxRevisionCycles: 2, requiredVerificationCheckIds: ["build"] });
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "prepared" });
  twoRevisions = managed.advanceManagedPair(twoRevisions, verificationEvent(twoRevisions, "f"));
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "workerDone" });
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "leadRequestedRevision", objections: ["first"] });
  twoRevisions = managed.advanceManagedPair(twoRevisions, verificationEvent(twoRevisions, "1"));
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "workerDone" });
  assert.equal(twoRevisions.state, "LEAD_REVIEW");
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "leadRequestedRevision", objections: ["second"] });
  twoRevisions = managed.advanceManagedPair(twoRevisions, verificationEvent(twoRevisions, "2"));
  twoRevisions = managed.advanceManagedPair(twoRevisions, { type: "workerDone" });
  assert.equal(twoRevisions.state, "LEAD_FINAL_REVIEW");
  assert.deepEqual(managed.parseManagedPairCheckpoint(JSON.parse(JSON.stringify(checkpoint))), checkpoint);
  assert.equal(managed.parseManagedPairCheckpoint({ ...checkpoint, taskHash: "0".repeat(64) }), undefined);
  assert.equal(managed.parseManagedPairCheckpoint({ ...checkpoint, workspaceFingerprint: "0".repeat(64) }), undefined);
  const planA = managed.createManagedPairCheckpoint({ taskId: "plan", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", verificationChecks: [{ id: "build", command: "bachata:workspace-integrity" }] });
  const planB = managed.createManagedPairCheckpoint({ taskId: "plan", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", verificationChecks: [{ id: "build", command: "bachata:project-checks" }] });
  assert.notEqual(planA.taskHash, planB.taskHash);
  assert.notEqual(planA.policy.verificationPlanHash, planB.policy.verificationPlanHash);
  const missingVerification = managed.createManagedPairCheckpoint({ taskId: "missing", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", requiredVerificationCheckIds: ["build"] });
  assert.ok(managed.validateManagedCompletion({ ...missingVerification, state: "FINALIZE", changedFiles: ["src/a.ts"] }).reasons.includes("verificationMissing"));

  let invalidated = managed.createManagedPairCheckpoint({ taskId: "invalidate", originalTask: "Change src/a.ts", worktreePath: "/tmp/work", requiredVerificationCheckIds: ["build"] });
  invalidated = managed.advanceManagedPair(invalidated, { type: "prepared" });
  invalidated = managed.advanceManagedPair(invalidated, { type: "workerRequestedPatch" });
  invalidated = managed.advanceManagedPair(invalidated, { type: "patchApplied", changedFiles: ["src/a.ts"], diffSummary: "diff", ...managedWorkspace(invalidated, "3") });
  invalidated = managed.advanceManagedPair(invalidated, verificationEvent(invalidated, "3"));
  invalidated = managed.advanceManagedPair(invalidated, { type: "workerRequestedPatch" });
  invalidated = managed.advanceManagedPair(invalidated, { type: "patchApplied", changedFiles: ["src/a.ts"], diffSummary: "diff2", ...managedWorkspace(invalidated, "4") });
  assert.deepEqual(invalidated.verification, []);
  assert.throws(() => managed.advanceManagedPair(invalidated, { type: "workerDone" }), /verification/);

  const handoff = load("context/taskHandoff.js");
  const lead = handoff.buildManagedTaskHandoff("lead", {
    taskId: "task",
    originalTask: "Original task",
    constraints: ["Do not commit"],
    commitMode: "never",
    readOnly: true,
    allowedPaths: ["src"],
    requiredVerificationCheckIds: ["build"],
    worktreePath: "/tmp/work",
    workspaceRevision: 1,
    changedFiles: ["src/a.ts"],
    preexistingChangedFiles: ["src/preexisting.ts"],
    repositoryPolicyViolations: [],
    contextCoverage: {
      inventoryCount: 2,
      indexedCount: 2,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
    },
    diff: "x".repeat(5000),
    diffOmittedFileCount: 3,
    initialContextOmitted: [{ path: "src/c.ts", score: 7, reason: ["budget"] }],
    snippets: [
      { id: "s1", path: "src/a.ts", startLine: 1, endLine: 5, sha256: "h", reason: ["changed"], text: "a".repeat(3000) },
      { id: "s2", path: "src/b.ts", startLine: 1, endLine: 5, sha256: "h2", reason: ["import"], text: "b".repeat(3000) },
    ],
    verification: [],
    unresolved: [],
  }, { totalBudgetBytes: 5000, diffBudgetBytes: 2048, snippetBudgetBytes: 2100 });
  assert.equal(lead.originalTask, "Original task");
  assert.equal(lead.policy.readOnly, true);
  assert.equal(lead.policy.commitMode, "never");
  assert.deepEqual(lead.policy.requiredVerificationCheckIds, ["build"]);
  assert.deepEqual(lead.repository.preexistingChangedFiles, ["src/preexisting.ts"]);
  assert.equal(lead.contextCoverage.indexedCount, 2);
  assert.ok(lead.omittedSnippetIds.length >= 1);

  const oversizedTaskHandoff = handoff.buildManagedTaskHandoff("worker", {
    taskId: "oversized",
    originalTask: "x".repeat(200_000),
    constraints: ["Do not commit"],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["src"],
    requiredVerificationCheckIds: ["build"],
    worktreePath: "/tmp/work",
    workspaceRevision: 1,
    changedFiles: ["src/a.ts"],
    preexistingChangedFiles: [],
    repositoryPolicyViolations: [],
    contextCoverage: {
      inventoryCount: 1,
      indexedCount: 1,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
    },
    diff: "",
    diffOmittedFileCount: 0,
    initialContextOmitted: [],
    snippets: [],
    verification: [],
    unresolved: [],
  }, { totalBudgetBytes: 96_000 });
  assert.equal(oversizedTaskHandoff.metadataCoverage.originalTask.truncated, true);
  assert.ok(oversizedTaskHandoff.metadataCoverage.originalTask.retainedBytes < oversizedTaskHandoff.metadataCoverage.originalTask.originalBytes);
  assert.deepEqual(oversizedTaskHandoff.metadataCoverage.originalTask.retrieval, {
    kind: "context.readTask",
    nextOffsetBytes: oversizedTaskHandoff.metadataCoverage.originalTask.retainedBytes,
  });
  assert.ok(Buffer.byteLength(handoff.renderManagedTaskHandoff(oversizedTaskHandoff), "utf8") <= 96_000);

  const boundedHandoffInput = {
    taskId: "bounded",
    originalTask: "Preserve this task exactly",
    constraints: ["Do not commit", "Only change src"],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["src", "src"],
    requiredVerificationCheckIds: ["build", "lint", "build"],
    worktreePath: "/tmp/work",
    workspaceRevision: 2,
    changedFiles: ["src/a.ts"],
    preexistingChangedFiles: ["src/preexisting.ts"],
    repositoryPolicyViolations: ["policy-a"],
    contextCoverage: {
      inventoryCount: 2,
      indexedCount: 2,
      maxFiles: 5000,
      maxFileBytes: 1_048_576,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
    },
    diff: "d".repeat(100_000),
    diffOmittedFileCount: 4,
    initialContextOmitted: [{ path: "src/omitted.ts", score: 9, reason: ["budget"] }],
    snippets: [
      { id: "s1", path: "src/a.ts", startLine: 1, endLine: 10, sha256: "h1", reason: ["task"], text: "z".repeat(100_000) },
      { id: "s2", path: "src/b.ts", startLine: 1, endLine: 10, sha256: "h2", reason: ["import"], text: "q".repeat(2_000) },
    ],
    verification: [{ id: "build", status: "passed", summary: "verified" }],
    unresolved: ["keep-this"],
    roleSummary: "r".repeat(10_000),
  };
  const boundedHandoff = handoff.buildManagedTaskHandoff("worker", boundedHandoffInput, { totalBudgetBytes: 96_000 });
  assert.ok(Buffer.byteLength(handoff.renderManagedTaskHandoff(boundedHandoff), "utf8") <= 96_000);
  assert.equal(boundedHandoff.originalTask, boundedHandoffInput.originalTask);
  assert.deepEqual(boundedHandoff.constraints, boundedHandoffInput.constraints);
  assert.deepEqual(boundedHandoff.policy.allowedPaths, ["src"]);
  assert.deepEqual(boundedHandoff.policy.requiredVerificationCheckIds, ["build", "lint"]);
  assert.deepEqual(boundedHandoff.unresolved, boundedHandoffInput.unresolved);
  assert.deepEqual(boundedHandoff.verification, boundedHandoffInput.verification);
  assert.deepEqual(boundedHandoff.repository.policyViolations, boundedHandoffInput.repositoryPolicyViolations);
  assert.equal(boundedHandoff.repository.diffTruncated, true);
  assert.ok(boundedHandoff.repository.diffOriginalBytes > boundedHandoff.repository.diffRetainedBytes);
  assert.equal(boundedHandoff.repository.diffOmittedFileCount, 4);
  assert.equal(boundedHandoff.contextSelection.omittedCount, 1);
  assert.equal(boundedHandoff.contextSelection.omitted[0]?.path, "src/omitted.ts");

  const local = load("browser/localInterpretation.js");
  const candidates = local.createReadOnlyInterpretationCandidates('Read "src/a.ts"\nSearch for "createRuntime"\nApply patch to src/a.ts');
  assert.deepEqual(candidates.map((candidate) => candidate.kindHint), ["read", "search"]);
  assert.equal(candidates.every((candidate) => Object.keys(candidate.parsedArguments).every((key) => key === "path" || key === "query")), true);

  const resources = load("runtime/providerResourceBroker.js");
  const broker = new resources.ProviderResourceBroker();
  broker.configure("test-resource", 1, 1);
  const firstLease = await broker.acquire("test-resource");
  const queuedLease = broker.acquire("test-resource");
  await assert.rejects(broker.acquire("test-resource"), /queue is full/);
  firstLease.release();
  (await queuedLease).release();
  assert.deepEqual(broker.snapshot("test-resource"), {
    resourceId: "test-resource",
    maxConcurrency: 1,
    maxQueue: 1,
    active: 0,
    queued: 0,
    circuit: "closed",
    failure: undefined,
  });

  const schema = load("pipeline/schema.js");
  const preset = JSON.parse(fs.readFileSync(path.join(root, "presets", "gpt-pair.pipeline.json"), "utf8"));
  const validation = schema.validatePipelineDefinition(preset);
  assert.equal(validation.success, true, validation.success ? "" : validation.errors.join("\n"));
  const invalidLead = structuredClone(preset);
  invalidLead.roles.find((role) => role.id === "lead").readOnly = false;
  assert.equal(schema.validatePipelineDefinition(invalidLead).success, false);
  const configuredManagedCheck = structuredClone(preset);
  configuredManagedCheck.managedPolicy.verificationChecks[0].command = "npm test";
  assert.equal(schema.validatePipelineDefinition(configuredManagedCheck).success, false);
  const invalidManagedCheck = structuredClone(preset);
  invalidManagedCheck.managedPolicy.verificationChecks[0].command = "bachata:unregistered-check";
  assert.equal(schema.validatePipelineDefinition(invalidManagedCheck).success, false);

  console.log("Managed fallback focused checks passed");
} finally {
  await worktreeLock.release();
}
