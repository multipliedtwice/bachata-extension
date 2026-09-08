import {
  closestMetadataLabel,
  metadataAliases,
  parseTodoDocument,
  repositoryPathComparisonKey,
  todoCheckboxPattern,
  todoMetadataPattern,
} from "./todoParser";
import { isDeclarableVerificationCommand } from "./verificationPolicy";

export type TodoDiagnosticSeverity = "error" | "warning";

export type TodoQuickFix = {
  title: string;
  line: number;
  text: string;
  mode: "replaceLine" | "insertAfter";
};

export type TodoDiagnostic = {
  line: number;
  column: number;
  length: number;
  severity: TodoDiagnosticSeverity;
  code: string;
  message: string;
  fixes: TodoQuickFix[];
};

export type TodoAnalyzedTask = {
  id: string;
  title: string;
  line: number;
  completed: boolean;
  dependsOn: string[];
  paths: string[];
  checks: string[];
  finalChecks: string[];
  priority: number;
};

export type TodoAnalysis = {
  tasks: TodoAnalyzedTask[];
  diagnostics: TodoDiagnostic[];
  waves: string[][];
  cycles: string[][];
  pathConflicts: Array<{ path: string; taskIds: string[] }>;
};

export type TodoAnalysisOptions = {
  pipelineId: string;
  retries: number;
  requirePaths: boolean;
  requireControllerVerification: boolean;
};

const listValues = (value: string): string[] =>
  value.split(",").map((entry) => entry.trim()).filter(Boolean);

const scopesOverlap = (left: string, right: string): boolean => {
  const a = repositoryPathComparisonKey(left);
  const b = repositoryPathComparisonKey(right);
  if (a === "" || b === "") return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

const findCycles = (tasks: TodoAnalyzedTask[]): string[][] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const stack: string[] = [];
  const visit = (id: string): void => {
    const status = state.get(id);
    if (status === "done") return;
    if (status === "visiting") {
      const start = stack.indexOf(id);
      if (start >= 0) cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    (byId.get(id)?.dependsOn ?? []).filter((dependency) => byId.has(dependency)).forEach(visit);
    stack.pop();
    state.set(id, "done");
  };
  tasks.forEach((task) => visit(task.id));
  return cycles.filter((cycle) => new Set(cycle).size > 1);
};

const executionWaves = (tasks: TodoAnalyzedTask[]): string[][] => {
  const pending = new Map(tasks.filter((task) => !task.completed).map((task) => [task.id, task]));
  const done = new Set(tasks.filter((task) => task.completed).map((task) => task.id));
  const waves: string[][] = [];
  while (pending.size > 0) {
    const ready = Array.from(pending.values())
      .filter((task) => task.dependsOn.every(
        (dependency) => done.has(dependency) || !pending.has(dependency),
      ))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    if (ready.length === 0) break;
    waves.push(ready.map((task) => task.id));
    ready.forEach((task) => {
      pending.delete(task.id);
      done.add(task.id);
    });
  }
  return waves;
};

export const analyzeTodo = (
  source: string,
  options: TodoAnalysisOptions,
): TodoAnalysis => {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const diagnostics: TodoDiagnostic[] = [];
  const tasks: TodoAnalyzedTask[] = [];
  let current: TodoAnalyzedTask | undefined;
  let currentSeen = new Set<string>();
  let currentLastLine = 0;
  let generated = 0;

  const flush = (): void => {
    if (!current) return;
    if (!current.completed && options.requirePaths && !currentSeen.has("paths")) {
      diagnostics.push({
        line: current.line,
        column: 0,
        length: lines[current.line - 1]?.length ?? 1,
        severity: "error",
        code: "todo.missingPaths",
        message: `Task ${current.id} declares no Paths. Autonomous tasks must state their scope; use "Paths: ." only for an explicit whole-workspace task.`,
        fixes: [{
          title: "Add Paths: .",
          line: currentLastLine,
          text: "  - Paths: .",
          mode: "insertAfter",
        }],
      });
    }
    if (!current.completed && !currentSeen.has("checks")) {
      diagnostics.push({
        line: current.line,
        column: 0,
        length: lines[current.line - 1]?.length ?? 1,
        severity: "warning",
        code: "todo.missingVerify",
        message: `Task ${current.id} declares no Verify. State the verification explicitly, or "Verify: none" to say there is none.`,
        fixes: [
          {
            title: "Add Verify: bachata:project-checks",
            line: currentLastLine,
            text: "  - Verify: bachata:project-checks",
            mode: "insertAfter",
          },
          {
            title: "Add Verify: none",
            line: currentLastLine,
            text: "  - Verify: none",
            mode: "insertAfter",
          },
        ],
      });
    }
    tasks.push(current);
    current = undefined;
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const checkbox = todoCheckboxPattern.exec(raw);
    if (checkbox) {
      flush();
      generated += 1;
      const explicitId = checkbox[3];
      current = {
        id: explicitId ?? `T${String(generated)}`,
        title: checkbox[4] ?? "",
        line,
        completed: checkbox[2] !== " ",
        dependsOn: [],
        paths: [],
        checks: [],
        finalChecks: [],
        priority: 0,
      };
      currentSeen = new Set();
      currentLastLine = line;
      return;
    }
    const metadata = todoMetadataPattern.exec(raw);
    if (!metadata || !current) return;
    currentLastLine = line;
    const rawKey = (metadata[1] ?? "").trim();
    const value = metadata[2] ?? "";
    const alias = metadataAliases.get(rawKey.replace(/[^a-zA-Z]/gu, "").toLowerCase());
    const column = raw.indexOf(rawKey);
    if (!alias) {
      const suggestion = closestMetadataLabel(rawKey.replace(/[^a-zA-Z]/gu, "").toLowerCase());
      diagnostics.push({
        line,
        column: Math.max(0, column),
        length: rawKey.length,
        severity: "error",
        code: "todo.unknownKey",
        message: suggestion
          ? `Unknown TODO metadata key "${rawKey}". Did you mean "${suggestion}"? An unknown key stops orchestration instead of silently disabling isolation.`
          : `Unknown TODO metadata key "${rawKey}". An unknown key stops orchestration instead of silently disabling isolation.`,
        fixes: suggestion
          ? [{
              title: `Change to ${suggestion}`,
              line,
              text: raw.replace(rawKey, suggestion),
              mode: "replaceLine",
            }]
          : [],
      });
      return;
    }
    if (currentSeen.has(alias.canonical) && alias.repeatable !== true) {
      diagnostics.push({
        line,
        column: Math.max(0, column),
        length: rawKey.length,
        severity: "error",
        code: "todo.duplicateKey",
        message: `${alias.label} is declared more than once for task ${current.id}.`,
        fixes: [],
      });
    }
    currentSeen.add(alias.canonical);
    if (alias.canonical === "dependencies") current.dependsOn.push(...listValues(value));
    if (alias.canonical === "paths") current.paths.push(...listValues(value));
    if (alias.canonical === "priority") {
      const parsed = Number(value.trim());
      if (!Number.isInteger(parsed)) {
        diagnostics.push({
          line,
          column: Math.max(0, column),
          length: rawKey.length,
          severity: "error",
          code: "todo.invalidPriority",
          message: `Priority must be an integer; found "${value.trim()}".`,
          fixes: [],
        });
      } else {
        current.priority = parsed;
      }
    }
    if (alias.canonical === "checks" || alias.canonical === "finalChecks") {
      const commands = listValues(value);
      const target = alias.canonical === "checks" ? current.checks : current.finalChecks;
      target.push(...commands);
      if (options.requireControllerVerification) {
        commands
          .filter((command) => command !== "none" && !isDeclarableVerificationCommand(command))
          .forEach((command) => diagnostics.push({
            line,
            column: Math.max(0, raw.indexOf(command)),
            length: command.length,
            severity: "error",
            code: "todo.unsupportedVerification",
            message: `Autonomous verification does not accept "${command}". Use bachata:workspace-integrity, bachata:project-checks, or none. A bachata:verifier:<id> descriptor may be declared, but an unattended run refuses it before any process starts.`,
            fixes: [
              {
                title: "Use bachata:project-checks",
                line,
                text: raw.replace(command, "bachata:project-checks"),
                mode: "replaceLine",
              },
              {
                title: "Use bachata:workspace-integrity",
                line,
                text: raw.replace(command, "bachata:workspace-integrity"),
                mode: "replaceLine",
              },
            ],
          }));
      }
    }
  });
  flush();

  const ids = new Set(tasks.map((task) => task.id));
  const seenIds = new Set<string>();
  tasks.forEach((task) => {
    if (seenIds.has(task.id)) {
      diagnostics.push({
        line: task.line,
        column: 0,
        length: lines[task.line - 1]?.length ?? 1,
        severity: "error",
        code: "todo.duplicateId",
        message: `Duplicate task id ${task.id}.`,
        fixes: [],
      });
    }
    seenIds.add(task.id);
    task.dependsOn.forEach((dependency) => {
      if (dependency === task.id) {
        diagnostics.push({
          line: task.line,
          column: 0,
          length: lines[task.line - 1]?.length ?? 1,
          severity: "error",
          code: "todo.selfDependency",
          message: `Task ${task.id} cannot depend on itself.`,
          fixes: [],
        });
        return;
      }
      if (!ids.has(dependency)) {
        diagnostics.push({
          line: task.line,
          column: 0,
          length: lines[task.line - 1]?.length ?? 1,
          severity: "error",
          code: "todo.unknownDependency",
          message: `Task ${task.id} depends on unknown task ${dependency}.`,
          fixes: [],
        });
      }
    });
  });

  const cycles = findCycles(tasks);
  cycles.forEach((cycle) => {
    const head = tasks.find((task) => task.id === cycle[0]);
    diagnostics.push({
      line: head?.line ?? 1,
      column: 0,
      length: head ? lines[head.line - 1]?.length ?? 1 : 1,
      severity: "error",
      code: "todo.dependencyCycle",
      message: `Dependency cycle: ${cycle.join(" → ")}.`,
      fixes: [],
    });
  });

  const runnable = tasks.filter((task) => !task.completed);
  const pathConflicts: Array<{ path: string; taskIds: string[] }> = [];
  runnable.forEach((left, leftIndex) => {
    runnable.slice(leftIndex + 1).forEach((right) => {
      const ordered = left.dependsOn.includes(right.id) || right.dependsOn.includes(left.id);
      if (ordered) return;
      left.paths.forEach((leftPath) => {
        right.paths.forEach((rightPath) => {
          if (!scopesOverlap(leftPath, rightPath)) return;
          const label = repositoryPathComparisonKey(leftPath).length >= repositoryPathComparisonKey(rightPath).length
            ? rightPath
            : leftPath;
          const existing = pathConflicts.find((conflict) => conflict.path === label);
          if (existing) {
            if (!existing.taskIds.includes(left.id)) existing.taskIds.push(left.id);
            if (!existing.taskIds.includes(right.id)) existing.taskIds.push(right.id);
            return;
          }
          pathConflicts.push({ path: label, taskIds: [left.id, right.id] });
        });
      });
    });
  });
  pathConflicts.forEach((conflict) => {
    const head = tasks.find((task) => task.id === conflict.taskIds[0]);
    diagnostics.push({
      line: head?.line ?? 1,
      column: 0,
      length: head ? lines[head.line - 1]?.length ?? 1 : 1,
      severity: "warning",
      code: "todo.pathConflict",
      message: `${conflict.taskIds.join(", ")} may write the same scope "${conflict.path}" with no dependency between them. They can run at the same time and their merges can conflict.`,
      fixes: [],
    });
  });

  try {
    parseTodoDocument("TODO.md", source, {
      pipelineId: options.pipelineId,
      retries: options.retries,
      requirePaths: options.requirePaths,
      requireControllerVerification: options.requireControllerVerification,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const located = /:(\d+)\b/u.exec(message);
    const line = located ? Number(located[1]) : 1;
    if (!diagnostics.some((diagnostic) => diagnostic.line === line && diagnostic.severity === "error")) {
      diagnostics.push({
        line,
        column: 0,
        length: lines[line - 1]?.length ?? 1,
        severity: "error",
        code: "todo.invalid",
        message,
        fixes: [],
      });
    }
  }

  return {
    tasks,
    diagnostics: diagnostics.sort((left, right) => left.line - right.line),
    waves: executionWaves(tasks),
    cycles,
    pathConflicts,
  };
};

export const renderTodoPlan = (analysis: TodoAnalysis, todoFile: string): string => {
  const byId = new Map(analysis.tasks.map((task) => [task.id, task]));
  const graph = [
    "```mermaid",
    "graph TD",
    ...analysis.tasks.map((task) =>
      `  ${task.id}["${task.id}${task.completed ? " (done)" : ""}"]`),
    ...analysis.tasks.flatMap((task) =>
      task.dependsOn
        .filter((dependency) => byId.has(dependency))
        .map((dependency) => `  ${dependency} --> ${task.id}`)),
    "```",
  ].join("\n");
  const waves = analysis.waves.length === 0
    ? "_No runnable task._"
    : analysis.waves
        .map((wave, index) => `${String(index + 1)}. ${wave.join(", ")}`)
        .join("\n");
  const conflicts = analysis.pathConflicts.length === 0
    ? "_No overlapping write scope between independent tasks._"
    : analysis.pathConflicts
        .map((conflict) => `- \`${conflict.path}\` · ${conflict.taskIds.join(", ")}`)
        .join("\n");
  const problems = analysis.diagnostics.length === 0
    ? "_None._"
    : analysis.diagnostics
        .map((diagnostic) => `- ${diagnostic.severity === "error" ? "**error**" : "warning"} line ${String(diagnostic.line)}: ${diagnostic.message}`)
        .join("\n");
  return [
    `# ${todoFile} plan`,
    "",
    "## Execution order",
    "",
    "Each numbered group can run at the same time, bounded by the configured task concurrency.",
    "",
    waves,
    "",
    "## Dependencies",
    "",
    graph,
    ...(analysis.cycles.length > 0
      ? ["", "## Cycles", "", ...analysis.cycles.map((cycle) => `- ${cycle.join(" → ")}`)]
      : []),
    "",
    "## Overlapping write scopes",
    "",
    conflicts,
    "",
    "## Problems",
    "",
    problems,
    "",
  ].join("\n");
};
