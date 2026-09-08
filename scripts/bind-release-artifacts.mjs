import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  VSIX_ARTIFACT_LIMITS,
  readArtifactSnapshot,
  resolvePinnedBridgeArchive,
} from "./lib/releaseArtifacts.mjs";
import {
  BINDING_DOCUMENTS,
  planDocumentBinding,
} from "./lib/bindReleaseArtifacts.mjs";
import { bindDocuments } from "./lib/documentBindingTransaction.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const vsixSnapshot = await readArtifactSnapshot(
  path.join(root, `bachata-vscode-${packageJson.version}.vsix`),
  "extension/package.json",
  `bachata-vscode-${packageJson.version}.vsix`,
  VSIX_ARTIFACT_LIMITS,
);
const pinnedBridge = await resolvePinnedBridgeArchive(root);

const artifacts = {
  vsix: {
    label: "Bachata VSIX",
    sha256: vsixSnapshot.sha256,
    version: vsixSnapshot.version,
  },
  bridge: {
    label: "Browser Bridge ZIP",
    sha256: pinnedBridge.sha256,
    version: pinnedBridge.version,
  },
};

const voidUnbindable = process.argv.slice(2).includes("--void-unbindable");

const plans = [];
for (const relative of BINDING_DOCUMENTS) {
  const file = path.join(root, relative);
  let original;
  try {
    original = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `${relative} could not be read, so Bachata refuses to bind any document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  plans.push({
    relative,
    file,
    original,
    ...planDocumentBinding({ relative, original, artifacts, voidUnbindable }),
  });
}

const problems = plans.flatMap((plan) => plan.problems);
const unbindable = plans.flatMap((plan) => plan.unbindable);
if (problems.length === 0 && unbindable.length > 0) {
  problems.push(
    ...unbindable.map((entry) =>
      `${entry} is recorded but names no artifact hash, so Bachata cannot tell which artifact produced it`),
    "Record the artifact hash in each row, or rerun with --void-unbindable to clear them.",
  );
}
if (problems.length > 0) {
  console.error(`Bachata refuses to bind release records; nothing was written:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const pending = plans.filter((plan) => plan.next !== plan.original);
const outcome = await bindDocuments({
  docsDirectory: path.join(root, "docs"),
  plans: pending,
});
outcome.recovered?.forEach((relative) => {
  console.log(`Recovered ${relative} from an interrupted binding before planning this one.`);
});
if (outcome.status === "blocked") {
  console.error(`Bachata refuses to bind release records; nothing was written:\n- ${outcome.reasons.join("\n- ")}`);
  process.exit(1);
}
if (outcome.status === "unrecovered") {
  throw new AggregateError(
    [outcome.error],
    `Binding failed and could not be rolled back. ${
      outcome.journal ? `Replay or remove ${outcome.journal}, then r` : "R"
    }estore these documents by hand: ${outcome.rollbackFailures.join("; ")}`,
  );
}
if (outcome.status === "rolled-back") {
  console.error(
    `Binding failed and every document was restored to its previous content: ${
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    }`,
  );
  process.exit(1);
}
const written = outcome.written;

const changed = written.length;
written.forEach((record) => {
  console.log(
    record.plan.voided > 0
      ? `Rebound ${record.relative} and voided ${String(record.plan.voided)} record(s) produced against another artifact.`
      : `Updated the artifact binding in ${record.relative}.`,
  );
});

console.log(
  `Bachata VSIX ${artifacts.vsix.version} ${artifacts.vsix.sha256}\nBrowser Bridge ZIP ${artifacts.bridge.version} ${artifacts.bridge.sha256}\n${String(changed)} document(s) updated.`,
);
