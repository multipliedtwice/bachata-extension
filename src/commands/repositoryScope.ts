import * as vscode from "vscode";

/**
 * EX-G6-08. One repository answer for the whole window.
 *
 * Improve resolves the repository it would execute in from the active editor, falling back to the
 * only workspace folder and refusing when a multi-root window leaves the choice open. Every
 * command that describes a repository — doctor, setup, evidence, verifier state — has to answer
 * the same question the same way, or it describes one repository while Improve would run in
 * another.
 */
export type RepositoryScope =
  | { root: string; ambiguous: false; empty: false }
  | { root: undefined; ambiguous: boolean; empty: boolean };

export const resolveRepositoryScope = (): RepositoryScope => {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri
    ? vscode.workspace.getWorkspaceFolder(activeUri)
    : undefined;
  if (activeFolder) {
    return { root: activeFolder.uri.fsPath, ambiguous: false, empty: false };
  }
  const [firstFolder] = folders;
  if (folders.length === 1 && firstFolder) {
    return { root: firstFolder.uri.fsPath, ambiguous: false, empty: false };
  }
  return {
    root: undefined,
    ambiguous: Boolean(firstFolder),
    empty: !firstFolder,
  };
};

/** The resolved repository, or nothing when no single repository is selected. */
export const resolveRepositoryRoot = (): string | undefined =>
  resolveRepositoryScope().root;
