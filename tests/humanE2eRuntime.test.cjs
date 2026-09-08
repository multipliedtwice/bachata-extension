const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runVerificationChecks } = require("../dist/orchestrator/commandRunner.js");
const { commandLooksLikeHumanOnlyE2e } = require("../dist/process/humanOnlyE2e.js");

const run = (commands, cwd) => runVerificationChecks(commands, {
  cwd,
  timeoutMs: 5000,
  maxOutputBytes: 65536,
});

test("automated checks reject direct E2E commands without spawning them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-e2e-direct-"));
  try {
    const marker = path.join(root, "marker");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)} e2e`;
    const results = await run([command], root);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].stderr, /E2E verification is human-only/u);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("automated checks resolve package scripts and reject hidden E2E runners", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-e2e-package-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        verify: "npm run browser-check",
        "browser-check": "playwright test",
      },
    }));
    const results = await run(["npm run verify"], root);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].stderr, /resolves to E2E/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package lifecycle hooks cannot hide E2E verification", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-e2e-lifecycle-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        preverify: "playwright test",
        verify: "node -e \"process.exit(0)\"",
      },
    }));
    const results = await run(["npm run verify"], root);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].stderr, /E2E verification is human-only/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package runner flags and direct yarn-style scripts cannot bypass E2E refusal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-e2e-runner-flags-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { verify: "playwright test" },
    }));
    for (const command of ["npm run --silent verify", "npm --silent run verify", "yarn verify"]) {
      const results = await run([command], root);
      assert.equal(results[0].status, "failed");
      assert.match(results[0].stderr, /E2E verification is human-only/u);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hyphenated and path-qualified E2E wrappers are refused without spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-e2e-wrapper-names-"));
  try {
    for (const command of [
      "./run-e2e.sh",
      "bash scripts/run-e2e.sh",
      "sh run-e2e.sh",
      "./scripts/e2e-local.sh",
      "node node_modules/.bin/cypress.js",
      "node_modules/.bin/playwright test",
    ]) {
      assert.equal(commandLooksLikeHumanOnlyE2e(command), true, command);
    }
    const marker = path.join(root, "marker");
    const results = await run(["./run-e2e.sh"], root);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].stderr, /E2E verification is human-only/u);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary build and test commands are not mistaken for E2E", () => {
  for (const command of [
    "npm run build",
    "npm test",
    "node scripts/check.js",
    "make all",
    "git status",
    "npx tsc --noEmit",
  ]) {
    assert.equal(commandLooksLikeHumanOnlyE2e(command), false, command);
  }
});
