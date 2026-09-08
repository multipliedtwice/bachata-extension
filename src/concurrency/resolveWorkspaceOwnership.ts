export type WorkspaceOwnershipRetryOptions<T> = {
  initialReason: string;
  prompt: (reason: string) => Promise<"Retry" | "Dismiss" | undefined>;
  waitForRetry: () => Promise<void>;
  acquire: () => Promise<T>;
  retryReason: (error: unknown) => string;
  block: (reason: string) => void;
  notifyRetryFailure: (reason: string) => Promise<void>;
};

export const resolveWorkspaceOwnershipAfterFailure = async <T>(
  options: WorkspaceOwnershipRetryOptions<T>,
): Promise<T | undefined> => {
  const choice = await options.prompt(options.initialReason);
  if (choice !== "Retry") {
    options.block(options.initialReason);
    return undefined;
  }
  await options.waitForRetry();
  try {
    return await options.acquire();
  } catch (error) {
    const reason = options.retryReason(error);
    options.block(reason);
    await options.notifyRetryFailure(reason);
    return undefined;
  }
};
