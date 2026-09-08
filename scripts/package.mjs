import { spawn, spawnSync } from "node:child_process";
import { npmExecutable, npmSpawnOptions } from "./lib/npmCommand.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVsix } from "./verify-vsix.mjs";
import { acquireWorktreeLock } from "./lib/worktreeLock.mjs";

const expectedVersion = "3.9.2";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const worktreeLock = await acquireWorktreeLock({ label: "packaging" });
try {
  const lockCheck = spawnSync(
    npmExecutable,
    ["ls", "--all", "--package-lock-only"],
    npmSpawnOptions({ cwd: root, stdio: "inherit" }),
  );
  if (lockCheck.error) {
    throw lockCheck.error;
  }
  if (lockCheck.status !== 0) {
    throw new Error(
      `Dependency lock validation failed with code ${String(lockCheck.status ?? "unknown")}`,
    );
  }

  let packagePath;
  try {
    packagePath = require.resolve("@vscode/vsce/package.json", { paths: [root] });
  } catch {
    throw new Error(
      `The locked @vscode/vsce@${expectedVersion} development dependency is not installed. Run npm ci before packaging.`,
    );
  }

  const packageValue = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageValue.version !== expectedVersion) {
    throw new Error(
      `Expected local VSCE ${expectedVersion}, received ${String(packageValue.version ?? "no version")}`,
    );
  }
  const bin = typeof packageValue.bin === "object" && typeof packageValue.bin.vsce === "string"
    ? packageValue.bin.vsce
    : undefined;
  if (!bin) {
    throw new Error("The installed @vscode/vsce package does not expose its CLI");
  }
  const cli = path.resolve(path.dirname(packagePath), bin);

  const run = (args, capture = false) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: root,
        stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
        windowsHide: true,
      });
      let stdout = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(`VSCE exited with code ${String(code)}`));
      });
    });

  const version = await run(["--version"], true);
  if (version.trim() !== expectedVersion) {
    throw new Error(`Expected VSCE ${expectedVersion}, received ${version.trim() || "no version"}`);
  }
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const artifact = path.join(root, `bachata-vscode-${manifest.version}.vsix`);
  await run(["package"]);
  await verifyVsix(artifact);

  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  console.log("");
  console.log("Candidate built. It is not a release until its records are bound and verified:");
  console.log(`  Bachata VSIX ${manifest.version} ${digest}`);
  console.log("  1. npm run release:bind      binds the records to this exact artifact");
  console.log("  2. npm run release:verify    validates identity, human evidence, and the binding");
  console.log("");
  console.log("This step deliberately does not gate on human evidence: that evidence can only be");
  console.log("produced by testing the artifact that has just been created.");

} finally {
  await worktreeLock.release();
}
