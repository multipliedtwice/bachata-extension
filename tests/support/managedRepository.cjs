const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { loadProduction } = require("./productionSource.cjs");
const managedPair = require("../../dist/orchestrator/managedPair.js");
const actions = require("../../dist/browser/actions.js");
const workspaceActions = require("../../dist/browser/workspaceActions.js");
const mutationPolicy = require("../../dist/browser/mutationPolicy.js");
const sourcePolicy = require("../../dist/browser/sourceTransferPolicy.js");
const { sha256FilePath } = require("../../dist/security/fileHash.js");
const { captureSourceBaseline } = require("../../dist/browser/sourceBaseline.js");
const { runProcess } = require("../../dist/orchestrator/commandRunner.js");
const { gitProcessEnvironment } = require("../../dist/process/safeEnvironment.js");
const production = loadProduction("src/browser/managedTurn.ts", [
  "MAX_REPOSITORY_PATH_BYTES", "MAX_REPOSITORY_PATHS", "parseNulPaths", "repositoryCommandOptions", "assertGitResult",
  "collectDirtyRepositoryPaths", "gitIgnoresPath", "sha256File", "fingerprintRepositoryPath", "captureManagedRepositoryBaseline",
  "repositoryState", "refreshManagedWorkspaceFingerprint", "mutationContext", "closeManagedDirectoryListings", "actionSource",
  "isManagedContextAction", "managedActionPayload", "mutationIgnoredTargets", "ignoredMutationTargets", "ignoredTargetMessage",
  "assertMutationTargetsSurfaced", "executeManagedBrowserEnvelope", "classifyManagedToolError", "renderResults",
  "compactContinuationItem", "boundedUtf8", "MAX_CONTINUATION_ITEM_BYTES",
], {
  createHash, lstat: fs.lstat, readlink: fs.readlink, path, sha256FilePath, captureSourceBaseline,
  ...mutationPolicy, ...sourcePolicy, ...actions, ...workspaceActions,
  runProcess, gitProcessEnvironment, computeManagedWorkspaceFingerprint: managedPair.computeManagedWorkspaceFingerprint,
  refreshContextFiles: async () => {},
  BrowserContextReferences: require("../../dist/browser/contextReferences.js").BrowserContextReferences,
  browserControlProtocolPrompt: require("../../dist/browser/controlProtocol.js").browserControlProtocolPrompt,
});
const before = "export const answer = 0;\n";
const after = "export const answer = 42;\n";
const withRepository = async (execute) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-repaired-baseline-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  try {
    git("init");
    git("config", "user.email", "checks@example.invalid");
    git("config", "user.name", "Bachata checks");
    await fs.writeFile(path.join(directory, "answer.ts"), before);
    await fs.writeFile(path.join(directory, ".gitignore"), "ignored.ts\n");
    git("add", "answer.ts", ".gitignore");
    git("commit", "-m", "fixture");
    const signal = new AbortController().signal;
    const baseline = await production.captureManagedRepositoryBaseline(directory, signal);
    const checkpoint = managedPair.createManagedPairCheckpoint({ taskId: "task", originalTask: "Update answer", worktreePath: directory, writeScope: "workspace" });
    const turn = { index: {}, snippets: new Map(), changedFiles: [], preexistingChangedFiles: [], verification: [], repositoryPolicyViolations: [],
      repositoryBaseline: baseline, workspaceSnapshot: baseline, workspaceRevision: 0, taskHash: checkpoint.taskHash };
    const options = { workingDirectory: directory, writeScope: "workspace", allowedPaths: [], protectedPaths: [], commitMode: "never", readOnly: false,
      repositoryBaseline: baseline, signal, continuationMaxBytes: 131072, executor: { timeoutMs: 5000, terminateGraceMs: 100, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 10 } };
    const envelope = { protocol: "bachata-browser-turn-v1", status: "working", actions: [{ kind: "workspace.write", path: "answer.ts", content: after,
      expectedFiles: [{ path: "answer.ts", sha256: createHash("sha256").update(before).digest("hex") }] }], summary: "", objections: [], unresolved: [] };
    return await execute({ directory, git, signal, baseline, checkpoint, turn, options, envelope });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
};
module.exports = { production, managedPair, before, after, withRepository };
