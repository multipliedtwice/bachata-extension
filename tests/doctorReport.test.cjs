const assert = require("node:assert/strict");
const test = require("node:test");
const { buildProductDoctorReport } = require("../dist/commands/doctorReport.js");

const report = (pipeline) => ({
  selectedPipelineId: pipeline.pipelineId,
  pipelines: [pipeline],
  pipelineNames: {},
  workspaceRoots: ["/work"],
  workingDirectory: "/work",
  trusted: true,
  adapters: [
    { type: "codex-app-server", available: true, detail: "codex 1" },
    { type: "claude-code", available: false, detail: "claude missing" },
  ],
  git: { available: true, detail: "git 2.39", clean: true, statusDetail: "Workspace is clean" },
  bridge: { enabled: true, connected: false, sessions: [] },
});

test("Doctor keeps unavailable optional providers nonblocking", () => {
  const findings = buildProductDoctorReport(report({ pipelineId: "codex-review", status: "ready", findings: [] }));
  assert.equal(findings.find((finding) => finding.name === "Claude Code").blocking, false);
});

test("Doctor makes selected workflow failures blocking", () => {
  const findings = buildProductDoctorReport(report({
    pipelineId: "plan",
    status: "needsSetup",
    findings: [{ id: "adapter.claude", label: "Claude Code", status: "needsSetup", detail: "missing", remediationId: "provider.install.claude" }],
  }));
  assert.equal(findings.find((finding) => finding.name === "Claude Code").blocking, true);
});
