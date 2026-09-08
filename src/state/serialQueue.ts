/**
 * EX-3. One operation at a time, expressed once.
 *
 * Three places serialise mutations this way — webview messages that change state, execution-lease
 * changes per conversation, and pipeline catalog writes. Each had its own copy of the same two
 * lines, and each copy had to get the same subtlety right: the caller is handed the operation's
 * own promise, rejection included, while the chain the next operation waits on is a settled one.
 * A chain that carried the rejection would refuse every later operation because an earlier one
 * failed.
 */
export const chainSerially = <T>(
  previous: Promise<unknown>,
  operation: () => Promise<T>,
): { result: Promise<T>; settled: Promise<void> } => {
  const result = previous.then(operation, operation);
  return {
    result,
    settled: result.then(
      () => undefined,
      () => undefined,
    ),
  };
};
