import { constants } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LONGITUDINAL_ARMS,
  validateLongitudinalTask,
  validateLongitudinalRunRecord,
  scoreLongitudinalRun,
  compareLongitudinalArms,
  longitudinalVerdict,
} from "./lib/longitudinalBenchmark.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxBytes = 4 * 1024 * 1024;
const usage = "Usage: longitudinal-benchmark.mjs record --task ID --arm single|paired --input FILE --output FILE | score --task ID [--single FILE] [--paired FILE]";
const fail = (message) => { throw new Error(message); };

const readJson = async (file) => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) fail("Benchmark input must be a regular JSON file of at most 4 MiB");
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail("Benchmark input changed while it was being read");
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await handle.close(); }
};

const recordErrors = (task, arm, value) => {
  if (!value || typeof value !== "object" || !Array.isArray(value.rounds) || value.rounds.length > 100) {
    return ["record must contain at most 100 rounds"];
  }
  const errors = [];
  for (let index = 0; index < value.rounds.length; index++) {
    const round = value.rounds[index];
    if (!round || typeof round !== "object" || round.kind !== task.rounds[index]?.kind ||
        !Array.isArray(round.findings) || round.findings.length > 1000 ||
        !Array.isArray(round.decisionsShownToHuman) || round.decisionsShownToHuman.length > 1000) {
      errors.push(`round ${index + 1} must match the task kind and contain bounded findings and decisions`);
      continue;
    }
    const seen = new Set();
    for (const finding of round.findings) {
      if (!finding || typeof finding !== "object" ||
          ![finding.id, finding.file, finding.identity].every((text) => typeof text === "string" && text.length > 0 && text.length <= 1024) ||
          (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) ||
          (finding.materialDelta !== undefined && (!Array.isArray(finding.materialDelta) ||
            finding.materialDelta.length > 100 || !finding.materialDelta.every((item) => typeof item === "string" && item.length <= 8192 && item.trim().length > 0)))) {
        errors.push(`round ${index + 1} contains a malformed finding`);
        continue;
      }
      if (seen.has(finding.identity)) errors.push(`round ${index + 1} repeats a finding identity`);
      seen.add(finding.identity);
    }
    if (!round.decisionsShownToHuman.every((id) => typeof id === "string" && id.length > 0 && id.length <= 1024) ||
        new Set(round.decisionsShownToHuman).size !== round.decisionsShownToHuman.length) {
      errors.push(`round ${index + 1} contains malformed or duplicate decisions`);
    }
  }
  return errors.length ? errors : validateLongitudinalRunRecord(task, arm, value);
};

const writeExclusive = async (file, value) => {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) fail("Recorded observation exceeds the 4 MiB ceiling");
  const destination = path.resolve(file);
  const temporary = path.join(path.dirname(destination), `.longitudinal-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporary, destination);
  } finally {
    await handle.close();
    await unlink(temporary);
  }
};

const main = async () => {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "record" && command !== "score") fail(usage);
  const allowed = new Set(command === "record" ? ["--task", "--arm", "--input", "--output"] : ["--task", "--single", "--paired"]);
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(key) || options.has(key) || !value || value.startsWith("--")) fail(usage);
    options.set(key, value);
  }
  const taskId = options.get("--task");
  if (!taskId || taskId.length > 80 || !/^[a-z][a-z0-9-]*$/.test(taskId)) fail("Choose a declared task ID");
  const task = await readJson(path.join(root, "benchmarks", "longitudinal", "tasks", `${taskId}.json`));
  const designErrors = validateLongitudinalTask(task);
  if (designErrors.length) fail(designErrors.join("; "));
  const loadRecord = async (arm, file) => {
    const value = await readJson(file);
    const errors = recordErrors(task, arm, value);
    if (errors.length) fail(errors.join("; "));
    return value;
  };
  if (command === "record") {
    const arm = options.get("--arm");
    if (!LONGITUDINAL_ARMS.includes(arm) || !options.get("--input") || !options.get("--output")) fail(usage);
    const value = await loadRecord(arm, options.get("--input"));
    await writeExclusive(options.get("--output"), value);
    process.stdout.write(`${JSON.stringify({ status: "recorded", taskId, arm, rounds: value.rounds.length })}\n`);
    return;
  }
  const scores = {};
  for (const arm of LONGITUDINAL_ARMS) {
    const file = options.get(`--${arm}`);
    if (file) scores[arm] = scoreLongitudinalRun(task, await loadRecord(arm, file));
  }
  const comparison = compareLongitudinalArms(scores.single, scores.paired);
  process.stdout.write(`${JSON.stringify({
    taskId, basis: "Supplied recorded observations; this command does not run providers or authenticate evidence.",
    scores, comparison, verdict: longitudinalVerdict([comparison]),
  }, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Longitudinal benchmark refused: ${error.message}\n`);
  process.exitCode = 1;
});
