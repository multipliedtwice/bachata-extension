import {
  createBoundedLineDecoder,
  createIncrementalTextDecoder,
} from "./streamDecoding";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { createAsyncQueue } from "../process/asyncQueue";
import { extensionVersion } from "../version";
import { ProcessTimeoutError } from "../process/errors";
import { redactText } from "../security/redact";
import { providerFailureErrorIfRecognized } from "./providerFailure";
import { assertWorkspacePathAllowed, isCommitCommand } from "../browser/mutationPolicy";
import {
  assertCodexScopeSupported,
  codexApprovalPolicyWire,
  codexSandboxModeWire,
  codexSandboxPolicyWire,
  codexWritesWorkspace,
  type CodexSandboxPolicy,
  type CodexWorkspacePolicy,
  type CodexWorkspaceScope,
} from "./codexWire";
import { commandInvocation } from "../process/commandInvocation";
import { spawnScopedProviderProcess } from "../process/processScope";

const textAttachmentExtensions = new Set([".txt", ".md", ".json"]);
import {
  AgentAdapter,
  AgentApprovalChoice,
  AgentEvent,
  JsonValue,
  NetworkApprovalContext,
  SendRequest,
} from "./types";
import { assertGitHeadUnchanged, captureGitHeadSnapshot, GitHeadSnapshot } from "./gitHeadGuard";
import {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
  type WorkspacePolicyAuditSnapshot,
} from "./workspacePolicyAudit";

type JsonObject = Record<string, unknown>;
type RpcId = number | string;

type PendingRequest = {
  resolve: (value: JsonObject) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

type NotificationListener = (message: JsonObject) => void;

type ActiveOperation = {
  fail: (error: unknown) => void;
};

export type CodexApprovalRequest = {
  requestId: string;
  kind: "command" | "fileChange" | "permissions";
  method: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  reason?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  grantRoot?: string | undefined;
  networkApprovalContext?: NetworkApprovalContext | undefined;
  commandActions?: JsonValue | undefined;
  additionalPermissions?: JsonValue | undefined;
  requestedPermissions?: JsonValue | undefined;
  proposedExecpolicyAmendment?: string[] | undefined;
  proposedNetworkPolicyAmendments?: JsonValue[] | undefined;
  choices: AgentApprovalChoice[];
};

export type CodexUserInputQuestionOption = {
  label: string;
  description: string;
};

export type CodexUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: CodexUserInputQuestionOption[];
};

export type CodexUserInputRequest = {
  requestId: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  questions: CodexUserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs?: number | undefined;
};

export type CodexUserInputResponse = {
  answers: Record<string, { answers: string[] }>;
};

export type CodexMcpElicitationRequest = {
  requestId: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  serverName?: string | undefined;
  mode: "form" | "openai/form" | "url";
  message: string;
  requestedSchema?: JsonValue | undefined;
  url?: string | undefined;
  elicitationId?: string | undefined;
};

export type CodexMcpElicitationResponse = {
  action: "accept" | "decline" | "cancel";
  content: JsonValue | null;
};

export type CodexAdapterOptions = {
  id?: string | undefined;
  resourceId?: string | undefined;
  command: string;
  commandCheckTimeoutMs: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  interruptGraceMs: number;
  environment?: NodeJS.ProcessEnv | undefined;
  workingDirectory?: string | undefined;
  workspaceScope?: CodexWorkspaceScope | undefined;
  requestApproval: (request: CodexApprovalRequest) => Promise<string>;
  requestUserInput?: (
    request: CodexUserInputRequest,
  ) => Promise<CodexUserInputResponse>;
  requestMcpElicitation?: (
    request: CodexMcpElicitationRequest,
  ) => Promise<CodexMcpElicitationResponse>;
  log: (message: string) => void;
};

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const getObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object"
    ? (value as JsonObject)
    : undefined;

const getNotificationThreadId = (message: JsonObject): string | undefined => {
  const params = getObject(message.params);
  const turn = getObject(params?.turn);
  return getString(params?.threadId) ?? getString(turn?.threadId);
};

const getNotificationTurnId = (message: JsonObject): string | undefined => {
  const params = getObject(message.params);
  const turn = getObject(params?.turn);
  return getString(params?.turnId) ?? getString(turn?.id);
};

const getDelta = (message: JsonObject): string | undefined => {
  const params = getObject(message.params);
  return getString(params?.delta) ?? getString(getObject(params?.delta)?.text);
};

const getAgentMessageText = (item: JsonObject): string | undefined => {
  const text = getString(item.text);
  if (text !== undefined) {
    return text;
  }

  const content = Array.isArray(item.content) ? item.content : [];
  const joined = content
    .map((entry) => getString(getObject(entry)?.text) ?? "")
    .join("");
  return joined || undefined;
};

// `item/commandExecution/requestApproval` declares `command: string | null` in the Codex
// 0.146.0 schema, so the string branch is the live one. An argv array belongs to the legacy
// `execCommandApproval` method, which nothing here wires up. Joining such an array on spaces
// would destroy the quoting that made a payload one argument, and the policy parser would
// then re-split it and read `bash -lc "git commit"` as a bare `git`. Quote each element so a
// later wiring of the legacy shape stays analysable instead of silently unenforced.
const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const getCommand = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const argv = value.filter((entry): entry is string => typeof entry === "string");
    return argv.length === 0 ? undefined : argv.map(shellQuote).join(" ");
  }

  return undefined;
};


const getNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toJsonValue = (value: unknown): JsonValue | undefined => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
};

const getStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return values.length > 0 ? values : undefined;
};

const parseUserInputQuestions = (
  value: unknown,
): CodexUserInputQuestion[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    return undefined;
  }
  const questions: CodexUserInputQuestion[] = [];
  for (const item of value) {
    const question = getObject(item);
    if (!question) {
      return undefined;
    }
    const id = getString(question.id);
    const header = getString(question.header);
    const text = getString(question.question);
    if (!id || !header || !text) {
      return undefined;
    }
    let optionsValue: CodexUserInputQuestionOption[] | undefined;
    if (question.options !== undefined) {
      if (!Array.isArray(question.options)) {
        return undefined;
      }
      optionsValue = [];
      for (const optionValue of question.options) {
        const option = getObject(optionValue);
        const label = getString(option?.label);
        const description = getString(option?.description);
        if (!label || description === undefined) {
          return undefined;
        }
        optionsValue.push({ label, description });
      }
    }
    questions.push({
      id,
      header,
      question: text,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      ...(optionsValue ? { options: optionsValue } : {}),
    });
  }
  return questions;
};

const getNetworkApprovalContext = (
  value: unknown,
): NetworkApprovalContext | undefined => {
  const context = getObject(value);
  if (!context) {
    return undefined;
  }
  const host = getString(context.host);
  const protocol = getString(context.protocol);
  const port = getNumber(context.port);
  const result: NetworkApprovalContext = {
    ...(host === undefined ? {} : { host }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(port === undefined ? {} : { port }),
  };
  return result.host || result.protocol || result.port !== undefined
    ? result
    : undefined;
};

const canonicalPolicyRoots = async (
  workingDirectory: string,
  paths: readonly string[],
  readOnly: boolean,
  workspace: boolean,
  restrictedPaths?: string[],
): Promise<string[]> => {
  const roots: string[] = [];
  for (const candidate of paths) {
    const resolved = await assertWorkspacePathAllowed(workingDirectory, candidate, {
      allowedPaths: workspace ? ["."] : [...paths],
      ...(restrictedPaths === undefined ? {} : { restrictedPaths }),
      scopeMode: workspace ? "workspace" : "bounded",
      commitMode: "never",
      readOnly,
    });
    if (!roots.includes(resolved.absolute)) roots.push(resolved.absolute);
  }
  return roots;
};

const writableRoots = async (
  workingDirectory: string,
  workspacePolicy: CodexWorkspacePolicy,
): Promise<string[]> => {
  const workspace = !workspacePolicy || workspacePolicy.writeScope === "workspace";
  const allowedPaths = workspace ? ["."] : workspacePolicy?.allowedPaths ?? [];
  if (!workspace && allowedPaths.length === 0) {
    throw new Error("Task-scoped Codex execution requires at least one writable path");
  }
  return canonicalPolicyRoots(
    workingDirectory,
    allowedPaths,
    false,
    workspace,
    workspacePolicy?.restrictedPaths,
  );
};

const sandboxPolicy = async (
  permissionMode: string | undefined,
  workingDirectory: string,
  workspacePolicy: CodexWorkspacePolicy,
  workspaceScope: CodexWorkspaceScope,
): Promise<CodexSandboxPolicy> => {
  assertCodexScopeSupported(workspacePolicy, workspaceScope);
  return codexSandboxPolicyWire(
    permissionMode,
    workspacePolicy,
    codexWritesWorkspace(permissionMode, workspacePolicy)
      ? await writableRoots(workingDirectory, workspacePolicy)
      : [],
  );
};

const codexFileChangePaths = (changes: unknown): string[] | undefined => {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 10_000) return undefined;
  const paths = new Set<string>();
  for (const value of changes) {
    const change = getObject(value);
    const filePath = getString(change?.path);
    const kind = getObject(change?.kind);
    if (!filePath?.trim() || typeof change?.diff !== "string"
      || !["add", "delete", "update"].includes(getString(kind?.type) ?? "")) return undefined;
    paths.add(filePath);
    if (kind?.type === "update" && kind.move_path !== undefined && kind.move_path !== null) {
      const target = getString(kind.move_path);
      if (!target?.trim()) return undefined;
      paths.add(target);
    }
    if (paths.size > 10_000) return undefined;
  }
  return [...paths];
};

const codexFileChangeAllowed = async (
  requestData: SendRequest,
  paths: readonly string[],
): Promise<boolean> => {
  const policy = requestData.workspacePolicy;
  if (!policy) return true;
  if (policy.readOnly || paths.length === 0) return false;
  try {
    for (const rawPath of paths) {
      const candidate = path.isAbsolute(rawPath)
        ? path.relative(requestData.workingDirectory, rawPath)
        : rawPath;
      await assertWorkspacePathAllowed(requestData.workingDirectory, candidate, {
        ...(policy.allowedPaths === undefined ? {} : { allowedPaths: policy.allowedPaths }),
        ...(policy.restrictedPaths === undefined
          ? {}
          : { restrictedPaths: policy.restrictedPaths }),
        scopeMode: policy.writeScope === "workspace" ? "workspace" : "bounded",
        commitMode: policy.commitMode,
        readOnly: policy.readOnly,
      });
    }
    return true;
  } catch {
    return false;
  }
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);


export const createCodexAppServerAdapter = (
  options: CodexAdapterOptions,
): AgentAdapter => {
  const log = (message: string): void => options.log(redactText(message));
  const workspaceScope: CodexWorkspaceScope = options.workspaceScope ?? "refuseNarrowedScope";
  let child: ChildProcessWithoutNullStreams | undefined;
  let requestId = 1;
  let initialized = false;
  let serverUserAgent: string | undefined;
  let startPromise: Promise<void> | undefined;
  let activeThreadId: string | undefined;
  let activeTurnId: string | undefined;
  let disposed = false;
  let failTransport: ((error: unknown) => void) | undefined;
  /**
   * EX-G6-06. Whether the transport's process tree actually went away, not merely that it was
   * asked to. A turn that settles on the answer to this question is a turn whose provider
   * resource is released only once nothing of it is still running.
   */
  let transportTermination: Promise<boolean> | undefined;
  let terminateChild: ((graceMs: number) => Promise<boolean>) | undefined;
  const pending = new Map<number, PendingRequest>();
  const listeners = new Set<NotificationListener>();
  const activeOperations = new Set<ActiveOperation>();
  const turnsWithProviderActivity = new Set<string>();
  const namedThreads = new Map<string, string>();
  const requestByTurn = new Map<string, SendRequest>();
  const fileChangeProposals = new Map<string, { threadId: string; turnId: string; paths: string[] }>();
  let pendingRequestData: SendRequest | undefined;

  const write = (message: JsonObject): void => {
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      child.stdin.destroyed
    ) {
      throw new Error("Codex app-server is not running");
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id: RpcId, result: JsonObject): void => {
    write({ id, result });
  };

  const respondError = (id: RpcId, code: number, message: string): void => {
    write({ id, error: { code, message } });
  };

  const request = (
    method: string,
    params: JsonObject,
    timeoutMs = options.requestTimeoutMs,
  ): Promise<JsonObject> => {
    const id = requestId;
    requestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ProcessTimeoutError(
          `Codex request ${method} timed out after ${String(timeoutMs)} ms`,
        );
        pending.delete(id);
        reject(error);
        if (failTransport) {
          failTransport(error);
        } else {
          terminateTransport();
        }
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });

      try {
        write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const notify = (method: string, params: JsonObject): void => {
    write({ method, params });
  };

  const rejectPending = (error: unknown): void => {
    const entries = Array.from(pending.values());
    pending.clear();
    entries.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });
  };

  const failActiveOperations = (error: unknown): void => {
    Array.from(activeOperations).forEach((operation) => operation.fail(error));
  };

  // EX-A5-R10. The drain is bound to the child that owns it: callers pass that launch's scoped
  // terminate (the one that scans for its token), so a descendant that left the process group is
  // still reached. A drained process may deliver its exit event after a replacement starts;
  // processFailure checks child identity before changing shared transport state.
  const beginTransportTermination = (
    terminate: (graceMs: number) => Promise<boolean>,
  ): Promise<boolean> => {
    if (transportTermination) return transportTermination;
    transportTermination = terminate(options.interruptGraceMs).then(
      (terminated) => {
        if (!terminated) {
          log("Codex process tree did not terminate");
        }
        return terminated;
      },
      (error) => {
        log(`Codex process-tree termination failed: ${errorMessage(error)}`);
        return false;
      },
    );
    return transportTermination;
  };

  // The current child is always paired with its scoped terminate (both assigned together at spawn),
  // so a missing scoped callback is an impossible broken invariant, not a live launch. Fail closed —
  // report the tree as not terminated — rather than downgrade to a weaker group-only terminate.
  const currentTerminate = (): (graceMs: number) => Promise<boolean> =>
    terminateChild ?? (() => Promise.resolve(false));

  const terminateTransport = (): Promise<boolean> => {
    const processChild = child;
    if (!processChild) {
      return transportTermination ?? Promise.resolve(true);
    }
    return beginTransportTermination(currentTerminate());
  };

  const answerServerRequest = async (message: JsonObject): Promise<void> => {
    const id =
      typeof message.id === "number" || typeof message.id === "string"
        ? message.id
        : undefined;
    const method = getString(message.method);

    if (id === undefined || !method) {
      return;
    }

    const params = getObject(message.params) ?? {};
    const requestTurnId = getString(params.turnId);
    const workspaceRequest = (requestTurnId ? requestByTurn.get(requestTurnId) : undefined) ?? pendingRequestData;
    const workspacePolicy = workspaceRequest?.workspacePolicy;
    if (requestTurnId && (
      method === "item/commandExecution/requestApproval"
      || method === "item/fileChange/requestApproval"
      || method === "item/permissions/requestApproval"
      || method === "item/tool/requestUserInput"
      || method === "tool/requestUserInput"
      || method === "mcpServer/elicitation/request"
    )) {
      turnsWithProviderActivity.add(requestTurnId);
    }

    try {
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval"
      ) {
        const kind =
          method === "item/commandExecution/requestApproval"
            ? "command"
            : "fileChange";
        const command = getCommand(params.command);
        const itemId = getString(params.itemId) ?? "";
        const proposal = fileChangeProposals.get(itemId);
        const fileChangeProposal = kind === "fileChange" && proposal?.threadId === getString(params.threadId)
          && proposal?.turnId === requestTurnId ? proposal : undefined;
        if (workspacePolicy?.readOnly === true) {
          respond(id, { decision: "cancel" });
          return;
        }
        if (kind === "command" && (workspacePolicy?.disableShell || workspacePolicy?.automated)) {
          respond(id, { decision: "cancel" });
          return;
        }
        if (kind === "fileChange" && (!fileChangeProposal || !workspaceRequest
          || !(await codexFileChangeAllowed(workspaceRequest, fileChangeProposal.paths))
          || fileChangeProposals.get(itemId) !== fileChangeProposal
          || requestByTurn.get(requestTurnId ?? "") !== workspaceRequest)) {
          respond(id, { decision: "cancel" });
          return;
        }
        if (kind === "command" && (
          workspacePolicy?.disableNetwork
          || workspacePolicy?.automated
        ) && (params.networkApprovalContext !== undefined || params.proposedNetworkPolicyAmendments !== undefined)) {
          respond(id, { decision: "cancel" });
          return;
        }
        if (kind === "command" && workspacePolicy?.commitMode === "never" && command && isCommitCommand(command)) {
          respond(id, { decision: "cancel" });
          return;
        }
        const choices: AgentApprovalChoice[] = [];
        const responses = new Map<string, JsonObject>();
        const addChoice = (
          choice: AgentApprovalChoice,
          response: JsonObject,
        ): void => {
          if (responses.has(choice.id)) {
            return;
          }
          choices.push(choice);
          responses.set(choice.id, response);
        };
        const addStandardChoice = (decision: string): void => {
          if (decision === "acceptForSession" && kind === "fileChange" && workspacePolicy) return;
          const labels: Record<string, string> = {
            accept: "Accept once",
            acceptForSession: "Accept for session",
            decline: "Decline",
            cancel: "Cancel",
          };
          const label = labels[decision];
          if (label) {
            addChoice({ id: decision, label }, { decision });
          }
        };

        const proposedExecpolicyAmendment = getStringArray(
          params.proposedExecpolicyAmendment,
        );
        const proposedNetworkPolicyAmendments = Array.isArray(
          params.proposedNetworkPolicyAmendments,
        )
          ? params.proposedNetworkPolicyAmendments
              .map(toJsonValue)
              .filter((value): value is JsonValue => value !== undefined)
          : [];
        const availableDecisions = Array.isArray(params.availableDecisions)
          ? params.availableDecisions
          : [];

        availableDecisions.forEach((decision, index) => {
          if (typeof decision === "string") {
            if (decision === "acceptWithExecpolicyAmendment") {
              if (proposedExecpolicyAmendment) {
                addChoice(
                  {
                    id: `execpolicy:${String(index)}`,
                    label: "Accept and remember command rule",
                  },
                  {
                    decision: {
                      acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: proposedExecpolicyAmendment,
                      },
                    },
                  },
                );
              }
              return;
            }
            addStandardChoice(decision);
            return;
          }

          const decisionObject = getObject(decision);
          const execpolicy = getObject(
            decisionObject?.acceptWithExecpolicyAmendment,
          );
          const execpolicyAmendment =
            getStringArray(execpolicy?.execpolicy_amendment) ??
            proposedExecpolicyAmendment;
          if (execpolicyAmendment) {
            addChoice(
              {
                id: `execpolicy:${String(index)}`,
                label: "Accept and remember command rule",
              },
              {
                decision: {
                  acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: execpolicyAmendment,
                  },
                },
              },
            );
          }

          const network = getObject(decisionObject?.applyNetworkPolicyAmendment);
          const networkAmendment =
            toJsonValue(network?.network_policy_amendment) ??
            proposedNetworkPolicyAmendments.at(index);
          if (networkAmendment !== undefined) {
            addChoice(
              {
                id: `networkPolicy:${String(index)}`,
                label: "Accept and remember network rule",
              },
              {
                decision: {
                  applyNetworkPolicyAmendment: {
                    network_policy_amendment: networkAmendment,
                  },
                },
              },
            );
          }
        });

        if (availableDecisions.length === 0) {
          addStandardChoice("accept");
          addStandardChoice("acceptForSession");
          if (kind === "command" && proposedExecpolicyAmendment) {
            addChoice(
              {
                id: "execpolicy:proposed",
                label: "Accept and remember command rule",
              },
              {
                decision: {
                  acceptWithExecpolicyAmendment: {
                    execpolicy_amendment: proposedExecpolicyAmendment,
                  },
                },
              },
            );
          }
          if (kind === "command") {
            proposedNetworkPolicyAmendments.forEach((amendment, index) => {
              addChoice(
                {
                  id: `networkPolicy:${String(index)}`,
                  label: "Accept and remember network rule",
                },
                {
                  decision: {
                    applyNetworkPolicyAmendment: {
                      network_policy_amendment: amendment,
                    },
                  },
                },
              );
            });
          }
          addStandardChoice("decline");
          addStandardChoice("cancel");
        }

        if (choices.length === 0) {
          addStandardChoice("cancel");
        }

        const choiceId = await options.requestApproval({
          requestId: String(id),
          kind,
          method,
          threadId: getString(params.threadId),
          turnId: getString(params.turnId),
          reason: fileChangeProposal
            ? [getString(params.reason), "Proposed files:",
              ...fileChangeProposal.paths.slice(0, 20).map((filePath) => JSON.stringify(filePath)),
              ...(fileChangeProposal.paths.length > 20 ? [`${String(fileChangeProposal.paths.length - 20)} more files`] : [])]
              .filter((line) => line !== undefined).join("\n")
            : getString(params.reason),
          command,
          cwd: getString(params.cwd),
          grantRoot: getString(params.grantRoot),
          networkApprovalContext: getNetworkApprovalContext(
            params.networkApprovalContext,
          ),
          commandActions: toJsonValue(params.commandActions),
          additionalPermissions: toJsonValue(params.additionalPermissions),
          proposedExecpolicyAmendment,
          proposedNetworkPolicyAmendments,
          choices,
        });
        const response = responses.get(choiceId);
        if (!response) {
          throw new Error(`Unsupported approval choice: ${choiceId}`);
        }
        if (kind === "fileChange") {
          const allowed = workspaceRequest && fileChangeProposal
            && await codexFileChangeAllowed(workspaceRequest, fileChangeProposal.paths);
          if (!allowed || fileChangeProposals.get(itemId) !== fileChangeProposal
            || requestByTurn.get(requestTurnId ?? "") !== workspaceRequest) {
            respond(id, { decision: "cancel" });
            return;
          }
          fileChangeProposals.delete(itemId);
        }
        respond(id, response);
        return;
      }

      if (method === "item/permissions/requestApproval") {
        if (workspacePolicy) {
          respond(id, { permissions: {}, scope: "turn" });
          return;
        }
        const requestedPermissions = toJsonValue(
          params.permissions ?? params.requestedPermissions,
        );
        const choices: AgentApprovalChoice[] = [
          { id: "grantForTurn", label: "Grant for this turn" },
          { id: "grantForSession", label: "Grant for this session" },
          { id: "decline", label: "Continue without permissions" },
          { id: "cancel", label: "Cancel" },
        ];
        const choiceId = await options.requestApproval({
          requestId: String(id),
          kind: "permissions",
          method,
          threadId: getString(params.threadId),
          turnId: getString(params.turnId),
          reason: getString(params.reason),
          cwd: getString(params.cwd),
          requestedPermissions,
          choices,
        });

        if (choiceId === "grantForTurn" || choiceId === "grantForSession") {
          respond(id, {
            permissions: requestedPermissions ?? {},
            scope: choiceId === "grantForSession" ? "session" : "turn",
          });
          return;
        }

        if (choiceId === "decline" || choiceId === "cancel") {
          respond(id, { permissions: {}, scope: "turn" });
          return;
        }

        throw new Error(`Unsupported permission choice: ${choiceId}`);
      }

      if (
        method === "item/tool/requestUserInput" ||
        method === "tool/requestUserInput"
      ) {
        const questions = parseUserInputQuestions(params.questions);
        if (!questions) {
          respond(id, { answers: {} });
          return;
        }
        const request: CodexUserInputRequest = {
          requestId: String(id),
          threadId: getString(params.threadId),
          turnId: getString(params.turnId),
          questions,
          isBlocking: params.isBlocking !== false,
          autoResolutionMs: getNumber(params.autoResolutionMs),
        };
        const operation = options.requestUserInput
          ? options.requestUserInput(request)
          : Promise.resolve({ answers: {} });
        let response: CodexUserInputResponse;
        if (
          !request.isBlocking &&
          request.autoResolutionMs !== undefined &&
          Number.isFinite(request.autoResolutionMs) &&
          request.autoResolutionMs > 0
        ) {
          let timer: NodeJS.Timeout | undefined;
          try {
            response = await Promise.race([
              operation,
              new Promise<CodexUserInputResponse>((resolve) => {
                timer = setTimeout(
                  () => resolve({ answers: {} }),
                  request.autoResolutionMs,
                );
              }),
            ]);
          } finally {
            if (timer) {
              clearTimeout(timer);
            }
          }
          void operation.catch((error) => {
            log(`Late Codex user-input handler failed: ${errorMessage(error)}`);
          });
        } else {
          response = await operation;
        }
        respond(id, response);
        return;
      }

      if (method === "mcpServer/elicitation/request") {
        if (workspacePolicy?.disableNetwork || workspacePolicy?.automated) {
          respond(id, { action: "cancel", content: null });
          return;
        }
        const mode = getString(params.mode);
        const message = getString(params.message);
        if (
          (mode !== "form" && mode !== "openai/form" && mode !== "url") ||
          !message
        ) {
          respond(id, { action: "decline", content: null });
          return;
        }
        const response = options.requestMcpElicitation
          ? await options.requestMcpElicitation({
              requestId: String(id),
              threadId: getString(params.threadId),
              turnId: getString(params.turnId),
              serverName: getString(params.serverName),
              mode,
              message,
              requestedSchema: toJsonValue(params.requestedSchema),
              url: getString(params.url),
              elicitationId: getString(params.elicitationId),
            })
          : { action: "decline" as const, content: null };
        respond(id, response);
        return;
      }

      if (method === "account/chatgptAuthTokens/refresh") {
        respondError(
          id,
          -32000,
          "Host token refresh is unavailable. Reauthenticate with Codex CLI.",
        );
        return;
      }

      respondError(id, -32601, `Unsupported Codex server request: ${method}`);
    } catch (error) {
      log(
        `Failed to answer Codex server request ${method}: ${errorMessage(error)}`,
      );

      try {
        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval"
        ) {
          respond(id, { decision: "cancel" });
        } else if (method === "item/permissions/requestApproval") {
          respond(id, { permissions: {}, scope: "turn" });
        } else if (
          method === "item/tool/requestUserInput" ||
          method === "tool/requestUserInput"
        ) {
          respond(id, { answers: {} });
        } else if (method === "mcpServer/elicitation/request") {
          respond(id, { action: "cancel", content: null });
        } else {
          respondError(id, -32000, errorMessage(error));
        }
      } catch (responseError) {
        log(
          `Failed to send Codex server-request fallback: ${errorMessage(responseError)}`,
        );
      }
    }
  };

  const handleLine = (line: string): void => {
    if (!line.trim()) {
      return;
    }

    let message: JsonObject;

    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      const error = new Error("Codex emitted invalid JSON");
      log(error.message);
      if (failTransport) {
        failTransport(error);
      } else {
        terminateTransport();
      }
      return;
    }

    const serverRequestId =
      typeof message.id === "number" || typeof message.id === "string"
        ? message.id
        : undefined;
    if (serverRequestId !== undefined && getString(message.method)) {
      void answerServerRequest(message).catch((error: unknown) => {
        log(`Codex server request handling failed: ${errorMessage(error)}`);
      });
      return;
    }

    const responseId = typeof message.id === "number" ? message.id : undefined;

    if (responseId !== undefined && pending.has(responseId)) {
      const entry = pending.get(responseId) as PendingRequest;
      pending.delete(responseId);
      clearTimeout(entry.timer);
      const error = getObject(message.error);

      if (error) {
        entry.reject(
          new Error(getString(error.message) ?? "Codex request failed"),
        );
        return;
      }

      entry.resolve(getObject(message.result) ?? {});
      return;
    }

    listeners.forEach((listener) => listener(message));
  };

  const start = async (): Promise<void> => {
    if (disposed) {
      throw new Error("Codex adapter is disposed");
    }

    if (
      initialized &&
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      return;
    }

    if (startPromise) {
      return startPromise;
    }

    const invocation = commandInvocation(options.command, ["app-server"]);
    const scope = spawnScopedProviderProcess(invocation.command, invocation.args, {
      ...(options.environment === undefined ? {} : { env: options.environment }),
    });
    const processChild = scope.child;
    terminateChild = scope.terminate;
    child = processChild;
    transportTermination = undefined;
    let terminated = false;

    const processFailure = (error: unknown): void => {
      if (terminated || child !== processChild) {
        return;
      }

      terminated = true;
      void beginTransportTermination(scope.terminate);
      rejectPending(error);
      failActiveOperations(error);
      initialized = false;
      activeThreadId = undefined;
      activeTurnId = undefined;
      requestByTurn.clear();
      fileChangeProposals.clear();
      pendingRequestData = undefined;
      if (child === processChild) {
        child = undefined;
      }
      if (failTransport === processFailure) {
        failTransport = undefined;
      }
    };
    failTransport = processFailure;
    processChild.stdin.once("error", processFailure);
    processChild.stdout.once("error", processFailure);
    processChild.stderr.once("error", processFailure);

    // A bounded decoder, not readline: readline has no line-length limit, so a child that
    // emits a long record with no newline buffers it whole inside the extension host.
    const decoder = createBoundedLineDecoder();
    let linesClosed = false;
    processChild.stdout.on("data", (chunk: Buffer) => {
      if (linesClosed) return;
      let produced: string[];
      try {
        produced = decoder.push(chunk);
      } catch (error) {
        linesClosed = true;
        processFailure(error);
        return;
      }
      for (const line of produced) handleLine(line);
    });
    processChild.stdout.on("end", () => {
      if (linesClosed) return;
      try {
        for (const line of decoder.end()) handleLine(line);
      } catch (error) {
        processFailure(error);
      }
    });

    // Decoded incrementally: a multi-byte character split across two chunks would otherwise
    // reach the log as a replacement character.
    const stderrDecoder = createIncrementalTextDecoder();
    const takeStderr = (value: string): void => {
      const text = value.trim();
      if (text) {
        log(`[codex] ${text}`);
      }
    };
    processChild.stderr.on("data", (chunk: Buffer) => takeStderr(stderrDecoder.push(chunk)));
    processChild.stderr.on("end", () => takeStderr(stderrDecoder.end()));

    const promise = new Promise<void>((resolve, reject) => {
      let startupSettled = false;

      const failStartup = (error: unknown): void => {
        processFailure(error);
        if (!startupSettled) {
          startupSettled = true;
          reject(error);
        }
      };

      processChild.once("spawn", () => {
        void (async () => {
          try {
            const response = await request("initialize", {
              clientInfo: {
                name: "bachata_vscode",
                title: "Bachata for VS Code",
                version: extensionVersion,
              },
              capabilities: {
                experimentalApi: true,
                requestAttestation: false,
                mcpServerOpenaiFormElicitation: true,
              },
            });
            const agent = getString(response.userAgent);
            if (!agent) {
              throw new Error(
                "Codex app-server did not answer initialize with a userAgent; the installed"
                + " command does not speak the app-server protocol Bachata requires",
              );
            }
            serverUserAgent = agent;
            notify("initialized", {});
            initialized = true;
            if (!startupSettled) {
              startupSettled = true;
              resolve();
            }
          } catch (error) {
            failStartup(error);
          }
        })();
      });

      processChild.once("error", failStartup);
      processChild.once("exit", (code, signal) => {
        linesClosed = true;
        const error = new Error(
          `Codex app-server exited with code ${String(code)} and signal ${String(signal)}`,
        );
        processFailure(error);
        if (!startupSettled) {
          startupSettled = true;
          reject(error);
        }
      });
    });

    startPromise = promise;

    try {
      await promise;
    } finally {
      if (startPromise === promise) {
        startPromise = undefined;
      }
    }
  };

  const setThreadName = async (
    threadId: string,
    name: string | undefined,
  ): Promise<void> => {
    const normalized = name?.trim();
    if (!normalized || namedThreads.get(threadId) === normalized) {
      return;
    }
    try {
      await request("thread/name/set", { threadId, name: normalized });
      namedThreads.set(threadId, normalized);
    } catch (error) {
      log(`Could not name Codex thread ${threadId}: ${errorMessage(error)}`);
    }
  };

  const openThread = async (requestData: SendRequest): Promise<string> => {
    // Refuse before spawning. A run Bachata will not allow must not start a provider process.
    assertCodexScopeSupported(requestData.workspacePolicy, workspaceScope);
    await start();

    if (requestData.sessionId) {
      const result = await request("thread/resume", {
        threadId: requestData.sessionId,
        cwd: requestData.workingDirectory,
        approvalPolicy: codexApprovalPolicyWire(requestData.approvalPolicy),
        sandbox: codexSandboxModeWire(requestData.permissionMode, requestData.workspacePolicy),
      });
      const thread = getObject(result.thread);
      const threadId = getString(thread?.id);

      if (!threadId) {
        throw new Error("Codex did not return a thread id while resuming");
      }

      await setThreadName(threadId, requestData.sessionName);
      return threadId;
    }

    const result = await request("thread/start", {
      cwd: requestData.workingDirectory,
      approvalPolicy: codexApprovalPolicyWire(requestData.approvalPolicy),
      sandbox: codexSandboxModeWire(requestData.permissionMode, requestData.workspacePolicy),
      serviceName: "bachata_vscode",
      ...(requestData.model ? { model: requestData.model } : {}),
    });
    const thread = getObject(result.thread);
    const threadId = getString(thread?.id);

    if (!threadId) {
      throw new Error("Codex did not return a thread id");
    }

    await setThreadName(threadId, requestData.sessionName);
    return threadId;
  };

  // The probe thread id cannot name a thread, and the server rejects unparseable parameters
  // before it parses the id, so an accepted payload stops at the id and never starts a turn.
  const probeThreadId = "bachata-capability-probe";
  const probeAccepted = /invalid (?:thread|session) id/iu;

  const capabilityProbes: ReadonlyArray<{ capability: string; method: string; params: JsonObject }> = [
    {
      capability: "read-only sandbox mode",
      method: "thread/resume",
      params: {
        threadId: probeThreadId,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ...(options.workingDirectory === undefined ? {} : { cwd: options.workingDirectory }),
      },
    },
    {
      capability: "workspace-write sandbox mode",
      method: "thread/resume",
      params: {
        threadId: probeThreadId,
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        ...(options.workingDirectory === undefined ? {} : { cwd: options.workingDirectory }),
      },
    },
    {
      capability: "read-only sandbox policy",
      method: "turn/start",
      params: {
        threadId: probeThreadId,
        input: [{ type: "text", text: "capability probe" }],
        approvalPolicy: "on-request",
        sandboxPolicy: codexSandboxPolicyWire("readOnly", undefined, []),
      },
    },
    {
      capability: "workspace-write sandbox policy",
      method: "turn/start",
      params: {
        threadId: probeThreadId,
        input: [{ type: "text", text: "capability probe" }],
        approvalPolicy: "untrusted",
        sandboxPolicy: codexSandboxPolicyWire("workspaceWrite", undefined, []),
      },
    },
  ];

  const probeCapability = async (probe: (typeof capabilityProbes)[number]): Promise<void> => {
    try {
      await request(probe.method, probe.params, options.commandCheckTimeoutMs);
    } catch (error) {
      if (error instanceof ProcessTimeoutError) {
        throw error;
      }
      const message = errorMessage(error);
      if (probeAccepted.test(message)) {
        return;
      }
      throw new Error(
        `Codex app-server rejected Bachata's ${probe.capability} payload: ${message}.`
        + " Bachata will not run Codex against a protocol it cannot serialise exactly.",
      );
    }
    throw new Error(
      `Codex app-server answered Bachata's ${probe.capability} probe instead of refusing an`
      + " unknown thread; the installed command does not behave like the app-server protocol"
      + " Bachata requires.",
    );
  };

  // Readiness is not a run. The handshake always leaves the transport terminated, so checking
  // a provider never leaves a provider process behind.
  const handshake = async (): Promise<string> => {
    try {
      await start();
      for (const probe of capabilityProbes) {
        await probeCapability(probe);
      }
    } finally {
      initialized = false;
      await terminateTransport();
    }
    const agent = serverUserAgent ?? "";
    return `codex app-server ${/^[^/\s]+\/(\S+)/u.exec(agent)?.[1] ?? agent}`;
  };

  const send = (
    requestData: SendRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> => {
    const queue = createAsyncQueue<AgentEvent>();

    const execute = async (): Promise<void> => {
      if (activeOperations.size > 0) {
        queue.fail(new Error("Codex is already running"));
        return;
      }

      if (signal.aborted) {
        queue.push({ type: "status", value: "interrupted" });
        queue.push({ type: "complete", status: "interrupted", answer: "" });
        queue.end();
        return;
      }

      let answer = "";
      let finalAnswer = "";
      let threadId: string | undefined;
      let turnId: string | undefined;
      let lastTurnError: string | undefined;
      let settled = false;
      let settlementStarted = false;
      let abortRequested = false;
      let interruptRequested = false;
      let interruptSettling = false;
      let timeoutError: ProcessTimeoutError | undefined;
      let turnTimer: NodeJS.Timeout | undefined;
      let gitBaseline: GitHeadSnapshot | undefined;
      let workspaceAuditBaseline: WorkspacePolicyAuditSnapshot | undefined;
      let completionValidationStarted = false;
      let interruptTimer: NodeJS.Timeout | undefined;
      let emittedProviderActivity = false;
      const providerResourceId = options.resourceId ?? `codex-cli:${options.id ?? "default"}`;
      const providerSideEffects = (): "none" | "possible" =>
        emittedProviderActivity || (turnId !== undefined && turnsWithProviderActivity.has(turnId))
          ? "possible"
          : "none";

      const cleanup = (): void => {
        if (turnTimer) {
          clearTimeout(turnTimer);
        }
        if (interruptTimer) {
          clearTimeout(interruptTimer);
        }
        signal.removeEventListener("abort", abortHandler);
        listeners.delete(listener);
        fileChangeProposals.clear();
        activeOperations.delete(operation);
        if (activeTurnId === turnId) {
          activeTurnId = undefined;
        }
        if (turnId) {
          turnsWithProviderActivity.delete(turnId);
          requestByTurn.delete(turnId);
        }
        if (pendingRequestData === requestData) pendingRequestData = undefined;
      };

      const validateNoCommit = async (): Promise<void> => {
        if (transportTermination) await transportTermination;
        if (requestData.workspacePolicy?.commitMode === "never") {
          await assertGitHeadUnchanged(requestData.workingDirectory, gitBaseline);
        }
        if (workspaceAuditBaseline) {
          await assertWorkspacePolicyAudit(requestData, workspaceAuditBaseline);
        }
      };

      const failNow = (error: unknown): void => {
        const failure = providerFailureErrorIfRecognized(
          error,
          "codex-app-server",
          providerResourceId,
          providerSideEffects(),
        );
        settled = true;
        cleanup();
        queue.fail(failure);
      };

      const finish = (
        status: "completed" | "interrupted",
        completedAnswer: string,
      ): void => {
        if (settled || settlementStarted) return;
        settlementStarted = true;
        void validateNoCommit().then(
          () => {
            if (settled) return;
            settled = true;
            cleanup();
            queue.push({ type: "status", value: status });
            queue.push({ type: "complete", status, answer: completedAnswer });
            queue.end();
          },
          (error) => {
            if (!settled) failNow(error);
          },
        );
      };

      const fail = (error: unknown): void => {
        if (settled || settlementStarted || interruptSettling) return;
        settlementStarted = true;
        void validateNoCommit().then(
          () => {
            if (!settled) failNow(error);
          },
          (guardError) => {
            if (!settled) failNow(guardError);
          },
        );
      };

      // EX-G6-06. The turn is over when the process tree it started is gone, not when the request
      // to end it was sent, and not when the provider says it stopped. Settling on either of
      // those releases the provider resource — and reports the turn interrupted — while that tree
      // may still be running. Both the grace timer and the provider's own interrupted turn
      // notification settle here, so neither can answer ahead of the confirmation.
      const settleInterrupted = async (): Promise<void> => {
        // Ending the process tree ends the transport, and the transport's own exit would
        // otherwise reach this turn as a provider failure. The interruption owns the outcome
        // while it is confirming, and answers with it afterwards.
        interruptSettling = true;
        let terminated: boolean;
        try {
          terminated = await terminateTransport();
        } finally {
          interruptSettling = false;
        }
        if (timeoutError) {
          fail(terminated
            ? timeoutError
            : new Error(`${timeoutError.message} and its process tree did not terminate`));
          return;
        }
        if (!terminated) {
          fail(new Error("Codex process tree did not terminate after interruption"));
          return;
        }
        finish("interrupted", finalAnswer || answer);
      };

      const requestInterrupt = (): void => {
        if (!threadId || !turnId || settled || interruptRequested) {
          return;
        }
        interruptRequested = true;

        void request("turn/interrupt", { threadId, turnId }).catch((error) => {
          log(`Codex interrupt failed: ${errorMessage(error)}`);
        });

        if (!interruptTimer) {
          interruptTimer = setTimeout(() => {
            void settleInterrupted();
          }, options.interruptGraceMs);
        }
      };

      const abortHandler = (): void => {
        abortRequested = true;
        requestInterrupt();
      };

      const listener: NotificationListener = (message) => {
        const method = getString(message.method);
        const messageThreadId = getNotificationThreadId(message);
        const messageTurnId = getNotificationTurnId(message);

        if (messageThreadId && threadId && messageThreadId !== threadId) {
          return;
        }

        if (messageTurnId && turnId && messageTurnId !== turnId) {
          return;
        }

        if (!turnId && messageTurnId) {
          turnId = messageTurnId;
          activeTurnId = messageTurnId;
          if (abortRequested || signal.aborted) {
            requestInterrupt();
          }
        }

        if (method === "item/started") {
          const item = getObject(getObject(message.params)?.item);
          const itemId = getString(item?.id);
          if (item?.type === "fileChange" && itemId && messageThreadId === threadId && messageTurnId === turnId
            && threadId && turnId) {
            emittedProviderActivity = true;
            const paths = item.status === "inProgress" ? codexFileChangePaths(item.changes) : undefined;
            fileChangeProposals.delete(itemId);
            if (paths && fileChangeProposals.size < 256) fileChangeProposals.set(itemId, { threadId, turnId, paths });
          }
          return;
        }

        if (method === "item/agentMessage/delta") {
          emittedProviderActivity = true;
          const delta = getDelta(message);
          if (delta) {
            answer += delta;
            queue.push({ type: "text", text: delta });
          }
          return;
        }

        if (method === "item/completed") {
          emittedProviderActivity = true;
          const params = getObject(message.params);
          const item = getObject(params?.item);
          if (getString(item?.type) === "fileChange") fileChangeProposals.delete(getString(item?.id) ?? "");
          if (getString(item?.type) === "agentMessage") {
            finalAnswer = getAgentMessageText(item ?? {}) ?? finalAnswer;
          }
          return;
        }

        if (method === "error") {
          const params = getObject(message.params);
          const error = getObject(params?.error) ?? getObject(message.error);
          lastTurnError = getString(error?.message) ?? lastTurnError;
          return;
        }

        if (method !== "turn/completed" || completionValidationStarted) {
          return;
        }
        completionValidationStarted = true;
        fileChangeProposals.clear();

        const params = getObject(message.params);
        const turn = getObject(params?.turn);
        const status = getString(turn?.status) ?? "completed";
        const error = getObject(turn?.error);

        void (async (): Promise<void> => {
          if (timeoutError) {
            fail(timeoutError);
            return;
          }
          if (status === "failed") {
            fail(
              new Error(
                getString(error?.message) ??
                  lastTurnError ??
                  "Codex turn failed",
              ),
            );
            return;
          }
          if (status === "interrupted" || status === "cancelled") {
            if (interruptRequested || abortRequested) {
              await settleInterrupted();
              return;
            }
            finish("interrupted", finalAnswer || answer);
            return;
          }
          finish("completed", finalAnswer || answer);
        })().catch(fail);
      };

      const operation: ActiveOperation = { fail };
      activeOperations.add(operation);
      signal.addEventListener("abort", abortHandler, { once: true });

      try {
        queue.push({ type: "status", value: "starting" });
        pendingRequestData = requestData;
        threadId = await openThread(requestData);
        if (settled) {
          return;
        }

        activeThreadId = threadId;
        queue.push({ type: "session", sessionId: threadId });

        if (abortRequested || signal.aborted) {
          finish("interrupted", "");
          return;
        }

        if (requestData.workspacePolicy?.commitMode === "never") {
          gitBaseline = await captureGitHeadSnapshot(requestData.workingDirectory);
        }
        if (requestData.workspacePolicy) {
          workspaceAuditBaseline = await captureWorkspacePolicyAudit(requestData, signal);
        }
        listeners.add(listener);
        const input: JsonObject[] = [
          { type: "text", text: requestData.prompt },
          ...await Promise.all(requestData.attachments.map(async (attachmentPath) =>
            textAttachmentExtensions.has(path.extname(attachmentPath).toLowerCase())
              ? {
                  type: "text",
                  text: `Attached file ${path.basename(attachmentPath)}:\n${await readFile(attachmentPath, "utf8")}`,
                }
              : { type: "localImage", path: attachmentPath })),
        ];
        const result = await request("turn/start", {
          threadId,
          input,
          cwd: requestData.workingDirectory,
          approvalPolicy: codexApprovalPolicyWire(requestData.approvalPolicy),
          sandboxPolicy: await sandboxPolicy(
            requestData.permissionMode,
            requestData.workingDirectory,
            requestData.workspacePolicy,
            workspaceScope,
          ),
          ...(requestData.model ? { model: requestData.model } : {}),
        });

        if (settled) {
          return;
        }

        const turn = getObject(result.turn);
        turnId = getString(turn?.id) ?? turnId;

        if (!turnId) {
          throw new Error("Codex did not return a turn id");
        }

        activeTurnId = turnId;
        requestByTurn.set(turnId, requestData);
        pendingRequestData = undefined;
        queue.push({ type: "status", value: "running" });
        turnTimer = setTimeout(() => {
          timeoutError = new ProcessTimeoutError(
            `Codex turn timed out after ${String(options.turnTimeoutMs)} ms`,
          );
          requestInterrupt();
        }, options.turnTimeoutMs);

        if (abortRequested || signal.aborted) {
          requestInterrupt();
        }
      } catch (error) {
        fail(error);
      }
    };

    void execute();
    return queue.iterable;
  };

  return {
    id: options.id ?? "codex",
    adapterType: "codex-app-server",
    capabilities: { streaming: true, resume: true, interrupt: true, attachments: true, repositoryTools: true, browserSessionSelection: false, passiveActionLoop: false },
    checkAvailability: () => handshake(),
    send,
    interrupt: async () => {
      if (!activeThreadId || !activeTurnId) {
        return;
      }

      await request("turn/interrupt", {
        threadId: activeThreadId,
        turnId: activeTurnId,
      });
    },
    resetSession: async () => {
      if (activeTurnId) {
        throw new Error("Cannot reset Codex while a turn is running");
      }

      activeThreadId = undefined;
    },
    dispose: async () => {
      disposed = true;
      const error = new Error("Codex adapter disposed");
      const processChild = child;
      if (processChild) void beginTransportTermination(currentTerminate());
      rejectPending(error);
      failActiveOperations(error);
      listeners.clear();
      if (transportTermination) await transportTermination;
      child = undefined;
      failTransport = undefined;
      initialized = false;
      startPromise = undefined;
      activeThreadId = undefined;
      activeTurnId = undefined;
      requestByTurn.clear();
      fileChangeProposals.clear();
      pendingRequestData = undefined;
    },
  };
};

export type CodexProbeOptions = {
  command: string;
  commandCheckTimeoutMs: number;
  requestTimeoutMs: number;
  interruptGraceMs: number;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  log?: (message: string) => void;
};

// The readiness probe is the same handshake a run performs, so a green provider light means the
// installed app-server accepted the exact payloads Bachata serialises.
export const probeCodexAppServer = async (options: CodexProbeOptions): Promise<string> => {
  const adapter = createCodexAppServerAdapter({
    command: options.command,
    commandCheckTimeoutMs: options.commandCheckTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    turnTimeoutMs: options.requestTimeoutMs,
    interruptGraceMs: options.interruptGraceMs,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.workingDirectory === undefined
      ? {}
      : { workingDirectory: options.workingDirectory }),
    requestApproval: async () => "decline",
    log: options.log ?? (() => undefined),
  });
  try {
    return await adapter.checkAvailability();
  } finally {
    await adapter.dispose();
  }
};
