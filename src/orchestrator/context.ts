import { OrchestrationLedger, OrchestrationTaskState } from "./types";

export const dependencySummary = (
  ledger: OrchestrationLedger,
  task: OrchestrationTaskState,
): string => {
  if (task.spec.dependsOn.length === 0) {
    return "None";
  }
  return task.spec.dependsOn
    .map((id) => {
      const dependency = ledger.tasks[id];
      const summary = dependency?.result?.summary ?? dependency?.status ?? "unknown";
      return `- ${id}: ${summary}`;
    })
    .join("\n");
};

export const buildTaskPrompt = (
  ledger: OrchestrationLedger,
  task: OrchestrationTaskState,
  verificationFailure?: string,
): string => [
  ledger.sourceKind === "generatedChecklist"
    ? "# Bachata deterministic selected task"
    : "# Bachata deterministic TODO task",
  "",
  `Task ID: ${task.spec.id}`,
  `Title: ${task.spec.title}`,
  `Working directory: ${task.worktreePath ?? ""}`,
  `Integration branch: ${ledger.integrationBranch}`,
  `Attempt: ${String(task.attempts)}`,
  "",
  "## Task",
  task.spec.description || task.spec.title,
  ledger.userNote ? `\n## User instructions\n${ledger.userNote}` : "",
  "",
  "## Allowed scope",
  task.spec.paths.length > 0 ? task.spec.paths.map((value) => `- ${value}`).join("\n") : "The task did not declare paths. Minimize changes to what is strictly necessary.",
  "",
  "## Dependencies already integrated",
  dependencySummary(ledger, task),
  "",
  "## Deterministic acceptance checks",
  task.spec.checks.length > 0 ? task.spec.checks.map((value) => `- ${value}`).join("\n") : "No task-specific commands were declared.",
  "",
  "## Control boundary",
  "Implement only this task. You may inspect files and use read-only analysis commands, but do not run declared acceptance, integration, E2E, database, Docker, browser, or shared-resource checks. Do not create, schedule, reorder, complete, or cancel tasks. Do not modify orchestration state. Do not decide whether this task is accepted. The deterministic controller will run protected checks and perform integration.",
  verificationFailure ? `\n## Previous deterministic verification failure\n${verificationFailure}` : "",
].filter(Boolean).join("\n");

const masterSnapshot = (ledger: OrchestrationLedger): unknown => ({
  runId: ledger.runId,
  sourceKind: ledger.sourceKind,
  status: ledger.status,
  tasks: Object.values(ledger.tasks).map((task) => ({
    id: task.spec.id,
    title: task.spec.title,
    dependencies: task.spec.dependsOn,
    paths: task.spec.paths,
    status: task.status,
    attempts: task.attempts,
    maximumAttempts: task.spec.retries + 1,
    hasPair: Boolean(task.conversationId),
    resultStatus: task.result?.status,
    pipelineStatus: task.result?.pipelineStatus,
    checks: task.result?.checks.map((check) => check.status) ?? [],
    completedAt: task.completedAt,
    lastError: task.lastError,
  })),
});

export const buildMasterPrompt = (
  ledger: OrchestrationLedger,
  phase: "schedule" | "terminal",
): string => [
  "# Bachata TODO execution watchdog",
  "",
  `Phase: ${phase}`,
  "",
  "Check execution flow only.",
  "Do not inspect code, file contents, implementation quality, style, or valid choices inside task scope.",
  "Do not request implementation changes.",
  "A ready task is waiting for the next scheduler pass. That is not a skipped task.",
  "Return JSON only:",
  '{"status":"continue|deviation","deviations":[{"taskId":"TASK-ID","kind":"skippedTask|wrongTask|missingCompletion|stalledTask|retryPolicy|todoState","details":"short fact"}]}',
  "Use status=continue and an empty deviations array when controller state is consistent.",
  "",
  "## Controller snapshot",
  JSON.stringify(masterSnapshot(ledger)),
].join("\n");
