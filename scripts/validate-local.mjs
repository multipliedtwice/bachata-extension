import { runLocalValidation } from "./lib/localValidationRun.mjs";

// The command line always validates against the canonical worktree lock. Only a test
// fixture calls runLocalValidation with an explicit lock path.
let findings;
try {
  findings = await runLocalValidation({ target: process.argv[2] ?? process.cwd() });
} catch (error) {
  // An unbuilt tree is expected and actionable, so it prints its one instruction alone.
  if (error?.code === "BACHATA_TREE_NOT_BUILT") {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

// The gate has already released its lock by the time it returns, so this only reports the
// outcome. process.exitCode rather than process.exit so nothing after this point is cut
// short either.
if (findings.length > 0) process.exitCode = 1;
