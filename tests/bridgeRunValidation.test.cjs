const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const moduleUrl = `file://${path.join(__dirname, "..", "scripts", "verify-bridge-run.mjs")}`;
const load = () => import(moduleUrl);

const EXPECTED_WORKFLOW_PATH = ".github/workflows/release-artifact.yml";
const EXPECTED_REPOSITORY = "example-owner/browser-bridge";

// Shaped after the documented GET /repos/{owner}/{repo}/actions/runs/{run_id} response.
// The field that matters here is `path`: GitHub returns it with the ref appended, which the
// first version of this check compared exactly against the bare path and so rejected every
// legitimate run before any artifact was downloaded.
const apiRun = (overrides = {}) => ({
  id: 1234567890,
  name: "Release artifact",
  status: "completed",
  conclusion: "success",
  path: `${EXPECTED_WORKFLOW_PATH}@main`,
  event: "workflow_dispatch",
  head_branch: "main",
  head_repository: { full_name: EXPECTED_REPOSITORY },
  repository: { full_name: EXPECTED_REPOSITORY },
  ...overrides,
});

const expected = { repository: EXPECTED_REPOSITORY, workflowPath: EXPECTED_WORKFLOW_PATH };

test("a documented successful run response is accepted", async () => {
  const { bridgeRunFindings } = await load();
  assert.deepEqual(bridgeRunFindings(apiRun(), expected), []);
});

test("the ref suffix on the workflow path is accepted in the forms GitHub returns", async () => {
  const { bridgeRunFindings } = await load();
  for (const value of [
    `${EXPECTED_WORKFLOW_PATH}@main`,
    `${EXPECTED_WORKFLOW_PATH}@refs/heads/main`,
    `${EXPECTED_WORKFLOW_PATH}@refs/tags/v0.6.7`,
    // Accepted if the API ever returns the bare path.
    EXPECTED_WORKFLOW_PATH,
  ]) {
    assert.deepEqual(
      bridgeRunFindings(apiRun({ path: value }), expected),
      [],
      `${value} was rejected`,
    );
  }
});

// A ref may legally contain `@` — `git check-ref-format refs/heads/feature@x` succeeds — so
// splitting the path on its last `@` cut a valid value at the wrong place and rejected it.
test("a ref containing @ is accepted", async () => {
  const { bridgeRunFindings, workflowPathMatches } = await load();
  for (const ref of ["feature@x", "refs/heads/feature@x", "user@host/branch", "a@b@c"]) {
    const value = `${EXPECTED_WORKFLOW_PATH}@${ref}`;
    assert.equal(workflowPathMatches(value, EXPECTED_WORKFLOW_PATH), true, `${value} was rejected`);
    assert.deepEqual(bridgeRunFindings(apiRun({ path: value }), expected), [], `${value} was rejected`);
  }
});

// The same split accepted a delimiter with nothing after it, because the part before the
// last `@` equalled the expected path exactly.
test("a delimiter with no ref after it is rejected", async () => {
  const { bridgeRunFindings, workflowPathMatches } = await load();
  const value = `${EXPECTED_WORKFLOW_PATH}@`;
  assert.equal(workflowPathMatches(value, EXPECTED_WORKFLOW_PATH), false, `${value} was accepted`);
  const findings = bridgeRunFindings(apiRun({ path: value }), expected);
  assert.equal(findings.length, 1, `${value} was accepted`);
});

test("a different workflow is rejected even with a ref suffix", async () => {
  const { bridgeRunFindings } = await load();
  const findings = bridgeRunFindings(
    apiRun({ path: ".github/workflows/release-gates.yml@main" }),
    expected,
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /release-gates\.yml@main.*not.*release-artifact\.yml/u);
});

test("a path that merely contains the expected text is rejected", async () => {
  const { bridgeRunFindings } = await load();
  for (const lookalike of [
    `evil/${EXPECTED_WORKFLOW_PATH}@main`,
    `${EXPECTED_WORKFLOW_PATH}.bak@main`,
    `${EXPECTED_WORKFLOW_PATH}x@main`,
    `.github/workflows/x-release-artifact.yml@main`,
    `prefix${EXPECTED_WORKFLOW_PATH}`,
    `${EXPECTED_WORKFLOW_PATH}/nested.yml@main`,
    // A lookalike must stay rejected even when its own suffix contains `@`.
    `evil/${EXPECTED_WORKFLOW_PATH}@feature@x`,
    `${EXPECTED_WORKFLOW_PATH}.bak@feature@x`,
  ]) {
    const findings = bridgeRunFindings(apiRun({ path: lookalike }), expected);
    assert.ok(findings.length > 0, `${lookalike} was accepted`);
  }
});

test("an unsuccessful or incomplete run is rejected", async () => {
  const { bridgeRunFindings } = await load();
  // A failed run can still have published artifacts before the step that failed, which is
  // exactly the case this gate exists for.
  for (const overrides of [
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { conclusion: "timed_out" },
    { conclusion: null },
    { status: "in_progress", conclusion: null },
    { status: "queued", conclusion: null },
  ]) {
    const findings = bridgeRunFindings(apiRun(overrides), expected);
    assert.ok(
      findings.length > 0,
      `${JSON.stringify(overrides)} was accepted`,
    );
  }
});

test("a run from another repository is rejected", async () => {
  const { bridgeRunFindings } = await load();
  for (const full of ["someone-else/browser-bridge", "example-owner/other", undefined]) {
    const findings = bridgeRunFindings(
      apiRun({ head_repository: full === undefined ? undefined : { full_name: full } }),
      expected,
    );
    assert.ok(findings.length > 0, `${String(full)} was accepted`);
  }
});

test("several problems are reported together", async () => {
  const { bridgeRunFindings } = await load();
  const findings = bridgeRunFindings(
    apiRun({
      conclusion: "failure",
      path: ".github/workflows/release-gates.yml@main",
      head_repository: { full_name: "someone-else/browser-bridge" },
    }),
    expected,
  );
  assert.equal(findings.length, 3, `expected three findings, got ${JSON.stringify(findings)}`);
});

test("a response that is not an object is refused rather than trusted", async () => {
  const { bridgeRunFindings } = await load();
  for (const value of [null, undefined, "", 0, [], "not json"]) {
    assert.ok(bridgeRunFindings(value, expected).length > 0, `${JSON.stringify(value)} passed`);
  }
});

test("the run id and repository shapes are checked before any request", async () => {
  const { requestFindings } = await load();
  assert.deepEqual(requestFindings("1234567890", EXPECTED_REPOSITORY), []);
  for (const [runId, repository] of [
    ["not-a-number", EXPECTED_REPOSITORY],
    ["12 34", EXPECTED_REPOSITORY],
    ["", EXPECTED_REPOSITORY],
    ["1234567890", "no-slash"],
    ["1234567890", "owner/repo; rm -rf /"],
    ["1234567890", "../../etc/passwd"],
    [undefined, EXPECTED_REPOSITORY],
  ]) {
    assert.ok(
      requestFindings(runId, repository).length > 0,
      `${String(runId)} / ${String(repository)} was accepted`,
    );
  }
});
