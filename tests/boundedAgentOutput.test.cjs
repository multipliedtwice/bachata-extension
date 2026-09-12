const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  AGENT_OUTPUT_ELISION,
  AGENT_OUTPUT_UNITS,
  boundedAgentOutput,
} = require("../dist/state/boundedAgentOutput.js");

const root = path.resolve(__dirname, "..");

test("a stream shorter than the cap is left exactly as it arrived", () => {
  assert.equal(boundedAgentOutput("hello"), "hello");
  const exact = "x".repeat(AGENT_OUTPUT_UNITS);
  assert.equal(boundedAgentOutput(exact), exact);
});

test("a stream past the cap keeps its newest output and says the rest was cut", () => {
  const bounded = boundedAgentOutput(`${"a".repeat(AGENT_OUTPUT_UNITS)}TAIL`);
  assert.ok(bounded.length <= AGENT_OUTPUT_UNITS, `${String(bounded.length)} units retained`);
  assert.ok(bounded.startsWith(AGENT_OUTPUT_ELISION));
  assert.ok(bounded.endsWith("TAIL"));
});

test("accumulating a stream one delta at a time stays bounded", () => {
  let output = "";
  for (let index = 0; index < 200; index += 1) {
    output = boundedAgentOutput(`${output}${"d".repeat(8_000)}`);
  }
  assert.ok(output.length <= AGENT_OUTPUT_UNITS, `${String(output.length)} units retained`);
});

test("bounding an already bounded stream is a fixed point", () => {
  const once = boundedAgentOutput("z".repeat(AGENT_OUTPUT_UNITS * 3));
  assert.equal(boundedAgentOutput(once), once);
});

test("an astral pair is never cut in half at the front", () => {
  const bounded = boundedAgentOutput("🙂".repeat(AGENT_OUTPUT_UNITS));
  assert.equal(/[\uDC00-\uDFFF]/u.test(bounded.slice(AGENT_OUTPUT_ELISION.length, AGENT_OUTPUT_ELISION.length + 1)), false);
  assert.ok(bounded.length <= AGENT_OUTPUT_UNITS);
});

const helperBody = (relative) => {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  return source
    .replace(/^\/\*\*[\s\S]*?cannot drift\.\n \*\/\n\n/u, "")
    .replace(/^export const /gmu, "const ")
    .trim();
};

test("the webview copy of the helper matches the extension-host module", () => {
  assert.equal(
    helperBody("src/webview-ui/boundedAgentOutput.ts"),
    helperBody("src/state/boundedAgentOutput.ts"),
    "src/webview-ui/boundedAgentOutput.ts and src/state/boundedAgentOutput.ts have drifted; the webview bundle cannot import the module, so the two copies are kept identical by hand",
  );
});
