const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const parityModule = path.join(root, "scripts", "verify-contract-parity.mjs");

const load = () => import(`file://${parityModule}`);

const compatibility = JSON.parse(
  fs.readFileSync(path.join(root, "protocol", "browser-bridge.compatibility.json"), "utf8"),
);
const localContractPath = path.join(root, "protocol", compatibility.contractFile);
const localContract = fs.readFileSync(localContractPath);

// BACHATA-AUD-02. Each repository validated its own contract copy and nothing compared the two,
// so a one-sided edit left both suites green and the ends disagreeing at runtime. The
// archive does not carry the contract, so the comparison has to be fed the Bridge's own
// build output; this is the gate the paired release job runs.

test("a Bridge contract identical to the pinned one reports no findings", async () => {
  const { contractParityFindings } = await load();
  const findings = await contractParityFindings(localContract);
  assert.deepEqual(findings, [], `parity should hold today: ${findings.join("; ")}`);
});

test("a drifted Bridge contract fails parity", async () => {
  const { contractParityFindings } = await load();
  const drifted = JSON.parse(localContract.toString("utf8"));
  drifted.clientMessageTypes = [...drifted.clientMessageTypes, "conversation.somethingNew"];
  const findings = await contractParityFindings(
    Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`, "utf8"),
  );
  assert.ok(findings.length > 0, "a drifted contract passed parity");
  assert.ok(
    findings.some((finding) => /hashes [0-9a-f]{64}, but this release pins/u.test(finding)),
    `no digest mismatch was reported: ${findings.join("; ")}`,
  );
  assert.ok(
    findings.some((finding) => /not byte-identical/u.test(finding)),
    `no byte comparison was reported: ${findings.join("; ")}`,
  );
});

test("a Bridge contract on another protocol version fails parity", async () => {
  const { contractParityFindings } = await load();
  const other = JSON.parse(localContract.toString("utf8"));
  other.protocolVersion = compatibility.protocolVersion + 1;
  const findings = await contractParityFindings(
    Buffer.from(`${JSON.stringify(other, null, 2)}\n`, "utf8"),
  );
  assert.ok(
    findings.some((finding) => /declares protocol version/u.test(finding)),
    `no protocol version mismatch was reported: ${findings.join("; ")}`,
  );
});

test("an unreadable Bridge contract fails parity instead of being skipped", async () => {
  const { contractParityFindings } = await load();
  const findings = await contractParityFindings(Buffer.from("not json at all", "utf8"));
  assert.ok(findings.length > 0);
  assert.ok(
    findings.some((finding) => /not readable JSON/u.test(finding)),
    `no parse failure was reported: ${findings.join("; ")}`,
  );
});

test("an empty artifact fails parity rather than passing vacuously", async () => {
  const { contractParityFindings } = await load();
  const findings = await contractParityFindings(Buffer.alloc(0));
  assert.ok(findings.length > 0, "an empty contract artifact passed parity");
});

test("the parity script exits non-zero when no artifact is named", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  await assert.rejects(
    execFileAsync(process.execPath, [parityModule]),
    (error) => error.code === 1,
    "a missing artifact argument must fail, not skip",
  );
});

test("the parity script accepts the pinned contract from a file", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(process.execPath, [
    parityModule,
    localContractPath,
    path.join(root, "protocol"),
  ]);
  assert.match(stdout, /contract parity confirmed/u);
  assert.match(stdout, new RegExp(compatibility.sha256, "u"));
  assert.match(stdout, /Shared boundary fixtures match/u);
});

// BACHATA-AUD-03 follow-up. Each repository compared its fixture only against a constant in its
// own suite, so editing a fixture and that constant together passed on both sides while the
// two repositories silently diverged. The paired job compares the bytes themselves.
test("the parity script refuses to run without the shared fixture directory", async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  await assert.rejects(
    execFileAsync(process.execPath, [parityModule, localContractPath]),
    (error) => error.code === 1 && /shared fixture tables were not compared/u.test(error.stderr),
    "omitting the fixture directory must fail rather than silently skip the comparison",
  );
});

test("a fixture that differs between repositories fails parity", async () => {
  const { sharedFixtureFindings, SHARED_BOUNDARY_FIXTURES } = await load();
  const os = require("node:os");
  const fsp = require("node:fs/promises");
  const staged = await fsp.mkdtemp(path.join(os.tmpdir(), "bachata-fixture-parity-"));
  try {
    for (const name of SHARED_BOUNDARY_FIXTURES) {
      await fsp.copyFile(path.join(root, "protocol", name), path.join(staged, name));
    }
    assert.deepEqual(await sharedFixtureFindings(staged), [], "identical copies should agree");

    const target = path.join(staged, SHARED_BOUNDARY_FIXTURES[0]);
    const drifted = JSON.parse(await fsp.readFile(target, "utf8"));
    drifted.cases.push({ name: "one-sided edit", path: "x", type: "file", excluded: false });
    await fsp.writeFile(target, `${JSON.stringify(drifted, null, 2)}\n`);
    const findings = await sharedFixtureFindings(staged);
    assert.ok(
      findings.some((finding) => finding.includes(SHARED_BOUNDARY_FIXTURES[0])),
      `a one-sided fixture edit was not reported: ${findings.join("; ")}`,
    );
  } finally {
    await fsp.rm(staged, { recursive: true, force: true });
  }
});

test("a missing shared fixture fails parity rather than passing vacuously", async () => {
  const { sharedFixtureFindings } = await load();
  const os = require("node:os");
  const fsp = require("node:fs/promises");
  const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "bachata-fixture-empty-"));
  try {
    const findings = await sharedFixtureFindings(empty);
    assert.ok(findings.length >= 2, `an empty fixture directory passed: ${findings.join("; ")}`);
    assert.ok(findings.every((finding) => /carries no/u.test(finding)));
  } finally {
    await fsp.rm(empty, { recursive: true, force: true });
  }
});
