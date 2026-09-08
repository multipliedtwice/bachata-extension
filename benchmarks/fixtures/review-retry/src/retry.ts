export type RetryOptions = {
  attempts: number;
  delayMs: number;
};

export const retry = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
  throw lastError;
};

export const retryForever = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (;;) {
    try {
      return await operation();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
};
