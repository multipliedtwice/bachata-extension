const path = require("node:path");
const assert = require("node:assert/strict");

const workspace = path.resolve(process.argv[2]);
const { pageCount, pageItems, pages } = require(path.join(workspace, "src", "pagination.js"));
const items = Array.from({ length: 10 }, (_, index) => index + 1);
assert.equal(pageCount(10, 3), 4);
assert.equal(pageCount(9, 3), 3);
assert.equal(pageCount(0, 3), 0);
assert.deepEqual(pageItems(items, 1, 3), [1, 2, 3]);
assert.deepEqual(pageItems(items, 4, 3), [10]);
assert.deepEqual(pageItems(items, 5, 3), []);
assert.deepEqual(pages(items, 3).flat(), items);
assert.deepEqual(pages(items, 5), [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]);
