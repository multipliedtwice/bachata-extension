const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MUTATION_CLASSES,
  isReadOnlyRefusal,
  mutationClassForCommand,
  mutationClassForProtocolMessage,
  refuseMutation,
} = require("../dist/state/readOnlyWorkspace.js");

const ownership = (overrides = {}) => ({
  owned: false,
  reason: "Another Bachata Extension Host owns this workspace.",
  retryCommand: "Bachata: Workspace Ownership",
  ...overrides,
});

test("every mutation class refuses, and each refusal is actionable", () => {
  MUTATION_CLASSES.forEach((mutation) => {
    const refusal = refuseMutation(mutation, ownership({
      holderDescription: "pid 4242 on MacBook",
      holderLastSeenSecondsAgo: 12,
    }));
    assert.equal(isReadOnlyRefusal(refusal), true);
    assert.equal(refusal.mutation, mutation);
    assert.match(refusal.message, new RegExp(`refused ${mutation}`, "u"));
    assert.match(refusal.message, /this window is read-only/u);
    assert.match(refusal.message, /pid 4242 on MacBook/u, "the refusal does not name the owner");
    assert.match(refusal.message, /active 12s ago/u);
    assert.match(refusal.message, /Workspace Ownership/u, "the refusal offers no way to take ownership");
  });
  assert.ok(MUTATION_CLASSES.length >= 20);
});

test("every blocked command maps to a mutation class, and read-only commands are exempt", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  const readOnly = /const READ_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\);/u.exec(source);
  assert.ok(readOnly, "the read-only command allowlist is gone");
  const exempt = Array.from(readOnly[1].matchAll(/"([^"]+)"/gu), (match) => match[1]);
  ["bachata.open", "bachata.doctor", "bachata.ownership"].forEach((command) => {
    assert.ok(exempt.includes(command), `${command} is not readable in a secondary window`);
  });
  ["bachata.setup", "bachata.reviewFile", "bachata.todo.start", "bachata.fixDiagnostic"].forEach((command) => {
    assert.equal(exempt.includes(command), false, `${command} is readable but mutates`);
    assert.ok(
      MUTATION_CLASSES.includes(mutationClassForCommand(command)),
      `${command} maps to no mutation class`,
    );
  });
});

test("an unmapped command still refuses rather than falling through", () => {
  assert.ok(MUTATION_CLASSES.includes(mutationClassForCommand("bachata.something.new")));
});

test("blocked-command registration routes through the refusal boundary", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
  assert.match(source, /refuseMutation\(/u, "blocked commands do not use the refusal boundary");
  assert.match(source, /mutationClassForCommand\(command\)/u);
  assert.match(source, /createReadOnlyProductService\(/u, "activation constructs no read-only product");
});

test("every state-changing protocol message maps to a mutation class", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "webview", "protocol.ts"),
    "utf8",
  );
  const managerMessages = /export type ConversationManagerToExtensionMessage =([\s\S]*?)\n\nexport type/u
    .exec(source);
  assert.ok(managerMessages, "the webview-to-extension message union is gone");
  const types = new Set(
    Array.from(managerMessages[1].matchAll(/type: "([a-zA-Z.]+)"/gu), (match) => match[1]),
  );
  assert.ok(types.size > 20, "the message union did not parse");
  // These read; everything else in the union changes state and must refuse.
  const readable = new Set(["manager.ready", "conversation.select", "conversation.viewExecution"]);
  types.forEach((type) => {
    if (readable.has(type)) return;
    assert.ok(
      MUTATION_CLASSES.includes(mutationClassForProtocolMessage(type)),
      `${type} maps to no mutation class`,
    );
  });
  assert.equal(mutationClassForProtocolMessage("orchestration.start"), "orchestrationStart");
  assert.equal(mutationClassForProtocolMessage("finding.merge"), "mergeFindings");
  assert.equal(mutationClassForProtocolMessage("conversation.runtime"), "providerExecution");
});
