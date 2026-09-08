const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const load = () => import(`file://${path.join(root, "scripts", "lib", "localValidation.mjs")}`);

const { parseTodoDocument } = require("../dist/orchestrator/todoParser.js");
const { parseVerifierRegistry } = require("../dist/orchestrator/verifierRegistry.js");
const { isDeclarableVerificationCommand } = require("../dist/orchestrator/verificationPolicy.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const { buildExecutionContract } = require("../dist/contract/executionContract.js");
const { parseExportPolicy } = require("../dist/export/exportPolicy.js");

const todoDefaults = {
  pipelineId: "todo-implementation",
  retries: 0,
  requirePaths: true,
  requireControllerVerification: true,
};

test("a malformed TODO file is reported, never silently accepted", async () => {
  const { validateTodo } = await load();
  const good = validateTodo({
    path: "TODO.md",
    source: "- [ ] [API-1] Fix cancellation\n  - Paths: src/api\n  - Verify: bachata:project-checks\n",
    parseTodoDocument,
    defaults: todoDefaults,
  });
  assert.deepEqual(good, []);

  const bad = validateTodo({
    path: "TODO.md",
    source: "- [ ] [API-1] Fix cancellation\n  - Verify: bachata:project-checks\n",
    parseTodoDocument,
    defaults: todoDefaults,
  });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].target, "todo");
});

test("an unreadable verifier registry and export policy are reported", async () => {
  const { validateVerifiers, validateExportPolicy } = await load();
  assert.deepEqual(validateVerifiers({ path: "v", source: undefined, parseVerifierRegistry }), []);
  assert.match(
    validateVerifiers({ path: "v", source: "{ broken", parseVerifierRegistry })[0].message,
    /not valid JSON/u,
  );
  assert.ok(
    validateVerifiers({
      path: "v",
      source: JSON.stringify({ version: 1, verifiers: [{ id: "BAD ID" }] }),
      parseVerifierRegistry,
    }).length > 0,
  );
  assert.ok(
    validateExportPolicy({
      path: "p",
      source: JSON.stringify({ version: 2 }),
      parseExportPolicy,
    }).length > 0,
  );
});

test("every shipped preset validates and resolves a coherent contract", async () => {
  const { validatePipeline, validateContract } = await load();
  const directory = path.join(root, "presets");
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(".pipeline.json"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const filePath = path.join(directory, name);
    const source = fs.readFileSync(filePath, "utf8");
    assert.deepEqual(validatePipeline({ path: filePath, source, validatePipelineDefinition }), [], name);
    assert.deepEqual(
      validateContract({
        pipeline: JSON.parse(source),
        filePath,
        buildExecutionContract,
        isDeclarableVerificationCommand,
        workingDirectory: root,
      }),
      [],
      name,
    );
  }
});

test("a contract that grants commits without verification is refused", async () => {
  const { validateContract } = await load();
  const findings = validateContract({
    pipeline: {
      version: 1,
      id: "loose",
      name: "Loose",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      roles: [{ id: "worker", name: "Worker", instructions: "", commitMode: "allow" }],
      steps: [{
        id: "run", name: "Run", enabled: true, humanGate: "none", type: "agent",
        participants: ["worker"], promptTemplate: "x", parallel: false, consensus: false,
      }],
      managedPolicy: { commitMode: "allow", writeScope: "configured" },
    },
    filePath: "loose.pipeline.json",
    buildExecutionContract,
    isDeclarableVerificationCommand,
  });
  const messages = findings.map((item) => item.message);
  assert.ok(messages.some((message) => message.includes("commit authority with no controller verification")));
  assert.ok(messages.some((message) => message.includes("no writable paths")));
});

test("findings render as one deterministic report", async () => {
  const { formatFindings } = await load();
  assert.equal(formatFindings([]), "Local Bachata configuration is valid.");
  assert.match(
    formatFindings([{ target: "todo", file: "TODO.md", message: "broken" }]),
    /1 finding\(s\):\n- \[todo\] TODO\.md: broken/u,
  );
});

test("the headless validator is exposed as an npm script", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["validate:local"], "node scripts/validate-local.mjs");
  assert.equal(fs.existsSync(path.join(root, "scripts", "validate-local.mjs")), true);
});

const os = require("node:os");

const runnerModule = path.join(root, "scripts", "lib", "localValidationRun.mjs");
const loadRunner = () => import(`file://${runnerModule}`);

const failingWith = (code) => {
  const error = new Error(`${code}: injected filesystem failure`);
  error.code = code;
  return error;
};

// The gate is driven through injected filesystem failures rather than file modes, so the
// same proof runs on every platform: Windows has no chmod that reproduces EACCES here.
const runnerFixture = () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-runner-"));
  fs.mkdirSync(path.join(target, ".bachata", "pipelines"), { recursive: true });
  fs.writeFileSync(path.join(target, ".bachata", "verifiers.json"), "{ this is not valid json", "utf8");
  const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-runner-lock-"));
  return {
    target,
    lockPath: path.join(lockDirectory, ".bachata-worktree.lock"),
    cleanup: () => {
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    },
  };
};

test("a configuration file that cannot be read is reported, never passed as valid", async () => {
  const { runLocalValidation } = await loadRunner();
  const { target, lockPath, cleanup } = runnerFixture();
  const verifiers = path.join(target, ".bachata", "verifiers.json");
  try {
    const readable = await runLocalValidation({ target, lockPath, log: () => undefined });
    assert.ok(
      readable.some((item) => item.target === "verifiers" && /not valid JSON/u.test(item.message)),
      "the control run must report the invalid registry it can read",
    );

    const findings = await runLocalValidation({
      target,
      lockPath,
      log: () => undefined,
      filesystem: {
        readFile: async (candidate, encoding) => {
          if (path.resolve(candidate) === verifiers) throw failingWith("EACCES");
          return fs.promises.readFile(candidate, encoding);
        },
      },
    });
    const unreadable = findings.filter((item) => item.file === verifiers);
    assert.equal(unreadable.length, 1, "an unreadable registry must produce exactly one finding");
    assert.equal(unreadable[0].target, "verifiers");
    assert.match(unreadable[0].message, /could not be read, so it was not validated/u);
    assert.match(unreadable[0].message, /EACCES/u);
  } finally {
    cleanup();
  }
});

test("a pipeline directory that cannot be enumerated is reported, never skipped in silence", async () => {
  const { runLocalValidation } = await loadRunner();
  const { target, lockPath, cleanup } = runnerFixture();
  const pipelines = path.join(target, ".bachata", "pipelines");
  try {
    const findings = await runLocalValidation({
      target,
      lockPath,
      log: () => undefined,
      filesystem: {
        readdir: async (candidate, options) => {
          if (path.resolve(candidate) === pipelines) throw failingWith("EACCES");
          return fs.promises.readdir(candidate, options);
        },
      },
    });
    const refused = findings.filter((item) => item.file === pipelines);
    assert.equal(refused.length, 1, "an unreadable pipeline directory must produce exactly one finding");
    assert.equal(refused[0].target, "pipelines");
    assert.match(refused[0].message, /could not be enumerated, so its pipelines were not validated/u);
    assert.match(refused[0].message, /EACCES/u);
  } finally {
    cleanup();
  }
});

test("an absent optional file is still nothing to validate", async () => {
  const { runLocalValidation } = await loadRunner();
  const { target, lockPath, cleanup } = runnerFixture();
  try {
    const findings = await runLocalValidation({
      target,
      lockPath,
      log: () => undefined,
      filesystem: {
        readFile: async (candidate, encoding) => {
          if (path.basename(candidate) === "verifiers.json") throw failingWith("ENOENT");
          return fs.promises.readFile(candidate, encoding);
        },
      },
    });
    assert.equal(
      findings.some((item) => item.file === path.join(target, ".bachata", "verifiers.json")),
      false,
      "ENOENT must stay 'nothing to validate', or every clean repository would fail",
    );
  } finally {
    cleanup();
  }
});

test("an unbuilt tree earns one instruction, not a module-resolution stack", async () => {
  const { runLocalValidation } = await import(
    `file://${path.join(root, "scripts", "lib", "localValidationRun.mjs")}`
  );
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-unbuilt-")));
  const lockPath = path.join(target, ".bachata-worktree.lock");
  try {
    const failure = await runLocalValidation({ target, root: target, lockPath }).then(
      () => undefined,
      (error) => error,
    );
    assert.ok(failure, "an unbuilt tree validated successfully");
    assert.equal(failure.code, "BACHATA_TREE_NOT_BUILT");
    assert.equal(failure.message, "This tree is not built yet. Run: npm run build");
    assert.doesNotMatch(failure.message, /ERR_MODULE_NOT_FOUND|\bat \//u);
    assert.equal(fs.existsSync(lockPath), false, "the refusal left its worktree lock behind");
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("the local validation gate deduplicates JSON parsing through one validator", async () => {
  const { validateJsonDocument } = await load();
  assert.deepEqual(
    validateJsonDocument({ target: "verifiers", path: "a.json", source: "{ nope", parse: () => [] }),
    [{
      target: "verifiers",
      file: "a.json",
      message: "is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)",
    }],
  );
  assert.deepEqual(
    validateJsonDocument({ target: "verifiers", path: "a.json", source: undefined, parse: () => [] }),
    [],
  );
  assert.deepEqual(
    validateJsonDocument({ target: "pipelines", path: "a.json", source: undefined, parse: () => [], required: true }),
    [{ target: "pipelines", file: "a.json", message: "is missing" }],
  );
  assert.deepEqual(
    validateJsonDocument({ target: "exportPolicy", path: "a.json", source: "{}", parse: () => ["bad"] }),
    [{ target: "exportPolicy", file: "a.json", message: "bad" }],
  );
});

test("the repository policy is read once, so validation and contracts cannot disagree", async () => {
  const { runLocalValidation } = await loadRunner();
  const { target, lockPath, cleanup } = runnerFixture();
  const policyPath = path.resolve(path.join(target, ".bachata", "policy.json"));
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ version: 1, approvedPipelineIds: ["codex-review"] }),
    "utf8",
  );
  try {
    let policyReads = 0;
    await runLocalValidation({
      target,
      lockPath,
      log: () => undefined,
      filesystem: {
        readFile: async (candidate, encoding) => {
          if (path.resolve(candidate) === policyPath) policyReads += 1;
          return fs.promises.readFile(candidate, encoding);
        },
      },
    });
    assert.equal(
      policyReads,
      1,
      "the policy was read more than once, so contracts can be built from a document that was never validated",
    );
  } finally {
    cleanup();
  }
});

test("an unreadable repository policy is reported once and never bypasses the injected filesystem", async () => {
  const { runLocalValidation } = await loadRunner();
  const { target, lockPath, cleanup } = runnerFixture();
  const policyPath = path.resolve(path.join(target, ".bachata", "policy.json"));
  fs.writeFileSync(policyPath, JSON.stringify({ version: 1 }), "utf8");
  try {
    const findings = await runLocalValidation({
      target,
      lockPath,
      log: () => undefined,
      filesystem: {
        readFile: async (candidate, encoding) => {
          if (path.resolve(candidate) === policyPath) throw failingWith("EACCES");
          return fs.promises.readFile(candidate, encoding);
        },
      },
    });
    const policyFindings = findings.filter((item) => path.resolve(item.file) === policyPath);
    assert.equal(
      policyFindings.length,
      1,
      "an unreadable policy produced a count other than one finding, so a second read reached the real disk",
    );
    assert.match(policyFindings[0].message, /could not be read, so it was not validated/u);
  } finally {
    cleanup();
  }
});

test("a dependency missing from inside a built tree is not relabelled as an unbuilt tree", async () => {
  const { runLocalValidation } = await import(
    `file://${path.join(root, "scripts", "lib", "localValidationRun.mjs")}`
  );
  const fakeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-halfbuilt-")));
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-halfbuilt-target-")));
  const moduleDirectory = path.join(fakeRoot, "dist", "orchestrator");
  fs.mkdirSync(moduleDirectory, { recursive: true });
  // The module this gate asks for exists; what it imports does not.
  fs.writeFileSync(
    path.join(moduleDirectory, "todoParser.js"),
    'export * from "./a-dependency-that-was-never-built.js";\n',
    "utf8",
  );
  try {
    const failure = await runLocalValidation({
      target,
      root: fakeRoot,
      lockPath: path.join(target, ".bachata-worktree.lock"),
      log: () => undefined,
    }).then(() => undefined, (error) => error);
    assert.ok(failure, "a half-built tree validated successfully");
    assert.notEqual(
      failure.code,
      "BACHATA_TREE_NOT_BUILT",
      "a missing dependency inside an existing build was diagnosed as an unbuilt tree",
    );
    assert.equal(failure.code, "ERR_MODULE_NOT_FOUND");
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
