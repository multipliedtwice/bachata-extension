const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { renderContractExplanation } = require("../dist/contract/explain.js");
const { buildExecutionContract } = require("../dist/contract/executionContract.js");

const root = path.join(__dirname, "..");
const preset = (name) => JSON.parse(fs.readFileSync(path.join(root, "presets", `${name}.pipeline.json`), "utf8"));

test("the explanation resolves authority without creating a run", () => {
  const contract = buildExecutionContract({ pipeline: preset("managed-fix"), maxIterations: 10 });
  const text = renderContractExplanation(contract);
  assert.match(text, /This is a dry run\. Nothing was started and no run was created\./u);
  for (const heading of [
    "## Providers and roles",
    "## Effective role authority",
    "## Aggregate scope",
    "## Verification",
    "## Human decisions",
    "## Fallback",
    "## Run limits",
    "## Completion",
    "## What each provider receives",
    "## Repository policy",
    "## Unresolved before running",
  ]) {
    assert.ok(text.includes(heading), `missing ${heading}`);
  }
  assert.match(text, /Worker · managed · writes configured working directory · writable src, tests/u);
  assert.match(text, /fallback order codex → claude/u);
  assert.match(text, /Commits: no commits are created/u);
});

test("a read-only pipeline explains as read-only with no verification", () => {
  const text = renderContractExplanation(
    buildExecutionContract({ pipeline: preset("codex-review"), maxIterations: 10 }),
  );
  assert.match(text, /Safety level: \*\*review\*\*/u);
  assert.match(text, /Write scope: no repository writes/u);
  assert.match(text, /_No controller verification runs\._/u);
  assert.match(text, /_No human gate interrupts this run\._/u);
});

test("policy refusals are explained, not hidden", () => {
  const text = renderContractExplanation(buildExecutionContract({
    pipeline: preset("managed-fix"),
    maxIterations: 10,
    repositoryPolicy: { version: 1, maxWriteScope: "task" },
  }));
  assert.match(text, /caps the write scope at task/u);
});

test("every shipped preset renders an explanation", () => {
  const directory = path.join(root, "presets");
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith(".pipeline.json"))) {
    const contract = buildExecutionContract({
      pipeline: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
      maxIterations: 10,
    });
    assert.match(renderContractExplanation(contract), /^# /u, name);
  }
});
