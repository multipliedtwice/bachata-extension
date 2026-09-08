const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { commandInvocation, nodeProcessEnvironment } = require("../dist/process/commandInvocation.js");
const { checkCommand } = require("../dist/process/checkCommand.js");
const { safeProcessEnvironment } = require("../dist/process/safeEnvironment.js");

const electronHost = (context, version) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { configurable: true, value: version });
  context.after(() => {
    if (descriptor) Object.defineProperty(process.versions, "electron", descriptor);
    else delete process.versions.electron;
  });
};

test("script invocations explicitly enable Node mode only under Electron", (context) => {
  electronHost(context, "40.0.0");
  const environment = Object.freeze({ BACHATA_TEST_ALLOWED: "retained", ELECTRON_RUN_AS_NODE: "0", electron_run_as_node: "0" });
  for (const script of ["provider.js", "provider.cjs", "provider.mjs", "provider.CJS"]) {
    const invocation = commandInvocation(script, ["--version"], environment);
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [script, "--version"]);
    assert.deepEqual(invocation.environment, { BACHATA_TEST_ALLOWED: "retained", ELECTRON_RUN_AS_NODE: "1" });
  }
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "0");
  assert.equal(environment.electron_run_as_node, "0");
});

test("executable invocations keep their supplied environment under Electron", (context) => {
  electronHost(context, "40.0.0");
  const environment = Object.freeze({ BACHATA_TEST_ALLOWED: "retained" });
  const invocation = commandInvocation("provider.exe", ["--version"], environment);
  assert.equal(invocation.command, "provider.exe");
  assert.deepEqual(invocation.args, ["--version"]);
  assert.equal(invocation.environment, environment);
});

test("ordinary Node script invocations leave their environment unchanged", (context) => {
  electronHost(context, undefined);
  const environment = Object.freeze({ BACHATA_TEST_ALLOWED: "retained" });
  assert.equal(commandInvocation("provider.cjs", [], environment).environment, environment);
  assert.equal(nodeProcessEnvironment(environment), environment);
});

test("native script availability runs with a restricted environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-node-mode-"));
  const script = path.join(root, "provider.cjs");
  const previous = process.env.BACHATA_TEST_NODE_MODE_SECRET;
  process.env.BACHATA_TEST_NODE_MODE_SECRET = "fixture-only-secret";
  try {
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ allowed: process.env.BACHATA_TEST_ALLOWED, secret: "BACHATA_TEST_NODE_MODE_SECRET" in process.env, nodeMode: process.env.ELECTRON_RUN_AS_NODE }));\n');
    const environment = safeProcessEnvironment(root, { BACHATA_TEST_ALLOWED: "retained" });
    assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
    const output = await checkCommand(script, [], { environment, timeoutMs: 15_000 });
    assert.deepEqual(JSON.parse(output), {
      allowed: "retained",
      secret: false,
      ...(process.versions.electron ? { nodeMode: "1" } : {}),
    });
    assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (previous === undefined) delete process.env.BACHATA_TEST_NODE_MODE_SECRET;
    else process.env.BACHATA_TEST_NODE_MODE_SECRET = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const provider of ["codex", "claude"]) {
  test(`native ${provider} script adapter completes with a restricted environment`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-native-provider-"));
    const environment = safeProcessEnvironment(root);
    const common = {
      command: path.join(__dirname, "fixtures", `mock-${provider}.cjs`),
      environment,
      turnTimeoutMs: 15_000,
      interruptGraceMs: 500,
      log: () => undefined,
    };
    const adapter = provider === "codex"
      ? require("../dist/adapters/codexAppServer.js").createCodexAppServerAdapter({
        ...common,
        commandCheckTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
        requestApproval: async () => "accept",
      })
      : require("../dist/adapters/claudeCode.js").createClaudeCodeAdapter({
        ...common,
        commandTimeoutMs: 15_000,
      });
    try {
      await adapter.checkAvailability();
      const events = [];
      for await (const event of adapter.send({
        prompt: "native provider fixture",
        workingDirectory: root,
        attachments: [],
        permissionMode: "readOnly",
        approvalPolicy: "onRequest",
      }, new AbortController().signal)) events.push(event);
      const completed = events.find((event) => event.type === "complete");
      assert.equal(completed?.status, "completed");
      assert.match(completed.answer, new RegExp(`mock ${provider} answer`, "u"));
      assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
    } finally {
      await adapter.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
