const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");

const { terminateProcessTree } = require("../dist/process/terminateProcessTree.js");
const { windowsScopeFromChild } = require("../scripts/process-scope.cjs");

const waitForChildExit = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => {
        child.once("close", resolve);
      });

/**
 * `process.platform` is a plain configurable value property, so the win32 branches these tests
 * cover can be driven from a POSIX developer machine instead of being skipped there — which is
 * how every win32 branch in tests/process.test.cjs went unexercised. The descriptor is always
 * restored, and node:test runs the tests in a file one at a time.
 */
const asPlatform = async (platform, operation) => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
};

test("Windows termination reports a tree that already exited as terminated", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await waitForChildExit(child);
  // What every normally completed turn does: the close handler asks for termination after the
  // CLI is gone. taskkill exits non-zero for a pid that names no task, so without the
  // already-exited short-circuit a healthy completion is failed as an unterminated tree.
  const terminated = await asPlatform("win32", () => terminateProcessTree(child, 200));
  assert.equal(terminated, true, "a completed turn was reported as a failed termination");
});

test("the script termination helper reports a tree that already exited as terminated", async () => {
  const { terminateProcessTree: terminateFromScript } = await import(
    "../scripts/terminate-process-tree.mjs"
  );
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await waitForChildExit(child);
  // scripts/terminate-process-tree.mjs is the standalone copy the bounded-command wrappers load,
  // and it must agree with dist/process/terminateProcessTree.js on this: a wrapper whose target
  // finished normally reports a clean stop, not a tree it failed to kill.
  const terminated = await asPlatform("win32", () => terminateFromScript(child, 200));
  assert.equal(terminated, true, "a completed wrapper target was reported as a failed termination");
});

test("a force-killed Windows scope confirms cleanup without status files", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-windows-scope-forced-"));
  const child = new EventEmitter();
  child.pid = 4321;
  let confirmKill;
  const scope = windowsScopeFromChild(
    child,
    {
      temporaryDirectory: directory,
      targetStatusPath: path.join(directory, "target-status.json"),
      jobStatusPath: path.join(directory, "job-status.json"),
    },
    () => new Promise((resolve) => {
      confirmKill = resolve;
    }),
  );
  try {
    const terminated = scope.terminate(1_000);
    // The runner closes before taskkill reports. The close listener runs synchronously inside
    // this emit, which is why a verdict recorded after terminate()'s awaits was never visible
    // to it, and the scope fell back to status files a force-killed runner never wrote.
    child.emit("close", 1, "SIGKILL");
    confirmKill(true);
    const result = await scope.result;
    assert.equal(result.cleanupConfirmed, true, "a confirmed forced kill was reported as unconfirmed cleanup");
    assert.equal(result.terminationRequested, true);
    assert.equal(result.error, undefined);
    assert.equal(await terminated, true, "terminate() and the scope result disagreed");
    assert.equal(fs.existsSync(directory), false, "the scope must remove its temporary directory");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a Windows scope whose forced kill failed still answers from the status files", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-windows-scope-unkilled-"));
  const targetStatusPath = path.join(directory, "target-status.json");
  const jobStatusPath = path.join(directory, "job-status.json");
  fs.writeFileSync(targetStatusPath, JSON.stringify({ exitCode: 3 }), "utf8");
  fs.writeFileSync(jobStatusPath, JSON.stringify({ cleanupConfirmed: false }), "utf8");
  const child = new EventEmitter();
  child.pid = 9_876;
  const scope = windowsScopeFromChild(
    child,
    { temporaryDirectory: directory, targetStatusPath, jobStatusPath },
    () => Promise.resolve(false),
  );
  try {
    const terminated = scope.terminate(1_000);
    child.emit("close", 1, null);
    const result = await scope.result;
    assert.equal(result.cleanupConfirmed, false, "an unconfirmed kill must not be reported as confirmed cleanup");
    assert.equal(result.exitCode, 3);
    assert.equal(await terminated, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
