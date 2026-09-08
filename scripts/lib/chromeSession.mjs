/**
 * A bounded, self-cleaning DevTools session over a Chrome the caller started.
 *
 * Two properties are what this module exists for, and both were absent when the layout gate
 * inlined this work:
 *
 * OWNERSHIP. A failure between the spawn and the first usable command left the browser running
 * with nobody holding a reference to it: the caller's `finally` could only clean up what the
 * connect call had already returned, and a connect that threw returned nothing. So the session
 * owns the child from the moment it is launched, and every failure path stops it before the error
 * leaves this module.
 *
 * DEADLINES. Target discovery, the socket handshake and every CDP request waited forever. The gate
 * runs inside `npm test`, which puts no outer bound on it, so one unresponsive browser hung the
 * whole suite with no output. Each of those waits now has its own bound, and a bound that fires
 * cancels what it was waiting on rather than abandoning it.
 *
 * Every collaborator is a parameter — the launch, the port read, the target listing, the socket
 * constructor, the sleep — so the failure paths can be driven from a test without a browser.
 */

export const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const DEADLINES = {
  port: 20_000,
  discovery: 20_000,
  discoveryRequest: 5_000,
  discoveryPoll: 100,
  socket: 15_000,
  command: 30_000,
  terminateGrace: 5_000,
  terminateKill: 2_000,
};

/** WebSocket.OPEN, stated rather than read off the global, so an injected socket needs no class. */
const SOCKET_OPEN = 1;

/**
 * A bound around one wait. `cancel` runs when the bound fires and not otherwise, so the operation
 * that lost the race releases what it was holding — an in-flight request, a pending CDP id —
 * instead of settling later into nothing.
 */
export const withDeadline = (ms, message, start, cancel) => {
  let timer;
  const bounded = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (cancel) cancel();
      reject(new Error(message));
    }, ms);
    try {
      Promise.resolve(start()).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  return bounded.finally(() => { clearTimeout(timer); });
};

/** Bounded, and only ever the child the caller started. */
export const endChild = async (child, { wait = delay, deadlines = DEADLINES } = {}) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => { child.once("exit", resolve); });
  child.kill("SIGTERM");
  const settled = await Promise.race([exited.then(() => true), wait(deadlines.terminateGrace).then(() => false)]);
  if (settled) return;
  child.kill("SIGKILL");
  await Promise.race([exited, wait(deadlines.terminateKill)]);
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Chrome (pid ${String(child.pid)}) did not exit; a browser was left running`);
  }
};

const closeQuietly = (socket) => {
  if (!socket) return;
  try {
    socket.close();
  } catch { /* a socket that never opened, or already closed */ }
};

/**
 * The default target listing, bounded at the transport as well as by `withDeadline`: an aborted
 * request frees its socket, where a raced one would keep reading a browser nobody is waiting for.
 */
const defaultFetchTargets = async (port, signal) => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json`, { signal });
  return await response.json();
};

const discoverPage = async ({ port, child, fetchTargets, wait, deadlines }) => {
  const stopAt = Date.now() + deadlines.discovery;
  let lastError;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Chrome exited before it exposed a debuggable page");
    }
    try {
      const targets = await withDeadline(
        deadlines.discoveryRequest,
        "Chrome did not answer the DevTools target list in time",
        () => fetchTargets(port, AbortSignal.timeout(deadlines.discoveryRequest)),
      );
      const page = Array.isArray(targets)
        ? targets.find((target) => target && target.type === "page" && target.webSocketDebuggerUrl)
        : undefined;
      if (page) return page;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= stopAt) break;
    await wait(deadlines.discoveryPoll);
  }
  throw new Error(
    lastError
      ? `Chrome exposed no debuggable page (${lastError.message})`
      : "Chrome exposed no debuggable page",
  );
};

/**
 * Opens the session, or leaves nothing behind.
 *
 * The child is launched here and stopped here. `launch` returns it, and from that point every
 * `throw` below passes through the one cleanup path: waiting requests are rejected, the socket is
 * closed, the browser is stopped, and only then does the original failure leave. A browser that
 * refuses to stop is not allowed to hide the failure that started the shutdown, so both are
 * reported together.
 */
export const openCdpSession = async ({
  launch,
  readPort,
  fetchTargets = defaultFetchTargets,
  createSocket = (url) => new WebSocket(url),
  wait = delay,
  deadlines = DEADLINES,
}) => {
  const child = launch();
  const pending = new Map();
  // A socket or a browser that goes away must reject what is waiting on it. Left alone those
  // promises never settle and the run hangs until its outer bound kills it, reporting nothing.
  const abandon = (reason) => {
    const error = new Error(reason);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  child.once("exit", (code, signal) => {
    abandon(`Chrome exited (${signal ?? String(code)}) while the layout gate was measuring`);
  });
  let socket;
  try {
    const port = await withDeadline(
      deadlines.port,
      "Chrome never reported a debugging port",
      () => readPort(child),
    );
    const page = await discoverPage({ port, child, fetchTargets, wait, deadlines });
    socket = createSocket(page.webSocketDebuggerUrl);
    await withDeadline(
      deadlines.socket,
      "Chrome did not accept a DevTools connection in time",
      () => new Promise((resolve, reject) => {
        socket.onopen = () => { resolve(undefined); };
        socket.onerror = () => { reject(new Error("Could not attach to the Chrome page")); };
        socket.onclose = () => { reject(new Error("The Chrome DevTools socket closed before it opened")); };
      }),
      () => { closeQuietly(socket); },
    );
    socket.onerror = () => { abandon("The Chrome DevTools socket failed while the layout gate was measuring"); };
    socket.onclose = () => { abandon("The Chrome DevTools socket closed while the layout gate was measuring"); };
    let id = 0;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
    const send = (method, params = {}) => {
      if (socket.readyState !== SOCKET_OPEN) {
        return Promise.reject(new Error("The Chrome DevTools socket is not open"));
      }
      id += 1;
      const request = id;
      return withDeadline(
        deadlines.command,
        `Chrome did not answer ${method} within ${String(deadlines.command)}ms`,
        () => new Promise((resolve, reject) => {
          pending.set(request, { resolve, reject });
          try {
            socket.send(JSON.stringify({ id: request, method, params }));
          } catch (error) {
            pending.delete(request);
            reject(error);
          }
        }),
        () => { pending.delete(request); },
      );
    };
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
      }
      return result.result.value;
    };
    await send("Runtime.enable");
    await send("Page.enable");
    return { child, socket, send, evaluate, pendingRequests: () => pending.size };
  } catch (error) {
    abandon("the layout gate is shutting down after a failed connection");
    closeQuietly(socket);
    let stranded;
    try {
      await endChild(child, { wait, deadlines });
    } catch (problem) {
      stranded = problem;
    }
    if (stranded) {
      throw new AggregateError(
        [error, stranded],
        `${error.message} — and the browser it started could not be stopped: ${stranded.message}`,
      );
    }
    throw error;
  }
};

/** The other half of `openCdpSession`: the caller closes what it was given, the same way. */
export const closeCdpSession = async (session, { wait = delay, deadlines = DEADLINES } = {}) => {
  if (!session) return;
  closeQuietly(session.socket);
  await endChild(session.child, { wait, deadlines });
};
