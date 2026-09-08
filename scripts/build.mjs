import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { generateThirdPartyNotices } from "./third-party-notices.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");
const prismRoot = path.dirname(require.resolve("prismjs/package.json"));
const codiconsRoot = path.dirname(require.resolve("@vscode/codicons/package.json"));
const watch = process.argv.includes("--watch");

const codiconFiles = ["dist/codicon.css", "dist/codicon.ttf", "LICENSE", "LICENSE-CODE"];

const prismFiles = [
  "LICENSE",
  "prism.js",
  "components/prism-bash.js",
  "components/prism-c.js",
  "components/prism-cpp.js",
  "components/prism-csharp.js",
  "components/prism-diff.js",
  "components/prism-git.js",
  "components/prism-go.js",
  "components/prism-java.js",
  "components/prism-json.js",
  "components/prism-jsx.js",
  "components/prism-markdown.js",
  "components/prism-powershell.js",
  "components/prism-python.js",
  "components/prism-rust.js",
  "components/prism-sql.js",
  "components/prism-tsx.js",
  "components/prism-typescript.js",
  "components/prism-yaml.js",
];

const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath, ...args], {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tsc exited with code ${String(code)}`));
    });
  });

const copyPrismAssets = async () => {
  await Promise.all(
    prismFiles.map(async (relativePath) => {
      const target = path.join("dist", "vendor", "prism", relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(prismRoot, relativePath), target);
    }),
  );
};

const copyCodiconAssets = async () => {
  await Promise.all(
    codiconFiles.map(async (relativePath) => {
      const target = path.join("dist", "vendor", "codicons", path.basename(relativePath));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(codiconsRoot, relativePath), target);
    }),
  );
};

const main = async () => {
  if (!watch) {
    await rm("dist", { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  await mkdir("dist", { recursive: true });
  await copyFile("src/webview-ui/style.css", "dist/webview.css");
  await copyFile("LICENSE", "dist/LICENSE");
  await copyPrismAssets();
  await copyCodiconAssets();
  await generateThirdPartyNotices({
    roots: ["ajv", "fast-glob", "ignore", "jsonrepair", "ts-morph", "typescript", "prismjs", "@vscode/codicons"],
    output: path.join("dist", "THIRD_PARTY_NOTICES.txt"),
  });

  if (watch) {
    await Promise.all([
      run(["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]),
      run(["-p", "tsconfig.webview-behavior.json", "--watch", "--preserveWatchOutput"]),
      run(["-p", "tsconfig.webview.json", "--watch", "--preserveWatchOutput"]),
    ]);
    return;
  }

  await run(["-p", "tsconfig.json"]);
  await run(["-p", "tsconfig.webview-behavior.json"]);
  await run(["-p", "tsconfig.webview.json"]);
};

withWorktreeLock({ label: watch ? "watch build" : "build" }, main).catch((error) => {
  console.error(error);
  process.exit(1);
});
