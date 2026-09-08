import { CodexApprovalPolicy, SendRequest } from "./types";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexAskForApproval = "untrusted" | "on-request" | "never";

export type CodexSandboxPolicy =
  | { type: "readOnly"; networkAccess: boolean }
  | {
      type: "workspaceWrite";
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

export type CodexWorkspaceScope = "refuseNarrowedScope" | "wholeWorkingDirectory";

export type CodexWorkspacePolicy = SendRequest["workspacePolicy"];

export const codexSandboxModes: readonly CodexSandboxMode[] = [
  "read-only",
  "workspace-write",
  "danger-full-access",
];

export const codexApprovalPolicies: readonly CodexAskForApproval[] = [
  "untrusted",
  "on-request",
  "never",
];

export const codexSandboxPolicyFields: Readonly<Record<CodexSandboxPolicy["type"], readonly string[]>> = {
  readOnly: ["networkAccess", "type"],
  workspaceWrite: [
    "excludeSlashTmp",
    "excludeTmpdirEnvVar",
    "networkAccess",
    "type",
    "writableRoots",
  ],
};

export const codexWorkspaceScopes: readonly CodexWorkspaceScope[] = [
  "refuseNarrowedScope",
  "wholeWorkingDirectory",
];

export class CodexScopeError extends Error {
  readonly code = "CODEX_SCOPE_UNSUPPORTED";

  readonly reason: "declaredReadPaths" | "restrictedPaths" | "unacknowledgedExclusions";

  constructor(reason: CodexScopeError["reason"], message: string) {
    super(message);
    this.name = "CodexScopeError";
    this.reason = reason;
  }
}

export const isCodexScopeError = (value: unknown): value is CodexScopeError =>
  value instanceof CodexScopeError;

export const codexApprovalPolicyWire = (
  policy: CodexApprovalPolicy | undefined,
): CodexAskForApproval => (policy === "unlessTrusted" ? "untrusted" : "on-request");

export const codexWritesWorkspace = (
  permissionMode: string | undefined,
  workspacePolicy: CodexWorkspacePolicy,
): boolean => permissionMode === "workspaceWrite" && workspacePolicy?.readOnly !== true;

export const codexSandboxModeWire = (
  permissionMode: string | undefined,
  workspacePolicy: CodexWorkspacePolicy,
): CodexSandboxMode =>
  codexWritesWorkspace(permissionMode, workspacePolicy) ? "workspace-write" : "read-only";

const protocolLimitation =
  "Codex CLI 0.146.0 has no per-path readable-root capability: its sandbox policy carries no"
  + " readable-root field, and the only selectable permission profiles are :read-only, :workspace"
  + " and :danger-full-access. A Codex turn therefore reads the whole working directory.";

const scopeRemedy =
  "Run this work on a provider that honours narrowed reads, or set bachata.codexWorkspaceScope to"
  + " wholeWorkingDirectory to record that Codex may read the entire working directory,"
  + " including the paths Bachata withholds from other providers.";

// A turn with no workspace policy already grants Codex the whole working directory, so it
// promises nothing Codex cannot keep. Every policy-bearing turn withholds at least the
// version-control, credential and bachata-internal paths, which Codex cannot be told to withhold.
export const codexScopeRefusal = (
  workspacePolicy: CodexWorkspacePolicy,
  workspaceScope: CodexWorkspaceScope,
): CodexScopeError | undefined => {
  if (!workspacePolicy) {
    return undefined;
  }
  if (workspacePolicy?.readPaths?.length) {
    return new CodexScopeError(
      "declaredReadPaths",
      `${protocolLimitation} This run declares explicit read paths (${workspacePolicy.readPaths.join(", ")}),`
      + " so Codex cannot keep the read scope this run asks for."
      + " Remove the declared read paths or run this work on another provider.",
    );
  }
  if (workspacePolicy?.restrictedPaths?.length) {
    return new CodexScopeError(
      "restrictedPaths",
      `${protocolLimitation} This run withholds explicit paths (${workspacePolicy.restrictedPaths.join(", ")}),`
      + " so Codex cannot keep the confidentiality promise this run makes."
      + " Remove the restricted paths or run this work on another provider.",
    );
  }
  if (workspaceScope !== "wholeWorkingDirectory") {
    return new CodexScopeError(
      "unacknowledgedExclusions",
      `${protocolLimitation} Bachata withholds version-control, credential and bachata-internal paths`
      + ` from every other provider, and Codex cannot be told to withhold them. ${scopeRemedy}`,
    );
  }
  return undefined;
};

export const assertCodexScopeSupported = (
  workspacePolicy: CodexWorkspacePolicy,
  workspaceScope: CodexWorkspaceScope,
): void => {
  const refusal = codexScopeRefusal(workspacePolicy, workspaceScope);
  if (refusal) {
    throw refusal;
  }
};

export const codexSandboxPolicyWire = (
  permissionMode: string | undefined,
  workspacePolicy: CodexWorkspacePolicy,
  writableRoots: readonly string[],
): CodexSandboxPolicy =>
  codexWritesWorkspace(permissionMode, workspacePolicy)
    ? {
        type: "workspaceWrite",
        writableRoots: [...writableRoots],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : { type: "readOnly", networkAccess: false };
