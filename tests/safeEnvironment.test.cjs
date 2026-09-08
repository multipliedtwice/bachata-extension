const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  configuredProcessEnvironment,
  gitProcessEnvironment,
  providerProcessEnvironment,
  safeProcessEnvironment,
} = require("../dist/process/safeEnvironment.js");

test("Git environments remove workspace PATH entries without restoring inherited search paths", () => {
  const workspace = path.resolve("workspace");
  const trusted = path.resolve("trusted-tools");
  const base = { PATH: [workspace, path.join(workspace, "bin"), ".", "", trusted].join(path.delimiter) };
  if (process.platform === "win32") base.Path = workspace;
  const environment = gitProcessEnvironment(workspace, base);
  assert.equal(environment.PATH, trusted);
  assert.equal(environment.Path, undefined);
  assert.equal(base.PATH.includes(workspace), true, "caller environment must remain unchanged");
  const emptySearchPath = process.platform === "win32" ? "" : undefined;
  assert.equal(gitProcessEnvironment(workspace, { PATH: workspace }).PATH, emptySearchPath);
  assert.equal(gitProcessEnvironment(workspace, {}).PATH, emptySearchPath);
  assert.equal(gitProcessEnvironment(workspace, { PATH: ` ${trusted}` }).PATH, emptySearchPath);
  if (process.platform === "win32") {
    assert.equal(gitProcessEnvironment(workspace, { Path: `"${trusted}"` }).PATH, `"${trusted}"`);
    assert.equal(gitProcessEnvironment(workspace, { Path: `"${workspace}"` }).PATH, "");
  }
});

const withEnvironment = async (values, operation) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("safe process environments exclude arbitrary Extension Host secrets", async () => {
  await withEnvironment({
    BACHATA_UNRELATED_SECRET: "secret",
    BACHATA_ALLOWED_PROVIDER: "provider",
    BACHATA_ALLOWED_CHECK: "check",
  }, async () => {
    const base = safeProcessEnvironment("/workspace");
    assert.equal(base.PWD, "/workspace");
    assert.equal(base.BACHATA_UNRELATED_SECRET, undefined);

    const provider = providerProcessEnvironment("/workspace", ["BACHATA_ALLOWED_PROVIDER"]);
    assert.equal(provider.BACHATA_ALLOWED_PROVIDER, "provider");
    assert.equal(provider.BACHATA_ALLOWED_CHECK, undefined);
    assert.equal(provider.BACHATA_UNRELATED_SECRET, undefined);

    const check = configuredProcessEnvironment("/workspace", ["BACHATA_ALLOWED_CHECK"]);
    assert.equal(check.BACHATA_ALLOWED_CHECK, "check");
    assert.equal(check.BACHATA_ALLOWED_PROVIDER, undefined);
    assert.equal(check.BACHATA_UNRELATED_SECRET, undefined);
  });
});
