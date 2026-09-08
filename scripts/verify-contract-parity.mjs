// BACHATA-AUD-02. The Bridge and the Extension each carry a copy of the browser protocol
// contract, and each repository validates its own parser against its own copy. Nothing
// compared the two, and the archive does not carry the contract at all, so the copies could
// diverge with both suites green and the two ends disagreeing only at runtime.
//
// This compares a Bridge-produced contract against what this repository pins. It is the
// release job's parity gate: give it the contract file from the Bridge's own build artifact.
//
// BACHATA-AUD-03. The shared fixture tables have the same problem in smaller form: each
// repository compared its copy against a digest hardcoded in its own suite, so editing a
// fixture and its local constant together passed on both sides. They are compared here, from
// the Bridge's own build, for the same reason the contract is.
//
// Usage: node scripts/verify-contract-parity.mjs <bridge-contract-file> [bridge-protocol-dir]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const readCompatibility = async (repositoryRoot = root) =>
  JSON.parse(
    await readFile(
      path.join(repositoryRoot, "protocol", "browser-bridge.compatibility.json"),
      "utf8",
    ),
  );

/**
 * Compares three things that must agree before a paired release is published:
 *
 * 1. this repository's own contract copy against the digest it pins,
 * 2. the Bridge-produced contract against that same digest,
 * 3. the two contract files byte for byte.
 *
 * Returns the findings rather than throwing, so a caller can report all of them at once.
 */
export const contractParityFindings = async (bridgeContractBytes, repositoryRoot = root) => {
  const findings = [];
  const compatibility = await readCompatibility(repositoryRoot);
  const localPath = path.join(repositoryRoot, "protocol", compatibility.contractFile);
  const localBytes = await readFile(localPath);
  const localDigest = sha256(localBytes);
  const bridgeDigest = sha256(bridgeContractBytes);

  if (typeof compatibility.sha256 !== "string" || compatibility.sha256.length !== 64) {
    findings.push("browser-bridge.compatibility.json declares no usable sha256");
    return findings;
  }
  if (localDigest !== compatibility.sha256) {
    findings.push(
      `this repository's ${compatibility.contractFile} hashes ${localDigest}, but its compatibility manifest pins ${compatibility.sha256}`,
    );
  }
  if (bridgeDigest !== compatibility.sha256) {
    findings.push(
      `the Browser Bridge contract hashes ${bridgeDigest}, but this release pins ${compatibility.sha256}`,
    );
  }
  if (!localBytes.equals(Buffer.from(bridgeContractBytes))) {
    findings.push(
      "the Browser Bridge contract and this repository's copy are not byte-identical",
    );
  }

  let bridgeContract;
  try {
    bridgeContract = JSON.parse(Buffer.from(bridgeContractBytes).toString("utf8"));
  } catch (error) {
    findings.push(
      `the Browser Bridge contract is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return findings;
  }
  if (bridgeContract.protocolVersion !== compatibility.protocolVersion) {
    findings.push(
      `the Browser Bridge contract declares protocol version ${String(bridgeContract.protocolVersion)}, but this release pins ${String(compatibility.protocolVersion)}`,
    );
  }
  return findings;
};

// Every file both repositories must carry byte for byte.
export const SHARED_BOUNDARY_FIXTURES = [
  "source-export.fixtures.json",
  "asset-name.fixtures.json",
];

export const sharedFixtureFindings = async (bridgeProtocolDirectory, repositoryRoot = root) => {
  const findings = [];
  for (const name of SHARED_BOUNDARY_FIXTURES) {
    const localPath = path.join(repositoryRoot, "protocol", name);
    const bridgePath = path.join(bridgeProtocolDirectory, name);
    let localBytes;
    let bridgeBytes;
    try {
      localBytes = await readFile(localPath);
    } catch {
      findings.push(`this repository carries no protocol/${name}`);
      continue;
    }
    try {
      bridgeBytes = await readFile(bridgePath);
    } catch {
      findings.push(`the Browser Bridge artifact carries no ${name}`);
      continue;
    }
    if (!localBytes.equals(bridgeBytes)) {
      findings.push(
        `${name} differs: this repository hashes ${sha256(localBytes)}, the Browser Bridge hashes ${sha256(bridgeBytes)}`,
      );
    }
  }
  return findings;
};

const main = async () => {
  const candidate = process.argv[2];
  if (!candidate) {
    console.error(
      "Usage: node scripts/verify-contract-parity.mjs <bridge-contract-file> <bridge-protocol-dir>\n" +
        "Both come from the Browser Bridge build artifact: its protocol contract, and the\n" +
        "directory holding the shared boundary fixtures.",
    );
    process.exitCode = 1;
    return;
  }
  let bytes;
  try {
    bytes = await readFile(candidate);
  } catch (error) {
    console.error(
      `Cannot read the Browser Bridge contract at ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }
  const findings = await contractParityFindings(bytes);
  const fixtureDirectory = process.argv[3];
  if (fixtureDirectory) {
    findings.push(...(await sharedFixtureFindings(fixtureDirectory)));
  } else {
    findings.push(
      "no Browser Bridge protocol directory was named, so the shared fixture tables were not compared",
    );
  }
  if (findings.length > 0) {
    console.error("Browser protocol contract parity failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const compatibility = await readCompatibility();
  console.log(
    `Browser protocol contract parity confirmed: version ${String(compatibility.protocolVersion)}, sha256 ${compatibility.sha256}.`,
  );
  console.log(
    `Shared boundary fixtures match: ${SHARED_BOUNDARY_FIXTURES.join(", ")}.`,
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
