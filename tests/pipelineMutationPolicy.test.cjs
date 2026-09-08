const assert = require("node:assert/strict");
const test = require("node:test");

const {
  hasDurableTaskState,
  pipelineMutationRefusal,
} = require("../dist/runtime/pipelineMutationPolicy.js");

// EX-AUD-12. The policy lived inside the runtime closure, reachable only by driving a whole
// runtime into each of the five states it distinguishes.

const durable = (overrides = {}) => ({
  taskDirty: false,
  transcriptTotal: 0,
  attachmentCount: 0,
  queuedMessageCount: 0,
  queueStartClaimed: false,
  recoveryCheckpointed: false,
  ...overrides,
});

const mutable = (overrides = {}) => ({
  operationInFlight: false,
  workflowStatus: "idle",
  attachmentCount: 0,
  durableTaskState: false,
  ...overrides,
});

test("a task that holds nothing is not durable", () => {
  assert.equal(hasDurableTaskState(durable()), false);
});

test("each kind of retained work on its own makes the task durable", () => {
  const cases = [
    { taskDirty: true },
    { transcriptTotal: 1 },
    { attachmentCount: 1 },
    { queuedMessageCount: 1 },
    { queueStartClaimed: true },
    { recoveryCheckpointed: true },
  ];
  cases.forEach((overrides) => {
    assert.equal(
      hasDurableTaskState(durable(overrides)),
      true,
      Object.keys(overrides)[0],
    );
  });
});

test("an idle empty runtime may change pipelines", () => {
  assert.equal(pipelineMutationRefusal(mutable()), undefined);
});

test("a catalog failure is reported before anything else the policy could say", () => {
  assert.equal(
    pipelineMutationRefusal(
      mutable({
        catalogError: "Two pipeline files declare custom-a",
        operationInFlight: true,
        workflowStatus: "running",
        attachmentCount: 3,
        durableTaskState: true,
      }),
    ),
    "Two pipeline files declare custom-a",
  );
});

test("an operation in flight is refused before a non-idle status", () => {
  assert.match(
    pipelineMutationRefusal(mutable({ operationInFlight: true, workflowStatus: "running" })),
    /Wait for the active operation/u,
  );
});

test("a run that is not idle is refused before attachments", () => {
  assert.match(
    pipelineMutationRefusal(mutable({ workflowStatus: "interrupted", attachmentCount: 2 })),
    /Reset this run/u,
  );
});

test("attachments are refused before other durable state", () => {
  assert.match(
    pipelineMutationRefusal(mutable({ attachmentCount: 1, durableTaskState: true })),
    /Remove attachments/u,
  );
});

test("other durable state is refused last, and names starting a new run", () => {
  assert.match(
    pipelineMutationRefusal(mutable({ durableTaskState: true })),
    /Start a new run/u,
  );
});

test("an empty catalog error is not a refusal", () => {
  assert.equal(pipelineMutationRefusal(mutable({ catalogError: "" })), undefined);
});

// EX-3. What a catalog write refuses, apart from performing one.
const {
  PIPELINE_SCOPE_CHANGED,
  pipelineDeleteRefusal,
  pipelineSaveRefusal,
} = require("../dist/runtime/pipelineMutationPolicy.js");

const save = (over = {}) =>
  pipelineSaveRefusal({
    mode: "update",
    pipelineId: "review",
    requestScopeKey: "workspace:/repo",
    scopeKey: "workspace:/repo",
    activeScopeKey: "workspace:/repo",
    existsInCatalog: true,
    isCustom: true,
    sourcePipelineId: "review",
    expectedHash: "hash-1",
    currentHash: "hash-1",
    fileExists: true,
    ...over,
  });

test("an editor opened against another scope is refused before anything else", () => {
  assert.equal(save({ requestScopeKey: "workspace:/other", isCustom: false }), PIPELINE_SCOPE_CHANGED.save);
  assert.equal(save({ activeScopeKey: "workspace:/other" }), PIPELINE_SCOPE_CHANGED.save);
});

test("creating over an existing pipeline says which kind it collided with", () => {
  assert.equal(
    save({ mode: "create", existsInCatalog: true, isCustom: true }),
    "Custom pipeline review already exists; open it before editing",
  );
  assert.equal(
    save({ mode: "create", existsInCatalog: true, isCustom: false }),
    "Pipeline id review belongs to a built-in preset; save it with a new id",
  );
});

test("creating a pipeline whose file is already on disk is refused", () => {
  assert.equal(
    save({ mode: "create", existsInCatalog: false, fileExists: true }),
    "Custom pipeline review already exists on disk",
  );
  assert.equal(save({ mode: "create", existsInCatalog: false, fileExists: false }), undefined);
});

test("an update needs the id and revision the editor opened with", () => {
  assert.equal(save({ sourcePipelineId: undefined }), "Pipeline update requires its original id and revision");
  assert.equal(save({ sourcePipelineId: "other" }), "Pipeline update requires its original id and revision");
  assert.equal(save({ expectedHash: undefined }), "Pipeline update requires its original id and revision");
});

test("an update to a pipeline the catalog no longer calls custom is refused", () => {
  assert.equal(save({ isCustom: false }), "Custom pipeline review no longer exists");
});

test("two editors on one pipeline do not overwrite each other", () => {
  assert.equal(
    save({ currentHash: "hash-2" }),
    "Pipeline review changed in another run. Reopen it before saving.",
  );
});

test("an update whose file left the disk is refused, and a clean update is not", () => {
  assert.equal(save({ fileExists: false }), "Custom pipeline review no longer exists on disk");
  assert.equal(save(), undefined);
});

const remove = (over = {}) =>
  pipelineDeleteRefusal({
    pipelineId: "review",
    requestScopeKey: "workspace:/repo",
    scopeKey: "workspace:/repo",
    activeScopeKey: "workspace:/repo",
    isCustom: true,
    expectedHash: "hash-1",
    currentHash: "hash-1",
    existsInCatalog: true,
    hasCatalogFile: true,
    fileExists: true,
    ...over,
  });

test("a delete from a stale scope, or of something not custom, is refused first", () => {
  assert.equal(remove({ requestScopeKey: "workspace:/other" }), PIPELINE_SCOPE_CHANGED.delete);
  assert.equal(remove({ isCustom: false }), "Only existing custom pipelines can be deleted");
});

test("a delete checks the revision the editor holds before it removes anything", () => {
  assert.equal(
    remove({ currentHash: "hash-2" }),
    "Pipeline review changed in another run. Reopen it before deleting.",
  );
});

test("a delete names what is missing: the pipeline, its catalog file, or the file on disk", () => {
  assert.equal(remove({ existsInCatalog: false }), "Unknown pipeline: review");
  assert.equal(remove({ hasCatalogFile: false }), "Custom pipeline review has no catalog file");
  assert.equal(remove({ fileExists: false }), "Custom pipeline review no longer exists on disk");
  assert.equal(remove(), undefined);
});
