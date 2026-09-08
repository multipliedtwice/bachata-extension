const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const vm = require("node:vm");

const { terminateProcessTree } = require("../dist/process/terminateProcessTree.js");
const { spawnProcessScope, windowsScopeFromChild } = require("../scripts/process-scope.cjs");
const { runProcess } = require("../dist/orchestrator/commandRunner.js");
const { gitProcessEnvironment } = require("../dist/process/safeEnvironment.js");

test("native process scopes complete sequential commands with confirmed cleanup", { timeout: 150_000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-native-scope-"));
  try {
    if (process.platform === "win32") {
      const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const gitEnvironment = gitProcessEnvironment(cwd);
      const selectedEnvironment = (names) => Object.fromEntries(names.flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ));
      const environments = [
        ["inherited", process.env],
        ["Git", gitEnvironment],
        ["Git with module path", { ...gitEnvironment, ...selectedEnvironment(["PSModulePath"]) }],
        ["Git with profile paths", { ...gitEnvironment, ...selectedEnvironment(["USERPROFILE", "APPDATA", "LOCALAPPDATA"]) }],
      ];
      for (const [name, env] of environments) {
        await t.test(`PowerShell resolves paths with the ${name} environment`, async () => {
          const result = await promisify(execFile)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write((Join-Path (Split-Path 'C:\\scope\\payload.json' -Parent) 'probe'))"], {
            cwd,
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
          assert.equal(result.stdout, "C:\\scope\\probe");
        });
        await t.test(`PowerShell compiles with the ${name} environment`, async () => {
          const command = "Add-Type -TypeDefinition 'public static class NativeScopeProbe { public static string Ready() { return \"ready\"; } }' -Language CSharp -ErrorAction Stop; [Console]::Out.Write([NativeScopeProbe]::Ready())";
          const result = await promisify(execFile)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
            cwd,
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
          assert.equal(result.stdout, "ready");
        });
      }
      await t.test("the Job Object runner completes a native target", async () => {
        const scope = spawnProcessScope(process.execPath, ["-e", "process.exit(0)"], {
          cwd,
          env: gitProcessEnvironment(cwd),
          stdio: ["ignore", "pipe", "pipe"],
        });
        scope.child.stdout.resume();
        scope.child.stderr.resume();
        let timeout;
        try {
          const result = await Promise.race([
            scope.result,
            new Promise((resolve) => { timeout = setTimeout(() => resolve(undefined), 10_000); }),
          ]);
          if (!result) {
            const argument = (name) => scope.child.spawnargs[scope.child.spawnargs.indexOf(name) + 1];
            const status = (name) => {
              const file = argument(name);
              return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "not written";
            };
            const state = {
              compiled: fs.existsSync(path.join(path.dirname(argument("-PayloadPath")), "job-compiled.dll")),
              cached: fs.existsSync(argument("-AssemblyPath")),
              target: status("-TargetStatusPath"),
              job: status("-JobStatusPath"),
            };
            await scope.terminate(2_000);
            assert.fail(`Native runner timed out; existing status files: ${JSON.stringify(state)}`);
          }
          assert.equal(result.exitCode, 0, result.error);
          assert.equal(result.cleanupConfirmed, true, result.error);
        } finally {
          clearTimeout(timeout);
          await scope.terminate(2_000);
        }
      });
    }
    for (const marker of ["first", "second"]) {
      const result = await runProcess(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(marker)})`], {
        cwd,
        environment: gitProcessEnvironment(cwd),
        timeoutMs: 10_000,
        maxOutputBytes: 1_024,
      });
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: marker,
        stderr: "",
        timedOut: false,
        cancelled: false,
        cleanupConfirmed: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    }
    const git = await runProcess("git", ["--version"], {
      cwd,
      environment: gitProcessEnvironment(cwd),
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    assert.equal(git.timedOut, false, git.stderr);
    assert.equal(git.cleanupConfirmed, true, git.stderr);
    assert.equal(git.exitCode, 0, git.stderr);
    assert.match(git.stdout, /^git version /u);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("Windows termination stays bounded when taskkill never answers", { timeout: 2_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-windows-scope-hung-kill-"));
  const child = new EventEmitter();
  child.pid = 4_321;
  const scope = windowsScopeFromChild(
    child,
    {
      temporaryDirectory: directory,
      targetStatusPath: path.join(directory, "target-status.json"),
      jobStatusPath: path.join(directory, "job-status.json"),
    },
    () => new Promise(() => {}),
  );
  try {
    const terminated = scope.terminate(30);
    assert.equal(await terminated, false, "a stalled kill must report unconfirmed cleanup");
    assert.equal(await scope.terminate(30), false, "repeated termination must retain its verdict");
    child.emit("close", 1, "SIGKILL");
    const result = await scope.result;
    assert.equal(result.cleanupConfirmed, false, "runner exit alone must not confirm the stalled tree kill");
    assert.equal(result.terminationRequested, true);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows termination stays bounded while its runner never closes", { timeout: 2_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-windows-scope-hung-runner-"));
  const child = new EventEmitter();
  child.pid = 4_321;
  const scope = windowsScopeFromChild(
    child,
    {
      temporaryDirectory: directory,
      targetStatusPath: path.join(directory, "target-status.json"),
      jobStatusPath: path.join(directory, "job-status.json"),
    },
    () => Promise.resolve(true),
  );
  try {
    assert.equal(await scope.terminate(30), false, "taskkill success without runner exit must not confirm cleanup");
  } finally {
    child.emit("close", 1, "SIGKILL");
    await scope.result;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows assembly reuse survives sequential scopes and cleans up only without live runners", async (t) => {
  for (const keepRunnerAlive of [false, true]) {
    await t.test(keepRunnerAlive ? "active runner preserves its assembly" : "completed runners release their assembly at exit", async () => {
      const parent = new EventEmitter();
      parent.platform = "win32";
      parent.execPath = process.execPath;
      parent.env = { ...process.env, SystemRoot: "C:\\Windows" };
      parent.cwd = () => process.cwd();
      const runners = [];
      const runtimeModule = { exports: {} };
      const scriptDirectory = path.resolve(__dirname, "../scripts");
      const context = vm.createContext({
        module: runtimeModule,
        __dirname: scriptDirectory,
        process: parent,
        setTimeout,
        clearTimeout,
        require: (name) => name === "node:child_process"
          ? {
              spawn: (_executable, args) => {
                const child = new EventEmitter();
                child.pid = 4_321 + runners.length;
                const argument = (name) => args[args.indexOf(name) + 1];
                runners.push({
                  child,
                  assembly: argument("-AssemblyPath"),
                  target: argument("-TargetStatusPath"),
                  job: argument("-JobStatusPath"),
                });
                return child;
              },
            }
          : require(name),
      });
      vm.runInContext(fs.readFileSync(path.join(scriptDirectory, "process-scope.cjs"), "utf8"), context);
      const finish = async (runner, scope) => {
        fs.writeFileSync(runner.target, JSON.stringify({ exitCode: 0 }));
        fs.writeFileSync(runner.job, JSON.stringify({ cleanupConfirmed: true }));
        runner.child.emit("close", 0, null);
        assert.equal((await scope.result).cleanupConfirmed, true);
      };
      let secondScope;
      try {
        const firstScope = runtimeModule.exports.spawnProcessScope("git", ["--version"]);
        const first = runners[0];
        assert.equal(path.isAbsolute(first.assembly), true);
        assert.match(path.basename(path.dirname(first.assembly)), /^bachata-windows-assembly-/u);
        fs.writeFileSync(first.assembly, "compiled assembly fixture");
        await finish(first, firstScope);
        assert.equal(fs.existsSync(first.assembly), true, "sequential commands must retain their assembly");
        secondScope = runtimeModule.exports.spawnProcessScope("git", ["status"]);
        assert.equal(runners[1].assembly, first.assembly);
        if (!keepRunnerAlive) await finish(runners[1], secondScope);
        parent.emit("exit", 0);
        assert.equal(fs.existsSync(first.assembly), keepRunnerAlive);
      } finally {
        if (keepRunnerAlive && secondScope) await finish(runners[1], secondScope);
        for (const runner of runners) {
          fs.rmSync(path.dirname(runner.target), { recursive: true, force: true });
          fs.rmSync(path.dirname(runner.assembly), { recursive: true, force: true });
        }
      }
    });
  }
});
