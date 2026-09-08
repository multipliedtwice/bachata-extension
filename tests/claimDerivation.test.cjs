const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const presetNames = () =>
  fs.readdirSync(path.join(root, "presets")).filter((name) => name.endsWith(".json"));
const preset = (name) => JSON.parse(read(path.join("presets", name)));

const {
  assuranceLabel,
  assuranceStatement,
  controllerCheckDescription,
  controllerCheckSummary,
  declaresRepositoryVerifier,
} = require("../dist/contract/executionContract.js");

// The webview bundle is concatenated rather than module-linked, so it carries its own copy
// of the check descriptions. This test is what stops the copy from drifting.
test("the webview and the controller describe a controller check identically", () => {
  const webview = read("src/webview-ui/executionRender.ts");
  for (const command of ["bachata:workspace-integrity", "bachata:project-checks"]) {
    const described = controllerCheckDescription(command);
    assert.ok(
      webview.includes(`return "${described}"`),
      `the webview must describe ${command} as "${described}"`,
    );
  }
  assert.ok(
    webview.includes('repository verifier "'),
    "the webview must name a repository verifier the way the controller does",
  );
  assert.equal(controllerCheckDescription("bachata:verifier:npm-test"), 'repository verifier "npm-test"');
});

test("a controller-checked claim names the checks it will actually run", () => {
  const projectOnly = ["bachata:workspace-integrity", "bachata:project-checks"];
  const label = assuranceLabel("controllerVerified", projectOnly);
  assert.match(label, /^Controller-checked: /u);
  assert.match(label, /integrity, syntax and types/u);
  assert.doesNotMatch(label, /^Controller-verified$/u);

  const statement = assuranceStatement("controllerVerified", projectOnly);
  assert.match(statement, /No repository test suite is declared for this run, so none runs\./u);
  assert.match(statement, /Bachata does not roll them back/u);

  const withVerifier = ["bachata:project-checks", "bachata:verifier:npm-test"];
  assert.match(assuranceLabel("controllerVerified", withVerifier), /repository verifier "npm-test"/u);
  assert.doesNotMatch(
    assuranceStatement("controllerVerified", withVerifier),
    /No repository test suite is declared/u,
  );
  assert.equal(declaresRepositoryVerifier(projectOnly), false);
  assert.equal(declaresRepositoryVerifier(withVerifier), true);
  assert.equal(controllerCheckSummary([]), "no declared check");
});

test("an isolated claim never says the workspace changed, and a direct one never says isolated", () => {
  const isolated = assuranceStatement("isolatedApplicable", ["bachata:project-checks"]);
  assert.match(isolated, /retained worktree/u);
  assert.doesNotMatch(isolated, /land in your selected workspace/u);
  const direct = assuranceStatement("controllerVerified", ["bachata:project-checks"]);
  assert.match(direct, /land in your selected workspace/u);
  assert.doesNotMatch(direct, /retained worktree/u);
});

test("no shipped preset declares a revision loop its own adapters cannot run", () => {
  for (const name of presetNames()) {
    const definition = preset(name);
    const declared = definition.managedPolicy?.maxRevisionCycles;
    if (declared === undefined) continue;
    const adapters = (definition.agents ?? []).map((agent) => agent.adapter ?? "");
    assert.ok(
      adapters.some((adapter) => adapter.endsWith("-browser")),
      `${name} declares maxRevisionCycles but no agent runs the managed browser revision loop`,
    );
  }
});

test("no user-facing surface reintroduces the superseded claims", () => {
  const surfaces = [
    "src/commands/registerCommands.ts",
    "src/webview-ui/executionRender.ts",
    "src/webview-ui/directionRender.ts",
    "src/notifications/derive.ts",
    "src/workflows/recommendation.ts",
    "src/contract/executionContract.ts",
  ];
  for (const relative of surfaces) {
    const source = read(relative);
    assert.doesNotMatch(source, /nothing is uploaded/u, `${relative} must not claim nothing is uploaded`);
    assert.doesNotMatch(source, /"controller-verified"/u, `${relative} must name the checks instead`);
  }
  assert.match(
    read("src/commands/registerCommands.ts"),
    /Bachata has no hosted service; selected content goes to the providers you configure\./u,
  );
  assert.match(
    read("src/webview-ui/directionRender.ts"),
    /Not observed in a fresh review: model non-observation, not a deterministic check/u,
  );
});
