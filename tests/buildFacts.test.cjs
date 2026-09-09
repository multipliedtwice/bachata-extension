const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const factsPath = path.join(root, "BUILD_FACTS.md");
const generator = path.join(root, "scripts", "build-facts.mjs");

const runGenerator = (args = [], cwd = root) =>
  spawnSync(process.execPath, [generator, ...args], { cwd, encoding: "utf8" });

const verdictWords = /\b(?:NO-SHIP|SHIP|ship it|release ready|approved for release)\b/u;

// EX-G6-18. This suite runs in a maintained-source distribution too, which carries no VCS
// metadata by design. A fact whose name says "Git-tracked" reports that it was not measured
// there, so the claims that are about the Git enumeration itself are checkout-only and say so
// rather than failing where they cannot hold.
const isGitCheckout = () => {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() === "true";
};

test("the generated build facts are current for this tree", () => {
  const result = runGenerator(["--check"]);
  assert.equal(
    result.status,
    0,
    `BUILD_FACTS.md is stale; run npm run docs:build-facts\n${result.stderr}`,
  );
});

test("the build facts carry measurements and no release decision", () => {
  const facts = fs.readFileSync(factsPath, "utf8");
  assert.equal(verdictWords.test(facts), false, "the generated facts state a release decision");
  assert.match(facts, /^# Build facts$/mu);
  assert.match(facts, /## Repository inventory/u);
  assert.match(facts, /## Observed on one machine/u);
  assert.match(
    facts,
    /\| Maintained source files \(Git-tracked\) \| (?:\d+|not enumerable without Git) \|/u,
  );
  assert.match(
    facts,
    /\| Maintained source manifest SHA-256 \(Git-tracked\) \| (?:[0-9a-f]{64}|not enumerable without Git) \|/u,
  );
  assert.match(facts, /\| Release-metadata findings \(identity stage\) \| \d+ \|/u);
});

test("the generator writes only its own file and never the human verdict", () => {
  const verdictPath = path.join(root, "docs", "RELEASE_VERDICT.md");
  const before = fs.readFileSync(verdictPath, "utf8");
  const factsBefore = fs.readFileSync(factsPath, "utf8");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-"));
  try {
    const result = runGenerator(["--out", path.join(scratch, "BUILD_FACTS.md")]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      fs.readFileSync(path.join(scratch, "BUILD_FACTS.md"), "utf8").includes("## Repository inventory"),
      "the generator did not write the requested output path",
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(verdictPath, "utf8"), before, "the generator rewrote the human verdict");
  assert.equal(
    fs.readFileSync(factsPath, "utf8"),
    factsBefore,
    "write mode rewrote the tracked facts instead of the requested output path",
  );
  const source = fs.readFileSync(generator, "utf8");
  assert.equal(
    /writeFileSync\((?!factsPath)/u.test(source),
    false,
    "the generator writes a file other than BUILD_FACTS.md",
  );
});

const comparedSection = (document) => {
  const start = document.indexOf("## Repository inventory");
  const end = document.indexOf("## Observed on one machine");
  assert.ok(start >= 0 && end > start, "the generated facts lost their compared section");
  return document.slice(start, end).trim();
};

test("check mode never writes the tracked facts", () => {
  const before = fs.readFileSync(factsPath, "utf8");
  const result = runGenerator(["--check"]);
  assert.equal(result.status, 0, `check mode failed: ${result.stderr}`);
  assert.equal(fs.readFileSync(factsPath, "utf8"), before, "check mode rewrote BUILD_FACTS.md");
});

// The gate compares only this slice. If it ever names the revision or the clean/dirty
// state again, no committed file can satisfy it: writing dirties the tree and committing
// moves HEAD, so the recorded answer is wrong the moment it lands.
test("the compared section is a fixed point that does not depend on revision or tree state", () => {
  const compared = comparedSection(fs.readFileSync(factsPath, "utf8"));
  assert.doesNotMatch(
    compared,
    /working tree was (?:modified|clean)|could not be determined/u,
    "clean/dirty prose is inside the compared section, which makes the gate unsatisfiable",
  );
  assert.doesNotMatch(
    compared,
    /\bcommit [0-9a-f]{7,}\b/u,
    "a revision is named inside the compared section, which makes the gate unsatisfiable",
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-fixed-"));
  try {
    const first = path.join(scratch, "first.md");
    const second = path.join(scratch, "second.md");
    assert.equal(runGenerator(["--out", first]).status, 0);
    assert.equal(runGenerator(["--out", second]).status, 0);
    assert.equal(
      comparedSection(fs.readFileSync(first, "utf8")),
      comparedSection(fs.readFileSync(second, "utf8")),
      "two generations of an unchanged tree disagreed on the compared section",
    );
    if (isGitCheckout()) {
      assert.equal(
        comparedSection(fs.readFileSync(first, "utf8")),
        compared,
        "regenerating an unchanged tree would not reproduce the committed compared section",
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// REVIEW-06, second half. The rule is not only that `--check` never writes: it is that no
// test writes the file whose staleness this suite reports. Two tests used to exercise
// `--test-log` against the tracked path and then "restore" it by regenerating, which does not
// restore anything — it rewrites the tracked facts from the current tree. On a checkout whose
// committed facts were stale that turned a real, permanent failure into a first-run-only one:
// the staleness assertions above run first and fail, the writers run after and make the file
// current, and every later run of the same suite passes. A gate that repairs what it measures
// reports the second run, not the tree.
test("no test in this suite writes the tracked facts", () => {
  const suite = fs.readFileSync(__filename, "utf8");
  // Split so this guard does not match its own search string.
  const marker = `runGenerator${"(["}`;
  const invocations = [];
  for (let at = suite.indexOf(marker); at >= 0; at = suite.indexOf(marker, at + 1)) {
    const end = suite.indexOf("])", at);
    assert.ok(end > at, "a generator invocation has no argument list");
    invocations.push(suite.slice(at, end));
  }
  assert.ok(invocations.length > 0, "the generator is no longer exercised at all");
  for (const invocation of invocations) {
    assert.ok(
      invocation.includes("--out") || invocation.includes("--check"),
      `${invocation.split("\n")[0]} runs the generator in write mode against the tracked file`,
    );
  }
  assert.doesNotMatch(
    suite,
    /runGenerator\(\s*\)/u,
    "an argumentless generator call regenerates the tracked BUILD_FACTS.md",
  );
});

test("the tree state the gate cannot compare is still recorded for a human", () => {
  const document = fs.readFileSync(factsPath, "utf8");
  const observed = document.slice(document.indexOf("## Observed on one machine"));
  assert.match(
    observed,
    /working tree was (?:modified|clean)|could not be determined/u,
    "the collector no longer records which commit these values describe",
  );
});

test("the human verdict keeps its own decision and cites the generated facts", () => {
  const verdict = fs.readFileSync(path.join(root, "docs", "RELEASE_VERDICT.md"), "utf8");
  assert.match(verdict, /\*\*(?:(?:NO-SHIP|SHIP) as a stable release|SHIP to VS Code Marketplace only: existing Bachata 0\.7\.0 VSIX, by explicit owner authorization\.)/u);
  assert.match(verdict, /BUILD_FACTS\.md/u);
});

// REVIEW-06. A check must not write the repository it is checking. `--out` moves both the
// write and the comparison to a scratch file, so drift can be simulated without the tracked
// facts ever being edited, and an interrupted run cannot leave the checkout dirty.
const withDriftedCopy = (mutate, body) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-drift-"));
  try {
    const copy = path.join(scratch, "BUILD_FACTS.md");
    fs.writeFileSync(copy, mutate(fs.readFileSync(factsPath, "utf8")));
    return body(copy);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

test("a drifted reproducible fact is reported instead of silently accepted", () => {
  const before = fs.readFileSync(factsPath, "utf8");
  // Contributed commands are counted from `package.json`, so this drift is measurable wherever
  // this suite runs — including a distribution with no checkout behind it.
  withDriftedCopy(
    (facts) => facts.replace(
      /\| Contributed commands \| (\d+) \|/u,
      "| Contributed commands | 1 |",
    ),
    (copy) => {
      const result = runGenerator(["--check", "--out", copy]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /records reproducible facts this tree no longer holds/u);
    },
  );
  if (isGitCheckout()) {
    withDriftedCopy(
      (facts) => facts.replace(
        /\| Maintained source files \(Git-tracked\) \| (\d+) \|/u,
        "| Maintained source files (Git-tracked) | 1 |",
      ),
      (copy) => {
        const result = runGenerator(["--check", "--out", copy]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /records reproducible facts this tree no longer holds/u);
      },
    );
  }
  assert.equal(fs.readFileSync(factsPath, "utf8"), before, "the check edited the tracked facts");
});

test("an environment-dependent observation never fails the check", () => {
  const before = fs.readFileSync(factsPath, "utf8");
  withDriftedCopy(
    (facts) => facts.replace(/\| Node \| [^|]+ \|/u, "| Node | v0.0.0 |"),
    (copy) => {
      assert.equal(runGenerator(["--check", "--out", copy]).status, 0);
    },
  );
  assert.equal(fs.readFileSync(factsPath, "utf8"), before, "the check edited the tracked facts");
});

test("a test count is recorded only from a real run log", () => {
  const before = fs.readFileSync(factsPath, "utf8");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-"));
  const empty = path.join(directory, "empty.log");
  fs.writeFileSync(empty, "nothing ran here\n");
  try {
    const refused = runGenerator([
      `--test-log=${empty}`,
      "--out",
      path.join(directory, "BUILD_FACTS.md"),
    ]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /do not record a run that did not happen/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(factsPath, "utf8"), before, "the check edited the tracked facts");
});

test("the collector contract is generated, not asserted as a fixed sentence", () => {
  const facts = fs.readFileSync(factsPath, "utf8");
  assert.match(facts, /Paths enumerated with `git ls-files`; untracked files are excluded\./u);
  assert.match(facts, /Bytes are read from the current working tree, not from Git objects\./u);
  assert.match(
    facts,
    /The working tree was (?:modified, so these values describe the working tree and not commit|clean, so these values also describe commit)/u,
    "the generated contract must state which tree state it measured",
  );
  assert.doesNotMatch(
    facts,
    /Derived from the tracked tree alone/u,
    "the superseded static scope claim must not return",
  );
});

test("generation records inventories and never a semantic guarantee", () => {
  const facts = fs.readFileSync(factsPath, "utf8");
  for (const forbidden of [/\bverified\b/iu, /\breversible\b/iu, /\bcorrect\b/iu, /cannot execute/iu]) {
    assert.doesNotMatch(facts, forbidden, `generated facts must not assert ${String(forbidden)}`);
  }
  assert.match(facts, /\| Declared artifact promotion types \| /u);
  assert.match(facts, /\| Benchmark arms declared \(Git-tracked tasks\) \| /u);
  assert.match(facts, /\| Moderated rows marked Not performed \| \d+ \|/u);
});

test("a modified tree is refused for release-level reproducibility", () => {
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  if (dirty.status !== 0) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-clean-"));
  const result = runGenerator([
    "--require-clean",
    "--out",
    path.join(scratch, "BUILD_FACTS.md"),
  ]);
  fs.rmSync(scratch, { recursive: true, force: true });
  if (dirty.stdout.trim().length > 0) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--require-clean refuses a modified or unknown working tree/u);
  } else {
    assert.equal(result.status, 0);
  }
});

test("a recorded test log is bound to an exit status and a candidate", () => {
  const before = fs.readFileSync(factsPath, "utf8");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-build-facts-bind-"));
  const log = path.join(directory, "run.log");
  const out = path.join(directory, "BUILD_FACTS.md");
  fs.writeFileSync(log, "\u2139 tests 3\n\u2139 pass 3\n\u2139 fail 0\n\u2139 skipped 0\n");
  try {
    const unbound = runGenerator([`--test-log=${log}`, "--out", out]);
    assert.equal(unbound.status, 1);
    assert.match(unbound.stderr, /requires --test-exit=/u);

    const recorded = runGenerator([
      `--test-log=${log}`,
      "--test-exit=0",
      "--test-source-digest=0000000000000000000000000000000000000000000000000000000000000000",
      "--out",
      out,
    ]);
    assert.equal(recorded.status, 0, recorded.stderr);
    const facts = fs.readFileSync(out, "utf8");
    assert.match(facts, /exit status 0/u);
    assert.match(facts, /is not this tree, so the log describes another candidate/u);
    assert.doesNotMatch(facts, /the candidate passe/iu);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(factsPath, "utf8"), before, "the check edited the tracked facts");
});
