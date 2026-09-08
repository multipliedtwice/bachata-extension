const exitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
};

export const installTerminationHandlers = ({
  getProcessScope,
  cleanup = async () => undefined,
  graceMs = 2_000,
}) => {
  let handling = false;
  let completion;
  const listeners = new Map();

  const start = (signal) => {
    if (handling) {
      return;
    }
    handling = true;
    completion = (async () => {
      const failures = [];
      const processScope = getProcessScope();
      if (processScope) {
        try {
          if (!await processScope.terminate(graceMs)) {
            failures.push(new Error(`Failed to terminate the active process scope after ${signal}`));
          }
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
      for (const failure of failures) {
        console.error(failure);
      }
      return failures.length === 0 ? exitCodes[signal] : 1;
    })();
    void completion.then((exitCode) => process.exit(exitCode));
  };

  for (const signal of Object.keys(exitCodes)) {
    const listener = () => start(signal);
    listeners.set(signal, listener);
    process.on(signal, listener);
  }

  return {
    isHandling: () => handling,
    waitForCompletion: async () => completion ? completion : undefined,
    remove: () => {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    },
  };
};
