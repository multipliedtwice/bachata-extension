import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { npmExecutable } from "./lib/npmCommand.mjs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawnProcessScope } from "./process-scope.mjs";
import { installTerminationHandlers } from "./install-termination-handlers.mjs";
import { waitForChild } from "./wait-for-child.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const confirmation = "RUN BACHATA E2E";
const humanE2eVerificationCommand = "node -e \"require('node:fs').accessSync('human-e2e-result.txt')\"";

const enabled = (value) =>
  typeof value === "string" && !["", "0", "false", "no"].includes(value.toLowerCase());

const platformSpawnOptions = process.platform === "win32" ? { shell: true } : {};
let activeScope;
let termination;

const run = async (executable, args, options = {}) => {
  const scope = spawnProcessScope(executable, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
    cleanupGraceMs: 5_000,
  });
  activeScope = scope;
  try {
    const timeoutMs = Math.max(
      60_000,
      Number(process.env.BACHATA_HUMAN_E2E_PHASE_TIMEOUT_MS ?? 20 * 60_000),
    );
    const result = await waitForChild(scope, {
      timeoutMs,
      graceMs: 5_000,
      label: executable,
    });
    if (termination?.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    if (result.signal) {
      throw new Error(`${executable} stopped by ${result.signal}`);
    }
    if (result.code !== 0) {
      throw new Error(`${executable} exited with ${String(result.code)}`);
    }
  } catch (error) {
    if (termination?.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    throw error;
  } finally {
    if (activeScope === scope) {
      activeScope = undefined;
    }
  }
};

const available = (executable) => {
  const result = spawnSync(executable, ["--version"], {
    stdio: "ignore",
    ...platformSpawnOptions,
  });
  return result.status === 0;
};

const resolveVscodeCli = () => {
  const configured = process.env.BACHATA_VSCODE_CLI?.trim();
  if (configured) {
    if (!available(configured)) {
      throw new Error(`BACHATA_VSCODE_CLI is not executable: ${configured}`);
    }
    return configured;
  }
  for (const candidate of process.platform === "win32"
    ? ["code.cmd", "code-insiders.cmd"]
    : ["code", "code-insiders"]) {
    if (available(candidate)) {
      return candidate;
    }
  }
  throw new Error("VS Code CLI was not found. Set BACHATA_VSCODE_CLI to its executable path.");
};

const confirmHumanExecution = async () => {
  if (enabled(process.env.CI)) {
    throw new Error("Human E2E refuses to run in CI");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Human E2E requires an interactive terminal");
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question(`Type ${confirmation} to start the real VS Code E2E run: `);
    if (answer !== confirmation) {
      throw new Error("Human E2E confirmation did not match");
    }
  } finally {
    input.close();
  }
};


const todoPipeline = {
  version: 1,
  id: "human-e2e-todo",
  name: "Human E2E TODO worker",
  description: "Deterministic TODO implementation pipeline for the guarded Extension Host suite",
  agents: [{ id: "human-e2e-todo-worker", name: "Human E2E TODO worker", adapter: "human-e2e-adapter" }],
  steps: [{
    id: "implement",
    name: "Implement task",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["human-e2e-todo-worker"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "none",
  }],
};

const masterPipeline = {
  version: 1,
  id: "human-e2e-master",
  name: "Human E2E TODO Master",
  description: "Deterministic TODO watchdog pipeline for the guarded Extension Host suite",
  agents: [{ id: "human-e2e-master", name: "Human E2E Master", adapter: "human-e2e-adapter" }],
  steps: [{
    id: "watch",
    name: "Watch execution",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["human-e2e-master"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "none",
    output: {
      name: "masterDecision",
      format: "json",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["continue", "deviation"] },
          deviations: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                taskId: { type: "string", minLength: 1, maxLength: 120 },
                kind: {
                  type: "string",
                  enum: ["skippedTask", "wrongTask", "missingCompletion", "stalledTask", "retryPolicy", "todoState"],
                },
                details: { type: "string", minLength: 1, maxLength: 500 },
              },
              required: ["taskId", "kind", "details"],
              additionalProperties: false,
            },
          },
        },
        required: ["status", "deviations"],
        additionalProperties: false,
      },
    },
  }],
};

const runSetupCommand = (executable, args, cwd) => {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    ...platformSpawnOptions,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "no output").trim()}`,
    );
  }
};

const main = async () => {
  let temporaryRoot;
  let cleanupPromise;
  const cleanup = async () => {
    if (!temporaryRoot) {
      return;
    }
    cleanupPromise ??= rm(temporaryRoot, { recursive: true, force: true });
    await cleanupPromise;
  };
  termination = installTerminationHandlers({
    getProcessScope: () => activeScope,
    cleanup,
    graceMs: 5_000,
  });

  try {
    await confirmHumanExecution();
    const cli = resolveVscodeCli();
    if (!available("git")) {
      throw new Error("Git is required for the TODO Extension Host scenario");
    }
    await run(npmExecutable, ["run", "build"]);

    temporaryRoot = await mkdtemp(path.join(tmpdir(), "bachata-human-e2e-"));
    const userDataDirectory = path.join(temporaryRoot, "user-data");
    const extensionsDirectory = path.join(temporaryRoot, "extensions");
    const workspaceDirectory = path.join(temporaryRoot, "workspace");
    const pipelineDirectory = path.join(workspaceDirectory, ".bachata", "pipelines");
    const settingsDirectory = path.join(workspaceDirectory, ".vscode");
    await Promise.all([
      mkdir(userDataDirectory, { recursive: true }),
      mkdir(extensionsDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
      mkdir(pipelineDirectory, { recursive: true }),
      mkdir(settingsDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(workspaceDirectory, "README.md"),
        "# Bachata human E2E workspace\n",
        "utf8",
      ),
      writeFile(
        path.join(workspaceDirectory, ".gitignore"),
        [
          ".bachata-human-e2e.json",
          ".bachata/pipelines/human-e2e-recovery.pipeline.json",
          ".bachata/pipelines/human-e2e-browser.pipeline.json",
          "",
        ].join("\n"),
        "utf8",
      ),
      writeFile(
        path.join(workspaceDirectory, "TODO.md"),
        [
          "- [ ] [HUMAN-E2E] Create deterministic result",
          "  - Paths: human-e2e-result.txt",
          `  - Verify: ${humanE2eVerificationCommand}`,
          "  - Resources: global:human-e2e-task-verification",
          `  - Verify Final: ${humanE2eVerificationCommand}`,
          "  - Final Resources: global:human-e2e-final-verification",
          "",
        ].join("\n"),
        "utf8",
      ),
      writeFile(
        path.join(pipelineDirectory, "human-e2e-todo.pipeline.json"),
        `${JSON.stringify(todoPipeline, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        path.join(pipelineDirectory, "human-e2e-master.pipeline.json"),
        `${JSON.stringify(masterPipeline, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        path.join(settingsDirectory, "settings.json"),
        `${JSON.stringify({
          "bachata.todoPipeline": todoPipeline.id,
          "bachata.todoMasterPipeline": masterPipeline.id,
          "bachata.todoMaxConcurrency": 1,
          "bachata.todoRetries": 0,
          "bachata.browserBridgePort": 0,
        }, null, 2)}\n`,
        "utf8",
      ),
    ]);
    runSetupCommand("git", ["init"], workspaceDirectory);
    runSetupCommand("git", ["config", "user.name", "Bachata Human E2E"], workspaceDirectory);
    runSetupCommand("git", ["config", "user.email", "bachata-human-e2e@example.invalid"], workspaceDirectory);
    runSetupCommand("git", ["add", "--all"], workspaceDirectory);
    runSetupCommand("git", ["commit", "-m", "Initial human E2E workspace"], workspaceDirectory);

    const argumentsForPhase = [
      "--new-window",
      "--disable-extensions",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      `--user-data-dir=${userDataDirectory}`,
      `--extensions-dir=${extensionsDirectory}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(root, "e2e", "suite", "index.cjs")}`,
      workspaceDirectory,
    ];

    for (const phase of ["prepare", "recover"]) {
      await run(cli, argumentsForPhase, {
        env: {
          ...process.env,
          BACHATA_HUMAN_E2E: "1",
          BACHATA_HUMAN_E2E_PHASE: phase,
        },
      });
    }
  } finally {
    try {
      await cleanup();
    } finally {
      termination.remove();
    }
  }
};
await main();
