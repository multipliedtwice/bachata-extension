import {
  appendBoundedText,
  createBoundedLineDecoder,
  createIncrementalTextDecoder,
} from "./streamDecoding";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createAsyncQueue } from "../process/asyncQueue";
import { checkCommand } from "../process/checkCommand";
import { ProcessTimeoutError } from "../process/errors";
import { redactText } from "../security/redact";
import { providerFailureErrorIfRecognized } from "./providerFailure";
import { assertWorkspacePathAllowed, isRestrictedWorkspacePath } from "../browser/mutationPolicy";
import { commandInvocation } from "../process/commandInvocation";
import { spawnScopedProviderProcess } from "../process/processScope";
import {
  ClaudeHookServer,
  ClaudePermissionRequest,
  ClaudePermissionResponse,
  ClaudeToolUseDecision,
  ClaudeToolUseRequest,
  ClaudeUserInputRequest,
  ClaudeUserInputResponse,
  startClaudeHookServer,
} from "./claudeHooks";
import { AgentAdapter, AgentEvent, SendRequest } from "./types";
import { assertGitHeadUnchanged, captureGitHeadSnapshot, GitHeadSnapshot } from "./gitHeadGuard";
import {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
  type WorkspacePolicyAuditSnapshot,
} from "./workspacePolicyAudit";

type JsonObject = Record<string, unknown>;

type ActiveRun = {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  terminate: (graceMs: number) => Promise<boolean>;
  stopping?: Promise<boolean>;
};

export type ClaudeAdapterOptions = {
  id?: string;
  adapterType?: string;
  resourceId?: string;
  command: string;
  defaultModel?: string;
  log: (message: string) => void;
  commandTimeoutMs?: number;
  turnTimeoutMs?: number;
  interruptGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
  requestUserInput?: (
    request: ClaudeUserInputRequest,
  ) => Promise<ClaudeUserInputResponse>;
  requestPermission?: (
    request: ClaudePermissionRequest,
  ) => Promise<ClaudePermissionResponse>;
};

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const extractAssistantText = (message: JsonObject): string => {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((block) => {
      const item = asObject(block);
      return asString(item?.text) ?? "";
    })
    .join("");
};

const extractPartialText = (message: JsonObject): string => {
  if (asString(message.type) !== "stream_event") {
    return "";
  }

  const event = asObject(message.event);
  const delta = asObject(event?.delta);
  return asString(delta?.text) ?? "";
};

const extractSessionId = (message: JsonObject): string | undefined =>
  asString(message.session_id) ??
  asString(asObject(message.message)?.session_id) ??
  asString(asObject(message.data)?.session_id);

const extractPermissionRequest = (
  message: JsonObject,
  sessionId?: string,
): ClaudePermissionRequest | undefined => {
  if (asString(message.type) !== "control_request") {
    return undefined;
  }
  const request = asObject(message.request);
  const requestId = asString(message.request_id);
  if (asString(request?.subtype) !== "can_use_tool" || !requestId) {
    return undefined;
  }
  return {
    requestId,
    ...(sessionId === undefined ? {} : { sessionId }),
    toolName: asString(request?.tool_name) ?? "unknown",
    toolInput: asObject(request?.input) ?? {},
    permissionSuggestions: Array.isArray(request?.permission_suggestions)
      ? request.permission_suggestions
      : [],
  };
};

const mimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const textAttachmentExtensions = new Set([".txt", ".md", ".json"]);

const createInputMessage = async (
  prompt: string,
  attachments: string[],
): Promise<string> => {
  const content: JsonObject[] = [{ type: "text", text: prompt }];

  for (const attachmentPath of attachments) {
    const extension = path.extname(attachmentPath).toLowerCase();
    if (textAttachmentExtensions.has(extension)) {
      const text = await readFile(attachmentPath, "utf8");
      content.push({
        type: "text",
        text: `Attached file ${path.basename(attachmentPath)}:\n${text}`,
      });
      continue;
    }
    const mimeType = mimeTypes[extension];
    if (!mimeType) {
      throw new Error(`Unsupported Claude attachment: ${attachmentPath}`);
    }

    const data = await readFile(attachmentPath);
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType,
        data: data.toString("base64"),
      },
    });
  }

  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  })}\n`;
};

const waitForClose = (
  child: ChildProcessWithoutNullStreams,
): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    child.once("close", () => resolve());
  });

const stopRun = (
  run: ActiveRun,
  graceMs: number,
): Promise<boolean> => {
  run.stopping ??= run.terminate(graceMs);
  return run.stopping;
};

const shellToolNames = new Set(["bash", "shell", "terminal", "exec", "execute", "command", "runcommand"]);
const mutationToolNames = new Set(["write", "edit", "multiedit", "notebookedit", "delete", "remove", "move", "rename", "copy", "applypatch", "patch"]);
const readToolNames = new Set(["read", "notebookread", "glob", "grep", "ls", "list", "search", "stat"]);
const internalToolNames = new Set(["task", "taskoutput", "taskstop", "todowrite", "askuserquestion", "skill", "enterplanmode", "exitplanmode", "toolsearch"]);
const networkToolNames = new Set(["webfetch", "websearch", "fetch", "http", "browser"]);
const pathKeys = new Set([
  "path",
  "paths",
  "filepath",
  "filepaths",
  "notebookpath",
  "oldpath",
  "newpath",
  "sourcepath",
  "destinationpath",
  "targetpath",
  "frompath",
  "topath",
  "directory",
  "directories",
  "workingdirectory",
  "cwd",
  "dir",
  "root",
]);

/**
 * EX-G6-07. The read tools that walk a tree rather than name a file.
 *
 * The tool-use hook is handed the search root and nothing else, so checking that the root is
 * readable says nothing about what comes back from under it. A run that withholds a path can be
 * handed the contents of that path by naming an allowed ancestor.
 */
const recursiveReadToolNames = new Set(["glob", "grep", "search", "find"]);

const normalizedToolName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/gu, "");

/**
 * EX-G6-07. The withheld path a recursive read rooted here would reach, if there is one.
 *
 * Exclusions are enforced where the tool cannot be told about them: the tool honours a root, so
 * the root is the boundary, and a root standing above something this run promised to withhold is
 * refused the way arbitrary shell execution already is.
 */
/** EX-A5-R11. How much of a tree a recursive read may be proved clean over before it is refused. */
const RECURSIVE_READ_SCAN_LIMIT = 20_000;

type RecursiveReadRefusal =
  | { kind: "withheld"; path: string }
  | { kind: "unprovable" };

/**
 * EX-A5-R11. Anything under this search root that Bachata may not disclose, or the fact that the
 * tree is too large to say.
 *
 * The configured `restrictedPaths` were the only thing this asked about, and they are the smaller
 * half of the policy. `.env`, private keys, credential files and the rest are refused by name and
 * by pattern wherever they sit — direct path validation rejects every one of them — so a search
 * rooted above one returned exactly what a direct read of it could not. The whole shared policy is
 * applied here, to everything the root can reach; a tree too large to finish walking is refused
 * rather than assumed clean, because an unfinished walk proves nothing.
 */
const recursiveReadRefusal = async (
  workingDirectory: string,
  rawPaths: readonly string[],
  restrictedPaths: readonly string[],
): Promise<RecursiveReadRefusal | undefined> => {
  const roots = rawPaths.length > 0 ? rawPaths : ["."];
  for (const rawPath of roots) {
    const searchRoot = path.resolve(workingDirectory, rawPath);
    for (const restricted of restrictedPaths) {
      const withheld = path.resolve(workingDirectory, restricted);
      const relative = path.relative(searchRoot, withheld);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return { kind: "withheld", path: restricted };
      }
    }
    let budget = RECURSIVE_READ_SCAN_LIMIT;
    const pending = [searchRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        // A directory that cannot be listed is a directory whose contents cannot be cleared.
        return { kind: "unprovable" };
      }
      for (const entry of entries) {
        budget -= 1;
        if (budget < 0) return { kind: "unprovable" };
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(workingDirectory, absolute);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        if (isRestrictedWorkspacePath(relative, restrictedPaths)) {
          return { kind: "withheld", path: relative };
        }
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(absolute);
      }
    }
  }
  return undefined;
};

const toolCategory = (toolName: string): "shell" | "mutation" | "read" | "network" | "internal" | "unknown" => {
  const normalized = normalizedToolName(toolName);
  const segments = toolName
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (shellToolNames.has(normalized) || segments.some((segment) => shellToolNames.has(segment))) return "shell";
  if (networkToolNames.has(normalized) || segments.some((segment) => networkToolNames.has(segment))) return "network";
  if (mutationToolNames.has(normalized) || segments.some((segment) => mutationToolNames.has(segment))) return "mutation";
  // A read is claimed, not inferred: a name that merely contains a read word (`search_replace`)
  // mutates, and the read branch is the one branch that is not refused for a scoped run.
  if (readToolNames.has(normalized)) return "read";
  if (internalToolNames.has(normalized)) return "internal";
  return "unknown";
};

const collectToolPaths = (value: unknown): string[] => {
  const results: string[] = [];
  const visit = (candidate: unknown, key?: string): void => {
    if (typeof candidate === "string") {
      if (key && pathKeys.has(normalizedToolName(key)) && candidate.trim()) results.push(candidate.trim());
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, key));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    Object.entries(candidate as Record<string, unknown>).forEach(([nestedKey, nestedValue]) => visit(nestedValue, nestedKey));
  };
  visit(value);
  return [...new Set(results)];
};

const validateClaudePaths = async (
  requestData: SendRequest,
  rawPaths: readonly string[],
  mutation: boolean,
): Promise<ClaudeToolUseDecision> => {
  const policy = requestData.workspacePolicy;
  if (!policy) return { behavior: "allow" };
  if (rawPaths.length === 0) {
    return { behavior: "deny", message: `${mutation ? "Mutation" : "Read"} tool did not provide an explicit workspace path` };
  }
  try {
    for (const rawPath of rawPaths) {
      const candidate = path.isAbsolute(rawPath)
        ? path.relative(requestData.workingDirectory, rawPath)
        : rawPath;
      const boundedPaths = mutation ? policy.allowedPaths : policy.readPaths;
      await assertWorkspacePathAllowed(requestData.workingDirectory, candidate, {
        ...(boundedPaths === undefined ? {} : { allowedPaths: boundedPaths }),
        ...(policy.restrictedPaths === undefined
          ? {}
          : { restrictedPaths: policy.restrictedPaths }),
        scopeMode: mutation
          ? policy.writeScope === "workspace" ? "workspace" : "bounded"
          : (policy.readPaths?.length ?? 0) > 0 ? "bounded" : "workspace",
        commitMode: policy.commitMode,
        readOnly: mutation ? policy.readOnly : true,
      });
    }
    return { behavior: "allow" };
  } catch (error) {
    return { behavior: "deny", message: error instanceof Error ? error.message : String(error) };
  }
};

export const validateClaudeWorkspaceToolUse = async (
  requestData: SendRequest,
  request: ClaudeToolUseRequest,
): Promise<ClaudeToolUseDecision> => {
  const policy = requestData.workspacePolicy;
  if (!policy) return { behavior: "allow" };
  const category = toolCategory(request.toolName);
  if (category === "shell") {
    return {
      behavior: "deny",
      message: "Shell execution is disabled because Bachata cannot enforce workspace read exclusions for arbitrary processes; use path-scoped tools or controller verification",
    };
  }
  if (category === "network") {
    if (policy.disableNetwork || policy.automated) {
      return { behavior: "deny", message: "Network tools are disabled by the Bachata autonomous workspace policy" };
    }
    return { behavior: "allow" };
  }
  if (category === "mutation") {
    if (policy.readOnly) return { behavior: "deny", message: "This participant is read-only" };
    return validateClaudePaths(requestData, collectToolPaths(request.toolInput), true);
  }
  if (category === "read") {
    const readPaths = collectToolPaths(request.toolInput);
    if (recursiveReadToolNames.has(normalizedToolName(request.toolName))) {
      const refusal = await recursiveReadRefusal(
        requestData.workingDirectory,
        readPaths,
        policy.restrictedPaths ?? [],
      );
      if (refusal?.kind === "withheld") {
        return {
          behavior: "deny",
          message: `Bachata cannot enforce workspace read exclusions for a recursive read rooted above ${refusal.path}; read a path below it, or narrow the search root`,
        };
      }
      if (refusal?.kind === "unprovable") {
        return {
          behavior: "deny",
          message: "Bachata cannot enumerate this search root to prove it holds nothing excluded from workspace reads; narrow the search root",
        };
      }
    }
    return validateClaudePaths(requestData, readPaths, false);
  }
  if (category === "internal") return { behavior: "allow" };
  if (policy.automated || policy.writeScope === "task" || policy.writeScope === "configured" || policy.writeScope === "readOnly") {
    return { behavior: "deny", message: `Unclassified Claude tool is disabled for scoped autonomous execution: ${request.toolName}` };
  }
  return { behavior: "allow" };
};

export const createClaudeCodeAdapter = (
  options: ClaudeAdapterOptions,
): AgentAdapter => {
  const log = (message: string): void => options.log(redactText(message));
  let activeRun: ActiveRun | undefined;
  let activeOperation: symbol | undefined;
  let disposed = false;
  const turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
  const interruptGraceMs = options.interruptGraceMs ?? 5_000;

  const send = (
    requestData: SendRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> => {
    const queue = createAsyncQueue<AgentEvent>();

    const execute = async (): Promise<void> => {
      if (disposed) {
        queue.fail(new Error("Claude Code adapter is disposed"));
        return;
      }

      if (activeRun || activeOperation) {
        queue.fail(new Error("Claude Code is already running"));
        return;
      }

      if (signal.aborted) {
        queue.push({ type: "status", value: "interrupted" });
        queue.push({ type: "complete", answer: "", status: "interrupted" });
        queue.end();
        return;
      }

      const operation = Symbol("claude-operation");
      activeOperation = operation;
      let input: string;
      try {
        input = await createInputMessage(
          requestData.prompt,
          requestData.attachments,
        );
      } catch (error) {
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        queue.fail(error);
        return;
      }

      if (disposed || signal.aborted) {
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        if (disposed) {
          queue.fail(new Error("Claude Code adapter is disposed"));
          return;
        }
        queue.push({ type: "status", value: "interrupted" });
        queue.push({ type: "complete", answer: "", status: "interrupted" });
        queue.end();
        return;
      }

      let providerActivity = false;
      const providerResourceId = options.resourceId ?? `claude-code:${options.id ?? "default"}`;
      let gitBaseline: GitHeadSnapshot | undefined;
      let workspaceAuditBaseline: WorkspacePolicyAuditSnapshot | undefined;
      try {
        if (requestData.workspacePolicy?.commitMode === "never") {
          gitBaseline = await captureGitHeadSnapshot(requestData.workingDirectory);
        }
        if (requestData.workspacePolicy) {
          workspaceAuditBaseline = await captureWorkspacePolicyAudit(requestData, signal);
        }
      } catch (error) {
        if (activeOperation === operation) activeOperation = undefined;
        queue.fail(error);
        return;
      }
      let hookServer: ClaudeHookServer;
      try {
        hookServer = await startClaudeHookServer(
          {
            ...(options.requestUserInput === undefined
              ? {}
              : { requestUserInput: options.requestUserInput }),
            ...(requestData.workspacePolicy?.commitMode
              ? { commitMode: requestData.workspacePolicy.commitMode }
              : {}),
            validateToolUse: async (request) => {
              const decision = await validateClaudeWorkspaceToolUse(requestData, request);
              if (decision.behavior === "allow") {
                providerActivity = true;
              }
              return decision;
            },
            log,
          },
          turnTimeoutMs,
        );
      } catch (error) {
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        queue.fail(error);
        return;
      }
      // The hook bearer token is a secret, and a command line is readable by every process running
      // as this user, so it travels in a 0600 file inside a 0700 directory that is removed with the
      // hook server itself, on every exit path.
      let settingsDirectory: string | undefined;
      let hookClose: Promise<void> | undefined;
      const closeHookServer = (): Promise<void> => {
        hookClose ??= hookServer
          .close()
          .finally(() =>
            settingsDirectory === undefined
              ? undefined
              : rm(settingsDirectory, { recursive: true, force: true }),
          );
        return hookClose;
      };

      let settingsPath: string;
      try {
        settingsDirectory = await mkdtemp(path.join(tmpdir(), "bachata-claude-settings-"));
        settingsPath = path.join(settingsDirectory, "settings.json");
        await writeFile(settingsPath, JSON.stringify(hookServer.settings), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await closeHookServer().catch(() => undefined);
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        queue.fail(error);
        return;
      }

      const generatedSessionId = randomUUID();
      const args = [
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        requestData.permissionMode ?? "default",
        "--settings",
        settingsPath,
      ];

      if (options.requestPermission) {
        args.push("--permission-prompt-tool", "stdio");
      }

      const model = requestData.model ?? options.defaultModel;
      if (model) {
        args.push("--model", model);
      }

      if (requestData.sessionId) {
        args.push("--resume", requestData.sessionId);
      } else {
        args.push("--session-id", generatedSessionId);
        if (requestData.sessionName) {
          args.push("--name", requestData.sessionName);
        }
      }

      let child: ChildProcessWithoutNullStreams;
      let terminateChild: (graceMs: number) => Promise<boolean>;
      try {
        const invocation = commandInvocation(options.command, args);
        const scope = spawnScopedProviderProcess(invocation.command, invocation.args, {
          cwd: requestData.workingDirectory,
          ...(options.environment === undefined ? {} : { env: options.environment }),
        });
        child = scope.child;
        terminateChild = scope.terminate;
      } catch (error) {
        await closeHookServer().catch(() => undefined);
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        queue.fail(error);
        return;
      }
      const closedPromise = waitForClose(child);
      const run: ActiveRun = { child, closed: closedPromise, terminate: terminateChild };
      let answer = "";
      let finalAnswer = "";
      let emittedPartial = false;
      let confirmedSessionId = requestData.sessionId;
      let emittedSessionId: string | undefined;
      let stderr = "";
      let resultError: string | undefined;
      let pendingError: unknown;
      let interrupted = false;
      let timedOut = false;
      let settled = false;
      let closed = false;
      let spawned = false;
      let timeout: NodeJS.Timeout | undefined;
      let stdinWrites = Promise.resolve();
      let resultReceived = false;
      let reapTimer: NodeJS.Timeout | undefined;
      // A bounded decoder, not readline: readline has no line-length limit, so a child that
      // emits a long record with no newline buffers it whole inside the extension host.
      const lines = createBoundedLineDecoder();
      let linesClosed = false;
      const closeLines = (): void => { linesClosed = true; };

      const writeControlResponse = (
        requestId: string,
        response: ClaudePermissionResponse,
        toolInput: Record<string, unknown>,
      ): Promise<void> => {
        const value = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: response.behavior === "allow"
              ? { behavior: "allow", updatedInput: toolInput }
              : {
                  behavior: "deny",
                  message: response.message ?? "Denied by Bachata",
                },
          },
        };
        const operation = stdinWrites.then(
          () => new Promise<void>((resolve, reject) => {
            if (child.stdin.destroyed || child.stdin.writableEnded) {
              reject(new Error("Claude permission response stream is closed"));
              return;
            }
            child.stdin.write(`${JSON.stringify(value)}\n`, "utf8", (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
        );
        stdinWrites = operation.catch(() => undefined);
        return operation;
      };

      const finishInputAfterResult = (): void => {
        if (resultReceived) {
          return;
        }
        resultReceived = true;
        stdinWrites = stdinWrites
          .then(
            () =>
              new Promise<void>((resolve) => {
                if (child.stdin.destroyed || child.stdin.writableEnded) {
                  resolve();
                  return;
                }
                child.stdin.end(() => resolve());
              }),
          )
          .catch(() => undefined);
        reapTimer = setTimeout(() => {
          void stopRun(run, interruptGraceMs).catch(() => undefined);
        }, Math.max(1_000, interruptGraceMs));
      };

      const cleanup = (): void => {
        signal.removeEventListener("abort", abortHandler);
        if (timeout) {
          clearTimeout(timeout);
        }
        if (reapTimer) {
          clearTimeout(reapTimer);
        }
        closeLines();
        if (activeRun?.child === child) {
          activeRun = undefined;
        }
        if (activeOperation === operation) {
          activeOperation = undefined;
        }
        void closeHookServer().catch((error) => {
          log(`Claude hook close failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };

      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        const failure = providerFailureErrorIfRecognized(
          error,
          "claude-code",
          providerResourceId,
          providerActivity ? "possible" : "none",
        );
        settled = true;
        cleanup();
        queue.fail(failure);
      };

      const complete = (status: "completed" | "interrupted"): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        queue.push({ type: "status", value: status });
        queue.push({
          type: "complete",
          answer: finalAnswer || answer,
          status,
        });
        queue.end();
      };

      const terminate = (): void => {
        if (closed) {
          return;
        }
        interrupted = true;
        void stopRun(run, interruptGraceMs).then(
          (terminated) => {
            if (!terminated && !settled) {
              fail(
                new Error(
                  timedOut
                    ? `Claude turn timed out after ${String(turnTimeoutMs)} ms and its process tree did not terminate`
                    : "Claude process tree did not terminate after interruption",
                ),
              );
            }
          },
          (error: unknown) => {
            if (!settled) {
              fail(error);
            }
          },
        );
      };

      const deferFailure = (error: unknown): void => {
        if (settled) return;
        pendingError ??= error;
        terminate();
      };

      const interrupt = (): void => {
        terminate();
      };

      const abortHandler = (): void => {
        interrupt();
      };

      activeRun = run;
      queue.push({ type: "status", value: "starting" });
      signal.addEventListener("abort", abortHandler, { once: true });

      const handleStdoutLine = (line: string): void => {
        if (!line.trim() || settled) {
          return;
        }

        let message: JsonObject;

        try {
          message = JSON.parse(line) as JsonObject;
        } catch {
          deferFailure(new Error("Claude emitted invalid stream JSON"));
          return;
        }

        const sessionId = extractSessionId(message);
        if (sessionId) {
          confirmedSessionId = sessionId;
          if (sessionId !== emittedSessionId) {
            emittedSessionId = sessionId;
            queue.push({ type: "session", sessionId });
          }
        }

        const permissionRequest = extractPermissionRequest(
          message,
          sessionId ?? confirmedSessionId,
        );
        if (permissionRequest) {
          if (requestData.workspacePolicy?.commitMode) {
            permissionRequest.commitMode = requestData.workspacePolicy.commitMode;
          }
          providerActivity = true;
          void (async (): Promise<void> => {
            let response: ClaudePermissionResponse;
            try {
              response = options.requestPermission
                ? await options.requestPermission(permissionRequest)
                : { behavior: "deny", message: "No Bachata permission handler is available" };
            } catch (error) {
              const messageText = error instanceof Error ? error.message : String(error);
              log(`Claude permission request failed: ${messageText}`);
              response = { behavior: "deny", message: messageText };
            }
            await writeControlResponse(
              permissionRequest.requestId,
              response,
              permissionRequest.toolInput,
            );
          })().catch((error) => {
            deferFailure(error);
          });
          return;
        }

        const partial = extractPartialText(message);
        if (partial) {
          providerActivity = true;
          emittedPartial = true;
          answer += partial;
          queue.push({ type: "text", text: partial });
          return;
        }

        const type = asString(message.type);
        if (type === "assistant" && !emittedPartial) {
          const text = extractAssistantText(asObject(message.message) ?? message);
          if (text) {
            providerActivity = true;
            answer += text;
            queue.push({ type: "text", text });
          }
          return;
        }

        if (type === "result") {
          finalAnswer = asString(message.result) ?? finalAnswer;
          if (message.is_error === true) {
            resultError =
              asString(message.error) ||
              finalAnswer ||
              asString(message.subtype) ||
              "Claude reported an error result";
          }
          finishInputAfterResult();
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (linesClosed) return;
        let produced: string[];
        try {
          produced = lines.push(chunk);
        } catch (error) {
          closeLines();
          deferFailure(error);
          return;
        }
        for (const line of produced) handleStdoutLine(line);
      });
      child.stdout.on("end", () => {
        if (linesClosed) return;
        try {
          for (const line of lines.end()) handleStdoutLine(line);
        } catch (error) {
          deferFailure(error);
        }
      });

      // Decoded incrementally: a multi-byte character split across two chunks would
      // otherwise reach the retained diagnostic as a replacement character.
      const stderrDecoder = createIncrementalTextDecoder();
      const takeStderr = (text: string): void => {
        if (!text) return;
        stderr = appendBoundedText(stderr, text, 32_768);
        if (text.trim()) {
          log(`[claude] ${text.trim()}`);
        }
      };
      child.stderr.on("data", (chunk: Buffer) => takeStderr(stderrDecoder.push(chunk)));
      child.stderr.on("end", () => takeStderr(stderrDecoder.end()));

      child.stdout.once("error", (error) => {
        deferFailure(error);
      });

      child.stderr.once("error", (error) => {
        deferFailure(error);
      });

      child.once("spawn", () => {
        spawned = true;
        queue.push({ type: "status", value: "running" });
        timeout = setTimeout(() => {
          timedOut = true;
          terminate();
        }, turnTimeoutMs);

        child.stdin.once("error", (error) => {
          deferFailure(error);
        });
        if (options.requestPermission) {
          child.stdin.write(input, "utf8", (error) => {
            if (error) {
              deferFailure(error);
            }
          });
        } else {
          child.stdin.end(input, "utf8");
        }

        if (signal.aborted) {
          interrupt();
        }
      });

      child.once("error", (error) => {
        if (spawned) {
          deferFailure(error);
        } else {
          fail(error);
        }
      });

      child.once("close", (code, closeSignal) => {
        closed = true;
        void (async (): Promise<void> => {
          const terminated = await stopRun(run, interruptGraceMs);
          if (settled) {
            cleanup();
            return;
          }
          if (!terminated) {
            fail(
              new Error(
                timedOut
                  ? `Claude turn timed out after ${String(turnTimeoutMs)} ms and its process tree did not terminate`
                  : "Claude process tree did not terminate after the CLI exited",
              ),
            );
            return;
          }

          if (requestData.workspacePolicy?.commitMode === "never") {
            await assertGitHeadUnchanged(requestData.workingDirectory, gitBaseline);
          }
          if (workspaceAuditBaseline) {
            await assertWorkspacePolicyAudit(requestData, workspaceAuditBaseline);
          }

          if (pendingError !== undefined) {
            fail(pendingError);
            return;
          }

          if (timedOut) {
            const detail = stderr.trim();
            fail(
              new ProcessTimeoutError(
                `Claude turn timed out after ${String(turnTimeoutMs)} ms${detail ? `: ${detail}` : ""}`,
              ),
            );
            return;
          }

          if (interrupted || signal.aborted) {
            complete("interrupted");
            return;
          }

          if (code !== 0 && !resultReceived) {
            const detail = stderr.trim();
            fail(
              new Error(
                detail ||
                  `Claude exited with code ${String(code)} and signal ${String(closeSignal)}`,
              ),
            );
            return;
          }

          if (resultError) {
            fail(new Error(resultError));
            return;
          }

          if (!confirmedSessionId) {
            fail(new Error("Claude completed without confirming a session id"));
            return;
          }

          if (confirmedSessionId !== emittedSessionId) {
            queue.push({ type: "session", sessionId: confirmedSessionId });
          }
          complete("completed");
        })().catch(fail);
      });
    };

    void execute().catch((error: unknown) => queue.fail(error));
    return queue.iterable;
  };

  return {
    id: options.id ?? "claude",
    adapterType: options.adapterType ?? "claude-code",
    capabilities: { streaming: true, resume: true, interrupt: true, attachments: true, repositoryTools: true, browserSessionSelection: false, passiveActionLoop: false },
    checkAvailability: () =>
      checkCommand(options.command, ["--version"], {
        ...(options.commandTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.commandTimeoutMs }),
        ...(options.interruptGraceMs === undefined
          ? {}
          : { terminateGraceMs: options.interruptGraceMs }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      }),
    send,
    interrupt: async () => {
      const run = activeRun;
      if (!run) {
        return;
      }
      if (!(await stopRun(run, interruptGraceMs))) {
        throw new Error("Claude process did not terminate after interruption");
      }
    },
    resetSession: async () => undefined,
    dispose: async () => {
      disposed = true;
      const run = activeRun;
      if (!run) {
        return;
      }
      if (!(await stopRun(run, interruptGraceMs))) {
        log("Claude process did not terminate during disposal");
      }
      if (activeRun === run) {
        activeRun = undefined;
      }
    },
  };
};
