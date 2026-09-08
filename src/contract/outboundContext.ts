import { readOnlyPermissionModes } from "../pipeline/permissionModes";
import type { WorkspaceWriteScope } from "../adapters/types";
import type { PipelineDefinition } from "../pipeline/types";
import { providerDisplayName } from "../pipeline/providerNames";

export type OutboundContextEntryKind =
  | "instruction"
  | "prompt"
  | "attachment"
  | "repositoryFile"
  | "metadata";

export type OutboundContextEntry = {
  kind: OutboundContextEntryKind;
  label: string;
  detail: string;
  exact: boolean;
};

export type OutboundContextManifest = {
  agentId: string;
  name: string;
  adapterLabel: string;
  transport: string;
  entries: OutboundContextEntry[];
  exclusions: string[];
  redactions: string[];
};

export type OutboundContextInput = {
  pipeline: PipelineDefinition;
  workingDirectory?: string;
  readablePaths: string[];
  writablePaths: string[];
  writeScope?: WorkspaceWriteScope;
  protectedPaths: string[];
  attachments: Array<{ name: string; mimeType: string; size: number }>;
  promptBytes: number;
  handoffMaxBytes?: number;
  continuationMaxBytes?: number;
};

const transportFor = (adapter: string): string =>
  adapter.endsWith("-browser")
    ? "Pasted into a browser conversation in your local browser through the Browser Bridge"
    : "Written to a local provider process on this machine";

const stepsForAgent = (pipeline: PipelineDefinition, agentId: string): string[] => {
  const assigned = new Map<string, string>();
  pipeline.steps.forEach((step) => {
    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => assigned.set(assignment.role, assignment.agentId));
    }
  });
  return pipeline.steps
    .filter((step) => step.type === "agent" || step.type === "checklist")
    .filter((step) => step.enabled !== false)
    .filter((step) => step.participants.some(
      (participant) => participant === agentId || assigned.get(participant) === agentId,
    ))
    .map((step) => step.name);
};

const bytes = (value: number): string =>
  value >= 1_048_576
    ? `${String(Math.round(value / 104_857.6) / 10)} MiB`
    : `${String(Math.round(value / 102.4) / 10)} KiB`;

export { readOnlyPermissionModes };

const CLAUDE_BOUNDARY_ADAPTERS = new Set(["claude-code", "zai-glm"]);
const CODEX_BOUNDARY_ADAPTERS = new Set(["codex-app-server"]);

const effectiveWriteCapability = (pipeline: PipelineDefinition, agentId: string): boolean => {
  const agent = pipeline.agents.find((candidate) => candidate.id === agentId);
  const agentMode = agent?.permissionMode;
  const modeWrites = (mode: string | undefined): boolean =>
    mode === undefined || !readOnlyPermissionModes.has(mode);
  const assigned: Record<string, string> = {};
  let participated = false;
  for (const step of pipeline.steps) {
    if (!step.enabled) continue;
    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => {
        assigned[assignment.role] = assignment.agentId;
      });
      continue;
    }
    if (step.type !== "agent" && step.type !== "checklist") continue;
    const participantKey = step.participants.find(
      (participant: string) => participant === agentId || assigned[participant] === agentId,
    );
    if (participantKey === undefined) continue;
    participated = true;
    if (participantKey !== agentId) {
      const role = (pipeline.roles ?? []).find((candidate) => candidate.id === participantKey);
      if (role?.readOnly === true) continue;
    }
    const modes = step.permissionModes;
    const resolved = modes?.[participantKey] ?? modes?.[agentId] ?? agentMode;
    if (modeWrites(resolved)) return true;
  }
  return participated ? false : modeWrites(agentMode);
};

const writeScopeStatement = (
  writeScope: WorkspaceWriteScope | undefined,
  writablePaths: string[],
): string => {
  const bounded = writablePaths.filter((entry) => entry !== ".");
  if (writeScope === "task") {
    return "Its writable paths are derived from the task by the controller when execution begins. Execution refuses if none resolve.";
  }
  if (writeScope === "configured") {
    return bounded.length > 0
      ? `This run declares bounded writable paths: ${bounded.join(", ")}.`
      : "This run is bounded to declared writable paths.";
  }
  if (writeScope === "workspace") {
    return "This run declares workspace write scope, so a write-capable step may cover the working directory.";
  }
  return bounded.length > 0
    ? `This run declares bounded writable paths: ${bounded.join(", ")}.`
    : "Bachata does not state the write scope for this run here; it is resolved before the write-capable step runs.";
};

const filesystemAccessStatements = (input: {
  adapter: string;
  writeCapable: boolean;
  protectedPaths: string[];
  writablePaths: string[];
  writeScope?: WorkspaceWriteScope;
}): string[] => {
  const excluded = [
    ".bachata",
    "version control internals",
    "environment files",
    "credential files",
    ...(input.protectedPaths.length > 0 ? ["your protected paths"] : []),
  ].join(", ");
  if (CLAUDE_BOUNDARY_ADAPTERS.has(input.adapter)) {
    return [
      "Shell execution is denied for this participant, so it cannot run repository commands. Verification stays with the controller.",
      `Its file reads and edits go through path-scoped tools that refuse ${excluded}. Bachata enforces that itself, before each tool call.`,
    ];
  }
  if (CODEX_BOUNDARY_ADAPTERS.has(input.adapter)) {
    if (input.writeCapable) {
      return [
        "This participant has at least one write-capable step. Its exact writable roots are resolved when that step executes, not here.",
        writeScopeStatement(input.writeScope, input.writablePaths),
        `A writable root is also readable, so anything under it is reachable by this participant, including ${excluded} where they fall inside it.`,
      ];
    }
    return [
      `This participant is read-only. Bachata resolves an explicit readable-root list that leaves out ${excluded}, symbolic links, and anything resolving outside the working directory, and sends it with the turn.`,
      "Bachata does not verify that the provider applied that list, and the installed Codex protocol may not carry per-path read restriction at all. Treat everything in the working directory as reachable by this participant until a live provider run proves otherwise.",
    ];
  }
  return [
    "This participant is a browser conversation. It receives only what Bachata pastes into it and has no direct repository access.",
  ];
};

export const buildOutboundContext = (
  input: OutboundContextInput,
): OutboundContextManifest[] => {
  const { pipeline } = input;
  const managed = pipeline.managedPolicy !== undefined ||
    (pipeline.roles ?? []).some((role) => role.managed === true);
  return pipeline.agents.map((agent) => {
    const steps = stepsForAgent(pipeline, agent.id);
    const role = (pipeline.roles ?? []).find((candidate) =>
      candidate.candidateAgentIds?.includes(agent.id),
    );
    const entries: OutboundContextEntry[] = [
      {
        kind: "prompt",
        label: "Your composer message",
        detail: input.promptBytes > 0
          ? `${bytes(input.promptBytes)} of text, sent verbatim.`
          : "Sent verbatim, exactly as you typed it.",
        exact: true,
      },
      {
        kind: "instruction",
        label: "Step instructions",
        detail: steps.length > 0
          ? `Instruction text of: ${steps.join(", ")}.`
          : "This provider participates in no enabled step.",
        exact: true,
      },
      ...(role && role.instructions.trim().length > 0
        ? [{
            kind: "instruction" as const,
            label: `Role instructions: ${role.name}`,
            detail: `${bytes(Buffer.byteLength(role.instructions, "utf8"))} stored in the pipeline definition.`,
            exact: true,
          }]
        : []),
      ...input.attachments.map((attachment): OutboundContextEntry => ({
        kind: "attachment",
        label: attachment.name,
        detail: `${attachment.mimeType}, ${bytes(attachment.size)}.`,
        exact: true,
      })),
      ...(managed
        ? [
            {
              kind: "repositoryFile" as const,
              label: "Repository excerpts",
              detail: [
                input.readablePaths.length > 0
                  ? `Selected at run time from: ${input.readablePaths.join(", ")}.`
                  : "Selected at run time from the working directory.",
                input.handoffMaxBytes
                  ? `The first handoff is bounded to ${bytes(input.handoffMaxBytes)}.`
                  : "",
                input.continuationMaxBytes
                  ? `Each continuation is bounded to ${bytes(input.continuationMaxBytes)}.`
                  : "",
                "The exact file list is recorded in the run transcript as it is selected.",
              ].filter(Boolean).join(" "),
              exact: false,
            },
            {
              kind: "metadata" as const,
              label: "Task metadata",
              detail: "Task id, title, declared paths, declared checks, and the no-commit boundary.",
              exact: true,
            },
          ]
        : [
            {
              kind: "repositoryFile" as const,
              label: "Repository excerpts",
              detail: input.readablePaths.length > 0
                ? `Only what the prepared draft carries, from: ${input.readablePaths.join(", ")}.`
                : "Only what the prepared draft carries from the selected file, selection, staged diff, or diagnostic.",
              exact: false,
            },
          ]),
    ];
    return {
      agentId: agent.id,
      name: agent.name,
      adapterLabel: providerDisplayName(agent.adapter),
      transport: transportFor(agent.adapter),
      entries,
      exclusions: [
        ...(input.workingDirectory
          ? [`No repository content outside ${input.workingDirectory} is read or sent. Selected attachments are listed above and may come from outside this working directory.`]
          : ["No working directory is selected, so no repository content is sent."]),
        ...filesystemAccessStatements({
          adapter: agent.adapter,
          writeCapable: effectiveWriteCapability(pipeline, agent.id),
          protectedPaths: input.protectedPaths,
          writablePaths: input.writablePaths,
          ...(input.writeScope === undefined ? {} : { writeScope: input.writeScope }),
        }),
        ...(input.protectedPaths.length > 0
          ? [`Protected paths declared for this run: ${input.protectedPaths.join(", ")}.`]
          : []),
        "Bachata itself reads repository-owned configuration under .bachata: repository policy, verifier definitions, export policy, and pipeline definitions. Bachata needs them to build this run.",
        "Step and role instructions stored in a repository pipeline under .bachata/pipelines are rendered into this prompt on purpose. They are listed above as instruction entries.",
        "Bachata never places provider credentials, cookies, or session tokens into a prompt, a transcript, or an export, and sends them to no service of its own. The provider's own client still uses them to authenticate with the provider.",
        "Transcripts and results of other runs are never sent.",
      ],
      redactions: [
        "Outbound text is sent as written. Bachata does not rewrite what you ask a provider.",
        "Secret-shaped values are replaced with [REDACTED] in stored transcripts and in exports, not in what the provider receives.",
        "Review this manifest before sending if the repository holds material you must not disclose.",
      ],
    };
  });
};
