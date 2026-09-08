const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const { isDeclarableVerificationCommand } = require("../dist/orchestrator/verificationPolicy.js");

const documentationFiles = () => {
  const directory = path.join(__dirname, "..", "docs");
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(directory, name), "utf8") }));
};

test("documented checklist checks use only controller-owned verification operations", () => {
  const offenders = [];
  for (const { name, source } of documentationFiles()) {
    for (const match of source.matchAll(/"checks"\s*:\s*\[([^\]]*)\]/gu)) {
      const commands = Array.from(match[1].matchAll(/"([^"]+)"/gu), (entry) => entry[1]);
      commands
        .filter((command) => !isDeclarableVerificationCommand(command))
        .forEach((command) => offenders.push(`${name}: ${command}`));
    }
  }
  assert.deepEqual(offenders, []);
});

test("documented TODO verification lines use only controller-owned operations", () => {
  const offenders = [];
  for (const { name, source } of documentationFiles()) {
    for (const match of source.matchAll(/^\s*-\s*Verify(?: Final)?:\s*(\S+)\s*$/gmu)) {
      const command = match[1].trim();
      if (command === "none") continue;
      if (!isDeclarableVerificationCommand(command)) offenders.push(`${name}: ${command}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("settings stay grouped with advanced limits separated from essentials", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const groups = [packageJson.contributes.configuration].flat();
  assert.ok(groups.length >= 2, "settings are not grouped");
  const titles = groups.map((group) => group.title);
  assert.equal(titles[0], "Bachata");
  assert.ok(titles.includes("Bachata: Advanced"));

  const keys = groups.flatMap((group) => Object.keys(group.properties));
  assert.equal(new Set(keys).size, keys.length, "a setting appears in two groups");

  const essentials = Object.keys(groups[0].properties);
  assert.ok(essentials.length <= 12, "the first settings group is not a short list");
  assert.ok(essentials.includes("bachata.codexCommand"));
  assert.ok(essentials.includes("bachata.defaultPipelineIterations"));
  assert.ok(essentials.includes("bachata.preferredProvider"));
  assert.ok(essentials.includes("bachata.notificationMode"));
  assert.ok(
    essentials.every((key) => !/TimeoutMs|MaxBytes|Concurrent|^bachata\.max/u.test(key)),
    "low-level limits leaked into the essential settings group",
  );
});

test("development documentation states the declared Node floor", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const development = fs.readFileSync(
    path.join(__dirname, "..", "docs", "DEVELOPMENT.md"),
    "utf8",
  );
  assert.equal(packageJson.engines?.node, ">=22.13.0");
  assert.ok(development.includes(packageJson.engines.node));
});

test("the stable release gate names the run-contract and evidence requirements", () => {
  const gate = fs.readFileSync(
    path.join(__dirname, "..", "docs", "STABLE_RELEASE_GATE.md"),
    "utf8",
  );
  for (const marker of [
    "Run-contract and evidence gate",
    "per-role managed authority",
    "refuse to start on any blocking preflight finding",
    "survive an Extension Host restart",
    "no provider conversation URL path",
  ]) {
    assert.equal(gate.includes(marker), true, `Missing stable gate requirement: ${marker}`);
  }
});

test("the live smoke test verifies contract authority and export privacy", () => {
  const smoke = fs.readFileSync(
    path.join(__dirname, "..", "docs", "LIVE_SMOKE_TEST.md"),
    "utf8",
  );
  for (const marker of [
    "Run contract and export privacy with live providers",
    "Contract matches applied authority (browser)",
    "Generic capability gate",
    "Export contains no session or conversation identity",
  ]) {
    assert.equal(smoke.includes(marker), true, `Missing live smoke gate: ${marker}`);
  }
});

const releaseCriticalDocuments = [
  "README.md",
  "CHANGELOG.md",
  "NO_TELEMETRY.md",
  "docs/PRODUCT_DOCTRINE.md",
  "docs/RELEASE_VERDICT.md",
  "docs/RELEASE_VALIDATION_RECORD.md",
  "docs/MODERATED_VALIDATION.md",
  "docs/STABLE_RELEASE_GATE.md",
  "docs/COMPATIBILITY_MATRIX.md",
  "docs/PROVIDER_TERMS.md",
  "docs/BROWSER_BRIDGE_INSTALL.md",
  "docs/PRIVACY.md",
  "docs/SECURITY.md",
  "media/walkthrough-provider.md",
  "media/walkthrough-doctor.md",
  "media/walkthrough-setup.md",
  "media/walkthrough-run.md",
  "media/walkthrough-evidence.md",
  "media/walkthrough-resolve.md",
  "media/walkthrough-apply.md",
  "media/walkthrough-fresh-review.md",
  "media/walkthrough-compare-rounds.md",
  "media/walkthrough-next-action.md",
  "benchmarks/README.md",
  "benchmarks/runs/README.md",
  "benchmarks/longitudinal/README.md",
  "benchmarks/longitudinal/runs/README.md",
];

test("product doctrine fixes problem-general refinement, software focus, human direction, attention, and friction boundaries", () => {
  const root = path.join(__dirname, "..");
  const doctrine = fs.readFileSync(path.join(root, "docs", "PRODUCT_DOCTRINE.md"), "utf8");
  for (const marker of [
    "Bachata exists to improve precision of theoretical and practical problem solving",
    "Core coordination model is problem-general",
    "Do not confuse initiative, cycle, and pipeline run",
    "Solution quality accumulates in accepted state and external evidence across cycles",
    "Only human authority can correct direction",
    "Top-level control surface shows current initiative direction without requiring transcript reading",
    "Initial Lead and Worker findings are provisional competing hypotheses",
    "There is no actual pipeline bug list before these competing claims converge on dispositions",
    "Only accepted findings enter the actionable list",
    "Lead is not right because role is Lead",
    "Deduplicate by subject and affected scope, not wording",
    "No automatic state means “quality achieved.”",
    "They are subordinate mechanics, not product value",
    "Breadth is not a defect or apology",
    "Custom pipeline defines artifact, roles, challenge/revision flow, evidence, human escalation, and convergence",
    "More agents create more opportunities for correction. They do not automatically increase accuracy",
    "custom pipeline makes Bachata a validated specialist product for every field",
  ]) {
    assert.equal(doctrine.includes(marker), true, `Missing product doctrine: ${marker}`);
  }

  for (const file of [
    "README.md",
    "docs/PRODUCT_SPEC.md",
    "docs/ROADMAP.md",
    "docs/PIPELINES.md",
    "docs/ORCHESTRATION.md",
    "docs/INTERACTIONS.md",
    "docs/SECURITY.md",
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(source.includes("PRODUCT_DOCTRINE.md"), true, `${file} must link product doctrine`);
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.description,
    "Review code with several AI agents in VS Code. They challenge each other, repeat the review "
      + "from a fresh start, and show what they found. You decide what gets fixed.",
    "the marketplace description no longer states the documented product claim",
  );
  assert.ok(
    packageJson.description.length <= 200,
    "the marketplace description is too long for the gallery to show in full",
  );
  assert.doesNotMatch(packageJson.description, /safety|security|permission/iu);
});

test("the local scope of initiative state is stated wherever it is claimed", () => {
  const root = path.join(__dirname, "..");
  for (const file of ["README.md", "docs/STATE.md", "docs/ROADMAP.md"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.equal(
      source.includes("Initiative state is local to this VS Code workspace"),
      true,
      `${file} must state that initiative state is local to the workspace`,
    );
    assert.equal(
      source.includes("does not claim portable or repository-backed initiative history"),
      true,
      `${file} must refuse the portability claim explicitly`,
    );
  }
  const state = fs.readFileSync(path.join(root, "docs", "STATE.md"), "utf8");
  assert.equal(state.includes("can require a new initiative"), true);
});

test("every release-critical document exists and is not ignored by Git", () => {
  const root = path.join(__dirname, "..");
  const missing = releaseCriticalDocuments.filter((file) => !fs.existsSync(path.join(root, file)));
  assert.deepEqual(missing, [], "release-critical documents are missing from the tree");

  const check = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: root,
    input: `${releaseCriticalDocuments.join("\n")}\n`,
    encoding: "utf8",
  });
  if (check.error || check.status === 128) return;
  const ignored = (check.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(
    ignored,
    [],
    "release-critical documents are ignored by Git and would be absent from a fresh checkout",
  );
});

const verdictSource = () =>
  fs.readFileSync(path.join(__dirname, "..", "docs", "RELEASE_VERDICT.md"), "utf8");

test("every recorded test count states the commands it sums", () => {
  const rows = verdictSource()
    .split("\n")
    .filter((line) => /^\|.*`npm test`/u.test(line));
  assert.ok(rows.length >= 2, "the verdict records no test-count rows to check");
  rows.forEach((row) => {
    const counted = /(\d[\d,]*) tests, (\d[\d,]*) passed, (\d[\d,]*) failed/u.exec(row);
    assert.ok(counted, `a test-count row records no tests/passed/failed triple: ${row}`);
    const [, total, passed, failed] = counted.map((value) => Number(String(value).replace(/,/gu, "")));
    assert.equal(failed, 0, `a recorded row claims a pass with ${String(failed)} failures: ${row}`);
    const skipped = /(\d+) skips?\b/u.exec(row);
    assert.equal(
      passed + (skipped ? Number(skipped[1]) : 0),
      total,
      `a recorded row's passed plus skipped does not equal its total: ${row}`,
    );
    assert.match(
      row,
      /test:source-distribution/u,
      `a recorded count does not name the commands it sums: ${row}`,
    );
  });
});

test("the verdict fixes one test-count convention rather than leaving it implied", () => {
  assert.match(
    verdictSource(),
    /every `node --test` invocation the package's `npm test` chain\nruns, summed/u,
    "the verdict states no counting convention, so 188 and 191 can both look correct",
  );
});

test("coverage evidence is claimed as a threshold, not as a reproducible percentage", () => {
  assert.match(
    verdictSource(),
    /the floors, not these percentages, are the claim/u,
    "coverage evidence does not state that the enforced floor, not one observed percentage, is the claim",
  );
  const declared = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  // Read the enforced floors rather than restating them: raising a gate after adding tests
  // must not require editing this guard, but the verdict must still name what is enforced.
  const script = declared.scripts["test:coverage:source"];
  const verdict = verdictSource();
  for (const name of ["lines", "branches", "functions"]) {
    const enforced = new RegExp(`--test-coverage-${name}=(\\d+)`, "u").exec(script);
    assert.notEqual(enforced, null, `test:coverage:source declares no ${name} floor`);
    assert.ok(
      verdict.includes(`${enforced[1]} / `) || verdict.includes(`/ ${enforced[1]}`),
      `docs/RELEASE_VERDICT.md does not name the enforced ${name} floor of ${enforced[1]}`,
    );
  }
});

test("the documented artifact vocabulary matches the shipped type union", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "longitudinal", "types.ts"),
    "utf8",
  );
  const union = /export type ArtifactType =([\s\S]*?);/u.exec(source);
  assert.ok(union, "ArtifactType is no longer a union this guard can read");
  const declared = Array.from(union[1].matchAll(/"([a-zA-Z]+)"/gu), (match) => match[1]).sort();
  assert.ok(declared.length > 0);
  documentationFiles().forEach(({ name, source: text }) => {
    const listed = /artifact (?:may be|:) ([^;.]+)[;.]/u.exec(text);
    if (!listed) return;
    const words = Array.from(listed[1].matchAll(/([a-zA-Z]+)/gu), (match) => match[1])
      .filter((word) => !["or", "a", "an", "custom", "typed", "output", "finding", "set", "type"].includes(word));
    words.forEach((word) => {
      assert.ok(
        declared.includes(word),
        `${name} lists artifact type "${word}", which ArtifactType does not declare`,
      );
    });
  });
});

test("public positioning leads with configurable workflows and claims no uniqueness", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const beforeCaveats = readme.slice(0, readme.indexOf("## What this does not prove"));
  assert.ok(
    beforeCaveats.includes("give each a job, and arrange the steps."),
    "the README no longer explains configurable roles and sequence",
  );
  assert.ok(
    readme.includes("## What this does not prove"),
    "the epistemic caveats were removed rather than moved below the benefit",
  );
  assert.ok(
    readme.indexOf("Only a human can correct direction") > readme.indexOf("## Build your own AI workflow"),
    "the caveats moved back above the benefit",
  );
  [
    /\bnobody else\b/iu,
    /\bthe only (?:product|tool|extension)\b/iu,
    /\bunique(?:ly)?\b/iu,
    /\bfirst (?:product|tool|extension) to\b/iu,
  ].forEach((pattern) => {
    assert.doesNotMatch(readme, pattern, `the README makes an unsupported uniqueness claim: ${String(pattern)}`);
  });
});

test("the heavy graph-context dependencies stay behind a lazy require", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "context", "tsJsContext.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /^import .* from "ts-morph"/mu,
    "ts-morph is imported at module load, so it would be paid for on activation",
  );
  assert.match(source, /require\("ts-morph"\)/u);
  const consumers = ["src/extension.ts", "src/runtime/createRuntime.ts"];
  consumers.forEach((relative) => {
    const text = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
    assert.doesNotMatch(
      text,
      /from "ts-morph"|require\("ts-morph"\)/u,
      `${relative} pulls ts-morph into the activation path`,
    );
  });
});
