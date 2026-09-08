const assert = require("node:assert/strict");
const test = require("node:test");

const {
  authorityDiff,
  authorityFingerprint,
  contractAcknowledgement,
  contractAuthority,
} = require("../dist/contract/authority.js");

const contract = (overrides = {}) => ({
  pipelineId: "managed-fix",
  pipelineName: "Managed fix",
  safetyLevel: "managed",
  providers: [{ agentId: "codex", name: "Codex", adapter: "codex-app-server", adapterLabel: "Codex", roles: [], status: "ready" }],
  roles: [],
  scope: {
    workingDirectory: "/repo",
    writeScope: "configured",
    writablePaths: ["src/api"],
    readablePaths: [],
    protectedPaths: [".git"],
  },
  commitPolicy: "never",
  verification: ["bachata:project-checks"],
  verificationResources: [],
  humanGates: [],
  limits: { iterations: 1, maxIterations: 10, iterationMode: "fixed" },
  fallbacks: [],
  completion: [],
  blockers: [],
  outboundContext: [{ agentId: "codex", name: "Codex", adapterLabel: "Codex", transport: "stdio", entries: [{ label: "prompt", detail: "12 bytes", exact: true }], exclusions: [], redactions: [] }],
  ...overrides,
});

test("authority is derived only from what the run is allowed to do", () => {
  const authority = contractAuthority(contract());
  assert.deepEqual(authority, {
    pipelineId: "managed-fix",
    workingDirectory: "/repo",
    writeScope: "configured",
    writablePaths: ["src/api"],
    readablePaths: [],
    protectedPaths: [".git"],
    commitPolicy: "never",
    verification: ["bachata:project-checks"],
    providers: ["codex:codex-app-server"],
    outboundContext: ["codex:stdio:1"],
  });
  assert.equal(
    authorityFingerprint(authority),
    authorityFingerprint(contractAuthority(contract({ pipelineName: "renamed" }))),
  );
});

test("a widened write scope is reported as an expansion", () => {
  const before = contractAuthority(contract());
  const after = contractAuthority(contract({
    scope: { ...contract().scope, writeScope: "workspace", writablePaths: [] },
  }));
  const diff = authorityDiff(before, after);
  assert.equal(diff.expanded, true);
  assert.deepEqual(
    diff.changes.map((change) => [change.label, change.expands]),
    [["Write scope", true], ["Writable paths", false]],
  );
});

test("a narrowed authority never requires a new acknowledgement", () => {
  const before = contractAuthority(contract({
    scope: { ...contract().scope, writeScope: "workspace" },
    commitPolicy: "allow",
  }));
  const after = contractAuthority(contract());
  const diff = authorityDiff(before, after);
  assert.equal(diff.expanded, false);
  assert.deepEqual(
    diff.changes.map((change) => change.label).sort(),
    ["Commit authority", "Write scope"],
  );
});

test("removing a protected path expands authority", () => {
  const before = contractAuthority(contract());
  const after = contractAuthority(contract({
    scope: { ...contract().scope, protectedPaths: [] },
  }));
  assert.equal(authorityDiff(before, after).expanded, true);
});

test("a new provider and new outbound context expand authority", () => {
  const before = contractAuthority(contract());
  const after = contractAuthority(contract({
    providers: [
      ...contract().providers,
      { agentId: "claude", name: "Claude", adapter: "claude-code", adapterLabel: "Claude", roles: [], status: "ready" },
    ],
  }));
  assert.equal(authorityDiff(before, after).expanded, true);
});

// EX-UI-02. A contract nobody has acknowledged yet is not a contract that changed. It opened on
// every first run, which put ten-plus evidence sections above the composer of a room that had
// never executed anything. What still holds is the gate: a writing contract refuses Send until it
// is acknowledged, and that refusal is said beside Send.
test("a read-only contract stays closed and demands no acknowledgement", () => {
  const acknowledgement = contractAcknowledgement(
    contract({
      safetyLevel: "review",
      scope: { ...contract().scope, writeScope: "readOnly", writablePaths: [] },
    }),
    undefined,
  );
  assert.equal(acknowledgement.open, false);
  assert.equal(acknowledgement.acknowledgementRequired, false);
  assert.deepEqual(acknowledgement.diff.changes, []);
});

test("a writing contract demands acknowledgement once without opening itself", () => {
  const first = contractAcknowledgement(contract(), undefined);
  assert.equal(first.open, false, "a contract nobody has acknowledged yet opened as if it changed");
  assert.equal(first.acknowledgementRequired, true);

  const second = contractAcknowledgement(contract(), first.authority);
  assert.equal(second.open, false);
  assert.equal(second.acknowledgementRequired, false);
  assert.deepEqual(second.diff.changes, []);
});

test("the contract reopens when authority changes and only re-gates on expansion", () => {
  const acknowledged = contractAcknowledgement(contract(), undefined).authority;

  const narrowed = contractAcknowledgement(
    contract({ verification: ["bachata:project-checks", "bachata:workspace-integrity"] }),
    acknowledged,
  );
  assert.equal(narrowed.open, true, "an authority that moved since the acknowledgement stayed closed");
  assert.ok(narrowed.diff.changes.length > 0);
  assert.equal(narrowed.acknowledgementRequired, false);

  const widened = contractAcknowledgement(contract({ commitPolicy: "allow" }), acknowledged);
  assert.equal(widened.open, true);
  assert.ok(widened.diff.changes.length > 0);
  assert.equal(widened.acknowledgementRequired, true);
});
