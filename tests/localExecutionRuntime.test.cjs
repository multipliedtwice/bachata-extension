const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");
const { projectionFromPrompt, proposal, planOperation } = require("./support/executionFixture.cjs");

for (const mode of ["legacy", "localTodoStateV1"]) {
  test(`real local TODO runtime preserves controller gates in ${mode}`, async () => {
    const root = scratchRootSync("bachata-local-todo-runtime-");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "feature.txt"), "before\n");
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "src/feature.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
    const requests = [];
    let harness;
    harness = loadRuntimeHarness({
      purgeCompiledModules: true,
      workspaceDirectories: [root],
      configuration: { executionContextMode: mode, codexWorkspaceScope: "wholeWorkingDirectory" },
      onAdapterSend: ({ agentId, request }) => {
        harness.adapterControls.get(agentId).release.resolve();
        requests.push(request);
        let answer;
        if (mode === "localTodoStateV1") {
          assert.equal(request.sessionMode, "freshExecutionState");
          assert.equal(Object.hasOwn(request, "sessionId"), false);
          assert.ok(Buffer.byteLength(request.prompt) <= 128 * 1024);
          const state = projectionFromPrompt(request.prompt);
          if (state.pending.role === "planner") {
            harness.configuration.set("executionContextMode", "legacy");
            answer = JSON.stringify(proposal(state, "planned", [planOperation()]));
          } else if (state.pending.role === "worker") {
            fs.writeFileSync(path.join(root, "src", "feature.txt"), "ready\n");
            answer = JSON.stringify(proposal(state));
          } else {
            assert.ok(state.checks.every((check) => check.status === "passed" && check.candidate === state.candidate && check.evidence));
            answer = JSON.stringify(proposal(state, "accept", []));
          }
        } else {
          assert.equal(request.sessionMode, undefined);
          if (requests.length === 1) answer = "Legacy plan marker";
          else if (requests.length === 2) {
            assert.ok(request.prompt.includes("Legacy plan marker"));
            fs.writeFileSync(path.join(root, "src", "feature.txt"), "ready\n");
            answer = "Legacy worker marker";
          } else {
            assert.ok(request.prompt.includes("Legacy worker marker"));
            assert.equal(request.sessionId, "seeded-codex-session");
            const candidate = /Candidate: ([a-f0-9]{64})/u.exec(request.prompt)?.[1];
            assert.ok(candidate);
            answer = JSON.stringify({ candidate, review: { verdict: "accept", summary: "Accepted", defects: [] } });
          }
        }
        return { answer, events: [{ type: "session", sessionId: `seeded-${agentId}-session` }] };
      },
    });
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      await harness.runtime.configure({ workingDirectory: root, pipelineId: "todo-implementation" });
      const result = await harness.runtime.runPipeline("Implement src/feature.txt so it contains ready.", [], { allowedPaths: ["src"], writeScope: "configured" });
      assert.equal(result.status, "completed");
      assert.equal(requests.length, 3);
      assert.equal(fs.readFileSync(path.join(root, "src", "feature.txt"), "utf8"), "ready\n");
      assert.ok(harness.transcript.some((entry) => entry.eventType === "verification.controller"));
      if (mode === "legacy") assert.equal(fs.existsSync(path.join(harness.storageDirectory, "execution-evidence")), false);
      else {
        const { localEvidenceForTask } = require("../dist/runtime/localExecutionState.js");
        const evidence = localEvidenceForTask(harness.storageDirectory, harness.runtime.getState().taskId);
        const manifest = await evidence.manifest();
        assert.equal(manifest.records.filter((record) => record.kind === "prompt").length, 3);
        assert.equal(manifest.records.filter((record) => record.kind === "providerLocator").length, 3);
      }
    } finally {
      harness.adapterControls.forEach((control) => control.release.resolve());
      await harness.runtime.dispose();
      harness.cleanup();
      removeScratchSync(root);
    }
  });
}
