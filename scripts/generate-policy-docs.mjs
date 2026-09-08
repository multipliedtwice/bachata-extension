import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { policyBlocks, renderGeneratedRegions } from "./lib/policyDocs.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

// These modules come from dist, which a concurrent build rewrites in place. The build holds
// the worktree lock and releases it on exit, so every later dist consumer in the composite
// chain must take the lock for its own read or import a module mid-delete. `withWorktreeLock`
// reuses an inherited token, so nesting under a caller that already holds it is free.
const { policy, registry } = await withWorktreeLock({ label: "policy documentation" }, async () => ({
  policy: await import(`file://${path.join(root, "dist", "orchestrator", "verificationPolicy.js")}`),
  registry: await import(`file://${path.join(root, "dist", "orchestrator", "verifierRegistry.js")}`),
}));

const blocks = policyBlocks({
  controllerCommands: [...policy.CONTROLLER_VERIFICATION_COMMANDS],
  verifierCommandPrefix: registry.VERIFIER_COMMAND_PREFIX,
  verifierRegistryPath: registry.VERIFIER_REGISTRY_PATH,
});

const documents = [
  "README.md",
  "docs/PIPELINES.md",
  "docs/ORCHESTRATION.md",
  "docs/VERIFIERS.md",
];

const drifted = [];
for (const relative of documents) {
  const file = path.join(root, relative);
  const current = await readFile(file, "utf8");
  const next = renderGeneratedRegions(current, blocks);
  if (current === next) continue;
  if (check) {
    drifted.push(relative);
    continue;
  }
  await writeFile(file, next, "utf8");
  console.log(`Regenerated policy regions in ${relative}`);
}

if (drifted.length > 0) {
  console.error(
    `Policy documentation is out of date with the execution constants:\n- ${drifted.join("\n- ")}\nRun: npm run docs:policy`,
  );
  process.exit(1);
}
console.log(check ? "Policy documentation matches the execution constants." : "Policy documentation regenerated.");
