import type {
  ExecutionAssurance,
  ExecutionContract,
  ExecutionSafetyLevel,
} from "../contract/executionContract";


export type GuardrailSummary = {
  pipelineId: string;
  pipelineName: string;
  safetyLevel: ExecutionSafetyLevel;
  assurance: ExecutionAssurance;
  assuranceLabel: string;
  assuranceStatement: string;
  writeAuthority: string;
  writablePaths: string[];
  readablePaths: string[];
  protectedPaths: string[];
  checks: string[];
  commitPolicy: "never" | "allow";
  providers: string[];
  humanDecisions: string[];
  advancedOnly: string[];
};

const authorityText: Record<ExecutionSafetyLevel, string> = {
  review: "Read-only. Nothing in your repository is written.",
  interactive: "Writes happen through provider actions you approve one at a time.",
  managed: "The controller owns the write scope, the path policy, and the verification.",
  orchestration: "Unattended execution in isolated Git worktrees behind a strict preflight.",
};

export const guardrailSummary = (contract: ExecutionContract): GuardrailSummary => {
  const advancedOnly = [
    ...(contract.roles.length > 0
      ? ["Per-role authority, candidates, and prompt instructions"]
      : []),
    ...(contract.scope.writablePaths.length > 0 || contract.scope.readablePaths.length > 0
      ? ["Writable and readable path lists beyond the working root"]
      : ["Writable and readable path lists"]),
    "Consensus, typed outputs, human gate placement, and capability requirements",
    "Per-provider permission modes and approval policies",
  ];
  return {
    pipelineId: contract.pipelineId,
    pipelineName: contract.pipelineName,
    safetyLevel: contract.safetyLevel,
    assurance: contract.assurance,
    assuranceLabel: contract.assuranceLabel,
    assuranceStatement: contract.assuranceStatement,
    writeAuthority: authorityText[contract.safetyLevel],
    writablePaths: contract.scope.writablePaths,
    readablePaths: contract.scope.readablePaths,
    protectedPaths: contract.scope.protectedPaths,
    checks: contract.verification,
    commitPolicy: contract.commitPolicy,
    providers: contract.providers.map((provider) =>
      provider.model
        ? `${provider.name} (${provider.adapterLabel} · ${provider.model})`
        : `${provider.name} (${provider.adapterLabel})`,
    ),
    humanDecisions: contract.humanGates.map((gate) => `${gate.stepName} · ${gate.gate}`),
    advancedOnly,
  };
};

export const guardrailStatements = (
  summary: GuardrailSummary,
  input: {
    workingDirectory?: string;
    iterations: number;
    iterationMode: "fixed" | "untilClean";
    requiredCleanPasses?: number;
  },
): string[] => [
  `Goal: ${summary.pipelineName}`,
  `Assurance: ${summary.assuranceLabel}. ${summary.assuranceStatement}`,
  `Providers: ${summary.providers.join(", ") || "none declared"}`,
  `Working root: ${input.workingDirectory ?? "not selected"}`,
  `Write authority: ${summary.writeAuthority}`,
  ...(summary.writablePaths.length > 0
    ? [`Writable paths: ${summary.writablePaths.join(", ")}`]
    : []),
  ...(summary.readablePaths.length > 0
    ? [`Readable paths: ${summary.readablePaths.join(", ")}`]
    : []),
  ...(summary.protectedPaths.length > 0
    ? [`Protected paths: ${summary.protectedPaths.join(", ")}`]
    : []),
  `Checks: ${summary.checks.join(", ") || "none declared"}`,
  `Commits: ${summary.commitPolicy === "allow" ? "the controller may create commits" : "no commits are created"}`,
  `Completion: ${input.iterationMode === "untilClean"
    ? `until ${String(input.requiredCleanPasses ?? 2)} consecutive iterations change nothing, at most ${String(input.iterations)}`
    : input.iterations === 1
      ? "one pass"
      : `${String(input.iterations)} iterations`}`,
  `Human decisions: ${summary.humanDecisions.join("; ") || "none while the run is healthy"}`,
];
