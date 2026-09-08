const assert = require("node:assert/strict");
const test = require("node:test");

const { remediationPlan } = require("../dist/readiness/remediation.js");
const { documentationUrls, verifiedDocumentationUrl } = require("../dist/readiness/providerDocs.js");

const context = { codexCommand: "codex", claudeCommand: "claude" };

test("every remediation states the blocking condition, numbered steps, and a recheck", () => {
  const ids = [
    "provider.install.codex",
    "provider.install.claude",
    "git.install",
    "doctor.run",
    "workspace.open",
    "workspace.trust",
    "bridge.useLocalWindow",
    "bridge.connect",
    "bridge.selectSession",
    "pipeline.select",
    "pipeline.chooseSupported",
  ];
  ids.forEach((id) => {
    const plan = remediationPlan(id, context);
    assert.equal(plan.id, id);
    assert.ok(plan.title.length > 0, `${id} has no title`);
    assert.ok(plan.condition.length > 0, `${id} has no blocking condition`);
    assert.ok(plan.steps.length > 0, `${id} has no steps`);
    assert.ok(plan.recheck.kind.length > 0, `${id} has no recheck`);
    if (id !== "bridge.useLocalWindow" && id !== "workspace.open" && id !== "workspace.trust") {
      assert.ok(plan.actions.length > 0, `${id} offers no direct action`);
    }
  });
});

test("provider remediation names the exact failure, the probe, and the override setting", () => {
  const plan = remediationPlan("provider.install.codex", {
    ...context,
    codexCommand: "/opt/bin/codex",
    detail: "codex unavailable: spawn codex ENOENT",
  });
  assert.equal(plan.condition, "codex unavailable: spawn codex ENOENT");
  assert.ok(plan.steps.some((step) => step.includes("/opt/bin/codex --version")));
  assert.ok(plan.steps.some((step) => step.includes("bachata.codexCommand")));
  assert.deepEqual(plan.recheck, { kind: "provider", provider: "codex", label: "Recheck Codex" });
  const terminal = plan.actions.find((action) => action.kind === "runInTerminal");
  assert.deepEqual(terminal, {
    kind: "runInTerminal",
    label: "Run /opt/bin/codex --version",
    command: "/opt/bin/codex",
    args: ["--version"],
  });
  assert.ok(plan.actions.some((action) => action.kind === "openSettings" && action.setting === "bachata.codexCommand"));
  assert.ok(plan.actions.some((action) => action.kind === "openDocument" && action.document === "docs/PROVIDERS.md"));
});

test("claude remediation uses its own command and setting", () => {
  const plan = remediationPlan("provider.install.claude", { ...context, claudeCommand: "claude" });
  assert.match(plan.title, /Claude Code/u);
  assert.ok(plan.steps.some((step) => step.includes("bachata.claudeCommand")));
  assert.deepEqual(plan.recheck, { kind: "provider", provider: "claude", label: "Recheck Claude Code" });
});

test("git remediation names the minimum version and rechecks only git", () => {
  const plan = remediationPlan("git.install", context);
  assert.ok(plan.steps.some((step) => step.includes("2.32")));
  assert.equal(plan.recheck.kind, "git");
  assert.ok(plan.actions.some((action) => action.kind === "openExternal" && action.url === documentationUrls.git));
});

test("a dirty workspace remediation opens Source Control and rechecks the status only", () => {
  const plan = remediationPlan("doctor.run", { ...context, detail: "Workspace has uncommitted changes" });
  assert.equal(plan.condition, "Workspace has uncommitted changes");
  assert.deepEqual(plan.actions, [
    { kind: "runCommand", label: "Open Source Control", command: "workbench.view.scm" },
  ]);
  assert.equal(plan.recheck.kind, "gitStatus");
});

test("verified provider docs are offered as the plan's external action; the bridge placeholder is withheld", () => {
  // Codex and Claude now resolve to their verified official docs, so each provider remediation
  // offers exactly that URL as its "Open ... documentation" action.
  assert.equal(verifiedDocumentationUrl("codex"), "https://developers.openai.com/codex/cli/");
  assert.equal(verifiedDocumentationUrl("claude"), "https://code.claude.com/docs/en/overview");

  const codex = remediationPlan("provider.install.codex", context);
  const codexDoc = codex.actions.find((action) => action.kind === "openExternal");
  assert.deepEqual(codexDoc, {
    kind: "openExternal",
    label: "Open Codex documentation",
    url: "https://developers.openai.com/codex/cli/",
  });

  const claude = remediationPlan("provider.install.claude", context);
  const claudeDoc = claude.actions.find((action) => action.kind === "openExternal");
  assert.deepEqual(claudeDoc, {
    kind: "openExternal",
    label: "Open Claude Code documentation",
    url: "https://code.claude.com/docs/en/overview",
  });

  // The bridge public URL is still a placeholder the owner has not supplied, so the bridge.connect
  // remediation offers its install guide document but no external download link.
  assert.equal(verifiedDocumentationUrl("bridge"), undefined);
  const bridge = remediationPlan("bridge.connect", context);
  assert.deepEqual(bridge.actions.filter((action) => action.kind === "openExternal"), []);
  assert.ok(bridge.actions.some((action) => action.kind === "openDocument" && action.document === "docs/BROWSER_BRIDGE_INSTALL.md"));
});

test("a remote extension host explains why browser providers are unavailable", () => {
  const plan = remediationPlan("bridge.useLocalWindow", { ...context, remoteName: "ssh-remote" });
  assert.match(plan.condition, /ssh-remote/u);
  assert.equal(plan.recheck.kind, "none");
});

test("an unknown remediation id degrades to settings without inventing steps", () => {
  const plan = remediationPlan("unknown.id", context);
  assert.equal(plan.id, "unknown.id");
  assert.deepEqual(plan.actions, []);
});
