export type PermissionMode = "readOnly" | "workspaceWrite";
export type ApprovalPolicy = "onRequest" | "unlessTrusted";

export type WorkspacePolicy = {
  readOnly: boolean;
  writableRoots: string[];
  readableRoots: string[];
};

export const sandboxName = (mode: PermissionMode, policy: WorkspacePolicy): string =>
  mode === "workspaceWrite" && !policy.readOnly ? "workspaceWrite" : "readOnly";

export const threadStartParams = (
  workingDirectory: string,
  mode: PermissionMode,
  approvalPolicy: ApprovalPolicy,
  policy: WorkspacePolicy,
): Record<string, unknown> => ({
  cwd: workingDirectory,
  approvalPolicy,
  sandbox: sandboxName(mode, policy),
  serviceName: "fixture",
});

export const sandboxPolicy = (
  mode: PermissionMode,
  policy: WorkspacePolicy,
): Record<string, unknown> => {
  const access = {
    type: "restricted",
    includePlatformDefaults: true,
    readableRoots: policy.readableRoots,
  };
  if (mode === "workspaceWrite" && !policy.readOnly) {
    return {
      type: "workspaceWrite",
      writableRoots: policy.writableRoots,
      readOnlyAccess: access,
      networkAccess: false,
    };
  }
  return { type: "readOnly", access };
};

export const turnStartParams = (
  threadId: string,
  prompt: string,
  mode: PermissionMode,
  approvalPolicy: ApprovalPolicy,
  policy: WorkspacePolicy,
): Record<string, unknown> => ({
  threadId,
  input: [{ type: "text", text: prompt }],
  approvalPolicy,
  sandboxPolicy: sandboxPolicy(mode, policy),
});

export const providerIsReady = async (
  runVersionCommand: (args: string[]) => Promise<string>,
): Promise<boolean> => {
  const version = await runVersionCommand(["--version"]);
  return version.trim().length > 0;
};
