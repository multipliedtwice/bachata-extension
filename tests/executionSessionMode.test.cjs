const assert = require("node:assert/strict");
const test = require("node:test");
const { assertAdapterSessionMode } = require("../dist/adapters/types.js");

test("fresh execution-state mode refuses seeded resume identifiers, including an explicit undefined property", () => {
  assert.doesNotThrow(() => assertAdapterSessionMode({ sessionMode: "freshExecutionState" }));
  assert.throws(() => assertAdapterSessionMode({ sessionMode: "freshExecutionState", sessionId: "old" }), /resume/);
  assert.throws(() => assertAdapterSessionMode({ sessionMode: "freshExecutionState", sessionId: undefined }), /resume/);
  assert.throws(() => assertAdapterSessionMode(Object.assign(Object.create({ sessionId: "inherited" }), { sessionMode: "freshExecutionState" })), /resume/);
  assert.throws(() => assertAdapterSessionMode({ sessionMode: "unknown" }), /Unknown/);
  assert.doesNotThrow(() => assertAdapterSessionMode({ sessionId: "old" }));
  assert.doesNotThrow(() => assertAdapterSessionMode({ sessionMode: "existing", sessionId: "old" }));
});
