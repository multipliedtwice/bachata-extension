import { OrchestrationLedger, OrchestrationTaskState } from "./types";
import { repositoryPathComparisonKey } from "./todoParser";

const activeStatuses = new Set(["running", "waitingForResources", "verifying", "integrating"]);

const normalizedPath = (value: string): string => repositoryPathComparisonKey(value);

const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

export const taskPathsConflict = (
  left: OrchestrationTaskState,
  right: OrchestrationTaskState,
): boolean => {
  const leftPaths = left.spec.paths.map(normalizedPath).filter(Boolean);
  const rightPaths = right.spec.paths.map(normalizedPath).filter(Boolean);
  if (leftPaths.length === 0 || rightPaths.length === 0) {
    return true;
  }
  return leftPaths.some((leftPath) => rightPaths.some((rightPath) => overlaps(leftPath, rightPath)));
};

const dependencyState = (
  ledger: OrchestrationLedger,
  task: OrchestrationTaskState,
): "ready" | "waiting" | "blocked" => {
  const dependencies = task.spec.dependsOn.map((id) => ledger.tasks[id]);
  const resolved = dependencies.filter(
    (dependency): dependency is OrchestrationTaskState => dependency !== undefined,
  );
  if (resolved.length !== dependencies.length) {
    return "blocked";
  }
  if (resolved.some((dependency) => ["blocked", "failed", "cancelled"].includes(dependency.status))) {
    return "blocked";
  }
  return resolved.every((dependency) => dependency.status === "done") ? "ready" : "waiting";
};

export const refreshTaskReadiness = (ledger: OrchestrationLedger): void => {
  Object.values(ledger.tasks).forEach((task) => {
    if (!["pending", "ready"].includes(task.status)) {
      return;
    }
    const dependency = dependencyState(ledger, task);
    if (dependency === "blocked") {
      task.status = "blocked";
      task.lastError = "A dependency did not complete successfully";
    } else {
      task.status = dependency === "ready" ? "ready" : "pending";
    }
  });
};

export const selectRunnableTasks = (ledger: OrchestrationLedger): OrchestrationTaskState[] => {
  refreshTaskReadiness(ledger);
  const running = Object.values(ledger.tasks).filter((task) => activeStatuses.has(task.status));
  const capacity = Math.max(0, ledger.maxConcurrency - running.length);
  if (capacity === 0) {
    return [];
  }
  const selected: OrchestrationTaskState[] = [];
  const candidates = Object.values(ledger.tasks)
    .filter((task) => task.status === "ready")
    .sort((left, right) =>
      right.spec.priority - left.spec.priority ||
      left.spec.line - right.spec.line ||
      left.spec.id.localeCompare(right.spec.id),
    );
  for (const candidate of candidates) {
    if (
      running.some((task) => taskPathsConflict(candidate, task)) ||
      selected.some((task) => taskPathsConflict(candidate, task))
    ) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= capacity) {
      break;
    }
  }
  return selected;
};

export const terminalLedgerStatus = (
  ledger: OrchestrationLedger,
): "completed" | "blocked" | "failed" | undefined => {
  const tasks = Object.values(ledger.tasks);
  if (tasks.some((task) => ["pending", "ready", "running", "waitingForResources", "verifying", "integrating"].includes(task.status))) {
    return undefined;
  }
  if (tasks.some((task) => task.status === "failed")) {
    return "failed";
  }
  if (tasks.some((task) => ["blocked", "cancelled"].includes(task.status))) {
    return "blocked";
  }
  return "completed";
};
