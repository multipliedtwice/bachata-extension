const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SERIALIZED_WEBVIEW_MESSAGE_TYPES,
  WEBVIEW_MESSAGE_DOMAIN,
  requiresWritableHost,
  unsupportedWebviewMessage,
  webviewDispatchPlan,
  webviewMessageDomain,
} = require("../dist/runtime/webviewDispatch.js");
const { RUNTIME_OPERATIONS } = require("../dist/webview/protocol.js");

test("every message type the protocol accepts has exactly one domain", () => {
  const types = Object.keys(WEBVIEW_MESSAGE_DOMAIN);
  assert.equal(new Set(types).size, types.length);
  for (const type of types) {
    assert.equal(typeof webviewMessageDomain(type), "string", type);
  }
});

test("a type nobody declared has no domain", () => {
  assert.equal(webviewMessageDomain("pipeline.detonate"), undefined);
  assert.equal(webviewMessageDomain(""), undefined);
});

test("domains group the messages one part of the runtime answers", () => {
  assert.equal(webviewMessageDomain("ready"), "session");
  assert.equal(webviewMessageDomain("message.send"), "conversation");
  assert.equal(webviewMessageDomain("run.gate"), "run");
  assert.equal(webviewMessageDomain("pipeline.save"), "catalog");
  assert.equal(webviewMessageDomain("bridge.discover"), "browser");
  assert.equal(webviewMessageDomain("transcript.loadOlder"), "transcript");
  assert.equal(webviewMessageDomain("queue.resume"), "queue");
  assert.equal(webviewMessageDomain("attachment.remove"), "attachment");
  assert.equal(webviewMessageDomain("approval.respond"), "approval");
});

test("pipeline.run belongs to the run domain, not the catalog that defines it", () => {
  assert.equal(webviewMessageDomain("pipeline.run"), "run");
  assert.equal(webviewMessageDomain("pipeline.select"), "catalog");
});

test("a panel that has just loaded may ask for state on a read-only host", () => {
  assert.equal(requiresWritableHost("ready"), false);
  for (const type of Object.keys(WEBVIEW_MESSAGE_DOMAIN)) {
    if (type === "ready") continue;
    assert.equal(requiresWritableHost(type), true, type);
  }
});

test("every serialized type is a message the protocol actually has", () => {
  for (const type of SERIALIZED_WEBVIEW_MESSAGE_TYPES) {
    assert.notEqual(webviewMessageDomain(type), undefined, type);
  }
});

test("nothing that ends or steers a live run is serialized behind the mutation queue", () => {
  for (const type of ["run.interrupt", "run.gate", "pipeline.run", "message.send", "ready"]) {
    assert.equal(SERIALIZED_WEBVIEW_MESSAGE_TYPES.includes(type), false, type);
  }
});

test("state-changing requests are serialized", () => {
  for (const type of ["pipeline.save", "attachment.add", "queue.resume", "task.reset"]) {
    assert.equal(SERIALIZED_WEBVIEW_MESSAGE_TYPES.includes(type), true, type);
  }
});

test("a plan is read off the raw value before it is known to be valid", () => {
  assert.deepEqual(
    webviewDispatchPlan({ type: "pipeline.save", requestId: "r-1", pipeline: "nonsense" }),
    { messageType: "pipeline.save", requestId: "r-1", serialize: true, settlesOnFailure: true },
  );
});

test("a value that is not a message plans nothing and settles nothing", () => {
  for (const raw of [undefined, null, 42, "ready", []]) {
    const plan = webviewDispatchPlan(raw);
    assert.equal(plan.serialize, false);
    assert.equal(plan.settlesOnFailure, false);
    assert.equal("messageType" in plan, false);
  }
});

test("an operation without a request id settles nothing, and neither does a request id on a non-operation", () => {
  assert.equal(webviewDispatchPlan({ type: "pipeline.save" }).settlesOnFailure, false);
  assert.equal(
    webviewDispatchPlan({ type: "task.reset", requestId: "r-2" }).settlesOnFailure,
    false,
  );
  assert.equal(webviewDispatchPlan({ type: "pipeline.save", requestId: "" }).requestId, undefined);
});

test("every operation the editor can wait on settles on failure when it carries its id", () => {
  for (const operation of RUNTIME_OPERATIONS) {
    assert.equal(
      webviewDispatchPlan({ type: operation, requestId: "r-3" }).settlesOnFailure,
      true,
      operation,
    );
  }
});

test("an unroutable message is reported with what arrived", () => {
  const error = unsupportedWebviewMessage({ type: "pipeline.detonate" });
  assert.match(error.message, /Unsupported webview message: \{"type":"pipeline\.detonate"\}/u);
});
