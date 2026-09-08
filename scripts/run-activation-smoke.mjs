/**
 * Activation smoke runner: one Extension Development Host, one journey, no human in the loop.
 *
 * This is not the human E2E suite and does not ask for its confirmation: it starts no provider,
 * submits no run and touches no shared resource. It opens a throwaway workspace in a real VS Code
 * window, activates the extension from this checkout, and lets `e2e/activation/index.cjs` assert
 * what the product actually served.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platformSpawnOptions = process.platform === "win32" ? { shell: true } : {};

const available = (executable) =>
  spawnSync(executable, ["--version"], { stdio: "ignore", ...platformSpawnOptions }).status === 0;

/**
 * The VS Code BINARY, not its `code` launcher.
 *
 * `code` hands the arguments to a running or newly spawned window and returns immediately with
 * status 0, so a suite that threw inside the Extension Host looked exactly like a suite that
 * passed. The Electron binary runs the host in this process's foreground and exits with the
 * suite's own status, which is the only thing that makes this smoke evidence.
 */
const resolveVscodeBinary = () => {
  const configured = process.env.BACHATA_VSCODE_BINARY?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`BACHATA_VSCODE_BINARY does not exist: ${configured}`);
    }
    return configured;
  }
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
      "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
      "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code",
      "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron",
    ]
    : process.platform === "win32"
      ? ["Code.exe", "Code - Insiders.exe"]
      : ["/usr/share/code/code", "/usr/bin/code"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "The VS Code binary was not found. Set BACHATA_VSCODE_BINARY to it (on macOS: /Applications/Visual Studio Code.app/Contents/MacOS/Code).",
  );
};

/**
 * The environment a fresh VS Code may be started in.
 *
 * Run from a VS Code integrated terminal, this process inherits `ELECTRON_RUN_AS_NODE=1` — which
 * makes the VS Code binary behave as plain Node and reject every window flag — and
 * `VSCODE_IPC_HOOK`, which makes the `code` launcher hand the arguments to the ALREADY RUNNING
 * window and return 0 immediately. Both turn a smoke that never ran into a smoke that reports
 * success, so both are removed rather than trusted.
 */
const hostEnvironment = () => {
  const environment = { ...process.env, BACHATA_HUMAN_E2E: "1" };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("VSCODE_") || name === "ELECTRON_RUN_AS_NODE") {
      delete environment[name];
    }
  }
  return environment;
};

// A window that never closes is a hang, not a pass, so the host is given a deadline of its own.
const HOST_TIMEOUT_MS = 600_000;

const run = (executable, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${executable} did not finish within ${String(HOST_TIMEOUT_MS)}ms`));
    }, HOST_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${executable} exited with ${String(code ?? signal)}`));
    });
  });

const cli = resolveVscodeBinary();
// VS Code opens a Unix socket under the user-data directory, and a socket path over 103 bytes is
// rejected by the kernel. macOS's per-user temporary directory is already most of that budget, so
// the smoke gets a short root and short subdirectory names.
const temporaryBase = process.platform === "darwin" ? "/tmp" : tmpdir();
const temporaryRoot = await mkdtemp(path.join(temporaryBase, "bcs-"));
try {
  const userDataDirectory = path.join(temporaryRoot, "ud");
  const extensionsDirectory = path.join(temporaryRoot, "ex");
  const workspaceDirectory = path.join(temporaryRoot, "ws");
  await Promise.all([
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(extensionsDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const evidencePath = path.join(workspaceDirectory, "activation-evidence.json");
  await writeFile(
    path.join(workspaceDirectory, "README.md"),
    "# Bachata activation smoke workspace\n",
    "utf8",
  );
  await run(cli, [
    "--new-window",
    "--disable-extensions",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--user-data-dir=${userDataDirectory}`,
    `--extensions-dir=${extensionsDirectory}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, "e2e", "activation", "index.cjs")}`,
    workspaceDirectory,
  ], hostEnvironment());
  console.log("Activation smoke passed.");
  console.log(await readFile(evidencePath, "utf8"));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
