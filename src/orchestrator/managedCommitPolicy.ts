export type ManagedCommitMode = "never" | "allow";

export const managedCommitMode = (_requested: ManagedCommitMode = "never"): ManagedCommitMode => "never";

export const shouldCreateManagedCommit = (_requested: ManagedCommitMode = "never"): boolean => false;

export const shouldPreserveIncompleteWorkspace = (): boolean => true;
