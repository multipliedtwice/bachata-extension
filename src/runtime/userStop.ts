export class UserStopError extends Error {
  constructor() {
    super("Stopped by you");
    this.name = "UserStopError";
  }
}

export const stoppedByUser = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && signal.reason instanceof UserStopError;
