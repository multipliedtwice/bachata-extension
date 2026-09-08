
import { createHash } from "node:crypto";

export type WorkspaceRevisionState = {
  revision: number;
  fileHashes: Readonly<Record<string, string>>;
};

export function hashWorkspaceContent(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createWorkspaceRevisionState(fileHashes?: Readonly<Record<string, string>>): WorkspaceRevisionState {
  return {
    revision: 0,
    fileHashes: { ...(fileHashes ?? {}) },
  };
}

export function advanceWorkspaceRevision(
  state: WorkspaceRevisionState,
  changedFiles: Readonly<Record<string, string>>,
): WorkspaceRevisionState {
  return {
    revision: state.revision + 1,
    fileHashes: {
      ...state.fileHashes,
      ...changedFiles,
    },
  };
}

export function actionFingerprint(action: unknown, workspaceRevision: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, workspaceRevision }))
    .digest("hex");
}

export function validateExpectedHashes(
  current: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): { valid: boolean; stalePaths: string[] } {
  const stalePaths = Object.entries(expected)
    .filter(([path, hash]) => current[path] !== hash)
    .map(([path]) => path)
    .sort();
  return { valid: stalePaths.length === 0, stalePaths };
}
