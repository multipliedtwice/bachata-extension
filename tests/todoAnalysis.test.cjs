const assert = require("node:assert/strict");
const test = require("node:test");

const { analyzeTodo, renderTodoPlan } = require("../dist/orchestrator/todoAnalysis.js");

const options = {
  pipelineId: "todo-implementation",
  retries: 1,
  requirePaths: true,
  requireControllerVerification: true,
};

const analyze = (source) => analyzeTodo(source, options);
const codes = (analysis) => analysis.diagnostics.map((entry) => entry.code);

test("a well-formed document produces no diagnostics", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Verify: bachata:project-checks",
    "- [ ] [B] Second",
    "  - Depends on: A",
    "  - Paths: src/b",
    "  - Verify: none",
  ].join("\n"));
  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(analysis.tasks.map((task) => task.id), ["A", "B"]);
  assert.deepEqual(analysis.waves, [["A"], ["B"]]);
});

test("a missing scope and a missing verification are reported with line-level fixes", () => {
  const analysis = analyze("- [ ] [A] First\n");
  assert.deepEqual(codes(analysis).sort(), ["todo.missingPaths", "todo.missingVerify"]);
  const paths = analysis.diagnostics.find((entry) => entry.code === "todo.missingPaths");
  assert.equal(paths.line, 1);
  assert.deepEqual(paths.fixes, [{
    title: "Add Paths: .",
    line: 1,
    text: "  - Paths: .",
    mode: "insertAfter",
  }]);
  const verify = analysis.diagnostics.find((entry) => entry.code === "todo.missingVerify");
  assert.deepEqual(verify.fixes.map((fix) => fix.title), [
    "Add Verify: bachata:project-checks",
    "Add Verify: none",
  ]);
});

test("a misspelled metadata key suggests the closest real key", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Pathz: src/a",
    "  - Verify: none",
  ].join("\n"));
  const unknown = analysis.diagnostics.find((entry) => entry.code === "todo.unknownKey");
  assert.ok(unknown);
  assert.match(unknown.message, /Did you mean "Paths"/u);
  assert.equal(unknown.line, 2);
  assert.deepEqual(unknown.fixes[0], {
    title: "Change to Paths",
    line: 2,
    text: "  - Paths: src/a",
    mode: "replaceLine",
  });
});

test("an arbitrary verification command is refused with controller-owned alternatives", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Verify: npm test",
  ].join("\n"));
  const unsupported = analysis.diagnostics.find((entry) => entry.code === "todo.unsupportedVerification");
  assert.ok(unsupported);
  assert.match(unsupported.message, /bachata:verifier:<id>/u);
  assert.deepEqual(unsupported.fixes.map((fix) => fix.title), [
    "Use bachata:project-checks",
    "Use bachata:workspace-integrity",
  ]);
});

test("a repository verifier descriptor is accepted in a TODO file", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Verify: bachata:verifier:unit-tests",
  ].join("\n"));
  assert.deepEqual(codes(analysis), []);
});

test("dependency cycles, unknown dependencies, and self-dependencies are located", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Depends on: B",
    "  - Paths: src/a",
    "  - Verify: none",
    "- [ ] [B] Second",
    "  - Depends on: A",
    "  - Paths: src/b",
    "  - Verify: none",
    "- [ ] [C] Third",
    "  - Depends on: C, MISSING",
    "  - Paths: src/c",
    "  - Verify: none",
  ].join("\n"));
  assert.ok(codes(analysis).includes("todo.dependencyCycle"));
  assert.ok(codes(analysis).includes("todo.selfDependency"));
  assert.ok(codes(analysis).includes("todo.unknownDependency"));
  assert.equal(analysis.cycles.length, 1);
  assert.deepEqual(analysis.cycles[0].slice(0, 2).sort(), ["A", "B"]);
});

test("independent tasks that share a write scope are flagged before they run together", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src",
    "  - Verify: none",
    "- [ ] [B] Second",
    "  - Paths: src/api",
    "  - Verify: none",
    "- [ ] [C] Third",
    "  - Depends on: A",
    "  - Paths: src/api",
    "  - Verify: none",
  ].join("\n"));
  const conflict = analysis.diagnostics.find((entry) => entry.code === "todo.pathConflict");
  assert.ok(conflict);
  assert.match(conflict.message, /can run at the same time/u);
  assert.deepEqual(analysis.pathConflicts.map((entry) => entry.taskIds.sort()), [["A", "B"], ["B", "C"]]);
});

test("execution order groups tasks that may run together, highest priority first", () => {
  const analysis = analyze([
    "- [x] [DONE] Already finished",
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Verify: none",
    "  - Priority: 5",
    "- [ ] [B] Second",
    "  - Paths: src/b",
    "  - Verify: none",
    "  - Priority: 20",
    "- [ ] [C] Third",
    "  - Depends on: A, B",
    "  - Paths: src/c",
    "  - Verify: none",
  ].join("\n"));
  assert.deepEqual(analysis.waves, [["B", "A"], ["C"]]);
});

test("a duplicate id and a duplicate key are both reported", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Paths: src/b",
    "  - Verify: none",
    "- [ ] [A] Duplicate",
    "  - Paths: src/c",
    "  - Verify: none",
  ].join("\n"));
  assert.ok(codes(analysis).includes("todo.duplicateKey"));
  assert.ok(codes(analysis).includes("todo.duplicateId"));
});

test("the plan preview states order, graph, conflicts, and problems", () => {
  const analysis = analyze([
    "- [ ] [A] First",
    "  - Paths: src/a",
    "  - Verify: none",
    "- [ ] [B] Second",
    "  - Depends on: A",
    "  - Paths: src/a",
    "  - Verify: none",
  ].join("\n"));
  const plan = renderTodoPlan(analysis, "TODO.md");
  assert.match(plan, /# TODO\.md plan/u);
  assert.match(plan, /## Execution order/u);
  assert.match(plan, /1\. A/u);
  assert.match(plan, /```mermaid/u);
  assert.match(plan, /A --> B/u);
  assert.match(plan, /## Overlapping write scopes/u);
  assert.match(plan, /_No overlapping write scope between independent tasks\._/u);
  assert.match(plan, /## Problems/u);
});
