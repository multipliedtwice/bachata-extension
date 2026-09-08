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
const isWindows = process.platform === "win32";

export const npmExecutable = isWindows ? "npm.cmd" : "npm";

export const npmSpawnOptions = (options = {}) => ({
  ...options,
  windowsHide: true,
  ...(isWindows ? { shell: true } : {}),
});
