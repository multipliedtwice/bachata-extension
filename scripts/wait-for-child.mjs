export const waitForChild = async (processScope, options) => {
  const timeoutMs = Math.max(1, options.timeoutMs);
  const graceMs = Math.max(1, options.graceMs);
  let timedOut = false;
  let settleTermination;
  const terminationOutcome = new Promise((resolve) => {
    settleTermination = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    void processScope.terminate(graceMs).then(
      (cleanupConfirmed) => settleTermination({ cleanupConfirmed }),
      () => settleTermination({ cleanupConfirmed: false }),
    );
  }, timeoutMs);

  let result;
  try {
    result = await Promise.race([processScope.result, terminationOutcome]);
  } finally {
    clearTimeout(timeout);
  }
  if (timedOut) {
    const suffix = result.cleanupConfirmed ? "" : "; process scope cleanup could not be confirmed";
    throw new Error(`${options.label} exceeded ${String(timeoutMs)} ms${suffix}`);
  }
  if (result.error) {
    throw new Error(`${options.label}: ${result.error}`);
  }
  if (!result.cleanupConfirmed) {
    throw new Error(`${options.label} process scope cleanup could not be confirmed`);
  }
  return {
    code: result.exitCode ?? null,
    signal: result.signal ?? null,
  };
};
