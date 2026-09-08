import { buildExecutionContract } from "../contract/executionContract";
import { repositoryPolicyRefusals } from "../policy/repositoryPolicy";
import type { PipelineDefinition } from "../pipeline/types";
import type { RepositoryPolicy } from "../policy/repositoryPolicy";

export type PolicyTemplate = {
  id: string;
  name: string;
  detail: string;
  policy: (verifierCommands: string[]) => RepositoryPolicy;
};

const CONTROLLER_VERIFIERS = ["bachata:workspace-integrity", "bachata:project-checks"];

export const policyTemplates: PolicyTemplate[] = [
  {
    id: "read-only",
    name: "Read-only repository",
    detail: "Only review and planning pipelines are approved. No pipeline may write.",
    policy: () => ({
      version: 1,
      approvedPipelineIds: [
        "codex-review",
        "claude-review",
        "review-only",
        "codex-plan",
        "claude-plan",
        "plan",
        "cross-reference-development",
      ],
      maxWriteScope: "readOnly",
      commitMode: "never",
    }),
  },
  {
    id: "verified-changes",
    name: "Verified changes only",
    detail: "A pipeline may write inside a declared scope, never commit, and only through verification this repository allows.",
    policy: (verifierCommands) => ({
      version: 1,
      maxWriteScope: "configured",
      commitMode: "never",
      allowedVerifiers: [...CONTROLLER_VERIFIERS, ...verifierCommands],
    }),
  },
  {
    id: "isolated-changes",
    name: "Isolated changes only",
    detail: "Only workflows that keep their work in an isolated worktree may write, and you apply the result yourself.",
    policy: (verifierCommands) => ({
      version: 1,
      approvedPipelineIds: ["paired-managed-fix", "todo-master", "todo-implementation"],
      maxWriteScope: "task",
      commitMode: "never",
      allowedVerifiers: [...CONTROLLER_VERIFIERS, ...verifierCommands],
    }),
  },
];

export type PolicyTemplateRefusal = {
  pipelineId: string;
  reasons: string[];
};

export const policyTemplateRefusals = (
  policy: RepositoryPolicy,
  pipelines: PipelineDefinition[],
): PolicyTemplateRefusal[] => {
  const approved = policy.approvedPipelineIds;
  return pipelines
    .filter((pipeline) => approved === undefined || approved.includes(pipeline.id))
    .flatMap((pipeline) => {
      const contract = buildExecutionContract({ pipeline, maxIterations: 10 });
      const reasons = repositoryPolicyRefusals(policy, {
        pipelineId: pipeline.id,
        writeScope: contract.scope.writeScope,
        commitPolicy: contract.commitPolicy,
        verification: contract.verification,
        protectedPaths: contract.scope.protectedPaths,
        humanGateCount: contract.humanGates.length,
      });
      return reasons.length > 0 ? [{ pipelineId: pipeline.id, reasons }] : [];
    });
};

export const policyDocument = (policy: RepositoryPolicy): string =>
  `${JSON.stringify(policy, undefined, 2)}\n`;
