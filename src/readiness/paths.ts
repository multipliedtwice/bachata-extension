const absolutePattern = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;

export const isAbsoluteLikePath = (value: string): boolean => absolutePattern.test(value);

export const normalizeRelativeRepositoryPath = (value: string): string =>
  value
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");

export const hasTraversalSegment = (value: string): boolean =>
  value.replaceAll("\\", "/").split("/").includes("..");

export const relativePathWithinDirectory = (directory: string, candidate: string): boolean => {
  if (isAbsoluteLikePath(directory) || isAbsoluteLikePath(candidate)) return false;
  if (hasTraversalSegment(directory) || hasTraversalSegment(candidate)) return false;
  const root = normalizeRelativeRepositoryPath(directory);
  const target = normalizeRelativeRepositoryPath(candidate);
  if (root.length === 0 || target.length === 0) return false;
  return target === root || target.startsWith(`${root}/`);
};
