import * as path from "node:path";

const excludedDirectories = new Set([
  "node_modules", "vendor", ".yarn", ".pnpm-store", "bower_components", ".gradle", ".m2", ".git", ".hg", ".svn", ".bachata", ".pair",
  "dist", "build", "out", "target", "coverage", ".nyc_output", ".next", ".nuxt",
  ".output", ".cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".turbo", ".parcel-cache", ".svelte-kit", ".venv", "venv", "test-results",
  "allure-results", "allure-report", "htmlcov", "playwright-report", "blob-report", "cypress-videos", "cypress-screenshots",
]);
const lockfiles = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "shrinkwrap.yaml",
  "packages.lock.json", "bun.lockb", "poetry.lock", "pipfile.lock", "pdm.lock",
  "uv.lock", "cargo.lock", "composer.lock", "gemfile.lock", "go.sum", "mix.lock",
  "package.resolved", "podfile.lock", "pubspec.lock", "flake.lock",
]);
const packagedOrGenerated = /\.(?:lock|vsix|crx|xpi|zip|tar|tgz|gz|bz2|xz|7z|rar|zst|dmg|pkg|msi|exe|deb|rpm|appimage|jar|war|ear|whl|egg|cab|iso|img|bz|tbz|tbz2|txz|lz|lzma|lz4|nupkg|apk|aab|ipa|msix|appx|map|webm|mp4|mov|avi)$/iu;
const absolute = (value: string): boolean => path.posix.isAbsolute(value) || path.win32.isAbsolute(value);

export const isBrowserSourcePath = (value: string): boolean => {
  if (absolute(value)) return false;
  const parts = value.replace(/\\/g, "/").toLowerCase().split("/");
  const basename = parts.at(-1) ?? "";
  return !parts.some((part) => excludedDirectories.has(part) || part === "..")
    && !lockfiles.has(basename) && !packagedOrGenerated.test(basename)
    && !/(?:^|\/)cypress\/(?:videos|screenshots)(?:\/|$)/u.test(parts.join("/"));
};

export const browserAttachmentPath = (value: string, workspaceRoot?: string): string => {
  if (!absolute(value)) return value;
  const paths = path.win32.isAbsolute(value) && !path.posix.isAbsolute(value) ? path.win32 : path;
  if (workspaceRoot) {
    const relative = paths.relative(workspaceRoot, value);
    if (relative && !absolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`)) return relative;
  }
  return value.replace(/^[a-z]:/iu, "").replace(/^[\\/]+/u, "");
};

export const assertBrowserSourcePath = (value: string): void => {
  if (!isBrowserSourcePath(value)) throw new Error(`Browser context excludes lockfiles and generated artifacts or non-source paths: ${path.basename(value)}`);
};

export const assertBrowserAttachmentSource = (
  filePath: string,
  attachments: readonly { name: string; relativePath: string }[],
  workspaceRoot?: string,
): void => {
  const metadata = attachments.find((entry) => path.win32.basename(entry.relativePath) === path.win32.basename(filePath));
  assertBrowserSourcePath(browserAttachmentPath(filePath, workspaceRoot));
  if (metadata) assertBrowserSourcePath(metadata.name);
};

export const browserSourceDiff = (diff: string): string => diff.split(/(?=^diff --git )/m)
  .filter((block) => {
    if (!block.startsWith("diff --git ")) return false;
    const header = block.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(header);
    return Boolean(match && isBrowserSourcePath(match[1] ?? "") && isBrowserSourcePath(match[2] ?? ""));
  })
  .map((block) => block.replace(/^index [a-f0-9]+\.\.[a-f0-9]+(?: [0-7]+)?\r?\n/gm, ""))
  .join("");
