import { ExecutionChecklistIssue } from "../pipeline/types";
import { isDeclarableVerificationCommand } from "./verificationPolicy";
import { VERIFIER_REGISTRY_PATH, verifierDescriptorId } from "./verifierRegistry";
import type { JsonValue } from "./types";

export type SelfImprovementBlocker = {
  subject: string;
  question: string;
  evidence: string[];
};

export type SelfImprovementTask = {
  id: string;
  outcome: string;
  details: string;
  paths: string[];
  dependsOn: string[];
  checks: string[];
  finalChecks: string[];
  priority: number;
  retries: number;
  evidence: string[];
};

export type SelfImprovementPlan = {
  title: string;
  summary: string;
  evidence: string[];
  blockers: SelfImprovementBlocker[];
  tasks: SelfImprovementTask[];
};

export type SelfImprovementDefect = {
  id: string;
  severity: "blocker" | "major" | "minor";
  statement: string;
  requiredChange: string;
  evidence: string[];
};

export type SelfImprovementReview = {
  verdict: "accept" | "reject";
  summary: string;
  defects: SelfImprovementDefect[];
};

export type CandidateIdentity = {
  // Logical identity of the work. Never a path an agent should try to open: the candidate is
  // checked out somewhere else, and advertising this as the read target is what made one audit
  // read nothing at all.
  repositoryRoot: string;
  baselineCommit: string;
  inputTree?: string;
  // The checked-out tree the agent's session is rooted at, and the only path it must read.
  candidateWorktree: string;
};

export type RepositoryAuditFinding = {
  subject: string;
  statement: string;
  proposedChange?: string;
  verification?: string;
  evidence: string[];
};

export type RepositoryAudit = {
  agentId: string;
  status: "assessed" | "blocked";
  blockedReason?: string;
  inspected: string[];
  findings: RepositoryAuditFinding[];
};

const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u;

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const boundedInteger = (value: unknown, fallback: number, low: number, high: number): number =>
  typeof value === "number" && Number.isInteger(value)
    ? Math.min(high, Math.max(low, value))
    : fallback;

/*
 * The convergence candidate is already schema-checked by the consensus decision. This second
 * pass is about what a schema cannot state: that ids are unique and referable, that every task
 * carries repository evidence, and that every declared check is a command an unattended run is
 * allowed to name. A candidate that fails here never becomes a task.
 */
export const parseSelfImprovementPlan = (
  value: JsonValue | undefined,
  defaults: { retries: number },
): { plan?: SelfImprovementPlan; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: ["The accepted convergence candidate is not a JSON object"] };
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!title) errors.push("The plan has no title");
  if (!summary) errors.push("The plan has no summary");

  const blockers: SelfImprovementBlocker[] = (Array.isArray(value.blockers) ? value.blockers : [])
    .filter(isRecord)
    .map((entry) => ({
      subject: typeof entry.subject === "string" ? entry.subject.trim() : "",
      question: typeof entry.question === "string" ? entry.question.trim() : "",
      evidence: stringList(entry.evidence),
    }))
    .filter((entry) => entry.subject.length > 0 && entry.question.length > 0);

  const rawTasks = Array.isArray(value.tasks) ? value.tasks.filter(isRecord) : [];
  const seen = new Set<string>();
  const tasks: SelfImprovementTask[] = [];
  rawTasks.forEach((entry, index) => {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const position = `tasks[${String(index)}]`;
    if (!idPattern.test(id)) {
      errors.push(`${position}.id must match ${String(idPattern)}`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`Duplicate generated task id: ${id}`);
      return;
    }
    seen.add(id);
    const outcome = typeof entry.outcome === "string" ? entry.outcome.trim() : "";
    const details = typeof entry.details === "string" ? entry.details.trim() : "";
    const paths = stringList(entry.paths).map((item) => item.trim()).filter(Boolean);
    const checks = stringList(entry.checks).map((item) => item.trim()).filter(Boolean);
    const finalChecks = stringList(entry.finalChecks).map((item) => item.trim()).filter(Boolean);
    const evidence = stringList(entry.evidence).map((item) => item.trim()).filter(Boolean);
    if (!outcome) errors.push(`Generated task ${id} has no outcome`);
    if (!details) errors.push(`Generated task ${id} has no details`);
    if (paths.length === 0) errors.push(`Generated task ${id} declares no path scope`);
    if (checks.length === 0) errors.push(`Generated task ${id} declares no Verify command`);
    if (evidence.length === 0) {
      errors.push(`Generated task ${id} cites no repository evidence, so it is not a confirmed finding`);
    }
    [...checks, ...finalChecks]
      .filter((command) => !isDeclarableVerificationCommand(command))
      .forEach((command) => {
        errors.push(`Generated task ${id} declares a verification command Bachata cannot name: ${command}`);
      });
    tasks.push({
      id,
      outcome,
      details,
      paths,
      dependsOn: stringList(entry.dependsOn).map((item) => item.trim()).filter(Boolean),
      checks,
      finalChecks,
      priority: boundedInteger(entry.priority, rawTasks.length - index, 0, 1000),
      retries: boundedInteger(entry.retries, defaults.retries, 0, 10),
      evidence,
    });
  });

  tasks.forEach((task) => {
    task.dependsOn.forEach((dependency) => {
      if (dependency === task.id) {
        errors.push(`Generated task ${task.id} depends on itself`);
        return;
      }
      if (!seen.has(dependency)) {
        errors.push(`Generated task ${task.id} depends on unknown task ${dependency}`);
      }
    });
  });

  if (tasks.length === 0 && blockers.length === 0) {
    errors.push("The plan produced neither a confirmed task nor a named blocker");
  }
  if (errors.length > 0) return { errors };
  return {
    plan: {
      title,
      summary,
      evidence: stringList(value.evidence),
      blockers,
      tasks,
    },
    errors: [],
  };
};

const evidenceFilePath = (value: string): string =>
  value
    .replace(/#L\d+(?:-L?\d+)?$/u, "")
    .replace(/:\d+(?::\d+)?$/u, "")
    .trim();

/*
 * The schema cannot check a claim against the repository it is about. This does: a declared
 * verifier must exist in the candidate's registry and be executable under this run's authority,
 * and an evidence path must be a path the candidate actually has. Both are checked before the
 * plan is rendered, so neither can be discovered only after a worker has already implemented it.
 */
export const planRepositoryErrors = (
  plan: SelfImprovementPlan,
  repository: {
    declaredVerifierIds: readonly string[];
    repositoryVerifiersApproved: boolean;
    pathExists: (relativePath: string) => boolean;
  },
): string[] => {
  const errors: string[] = [];
  const declared = new Set(repository.declaredVerifierIds);
  plan.tasks.forEach((task) => {
    [...task.checks, ...task.finalChecks].forEach((command) => {
      const id = verifierDescriptorId(command);
      if (id === undefined) return;
      if (!repository.repositoryVerifiersApproved) {
        errors.push(
          `Generated task ${task.id} declares ${command}, but this workspace has approved no repository verifier, so that check would be refused`,
        );
        return;
      }
      if (!declared.has(id)) {
        errors.push(
          `Generated task ${task.id} declares ${command}, which ${VERIFIER_REGISTRY_PATH} does not declare`,
        );
      }
    });
    task.evidence.forEach((item) => {
      const file = evidenceFilePath(item);
      if (file.length === 0 || !repository.pathExists(file)) {
        errors.push(
          `Generated task ${task.id} cites evidence this repository does not contain: ${item}`,
        );
      }
    });
  });
  plan.blockers.forEach((blocker, index) => {
    blocker.evidence.forEach((item) => {
      const file = evidenceFilePath(item);
      if (file.length === 0 || !repository.pathExists(file)) {
        errors.push(
          `Blocker ${String(index + 1)} (${blocker.subject}) cites evidence this repository does not contain: ${item}`,
        );
      }
    });
  });
  return errors;
};

export const selfImprovementIssues = (plan: SelfImprovementPlan): ExecutionChecklistIssue[] =>
  plan.tasks.map((task) => ({
    id: task.id,
    title: task.outcome,
    details: task.details,
    dependencies: [...task.dependsOn],
    paths: [...task.paths],
  }));

const listLine = (label: string, values: string[]): string =>
  `  - ${label}: ${values.length > 0 ? values.join(", ") : "none"}`;

// Verify and Verify Final are repeatable metadata: the parser reads one command per line and
// never splits a line on commas, so a joined line would be read as a single unknown command.
const commandLines = (label: string, values: string[]): string[] =>
  values.length > 0 ? values.map((value) => `  - ${label}: ${value}`) : [`  - ${label}: none`];

/*
 * Rendered from the accepted candidate, never from prose an agent restated. The controller
 * parses this back with the same parser `Bachata: Run TODO.md` uses, so a plan that cannot be
 * expressed as an executable TODO is rejected before a worker starts.
 */
export const renderExecutableTodo = (
  plan: SelfImprovementPlan,
  options: { pipelineId: string; candidate: CandidateIdentity },
): string => {
  const header = [
    `# ${plan.title}`,
    "",
    plan.summary,
    "",
    `Generated by Bachata: Improve This Project from repository candidate ${options.candidate.baselineCommit}.`,
    ...(plan.evidence.length > 0
      ? ["", "Evidence:", ...plan.evidence.map((item) => `- ${item}`)]
      : []),
    ...(plan.blockers.length > 0
      ? [
          "",
          "Human-owned decisions this plan did not answer:",
          ...plan.blockers.map((item) => `- ${item.subject}: ${item.question} (${item.evidence.join(", ")})`),
        ]
      : []),
    "",
    "## Tasks",
    "",
  ];
  const body = plan.tasks.flatMap((task) => [
    `- [ ] [${task.id}] ${task.outcome}`,
    `  - Description: ${task.details}`,
    listLine("Paths", task.paths),
    ...(task.dependsOn.length > 0 ? [listLine("Depends on", task.dependsOn)] : []),
    `  - Pipeline: ${options.pipelineId}`,
    ...commandLines("Verify", task.checks),
    ...commandLines("Verify Final", task.finalChecks),
    `  - Priority: ${String(task.priority)}`,
    `  - Retries: ${String(task.retries)}`,
    `  - Notes: Evidence: ${task.evidence.join(", ")}`,
    "",
  ]);
  return [...header, ...body].join("\n");
};

export const parseSelfImprovementReview = (
  value: JsonValue | undefined,
): { review?: SelfImprovementReview; errors: string[] } => {
  if (!isRecord(value)) {
    return { errors: ["The lead review is not a JSON object"] };
  }
  const verdict = value.verdict;
  if (verdict !== "accept" && verdict !== "reject") {
    return { errors: ["The lead review did not return accept or reject"] };
  }
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (!summary) return { errors: ["The lead review carries no summary"] };
  const defects: SelfImprovementDefect[] = (Array.isArray(value.defects) ? value.defects : [])
    .filter(isRecord)
    .map((entry): SelfImprovementDefect => ({
      id: typeof entry.id === "string" ? entry.id.trim() : "",
      severity: entry.severity === "blocker" || entry.severity === "minor" ? entry.severity : "major",
      statement: typeof entry.statement === "string" ? entry.statement.trim() : "",
      requiredChange: typeof entry.requiredChange === "string" ? entry.requiredChange.trim() : "",
      evidence: stringList(entry.evidence),
    }))
    .filter((entry) => entry.id.length > 0 && entry.statement.length > 0 && entry.requiredChange.length > 0);
  if (verdict === "reject" && defects.length === 0) {
    return { errors: ["The lead rejected the candidate without naming an actionable defect"] };
  }
  // An accept that still names a defect is two answers at once. Integrating on it would ship
  // work the lead itself flagged, so the decision is refused rather than resolved by guessing.
  if (verdict === "accept" && defects.length > 0) {
    return {
      errors: [
        `The lead accepted the candidate while still naming ${String(defects.length)} defect${defects.length === 1 ? "" : "s"}: ${defects
          .map((defect) => defect.id)
          .join(", ")}`,
      ],
    };
  }
  return { review: { verdict, summary, defects }, errors: [] };
};

export const renderReviewDefects = (review: SelfImprovementReview): string =>
  review.defects
    .map((defect, index) =>
      [
        `${String(index + 1)}. [${defect.id}] (${defect.severity}) ${defect.statement}`,
        `   Required change: ${defect.requiredChange}`,
        ...(defect.evidence.length > 0 ? [`   Evidence: ${defect.evidence.join(", ")}`] : []),
      ].join("\n"),
    )
    .join("\n");

const candidateLines = (candidate: CandidateIdentity): string[] => [
  `Read this tree: ${candidate.candidateWorktree}`,
  "It is your session's working directory. Every path you cite is relative to it.",
  `Logical repository (identity only, do not try to open it): ${candidate.repositoryRoot}`,
  `Baseline commit: ${candidate.baselineCommit}`,
  ...(candidate.inputTree ? [`Sealed input tree: ${candidate.inputTree}`] : []),
];

/*
 * A completed transport is not a completed audit. A participant that could not read the
 * candidate, or that cites nothing it read, stops discovery here — before convergence and
 * before any worker — rather than contributing an empty answer that convergence treats as
 * agreement.
 */
export const auditGateErrors = (audits: readonly RepositoryAudit[]): string[] => {
  if (audits.length < 2) {
    return [
      `Independent discovery needs two audits and produced ${String(audits.length)}`,
    ];
  }
  return audits.flatMap((audit) => {
    if (audit.status === "blocked") {
      return [
        `${audit.agentId} could not audit the candidate: ${audit.blockedReason ?? "no reason given"}`,
      ];
    }
    if (audit.inspected.length === 0) {
      return [
        `${audit.agentId} reported an audit but cited no repository path it read, so no independent audit happened`,
      ];
    }
    return [];
  });
};

export const parseRepositoryAudit = (
  agentId: string,
  value: JsonValue | undefined,
): { audit?: RepositoryAudit; errors: string[] } => {
  if (!isRecord(value)) return { errors: [`${agentId} returned no audit object`] };
  const status = value.status;
  if (status !== "assessed" && status !== "blocked") {
    return { errors: [`${agentId} returned no audit status`] };
  }
  const findings: RepositoryAuditFinding[] = (Array.isArray(value.findings) ? value.findings : [])
    .filter(isRecord)
    .map((entry): RepositoryAuditFinding => ({
      subject: typeof entry.subject === "string" ? entry.subject.trim() : "",
      statement: typeof entry.statement === "string" ? entry.statement.trim() : "",
      ...(typeof entry.proposedChange === "string" ? { proposedChange: entry.proposedChange } : {}),
      ...(typeof entry.verification === "string" ? { verification: entry.verification } : {}),
      evidence: stringList(entry.evidence),
    }))
    .filter((entry) => entry.subject.length > 0 && entry.statement.length > 0);
  return {
    audit: {
      agentId,
      status,
      ...(typeof value.blockedReason === "string" && value.blockedReason.trim().length > 0
        ? { blockedReason: value.blockedReason.trim() }
        : {}),
      inspected: stringList(value.inspected).map((item) => item.trim()).filter(Boolean),
      findings,
    },
    errors: [],
  };
};

export const renderAudits = (audits: readonly RepositoryAudit[]): string =>
  audits
    .map((audit) =>
      [
        `### ${audit.agentId}`,
        `Inspected: ${audit.inspected.join(", ")}`,
        ...audit.findings.map((finding, index) =>
          [
            `${String(index + 1)}. ${finding.subject}: ${finding.statement}`,
            ...(finding.proposedChange ? [`   Proposed change: ${finding.proposedChange}`] : []),
            ...(finding.verification ? [`   Verification: ${finding.verification}`] : []),
            `   Evidence: ${finding.evidence.join(", ")}`,
          ].join("\n"),
        ),
      ].join("\n"),
    )
    .join("\n\n");

export const buildDiscoveryPrompt = (input: {
  candidate: CandidateIdentity;
  pipelineId: string;
  retries: number;
  controllerChecks: string[];
  approvedVerifierCommands: string[];
}): string => [
  "# Bachata self-improvement discovery",
  "",
  "Audit the repository candidate checked out at your working directory. Read it. Do not edit any file, and do not run acceptance, integration, E2E, database, Docker, browser, or other shared-resource commands.",
  "",
  "## The tree you must read",
  ...candidateLines(input.candidate),
  "",
  "## Question",
  "The configured TODO file is missing, empty, or not executable. Name the work this candidate's own contents show is outstanding, so Bachata can execute it unattended.",
  "",
  "## Rules",
  "- Every finding must cite a repository-relative path you actually opened. A finding with no such path is dropped.",
  "- Do not invent owner decisions, provider evidence, benchmark results, or participant evidence.",
  "- A judgment a human owns — product identity, legal review, accounts, external access, release authorization — is not a finding.",
  "- Prefer bounded work a single worker can finish inside one declared path scope.",
  "",
  "## Execution constraints any resulting task must satisfy",
  `- Each task runs the pipeline ${input.pipelineId} in its own isolated Git worktree.`,
  `- Verify and Verify Final accept only: ${[...input.controllerChecks, ...input.approvedVerifierCommands].join(", ")}.`,
  `- Default retries per task: ${String(input.retries)}.`,
  "- Paths are repository-relative and must stay inside the repository.",
  "- Nothing is committed or pushed. The result is retained for one human Apply action.",
  "",
  "## Required answer",
  'Return JSON only: {"status":"assessed"|"blocked","blockedReason":"...","inspected":[repository-relative paths you opened],"findings":[{"subject","statement","proposedChange","evidence":[paths]}]}.',
  "- inspected lists the files you actually read. It is the record that an audit happened at all.",
  "- If you could not read the candidate, return status \"blocked\" with blockedReason and an empty findings list. Do not guess, and do not return an empty assessed audit instead. Bachata stops discovery on a blocked audit rather than proceeding without you.",
  "- status \"assessed\" with an empty inspected list is refused for the same reason.",
  "- This first pass is yours alone; you are not shown any other participant's answer.",
].join("\n");

export const buildConvergencePrompt = (input: {
  candidate: CandidateIdentity;
  pipelineId: string;
  retries: number;
  controllerChecks: string[];
  approvedVerifierCommands: string[];
  audits: readonly RepositoryAudit[];
}): string => [
  "# Bachata self-improvement convergence",
  "",
  "Both first-pass audits are below. Cross-check every checkable claim against the candidate before you carry it forward.",
  "",
  "## The tree you must read",
  ...candidateLines(input.candidate),
  "",
  "## Rules",
  "- Confirm a claim only by reading the path it cites. Drop every claim the source does not support.",
  "- A claim you cannot settle from the candidate is unresolved. An unresolved claim never becomes a task.",
  "- A judgment a human owns becomes a blocker carrying the exact question, never an invented answer.",
  "",
  "## Required answer",
  'Return JSON only, and nothing else: {"candidate": {...}, "accepted": true|false, "objections": [...], "unresolvedRisks": [...]}.',
  "candidate must be an executable task plan:",
  '{"title": ..., "summary": ..., "evidence": [repository paths], "blockers": [{"subject","question","evidence":[paths]}], "tasks": [{"id","outcome","details","paths":[...],"dependsOn":[...],"checks":[...],"finalChecks":[...],"priority":int,"retries":int,"evidence":[paths]}]}',
  "",
  "- Include no field that is not named above. An unknown field invalidates the whole answer.",
  `- checks and finalChecks accept only: ${[...input.controllerChecks, ...input.approvedVerifierCommands].join(", ")}. Omit finalChecks or leave it empty when the task needs no integration-tree check.`,
  `- Default retries per task: ${String(input.retries)}. Every task needs at least one evidence path that exists in this candidate.`,
  "- ids are stable, unique, and referable by dependsOn.",
  "",
  "About accepted: it is a boolean about the exact candidate you are returning in this answer. Return true once the candidate is the plan you are prepared to have executed — including when you reached that by dropping every claim you could not confirm. Return false only while a factual disagreement still needs another round, and say what is unsettled in objections. Agreement is on content, so return the same candidate the other participant returned when you agree with it, byte for byte.",
  "",
  "If this round asks you alone, after the other participant has already answered, then your answer is the final ruling. Settle every remaining disagreement from source yourself, return the candidate you can defend, and return accepted true. There is no further round.",
  "",
  "## First-pass audits",
  renderAudits(input.audits),
].join("\n");

export const buildWorkerPacket = (input: {
  taskId: string;
  outcome: string;
  details: string;
  paths: string[];
  evidence: string[];
  dependencies: string;
  checks: string[];
  worktreePath: string;
  integrationBranch: string;
  attempt: number;
  lockedDecisions: string[];
  baselineFailures: string[];
  verificationFailure?: string;
}): string => [
  "# Bachata self-improvement task",
  "",
  `Task ID: ${input.taskId}`,
  `Outcome: ${input.outcome}`,
  `Working directory: ${input.worktreePath}`,
  `Integration branch: ${input.integrationBranch}`,
  `Attempt: ${String(input.attempt)}`,
  "",
  "## What must become true",
  input.details,
  "",
  "## Source evidence this task was derived from",
  input.evidence.length > 0 ? input.evidence.map((item) => `- ${item}`).join("\n") : "- None recorded",
  "",
  "## Allowed scope",
  input.paths.map((item) => `- ${item}`).join("\n"),
  "",
  "## Dependencies already integrated",
  input.dependencies,
  "",
  "## Checks the controller will run on your result",
  input.checks.length > 0 ? input.checks.map((item) => `- ${item}`).join("\n") : "- None declared",
  "",
  "## Locked decisions",
  input.lockedDecisions.map((item) => `- ${item}`).join("\n"),
  "",
  "## Known baseline failures",
  input.baselineFailures.length > 0
    ? input.baselineFailures.map((item) => `- ${item}`).join("\n")
    : "- None recorded. Treat every failure you see as caused by this task.",
  "",
  "## Stop conditions",
  "- Stop and report if the outcome needs a decision a human owns, an external dependency, credentials, or a destructive operation.",
  "- Stop and report if the declared scope cannot contain the change.",
  "",
  "## Control boundary",
  "Implement only this task. You may inspect files and use read-only analysis commands, but do not run declared acceptance, integration, E2E, database, Docker, browser, or shared-resource checks. Do not create, schedule, reorder, complete, or cancel tasks. Do not modify orchestration state or the controller-owned TODO. Do not decide whether this task is accepted.",
  "",
  "## Final report",
  "End with: what changed, which files, why the outcome is now true, and anything you could not do.",
  ...(input.verificationFailure
    ? ["", "## Previous deterministic verification failure", input.verificationFailure]
    : []),
].join("\n");

export const buildLeadReviewPrompt = (input: {
  taskId: string;
  outcome: string;
  details: string;
  paths: string[];
  candidate: CandidateIdentity;
  taskTree: string;
  changedFiles: string[];
  patch: string;
  checks: Array<{ command: string; status: string; exitCode?: number; stdout: string; stderr: string }>;
  workerReport: string;
  final: boolean;
}): string => [
  input.final ? "# Bachata self-improvement final lead review" : "# Bachata self-improvement lead review",
  "",
  "Review this exact candidate tree. The controller has already run the declared checks below; their results are authoritative. Do not edit files, do not run commands that change state, and do not change orchestration state.",
  "",
  "## Task",
  `Task ID: ${input.taskId}`,
  `Outcome: ${input.outcome}`,
  input.details,
  "",
  "## Declared scope",
  input.paths.map((item) => `- ${item}`).join("\n"),
  "",
  "## Candidate tree identity",
  ...candidateLines(input.candidate),
  `Task tree: ${input.taskTree}`,
  "",
  "## Changed files",
  input.changedFiles.length > 0 ? input.changedFiles.map((item) => `- ${item}`).join("\n") : "- None",
  "",
  "## Controller check results",
  input.checks.length > 0
    ? input.checks
        .map((check) =>
          [
            `$ ${check.command}`,
            `Status: ${check.status}${check.exitCode === undefined ? "" : ` · exit ${String(check.exitCode)}`}`,
            check.stdout.trim() ? `stdout:\n${check.stdout.trim()}` : "",
            check.stderr.trim() ? `stderr:\n${check.stderr.trim()}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n")
    : "No check was declared for this task.",
  "",
  "## Worker report",
  input.workerReport || "The worker returned no report.",
  "",
  "## Diff",
  input.patch.trim() ? ["```diff", input.patch, "```"].join("\n") : "The candidate changed no tracked content.",
  "",
  "## Required answer",
  'Return JSON only: {"verdict":"accept"|"reject","summary":"...","defects":[{"id","severity","statement","requiredChange","evidence":[...]}]}.',
  "- accept means this exact candidate is ready to integrate. defects must then be an empty array.",
  "- reject means at least one defect a worker can fix in one bounded revision inside the declared scope. State each defect once, with the exact change required.",
  "- Do not reject for style, for work outside the declared scope, or for anything the controller checks already passed.",
  ...(input.final
    ? ["- This is the final review. The revision budget is spent; there is no further revision after this answer."]
    : []),
].join("\n");

export const buildRevisionPacket = (input: {
  taskId: string;
  outcome: string;
  details: string;
  paths: string[];
  worktreePath: string;
  review: SelfImprovementReview;
  checks: string[];
}): string => [
  "# Bachata self-improvement revision",
  "",
  `Task ID: ${input.taskId}`,
  `Outcome: ${input.outcome}`,
  `Working directory: ${input.worktreePath}`,
  "",
  "The lead reviewed your implementation and rejected this candidate. Revise it in place, in this same worktree. This is the only revision this task gets.",
  "",
  "## Original task",
  input.details,
  "",
  "## Allowed scope",
  input.paths.map((item) => `- ${item}`).join("\n"),
  "",
  "## Lead review",
  input.review.summary,
  "",
  "## Defects to fix",
  renderReviewDefects(input.review),
  "",
  "## Checks the controller will rerun on your revision",
  input.checks.length > 0 ? input.checks.map((item) => `- ${item}`).join("\n") : "- None declared",
  "",
  "## Control boundary",
  "Fix exactly these defects and nothing else. Stay inside the declared scope. Do not run declared acceptance, integration, E2E, database, Docker, browser, or shared-resource checks. Do not change orchestration state.",
  "",
  "## Final report",
  "End with: which defect you fixed where, and any defect you could not fix and why.",
].join("\n");
