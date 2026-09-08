const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "vscode") {
    return {
      Uri: { file: (value) => ({ fsPath: value, toString: () => `file://${value}` }) },
      Range: class Range {
        constructor(startLine, startCharacter, endLine, endCharacter) {
          this.start = { line: startLine, character: startCharacter };
          this.end = { line: endLine, character: endCharacter };
        }
      },
      Diagnostic: class Diagnostic {
        constructor(range, message, severity) {
          this.range = range;
          this.message = message;
          this.severity = severity;
        }
      },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { publishRunFindings } = require("../dist/results/publishFindings.js");
Module._load = originalLoad;

const collection = () => {
  const entries = new Map();
  return {
    entries,
    clear: () => entries.clear(),
    set: (uri, diagnostics) => entries.set(uri.fsPath, diagnostics),
  };
};

const result = (findings) => ({ checks: [], findings, changedFiles: [], evidence: [] });

const finding = (overrides = {}) => ({
  message: "retry is unbounded",
  severity: "warning",
  disposition: "accepted",
  location: { file: "src/retry.ts", startLine: 23, endLine: 23 },
  ...overrides,
});

test("only accepted findings are projected into the editor", () => {
  const target = collection();
  const published = publishRunFindings(
    target,
    result([
      finding(),
      finding({ disposition: "rejected", message: "not real" }),
      finding({ disposition: "proposed", message: "still a claim" }),
    ]),
    "/repo",
  );
  assert.equal(published.located, 1, "a projection carried a finding that was not accepted");
  const diagnostics = target.entries.get("/repo/src/retry.ts");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "retry is unbounded");
  assert.equal(diagnostics[0].source, "Bachata");
});

test("republishing removes projections that are no longer accepted", () => {
  const target = collection();
  publishRunFindings(target, result([finding()]), "/repo");
  assert.equal(target.entries.size, 1);

  // The finding was rejected in a later round.
  publishRunFindings(target, result([finding({ disposition: "rejected" })]), "/repo");
  assert.equal(
    target.entries.size,
    0,
    "a resolved or rejected finding was left projected in the editor",
  );
});

test("a projection carries the location that navigates back to the finding", () => {
  const target = collection();
  publishRunFindings(
    target,
    result([finding({ location: { file: "src/a.ts", startLine: 12, endLine: 14 } })]),
    "/repo",
  );
  const diagnostics = target.entries.get("/repo/src/a.ts");
  assert.equal(diagnostics[0].range.start.line, 11, "the projection lost its line provenance");
  assert.equal(diagnostics[0].range.end.line, 13);
});

test("projection is optional: no result publishes nothing and clears what was there", () => {
  const target = collection();
  publishRunFindings(target, result([finding()]), "/repo");
  const cleared = publishRunFindings(target, undefined, "/repo");
  assert.deepEqual(cleared, { located: 0, unlocated: 0 });
  assert.equal(target.entries.size, 0);
});
