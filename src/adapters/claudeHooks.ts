import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";

export type ClaudeQuestionOption = {
  label: string;
  description?: string;
};

export type ClaudeQuestion = {
  question: string;
  header: string;
  options: ClaudeQuestionOption[];
  multiSelect: boolean;
};

export type ClaudeUserInputRequest = {
  requestId: string;
  sessionId?: string;
  questions: ClaudeQuestion[];
};

export type ClaudeUserInputResponse = {
  answers: Record<string, string>;
};

export type ClaudePermissionRequest = {
  requestId: string;
  sessionId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionSuggestions: unknown[];
  // The turn's commit mode, so the broker can refuse a commit before the tool runs.
  commitMode?: "never" | "allow";
};

export type ClaudePermissionResponse = {
  behavior: "allow" | "deny";
  message?: string;
};

export type ClaudeToolUseRequest = {
  toolName: string;
  toolInput: Record<string, unknown>;
};

export type ClaudeToolUseDecision = {
  behavior: "allow" | "deny";
  message?: string;
};

export type ClaudeHookHandlers = {
  commitMode?: "never" | "allow";
  requestUserInput?: (
    request: ClaudeUserInputRequest,
  ) => Promise<ClaudeUserInputResponse>;
  requestPermission?: (
    request: ClaudePermissionRequest,
  ) => Promise<ClaudePermissionResponse>;
  validateToolUse?: (
    request: ClaudeToolUseRequest,
  ) => Promise<ClaudeToolUseDecision>;
  log: (message: string) => void;
};

export type ClaudeHookServer = {
  settings: Record<string, unknown>;
  close: () => Promise<void>;
};

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseQuestions = (value: unknown): ClaudeQuestion[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const question = stringValue(item.question);
    const header = stringValue(item.header) ?? "Question";
    if (!question) {
      return [];
    }
    const options = Array.isArray(item.options)
      ? item.options.flatMap((option) => {
          if (!isObject(option) || typeof option.label !== "string") {
            return [];
          }
          return [{
            label: option.label,
            ...(typeof option.description === "string"
              ? { description: option.description }
              : {}),
          }];
        })
      : [];
    return [{
      question,
      header,
      options,
      multiSelect: item.multiSelect === true,
    }];
  });
};

const readJsonBody = async (request: IncomingMessage): Promise<JsonObject> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) {
      throw new Error("Claude hook request exceeded 1048576 bytes");
    }
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isObject(value)) {
    throw new Error("Claude hook request must be a JSON object");
  }
  return value;
};

const writeJson = (
  response: ServerResponse,
  statusCode: number,
  value: Record<string, unknown>,
): void => {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
};

const denyPreToolUse = (reason: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

const denyPermission = (message: string): Record<string, unknown> => ({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: {
      behavior: "deny",
      message,
    },
  },
});

const handlePreToolUse = async (
  input: JsonObject,
  handlers: ClaudeHookHandlers,
): Promise<Record<string, unknown>> => {
  const toolName = stringValue(input.tool_name) ?? "unknown";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (handlers.validateToolUse) {
    const decision = await handlers.validateToolUse({ toolName, toolInput });
    if (decision.behavior === "deny") {
      return denyPreToolUse(decision.message ?? "Denied by Bachata workspace policy");
    }
  }
  if (toolName !== "AskUserQuestion") {
    return {};
  }
  if (!handlers.requestUserInput) {
    return denyPreToolUse("Bachata has no Claude input handler");
  }
  const questions = parseQuestions(toolInput.questions);
  if (questions.length === 0) {
    return denyPreToolUse("Claude AskUserQuestion contained no valid questions");
  }
  const inputSessionId = stringValue(input.session_id);
  const result = await handlers.requestUserInput({
    requestId:
      stringValue(input.tool_use_id) ??
      stringValue(input.request_id) ??
      randomUUID(),
    ...(inputSessionId === undefined ? {} : { sessionId: inputSessionId }),
    questions,
  });
  const answers = Object.fromEntries(
    questions.map((question) => [
      question.question,
      result.answers[question.question] ?? "",
    ]),
  );
  if (Object.values(answers).some((answer) => !answer.trim())) {
    return denyPreToolUse("Claude question was not answered");
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...toolInput,
        questions: toolInput.questions,
        answers,
      },
    },
  };
};

const handlePermissionRequest = async (
  input: JsonObject,
  handlers: ClaudeHookHandlers,
): Promise<Record<string, unknown>> => {
  if (!handlers.requestPermission) {
    return denyPermission("Bachata has no Claude permission handler");
  }
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  const permissionSessionId = stringValue(input.session_id);
  const decision = await handlers.requestPermission({
    requestId:
      stringValue(input.tool_use_id) ??
      stringValue(input.request_id) ??
      randomUUID(),
    ...(permissionSessionId === undefined ? {} : { sessionId: permissionSessionId }),
    toolName: stringValue(input.tool_name) ?? "unknown",
    toolInput,
    permissionSuggestions: Array.isArray(input.permission_suggestions)
      ? input.permission_suggestions
      : [],
    ...(handlers.commitMode ? { commitMode: handlers.commitMode } : {}),
  });
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.behavior === "allow"
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            message: decision.message ?? "Denied by Bachata",
          },
    },
  };
};

export const startClaudeHookServer = async (
  handlers: ClaudeHookHandlers,
  timeoutMs: number,
): Promise<ClaudeHookServer> => {
  const token = randomUUID();
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (
        request.method !== "POST" ||
        request.url !== "/hooks" ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        writeJson(response, 404, { error: "not found" });
        return;
      }
      const input = await readJsonBody(request);
      const hookEvent = stringValue(input.hook_event_name);
      const result = hookEvent === "PreToolUse"
        ? await handlePreToolUse(input, handlers)
        : hookEvent === "PermissionRequest"
          ? await handlePermissionRequest(input, handlers)
          : {};
      writeJson(response, 200, result);
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      handlers.log(`Claude hook failed: ${message}`);
      const event = request.headers["x-bachata-hook-event"];
      writeJson(
        response,
        200,
        event === "PermissionRequest"
          ? denyPermission(message)
          : denyPreToolUse(message),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Claude hook server did not receive a TCP address");
  }
  const url = `http://127.0.0.1:${String(address.port)}/hooks`;
  const hookTimeout = Math.max(1, Math.ceil(timeoutMs / 1_000));
  const handler = (event: "PreToolUse" | "PermissionRequest") => ({
    type: "http",
    url,
    timeout: hookTimeout,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-bachata-Hook-Event": event,
    },
  });
  const hooks: Record<string, unknown> = {};
  if (handlers.requestUserInput || handlers.validateToolUse) {
    hooks.PreToolUse = [{
      matcher: handlers.validateToolUse ? "" : "AskUserQuestion",
      hooks: [handler("PreToolUse")],
    }];
  }
  if (handlers.requestPermission) {
    hooks.PermissionRequest = [{
      matcher: "",
      hooks: [handler("PermissionRequest")],
    }];
  }

  return {
    settings: { hooks },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      }),
  };
};
