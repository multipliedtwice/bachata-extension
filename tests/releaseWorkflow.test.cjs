const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "paired-release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

const lineOf = (needle, from = 0) => {
  const index = workflow.indexOf(needle, from);
  assert.ok(index >= 0, `paired-release.yml does not contain ${JSON.stringify(needle)}`);
  return workflow.slice(0, index).split("\n").length;
};

// BACHATA-AUD-01 / EX-AUD-08. These are static assertions about the workflow, because no CI run
// is available to execute it. They cover the failure modes a review found rather than the
// happy path: an unusable token, and artifacts taken from a run that never passed its gates.

test("cross-repository downloads never use the repository-scoped GITHUB_TOKEN", () => {
  // GITHUB_TOKEN is minted for this repository. `download-artifact` reading another
  // repository needs `actions: read` there, which that token cannot carry, so the job would
  // fail before verifying anything.
  const downloads = workflow.split("actions/download-artifact@v4").slice(1);
  assert.ok(downloads.length >= 3, `expected three cross-repository downloads, saw ${String(downloads.length)}`);
  for (const [index, block] of downloads.entries()) {
    const step = block.slice(0, block.indexOf("\n      - name:") + 1 || undefined);
    assert.equal(
      /github-token:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/u.test(step),
      false,
      `download ${String(index + 1)} authenticates with GITHUB_TOKEN`,
    );
  }
});

test("every cross-repository download uses the dedicated read token", () => {
  const downloads = workflow.split("actions/download-artifact@v4").slice(1);
  for (const [index, block] of downloads.entries()) {
    assert.match(
      block.slice(0, 600),
      /github-token:\s*\$\{\{\s*secrets\.BRIDGE_ARTIFACT_READ_TOKEN\s*\}\}/u,
      `download ${String(index + 1)} does not use BRIDGE_ARTIFACT_READ_TOKEN`,
    );
  }
});

test("a missing read token fails early with an actionable message", () => {
  const guard = lineOf("Require the Browser Bridge artifact read token");
  const firstDownload = lineOf("actions/download-artifact@v4");
  assert.ok(guard < firstDownload, "the token guard runs after the first download");
  assert.match(workflow, /BRIDGE_ARTIFACT_READ_TOKEN is not set\./u);
  assert.match(workflow, /Actions: read on/u);
});

test("the run's success and identity are checked before anything is downloaded", () => {
  const check = lineOf("Refuse a run that is not a successful Bridge release build");
  const firstDownload = lineOf("actions/download-artifact@v4");
  assert.ok(check < firstDownload, "the run check runs after the first download");
  // What the check decides is asserted against API-shaped responses in
  // tests/bridgeRunValidation.test.cjs. Here we only assert that the workflow delegates to
  // it and hands it the values it needs.
  assert.match(workflow, /run: node scripts\/verify-bridge-run\.mjs/u);
  assert.match(workflow, /EXPECTED_WORKFLOW_PATH: \.github\/workflows\/release-artifact\.yml/u);
});

test("workflow inputs reach the shell through the environment, not interpolation", () => {
  // `${{ inputs.x }}` expanded inside a run script is substituted before bash sees it, so an
  // input containing shell syntax would execute. Inputs are bound to env vars instead.
  const runScripts = workflow.split(/\n {8}run: \|/u).slice(1);
  for (const script of runScripts) {
    const body = script.split(/\n {6}- name:/u)[0];
    assert.equal(
      /\$\{\{\s*inputs\./u.test(body),
      false,
      `a run script interpolates a workflow input directly:\n${body.slice(0, 200)}`,
    );
  }
  assert.match(workflow, /BRIDGE_RUN_ID: \$\{\{ inputs\.bridge_run_id \}\}/u);
  assert.match(workflow, /BRIDGE_REPOSITORY: \$\{\{ inputs\.bridge_repository \}\}/u);
});

test("the token is never printed", () => {
  assert.equal(
    /echo[^\n]*\$\{?BRIDGE_ARTIFACT_READ_TOKEN/u.test(workflow),
    false,
    "the workflow echoes the read token",
  );
});

test("the archive-required environment variable is set for the test step", () => {
  assert.match(workflow, /BACHATA_REQUIRE_RELEASE_ARTIFACTS: "1"/u);
});

test("source drift is refused before release binding intentionally updates records", () => {
  const drift = lineOf("Refuse source drift from the gates");
  const bind = lineOf("Bind the measured artifact hashes into the release records");
  assert.ok(
    drift < bind,
    "the post-bind drift gate rejects the release records that release:bind must update",
  );
});

test("downloaded Bridge inputs stay outside the source drift check", () => {
  assert.doesNotMatch(workflow, /(?:github\.workspace|GITHUB_WORKSPACE)[^\n]*\/bridge-(?:artifact|contract|dist)/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/bridge-artifact/u);
});

test("acceptance verifies the existing candidate instead of rebuilding its bytes", () => {
  assert.match(workflow, /name: Build the candidate VSIX\n\s+if: inputs\.phase == 'candidate'/u);
  assert.match(workflow, /name: Download the already tested VSIX\n\s+if: inputs\.phase == 'verify'/u);
  assert.match(workflow, /name: Release verification\n\s+if: inputs\.phase == 'verify'/u);
  assert.ok(lineOf("Release verification") < lineOf("Retain the exact approved artifacts for deployment"));
});

test("marketplace publication consumes a verified bundle and never rebuilds or versions it", () => {
  const deploy = fs.readFileSync(path.join(root, ".github/workflows/publish-marketplaces.yml"), "utf8");
  assert.match(deploy, /environment: marketplace/u);
  assert.match(deploy, /EXPECTED_COMMIT: \$\{\{ github\.sha \}\}/u);
  assert.match(deploy, /EXPECTED_RUN_ATTEMPT: \$\{\{ inputs\.release_run_attempt \}\}/u);
  assert.match(deploy, /EXPECTED_EVENT: workflow_dispatch/u);
  assert.match(deploy, /--azure-credential --packagePath/u);
  assert.doesNotMatch(deploy, /npm (?:version|run (?:build|package))|vsce publish (?:major|minor|patch)/u);
  assert.ok(deploy.indexOf("release-bundle.mjs verify") < deploy.indexOf("publish-chrome-store.mjs"));
});
