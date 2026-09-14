const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Cypress source specs remain visible while root artifacts stay ignored", () => {
  const root = path.resolve(__dirname, "..");
  const spec = "tests/cypress/execution-result-hierarchy.cy.cjs";
  const rules = readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/u).map((line) => line.trim());
  assert.equal(rules.includes("/cypress/"), true);
  assert.equal(rules.includes("cypress"), false);
  assert.equal(rules.includes("cypress/"), false);
  assert.equal(existsSync(path.join(root, spec)), true);
  const source = spawnSync("git", ["check-ignore", "--no-index", spec], { cwd: root, encoding: "utf8" });
  assert.equal(source.status, 1, source.stderr || source.stdout);
  assert.equal(source.stdout, "");
  const artifact = spawnSync("git", ["check-ignore", "cypress/screenshots/generated.png"], { cwd: root, encoding: "utf8" });
  assert.equal(artifact.status, 0, artifact.stderr);
  assert.equal(artifact.stdout.trim(), "cypress/screenshots/generated.png");
  const visible = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", spec], { cwd: root, encoding: "utf8" });
  assert.equal(visible.status, 0, visible.stderr);
  assert.deepEqual(visible.stdout.trim().split(/\r?\n/u), [spec]);
});
