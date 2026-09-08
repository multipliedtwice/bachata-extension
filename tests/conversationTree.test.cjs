const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeConversationTree } = require("../dist/conversations/conversationTree.js");

// EX-AUD-12. Persisted state is not trusted to be a tree, and a walk over a broken chain does
// not terminate. This lived inside `createConversationManager`, where the only way to reach a
// cycle was to persist one and boot a whole manager over it.

const conversation = (id, overrides = {}) => ({
  id,
  runRef: `run-${id}`,
  title: id,
  iterationCount: 1,
  activeIteration: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  running: false,
  workflowStatus: "idle",
  unread: 0,
  archived: false,
  ...overrides,
});

test("a well-formed chain keeps every link", () => {
  const conversations = [
    conversation("root"),
    conversation("child", { parentConversationId: "root" }),
    conversation("grandchild", { parentConversationId: "child" }),
  ];
  normalizeConversationTree(conversations);
  assert.deepEqual(
    conversations.map((item) => item.parentConversationId),
    [undefined, "root", "child"],
  );
});

test("a link to a parent that is gone is dropped, not left dangling", () => {
  const orphan = conversation("orphan", { parentConversationId: "deleted" });
  normalizeConversationTree([orphan]);
  assert.equal(Object.hasOwn(orphan, "parentConversationId"), false);
});

// Every chain has to end. One dropped link is enough to break a cycle, and the walk below is
// what any reader of the tree performs, so it is the property worth asserting.
const chainTerminates = (conversations) => {
  const byId = new Map(conversations.map((item) => [item.id, item]));
  conversations.forEach((item) => {
    const seen = new Set([item.id]);
    let parentId = item.parentConversationId;
    while (parentId) {
      assert.equal(seen.has(parentId), false, `${item.id} walks a cycle through ${parentId}`);
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentConversationId;
    }
  });
};

test("a chain that closes on itself is broken", () => {
  const first = conversation("a", { parentConversationId: "b" });
  const second = conversation("b", { parentConversationId: "a" });
  const pair = [first, second];
  normalizeConversationTree(pair);
  chainTerminates(pair);
  assert.equal(
    pair.filter((item) => Object.hasOwn(item, "parentConversationId")).length,
    1,
    "breaking a two-conversation cycle dropped more links than it had to",
  );
});

test("a conversation naming itself as its own parent is broken", () => {
  const self = conversation("self", { parentConversationId: "self" });
  normalizeConversationTree([self]);
  assert.equal(Object.hasOwn(self, "parentConversationId"), false);
});

test("a longer cycle is broken however deep it closes", () => {
  const chain = [
    conversation("a", { parentConversationId: "b" }),
    conversation("b", { parentConversationId: "c" }),
    conversation("c", { parentConversationId: "a" }),
  ];
  normalizeConversationTree(chain);
  chainTerminates(chain);
});

test("archiving a parent archives everything under it, however deep", () => {
  const conversations = [
    conversation("root", { archived: true }),
    conversation("child", { parentConversationId: "root" }),
    conversation("grandchild", { parentConversationId: "child" }),
    conversation("unrelated"),
  ];
  normalizeConversationTree(conversations);
  assert.deepEqual(
    conversations.map((item) => item.archived),
    [true, true, true, false],
  );
});

test("restoring a parent restores everything under it", () => {
  const conversations = [
    conversation("root"),
    conversation("child", { parentConversationId: "root", archived: true }),
    conversation("grandchild", { parentConversationId: "child", archived: true }),
  ];
  normalizeConversationTree(conversations);
  assert.deepEqual(conversations.map((item) => item.archived), [false, false, false]);
});

test("a child whose link was dropped keeps its own archived state", () => {
  const orphan = conversation("orphan", { parentConversationId: "deleted", archived: true });
  normalizeConversationTree([orphan]);
  assert.equal(orphan.archived, true);
});

test("the list is returned as given, in place", () => {
  const conversations = [conversation("only")];
  assert.equal(normalizeConversationTree(conversations), conversations);
  assert.deepEqual(normalizeConversationTree([]), []);
});
