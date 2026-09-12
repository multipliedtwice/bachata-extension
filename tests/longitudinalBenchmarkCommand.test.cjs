const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { mkdtemp, writeFile, readFile, rm, symlink } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const task = require("../benchmarks/longitudinal/tasks/retry-refinement.json");
const command = path.resolve(__dirname, "../scripts/longitudinal-benchmark.mjs");
const execute = promisify(execFile);
const invoke = (args) => execute(process.execPath, [command, ...args], { timeout: 20_000 });
const record = (arm) => ({ taskId: task.id, arm, rounds: task.rounds.map((round) => ({
  index: round.index, kind: round.kind,
  findings: round.index === 1 ? [{ ...task.answerKey.requiredFindings[0], identity: "retry-off-by-one", disposition: "accepted" }] : [],
  decisionsShownToHuman: round.index === 2 ? [task.answerKey.coreDecisions[0].id] : [],
})) });
const fixture = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-longitudinal-command-"));
  try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test("record and score execute against the realistic retry corpus without inventing provider results", async () => fixture(async (root) => {
  const records = {};
  for (const arm of ["single", "paired"]) {
    const input = path.join(root, `${arm}-input.json`);
    const output = path.join(root, `${arm}.json`);
    await writeFile(input, JSON.stringify(record(arm)));
    const result = await invoke(["record", "--task", task.id, "--arm", arm, "--input", input, "--output", output]);
    assert.equal(JSON.parse(result.stdout).status, "recorded");
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), record(arm));
    records[arm] = output;
    await assert.rejects(invoke(["record", "--task", task.id, "--arm", arm, "--input", input, "--output", output]), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), record(arm));
  }
  const result = JSON.parse((await invoke(["score", "--task", task.id, "--single", records.single, "--paired", records.paired])).stdout);
  assert.equal(result.comparison.eligible, true);
  assert.equal(result.scores.single.totals.newSupportedFindings, 1);
  assert.equal(result.scores.paired.totals.falsePositives, 0);
  assert.match(result.basis, /does not run providers or authenticate evidence/);
  const incomplete = JSON.parse((await invoke(["score", "--task", task.id, "--single", records.single])).stdout);
  assert.equal(incomplete.comparison.eligible, false);
  assert.match(incomplete.verdict, /supports no claim/);
}));

for (const [label, mutate] of [
  ["different task", (value) => { value.taskId = "other"; }],
  ["different arm", (value) => { value.arm = "paired"; }],
  ["relabelled round", (value) => { value.rounds[1].kind = "freshReview"; }],
  ["duplicate finding", (value) => { value.rounds[0].findings.push(value.rounds[0].findings[0]); }],
  ["duplicate decision", (value) => { value.rounds[1].decisionsShownToHuman.push(value.rounds[1].decisionsShownToHuman[0]); }],
  ["malformed finding", (value) => { value.rounds[0].findings = [null]; }],
  ["oversized list", (value) => { value.rounds[0].findings = Array(1001).fill(value.rounds[0].findings[0]); }],
  ["empty evidence delta", (value) => { value.rounds[0].findings[0].materialDelta = [""]; }],
]) test(`command refuses ${label} without publishing a record`, async () => fixture(async (root) => {
  const value = record("single"); mutate(value);
  const input = path.join(root, "input.json"); const output = path.join(root, "output.json");
  await writeFile(input, JSON.stringify(value));
  await assert.rejects(invoke(["record", "--task", task.id, "--arm", "single", "--input", input, "--output", output]), /Longitudinal benchmark refused/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
}));

test("command refuses oversized inputs, symlinks and task traversal", async () => fixture(async (root) => {
  const input = path.join(root, "input.json"); const link = path.join(root, "link.json");
  await writeFile(input, " ".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(invoke(["score", "--task", task.id, "--single", input]), /at most 4 MiB/);
  await writeFile(input, JSON.stringify(record("single")));
  await symlink(input, link);
  await assert.rejects(invoke(["score", "--task", task.id, "--single", link]), /refused/);
  await assert.rejects(invoke(["score", "--task", "../retry-refinement"]), /Choose a declared task ID/);
  await assert.rejects(invoke(["score", "--task", task.id, "--task", task.id]), /Usage/);
}));


test("benchmark input refuses directories before reading", async () => fixture(async (root) => {
  await assert.rejects(invoke(["score", "--task", task.id, "--single", root]), /regular JSON file/);
}));

if (process.platform !== "win32") test("benchmark input refuses a named pipe without waiting for a writer", async () => fixture(async (root) => {
  const input = path.join(root, "input.pipe");
  await execute("mkfifo", [input], { timeout: 5000 });
  await assert.rejects(invoke(["score", "--task", task.id, "--single", input]), /regular JSON file/);
}));


test("recorded output obeys its byte ceiling including the terminating newline", async () => fixture(async (root) => {
  const value = { ...record("single"), notes: "" };
  const limit = 4 * 1024 * 1024;
  value.notes = "x".repeat(limit - Buffer.byteLength(JSON.stringify(value)));
  const input = path.join(root, "input.json"); const output = path.join(root, "output.json");
  const serialized = JSON.stringify(value);
  assert.equal(Buffer.byteLength(serialized), limit);
  await writeFile(input, serialized);
  await assert.rejects(invoke(["record", "--task", task.id, "--arm", "single", "--input", input, "--output", output]), /4 MiB ceiling/);
  await assert.rejects(readFile(output), { code: "ENOENT" });
}));

test("recording nested observation metadata cannot amplify a small input into an oversized file", async () => fixture(async (root) => {
  let metadata = Array(20000).fill("retry reproduction observation");
  for (let depth = 0; depth < 200; depth++) metadata = { context: metadata };
  const value = { ...record("single"), metadata };
  const input = path.join(root, "input.json"); const output = path.join(root, "output.json");
  await writeFile(input, JSON.stringify(value));
  await invoke(["record", "--task", task.id, "--arm", "single", "--input", input, "--output", output]);
  const stored = await readFile(output);
  assert.ok(stored.length <= 4 * 1024 * 1024);
  assert.deepEqual(JSON.parse(stored), value);
}));
