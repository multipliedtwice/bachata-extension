import type { ExecutionContract } from "./executionContract";
import { humanGateLabels, readinessStatusLabels, writeScopeLabels } from "./executionContract";

const section = (title: string, lines: string[], empty: string): string =>
  `## ${title}\n\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : `_${empty}_`}\n`;

const duration = (milliseconds: number): string => milliseconds < 60_000
  ? `${String(Math.round(milliseconds / 1000))}s`
  : `${String(Math.round(milliseconds / 60_000))} min`;

export const renderContractExplanation = (contract: ExecutionContract): string => {
  const limits = [
    `Iterations: ${String(contract.limits.iterations)} (maximum ${String(contract.limits.maxIterations)}, mode ${contract.limits.iterationMode})`,
    ...(contract.limits.agentTurnTimeoutMs === undefined
      ? []
      : [`Provider turn limit: ${duration(contract.limits.agentTurnTimeoutMs)}`]),
    ...(contract.limits.managedTaskTimeoutMs === undefined
      ? []
      : [`Managed task limit: ${duration(contract.limits.managedTaskTimeoutMs)}`]),
    ...(contract.limits.browserOperationTimeoutMs === undefined
      ? []
      : [`Browser operation limit: ${duration(contract.limits.browserOperationTimeoutMs)}`]),
    ...(contract.limits.maxRevisionCycles === undefined
      ? []
      : [`Revision cycles: ${String(contract.limits.maxRevisionCycles)}`]),
    ...(contract.limits.consensusSteps ?? []).map((step) =>
      `Consensus rounds, ${step.stepName}: at most ${String(step.maxRounds)} before a human decision. Retrying after an invalid round grants one more${
        step.roundLimitRetryable
          ? `, and retrying at the round limit grants another ${String(step.maxRounds)}`
          : "; at the round limit this step does not offer a retry"
      }`),
    contract.limits.maxParticipantTurns === undefined
      ? "Participant turns: none; this pipeline runs no provider turn"
      : contract.limits.participantTurnsBounded
        ? `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} for the whole run`
        : `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} without a further human decision${
            contract.limits.consensusSteps.length > 0 ? "; a granted consensus retry raises it" : ""
          }${
            contract.limits.executesChecklist ? "; each checklist task adds one bounded sub-run" : ""
          }`,
    ...(contract.limits.checklistRetries === undefined
      ? []
      : [`Checklist retries per task: ${String(contract.limits.checklistRetries)}`]),
    ...(contract.limits.checklistConcurrency === undefined
      ? []
      : [`Checklist concurrency: ${String(contract.limits.checklistConcurrency)}`]),
  ];
  return [
    `# ${contract.pipelineName}`,
    "",
    `Pipeline id: \`${contract.pipelineId}\`. Safety level: **${contract.safetyLevel}**. Assurance: **${contract.assurance}**.`,
    "",
    contract.assuranceStatement,
    "",
    "This is a dry run. Nothing was started and no run was created.",
    "",
    section("Providers and roles", contract.providers.map((provider) => {
      const roles = provider.roles.length > 0 ? ` · roles ${provider.roles.join(", ")}` : " · no assigned role";
      const model = ` · model ${provider.model ?? "not reported"}`;
      const runtime = ` · runtime ${provider.runtimeVersion ?? "not detected"}`;
      return `${provider.name} · ${provider.adapterLabel}${model}${runtime}${roles} · ${readinessStatusLabels[provider.status]}${provider.detail ? ` (${provider.detail})` : ""}`;
    }), "This pipeline declares no providers."),
    section("Effective role authority", contract.roles.map((role) => [
      `${role.name}${role.managed ? " · managed" : ""}${role.optional ? " · optional" : ""}`,
      role.readOnly ? "read-only" : `writes ${writeScopeLabels[role.writeScope]}`,
      ...(role.writablePaths.length > 0 ? [`writable ${role.writablePaths.join(", ")}`] : []),
      ...(role.readablePaths.length > 0 ? [`readable ${role.readablePaths.join(", ")}`] : []),
      ...(role.protectedPaths.length > 0 ? [`protected ${role.protectedPaths.join(", ")}`] : []),
      role.commitPolicy === "allow" ? "commits allowed" : "no commits",
      ...(role.verification.length > 0 ? [`checks ${role.verification.join(", ")}`] : []),
      ...(role.candidateAgentIds.length > 0 ? [`fallback order ${role.candidateAgentIds.join(" → ")}`] : []),
    ].join(" · ")), "This pipeline declares no roles; every provider runs with the aggregate scope below."),
    section("Aggregate scope", [
      `Working directory: ${contract.scope.workingDirectory ?? "not selected"}`,
      `Write scope: ${writeScopeLabels[contract.scope.writeScope]}`,
      `Writable paths: ${contract.scope.writablePaths.join(", ") || "none declared"}`,
      `Readable paths: ${contract.scope.readablePaths.join(", ") || "none declared"}`,
      `Protected paths: ${contract.scope.protectedPaths.join(", ") || "none declared"}`,
      `Commits: ${contract.commitPolicy === "allow" ? "the controller may create commits" : "no commits are created"}`,
    ], ""),
    section("Verification", contract.verification, "No controller verification runs."),
    section("Human decisions", contract.humanGates.map((gate) => `${gate.stepName} · ${humanGateLabels[gate.gate]}`), "No human gate interrupts this run."),
    section("Fallback", contract.fallbacks, "No provider fallback is declared."),
    section("Run limits", limits, ""),
    section("Completion", contract.completion, ""),
    section("What each provider receives", (contract.outboundContext ?? []).map((manifest) =>
      `${manifest.name} · ${manifest.transport} · ${String(manifest.entries.length)} context entries`),
      "No outbound context was resolved."),
    section("Provenance", [
      `Extension version: ${contract.provenance.extensionVersion}`,
      `Pipeline hash: \`${contract.provenance.pipelineHash}\``,
      ...contract.providers.map((provider) =>
        `${provider.name}: ${provider.model ? `model ${provider.model} (${provider.modelSource})` : "model not reported by the provider"}, ${provider.runtimeVersion ? `runtime ${provider.runtimeVersion} (${provider.runtimeVersionSource})` : "runtime version not detected"}`),
    ], ""),
    section("Repository policy", contract.policyRefusals, "This repository's policy refuses nothing in this pipeline."),
    section("Unresolved before running", contract.blockers, "Nothing blocks this pipeline right now."),
  ].join("\n");
};
