import type { ProductDoctorFinding } from "./doctorReport";

export type ReadOnlyDoctorInput = {
  ownershipReason: string;
  retryCommand: string;
  catalogPresent: boolean;
  catalogPath: string;
  runCount: number;
  initiativeTitle?: string;
  retainedRuns: number;
  retainedWorktrees: readonly string[];
  pipelineCount: number;
};

/**
 * What Doctor can state in a window that does not own the workspace.
 *
 * It reports only what reading proves: whether the catalog the writer persisted is readable,
 * how much of the product it holds, and what work is still retained. It probes no provider
 * and starts no runtime, because a read-only window may run neither.
 */
export const readOnlyDoctorReport = (
  input: ReadOnlyDoctorInput,
): ProductDoctorFinding[] => [
  {
    name: "Workspace ownership",
    ok: false,
    blocking: true,
    detail: `${input.ownershipReason} Run ${input.retryCommand} to take ownership.`,
  },
  {
    name: "Run catalog",
    ok: input.catalogPresent,
    blocking: false,
    detail: input.catalogPresent
      ? `Readable: ${String(input.runCount)} run${input.runCount === 1 ? "" : "s"} at ${input.catalogPath}`
      : `No catalog has been written yet at ${input.catalogPath}`,
  },
  {
    name: "Direction",
    ok: input.initiativeTitle !== undefined,
    blocking: false,
    detail: input.initiativeTitle === undefined
      ? "No initiative has been recorded for this repository"
      : `Initiative: ${input.initiativeTitle}`,
  },
  {
    name: "Retained work",
    ok: input.retainedRuns === 0,
    blocking: false,
    detail: input.retainedRuns === 0
      ? "No orchestration run is holding a Git worktree"
      : `${String(input.retainedRuns)} retained run${input.retainedRuns === 1 ? "" : "s"} still hold ${
        input.retainedWorktrees.length === 0 ? "a worktree" : input.retainedWorktrees.join(", ")
      }. Only the owning window can clean them up.`,
  },
  {
    name: "Pipelines",
    ok: input.pipelineCount > 0,
    blocking: false,
    detail: input.pipelineCount > 0
      ? `${String(input.pipelineCount)} pipeline${input.pipelineCount === 1 ? "" : "s"} can be explained without running them`
      : "No pipeline definition could be read",
  },
];
