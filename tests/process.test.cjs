const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { checkCommand } = require("../dist/process/checkCommand.js");
const { terminateProcessTree } = require("../dist/process/terminateProcessTree.js");

/**
 * These tests spawn `scripts/run-bounded-command.mjs`, and that wrapper takes this worktree's
 * lock. One of them then SIGTERMs the wrapper on purpose, which by design leaves the lock behind:
 * "a dead wrapper is no proof that they stopped" is the whole doctrine, and recovery is a manual
 * token-checked unlock. So this FILE, run on its own, stranded the real lock at its third test and
 * every later bounded test in it then waited the full ten-second acquisition budget and failed —
 * as did every build, test and coverage run in the worktree afterwards, until a human unlocked it.
 *
 * That is why it looked like a load-dependent timeout and was not one: under
 * `scripts/run-test-files.mjs` the lane already owns the lock and passes its token down, so the
 * wrappers are re-entrant and never touch it. Owning the lock here gives the file the same footing
 * on its own. `acquireWorktreeLock` publishes the token into this process's environment, which
 * every spawned wrapper inherits, and returns a no-op release when the lane already owns it.
 */
let worktreeLock;
test.before(async () => {
  const { acquireWorktreeLock } = await import("../scripts/lib/worktreeLock.mjs");
  worktreeLock = await acquireWorktreeLock({ label: "process tests" });
});
test.after(async () => {
  await worktreeLock?.release();
});


const waitForProcessNotRunning = async (pid) => {
  const fs = require("node:fs");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        try {
          const status = fs.readFileSync(`/proc/${String(pid)}/status`, "utf8");
          if (/^State:\s+Z/mu.test(status)) {
            return;
          }
        } catch (error) {
          if (error?.code === "ENOENT") {
            return;
          }
        }
      }
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${String(pid)} is still running`);
};

const waitForChildExit = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });

/**
 * Stop a spawned wrapper the test is finished with, on EVERY path out of the test.
 *
 * WHY THIS IS NOT TIDINESS. `scripts/run-bounded-command.mjs` takes the worktree lock. These
 * tests spawned one and cleaned up only the temporary directory, so any assertion or fixture wait
 * that threw left a live lock-holding process behind for the rest of its timeout — sixty seconds
 * in one case — and a stale lock file after it. Every later build, test or coverage run in this
 * worktree then refused to start, and recovery is a manual token-checked unlock. The first failure
 * therefore poisoned the worktree instead of failing alone, which is also why running this file on
 * its own looked like a load-dependent timeout: the second run was waiting on a lock the first run
 * had abandoned.
 *
 * The wrapper is not detached, so it shares the test runner's process group and the
 * `process.kill(-pid)` that stood here reached no group of its own and did nothing. SIGTERM to the
 * wrapper itself is what works: its own termination handlers stop its grandchildren and release
 * the lock. SIGKILL only if it does not go, and only then, because a killed wrapper releases
 * nothing.
 */
const stopSpawned = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    undefined;
  }
  await Promise.race([
    waitForChildExit(child).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      undefined;
    }
  }
};

const waitForFile = async (fs, filePath) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Fixture did not become ready: ${filePath}`);
};

const hangingCommand = path.join(
  __dirname,
  "fixtures",
  "mock-hanging-command.cjs",
);

test("command availability timeout force-kills an unresponsive process", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    checkCommand(hangingCommand, [], {
      timeoutMs: 50,
      terminateGraceMs: 50,
    }),
    /timed out after 50 ms/,
  );

  assert.ok(Date.now() - startedAt < 2000);
});

test("command timeout terminates descendant processes on POSIX", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-process-tree-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-process-tree.cjs");
  try {
    const check = checkCommand(command, [pidFile], {
      timeoutMs: 1000,
      terminateGraceMs: 500,
    });
    await waitForFile(fs, pidFile);
    await assert.rejects(check, /timed out after 1000 ms/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("command availability cleanup terminates descendants in a new POSIX session", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-command-check-detached-session-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-parent-exits-detached-session.cjs");
  try {
    await checkCommand(command, [pidFile], { timeoutMs: 5_000, terminateGraceMs: 500 });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("process-tree termination kills descendants after the direct parent exits", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-process-tree-parent-exit-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(
    __dirname,
    "fixtures",
    "mock-parent-exits-child-survives.cjs",
  );
  const parent = spawn(process.execPath, [command, pidFile], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitForFile(fs, pidFile);
    await waitForChildExit(parent);
    assert.equal(await terminateProcessTree(parent, 500), true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch {
      undefined;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("script process-tree termination reaches a surviving POSIX process group", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-script-process-tree-parent-exit-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(
    __dirname,
    "fixtures",
    "mock-parent-exits-child-survives.cjs",
  );
  const parent = spawn(process.execPath, [command, pidFile], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitForFile(fs, pidFile);
    await waitForChildExit(parent);
    const helper = await import("../scripts/terminate-process-tree.mjs");
    assert.equal(await helper.terminateProcessTree(parent, 500), true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch {
      undefined;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("bounded command escalates after the direct parent exits on SIGTERM", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bounded-parent-exit-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(
    __dirname,
    "fixtures",
    "mock-parent-exits-on-sigterm.cjs",
  );
  const runner = path.join(__dirname, "..", "scripts", "run-bounded-command.mjs");
  const bounded = spawn(
    process.execPath,
    [runner, "200", process.execPath, command, pidFile],
    { stdio: "ignore" },
  );
  try {
    await waitForFile(fs, pidFile);
    await waitForChildExit(bounded);
    assert.notEqual(bounded.exitCode, 0);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    await stopSpawned(bounded);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded command terminates its detached child group when the wrapper receives SIGTERM", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bounded-parent-signal-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-process-tree.cjs");
  const runner = path.join(__dirname, "..", "scripts", "run-bounded-command.mjs");
  const bounded = spawn(
    process.execPath,
    [runner, "60000", process.execPath, command, pidFile],
    { stdio: "ignore" },
  );
  try {
    await waitForFile(fs, pidFile);
    bounded.kill("SIGTERM");
    await waitForChildExit(bounded);
    assert.equal(bounded.exitCode, 143);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    await stopSpawned(bounded);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded command terminates a successful child that leaves a new POSIX session", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bounded-detached-session-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-parent-exits-detached-session.cjs");
  const runner = path.join(__dirname, "..", "scripts", "run-bounded-command.mjs");
  const bounded = spawn(process.execPath, [runner, "5000", process.execPath, command, pidFile], {
    stdio: "ignore",
  });
  try {
    await waitForChildExit(bounded);
    assert.equal(bounded.exitCode, 0);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    await stopSpawned(bounded);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows process scopes use a suspended child assigned to a kill-on-close Job Object", () => {
  const fs = require("node:fs");
  const root = path.join(__dirname, "..");
  const jobRunner = fs.readFileSync(path.join(root, "scripts", "windows-job-runner.ps1"), "utf8");
  const processScope = fs.readFileSync(path.join(root, "scripts", "process-scope.cjs"), "utf8");
  const windowsHost = fs.readFileSync(path.join(root, "scripts", "windows-process-host.cjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(jobRunner, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(jobRunner, /CREATE_SUSPENDED/u);
  assert.match(jobRunner, /AssignProcessToJobObject/u);
  assert.match(jobRunner, /TerminateJobObject/u);
  assert.match(processScope, /environment\.SystemRoot \?\? environment\.SYSTEMROOT \?\? environment\.WINDIR/u);
  assert.match(processScope, /containment: "jobObject"/u);
  assert.match(windowsHost, /child\.once\("exit"/u);
  assert.doesNotMatch(windowsHost, /child\.once\("close"/u);
  assert.ok(packageJson.files.includes("scripts/process-scope.cjs"));
  assert.ok(packageJson.files.includes("scripts/process-scope.mjs"));
  assert.ok(packageJson.files.includes("scripts/windows-job-runner.ps1"));
  assert.ok(packageJson.files.includes("scripts/windows-process-host.cjs"));
});

test("all detached-process wrappers install shared termination handlers", () => {
  const fs = require("node:fs");
  for (const script of [
    "run-bounded-command.mjs",
    "run-test-files.mjs",
    "run-human-e2e.mjs",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", script), "utf8");
    assert.match(source, /installTerminationHandlers/u, script);
  }
});

test("test-file runner continues after a completed failure and still exits nonzero", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-test-file-failure-"));
  const failedFile = path.join(directory, "first.test.cjs");
  const passedFile = path.join(directory, "second.test.cjs");
  const marker = path.join(directory, "continued.txt");
  const runner = path.join(__dirname, "..", "scripts", "run-test-files.mjs");
  fs.writeFileSync(failedFile, 'require("node:test")("first fails", () => { throw new Error("expected fixture failure"); });\n');
  fs.writeFileSync(passedFile, `require("node:test")("second passes", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "passed"); });\n`);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, failedFile, passedFile], {
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  try {
    await waitForChildExit(child);
    assert.equal(child.exitCode, 1, output);
    assert.equal(child.signalCode, null, output);
    assert.equal(fs.readFileSync(marker, "utf8"), "passed", output);
    assert.ok(output.includes(`Test files failed:\n${failedFile} exited with 1`), output);
    assert.ok(!output.includes(`${passedFile} exited with`), output);
  } finally {
    await stopSpawned(child);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("command availability cleanup removes descendants after a successful direct parent exit", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-command-check-success-cleanup-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-parent-exits-child-survives.cjs");
  try {
    await checkCommand(command, [pidFile], { timeoutMs: 5_000, terminateGraceMs: 500 });
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded command cleanup removes descendants after a successful direct parent exit", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const fs = require("node:fs");
  const os = require("node:os");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-bounded-success-cleanup-"));
  const pidFile = path.join(directory, "child.pid");
  const command = path.join(__dirname, "fixtures", "mock-parent-exits-child-survives.cjs");
  const runner = path.join(__dirname, "..", "scripts", "run-bounded-command.mjs");
  const bounded = spawn(process.execPath, [runner, "5000", process.execPath, command, pidFile], {
    stdio: "ignore",
  });
  try {
    await waitForChildExit(bounded);
    assert.equal(bounded.exitCode, 0);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
  } finally {
    await stopSpawned(bounded);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
