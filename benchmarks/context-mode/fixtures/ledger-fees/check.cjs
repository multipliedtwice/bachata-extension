const path = require("node:path");
const assert = require("node:assert/strict");

const workspace = path.resolve(process.argv[2]);
const { balance } = require(path.join(workspace, "src", "ledger.js"));
const cases = [
  [[{ type: "card", amount: "19.00" }], "18.71"],
  [[{ type: "card", amount: "-1.00" }], "-0.98"],
  [[{ type: "card", amount: "1.00" }, { type: "card", amount: "-1.00" }], "0.00"],
  [[{ type: "transfer", amount: "58.00" }], "57.85"],
  [[{ type: "cash", amount: "0.10" }, { type: "cash", amount: "0.20" }, { type: "cash", amount: "0.30" }], "0.60"],
  [[{ type: "card", amount: "67.00" }, { type: "transfer", amount: "-0.10" }], "65.89"],
  [[{ type: "card", amount: "0.70" }], "0.69"],
  [[{ type: "card", amount: "-3.00" }], "-2.95"],
  [[{ type: "cash", amount: "-0.05" }], "-0.05"],
];
for (const [entries, expected] of cases) {
  assert.equal(balance(entries), expected, JSON.stringify(entries));
}
