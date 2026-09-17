const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONTINUITY_HANDOFF_MAX_BYTES,
  RESUMED_STEP_NOTICE,
  continuityHandoffPrompt,
  promptEntryData,
  roleAnswers,
  resumedIntoPromptedStep,
} = require("../dist/runtime/browserContinuity.js");

let sequence = 0;
const entry = (kind, agentId, stepId, text, data) => ({
  id: `entry-${String((sequence += 1))}`,
  kind,
  agentId,
  stepId,
  step: stepId === undefined ? undefined : `Step ${stepId}`,
  text,
  createdAt: "2026-09-17T00:00:00.000Z",
  ...(data === undefined ? {} : { data }),
});

const names = (agentId) => ({ codex: "Codex CLI", chatgpt: "ChatGPT" })[agentId] ?? "unknown";

test("prompt entries carry the role only when the turn has one", () => {
  assert.deepEqual(promptEntryData("implementer"), { roleId: "implementer" });
  assert.equal(promptEntryData(undefined), undefined);
});

test("a role's answers follow the role across a provider switch", () => {
  const entries = [
    entry("prompt", "codex", "plan", "plan it", { roleId: "implementer" }),
    entry("answer", "codex", "plan", "CLI plan"),
    entry("prompt", "reviewer", "review", "review it", { roleId: "reviewer" }),
    entry("answer", "reviewer", "review", "review notes"),
    entry("prompt", "codex", "build", "build it", { roleId: "implementer" }),
    entry("status", "codex", "build", "working"),
    entry("answer", "codex", "build", "   "),
    entry("answer", "codex", "build", "CLI build"),
  ];
  assert.deepEqual(roleAnswers(entries, { agentId: "chatgpt", roleId: "implementer" }), [
    { agentId: "codex", step: "Step plan", text: "CLI plan" },
    { agentId: "codex", step: "Step build", text: "CLI build" },
  ]);
});

test("answers with no recorded role fall back to the same participant", () => {
  const entries = [
    entry("prompt", "chatgpt", "one", "legacy prompt"),
    entry("answer", "chatgpt", "one", "legacy answer"),
    entry("answer", "codex", "two", "unprompted answer"),
    entry("prompt", "chatgpt", "three", "role prompt", { roleId: "implementer" }),
    entry("answer", "chatgpt", "three", "role answer"),
    entry("prompt", "chatgpt", "four", "array data", ["not", "a", "record"]),
    entry("answer", "chatgpt", "four", "array answer"),
    entry("prompt", "chatgpt", "five", "numeric role", { roleId: 7 }),
    entry("answer", "chatgpt", "five", "numeric answer"),
  ];
  assert.deepEqual(
    roleAnswers(entries, { agentId: "chatgpt" }).map((answer) => answer.text),
    ["legacy answer", "role answer", "array answer", "numeric answer"],
  );
  assert.deepEqual(
    roleAnswers(entries, { agentId: "chatgpt", roleId: "reviewer" }).map((answer) => answer.text),
    ["legacy answer", "array answer", "numeric answer"],
  );
});

test("only the first turn after a resume into an already prompted step is flagged", () => {
  const resumed = { ...entry("event", undefined, undefined, "Continued"), eventType: "workflow.resumed" };
  const before = [entry("prompt", "chatgpt", "build", "build it"), entry("answer", "codex", "review", "done")];
  assert.equal(resumedIntoPromptedStep(before, "chatgpt", "build"), false);
  assert.equal(resumedIntoPromptedStep([...before, resumed], "chatgpt", "build"), true);
  assert.equal(resumedIntoPromptedStep([...before, resumed], "chatgpt", "review"), false);
  assert.equal(resumedIntoPromptedStep([...before, resumed], "codex", "review"), false);
  assert.equal(
    resumedIntoPromptedStep([...before, resumed, entry("prompt", "chatgpt", "build", "again")], "chatgpt", "build"),
    false,
  );
  assert.equal(
    resumedIntoPromptedStep([...before, resumed, entry("prompt", "codex", "review", "other")], "chatgpt", "build"),
    true,
  );
});

test("no earlier answers means no handoff", () => {
  assert.equal(
    continuityHandoffPrompt({ answers: [], participantName: names, resumed: false }),
    undefined,
  );
});

test("a handoff lists earlier answers oldest first and says what it is", () => {
  const prompt = continuityHandoffPrompt({
    roleName: "Implementer",
    answers: [
      { agentId: "codex", step: "Plan", text: "first answer" },
      { agentId: "chatgpt", text: "second answer" },
    ],
    participantName: names,
    resumed: false,
  });
  assert.match(prompt, /^Bachata context handoff for the Implementer role\./u);
  assert.match(prompt, /oldest first \(2 of 2\)\./u);
  assert.ok(prompt.indexOf("first answer") < prompt.indexOf("second answer"));
  assert.match(prompt, /--- Plan \(answered by Codex CLI\) ---\nfirst answer/u);
  assert.match(prompt, /--- Earlier step \(answered by ChatGPT\) ---\nsecond answer/u);
  assert.ok(!prompt.includes(RESUMED_STEP_NOTICE));
  assert.match(prompt, /End of handoff\. Continue with the current request\. ---$/u);
});

test("a resumed handoff also warns about the interrupted request", () => {
  const prompt = continuityHandoffPrompt({
    answers: [{ agentId: "codex", step: "Plan", text: "answer" }],
    participantName: names,
    resumed: true,
  });
  assert.match(prompt, /^Bachata context handoff\.\n/u);
  assert.ok(prompt.includes(RESUMED_STEP_NOTICE));
});

test("a handoff keeps the newest answers within its byte budget", () => {
  const answers = [
    { agentId: "codex", step: "Old", text: "old ".repeat(100) },
    { agentId: "codex", step: "Middle", text: `middle-start ${"m".repeat(300)} middle-end` },
    { agentId: "codex", step: "New", text: "newest answer" },
  ];
  const prompt = continuityHandoffPrompt({ answers, participantName: names, resumed: false, maxBytes: 200 });
  assert.match(prompt, /\(2 of 3, truncated\)/u);
  assert.ok(prompt.includes("newest answer"));
  assert.ok(prompt.includes("middle-end"));
  assert.ok(!prompt.includes("middle-start"));
  assert.ok(prompt.includes("[earlier part omitted]"));
  assert.ok(!prompt.includes("old old"));
});

test("a handoff stops when not even the next heading fits", () => {
  const prompt = continuityHandoffPrompt({
    answers: [
      { agentId: "codex", step: "Old", text: "old answer" },
      { agentId: "codex", step: "New", text: "new answer" },
    ],
    participantName: names,
    resumed: false,
    maxBytes: 60,
  });
  assert.match(prompt, /\(1 of 2, truncated\)/u);
  assert.ok(prompt.includes("new answer"));
  assert.ok(!prompt.includes("old answer"));
});

test("a truncated answer never starts with a broken character", () => {
  const prompt = continuityHandoffPrompt({
    answers: [{ agentId: "codex", step: "S", text: "é".repeat(100) }],
    participantName: names,
    resumed: false,
    maxBytes: 51,
  });
  assert.ok(!prompt.includes("\uFFFD"));
});

test("the default budget is bounded", () => {
  assert.equal(CONTINUITY_HANDOFF_MAX_BYTES, 32_768);
});

test("a continuity block comes before the task and never replaces it", () => {
  const { composeAgentPrompt } = require("../dist/runtime/browserPromptContracts.js");
  assert.equal(
    composeAgentPrompt({ task: "Do the step", continuity: "Earlier work", workspaceProtocol: "Protocol" }),
    "Earlier work\n\nDo the step\n\nProtocol",
  );
  assert.equal(composeAgentPrompt({ task: "Do the step", continuity: "" }), "Do the step");
});
