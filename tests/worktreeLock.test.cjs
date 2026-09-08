const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const lockModule = path.join(root, "scripts", "lib", "worktreeLock.mjs");
const loadLock = () => import(`file://${lockModule}`);

const temporaryLockPath = (name) =>
  path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bachata-worktree-lock-${name}-`))),
    ".bachata-worktree.lock",
  );

const cleanup = (lockPath) => {
  fs.rmSync(path.dirname(lockPath), { recursive: true, force: true });
};

test("the lock file lives outside dist, which the build deletes", async () => {
  const { defaultWorktreeLockPath, WORKTREE_LOCK_FILE } = await loadLock();
  const lockPath = defaultWorktreeLockPath();
  assert.equal(path.dirname(lockPath), path.resolve(root));
  assert.equal(path.basename(lockPath), WORKTREE_LOCK_FILE);
  assert.equal(lockPath.includes(`${path.sep}dist${path.sep}`), false);
  const buildSource = fs.readFileSync(path.join(root, "scripts", "build.mjs"), "utf8");
  assert.match(buildSource, /withWorktreeLock/u);
  const ignored = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
  // The lock, its fence, and any file moved aside during a reclaim all share this prefix.
  assert.ok(
    ignored.includes(WORKTREE_LOCK_FILE) || ignored.includes(".bachata-worktree.*"),
    ".gitignore must exclude the worktree lock file and the fence beside it",
  );
});

test("every command that reads or rewrites the built tree takes the same lock", () => {
  const holders = [
    ["scripts/build.mjs", /withWorktreeLock/u],
    ["scripts/run-test-files.mjs", /withWorktreeLock/u],
    ["scripts/run-bounded-command.mjs", /withWorktreeLock/u],
    ["scripts/package.mjs", /acquireWorktreeLock/u],
    ["scripts/test-managed-modules.mjs", /acquireWorktreeLock/u],
    ["scripts/test-managed-worktree.mjs", /acquireWorktreeLock/u],
    // The gate itself moved into a functional entry point; the CLI is a thin caller.
    ["scripts/lib/localValidationRun.mjs", /acquireWorktreeLock/u],
  ];
  holders.forEach(([relative, pattern]) => {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.match(source, pattern, `${relative} must take the worktree lock`);
    assert.match(source, /worktreeLock\.mjs/u, `${relative} must use the shared lock module`);
  });
});

test("a partially written lock record is never mistaken for a dead owner", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("partial");
  try {
    // Exactly what a reader observes between `open(path, "wx")` and the record write.
    fs.writeFileSync(lockPath, "", "utf8");
    await assert.rejects(
      acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "second run",
        waitMs: 300,
        pollMs: 40,
        log: () => undefined,
      }),
      /Another run owns this worktree/u,
      "an empty record must not be reclaimed as stale",
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), "", "the live lock must survive untouched");

    fs.writeFileSync(lockPath, "{\"token\": \"truncated", "utf8");
    await assert.rejects(
      acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "second run",
        waitMs: 300,
        pollMs: 40,
        log: () => undefined,
      }),
      /Another run owns this worktree/u,
      "a truncated record must not be reclaimed as stale",
    );

    fs.writeFileSync(lockPath, JSON.stringify({ label: "no token or pid" }), "utf8");
    await assert.rejects(
      acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "second run",
        waitMs: 300,
        pollMs: 40,
        log: () => undefined,
      }),
      /Another run owns this worktree/u,
      "a record without a token must not be reclaimed as stale",
    );
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    cleanup(lockPath);
  }
});

test("two simultaneous owners with different tokens are impossible", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("simultaneous");
  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (unused, index) => acquireWorktreeLock({
        lockPath,
        environment: {},
        label: `run ${String(index)}`,
        waitMs: 250,
        pollMs: 20,
        log: () => undefined,
      })),
    );
    const held = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    assert.equal(held.length, 1, `exactly one run may own the worktree, ${String(held.length)} did`);
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(record.token, held[0].token, "the lock file must name the run that owns it");
    await Promise.all(held.map((lock) => lock.release()));
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanup(lockPath);
  }
});

test("concurrent acquirers all refuse a lock left by a dead owner, and none touches it", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("dead-owner-refusals");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const deadPid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const record = JSON.stringify({ token: "dead-owner", pid: deadPid, host: os.hostname(), label: "crashed run" });
  try {
    fs.writeFileSync(lockPath, record, "utf8");
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (unused, index) => acquireWorktreeLock({
        lockPath,
        environment: {},
        label: `contender ${String(index)}`,
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      }).then(() => "acquired", () => "refused")),
    );
    assert.deepEqual(
      Array.from(new Set(attempts)),
      ["refused"],
      "a lock left by a dead process is not evidence that the work it protected stopped",
    );
    assert.equal(fs.readFileSync(lockPath, "utf8"), record, "no contender may alter the abandoned record");
  } finally {
    cleanup(lockPath);
  }
});

test("a run refuses promptly instead of queueing for the length of a suite", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const source = fs.readFileSync(path.join(root, "scripts", "lib", "worktreeLock.mjs"), "utf8");
  const declared = /const DEFAULT_WAIT_MS = ([0-9_]+);/u.exec(source);
  assert.notEqual(declared, null);
  const waitMs = Number(declared[1].replaceAll("_", ""));
  assert.ok(waitMs <= 30_000, `a contended run must refuse promptly, not wait ${String(waitMs)}ms`);
  const lockPath = temporaryLockPath("prompt");
  const held = await acquireWorktreeLock({ lockPath, environment: {}, label: "first run", log: () => undefined });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      acquireWorktreeLock({ lockPath, environment: {}, label: "second run", waitMs: 500, log: () => undefined }),
      /Another run owns this worktree/u,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 400, `refusal must honour the wait window, refused after ${String(elapsed)}ms`);
    assert.ok(elapsed < 10_000, `refusal must not queue behind a whole suite, took ${String(elapsed)}ms`);
  } finally {
    await held.release();
    cleanup(lockPath);
  }
});

test("a second run waits and then fails rather than deleting a live run's build tree", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("contended");
  const environment = {};
  const held = await acquireWorktreeLock({
    lockPath,
    environment,
    label: "first run",
    log: () => undefined,
  });
  try {
    await assert.rejects(
      acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "second run",
        waitMs: 400,
        pollMs: 50,
        log: () => undefined,
      }),
      /Another run owns this worktree/u,
    );
    await held.release();
    const second = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "second run",
      waitMs: 1_000,
      pollMs: 50,
      log: () => undefined,
    });
    assert.equal(second.reentrant, false);
    await second.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    await held.release();
    cleanup(lockPath);
  }
});

test("a lock left by a dead owner is cleared only by explicit operator recovery", async () => {
  const { acquireWorktreeLock, recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("operator-recovery");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const deadPid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  try {
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: "dead-owner", pid: deadPid, host: os.hostname(), label: "crashed run" }),
      "utf8",
    );
    const refused = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", (error) => error.message);
    assert.match(String(refused), /never reclaims it automatically/u);
    assert.match(String(refused), /confirm nothing from that run is still working in this worktree/u);
    assert.match(String(refused), /npm run worktree:unlock -- LOCK_TOKEN/u);

    // Recovery refuses without the token an operator must read out of the file.
    assert.equal((await recoverWorktreeLock({ lockPath, log: () => undefined })).removed, false);
    assert.equal(
      (await recoverWorktreeLock({ lockPath, expectedToken: "some-other-token", log: () => undefined })).removed,
      false,
    );
    assert.equal(fs.existsSync(lockPath), true, "a mistaken token must leave the lock in place");

    const recovered = await recoverWorktreeLock({ lockPath, expectedToken: "dead-owner", log: () => undefined });
    assert.equal(recovered.removed, true);
    assert.equal(fs.existsSync(lockPath), false);
    const lock = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 2_000,
      pollMs: 20,
      log: () => undefined,
    });
    await lock.release();
  } finally {
    cleanup(lockPath);
  }
});

test("a child that inherits the owner token re-enters the lock instead of deadlocking", async () => {
  const { acquireWorktreeLock, WORKTREE_LOCK_OWNER_ENVIRONMENT } = await loadLock();
  const lockPath = temporaryLockPath("reentrant");
  const environment = {};
  const outer = await acquireWorktreeLock({ lockPath, environment, label: "npm test", log: () => undefined });
  try {
    assert.equal(typeof environment[WORKTREE_LOCK_OWNER_ENVIRONMENT], "string");
    const inner = await acquireWorktreeLock({
      lockPath,
      environment: { ...environment },
      label: "nested build",
      waitMs: 500,
      pollMs: 50,
      log: () => undefined,
    });
    assert.equal(inner.reentrant, true);
    await inner.release();
    assert.equal(fs.existsSync(lockPath), true, "a re-entrant release must not free the outer lock");
  } finally {
    await outer.release();
    cleanup(lockPath);
  }
});

test("an inherited token that no longer matches the lock acquires a fresh lock", async () => {
  const { acquireWorktreeLock, WORKTREE_LOCK_OWNER_ENVIRONMENT } = await loadLock();
  const lockPath = temporaryLockPath("orphan");
  try {
    const lock = await acquireWorktreeLock({
      lockPath,
      environment: { [WORKTREE_LOCK_OWNER_ENVIRONMENT]: "token-from-a-crashed-parent" },
      label: "orphaned child",
      waitMs: 1_000,
      pollMs: 50,
      log: () => undefined,
    });
    assert.equal(lock.reentrant, false);
    assert.equal(fs.existsSync(lockPath), true);
    await lock.release();
  } finally {
    cleanup(lockPath);
  }
});

test("a fence left behind by a crashed remover does not block the worktree", async () => {
  const { acquireWorktreeLock, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("orphan-fence");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const deadPid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const fencePath = fencePathFor(lockPath);
  fs.writeFileSync(
    fencePath,
    JSON.stringify({ token: "abandoned", pid: deadPid, host: os.hostname(), label: "crashed remover" }),
    "utf8",
  );
  try {
    const lock = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "next run",
      waitMs: 2_000,
      pollMs: 20,
      log: () => undefined,
    });
    assert.equal(fs.existsSync(fencePath), false, "a dead remover's fence must be retired, not waited out");
    await lock.release();
  } finally {
    cleanup(lockPath);
  }
});

test("separate processes never both own the worktree", async () => {
  const lockPath = temporaryLockPath("multi-process");
  const script = `
    const lockPath = process.argv[1];
    import(${JSON.stringify(`file://${lockModule}`)}).then(async ({ acquireWorktreeLock }) => {
      try {
        const lock = await acquireWorktreeLock({
          lockPath,
          environment: {},
          label: "process " + String(process.pid),
          waitMs: 4000,
          pollMs: 10,
          log: () => undefined,
        });
        process.stdout.write(JSON.stringify({ owned: true, token: lock.token }) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 150));
        await lock.release();
      } catch (error) {
        process.stdout.write(JSON.stringify({ owned: false, error: String(error.message) }) + "\\n");
      }
    });
  `;
  const run = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("close", () => resolve(JSON.parse(output.trim() || "{}")));
    });
  try {
    const results = await Promise.all([run(), run(), run(), run()]);
    const owners = results.filter((result) => result.owned);
    assert.equal(owners.length, 4, "each process must take its turn rather than fail");
    assert.equal(new Set(owners.map((result) => result.token)).size, 4, "each turn is a distinct ownership");
    assert.equal(fs.existsSync(lockPath), false, "the last owner releases the lock");
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [], "no reclaim residue is left behind");
  } finally {
    cleanup(lockPath);
  }
});

// A barrier the tests use to stop a run at an exact point in its destructive path and to
// resume it after another run has acted. No sleeps, so the interleaving is deterministic.
const barrier = () => {
  let release;
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  const resumed = new Promise((resolve) => {
    release = resolve;
  });
  return {
    arrived,
    hook: async () => {
      reached();
      await resumed;
    },
    resume: () => release(),
  };
};

test("a run that created its file while a delete was fenced never deletes the owner that follows", async () => {
  const { acquireWorktreeLock, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("stand-down");
  const fencePath = fencePathFor(lockPath);
  try {
    const paused = barrier();
    // The contested run is stopped between creating its file and checking for a fence,
    // which is the window in which another run's fenced delete removes that file.
    const contested = acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contested run",
      waitMs: 600,
      pollMs: 10,
      log: () => undefined,
      hooks: { afterCreate: paused.hook },
    }).then(() => "acquired", (error) => `refused: ${error.message}`);
    await paused.arrived;

    // A delete is fenced, removes the contested file, and an owner takes the path.
    fs.writeFileSync(
      fencePath,
      JSON.stringify({ token: "remover", pid: process.pid, host: os.hostname(), label: "remover" }),
      "utf8",
    );
    fs.rmSync(lockPath, { force: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: "owner-after-delete", pid: process.pid, host: os.hostname(), label: "owner" }),
      "utf8",
    );
    paused.resume();
    // The fence clears; the contested run must now find its file gone and stand down.
    fs.rmSync(fencePath, { force: true });

    const outcome = await contested;
    assert.match(String(outcome), /^refused/u, "a contested run must not claim ownership it lost");
    assert.equal(fs.existsSync(lockPath), true, "the owner that followed must survive");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "owner-after-delete");
  } finally {
    cleanup(lockPath);
  }
});


test("a run that gives up while waiting out a fence removes the lock it published", async () => {
  const { acquireWorktreeLock, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("fence-abandon");
  const fencePath = fencePathFor(lockPath);
  let clearFence;
  let planted = false;
  try {
    const outcome = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "abandoning run",
      waitMs: 60,
      pollMs: 10,
      log: () => undefined,
      hooks: {
        // A fence appears between this run's before-check and its publication, which is what
        // another run's release does when it frees the path this run then links into.
        beforePublish: async () => {
          if (planted) return;
          planted = true;
          fs.writeFileSync(
            fencePath,
            JSON.stringify({ token: "remover", pid: process.pid, host: os.hostname(), label: "remover" }),
            "utf8",
          );
        },
        // The fence outlives this run's wait budget, so the run gives up holding a published
        // lock nothing in this module would ever reclaim.
        afterContestedCreate: async () => {
          clearFence = setTimeout(() => fs.rmSync(fencePath, { force: true }), 120);
        },
      },
    }).then(() => "acquired", (error) => `refused: ${error.message}`);

    assert.match(String(outcome), /^refused/u, "a run must not claim a path it could not confirm");
    assert.equal(fs.existsSync(lockPath), false, "the abandoned run left its own published lock behind");
    assert.deepEqual(
      fs.readdirSync(path.dirname(lockPath)),
      [],
      "the abandoned run left residue beside the lock",
    );
  } finally {
    clearTimeout(clearFence);
    cleanup(lockPath);
  }
});


// A child that acquires the worktree lock, reports its pid and token, and then waits. It
// is used to hold a lock with a real, separately schedulable process.
const OWNER_CHILD_SCRIPT = (lockModulePath) => `
  const lockPath = process.argv[1];
  import(${JSON.stringify("file://LOCK_MODULE")}.replace("LOCK_MODULE", ${JSON.stringify(lockModulePath)}))
    .then(async ({ acquireWorktreeLock }) => {
      const lock = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "child owner",
        log: () => undefined,
      });
      process.stdout.write(JSON.stringify({ token: lock.token, pid: process.pid }) + "\\n");
      process.stdin.on("data", () => process.exit(0));
    });
`;

const startOwnerChild = async (lockPath) => {
  const child = spawn(process.execPath, ["-e", OWNER_CHILD_SCRIPT(lockModule), lockPath], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const announced = await new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("\n")) resolve(JSON.parse(output.trim()));
    });
  });
  return { child, ...announced };
};

const ageBeyondEveryDeadline = (target) => {
  const ancient = new Date(Date.now() - 24 * 3_600_000);
  fs.utimesSync(target, ancient, ancient);
};

test("a stopped owner keeps the worktree, and its death does not hand the worktree on", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("live-owner");
  const owned = await startOwnerChild(lockPath);
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, owned.token);

    // Stopped, exactly as a descheduled or suspended run would be, and aged past every
    // deadline this lock has ever used.
    process.kill(owned.pid, "SIGSTOP");
    ageBeyondEveryDeadline(lockPath);
    const contended = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 400,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", (error) => `refused: ${error.message}`);
    assert.match(String(contended), /^refused/u, "age must never take a worktree from a process that can resume");

    // Killing the recorded process is not evidence that the work it started has stopped.
    process.kill(owned.pid, "SIGCONT");
    owned.child.kill("SIGKILL");
    await new Promise((resolve) => owned.child.once("exit", resolve));
    const afterDeath = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 400,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", () => "refused");
    assert.equal(afterDeath, "refused", "a dead wrapper does not release the worktree automatically");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, owned.token);
  } finally {
    try {
      process.kill(owned.pid, "SIGCONT");
    } catch {
      // Already gone.
    }
    owned.child.kill("SIGKILL");
    cleanup(lockPath);
  }
});

test("a fence held by a living process cannot be retired, however long it has been held", async () => {
  const { acquireWorktreeLock, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("durable-fence");
  const fencePath = fencePathFor(lockPath);
  try {
    // A fence naming this very process, aged past any deadline. Its holder is alive, so its
    // authority cannot lapse and no run may create a lock behind it.
    fs.writeFileSync(
      fencePath,
      JSON.stringify({ token: "held", pid: process.pid, host: os.hostname(), label: "living remover" }),
      "utf8",
    );
    ageBeyondEveryDeadline(fencePath);
    const outcome = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 400,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", (error) => `refused: ${error.message}`);
    assert.match(String(outcome), /^refused/u, "a living fence holder keeps its authority");
    assert.equal(fs.existsSync(fencePath), true, "a living holder's fence must not be retired");
    assert.equal(fs.existsSync(lockPath), false, "no lock may be created behind a held fence");
  } finally {
    fs.rmSync(fencePath, { force: true });
    cleanup(lockPath);
  }
});

test("a foreign host, an unreadable record and a missing pid all fail closed", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const cases = [
    ["foreign host", JSON.stringify({ token: "elsewhere", pid: 999_999, host: "another-machine" })],
    ["no pid", JSON.stringify({ token: "no-pid", host: os.hostname() })],
    ["unparsable record", "{ this is not json"],
    ["empty record", ""],
  ];
  for (const [what, contents] of cases) {
    const lockPath = temporaryLockPath("fail-closed");
    try {
      fs.writeFileSync(lockPath, contents, "utf8");
      ageBeyondEveryDeadline(lockPath);
      const outcome = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "contender",
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      }).then(() => "acquired", () => "refused");
      assert.equal(outcome, "refused", `${what} must never be reclaimed`);
      assert.equal(fs.readFileSync(lockPath, "utf8"), contents, `${what} must be left untouched`);
    } finally {
      cleanup(lockPath);
    }
  }
});

const deadLocalPid = async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
};

const writeDeadOwnerLock = async (lockPath) => {
  const pid = await deadLocalPid();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ token: "dead-owner", pid, host: os.hostname(), label: "crashed run" }),
    "utf8",
  );
  return pid;
};

test("a recovery paused after its final proof keeps its authority, and only the judged lock moves", async () => {
  const { acquireWorktreeLock, recoverWorktreeLock, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("last-proof");
  const fencePath = fencePathFor(lockPath);
  try {
    await writeDeadOwnerLock(lockPath);
    const judged = fs.statSync(lockPath).ino;

    // The only destructive canonical path is operator recovery, stopped here between its
    // last authority proof and the move itself.
    const paused = barrier();
    const recovering = recoverWorktreeLock({
      lockPath,
      expectedToken: "dead-owner",
      log: () => undefined,
      hooks: { afterFinalProof: paused.hook },
    });
    await paused.arrived;

    assert.equal(fs.existsSync(fencePath), true);
    ageBeyondEveryDeadline(fencePath);
    const contended = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 300,
      pollMs: 10,
      log: () => undefined,
    }).then(() => "acquired", () => "refused");
    assert.equal(contended, "refused", "no run may acquire while a living recovery holds the fence");
    assert.equal(fs.existsSync(fencePath), true, "a living holder's fence survives an ageing attempt");
    assert.equal(fs.statSync(lockPath).ino, judged, "the judged lock is still the file about to move");

    paused.resume();
    assert.equal((await recovering).removed, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes(".retired-")),
      [],
      "the judged lock is the only file that moved, and it was removed",
    );
  } finally {
    fs.rmSync(fencePath, { force: true });
    cleanup(lockPath);
  }
});

test("a release cannot delete a lock that replaced its own", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("release-replacement");
  try {
    const owner = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "owner",
      log: () => undefined,
    });
    // The only way a live owner's file is replaced is outside this protocol: a human, or a
    // stray script, removing it. The release must still refuse to delete what followed.
    fs.rmSync(lockPath, { force: true });
    const replacement = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "replacement",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    assert.notEqual(replacement.token, owner.token);
    await owner.release();
    assert.equal(fs.existsSync(lockPath), true, "the replacement must survive the old owner's release");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, replacement.token);
    assert.equal(await owner.ownsWorktree(), false);
    await replacement.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    cleanup(lockPath);
  }
});

test("exit cleanup in another process cannot delete a lock that replaced its own", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("exit-replacement");
  const owned = await startOwnerChild(lockPath);
  try {
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, owned.token);
    fs.rmSync(lockPath, { force: true });
    const replacement = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "replacement",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    assert.notEqual(replacement.token, owned.token);

    // The child now exits normally and runs its exit cleanup against a path it no longer
    // owns.
    owned.child.stdin.write("exit\n");
    await new Promise((resolve) => owned.child.once("exit", resolve));
    assert.equal(fs.existsSync(lockPath), true, "exit cleanup must not delete the replacement lock");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, replacement.token);
    await replacement.release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    owned.child.kill("SIGKILL");
    cleanup(lockPath);
  }
});

test("the sweep clears ownerless residue of both families and keeps residue with a living owner", async () => {
  const { sweepWorktreeLockResidue, fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("sweep");
  const fencePath = fencePathFor(lockPath);
  const directory = path.dirname(lockPath);
  try {
    const deadPid = await deadLocalPid();
    const deadRecord = JSON.stringify({ token: "dead", pid: deadPid, host: os.hostname(), label: "gone" });
    const liveRecord = JSON.stringify({ token: "live", pid: process.pid, host: os.hostname(), label: "running" });
    // A lock moved aside by a reclaim or release, which the previous sweep never matched.
    fs.writeFileSync(`${lockPath}.retired-dead`, deadRecord, "utf8");
    fs.writeFileSync(`${fencePath}.retired-dead`, deadRecord, "utf8");
    fs.writeFileSync(`${fencePath}.claim-dead`, deadRecord, "utf8");
    fs.writeFileSync(`${lockPath}.retired-ownerless`, "", "utf8");
    fs.writeFileSync(`${lockPath}.claim-dead`, deadRecord, "utf8");
    fs.writeFileSync(`${lockPath}.retired-live`, liveRecord, "utf8");
    fs.writeFileSync(`${fencePath}.claim-live`, liveRecord, "utf8");

    const removed = await sweepWorktreeLockResidue(lockPath);
    assert.deepEqual(
      removed.sort(),
      [
        `${path.basename(fencePath)}.claim-dead`,
        `${path.basename(fencePath)}.retired-dead`,
        `${path.basename(lockPath)}.claim-dead`,
        `${path.basename(lockPath)}.retired-dead`,
      ].sort(),
      "the sweep must clear canonical and fence residue whose writer is proven dead",
    );
    const remaining = fs.readdirSync(directory).sort();
    assert.deepEqual(
      remaining,
      [
        `${path.basename(fencePath)}.claim-live`,
        `${path.basename(lockPath)}.retired-live`,
        // An unreadable record may be a claim being written right now, so it is kept.
        `${path.basename(lockPath)}.retired-ownerless`,
      ].sort(),
      "residue naming a living owner, or no owner it can read, must be kept",
    );
  } finally {
    cleanup(lockPath);
  }
});

// A parent that acquires the lock, hands the owner token to a child, and reports both pids.
// The child holds the worktree open the way a compiler or test runner does.
const PROTECTED_TREE_SCRIPT = (lockModulePath, reentrant) => `
  const lockPath = process.argv[1];
  const { spawn } = require("node:child_process");
  import(${JSON.stringify("LOCK")}.replace("LOCK", ${JSON.stringify(lockModulePath)}))
    .then(async ({ acquireWorktreeLock, WORKTREE_LOCK_OWNER_ENVIRONMENT }) => {
      const environment = {};
      const lock = await acquireWorktreeLock({ lockPath, environment, label: "parent", log: () => undefined });
      const childScript = ${reentrant
        ? `'import(' + JSON.stringify(${JSON.stringify(lockModulePath)}) + ').then(async ({ acquireWorktreeLock }) => { const inner = await acquireWorktreeLock({ lockPath: process.argv[1], environment: { BACHATA_WORKTREE_LOCK_OWNER: process.env.BACHATA_WORKTREE_LOCK_OWNER }, label: "child", log: () => undefined }); process.stdout.write(JSON.stringify({ reentrant: inner.reentrant, pid: process.pid }) + String.fromCharCode(10)); setInterval(() => undefined, 1000); });'`
        : `'process.stdout.write(JSON.stringify({ reentrant: false, pid: process.pid }) + String.fromCharCode(10)); setInterval(() => undefined, 1000);'`};
      const child = spawn(process.execPath, ["-e", childScript, lockPath], {
        stdio: ["ignore", "inherit", "ignore"],
        env: { ...process.env, BACHATA_WORKTREE_LOCK_OWNER: environment[WORKTREE_LOCK_OWNER_ENVIRONMENT] },
      });
      process.stdout.write(JSON.stringify({ parent: process.pid, child: child.pid, token: lock.token }) + String.fromCharCode(10));
      setInterval(() => undefined, 1000);
    });
`;

const startProtectedTree = async (lockPath, reentrant) => {
  const parent = spawn(process.execPath, ["-e", PROTECTED_TREE_SCRIPT(lockModule, reentrant), lockPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = [];
  await new Promise((resolve) => {
    let buffered = "";
    parent.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const complete = buffered.split("\n").filter((line) => line.trim().length > 0);
      complete.forEach((line) => {
        const parsed = JSON.parse(line);
        if (!lines.some((seen) => JSON.stringify(seen) === line)) lines.push(parsed);
      });
      if (lines.some((entry) => entry.parent !== undefined) && lines.some((entry) => entry.pid !== undefined)) {
        resolve();
      }
    });
  });
  const outer = lines.find((entry) => entry.parent !== undefined);
  const inner = lines.find((entry) => entry.pid !== undefined);
  return { parent, outer, inner };
};

test("killing the recorded owner does not release a worktree its re-entrant child still holds", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("protected-tree");
  const tree = await startProtectedTree(lockPath, true);
  try {
    assert.equal(tree.inner.reentrant, true, "the child re-entered the lock its parent owns");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, tree.outer.token);

    process.kill(tree.outer.parent, "SIGKILL");
    await new Promise((resolve) => tree.parent.once("exit", resolve));
    assert.doesNotThrow(() => process.kill(tree.inner.pid, 0), "the child is still running");

    const contended = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 400,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", () => "refused");
    assert.equal(
      contended,
      "refused",
      "the recorded process dying is not evidence that its re-entrant child stopped",
    );
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, tree.outer.token);
  } finally {
    try {
      process.kill(tree.inner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    tree.parent.kill("SIGKILL");
    cleanup(lockPath);
  }
});

test("killing the recorded owner does not release a worktree an unregistered subprocess still uses", async () => {
  const { acquireWorktreeLock, recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("unregistered-child");
  const tree = await startProtectedTree(lockPath, false);
  try {
    // This child never called acquireWorktreeLock at all — a compiler or test runner.
    assert.equal(tree.inner.reentrant, false);
    process.kill(tree.outer.parent, "SIGKILL");
    await new Promise((resolve) => tree.parent.once("exit", resolve));
    assert.doesNotThrow(() => process.kill(tree.inner.pid, 0), "the unregistered child is still running");

    const contended = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 400,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", () => "refused");
    assert.equal(contended, "refused", "no automatic transfer may overlap work Bachata cannot see");

    // The operator, who can see that work, is the only one who may clear it.
    const token = JSON.parse(fs.readFileSync(lockPath, "utf8")).token;
    process.kill(tree.inner.pid, "SIGKILL");
    assert.equal((await recoverWorktreeLock({ lockPath, expectedToken: token, log: () => undefined })).removed, true);
    const lock = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 2_000,
      pollMs: 20,
      log: () => undefined,
    });
    await lock.release();
  } finally {
    try {
      process.kill(tree.inner.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    tree.parent.kill("SIGKILL");
    cleanup(lockPath);
  }
});

test("a publication that throws removes its own claim and publishes nothing", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("publish-throws");
  const directory = path.dirname(lockPath);
  try {
    // An in-process failure, not a crash: the catch path must clean up after itself. The
    // real crash case is covered by the SIGKILL regression below, which leaves the claim.
    const failed = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "failing run",
      waitMs: 500,
      pollMs: 10,
      log: () => undefined,
      hooks: {
        beforePublish: async () => {
          throw new Error("publication refused by the hook");
        },
      },
    }).then(() => "acquired", (error) => error.message);
    assert.match(String(failed), /publication refused by the hook/u);
    assert.equal(fs.existsSync(lockPath), false, "no canonical lock may exist without a complete record");
    assert.deepEqual(
      fs.readdirSync(directory),
      [],
      "a failure this run caught must leave no claim behind",
    );
    const next = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "next run",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    await next.release();
  } finally {
    cleanup(lockPath);
  }
});
test("a failed record write publishes nothing and leaves no permanent empty lock", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("failed-write");
  try {
    // The directory is made read-only, so creating the private claim fails outright.
    fs.chmodSync(path.dirname(lockPath), 0o500);
    const failed = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "failing run",
      waitMs: 300,
      pollMs: 10,
      log: () => undefined,
    }).then(() => "acquired", (error) => error.code ?? error.message);
    assert.notEqual(failed, "acquired", "a write that cannot happen must not yield ownership");
    fs.chmodSync(path.dirname(lockPath), 0o700);
    assert.equal(fs.existsSync(lockPath), false, "no empty canonical lock may be left behind");
    const next = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "next run",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    await next.release();
  } finally {
    try {
      fs.chmodSync(path.dirname(lockPath), 0o700);
    } catch {
      // Already restored.
    }
    cleanup(lockPath);
  }
});

// Identity is read through one injectable function in the lock module, so a filesystem
// that reports no usable inode is reproduced in a real child process against the real
// module rather than by patching bindings this module never reads.
const ZERO_INODE_PRELUDE = (lockModulePath) => `
  const { setFileIdentityReaderForTests } = await import(${JSON.stringify("LOCK")}.replace("LOCK", ${JSON.stringify(lockModulePath)}));
  const { promises: fsp } = await import("node:fs");
  setFileIdentityReaderForTests(async (candidate) => {
    const details = await fsp.lstat(candidate).catch((error) => {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!details) return undefined;
    return Object.create(Object.getPrototypeOf(details), {
      ...Object.getOwnPropertyDescriptors(details),
      ino: { value: 0, enumerable: true },
    });
  });
`;

const runInChild = async (body, environment = {}) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", body], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment },
  });
  const output = await new Promise((resolve) => {
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.once("close", () => resolve({ out, err }));
  });
  if (!output.out.trim()) {
    throw new Error(`child produced no result: ${output.err.slice(0, 400)}`);
  }
  return JSON.parse(output.out.trim().split("\n").at(-1));
};

test("a filesystem with no usable inode identifies files by their recorded token", async () => {
  const lockPath = temporaryLockPath("zero-inode");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      ${ZERO_INODE_PRELUDE(lockModule)}
      const { acquireWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      const owner = await acquireWorktreeLock({ lockPath, environment: {}, label: "owner", waitMs: 2000, pollMs: 10, log: () => undefined });
      const ownsBeforeRelease = await owner.ownsWorktree();
      const contended = await acquireWorktreeLock({ lockPath, environment: {}, label: "contender", waitMs: 200, pollMs: 10, log: () => undefined })
        .then(() => true, () => false);
      await owner.release();
      const lockAfterRelease = fs.existsSync(lockPath);
      const fenceAfterRelease = fs.existsSync(lockPath + ".fence");
      process.stdout.write(JSON.stringify({ ownsBeforeRelease, contended, lockAfterRelease, fenceAfterRelease }));
    `);
    assert.deepEqual(result, {
      ownsBeforeRelease: true,
      contended: false,
      lockAfterRelease: false,
      fenceAfterRelease: false,
    }, "without inodes the recorded token must identify locks, fences and ownership alike");
  } finally {
    cleanup(lockPath);
  }
});

test("without inodes, a release whose file was replaced still deletes nothing", async () => {
  const lockPath = temporaryLockPath("zero-inode-replaced");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      ${ZERO_INODE_PRELUDE(lockModule)}
      const { acquireWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      const owner = await acquireWorktreeLock({ lockPath, environment: {}, label: "owner", waitMs: 2000, pollMs: 10, log: () => undefined });
      fs.rmSync(lockPath, { force: true });
      const replacement = await acquireWorktreeLock({ lockPath, environment: {}, label: "replacement", waitMs: 2000, pollMs: 10, log: () => undefined });
      await owner.release();
      const survivedToken = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")).token : undefined;
      process.stdout.write(JSON.stringify({
        replacementSurvived: survivedToken === replacement.token,
        oldOwnerStillClaims: await owner.ownsWorktree(),
      }));
    `);
    assert.deepEqual(result, { replacementSurvived: true, oldOwnerStillClaims: false });
  } finally {
    cleanup(lockPath);
  }
});

test("a signalled owner leaves its lock behind while its children still run", async () => {
  const { acquireWorktreeLock } = await loadLock();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    const lockPath = temporaryLockPath(`signalled-${signal}`);
    const tree = await startProtectedTree(lockPath, true);
    try {
      assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, tree.outer.token);
      process.kill(tree.outer.parent, signal);
      await new Promise((resolve) => tree.parent.once("exit", resolve));
      let childAlive = true;
      try {
        process.kill(tree.inner.pid, 0);
      } catch {
        childAlive = false;
      }
      assert.equal(childAlive, true, `${signal}: the child outlives its signalled parent`);
      assert.equal(
        fs.existsSync(lockPath),
        true,
        `${signal}: the lock must not be released while the work it protects is still running`,
      );
      const contended = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "contender",
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      }).then(() => "acquired", () => "refused");
      assert.equal(contended, "refused", `${signal}: no run may take the worktree from surviving children`);
    } finally {
      try {
        process.kill(tree.inner.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      tree.parent.kill("SIGKILL");
      cleanup(lockPath);
    }
  }
});

test("a forced process.exit leaves the lock for an operator rather than releasing it", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("forced-exit");
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { acquireWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lock = await acquireWorktreeLock({ lockPath: ${JSON.stringify(lockPath)}, environment: {}, label: "exiting run", log: () => undefined });
      process.stdout.write(JSON.stringify({ token: lock.token }) + String.fromCharCode(10));
      process.exit(0);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    const announced = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("\n")) resolve(JSON.parse(out.trim()));
      });
    });
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(fs.existsSync(lockPath), true, "a forced exit must not delete the lock behind its own children");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, announced.token);
    const contended = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "acquired", () => "refused");
    assert.equal(contended, "refused");
  } finally {
    cleanup(lockPath);
  }
});

test("a kill between claim sync and publication leaves only a sweepable claim", async () => {
  const { acquireWorktreeLock, sweepWorktreeLockResidue } = await loadLock();
  const lockPath = temporaryLockPath("kill-before-publish");
  const directory = path.dirname(lockPath);
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { acquireWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      await acquireWorktreeLock({
        lockPath: ${JSON.stringify(lockPath)},
        environment: {},
        label: "killed run",
        log: () => undefined,
        hooks: {
          beforePublish: async () => {
            process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
            await new Promise(() => undefined);
          },
        },
      });
    `], { stdio: ["ignore", "pipe", "ignore"] });
    const announced = await new Promise((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (out.includes("\n")) resolve(JSON.parse(out.trim()));
      });
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    assert.equal(fs.existsSync(lockPath), false, "a kill before publication must publish no canonical lock");
    const claims = fs.readdirSync(directory);
    assert.equal(claims.length, 1, `exactly the private claim remains: ${claims.join(", ")}`);
    assert.match(claims[0], /\.lock\.claim-/u);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, claims[0]), "utf8")).pid, announced.pid);

    // The next run is not blocked by it, and the sweep clears it now that its writer is gone.
    const next = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "next run",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    await next.release();
    const removed = await sweepWorktreeLockResidue(lockPath);
    assert.deepEqual(removed, [claims[0]], "a claim whose writer is proven dead is residue");
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    cleanup(lockPath);
  }
});

test("the sweep never removes a claim that may still be mid-write", async () => {
  const { sweepWorktreeLockResidue } = await loadLock();
  const lockPath = temporaryLockPath("midwrite-claim");
  const directory = path.dirname(lockPath);
  try {
    // An empty claim is exactly what a run that has created its claim but not yet written
    // it looks like from outside.
    fs.writeFileSync(`${lockPath}.claim-in-flight`, "", "utf8");
    fs.writeFileSync(
      `${lockPath}.claim-live`,
      JSON.stringify({ token: "live", pid: process.pid, host: os.hostname(), label: "running" }),
      "utf8",
    );
    assert.deepEqual(await sweepWorktreeLockResidue(lockPath), []);
    assert.deepEqual(
      fs.readdirSync(directory).sort(),
      [`${path.basename(lockPath)}.claim-in-flight`, `${path.basename(lockPath)}.claim-live`].sort(),
    );
  } finally {
    cleanup(lockPath);
  }
});

test("recovery accepts only the exact recorded token, and one racer wins", async () => {
  const { acquireWorktreeLock, recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("recovery-race");
  try {
    const token = await writeDeadOwnerLock(lockPath).then(() => "dead-owner");
    assert.equal((await recoverWorktreeLock({ lockPath, log: () => undefined })).removed, false);
    assert.equal(
      (await recoverWorktreeLock({ lockPath, expectedToken: "wrong", log: () => undefined })).removed,
      false,
    );
    assert.equal(fs.existsSync(lockPath), true);

    const racers = await Promise.all(
      Array.from({ length: 4 }, () => recoverWorktreeLock({ lockPath, expectedToken: token, log: () => undefined })),
    );
    assert.equal(
      racers.filter((outcome) => outcome.removed).length,
      1,
      "exactly one racing recovery may remove the lock",
    );
    assert.equal(fs.existsSync(lockPath), false);
    const lock = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "next run",
      waitMs: 2_000,
      pollMs: 10,
      log: () => undefined,
    });
    await lock.release();
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
  } finally {
    cleanup(lockPath);
  }
});

test("without inodes, a fence replaced between proof and retirement survives", async () => {
  const lockPath = temporaryLockPath("fence-replaced");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      import os from "node:os";
      ${ZERO_INODE_PRELUDE(lockModule)}
      const { acquireWorktreeLock, fencePathFor } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      const fencePath = fencePathFor(lockPath);

      // A fence whose holder is provably dead, so the proof that it may be retired succeeds.
      fs.writeFileSync(fencePath, JSON.stringify({ token: "dead-fence", pid: 999999, host: os.hostname(), label: "gone" }));
      const firstReadProvedDead = (() => {
        try { process.kill(999999, 0); return false; } catch (error) { return error.code === "ESRCH"; }
      })();

      // Between that proof and the retirement, the fence is replaced by one whose holder is
      // this very process, and is therefore alive.
      const live = JSON.stringify({ token: "live-fence", pid: process.pid, host: os.hostname(), label: "living remover" });
      const contender = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "contender",
        waitMs: 400,
        pollMs: 20,
        log: () => undefined,
        hooks: {
          beforeFenceRetire: async () => {
            fs.writeFileSync(fencePath, live);
          },
        },
      }).then(() => true, () => false);
      const survivingFence = fs.existsSync(fencePath) ? JSON.parse(fs.readFileSync(fencePath, "utf8")).token : undefined;
      process.stdout.write(JSON.stringify({
        firstReadProvedDead,
        liveFenceSurvived: survivingFence === "live-fence",
        contenderAcquiredBehindLiveFence: contender,
      }));
    `);
    assert.deepEqual(result, {
      firstReadProvedDead: true,
      liveFenceSurvived: true,
      contenderAcquiredBehindLiveFence: false,
    }, "a fence replaced between proof and retirement must survive, and nothing may acquire behind it");
  } finally {
    cleanup(lockPath);
  }
});
test("the validation runner releases its isolated lock when the configuration is invalid", async () => {
  const { fencePathFor } = await loadLock();
  const lockPath = temporaryLockPath("invalid-config");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-invalid-config-"));
  try {
    fs.mkdirSync(path.join(target, ".bachata"));
    fs.writeFileSync(path.join(target, ".bachata", "policy.json"), "{ this is not valid json", "utf8");
    // The gate is invoked through its functional entry point with an isolated lock, which
    // is the only way a caller may choose one. The command line has no such option.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const { runLocalValidation } = await import(${JSON.stringify(`file://${path.join(root, "scripts", "lib", "localValidationRun.mjs")}`)});
      const findings = await runLocalValidation({
        target: ${JSON.stringify(target)},
        lockPath: ${JSON.stringify(lockPath)},
        log: () => undefined,
      });
      if (findings.length > 0) process.exitCode = 1;
    `], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    const code = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(code, 1, "an invalid configuration must fail the gate");
    assert.equal(fs.existsSync(lockPath), false, "a failing gate must still release the worktree lock");
    assert.equal(fs.existsSync(fencePathFor(lockPath)), false, "no fence may be left behind either");
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [], "and no residue of either kind");
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    cleanup(lockPath);
  }
});

// A redirectable canonical lock lets two commands in one worktree both claim ownership.
// This is proved by behaviour, not by grepping the sources: what matters is that the
// legacy variable changes neither the resolved path nor where the shipped command writes.
test("the legacy environment variable redirects neither the canonical lock nor the CLI", async () => {
  const { defaultWorktreeLockPath, fencePathFor } = await loadLock();
  const canonical = defaultWorktreeLockPath();
  const decoyDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-decoy-lock-")));
  const decoy = path.join(decoyDirectory, ".bachata-worktree.lock");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-decoy-target-"));
  try {
    const redirected = await runInChild(`
      const { defaultWorktreeLockPath } = await import(${JSON.stringify(`file://${lockModule}`)});
      process.stdout.write(JSON.stringify({ path: defaultWorktreeLockPath() }));
    `, { BACHATA_WORKTREE_LOCK_PATH: decoy });
    assert.equal(redirected.path, canonical, "the canonical path must ignore the environment");

    fs.mkdirSync(path.join(target, ".bachata"));
    fs.writeFileSync(path.join(target, ".bachata", "policy.json"), "{ this is not valid json", "utf8");
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts", "validate-local.mjs"), target],
      {
        cwd: root,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, BACHATA_WORKTREE_LOCK_PATH: decoy },
      },
    );
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(fs.existsSync(decoy), false, "the command must not take a redirected lock");
    assert.equal(fs.existsSync(fencePathFor(decoy)), false, "no redirected fence may appear");
    assert.deepEqual(
      fs.readdirSync(decoyDirectory),
      [],
      "no lock, fence, claim or retired residue may appear at the redirected path",
    );
  } finally {
    fs.rmSync(decoyDirectory, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
test("recovery instructions carry no shell metacharacters", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("instructions");
  const shellMetacharacters = /[<>|&;$`(){}[\]*?~!]/u;
  try {
    const owner = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "owner",
      log: () => undefined,
    });
    const refusal = await acquireWorktreeLock({
      lockPath,
      environment: {},
      label: "contender",
      waitMs: 200,
      pollMs: 20,
      log: () => undefined,
    }).then(() => "", (error) => error.message);
    await owner.release();

    const commandLines = String(refusal)
      .split("\n")
      .filter((line) => line.includes("worktree:unlock"));
    assert.ok(commandLines.length > 0, "the refusal states the recovery command");
    commandLines.forEach((line) => {
      assert.equal(
        shellMetacharacters.test(line),
        false,
        `a recovery instruction must be safe to paste into a shell: ${line.trim()}`,
      );
      assert.match(line, /LOCK_TOKEN/u);
    });

    const sources = [
      fs.readFileSync(path.join(root, "scripts", "worktree-unlock.mjs"), "utf8"),
      fs.readFileSync(path.join(root, "docs", "DEVELOPMENT.md"), "utf8"),
      fs.readFileSync(path.join(root, "scripts", "lib", "worktreeLock.mjs"), "utf8"),
    ];
    sources.forEach((source) => {
      assert.equal(
        /worktree:unlock -- <token>/u.test(source),
        false,
        "no source may print a placeholder the shell would read as a redirection",
      );
    });
  } finally {
    cleanup(lockPath);
  }
});

// Every file reports the same inode number, which is what a caller sees when an inode is
// reused after a delete and a create. Only the recorded token can tell the files apart.
const REUSED_INODE_PRELUDE = (lockModulePath) => `
  const { setFileIdentityReaderForTests } = await import(${JSON.stringify("LOCK")}.replace("LOCK", ${JSON.stringify(lockModulePath)}));
  const { promises: fsp } = await import("node:fs");
  setFileIdentityReaderForTests(async (candidate) => {
    const details = await fsp.lstat(candidate).catch((error) => {
      if (error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!details) return undefined;
    return Object.create(Object.getPrototypeOf(details), {
      ...Object.getOwnPropertyDescriptors(details),
      ino: { value: 4242, enumerable: true },
    });
  });
`;

test("a reused inode does not let a dead fence's retirement delete a live replacement", async () => {
  const lockPath = temporaryLockPath("aba-fence");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      import os from "node:os";
      ${REUSED_INODE_PRELUDE(lockModule)}
      const { acquireWorktreeLock, fencePathFor } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      const fencePath = fencePathFor(lockPath);
      fs.writeFileSync(fencePath, JSON.stringify({ token: "dead-fence", pid: 999999, host: os.hostname(), label: "gone" }));
      const live = JSON.stringify({ token: "live-fence", pid: process.pid, host: os.hostname(), label: "living remover" });
      const contender = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "contender",
        waitMs: 400,
        pollMs: 20,
        log: () => undefined,
        hooks: { beforeFenceRetire: async () => { fs.writeFileSync(fencePath, live); } },
      }).then(() => true, () => false);
      const survivor = fs.existsSync(fencePath) ? JSON.parse(fs.readFileSync(fencePath, "utf8")).token : undefined;
      const residue = fs.readdirSync(${JSON.stringify(path.dirname(lockPath))})
        .filter((name) => name.includes(".retired-"));
      process.stdout.write(JSON.stringify({
        replacementUsedSameReportedInode: true,
        liveFenceSurvived: survivor === "live-fence",
        contenderAcquiredBehindLiveFence: contender,
        retiredResidue: residue.length,
      }));
    `);
    assert.deepEqual(result, {
      replacementUsedSameReportedInode: true,
      liveFenceSurvived: true,
      contenderAcquiredBehindLiveFence: false,
      // A restored fence has two names for one inode. The retired name must be dropped
      // here: its record names the living replacement, and the sweep removes residue only
      // once that owner is provably dead, so cleanup would otherwise wait for that death
      // and for a later sweep to run.
      retiredResidue: 0,
    }, "a matching inode number is not identity; the recorded token must agree too");
  } finally {
    cleanup(lockPath);
  }
});

test("a reused inode does not let a release delete the lock that replaced its own", async () => {
  const lockPath = temporaryLockPath("aba-release");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      import os from "node:os";
      ${REUSED_INODE_PRELUDE(lockModule)}
      const { acquireWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      const replacement = JSON.stringify({ token: "replacement", pid: process.pid, host: os.hostname(), label: "replacement" });
      // The owner's file is replaced between its validation and its removal, and the
      // replacement reports the very same inode number. The hook fires only inside a
      // fenced removal, which for this run is its own release.
      const owner = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "owner",
        waitMs: 2000,
        pollMs: 10,
        log: () => undefined,
        hooks: { beforeFencedRename: async () => { fs.writeFileSync(lockPath, replacement); } },
      });
      await owner.release();
      const survivor = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")).token : undefined;
      const residue = fs.readdirSync(${JSON.stringify(path.dirname(lockPath))})
        .filter((name) => name.includes(".retired-"));
      process.stdout.write(JSON.stringify({
        replacementUsedSameReportedInode: true,
        replacementSurvived: survivor === "replacement",
        retiredResidue: residue.length,
      }));
    `);
    assert.deepEqual(result, {
      replacementUsedSameReportedInode: true,
      replacementSurvived: true,
      // Restoration put the replacement back under the canonical name. The retired name it
      // was moved to is dropped here rather than left for the sweep, which can only remove
      // residue whose recorded owner is provably dead: this record names a living process,
      // so the file would persist until that process exits and a later sweep runs.
      retiredResidue: 0,
    }, "a release must not delete a replacement that merely reports the same inode");
  } finally {
    cleanup(lockPath);
  }
});

test("a reused inode does not let recovery delete a replacement at the removal seam", async () => {
  const lockPath = temporaryLockPath("aba-recovery");
  try {
    const result = await runInChild(`
      import fs from "node:fs";
      import os from "node:os";
      ${REUSED_INODE_PRELUDE(lockModule)}
      const { recoverWorktreeLock } = await import(${JSON.stringify(`file://${lockModule}`)});
      const lockPath = ${JSON.stringify(lockPath)};
      fs.writeFileSync(lockPath, JSON.stringify({ token: "abandoned", pid: 999999, host: os.hostname(), label: "crashed run" }));
      const replacement = JSON.stringify({ token: "replacement", pid: process.pid, host: os.hostname(), label: "replacement" });
      const outcome = await recoverWorktreeLock({
        lockPath,
        expectedToken: "abandoned",
        log: () => undefined,
        hooks: { afterFinalProof: async () => { fs.writeFileSync(lockPath, replacement); } },
      });
      const survivor = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")).token : undefined;
      process.stdout.write(JSON.stringify({
        replacementUsedSameReportedInode: true,
        removed: outcome.removed,
        replacementSurvived: survivor === "replacement",
      }));
    `);
    assert.deepEqual(result, {
      replacementUsedSameReportedInode: true,
      removed: false,
      replacementSurvived: true,
    }, "operator recovery must not remove a replacement that appeared at the seam");
  } finally {
    cleanup(lockPath);
  }
});

test("the real validate-local command exits 1 on an invalid configuration and disturbs no lock", async () => {
  const { defaultWorktreeLockPath, fencePathFor, WORKTREE_LOCK_OWNER_ENVIRONMENT } = await loadLock();
  const canonicalLock = defaultWorktreeLockPath();
  const canonicalFence = fencePathFor(canonicalLock);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-cli-invalid-"));
  try {
    fs.mkdirSync(path.join(target, ".bachata"));
    fs.writeFileSync(path.join(target, ".bachata", "policy.json"), "{ this is not valid json", "utf8");

    // Under npm test the suite already owns the canonical lock and the command re-enters it
    // through the inherited owner token; run on its own, the command takes and releases
    // that lock itself. Either way the lock must end as it started.
    const inheritedOwner = process.env[WORKTREE_LOCK_OWNER_ENVIRONMENT];
    const lockBefore = fs.existsSync(canonicalLock);
    const fenceBefore = fs.existsSync(canonicalFence);

    const child = spawn(
      process.execPath,
      [path.join(root, "scripts", "validate-local.mjs"), target],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const code = await new Promise((resolve) => child.once("exit", resolve));

    assert.equal(
      /Another run owns this worktree/u.test(stderr),
      false,
      `the command must run, not be refused the worktree: ${stderr.slice(0, 300)}`,
    );
    assert.equal(code, 1, "the shipped command must report an invalid configuration as a failure");
    // Exit 1 alone would also be produced by an unbuilt tree or a crashed import, so the
    // report itself is asserted: the failure must be the invalid policy this test wrote.
    assert.match(stdout, /1 finding\(s\)/u, `the gate must report its findings: ${stdout.slice(0, 300)}`);
    assert.match(
      stdout,
      /\[repositoryPolicy\][^\n]*policy\.json: is not valid JSON/u,
      `the reported finding must be the invalid policy: ${stdout.slice(0, 300)}`,
    );
    assert.equal(fs.existsSync(canonicalLock), lockBefore, "the canonical lock must end as it started");
    assert.equal(fs.existsSync(canonicalFence), fenceBefore, "no fence may be left behind");
    if (inheritedOwner !== undefined && lockBefore) {
      assert.equal(
        JSON.parse(fs.readFileSync(canonicalLock, "utf8")).token,
        inheritedOwner,
        "a re-entrant command must leave the inherited owner's lock untouched",
      );
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("an unreadable lock record is recovered only on its own explicit confirmation", async () => {
  const { recoverWorktreeLock } = await loadLock();
  for (const contents of ["{ this is not json", "", "{}", JSON.stringify({ token: "" })]) {
    const lockPath = temporaryLockPath("unreadable-recovery");
    try {
      fs.writeFileSync(lockPath, contents, "utf8");
      const withoutConfirmation = await recoverWorktreeLock({
        lockPath,
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      });
      assert.equal(withoutConfirmation.removed, false);
      assert.match(withoutConfirmation.reason, /unreadable-record confirmation/u);
      assert.equal(fs.existsSync(lockPath), true, "the lock was removed without confirmation");

      const withToken = await recoverWorktreeLock({
        lockPath,
        expectedToken: "guessed",
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      });
      assert.equal(withToken.removed, false, "a guessed token recovered an unreadable lock");
      assert.equal(fs.existsSync(lockPath), true);

      const confirmed = await recoverWorktreeLock({
        lockPath,
        confirmUnreadable: true,
        waitMs: 300,
        pollMs: 20,
        log: () => undefined,
      });
      assert.equal(confirmed.removed, true, `an unreadable record (${JSON.stringify(contents)}) stayed unrecoverable`);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      cleanup(lockPath);
    }
  }
});

test("unreadable-record recovery never removes a readable lock", async () => {
  const { recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("unreadable-refuses-readable");
  const contents = JSON.stringify({ token: "live-owner", pid: process.pid, host: os.hostname() });
  try {
    fs.writeFileSync(lockPath, contents, "utf8");
    const outcome = await recoverWorktreeLock({
      lockPath,
      confirmUnreadable: true,
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
    });
    assert.equal(outcome.removed, false);
    assert.equal(fs.readFileSync(lockPath, "utf8"), contents, "a readable lock was disturbed");
  } finally {
    cleanup(lockPath);
  }
});

test("a lock that becomes readable before the fenced removal is left alone", async () => {
  const { recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("unreadable-became-readable");
  const live = JSON.stringify({ token: "arrived-later", pid: process.pid, host: os.hostname() });
  try {
    fs.writeFileSync(lockPath, "{ truncated", "utf8");
    const outcome = await recoverWorktreeLock({
      lockPath,
      confirmUnreadable: true,
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
      hooks: {
        afterRecoveryFence: async () => {
          fs.writeFileSync(lockPath, live, "utf8");
        },
      },
    });
    assert.equal(outcome.removed, false, "a lock that became readable was still removed");
    assert.equal(fs.readFileSync(lockPath, "utf8"), live);
  } finally {
    cleanup(lockPath);
  }
});

test("an unreadable lock replaced between judgement and rename is restored", async () => {
  const { recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("unreadable-aba");
  const replacement = JSON.stringify({ token: "replacement", pid: process.pid, host: os.hostname() });
  try {
    fs.writeFileSync(lockPath, "{ truncated", "utf8");
    const outcome = await recoverWorktreeLock({
      lockPath,
      confirmUnreadable: true,
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
      hooks: {
        beforeFencedRename: async () => {
          fs.rmSync(lockPath, { force: true });
          fs.writeFileSync(lockPath, replacement, "utf8");
        },
      },
    });
    assert.equal(outcome.removed, false, "recovery removed a lock that had replaced the one it judged");
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  } finally {
    cleanup(lockPath);
  }
});

test("the refusal names the unreadable recovery only when no token can be quoted", async () => {
  const { acquireWorktreeLock } = await loadLock();
  const cases = [
    ["{ this is not json", /--unreadable/u, /read the token from/u],
    [
      JSON.stringify({ token: "held", pid: process.pid, host: os.hostname() }),
      /read the token from/u,
      /--unreadable/u,
    ],
  ];
  for (const [contents, expected, forbidden] of cases) {
    const lockPath = temporaryLockPath("refusal-copy");
    try {
      fs.writeFileSync(lockPath, contents, "utf8");
      const message = await acquireWorktreeLock({
        lockPath,
        environment: {},
        label: "contender",
        waitMs: 200,
        pollMs: 20,
        log: () => undefined,
      }).then(() => "acquired", (error) => error.message);
      assert.notEqual(message, "acquired");
      assert.match(message, expected);
      assert.doesNotMatch(message, forbidden);
    } finally {
      cleanup(lockPath);
    }
  }
});

test("an unreadable lock rewritten in place, keeping its inode, is not removed", async () => {
  const { recoverWorktreeLock } = await loadLock();
  const lockPath = temporaryLockPath("unreadable-same-inode");
  const replacement = "{ a different truncated record";
  try {
    fs.writeFileSync(lockPath, "{ truncated", "utf8");
    const judgedInode = fs.statSync(lockPath).ino;
    const outcome = await recoverWorktreeLock({
      lockPath,
      confirmUnreadable: true,
      waitMs: 300,
      pollMs: 20,
      log: () => undefined,
      hooks: {
        // Rewriting through the same descriptor keeps the inode, so inode equality alone
        // would wrongly accept this as the file that was judged.
        beforeFencedRename: async () => {
          const handle = fs.openSync(lockPath, "r+");
          fs.ftruncateSync(handle, 0);
          fs.writeSync(handle, replacement, 0, "utf8");
          fs.closeSync(handle);
        },
      },
    });
    assert.equal(
      fs.statSync(lockPath).ino,
      judgedInode,
      "the fixture did not reproduce inode reuse, so it proves nothing",
    );
    assert.equal(outcome.removed, false, "a lock rewritten in place was removed on inode equality alone");
    assert.equal(fs.readFileSync(lockPath, "utf8"), replacement);
  } finally {
    cleanup(lockPath);
  }
});

// BR-9. The build holds the worktree lock and releases it on exit, so every later step in the
// composite `npm test` chain that reads dist used to do so unlocked. A concurrent build could
// rewrite or delete dist while policy-doc generation imported two modules from it and while
// build-facts walked it recursively. Both windows must now contend for the same lock.
test("every dist consumer in the composite chain takes the worktree lock", async () => {
  const { acquireWorktreeLock } = await import(
    `file://${path.join(root, "scripts", "lib", "worktreeLock.mjs")}`
  );
  // build-facts runs in write mode into a scratch file: `--check` would couple this
  // regression to whether BUILD_FACTS.md happens to be current, which is a different gate.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-composite-lock-"));
  const distConsumers = [
    ["scripts/generate-policy-docs.mjs", "--check"],
    ["scripts/build-facts.mjs", "--out", path.join(scratch, "BUILD_FACTS.md")],
  ];
  // `owner` decides whether the child inherits this run's lock or has to contend for it. The
  // suite itself may already hold the lock, so the free case is expressed as inheritance
  // rather than as an absent lock, and both cases hold whatever the ambient state is.
  const runWith = (argv, owner) => spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BACHATA_WORKTREE_LOCK_OWNER: owner, BACHATA_WORKTREE_LOCK_WAIT_MS: "300" },
  });

  const held = await acquireWorktreeLock({ label: "composite lock regression" });
  try {
    for (const argv of distConsumers) {
      assert.notEqual(
        runWith(argv, "").status,
        0,
        `${argv[0]} read dist while another process held the worktree lock`,
      );
      const inherited = runWith(argv, held.token);
      assert.equal(
        inherited.status,
        0,
        `${argv[0]} refused an inherited lock: ${inherited.stderr || inherited.stdout}`,
      );
    }
  } finally {
    await held.release();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
