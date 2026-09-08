const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const load = (file) => readFile(path.join(root, file), "utf8");

test("human E2E is excluded from automated scripts", async () => {
  const packageJson = JSON.parse(await load("package.json"));
  assert.equal(packageJson.scripts["test:e2e:human"], "node scripts/run-human-e2e.mjs");
  for (const script of ["test", "test:unit", "vscode:prepublish", "package"]) {
    assert.doesNotMatch(packageJson.scripts[script], /e2e/u);
  }
});

test("human E2E runner rejects CI and noninteractive execution", async () => {
  const source = await load("scripts/run-human-e2e.mjs");
  assert.match(source, /process\.env\.CI/u);
  assert.match(source, /process\.stdin\.isTTY/u);
  assert.match(source, /process\.stdout\.isTTY/u);
  assert.match(source, /RUN BACHATA E2E/u);
  assert.match(source, /BACHATA_HUMAN_E2E: "1"/u);
  assert.match(source, /for \(const phase of \["prepare", "recover"\]\)/u);
  assert.match(source, /BACHATA_HUMAN_E2E_PHASE: phase/u);
});


test("human E2E refusal paths execute before build or VS Code launch", () => {
  const script = path.join(root, "scripts", "run-human-e2e.mjs");
  const ci = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(ci.status, 0);
  assert.match(ci.stderr, /refuses to run in CI/u);
  assert.doesNotMatch(ci.stderr, /npm|VS Code CLI was not found/u);

  const noninteractive = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CI: "" },
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(noninteractive.status, 0);
  assert.match(noninteractive.stderr, /requires an interactive terminal/u);
  assert.doesNotMatch(noninteractive.stderr, /npm|VS Code CLI was not found/u);
});

test("human E2E API is unavailable outside the guarded Extension Host", async () => {
  const source = await load("src/extension.ts");
  assert.match(source, /context\.extensionMode === vscode\.ExtensionMode\.Development/u);
  assert.match(source, /process\.env\.BACHATA_HUMAN_E2E === "1"/u);
  assert.match(source, /humanE2e\?: HumanE2eApi/u);
  assert.match(source, /waitForWebviewReady: waitForPipelinePanelReady/u);
  assert.doesNotMatch(source, /handleMessage: activeManager\.handleMessage/u);
  assert.doesNotMatch(source, /createConversation: activeManager\.createConversation/u);
  assert.match(source, /runWebviewScenario: runPipelinePanelUiScenario/u);
  assert.match(source, /runWebviewAction: runPipelinePanelUiAction/u);
  assert.match(source, /flush: activeManager\.flush/u);
});

test("main specification prohibits automated E2E execution", async () => {
  const source = await load("docs/PRODUCT_SPEC.md");
  assert.match(source, /Only a human may start the Extension Host E2E suite/u);
  assert.match(source, /AI assistants, coding agents, CI, prepublish, packaging, scheduled jobs, and automated review systems must never invoke it/u);
});


test("human E2E documentation requires simultaneous-window ownership checks", async () => {
  const documentation = await readFile(path.join(root, "docs", "HUMAN_E2E.md"), "utf8");
  assert.match(documentation, /Required simultaneous-window check/u);
  assert.match(documentation, /authoritative ownership by another Extension Host/u);
  assert.match(documentation, /cancel it in the webview/u);
  assert.match(documentation, /Suspend and resume the machine/u);
});

test("human E2E documentation covers the run contract, evidence, and draft gates", async () => {
  const documentation = await readFile(path.join(root, "docs", "HUMAN_E2E.md"), "utf8");
  for (const marker of [
    "Required run-contract, evidence, and draft checks",
    "run contract above the composer",
    "safety level",
    "confirmation dialog lists repository",
    "refuses with the blocking preflight findings",
    "edited text is restored",
    "which repository the run targets",
    "which provider ruled",
    "Open Source Control",
    "no provider conversation URL path",
    "stopped at its evidence budget",
  ]) {
    assert.equal(documentation.includes(marker), true, `Missing human E2E gate: ${marker}`);
  }
});

test("human E2E covers cold recovery and UI lifecycle controls", async () => {
  const source = await load("e2e/suite/index.cjs");
  assert.match(source, /BACHATA_HUMAN_E2E_PHASE/u);
  assert.match(source, /phaseOnePid/u);
  assert.match(source, /runWebviewScenario/u);
  assert.match(source, /runCreated/u);
  assert.match(source, /pipelineCreated/u);
  assert.doesNotMatch(source, /humanE2e\.createConversation/u);
  assert.doesNotMatch(source, /humanE2e\.handleMessage/u);
  assert.match(source, /runWebviewAction\("selectRun"/u);
  assert.match(source, /runWebviewAction\("resumeWorkflow"/u);
  assert.match(source, /runWebviewAction\("archiveRun"/u);
  assert.match(source, /runWebviewAction\("unarchiveRun"/u);
  assert.match(source, /runWebviewAction\("deleteRun"/u);
  for (const action of [
    "startTodo",
    "stopTodo",
    "resumeTodo",
    "cleanupTodo",
    "abandonTodo",
    "discoverBridge",
    "selectBrowserSession",
    "submitPreparedRun",
  ]) {
    assert.match(source, new RegExp(`runWebviewAction\\("${action}"`, "u"));
  }
  // `bridge.pair` is a protocol wire type shared with the Browser Bridge, not a product name:
  // renaming it here would assert a message that exists on neither side.
  assert.match(source, /type: "bridge\.pair"/u);
  assert.match(source, /type: "provider\.status"/u);
  assert.match(source, /value\.type === "conversation\.send"/u);
  assert.match(source, /requestCodexUserInput/u);
  assert.match(source, /eventTypes\.filter\(\(type\) => type === "run\.started"\)\.length, 1/u);
  assert.match(source, /eventTypes\.includes\("iteration\.resumed"\)/u);
  const webview = await load("src/webview-ui/main.ts");
  assert.match(webview, /humanE2e\.uiRun/u);
  assert.match(webview, /humanE2e\.uiAction/u);
  assert.match(webview, /data-action="create-conversation"/u);
  assert.match(webview, /data-action="editor-mode"\]\[data-mode="json"/u);
  const panel = await load("src/webview/openPipelinePanel.ts");
  assert.match(panel, /isHumanE2eUiAction\(action\)/u);
  assert.match(panel, /browserEndpoint: typeof value\.browserEndpoint === "string"/u);
  assert.match(panel, /pairingToken: typeof value\.pairingToken === "string"/u);
});

test("human E2E Browser origin override is development-only", async () => {
  const source = await load("src/conversations/createConversationManager.ts");
  assert.match(source, /context\.extensionMode === vscode\.ExtensionMode\.Development/u);
  assert.match(source, /process\.env\.BACHATA_HUMAN_E2E === "1"/u);
  assert.match(source, /originOverrideForTests:/u);
});

test("automated verification refuses direct and package-script E2E commands", async () => {
  const source = await load("src/orchestrator/commandRunner.ts");
  assert.match(source, /humanOnlyE2eRefusal/u);
  const policy = await load("src/process/humanOnlyE2e.ts");
  assert.match(policy, /E2E verification is human-only/u);
  assert.match(policy, /cypress/u);
  assert.match(policy, /playwright/u);
  assert.match(policy, /webdriverio/u);
  assert.match(policy, /testcafe/u);
  const managed = await load("src/browser/managedTurn.ts");
  assert.match(managed, /MANAGED_WORKSPACE_INTEGRITY_COMMAND/u);
  assert.match(managed, /MANAGED_PROJECT_CHECKS_COMMAND/u);
  assert.match(managed, /does not execute repository commands or shell wrappers/u);
  const controllerPolicy = await load("src/orchestrator/verificationPolicy.ts");
  assert.match(controllerPolicy, /Autonomous verification accepts only controller-owned/u);
});

test("documentation never recommends automated E2E in Verify Final", async () => {
  for (const file of ["README.md", "docs/ORCHESTRATION.md", "docs/CONCURRENCY.md"]) {
    const source = await load(file);
    assert.doesNotMatch(source, /Verify Final:\s+.*(?:e2e|cypress|playwright)/iu);
  }
});

test("human-only E2E detection refuses runner invocations regardless of path or target syntax", () => {
  const { commandLooksLikeHumanOnlyE2e } = require("../dist/process/humanOnlyE2e.js");
  const refused = [
    "nx run app-e2e:test",
    "npx nx run web-e2e:e2e",
    "pnpm nx run api-e2e:test",
    "./run-e2e.sh",
    "bash scripts/run-e2e.sh",
    "sh ./e2e.sh",
    "node ./node_modules/.bin/cypress.js",
    "npx cypress run",
    "playwright test",
    "yarn wdio run wdio.conf.js",
  ];
  refused.forEach((command) => {
    assert.equal(
      commandLooksLikeHumanOnlyE2e(command),
      true,
      `expected refusal: ${command}`,
    );
  });
  const allowed = [
    "npm run build",
    "tsc --noEmit",
    "npm run lint",
    "pytest tests/",
    "cargo test",
    "echo hello",
  ];
  allowed.forEach((command) => {
    assert.equal(
      commandLooksLikeHumanOnlyE2e(command),
      false,
      `expected allowance: ${command}`,
    );
  });
});


const fsp = require("node:fs/promises");
const os = require("node:os");

const { runVerificationChecks } = require("../dist/orchestrator/commandRunner.js");
const { parseVerifierRegistry } = require("../dist/orchestrator/verifierRegistry.js");
const {
  commandLooksLikeHumanOnlyE2e,
  humanOnlyE2ePlanRefusal,
  planLooksLikeHumanOnlyE2e,
} = require("../dist/process/humanOnlyE2e.js");

const HUMAN_ONLY = /human-only/u;

const e2eDescriptor = (overrides = {}) => ({
  id: "acceptance",
  description: "Repository check",
  executable: "node",
  args: ["--version"],
  workingDirectory: ".",
  environmentAllowlist: ["CI"],
  timeoutMs: 60000,
  maxOutputBytes: 65536,
  expect: { exitCode: 0 },
  ...overrides,
});

const e2eWorkspace = async (files) => {
  const created = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), "bachata-e2e-policy-")),
  );
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(created, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, "utf8");
  }
  return created;
};

const withRegistry = (descriptors) =>
  JSON.stringify({ version: 1, verifiers: descriptors });

const runNamedVerifier = async (root, id = "acceptance") => {
  const results = await runVerificationChecks([`bachata:verifier:${id}`], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    autonomous: true,
    repositoryVerifiers: "humanApproved",
  });
  return results[0];
};

test("a neutral verifier id running a browser E2E runner is refused", async () => {
  for (const args of [["cypress", "run"], ["playwright", "test"], ["wdio", "run"]]) {
    const root = await e2eWorkspace({
      ".bachata/verifiers.json": withRegistry([e2eDescriptor({ executable: "npx", args })]),
    });
    const result = await runNamedVerifier(root);
    assert.equal(result.status, "failed", `expected refusal for npx ${args.join(" ")}`);
    assert.match(result.stderr, HUMAN_ONLY);
  }
});

test("the registry parser refuses an E2E plan behind any id", () => {
  const parsed = parseVerifierRegistry({
    version: 1,
    verifiers: [e2eDescriptor({ id: "acceptance", executable: "npx", args: ["cypress", "run"] })],
  });
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], HUMAN_ONLY);
  const benign = parseVerifierRegistry({ version: 1, verifiers: [e2eDescriptor()] });
  assert.deepEqual(benign.errors, []);
});

test("a package script resolving to E2E is refused through its lifecycle and nesting", async () => {
  const cases = [
    { scripts: { test: "cypress run" }, args: ["test"] },
    { scripts: { pretest: "npm run e2e", test: "node --version", e2e: "cypress run" }, args: ["test"] },
    { scripts: { verify: "npm run inner", inner: "npm run suite", suite: "playwright test" }, args: ["run", "verify"] },
  ];
  for (const { scripts, args } of cases) {
    const root = await e2eWorkspace({
      "package.json": JSON.stringify({ name: "fixture", scripts }),
      ".bachata/verifiers.json": withRegistry([e2eDescriptor({ executable: "npm", args })]),
    });
    const result = await runNamedVerifier(root);
    assert.equal(result.status, "failed", `expected refusal for npm ${args.join(" ")}`);
    assert.match(result.stderr, HUMAN_ONLY);
  }
});

test("a nested workingDirectory resolves that directory's package.json", async () => {
  const nestedIsE2e = await e2eWorkspace({
    "package.json": JSON.stringify({ name: "root", scripts: { test: "node --version" } }),
    "packages/app/package.json": JSON.stringify({ name: "app", scripts: { test: "cypress run" } }),
    ".bachata/verifiers.json": withRegistry([
      e2eDescriptor({ executable: "npm", args: ["test"], workingDirectory: "packages/app" }),
    ]),
  });
  const refused = await runNamedVerifier(nestedIsE2e);
  assert.equal(refused.status, "failed");
  assert.match(refused.stderr, HUMAN_ONLY);

  const rootIsE2e = await e2eWorkspace({
    "package.json": JSON.stringify({ name: "root", scripts: { test: "cypress run" } }),
    "packages/app/package.json": JSON.stringify({ name: "app", scripts: { test: "node --version" } }),
    ".bachata/verifiers.json": withRegistry([
      e2eDescriptor({ executable: "npm", args: ["test"], workingDirectory: "packages/app" }),
    ]),
  });
  const planned = await humanOnlyE2ePlanRefusal({
    executable: "npm",
    args: ["test"],
    cwd: path.join(rootIsE2e, "packages", "app"),
  });
  assert.equal(planned, undefined);
});

test("an unattended run refuses every repository descriptor before a process starts", async () => {
  const root = await e2eWorkspace({
    ".bachata/verifiers.json": withRegistry([e2eDescriptor()]),
  });
  const [refused] = await runVerificationChecks(["bachata:verifier:acceptance"], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    autonomous: true,
  });
  assert.equal(refused.status, "failed");
  assert.match(refused.stderr, /never starts one unattended/u);
  assert.equal(refused.exitCode, undefined, "no process may be started to produce an exit code");
});

test("built-in controller checks stay available to an unattended run", async () => {
  const root = await e2eWorkspace({ "package.json": JSON.stringify({ name: "fixture" }) });
  const results = await runVerificationChecks(["bachata:workspace-integrity"], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    autonomous: true,
  });
  assert.doesNotMatch(results[0].stderr, /never starts one unattended/u);
});

test("a benign repository verifier still runs under human-approved authority", async () => {
  const root = await e2eWorkspace({
    ".bachata/verifiers.json": withRegistry([e2eDescriptor()]),
  });
  const results = await runVerificationChecks(["bachata:verifier:acceptance"], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    autonomous: true,
    repositoryVerifiers: "humanApproved",
  });
  assert.equal(results[0].status, "passed");
  assert.doesNotMatch(results[0].stderr, HUMAN_ONLY);
});

test("plan classification reads the whole argument vector", () => {
  assert.equal(planLooksLikeHumanOnlyE2e("npx", ["cypress", "run"]), true);
  assert.equal(planLooksLikeHumanOnlyE2e("npx", ["playwright", "test"]), true);
  assert.equal(planLooksLikeHumanOnlyE2e("node", ["--test", "tests/unit.test.js"]), false);
  assert.equal(planLooksLikeHumanOnlyE2e("npm", ["test"]), false);
});

test("every named direct E2E form is detected on the command line", () => {
  const refused = [
    "npx cypress run",
    "playwright test",
    "npx @playwright/test test",
    "node ./node_modules/@playwright/test/cli.js test",
    "npx playwright-core test",
    "./run-e2e.sh",
    "yarn wdio run wdio.conf.js",
  ];
  refused.forEach((command) => {
    assert.equal(commandLooksLikeHumanOnlyE2e(command), true, `expected refusal: ${command}`);
  });
  const allowed = ["npm run build", "tsc --noEmit", "cargo test", "node --test tests/unit.test.js"];
  allowed.forEach((command) => {
    assert.equal(commandLooksLikeHumanOnlyE2e(command), false, `expected allowance: ${command}`);
  });
});

test("a manager flag that takes a value does not hide the script name", async () => {
  for (const args of [["--prefix", ".", "run", "verify"], ["--workspace", "pkg", "run", "verify"], ["run", "--workspace=pkg", "verify"]]) {
    const root = await e2eWorkspace({
      "package.json": JSON.stringify({ name: "fixture", scripts: { verify: "cypress run" } }),
    });
    const refusal = await humanOnlyE2ePlanRefusal({ executable: "npm", args, cwd: root });
    assert.notEqual(refusal, undefined, `npm ${args.join(" ")} must resolve its script name`);
    assert.match(refusal, HUMAN_ONLY);
  }
});

// Stated as a known limit rather than left to be discovered as a false claim. Autonomous
// descriptors are refused outright, so this is defense-in-depth coverage, not a hazard.
test("--prefix and --workspace are not followed into another package", async () => {
  const root = await e2eWorkspace({
    "package.json": JSON.stringify({ name: "root", scripts: { verify: "node --version" } }),
    "sub/package.json": JSON.stringify({ name: "sub", scripts: { verify: "cypress run" } }),
  });
  const missed = await humanOnlyE2ePlanRefusal({
    executable: "npm",
    args: ["--prefix", "./sub", "run", "verify"],
    cwd: root,
  });
  assert.equal(
    missed,
    undefined,
    "package scripts resolve against the stated working directory only; --prefix is not followed",
  );
});

test("no surface claims arbitrary code cannot launch E2E", () => {
  const sources = [
    "src/process/humanOnlyE2e.ts",
    "src/orchestrator/verificationPolicy.ts",
    "scripts/lib/policyDocs.mjs",
  ].map((relative) => load(relative));
  return Promise.all(sources).then((texts) => {
    const joined = texts.join("\n");
    assert.doesNotMatch(joined, /E2E remains human-only\./u);
    assert.doesNotMatch(joined, /(?<!not a proof that arbitrary code )cannot (?:launch|start|run) E2E/u);
    assert.match(joined, /can start a browser E2E runner from inside/u);
    assert.match(joined, /not a proof that arbitrary code cannot launch E2E/u);
  });
});
