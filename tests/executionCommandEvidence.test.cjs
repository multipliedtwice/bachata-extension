const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const { runProcess } = require("../dist/orchestrator/commandRunner.js");
const { withControllerEvidence } = require("../dist/state/executionEvidence.js");

const options = () => ({ cwd: os.tmpdir(), timeoutMs: 10000, maxOutputBytes: 64 });

test("controller command evidence is captured before bounded operational output", async () => {
  const records = [];
  const text = "ไทย🙂".repeat(100);
  const result = await withControllerEvidence(async (source, content) => records.push({ source, content }), () => runProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)});process.stderr.write('exact stderr')`], options()));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(records.find((record) => record.source === "command stdout").content, text);
  assert.equal(records.find((record) => record.source === "command stderr").content, "exact stderr");
  const legacy = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(200))"], options());
  assert.equal(legacy.stdoutTruncated, true);
});

test("controller evidence persistence failure prevents a successful command from advancing", async () => {
  await assert.rejects(withControllerEvidence(async () => { throw new Error("evidence unavailable"); }, () => runProcess(process.execPath, ["-e", "process.stdout.write('pass')"], options())), /evidence unavailable/);
});
