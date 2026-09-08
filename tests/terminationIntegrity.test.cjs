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
const { windowsScopeFromChild } = require("../scripts/process-scope.cjs");
const { runProcess } = require("../dist/orchestrator/commandRunner.js");
const { gitProcessEnvironment } = require("../dist/process/safeEnvironment.js");
const nodeEnvironment = (cwd) => ({
  ...gitProcessEnvironment(cwd),
  ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
});

test("native process scopes complete sequential commands with confirmed cleanup", { timeout: 90_000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-native-scope-"));
  try {
    for (const marker of ["first", "second"]) {
      const environment = nodeEnvironment(cwd);
      if (marker === "second") environment.PSModulePath = "caller-module-path";
      const target = `process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(marker)}, modulePath: process.env.PSModulePath ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }))`;
      const result = await runProcess(process.execPath, ["-e", target], {
        cwd,
        environment,
        timeoutMs: marker === "first" ? 30_000 : 10_000,
        maxOutputBytes: 1_024,
      });
      assert.deepEqual(result, {
        exitCode: 0,
        stdout: JSON.stringify({ marker, modulePath: environment.PSModulePath ?? null, runAsNode: environment.ELECTRON_RUN_AS_NODE ?? null }),
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

test("native Windows scopes remove descendants after their parent exits", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-native-descendant-"));
  const pidPath = path.join(cwd, "child.pid");
  const descendant = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    `setInterval(() => { if (!fs.existsSync(${JSON.stringify(cwd)})) process.exit(0); }, 100);`,
    'setTimeout(() => process.exit(0), 30_000);',
    'process.send("ready");',
  ].join("\n");
  const parent = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
    'child.once("error", () => process.exit(1));',
    'child.once("message", () => process.exit(0));',
  ].join("\n");
  try {
    const result = await runProcess(process.execPath, ["-e", parent], {
      cwd,
      environment: nodeEnvironment(cwd),
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.cleanupConfirmed, true, result.stderr);
    const pid = Number(fs.readFileSync(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("Windows process host restores target helper variables without changing unrelated environment", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-host-environment-"));
  const payloadPath = path.join(directory, "payload.json");
  const statusPath = path.join(directory, "status.json");
  const hostPath = path.resolve(__dirname, "../scripts/windows-process-host.cjs");
  const environment = nodeEnvironment(directory);
  environment.BACHATA_TARGET_ONLY = "target";
  try {
    for (const modulePath of [undefined, "caller-module-path"]) {
      if (modulePath === undefined) delete environment.PSModulePath;
      else {
        environment.PSModulePath = modulePath;
        environment.ELECTRON_RUN_AS_NODE = "1";
      }
      fs.writeFileSync(payloadPath, JSON.stringify({
        executable: process.execPath,
        args: ["-e", "process.stdout.write(JSON.stringify({ modulePath: process.env.PSModulePath ?? null, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, target: process.env.BACHATA_TARGET_ONLY, helper: process.env.BACHATA_HELPER_ONLY ?? null }))"],
        cwd: directory,
        helperEnvironment: {
          ...(modulePath === undefined ? {} : { PSModulePath: modulePath }),
          ...(environment.ELECTRON_RUN_AS_NODE === undefined ? {} : { ELECTRON_RUN_AS_NODE: environment.ELECTRON_RUN_AS_NODE }),
        },
        stdinMode: "ignore",
      }));
      const result = await promisify(execFile)(process.execPath, [hostPath, payloadPath, statusPath], {
        cwd: directory,
        env: { ...environment, PSModulePath: "helper-module-path", ELECTRON_RUN_AS_NODE: "1", BACHATA_HELPER_ONLY: "helper" },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.deepEqual(JSON.parse(result.stdout), { modulePath: modulePath ?? null, runAsNode: environment.ELECTRON_RUN_AS_NODE ?? null, target: "target", helper: "helper" });
      assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, "utf8")), { exitCode: 0 });
    }
    fs.writeFileSync(payloadPath, JSON.stringify({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: directory,
    }));
    await assert.rejects(promisify(execFile)(process.execPath, [hostPath, payloadPath, statusPath], {
      cwd: directory,
      env: environment,
      timeout: 5_000,
    }), { code: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, "utf8")), {
      error: "Windows target helper environment is missing or invalid",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const waitForChildExit = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => {
        child.once("close", resolve);
      });

test("Windows process host restores only caller helper settings and rejects other payload keys", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../scripts/windows-process-host.cjs"), "utf8");
  const inherited = {
    SystemRoot: "C:\\Windows",
    PSModulePath: "helper-modules",
    psmodulepath: "helper-lowercase-modules",
    ELECTRON_RUN_AS_NODE: "1",
    electron_run_as_node: "helper-lowercase-node-mode",
    BACHATA_TARGET_ONLY: "target",
  };
  for (const [helperEnvironment, valid] of [
    [{}, true],
    [{ PsModulePath: "caller-modules", Electron_Run_As_Node: "0" }, true],
    [{ NODE_OPTIONS: "--require=untrusted.cjs" }, false],
    [{ ELECTRON_RUN_AS_NODE: 1 }, false],
  ]) {
    let targetEnvironment;
    let status;
    const exit = new Error("host exited");
    const context = vm.createContext({
      process: {
        argv: ["node", "host", "payload.json", "status.json"],
        env: inherited,
        exit: () => { throw exit; },
      },
      require: (name) => name === "node:fs"
        ? {
            readFileSync: () => JSON.stringify({ executable: "git", args: ["--version"], helperEnvironment }),
            writeFileSync: (_path, value) => { status = JSON.parse(value); },
          }
        : {
            spawn: (_executable, _args, options) => {
              targetEnvironment = options.env;
              return new EventEmitter();
            },
          },
    });
    if (valid) {
      vm.runInContext(source, context);
      assert.deepEqual(JSON.parse(JSON.stringify(targetEnvironment)), {
        SystemRoot: "C:\\Windows",
        BACHATA_TARGET_ONLY: "target",
        ...helperEnvironment,
      });
    } else {
      assert.throws(() => vm.runInContext(source, context), (error) => error === exit);
      assert.equal(targetEnvironment, undefined);
      assert.deepEqual(status, { error: "Windows target helper environment is missing or invalid" });
    }
  }
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
      parent.env = {
        SystemRoot: "C:\\Windows",
        PSModulePath: "C:\\untrusted-modules",
        psmodulepath: "C:\\untrusted-lowercase-modules",
        ELECTRON_RUN_AS_NODE: "caller-node-mode",
        electron_run_as_node: "caller-lowercase-node-mode",
        BACHATA_TEST_SECRET: "fixture-secret",
      };
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
              spawn: (_executable, args, options) => {
                const child = new EventEmitter();
                child.pid = 4_321 + runners.length;
                const argument = (name) => args[args.indexOf(name) + 1];
                runners.push({
                  child,
                  assembly: argument("-AssemblyPath"),
                  target: argument("-TargetStatusPath"),
                  job: argument("-JobStatusPath"),
                  environment: options.env,
                  payload: JSON.parse(fs.readFileSync(argument("-PayloadPath"), "utf8")),
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
        assert.deepEqual(JSON.parse(JSON.stringify(first.environment)), {
          SystemRoot: "C:\\Windows",
          PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
          ELECTRON_RUN_AS_NODE: "1",
          BACHATA_TEST_SECRET: "fixture-secret",
        });
        assert.deepEqual(first.payload.helperEnvironment, {
          PSModulePath: "C:\\untrusted-modules",
          psmodulepath: "C:\\untrusted-lowercase-modules",
          ELECTRON_RUN_AS_NODE: "caller-node-mode",
          electron_run_as_node: "caller-lowercase-node-mode",
        }, "the target must retain its caller's helper environment");
        assert.equal(JSON.stringify(first.payload).includes("fixture-secret"), false, "the payload must not persist unrelated environment values");
        assert.equal(parent.env.PSModulePath, "C:\\untrusted-modules", "wrapper setup must not mutate the caller's environment");
        assert.equal(parent.env.ELECTRON_RUN_AS_NODE, "caller-node-mode", "wrapper setup must not mutate the caller's Node mode");
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
