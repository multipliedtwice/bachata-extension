import { existsSync } from "node:fs";
import { readFile as readFileFromDisk, readdir as readdirFromDisk } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatFindings,
  validateContract,
  validateExportPolicy,
  validatePipeline,
  validateRepositoryPolicy,
  validateTodo,
  validateVerifiers,
} from "./localValidation.mjs";
import { acquireWorktreeLock, defaultWorktreeLockPath } from "./worktreeLock.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DISK = { readFile: readFileFromDisk, readdir: readdirFromDisk };

const describeError = (error) => (error instanceof Error ? error.message : String(error));

// Only an absent file is "nothing to validate". Every other failure — a permission
// refusal, an I/O error, a path that is not what it claimed to be — is reported as a
// finding, because a gate that cannot read a file has not checked it. Swallowing these
// turned an unreadable invalid configuration into a passing run.
const isMissing = (error) => error?.code === "ENOENT";

const parseJson = (source, project) => {
  try {
    return project(JSON.parse(source));
  } catch {
    return undefined;
  }
};

export const runLocalValidation = async ({
  target: rawTarget = process.cwd(),
  root = PACKAGE_ROOT,
  lockPath = defaultWorktreeLockPath(),
  filesystem = DISK,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) => {
  const target = path.resolve(rawTarget);
  const readFile = filesystem.readFile ?? DISK.readFile;
  const readdir = filesystem.readdir ?? DISK.readdir;
  // This gate loads the built tree, so it holds the same worktree lock the build takes.
  // The lock is held for the whole gate and released explicitly below. Nothing releases
  // it on a signal: a run that dies without reaching the release leaves the lock for an
  // operator, because its child processes may still be working in this worktree.
  const worktreeLock = await acquireWorktreeLock({ label: "local validation", lockPath });
  try {
    // An unbuilt tree is an expected state, not a crash: it earns one instruction, never a
    // module-resolution stack from inside this script.
    const load = async (relative) => {
      const target_ = path.join(root, "dist", relative);
      try {
        return await import(`file://${target_}`);
      } catch (error) {
        // Only the module this gate asked for being absent means "not built". A missing
        // dependency reached from inside an existing build is a different failure and must
        // keep its own error rather than be relabelled as an unbuilt tree.
        if (error?.code === "ERR_MODULE_NOT_FOUND" && !existsSync(target_)) {
          const unbuilt = new Error("This tree is not built yet. Run: npm run build");
          unbuilt.code = "BACHATA_TREE_NOT_BUILT";
          throw unbuilt;
        }
        throw error;
      }
    };
    const { parseTodoDocument } = await load("orchestrator/todoParser.js");
    const { parseVerifierRegistry } = await load("orchestrator/verifierRegistry.js");
    const { isDeclarableVerificationCommand } = await load("orchestrator/verificationPolicy.js");
    const { validatePipelineDefinition } = await load("pipeline/schema.js");
    const { buildExecutionContract } = await load("contract/executionContract.js");
    const { parseExportPolicy } = await load("export/exportPolicy.js");
    const { parseRepositoryPolicy, REPOSITORY_POLICY_PATH } = await load("policy/repositoryPolicy.js");

    const findings = [];
    const unreadable = (target_, file, error) => {
      findings.push({
        target: target_,
        file,
        message: `could not be read, so it was not validated: ${describeError(error)}`,
      });
    };

    // Returns the source to validate, or undefined when there is nothing to validate —
    // either because the file is absent or because reading it already produced a finding.
    const readOptional = async (validationTarget, relative) => {
      const filePath = path.join(target, relative);
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (!isMissing(error)) unreadable(validationTarget, filePath, error);
        return undefined;
      }
    };

    const listPipelines = async () => {
      const directories = [path.join(target, ".bachata", "pipelines"), path.join(root, "presets")];
      const files = [];
      for (const directory of directories) {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (!isMissing(error)) {
            findings.push({
              target: "pipelines",
              file: directory,
              message: `could not be enumerated, so its pipelines were not validated: ${describeError(error)}`,
            });
          }
          continue;
        }
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".pipeline.json"))
          .forEach((entry) => files.push(path.join(directory, entry.name)));
      }
      return files;
    };

    findings.push(...validateTodo({
      path: path.join(target, "TODO.md"),
      source: await readOptional("todo", "TODO.md"),
      parseTodoDocument,
      defaults: { pipelineId: "todo-implementation", retries: 0, requirePaths: true, requireControllerVerification: true },
    }));

    findings.push(...validateVerifiers({
      path: path.join(target, ".bachata", "verifiers.json"),
      source: await readOptional("verifiers", path.join(".bachata", "verifiers.json")),
      parseVerifierRegistry,
    }));

    findings.push(...validateExportPolicy({
      path: path.join(target, ".bachata", "export-policy.json"),
      source: await readOptional("exportPolicy", path.join(".bachata", "export-policy.json")),
      parseExportPolicy,
    }));

    // The policy is read once, through the same filesystem the rest of this gate uses, and
    // parsed once. Validating one document while the contracts below are built from a second
    // read of another is the one disagreement this gate cannot report.
    const repositoryPolicySource = await readOptional("repositoryPolicy", REPOSITORY_POLICY_PATH);
    findings.push(...validateRepositoryPolicy({
      path: path.join(target, REPOSITORY_POLICY_PATH),
      source: repositoryPolicySource,
      parseRepositoryPolicy,
    }));

    // A policy that failed to read or parse is already a finding above; the contracts below
    // are then resolved without one, and the run still exits non-zero because of it.
    const repositoryPolicy = repositoryPolicySource === undefined
      ? undefined
      : parseJson(repositoryPolicySource, (value) => parseRepositoryPolicy(value).policy);

    for (const filePath of await listPipelines()) {
      let source;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        if (!isMissing(error)) unreadable("pipelines", filePath, error);
        continue;
      }
      const pipelineFindings = validatePipeline({ path: filePath, source, validatePipelineDefinition });
      findings.push(...pipelineFindings);
      if (pipelineFindings.length > 0) continue;
      findings.push(...validateContract({
        pipeline: JSON.parse(source),
        filePath,
        buildExecutionContract,
        isDeclarableVerificationCommand,
        workingDirectory: target,
        ...(repositoryPolicy === undefined ? {} : { repositoryPolicy }),
      }));
    }

    log(formatFindings(findings));
    return findings;
  } finally {
    await worktreeLock.release();
  }
};
