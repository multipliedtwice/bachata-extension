import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ManagedCommitMode = "never" | "allow";

export const managedCommitMode = (_requested: ManagedCommitMode = "never"): ManagedCommitMode => "never";

export const shouldCreateManagedCommit = (_requested: ManagedCommitMode = "never"): boolean => false;

export const readHeadCommit = async (cwd: string): Promise<string> => {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout.trim();
};

export const shouldPreserveIncompleteWorkspace = (): boolean => true;
