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

// Two spellings of one absolute directory are one directory on Windows: the filesystem is
// case-insensitive and accepts either separator, so `C:\Users\x` and `c:/users/x` name the same
// place. Comparing them byte for byte reported an open workspace root as closed. The platform is
// read off the value rather than off `process`, because this module is shared with the webview
// and holds no node import.
const windowsAbsolute = (value: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value);

export const normalizeAbsolutePathIdentity = (value: string): string => {
  const trimmed = value.replace(/[\\/]+$/u, "");
  // A backslash is a legal character in a POSIX filename, so separators are folded only where
  // the value is a Windows path and the fold cannot change which file is named.
  return windowsAbsolute(trimmed) ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
};

export const absolutePathWithinDirectory = (directory: string, candidate: string): boolean => {
  const base = normalizeAbsolutePathIdentity(directory);
  if (base.length === 0) return false;
  const target = normalizeAbsolutePathIdentity(candidate);
  return target === base || target.startsWith(`${base}/`);
};

export const relativePathWithinDirectory = (directory: string, candidate: string): boolean => {
  if (isAbsoluteLikePath(directory) || isAbsoluteLikePath(candidate)) return false;
  if (hasTraversalSegment(directory) || hasTraversalSegment(candidate)) return false;
  const root = normalizeRelativeRepositoryPath(directory);
  const target = normalizeRelativeRepositoryPath(candidate);
  if (root.length === 0 || target.length === 0) return false;
  return target === root || target.startsWith(`${root}/`);
};
