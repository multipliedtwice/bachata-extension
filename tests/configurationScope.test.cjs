const assert = require("node:assert/strict");
const test = require("node:test");

const { mostSpecificPositiveNumber } = require("../dist/runtime/configurationScope.js");

test("folder scope wins over workspace and global, matching VS Code specificity", () => {
  assert.equal(
    mostSpecificPositiveNumber({ globalValue: 1000, workspaceValue: 2000, workspaceFolderValue: 3000 }),
    3000,
  );
  assert.equal(mostSpecificPositiveNumber({ globalValue: 1000, workspaceValue: 2000 }), 2000);
  assert.equal(mostSpecificPositiveNumber({ globalValue: 1000 }), 1000);
});

test("less specific scopes fill in only when a more specific scope is unset", () => {
  assert.equal(mostSpecificPositiveNumber({ globalValue: 1000, workspaceFolderValue: 3000 }), 3000);
  assert.equal(mostSpecificPositiveNumber({ workspaceValue: 2000, workspaceFolderValue: 3000 }), 3000);
});

test("non-positive and non-finite values are skipped rather than selected", () => {
  assert.equal(mostSpecificPositiveNumber({ workspaceFolderValue: 0, globalValue: 1000 }), 1000);
  assert.equal(mostSpecificPositiveNumber({ workspaceFolderValue: -5, workspaceValue: 2000 }), 2000);
  assert.equal(mostSpecificPositiveNumber({ workspaceFolderValue: Number.NaN, globalValue: 1000 }), 1000);
  assert.equal(mostSpecificPositiveNumber({ workspaceFolderValue: Number.POSITIVE_INFINITY, globalValue: 1000 }), 1000);
});

test("an absent or empty setting yields undefined", () => {
  assert.equal(mostSpecificPositiveNumber(undefined), undefined);
  assert.equal(mostSpecificPositiveNumber({}), undefined);
});
