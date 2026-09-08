const assert = require("node:assert/strict");
const test = require("node:test");

const {
  approvalChoices,
  approvalPrompt,
  approvalRecord,
  claudePermissionPrompt,
  claudePermissionRecord,
  claudePermissionVerdict,
  claudeUnansweredInput,
  claudeUserInputAnswer,
  claudeUserInputAsk,
  codexAutoResolutionMs,
  codexUnansweredInput,
  codexUnansweredPick,
  codexUserInputAnswer,
  codexUserInputAsk,
  codexUserInputCompleted,
  codexUserInputRequested,
  mcpElicitationCompleted,
  mcpElicitationRequested,
  mcpFieldValidation,
  mcpFieldValue,
  mcpUrlDecision,
  mcpUrlOutcome,
} = require("../dist/runtime/providerInteraction.js");

// EX-AUD-12. These decisions lived inside `createRuntime`, where reaching a timeout, a
// cancellation or a multi-select answer meant driving a whole runtime through a live provider.

const question = (overrides = {}) => ({
  question: "Which database?",
  header: "Database",
  options: [],
  multiSelect: false,
  ...overrides,
});

const response = (overrides = {}) => ({
  selected: [],
  freeText: "",
  source: "user",
  ...overrides,
});

test("a question with no options is answered in prose", () => {
  const ask = claudeUserInputAsk("claude", "request-1", 0, question());
  assert.equal(ask.sourceKey, "claude-input:claude:request-1:0");
  assert.equal(ask.kind, "semanticQuestion");
  assert.equal(ask.title, "Database");
  assert.equal(ask.prompt, "Which database?");
  assert.deepEqual(ask.options, []);
  assert.equal(ask.allowFreeText, true);
  assert.equal(ask.secret, false);
});

test("a question with options is answered by choosing, and each option keeps its own text", () => {
  const ask = claudeUserInputAsk("claude", "request-1", 2, question({
    options: [
      { label: "Postgres", description: "the one already running" },
      { label: "SQLite" },
    ],
  }));
  assert.equal(ask.sourceKey, "claude-input:claude:request-1:2");
  assert.deepEqual(ask.options, [
    { id: "Postgres", label: "Postgres", description: "the one already running" },
    { id: "SQLite", label: "SQLite", description: undefined },
  ]);
  assert.equal(ask.allowFreeText, false);
});

test("the Lead fallback repeats the question the user was asked, not a summary of it", () => {
  const asked = question({ options: [{ label: "Postgres" }] });
  const ask = claudeUserInputAsk("claude", "request-1", 0, asked);
  assert.equal(ask.fallback.type, "lead");
  assert.equal(ask.fallback.originAgentId, "claude");
  assert.equal(ask.fallback.title, ask.title);
  assert.equal(ask.fallback.prompt, ask.prompt);
  assert.deepEqual(ask.fallback.options, ask.options);
  assert.equal(ask.fallback.allowFreeText, ask.allowFreeText);
});

test("a single-select question keeps one choice however many came back", () => {
  assert.equal(
    claudeUserInputAnswer(question(), response({ selected: ["Postgres", "SQLite"] })),
    "Postgres",
  );
  assert.equal(
    claudeUserInputAnswer(
      question({ multiSelect: true }),
      response({ selected: ["Postgres", "SQLite"] }),
    ),
    "Postgres, SQLite",
  );
});

test("free text is added to the choices rather than replacing them", () => {
  assert.equal(
    claudeUserInputAnswer(
      question(),
      response({ selected: ["Postgres"], freeText: "  version 16  " }),
    ),
    "Postgres, version 16",
  );
  assert.equal(
    claudeUserInputAnswer(question(), response({ freeText: "whatever is running" })),
    "whatever is running",
  );
});

test("an empty answer is not an answer", () => {
  assert.equal(claudeUserInputAnswer(question(), response()), undefined);
  assert.equal(claudeUserInputAnswer(question(), response({ freeText: "   " })), undefined);
  assert.equal(
    claudeUserInputAnswer(question(), response({ selected: [""], freeText: "" })),
    undefined,
  );
});

test("an unanswered request is recorded as the reason it went unanswered", () => {
  assert.deepEqual(claudeUnansweredInput(response({ source: "timeout" })), {
    eventType: "claude.userInput.timedOut",
    text: "Claude input request reached its fallback deadline without an answer.",
  });
  ["cancel", "user", "lead"].forEach((source) => {
    assert.equal(
      claudeUnansweredInput(response({ source })).eventType,
      "claude.userInput.cancelled",
      source,
    );
  });
});

test("a permission prompt quotes the tool and what it was given", () => {
  assert.equal(
    claudePermissionPrompt({ toolName: "Bash", toolInput: { command: "ls" } }),
    "Tool: Bash\nInput: {\"command\":\"ls\"}",
  );
});

test("a tool with no input shows no empty payload", () => {
  assert.equal(
    claudePermissionPrompt({ toolName: "Read", toolInput: {} }),
    "Tool: Read",
  );
});

test("a permission prompt is bounded, because a dialog is not a payload viewer", () => {
  const prompt = claudePermissionPrompt({
    toolName: "Write",
    toolInput: { content: "x".repeat(10_000) },
  });
  const input = prompt.split("\n")[1];
  assert.equal(input.length, "Input: ".length + 4_000);
});

test("only an explicit allow allows, and every other answer denies with a reason", () => {
  assert.deepEqual(claudePermissionVerdict(response({ selected: ["allow"] })), {
    behavior: "allow",
  });
  [[], ["reject"], ["Allow"], ["allow-once"]].forEach((selected) => {
    assert.deepEqual(
      claudePermissionVerdict(response({ selected })),
      { behavior: "deny", message: "Denied by Bachata" },
      JSON.stringify(selected),
    );
  });
});

test("a permission decision is recorded by what happened and why it ended", () => {
  assert.deepEqual(claudePermissionRecord(response({ selected: ["allow"] })), {
    eventType: "claude.permission.decided",
    text: "Claude permission was allowed.",
    allowed: true,
  });
  assert.deepEqual(claudePermissionRecord(response({ selected: ["reject"] })), {
    eventType: "claude.permission.decided",
    text: "Claude permission was denied.",
    allowed: false,
  });
  assert.deepEqual(claudePermissionRecord(response({ source: "timeout" })), {
    eventType: "claude.permission.timedOut",
    text: "Claude permission was denied.",
    allowed: false,
  });
  // A deadline that expires after the user allowed is still an allow.
  assert.deepEqual(
    claudePermissionRecord(response({ selected: ["allow"], source: "timeout" })),
    {
      eventType: "claude.permission.timedOut",
      text: "Claude permission was allowed.",
      allowed: true,
    },
  );
});

const codexQuestion = (overrides = {}) => ({
  id: "q1",
  header: "Database",
  question: "Which database?",
  isOther: false,
  isSecret: false,
  ...overrides,
});

const codexRequest = (overrides = {}) => ({
  requestId: "request-1",
  questions: [codexQuestion()],
  isBlocking: false,
  autoResolutionMs: 30_000,
  ...overrides,
});

test("a blocking Codex request has no deadline to auto-resolve to", () => {
  assert.equal(codexAutoResolutionMs(codexRequest({ isBlocking: true })), undefined);
});

test("only a finite positive auto-resolution is a deadline", () => {
  assert.equal(codexAutoResolutionMs(codexRequest()), 30_000);
  [undefined, 0, -1, Number.POSITIVE_INFINITY, Number.NaN].forEach((autoResolutionMs) => {
    assert.equal(
      codexAutoResolutionMs(codexRequest({ autoResolutionMs })),
      undefined,
      String(autoResolutionMs),
    );
  });
});

test("a Codex question with options is asked as a choice, and carries its deadline", () => {
  const ask = codexUserInputAsk("codex", codexRequest(), codexQuestion({
    options: [{ label: "Postgres", description: "already running" }],
  }));
  assert.equal(ask.sourceKey, "codex-input:codex:request-1:q1");
  assert.equal(ask.kind, "semanticQuestion");
  assert.equal(ask.secret, false);
  assert.deepEqual(ask.options, [
    { id: "Postgres", label: "Postgres", description: "already running" },
  ]);
  assert.equal(ask.allowFreeText, false);
  assert.equal(ask.timeoutMs, 30_000);
});

test("free text is allowed with no options, or when Codex marked the question as other", () => {
  assert.equal(codexUserInputAsk("codex", codexRequest(), codexQuestion()).allowFreeText, true);
  assert.equal(
    codexUserInputAsk("codex", codexRequest(), codexQuestion({
      options: [{ label: "Postgres", description: "" }],
      isOther: true,
    })).allowFreeText,
    true,
  );
});

test("a blocking request carries no timeout key at all", () => {
  const ask = codexUserInputAsk("codex", codexRequest({ isBlocking: true }), codexQuestion());
  assert.equal(Object.hasOwn(ask, "timeoutMs"), false);
});

test("a secret is never offered to the Lead", () => {
  const secret = codexUserInputAsk("codex", codexRequest(), codexQuestion({ isSecret: true }));
  assert.equal(secret.kind, "secret");
  assert.equal(secret.secret, true);
  assert.equal(Object.hasOwn(secret, "fallback"), false);

  const ordinary = codexUserInputAsk("codex", codexRequest(), codexQuestion());
  assert.equal(ordinary.fallback.type, "lead");
  assert.equal(ordinary.fallback.originAgentId, "codex");
  assert.deepEqual(ordinary.fallback.options, ordinary.options);
  assert.equal(ordinary.fallback.allowFreeText, ordinary.allowFreeText);
});

test("Codex takes one answer, so a choice and a note are joined under a heading", () => {
  assert.equal(
    codexUserInputAnswer({ selected: ["Postgres"], freeText: "", source: "user" }),
    "Postgres",
  );
  assert.equal(
    codexUserInputAnswer({ selected: [], freeText: "  whatever runs  ", source: "user" }),
    "whatever runs",
  );
  assert.equal(
    codexUserInputAnswer({ selected: ["Postgres"], freeText: "version 16", source: "user" }),
    "Postgres\n\nAdditional user input: version 16",
  );
  // Only the first choice reaches Codex, which takes one answer per question.
  assert.equal(
    codexUserInputAnswer({ selected: ["Postgres", "SQLite"], freeText: "", source: "user" }),
    "Postgres",
  );
  assert.equal(codexUserInputAnswer({ selected: [], freeText: "  ", source: "cancel" }), undefined);
});

test("an unanswered Codex request names how it ended, in the words of the path it took", () => {
  assert.deepEqual(codexUnansweredInput({ selected: [], freeText: "", source: "timeout" }), {
    eventType: "codex.userInput.autoResolved",
    text: "Codex input request reached its fallback deadline without an answer.",
  });
  assert.equal(
    codexUnansweredInput({ selected: [], freeText: "", source: "cancel" }).eventType,
    "codex.userInput.cancelled",
  );
  assert.deepEqual(codexUnansweredPick(true), {
    eventType: "codex.userInput.autoResolved",
    text: "Codex input request reached its auto-resolution deadline.",
  });
  assert.equal(codexUnansweredPick(false).eventType, "codex.userInput.cancelled");
});

test("the request record counts the questions and names them, without their answers", () => {
  const one = codexUserInputRequested(codexRequest());
  assert.equal(one.text, "Codex requested 1 input answer.");
  assert.deepEqual(one.detail, {
    requestId: "request-1",
    questionIds: ["q1"],
    blocking: false,
    autoResolutionMs: 30_000,
  });

  const many = codexUserInputRequested(codexRequest({
    questions: [codexQuestion(), codexQuestion({ id: "q2" })],
    isBlocking: true,
    autoResolutionMs: undefined,
  }));
  assert.equal(many.text, "Codex requested 2 input answers.");
  assert.deepEqual(many.detail.questionIds, ["q1", "q2"]);
  assert.equal(many.detail.blocking, true);
  assert.equal(many.detail.autoResolutionMs, null);
});

test("the completion names which questions were secret, never what they were answered with", () => {
  const record = codexUserInputCompleted(
    codexRequest({
      questions: [codexQuestion(), codexQuestion({ id: "q2", isSecret: true })],
    }),
    ["q1", "q2"],
  );
  assert.deepEqual(record, {
    requestId: "request-1",
    answeredQuestionIds: ["q1", "q2"],
    secretQuestionIds: ["q2"],
  });
  assert.equal(JSON.stringify(record).includes("answers"), false);
});

const approvalRequest = (overrides = {}) => ({
  requestId: "approval-1",
  kind: "exec",
  choices: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  ...overrides,
});

test("an approval that offers nothing is still answerable, and only by cancelling", () => {
  assert.deepEqual(approvalChoices([]), [{ id: "cancel", label: "Cancel" }]);
});

test("offered choices are passed through by id and label only", () => {
  assert.deepEqual(
    approvalChoices([
      { id: "allow", label: "Allow", extra: "ignored" },
      { id: "deny", label: "Deny" },
    ]),
    [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }],
  );
});

test("the human is told the reason, then the command, then at least the kind", () => {
  assert.equal(
    approvalPrompt(approvalRequest({ reason: "needs network", command: "curl" })),
    "needs network",
  );
  assert.equal(approvalPrompt(approvalRequest({ command: "rm -rf build" })), "rm -rf build");
  assert.equal(approvalPrompt(approvalRequest()), "Approve exec");
  assert.equal(approvalPrompt(approvalRequest({ kind: "patch" })), "Approve patch");
});

test("a dismissed approval is a cancellation, never consent", () => {
  const dismissed = approvalRecord(approvalRequest(), response({ selected: [] }));
  assert.equal(dismissed.choice, "cancel");
  assert.equal(dismissed.eventType, "approval.decided");
  assert.equal(dismissed.text, "Approval approval-1: cancel");
});

test("an approval records the choice that was made and how the dialog ended", () => {
  const allowed = approvalRecord(approvalRequest(), response({ selected: ["allow"] }));
  assert.deepEqual(allowed, {
    choice: "allow",
    eventType: "approval.decided",
    text: "Approval approval-1: allow",
  });
  const expired = approvalRecord(approvalRequest(), response({ source: "timeout" }));
  assert.equal(expired.eventType, "approval.timedOut");
  assert.equal(expired.choice, "cancel");
  // Only the first choice is the answer; an approval takes one.
  assert.equal(
    approvalRecord(approvalRequest(), response({ selected: ["allow", "deny"] })).choice,
    "allow",
  );
});

const schemeOf = (value) => {
  try {
    return new URL(value).protocol.replace(/:$/u, "");
  } catch {
    return undefined;
  }
};

test("an MCP URL request is opened only for plain web navigation", () => {
  assert.deepEqual(mcpUrlDecision("https://example.invalid/auth", schemeOf), { open: true });
  assert.deepEqual(mcpUrlDecision("http://127.0.0.1:9000/auth", schemeOf), { open: true });
});

test("an MCP URL that names no web page is refused before a dialog appears", () => {
  assert.equal(mcpUrlDecision(undefined, schemeOf).refusal, "noUrl");
  assert.equal(mcpUrlDecision("", schemeOf).refusal, "noUrl");
  assert.equal(mcpUrlDecision("not a url", schemeOf).refusal, "unparsable");
  ["file:///etc/hosts", "vscode://command/x", "javascript:alert(1)", "data:text/html,x"]
    .forEach((url) => {
      assert.equal(mcpUrlDecision(url, schemeOf).refusal, "unsupportedScheme", url);
    });
});

test("an opened MCP URL is accepted, and one the host could not open is refused", () => {
  assert.deepEqual(mcpUrlOutcome("Open", true), {
    action: "accept",
    completed: "MCP URL was opened.",
  });
  assert.deepEqual(mcpUrlOutcome("Open", false), {
    action: "decline",
    completed: "MCP URL could not be opened.",
  });
});

test("a dismissed MCP dialog is a cancellation, not a refusal", () => {
  assert.deepEqual(mcpUrlOutcome("Decline", false), { action: "decline" });
  [undefined, "", "Something else"].forEach((choice) => {
    assert.equal(mcpUrlOutcome(choice, false).action, "cancel", String(choice));
    assert.equal(mcpUrlOutcome(choice, false).completed, undefined, String(choice));
  });
});

const formField = (overrides = {}) => ({
  key: "port",
  type: "string",
  required: false,
  secret: false,
  ...overrides,
});

test("a required field refuses an empty answer and an optional one accepts it", () => {
  assert.equal(
    mcpFieldValidation(formField({ required: true }), ""),
    "A value is required",
  );
  assert.equal(mcpFieldValidation(formField(), ""), undefined);
});

test("only a numeric field parses, and an integer field refuses a fraction", () => {
  assert.equal(mcpFieldValidation(formField(), "not a number"), undefined);
  assert.equal(
    mcpFieldValidation(formField({ type: "number" }), "not a number"),
    "Enter a valid number",
  );
  assert.equal(mcpFieldValidation(formField({ type: "number" }), "1.5"), undefined);
  assert.equal(
    mcpFieldValidation(formField({ type: "integer" }), "1.5"),
    "Enter a whole number",
  );
  assert.equal(mcpFieldValidation(formField({ type: "integer" }), "8080"), undefined);
  // An empty optional numeric field is not asked to parse.
  assert.equal(mcpFieldValidation(formField({ type: "integer" }), ""), undefined);
});

test("a string field keeps what was entered and a numeric one converts it", () => {
  assert.equal(mcpFieldValue(formField(), "8080"), "8080");
  assert.equal(mcpFieldValue(formField(), ""), "");
  assert.equal(mcpFieldValue(formField({ type: "number" }), "8080"), 8080);
  assert.equal(mcpFieldValue(formField({ type: "integer" }), "8080"), 8080);
});

test("a numeric field left empty has no value rather than zero", () => {
  assert.equal(mcpFieldValue(formField({ type: "number" }), ""), undefined);
  assert.equal(mcpFieldValue(formField({ type: "number" }), undefined), undefined);
  assert.equal(mcpFieldValue(formField(), undefined), undefined);
});

test("an elicitation names the kind of interaction the server asked for", () => {
  assert.deepEqual(
    mcpElicitationRequested({ requestId: "mcp-1", serverName: "files", mode: "url" }),
    {
      text: "MCP server requested a URL interaction.",
      detail: { requestId: "mcp-1", serverName: "files", mode: "url" },
    },
  );
  ["form", "openai/form"].forEach((mode) => {
    assert.equal(
      mcpElicitationRequested({ requestId: "mcp-1", mode }).text,
      "MCP server requested structured input.",
      mode,
    );
  });
});

test("an accepted form records which fields were answered and which were secret", () => {
  const record = mcpElicitationCompleted(
    "mcp-1",
    { host: "127.0.0.1", token: "secret-value" },
    ["token"],
  );
  assert.deepEqual(record, {
    requestId: "mcp-1",
    fieldNames: ["host", "token"],
    secretFields: ["token"],
  });
  assert.equal(JSON.stringify(record).includes("secret-value"), false);
  assert.deepEqual(mcpElicitationCompleted("mcp-1", {}, []).fieldNames, []);
});

// EX-3. Which widget a question is put in, what a pick means, and the record a panel is shown.
const {
  CODEX_OTHER_ANSWER_ID,
  codexPickOutcome,
  codexQuestionInputBox,
  codexQuestionWidget,
  mcpFieldWidget,
  pendingApprovalFrom,
} = require("../dist/runtime/providerInteraction.js");

const codexWidgetQuestion = (overrides = {}) => ({
  id: "q1",
  header: "Database",
  question: "Which database?",
  isOther: false,
  isSecret: false,
  ...overrides,
});

test("a question with options is a picker over them, in the question's own words", () => {
  assert.deepEqual(
    codexQuestionWidget(codexWidgetQuestion({
      options: [{ label: "Postgres", description: "default" }, { label: "SQLite", description: "local" }],
    })),
    {
      kind: "pick",
      title: "Database",
      placeHolder: "Which database?",
      items: [
        { label: "Postgres", description: "default", value: "Postgres" },
        { label: "SQLite", description: "local", value: "SQLite" },
      ],
    },
  );
});

test("a question that allows another answer gets one extra entry that opens the input box", () => {
  const widget = codexQuestionWidget(codexWidgetQuestion({
    isOther: true,
    options: [{ label: "Postgres", description: "default" }],
  }));
  assert.equal(widget.items.length, 2);
  assert.deepEqual(widget.items[1], {
    label: "Other…",
    description: "Enter another answer",
    value: CODEX_OTHER_ANSWER_ID,
  });
});

test("a question without options, or with an empty list, is an input box", () => {
  assert.deepEqual(codexQuestionWidget(codexWidgetQuestion({ isSecret: true })), {
    kind: "input",
    title: "Database",
    prompt: "Which database?",
    password: true,
  });
  assert.equal(codexQuestionWidget(codexWidgetQuestion({ options: [] })).kind, "input");
  assert.deepEqual(codexQuestionInputBox(codexWidgetQuestion()), {
    title: "Database",
    prompt: "Which database?",
    password: false,
  });
});

test("a pick is the answer, the other entry asks again, and nothing picked says whether it timed out", () => {
  assert.deepEqual(codexPickOutcome({ value: { value: "SQLite" }, timedOut: false }), {
    kind: "answer",
    answer: "SQLite",
  });
  assert.deepEqual(codexPickOutcome({ value: { value: CODEX_OTHER_ANSWER_ID }, timedOut: false }), {
    kind: "askOther",
  });
  assert.deepEqual(codexPickOutcome({ timedOut: true }), { kind: "none", timedOut: true });
  assert.deepEqual(codexPickOutcome({ value: undefined, timedOut: false }), { kind: "none", timedOut: false });
});

const mcpField = (overrides = {}) => ({
  key: "host",
  title: "Host",
  type: "string",
  required: true,
  secret: false,
  ...overrides,
});

test("a field that names its values is a picker over them, described by the field when it can be", () => {
  assert.deepEqual(
    mcpFieldWidget(
      mcpField({ description: "Where to connect", values: [{ label: "prod", value: "prod" }, { label: "dev", value: "dev" }] }),
      "Server asks",
    ),
    {
      kind: "pick",
      title: "Host",
      placeHolder: "Server asks",
      items: [
        { label: "prod", description: "Where to connect", value: "prod" },
        { label: "dev", description: "Where to connect", value: "dev" },
      ],
    },
  );
  const undescribed = mcpFieldWidget(mcpField({ values: [{ label: "prod", value: "prod" }] }), "Server asks");
  assert.equal("description" in undescribed.items[0], false);
});

test("a boolean field is a True/False picker with the description as its placeholder", () => {
  assert.deepEqual(mcpFieldWidget(mcpField({ type: "boolean", description: "Use TLS?" }), "Server asks"), {
    kind: "pick",
    title: "Host",
    placeHolder: "Use TLS?",
    items: [{ label: "True", value: true }, { label: "False", value: false }],
  });
  assert.equal(mcpFieldWidget(mcpField({ type: "boolean" }), "Server asks").placeHolder, "Server asks");
});

test("any other field is an input box, prefilled with its default and masked when secret", () => {
  assert.deepEqual(mcpFieldWidget(mcpField({ type: "number", defaultValue: 5432, description: "Port" }), "Server asks"), {
    kind: "input",
    title: "Host",
    prompt: "Port",
    value: "5432",
    password: false,
  });
  const secret = mcpFieldWidget(mcpField({ secret: true }), "Server asks");
  assert.equal(secret.password, true);
  assert.equal(secret.prompt, "Server asks");
  assert.equal("value" in secret, false);
});

test("the pending approval a panel is shown takes the grant root where no working directory was given", () => {
  const approval = pendingApprovalFrom("lead", {
    requestId: "a-1",
    kind: "command",
    reason: "needs shell",
    command: "npm test",
    grantRoot: "/repo",
    choices: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }],
  });
  assert.equal(approval.agentId, "lead");
  assert.equal(approval.cwd, "/repo");
  assert.equal(approval.browserAction, undefined);
  assert.deepEqual(approval.choices.map((choice) => choice.id), ["approve", "cancel"]);
});

test("a working directory wins over the grant root, and a browser action travels", () => {
  const approval = pendingApprovalFrom("lead", {
    requestId: "a-2",
    kind: "browserAction",
    cwd: "/work",
    grantRoot: "/repo",
    browserAction: { kind: "click", target: "#send" },
    choices: [],
  });
  assert.equal(approval.cwd, "/work");
  assert.deepEqual(approval.browserAction, { kind: "click", target: "#send" });
  assert.equal(approval.requestId, "a-2");
  assert.equal(approval.kind, "browserAction");
});
