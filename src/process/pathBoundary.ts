import * as path from "node:path";

export const normalizePathIdentity = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;

export const samePathIdentity = (left: string, right: string): boolean =>
  normalizePathIdentity(path.resolve(left)) === normalizePathIdentity(path.resolve(right));

export const pathInsideRelative = (root: string, candidate: string): string | undefined => {
  const relative = path.relative(
    normalizePathIdentity(path.resolve(root)),
    normalizePathIdentity(path.resolve(candidate)),
  );
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
    ? relative
    : undefined;
};

export const isPathInsideRoot = (root: string, candidate: string): boolean =>
  pathInsideRelative(root, candidate) !== undefined;
