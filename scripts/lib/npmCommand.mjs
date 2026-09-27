/*
 * EX-G6-16. One platform-correct way to start npm.
 *
 * On Windows `npm` is `npm.cmd`, a batch shim, and since the CVE-2024-27980 fix Node refuses to
 * execute `.cmd` and `.bat` files unless a command interpreter is asked for explicitly. A
 * `spawnSync("npm.cmd", args)` — or worse, one that passes `shell: false` — therefore fails with
 * EINVAL on every current Node on Windows, so packaging and the lockfile gate could not run there
 * at all. Two scripts had the executable right and the interpreter wrong, and two others had both
 * right, which is exactly the drift one shared helper removes.
 *
 * Arguments stay an array. Under `shell: true` Windows joins them for `cmd.exe`, so every caller
 * here passes plain npm subcommands and flags with no spaces or shell metacharacters in them.
 */
import { existsSync } from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";
const windowsNpm = () => {
  const directories = (process.env.Path ?? process.env.PATH ?? "").split(path.delimiter);
  for (const directory of directories) {
    const candidate = path.join(directory.replace(/^"|"$/gu, ""), "npm.cmd");
    if (existsSync(candidate)) return "npm.cmd";
  }
  return "npm.exe";
};

export const npmExecutable = isWindows ? windowsNpm() : "npm";

export const npmSpawnOptions = (options = {}) => ({
  ...options,
  windowsHide: true,
  ...(npmExecutable === "npm.cmd" ? { shell: true } : {}),
});
