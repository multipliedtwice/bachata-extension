const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveWorkspaceOwnershipAfterFailure,
} = require("../dist/concurrency/resolveWorkspaceOwnership.js");

test("ownership dismissal registers blocked commands exactly once", async () => {
  const commands = new Set();
  const result = await resolveWorkspaceOwnershipAfterFailure({
    initialReason: "owned",
    prompt: async () => "Dismiss",
    waitForRetry: async () => assert.fail("retry wait must not run"),
    acquire: async () => assert.fail("acquire must not run"),
    retryReason: () => "retry failed",
    block: () => {
      for (const command of ["bachata.open", "bachata.todo.start"]) {
        if (commands.has(command)) throw new Error(`duplicate ${command}`);
        commands.add(command);
      }
    },
    notifyRetryFailure: async () => assert.fail("notification must not run"),
  });
  assert.equal(result, undefined);
  assert.equal(commands.size, 2);
});

test("ownership retry failure registers blocked commands exactly once", async () => {
  const commands = new Set();
  const notices = [];
  const result = await resolveWorkspaceOwnershipAfterFailure({
    initialReason: "owned",
    prompt: async () => "Retry",
    waitForRetry: async () => undefined,
    acquire: async () => {
      throw new Error("still owned");
    },
    retryReason: () => "retry failed",
    block: () => {
      for (const command of ["bachata.open", "bachata.todo.start"]) {
        if (commands.has(command)) throw new Error(`duplicate ${command}`);
        commands.add(command);
      }
    },
    notifyRetryFailure: async (reason) => notices.push(reason),
  });
  assert.equal(result, undefined);
  assert.equal(commands.size, 2);
  assert.deepEqual(notices, ["retry failed"]);
});

test("ownership retry success does not register blocked commands", async () => {
  const lease = { id: "lease" };
  const result = await resolveWorkspaceOwnershipAfterFailure({
    initialReason: "owned",
    prompt: async () => "Retry",
    waitForRetry: async () => undefined,
    acquire: async () => lease,
    retryReason: () => "retry failed",
    block: () => assert.fail("commands must stay available"),
    notifyRetryFailure: async () => assert.fail("notification must not run"),
  });
  assert.equal(result, lease);
});
