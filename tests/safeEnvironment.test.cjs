const assert = require("node:assert/strict");
const test = require("node:test");

const {
  configuredProcessEnvironment,
  providerProcessEnvironment,
  safeProcessEnvironment,
} = require("../dist/process/safeEnvironment.js");

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
