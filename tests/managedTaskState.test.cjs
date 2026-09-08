const assert = require("node:assert/strict");
const test = require("node:test");

const { createManagedTaskState } = require("../dist/runtime/managedTaskState.js");

const directive = (candidate) => ({
  candidate,
  summary: "not accepted",
  defects: [{ id: "d1", statement: "wrong", requiredChange: "fix it", evidence: [] }],
  evidence: [],
});

test("a task's budget and directive belong to that task and to no other", () => {
  // THE DEFECT THIS REPLACES. Two runtime-wide maps held both values by task id. The counter had
  // no delete at all and the directive was removed only when a Worker consumed it, so a rejection
  // whose Worker never ran left an entry that nothing would read again — one per revised task,
  // for the life of the Extension Host. Nothing leaked across tasks, because the key is a fresh
  // UUID per task; what accumulated was memory.
  const state = createManagedTaskState();
  assert.equal(state.spendRevision("task-1"), 1);
  assert.equal(state.spendRevision("task-1"), 2);
  assert.equal(state.revisionsUsed("task-1"), 2);
  state.holdLeadRevision("task-1", directive("candidate-1"));

  // A second task starts from nothing and cannot see the first task's spent budget or defects.
  assert.equal(state.revisionsUsed("task-2"), 0);
  assert.equal(state.takeLeadRevision("task-2"), undefined);
  assert.equal(state.spendRevision("task-2"), 1);
  // And the first task is gone rather than retained: touching a second task discards it.
  assert.equal(state.revisionsUsed("task-1"), 0);
  assert.equal(state.takeLeadRevision("task-1"), undefined);
});

test("a directive reaches its Worker once and is not delivered twice", () => {
  const state = createManagedTaskState();
  state.holdLeadRevision("task-1", directive("candidate-1"));
  const taken = state.takeLeadRevision("task-1");
  assert.equal(taken?.candidate, "candidate-1");
  assert.equal(state.takeLeadRevision("task-1"), undefined);
  // Taking a directive is not spending a cycle: the budget is spent where the rejection happens.
  assert.equal(state.revisionsUsed("task-1"), 0);
});

test("a rejection whose Worker never runs leaves nothing behind", () => {
  // A Lead rejects, the Worker is disabled or the turn fails, and no one ever consumes the
  // directive. Under the old maps that entry stayed for the life of the runtime.
  const state = createManagedTaskState();
  state.spendRevision("abandoned");
  state.holdLeadRevision("abandoned", directive("candidate-1"));
  state.clear();
  assert.equal(state.revisionsUsed("abandoned"), 0);
  assert.equal(state.takeLeadRevision("abandoned"), undefined);
});

test("many sequential revised tasks accumulate nothing", () => {
  // The property the old shape could not have: what is retained does not grow with the number of
  // tasks. Asserted through behaviour rather than by measuring a map, so it stays true of any
  // structure that keeps one task's state at a time.
  const state = createManagedTaskState();
  for (let index = 0; index < 500; index += 1) {
    const taskId = `task-${String(index)}`;
    assert.equal(state.revisionsUsed(taskId), 0, `task ${taskId} inherited a budget`);
    assert.equal(state.takeLeadRevision(taskId), undefined, `task ${taskId} inherited a directive`);
    state.spendRevision(taskId);
    state.holdLeadRevision(taskId, directive(`candidate-${String(index)}`));
  }
  // Every earlier task is unreachable, including the one immediately before the last.
  for (let index = 0; index < 499; index += 1) {
    assert.equal(state.revisionsUsed(`task-${String(index)}`), 0);
  }
  assert.equal(state.revisionsUsed("task-499"), 1);
  state.clear();
  assert.equal(state.revisionsUsed("task-499"), 0);
});

test("clear is idempotent and a cleared owner still serves the next task", () => {
  const state = createManagedTaskState();
  state.spendRevision("task-1");
  state.clear();
  state.clear();
  assert.equal(state.spendRevision("task-1"), 1, "a cleared task did not restart from nothing");
  state.holdLeadRevision("task-1", directive("candidate-1"));
  assert.equal(state.takeLeadRevision("task-1")?.candidate, "candidate-1");
});
