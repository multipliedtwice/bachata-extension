const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

// EX-UI-04. The browser layout gate starts a real Chrome. Two things about that were unowned.
//
// A failure between the spawn and the first usable command returned nothing to the caller, so the
// caller's cleanup — which could only close what it had been handed — closed nothing, and the
// browser stayed running for as long as the machine did. And the waits in between had no bounds
// at all: target discovery, the socket handshake and every CDP request would wait forever, inside
// an `npm test` that puts no outer bound on the gate.
//
// Neither failure is reachable from a passing run, and neither shows up in a green suite. They are
// driven here through injected collaborators instead: a child that ignores signals, a socket that
// never opens, a browser that answers nothing. Every case asserts the same two things — the error
// says what happened, and nothing was left behind.
const root = path.join(__dirname, "..");
const sessionModule = path.join(root, "scripts", "lib", "chromeSession.mjs");
const loadSession = () => import(`file://${sessionModule}`);

// A real timer, with the tiny bounds below. A wait that resolved on the microtask queue would
// always beat the child's own exit event and turn every polite termination into a SIGKILL.
const briefly = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Tiny bounds so a deadline that fires is the point of the test rather than its duration.
const DEADLINES = {
  port: 40,
  discovery: 40,
  discoveryRequest: 20,
  discoveryPoll: 1,
  socket: 40,
  command: 40,
  terminateGrace: 20,
  terminateKill: 20,
};

const fakeChild = ({ diesOn = "SIGTERM", pid = 4242 } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    if (diesOn === signal || diesOn === "any") {
      child.signalCode = signal;
      setImmediate(() => { child.emit("exit", null, signal); });
    }
    return true;
  };
  return child;
};

const stopped = (child) => child.exitCode !== null || child.signalCode !== null;

const fakeSocket = ({ opens = true, answers = true } = {}) => {
  const socket = {
    readyState: 0,
    sent: [],
    closed: 0,
    answering: answers,
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
  };
  socket.close = () => {
    socket.closed += 1;
    socket.readyState = 3;
  };
  socket.send = (payload) => {
    const request = JSON.parse(payload);
    socket.sent.push(request);
    if (!socket.answering) return;
    setImmediate(() => {
      if (socket.onmessage) socket.onmessage({ data: JSON.stringify({ id: request.id, result: {} }) });
    });
  };
  setImmediate(() => {
    if (!opens) {
      if (socket.onerror) socket.onerror(new Error("refused"));
      return;
    }
    socket.readyState = 1;
    if (socket.onopen) socket.onopen();
  });
  return socket;
};

const openWith = async (overrides) => {
  const { openCdpSession } = await loadSession();
  const child = overrides.child ?? fakeChild();
  const session = await openCdpSession({
    launch: () => child,
    readPort: async () => 9222,
    fetchTargets: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/page" }],
    createSocket: () => overrides.socket,
    wait: briefly,
    deadlines: DEADLINES,
    ...overrides.session,
  });
  return { child, session };
};

test("a browser that never reports a debugging port is stopped before the failure leaves", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => { throw new Error("Chrome never wrote DevToolsActivePort"); },
      fetchTargets: async () => [],
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /Chrome never wrote DevToolsActivePort/u,
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(stopped(child), true);
});

test("a port read that hangs is bounded, and the browser it started is stopped", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  let portSignal;
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: (_child, signal) => {
        portSignal = signal;
        return new Promise(() => {});
      },
      fetchTargets: async () => [],
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /Chrome never reported a debugging port/u,
  );
  assert.equal(portSignal.aborted, true, "the session deadline did not cancel port polling");
  assert.equal(stopped(child), true);
});

test("a failed Chrome startup retains only its bounded stderr tail and original error", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  child.stderr = new PassThrough();
  const original = new Error("Chrome exited before it reported a debugging port");
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => {
        child.stderr.write("discarded-startup-prefix");
        child.stderr.write("x".repeat(20 * 1024));
        child.stderr.write("\nChrome launch failure detail");
        throw original;
      },
      wait: briefly,
      deadlines: DEADLINES,
    }),
    (error) => {
      assert.equal(error.cause, original);
      assert.match(error.message, /Chrome launch failure detail$/u);
      assert.doesNotMatch(error.message, /discarded-startup-prefix/u);
      const tail = error.message.split("Chrome stderr (last 16384 bytes):\n")[1];
      assert.equal(Buffer.byteLength(tail), 16 * 1024);
      assert.equal(stopped(child), true);
      return true;
    },
  );
  assert.equal(child.stderr.listenerCount("data"), 0);
  child.stderr.destroy();
});

test("a connected Chrome stops retaining stderr and keeps draining the pipe", async () => {
  const { closeCdpSession } = await loadSession();
  const child = fakeChild();
  child.stderr = new PassThrough();
  const { session } = await openWith({ child, socket: fakeSocket() });
  try {
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(child.stderr.readableFlowing, true);
  } finally {
    await closeCdpSession(session, { wait: briefly, deadlines: DEADLINES });
    child.stderr.destroy();
  }
});

test("a browser that exposes no debuggable page is bounded and stopped", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  let attempts = 0;
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => 9222,
      fetchTargets: async () => { attempts += 1; return []; },
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /Chrome exposed no debuggable page/u,
  );
  assert.ok(attempts > 0, "the target list was never asked for");
  assert.equal(stopped(child), true);
});

test("a target listing that never answers is bounded rather than awaited forever", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => 9222,
      fetchTargets: () => new Promise(() => {}),
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /did not answer the DevTools target list in time/u,
  );
  assert.equal(stopped(child), true);
});

test("a browser that exits during discovery is reported as an exit, not as a timeout", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  child.exitCode = 3;
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => 9222,
      fetchTargets: async () => [],
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /Chrome exited before it exposed a debuggable page/u,
  );
});

test("a socket that refuses to open leaves neither a socket nor a browser behind", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  const socket = fakeSocket({ opens: false });
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => 9222,
      fetchTargets: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/page" }],
      createSocket: () => socket,
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /Could not attach to the Chrome page/u,
  );
  assert.ok(socket.closed > 0, "the socket that failed to open was not closed");
  assert.equal(stopped(child), true);
});

test("a socket that never opens at all is bounded, closed and its browser stopped", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild();
  const quiet = {
    readyState: 0,
    closed: 0,
    onopen: null,
    onerror: null,
    onclose: null,
    onmessage: null,
    close() { this.closed += 1; },
    send() {},
  };
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => 9222,
      fetchTargets: async () => [{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9222/page" }],
      createSocket: () => quiet,
      wait: briefly,
      deadlines: DEADLINES,
    }),
    /did not accept a DevTools connection in time/u,
  );
  assert.ok(quiet.closed > 0, "a socket that never opened was left open");
  assert.equal(stopped(child), true);
});

test("a browser that will not stop is reported next to the failure that started the shutdown", async () => {
  const { openCdpSession } = await loadSession();
  const child = fakeChild({ diesOn: "never" });
  await assert.rejects(
    openCdpSession({
      launch: () => child,
      readPort: async () => { throw new Error("Chrome never wrote DevToolsActivePort"); },
      fetchTargets: async () => [],
      createSocket: () => fakeSocket(),
      wait: briefly,
      deadlines: DEADLINES,
    }),
    (error) => {
      assert.ok(error instanceof AggregateError, "the two failures were not reported together");
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /Chrome never wrote DevToolsActivePort/u);
      assert.match(error.message, /a browser was left running/u);
      return true;
    },
  );
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("a CDP request that is never answered is bounded and leaves no pending waiter", async () => {
  const socket = fakeSocket();
  const { session } = await openWith({ socket });
  assert.equal(session.pendingRequests(), 0);
  socket.answering = false;
  await assert.rejects(
    session.send("Runtime.evaluate", { expression: "1" }),
    /Chrome did not answer Runtime\.evaluate within 40ms/u,
  );
  assert.equal(session.pendingRequests(), 0);
});

test("a browser that exits mid-measurement rejects what is waiting on it", async () => {
  const socket = fakeSocket();
  const { child, session } = await openWith({ socket });
  socket.answering = false;
  const waiting = session.send("Page.enable");
  child.exitCode = 9;
  child.emit("exit", 9, null);
  await assert.rejects(waiting, /Chrome exited \(9\) while the layout gate was measuring/u);
  assert.equal(session.pendingRequests(), 0);
});

test("a socket that closes mid-measurement rejects what is waiting on it", async () => {
  const socket = fakeSocket();
  const { session } = await openWith({ socket });
  socket.answering = false;
  const waiting = session.send("Page.enable");
  socket.onclose();
  await assert.rejects(waiting, /socket closed while the layout gate was measuring/u);
  assert.equal(session.pendingRequests(), 0);
});

test("a send on a socket that is no longer open is refused rather than queued", async () => {
  const socket = fakeSocket();
  const { session } = await openWith({ socket });
  socket.readyState = 3;
  await assert.rejects(session.send("Page.enable"), /The Chrome DevTools socket is not open/u);
  assert.equal(session.pendingRequests(), 0);
});

test("closing the session closes the socket and stops the browser", async () => {
  const { closeCdpSession } = await loadSession();
  const socket = fakeSocket();
  const { child, session } = await openWith({ socket });
  await closeCdpSession(session, { wait: briefly, deadlines: DEADLINES });
  assert.ok(socket.closed > 0);
  assert.equal(stopped(child), true);
  await closeCdpSession(undefined, { wait: briefly, deadlines: DEADLINES });
});

test("stopping a browser escalates to SIGKILL and reports one that survives both", async () => {
  const { endChild } = await loadSession();
  const polite = fakeChild({ diesOn: "SIGTERM" });
  await endChild(polite, { wait: briefly, deadlines: DEADLINES });
  assert.deepEqual(polite.kills, ["SIGTERM"]);

  const stubborn = fakeChild({ diesOn: "SIGKILL" });
  await endChild(stubborn, { wait: briefly, deadlines: DEADLINES });
  assert.deepEqual(stubborn.kills, ["SIGTERM", "SIGKILL"]);

  const immortal = fakeChild({ diesOn: "never", pid: 77 });
  await assert.rejects(
    endChild(immortal, { wait: briefly, deadlines: DEADLINES }),
    /Chrome \(pid 77\) did not exit; a browser was left running/u,
  );

  const already = fakeChild();
  already.exitCode = 0;
  await endChild(already, { wait: briefly, deadlines: DEADLINES });
  assert.deepEqual(already.kills, []);
});

// The gate itself cannot be imported — it runs on import, and running it starts a browser — so the
// two properties it owns rather than delegates are read from its source.
test("the layout gate delegates ownership and addresses the fixture as a URL", async () => {
  const source = await fs.promises.readFile(path.join(root, "scripts", "run-webview-layout.mjs"), "utf8");
  assert.match(source, /openCdpSession\(\{/u);
  assert.match(source, /closeCdpSession\(session\)/u);
  assert.match(source, /pathToFileURL\(fixture\)\.href/u);
  // A path pasted after `file://` breaks on a space, a `#` or a `%` in the checkout's own path.
  assert.doesNotMatch(source, /file:\/\/\$\{fixture\}/u);
  const cleanup = source.slice(source.lastIndexOf("} finally {"));
  // The profile is removed even when stopping the browser fails, which is why the two are
  // separately guarded and why the removal is not written after an unguarded await.
  assert.match(cleanup, /try \{\s*await closeCdpSession\(session\);\s*\} catch/u);
  assert.ok(
    cleanup.indexOf("rmSync(profile") > cleanup.indexOf("closeCdpSession"),
    "the profile is removed before the browser is stopped",
  );
  assert.match(cleanup, /failures\.push\(stranded\)/u);
});
