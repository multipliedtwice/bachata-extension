/**
 * What a provider's interaction request means, apart from asking it.
 *
 * Claude asks Bachata two kinds of question: for input, and for permission to run a tool. Both
 * arrive from an adapter, are put to a human through one broker, and are answered back in the
 * provider's own shape. The asking is I/O; how a question is presented, how an answer is read,
 * and what a refusal is called are decisions — and they lived inside `createRuntime`, where
 * reaching a timeout, a cancellation or a multi-select answer meant driving a whole runtime
 * through a live provider.
 */
import type {
  ClaudePermissionRequest,
  ClaudePermissionResponse,
  ClaudeQuestion,
} from "../adapters/claudeHooks";
import type {
  AgentApprovalChoice,
  AgentApprovalRequest,
  JsonValue,
} from "../adapters/types";
import type { PendingApproval } from "../webview/protocol";
import type {
  CodexUserInputQuestion,
  CodexUserInputRequest,
} from "../adapters/codexAppServer";

export type InteractionOption = {
  id: string;
  label: string;
  description?: string | undefined;
};

export type InteractionAsk = {
  sourceKey: string;
  kind: "semanticQuestion" | "permission" | "secret";
  title: string;
  prompt: string;
  options: InteractionOption[];
  allowFreeText: boolean;
  secret: boolean;
  fallback?: {
    type: "lead";
    originAgentId: string;
    title: string;
    prompt: string;
    options: InteractionOption[];
    allowFreeText: boolean;
  };
};

export type InteractionAnswer = {
  selected: string[];
  freeText: string;
  source: "user" | "lead" | "timeout" | "cancel";
};

/**
 * A question with no options is answered in prose, one with options by choosing. The Lead
 * fallback repeats the question rather than summarising it, because the Lead answers the same
 * question the user was asked and its answer is recorded against that question.
 */
export const claudeUserInputAsk = (
  agentId: string,
  requestId: string,
  index: number,
  question: ClaudeQuestion,
): InteractionAsk => {
  const options = question.options.map((option) => ({
    id: option.label,
    label: option.label,
    description: option.description,
  }));
  const allowFreeText = options.length === 0;
  return {
    sourceKey: `claude-input:${agentId}:${requestId}:${String(index)}`,
    kind: "semanticQuestion",
    title: question.header,
    prompt: question.question,
    options,
    allowFreeText,
    secret: false,
    fallback: {
      type: "lead",
      originAgentId: agentId,
      title: question.header,
      prompt: question.question,
      options,
      allowFreeText,
    },
  };
};

/**
 * The answer a response carries, or nothing.
 *
 * A single-select question keeps one choice however many came back. Free text is appended to
 * the choices rather than replacing them, so a chosen option annotated in prose keeps both.
 * An empty answer is not an answer: a cancelled or timed-out request must not be recorded as
 * the user having said nothing on purpose.
 */
export const claudeUserInputAnswer = (
  question: ClaudeQuestion,
  response: InteractionAnswer,
): string | undefined => {
  const selected = question.multiSelect ? response.selected : response.selected.slice(0, 1);
  const answer = [...selected, response.freeText.trim()].filter(Boolean).join(", ");
  return answer === "" ? undefined : answer;
};

export type UnansweredInput = {
  eventType: "claude.userInput.timedOut" | "claude.userInput.cancelled";
  text: string;
};

export const claudeUnansweredInput = (
  response: InteractionAnswer,
): UnansweredInput =>
  response.source === "timeout"
    ? {
        eventType: "claude.userInput.timedOut",
        text: "Claude input request reached its fallback deadline without an answer.",
      }
    : {
        eventType: "claude.userInput.cancelled",
        text: "Claude input request was cancelled.",
      };

/**
 * What the human is shown before allowing a tool.
 *
 * The tool's own input is quoted so the decision is made on what the tool will actually do,
 * bounded because a permission dialog is not a place to render an arbitrary payload, and
 * omitted entirely when there is nothing to show rather than printing an empty object.
 */
export const claudePermissionPrompt = (
  request: Pick<ClaudePermissionRequest, "toolName" | "toolInput">,
): string => {
  const toolDetail = JSON.stringify(request.toolInput);
  return [
    `Tool: ${request.toolName}`,
    toolDetail === "{}" ? "" : `Input: ${toolDetail.slice(0, 4_000)}`,
  ].filter(Boolean).join("\n");
};

export const claudePermissionVerdict = (
  response: InteractionAnswer,
): ClaudePermissionResponse =>
  response.selected.includes("allow")
    ? { behavior: "allow" }
    : { behavior: "deny", message: "Denied by Bachata" };

export type PermissionRecord = {
  eventType: "claude.permission.timedOut" | "claude.permission.decided";
  text: string;
  allowed: boolean;
};

export const claudePermissionRecord = (
  response: InteractionAnswer,
): PermissionRecord => {
  const allowed = response.selected.includes("allow");
  return {
    eventType: response.source === "timeout"
      ? "claude.permission.timedOut"
      : "claude.permission.decided",
    text: allowed ? "Claude permission was allowed." : "Claude permission was denied.",
    allowed,
  };
};

/**
 * How long Codex will wait for a human before answering itself.
 *
 * A blocking request has no deadline: Codex is waiting on the answer and there is nothing to
 * auto-resolve to. A non-blocking one carries the deadline Codex chose, and only a finite
 * positive value is one — an infinity or a zero from the wire is no deadline at all, and the
 * request falls back to waiting.
 */
export const codexAutoResolutionMs = (
  request: Pick<CodexUserInputRequest, "isBlocking" | "autoResolutionMs">,
): number | undefined =>
  !request.isBlocking &&
  request.autoResolutionMs !== undefined &&
  Number.isFinite(request.autoResolutionMs) &&
  request.autoResolutionMs > 0
    ? request.autoResolutionMs
    : undefined;

/**
 * How one Codex question is put to a human.
 *
 * A secret is never offered to the Lead: the fallback exists so a run can continue past a
 * deadline, and continuing is not worth handing a credential to another agent. Free text is
 * allowed when there is nothing to choose from, or when Codex itself marked the question as
 * accepting something other than its own options.
 */
export const codexUserInputAsk = (
  agentId: string,
  request: Pick<CodexUserInputRequest, "requestId" | "isBlocking" | "autoResolutionMs">,
  question: CodexUserInputQuestion,
): InteractionAsk & { timeoutMs?: number | undefined } => {
  const options = (question.options ?? []).map((option) => ({
    id: option.label,
    label: option.label,
    description: option.description,
  }));
  const allowFreeText = options.length === 0 || question.isOther === true;
  const timeoutMs = codexAutoResolutionMs(request);
  return {
    sourceKey: `codex-input:${agentId}:${request.requestId}:${question.id}`,
    kind: question.isSecret ? "secret" : "semanticQuestion",
    title: question.header,
    prompt: question.question,
    options,
    allowFreeText,
    secret: question.isSecret,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(question.isSecret
      ? {}
      : {
          fallback: {
            type: "lead" as const,
            originAgentId: agentId,
            title: question.header,
            prompt: question.question,
            options,
            allowFreeText,
          },
        }),
  };
};

/**
 * The answer a Codex response carries, or nothing.
 *
 * Codex takes one answer per question, so a choice and a note are joined into one string
 * under a heading rather than sent as two answers it would not read.
 */
export const codexUserInputAnswer = (
  response: InteractionAnswer,
): string | undefined => {
  const answer = [response.selected[0], response.freeText.trim()]
    .filter(Boolean)
    .join("\n\nAdditional user input: ");
  return answer === "" ? undefined : answer;
};

export type UnansweredCodexInput = {
  eventType: "codex.userInput.autoResolved" | "codex.userInput.cancelled";
  text: string;
};

export const codexUnansweredInput = (
  response: InteractionAnswer,
): UnansweredCodexInput =>
  response.source === "timeout"
    ? {
        eventType: "codex.userInput.autoResolved",
        text: "Codex input request reached its fallback deadline without an answer.",
      }
    : {
        eventType: "codex.userInput.cancelled",
        text: "Codex input request was cancelled.",
      };

export const codexUnansweredPick = (timedOut: boolean): UnansweredCodexInput =>
  timedOut
    ? {
        eventType: "codex.userInput.autoResolved",
        text: "Codex input request reached its auto-resolution deadline.",
      }
    : {
        eventType: "codex.userInput.cancelled",
        text: "Codex input request was cancelled.",
      };

/**
 * What is recorded about a Codex input request, before and after it is answered.
 *
 * The completion names which questions were secret rather than what they were answered with,
 * because the transcript is exported and a secret answer must never reach it.
 */
export const codexUserInputRequested = (
  request: Pick<CodexUserInputRequest, "requestId" | "questions" | "isBlocking" | "autoResolutionMs">,
): { text: string; detail: Record<string, unknown> } => ({
  text: `Codex requested ${String(request.questions.length)} input ${request.questions.length === 1 ? "answer" : "answers"}.`,
  detail: {
    requestId: request.requestId,
    questionIds: request.questions.map((question) => question.id),
    blocking: request.isBlocking,
    autoResolutionMs: request.autoResolutionMs ?? null,
  },
});

export const codexUserInputCompleted = (
  request: Pick<CodexUserInputRequest, "requestId" | "questions">,
  answeredQuestionIds: string[],
): Record<string, unknown> => ({
  requestId: request.requestId,
  answeredQuestionIds,
  secretQuestionIds: request.questions
    .filter((question) => question.isSecret)
    .map((question) => question.id),
});

export type ApprovalChoice = {
  id: string;
  label: string;
};

export type ApprovalRequestLike = {
  requestId: string;
  kind: string;
  choices: ApprovalChoice[];
  reason?: string | undefined;
  command?: string | undefined;
};

/**
 * What the human may answer an approval with.
 *
 * A request that offers nothing still has to be answerable, and the only answer that is safe
 * to invent is the one that grants nothing. Without this a provider could stall a run behind
 * a dialog with no way out.
 */
export const approvalChoices = (
  choices: readonly ApprovalChoice[],
): ApprovalChoice[] =>
  choices.length > 0
    ? choices.map((choice) => ({ id: choice.id, label: choice.label }))
    : [{ id: "cancel", label: "Cancel" }];

/**
 * What the human is told they are approving: the provider's own reason, the command it wants
 * to run, or — failing both — the kind of thing it is asking for. Never nothing.
 */
export const approvalPrompt = (request: ApprovalRequestLike): string =>
  request.reason ?? request.command ?? `Approve ${request.kind}`;

export type ApprovalRecord = {
  choice: string;
  eventType: "approval.timedOut" | "approval.decided";
  text: string;
};

/**
 * The answer an approval response carries.
 *
 * An empty selection is a cancellation, not an approval: a dialog dismissed without a choice
 * must never be read as consent.
 */
export const approvalRecord = (
  request: Pick<ApprovalRequestLike, "requestId">,
  response: InteractionAnswer,
): ApprovalRecord => {
  const choice = response.selected[0] ?? "cancel";
  return {
    choice,
    eventType: response.source === "timeout" ? "approval.timedOut" : "approval.decided",
    text: `Approval ${request.requestId}: ${choice}`,
  };
};

export type McpFormFieldLike = {
  key: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  secret: boolean;
};

export type McpUrlDecision =
  | { open: true; refusal?: undefined }
  | { open?: undefined; refusal: "noUrl" | "unparsable" | "unsupportedScheme" };

/**
 * Whether an MCP server's URL request may be put to the human at all.
 *
 * The server names the URL; Bachata opens it in the user's own browser, so anything but plain
 * web navigation is refused before a dialog appears. A scheme the extension host would treat
 * as a command — or a string that is no URL — is declined rather than shown as a choice.
 */
export const mcpUrlDecision = (
  url: string | undefined,
  scheme: (value: string) => string | undefined,
): McpUrlDecision => {
  if (!url) {
    return { refusal: "noUrl" };
  }
  const parsed = scheme(url);
  if (parsed === undefined) {
    return { refusal: "unparsable" };
  }
  if (parsed !== "http" && parsed !== "https") {
    return { refusal: "unsupportedScheme" };
  }
  return { open: true };
};

export type McpUrlOutcome = {
  action: "accept" | "decline" | "cancel";
  completed?: string | undefined;
};

/**
 * What an MCP URL prompt ended as.
 *
 * A dismissed dialog is a cancellation, not a refusal: the human answered nothing, and the
 * server is told that rather than being told no. An accepted URL that the host could not open
 * is a refusal, because nothing was opened and saying otherwise would be a false report.
 */
export const mcpUrlOutcome = (
  choice: string | undefined,
  opened: boolean,
): McpUrlOutcome => {
  if (choice === "Open") {
    return opened
      ? { action: "accept", completed: "MCP URL was opened." }
      : { action: "decline", completed: "MCP URL could not be opened." };
  }
  return { action: choice === "Decline" ? "decline" : "cancel" };
};

/**
 * What a field will accept, in the words the input box shows.
 *
 * A required field refuses an empty answer; an optional one accepts it and is skipped. Only
 * numeric fields parse, and an integer field refuses a fraction rather than rounding one.
 */
export const mcpFieldValidation = (
  field: Pick<McpFormFieldLike, "type" | "required">,
  input: string,
): string | undefined => {
  if (!input && field.required) {
    return "A value is required";
  }
  if (!input || field.type === "string") {
    return undefined;
  }
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) {
    return "Enter a valid number";
  }
  if (field.type === "integer" && !Number.isInteger(parsed)) {
    return "Enter a whole number";
  }
  return undefined;
};

/**
 * What a field's typed answer is worth.
 *
 * A string field keeps whatever was entered, including an empty one. A numeric field with an
 * empty answer has no value at all rather than zero, which is a different answer entirely.
 */
export const mcpFieldValue = (
  field: Pick<McpFormFieldLike, "type">,
  entered: string | undefined,
): string | number | undefined => {
  if (entered === undefined) {
    return undefined;
  }
  if (field.type === "string") {
    return entered;
  }
  return entered ? Number(entered) : undefined;
};

export const mcpElicitationRequested = (
  request: { requestId: string; serverName?: string | undefined; mode: string },
): { text: string; detail: Record<string, unknown> } => ({
  text: `MCP server requested ${request.mode === "url" ? "a URL interaction" : "structured input"}.`,
  detail: {
    requestId: request.requestId,
    serverName: request.serverName,
    mode: request.mode,
  },
});

/**
 * What is recorded once a form is accepted: which fields were answered, and which of those
 * were secret. Never a value — the transcript is exported.
 */
export const mcpElicitationCompleted = (
  requestId: string,
  content: Record<string, unknown>,
  secretFields: readonly string[],
): Record<string, unknown> => ({
  requestId,
  fieldNames: Object.keys(content),
  secretFields: [...secretFields],
});

/**
 * EX-3. Which editor widget a Codex question is put in, and what a pick from it means.
 *
 * A question with options is a picker; one that also allows another answer gets an extra entry
 * that opens an input box; everything else is an input box, secret when the question says so.
 * The choice lived beside the `showQuickPick` and `showInputBox` calls in the runtime, so which
 * widget a question got could only be seen by opening one.
 */
export const CODEX_OTHER_ANSWER_ID = "__pair_other__";

export type CodexQuestionInputBox = { title: string; prompt: string; password: boolean };

export type CodexQuestionWidget =
  | {
      kind: "pick";
      title: string;
      placeHolder: string;
      items: { label: string; description: string; value: string }[];
    }
  | ({ kind: "input" } & CodexQuestionInputBox);

export const codexQuestionInputBox = (
  question: Pick<CodexUserInputQuestion, "header" | "question" | "isSecret">,
): CodexQuestionInputBox => ({
  title: question.header,
  prompt: question.question,
  password: question.isSecret,
});

export const codexQuestionWidget = (
  question: Pick<CodexUserInputQuestion, "header" | "question" | "isOther" | "isSecret" | "options">,
): CodexQuestionWidget => {
  if (!question.options || question.options.length === 0) {
    return { kind: "input", ...codexQuestionInputBox(question) };
  }
  return {
    kind: "pick",
    title: question.header,
    placeHolder: question.question,
    items: [
      ...question.options.map((option) => ({
        label: option.label,
        description: option.description,
        value: option.label,
      })),
      ...(question.isOther
        ? [{ label: "Other…", description: "Enter another answer", value: CODEX_OTHER_ANSWER_ID }]
        : []),
    ],
  };
};

export type CodexPickOutcome =
  | { kind: "answer"; answer: string }
  /** The person chose to type another answer; the input box follows. */
  | { kind: "askOther" }
  | { kind: "none"; timedOut: boolean };

export const codexPickOutcome = (picked: {
  value?: { value: string } | undefined;
  timedOut: boolean;
}): CodexPickOutcome => {
  if (picked.value === undefined) return { kind: "none", timedOut: picked.timedOut };
  if (picked.value.value === CODEX_OTHER_ANSWER_ID) return { kind: "askOther" };
  return { kind: "answer", answer: picked.value.value };
};

/**
 * Which editor widget an MCP form field is put in.
 *
 * A field that names its values is a picker over them; a boolean is a True/False picker; anything
 * else is an input box, prefilled with the declared default and masked when the field is secret.
 * The field's own description is the placeholder where the picker has one to give, and the
 * server's message otherwise.
 */
export type McpFieldPresentation = McpFormFieldLike & {
  title: string;
  description?: string | undefined;
  values?: readonly { label: string; value: JsonValue }[] | undefined;
  defaultValue?: JsonValue | undefined;
};

export type McpFieldWidget =
  | {
      kind: "pick";
      title: string;
      placeHolder: string;
      items: { label: string; description?: string; value: JsonValue }[];
    }
  | { kind: "input"; title: string; prompt: string; value?: string; password: boolean };

export const mcpFieldWidget = (field: McpFieldPresentation, message: string): McpFieldWidget => {
  if (field.values) {
    return {
      kind: "pick",
      title: field.title,
      placeHolder: message,
      items: field.values.map((entry) => ({
        label: entry.label,
        ...(field.description === undefined ? {} : { description: field.description }),
        value: entry.value,
      })),
    };
  }
  if (field.type === "boolean") {
    return {
      kind: "pick",
      title: field.title,
      placeHolder: field.description ?? message,
      items: [
        { label: "True", value: true },
        { label: "False", value: false },
      ],
    };
  }
  const defaultText = field.defaultValue === undefined ? undefined : String(field.defaultValue);
  return {
    kind: "input",
    title: field.title,
    prompt: field.description ?? message,
    ...(defaultText === undefined ? {} : { value: defaultText }),
    password: field.secret,
  };
};

/**
 * The pending-approval record a panel is shown for a provider's request.
 *
 * Codex and the browser adapters ask in slightly different shapes — Codex names a grant root
 * where the others name a working directory, and only a browser request carries a browser
 * action. The panel sees one shape, with the grant root standing in for the working directory
 * when that is what was given.
 */
export type ApprovalRequestSource = {
  requestId: string;
  kind: AgentApprovalRequest["kind"];
  reason?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  grantRoot?: string | undefined;
  networkApprovalContext?: AgentApprovalRequest["networkApprovalContext"];
  commandActions?: JsonValue | undefined;
  additionalPermissions?: JsonValue | undefined;
  requestedPermissions?: JsonValue | undefined;
  proposedExecpolicyAmendment?: string[] | undefined;
  proposedNetworkPolicyAmendments?: JsonValue[] | undefined;
  browserAction?: JsonValue | undefined;
  choices: AgentApprovalChoice[];
};

export const pendingApprovalFrom = (
  agentId: string,
  request: ApprovalRequestSource,
): PendingApproval => ({
  agentId,
  requestId: request.requestId,
  kind: request.kind,
  reason: request.reason,
  command: request.command,
  cwd: request.cwd ?? request.grantRoot,
  networkApprovalContext: request.networkApprovalContext,
  commandActions: request.commandActions,
  browserAction: request.browserAction,
  additionalPermissions: request.additionalPermissions,
  requestedPermissions: request.requestedPermissions,
  proposedExecpolicyAmendment: request.proposedExecpolicyAmendment,
  proposedNetworkPolicyAmendments: request.proposedNetworkPolicyAmendments,
  choices: approvalChoices(request.choices),
});
