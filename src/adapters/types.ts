import { BrowserConversationBinding, CapturedResponse } from "../browser/protocol";

export type AgentId = string;

export type CodexApprovalPolicy = "onRequest" | "unlessTrusted";

export type WorkspaceWriteScope = "task" | "configured" | "workspace" | "readOnly";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentApprovalChoice = {
  id: string;
  label: string;
};

export type NetworkApprovalContext = {
  host?: string;
  protocol?: string;
  port?: number;
};

export type AgentApprovalRequest = {
  requestId: string;
  kind: "command" | "fileChange" | "permissions" | "browserAction";
  reason?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  networkApprovalContext?: NetworkApprovalContext | undefined;
  commandActions?: JsonValue | undefined;
  additionalPermissions?: JsonValue | undefined;
  requestedPermissions?: JsonValue | undefined;
  proposedExecpolicyAmendment?: string[] | undefined;
  proposedNetworkPolicyAmendments?: JsonValue[] | undefined;
  browserAction?: JsonValue | undefined;
  choices: AgentApprovalChoice[];
};

export type AgentCompletionStatus = "completed" | "interrupted";

export type AgentRunResult = {
  status: AgentCompletionStatus;
  answer: string;
  managedState?: {
    state: string;
    revisionCycles: number;
    maxRevisionCycles: number;
  };
};

export type AgentCapabilities = {
  streaming: boolean;
  resume: boolean;
  interrupt: boolean;
  attachments: boolean;
  repositoryTools: boolean;
  browserSessionSelection: boolean;
  passiveActionLoop: boolean;
};

export type SendRequest = {
  sessionId?: string | undefined;
  sessionName?: string | undefined;
  browserBinding?: BrowserConversationBinding | undefined;
  prompt: string;
  workingDirectory: string;
  attachments: string[];
  permissionMode?: string | undefined;
  approvalPolicy?: CodexApprovalPolicy | undefined;
  model?: string | undefined;
  workspacePolicy?: {
    readOnly: boolean;
    writeScope?: WorkspaceWriteScope | undefined;
    readPaths?: string[] | undefined;
    allowedPaths?: string[] | undefined;
    restrictedPaths?: string[] | undefined;
    commitMode: "never" | "allow";
    disableShell?: boolean | undefined;
    disableNetwork?: boolean | undefined;
    automated?: boolean | undefined;
  };
};

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "replace"; text: string }
  | { type: "status"; value: string }
  /**
   * BB-A4-N05. Something the person needs told about this turn that does not end it. A failed
   * Stop is the first: the request is still running, so reporting it as a completion or an error
   * would take the answer that is still coming with it.
   */
  | { type: "notice"; message: string }
  | { type: "captured"; response: CapturedResponse }
  | { type: "error"; message: string }
  | {
      type: "complete";
      answer: string;
      status: AgentCompletionStatus;
    };

export type AgentAdapter = {
  id: AgentId;
  adapterType: string;
  capabilities: AgentCapabilities;
  checkAvailability: (
    sessionId?: string,
    browserBinding?: BrowserConversationBinding,
  ) => Promise<string>;
  send: (
    request: SendRequest,
    signal: AbortSignal,
  ) => AsyncIterable<AgentEvent>;
  interrupt: (sessionId?: string) => Promise<void>;
  resetSession?: () => Promise<void>;
  dispose: () => Promise<void>;
};
