import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { validatePipelineDefinition } from "../pipeline/schema";
import type { PipelineDefinition } from "../pipeline/types";
import { assignmentSlots } from "../pipeline/agentAssignment";
import { pipelineDefinitionHash } from "../pipeline/identity";
import { pipelineSummary } from "../pipeline/pipelineCatalog";
import type { ConversationSummary, LocalModelConsumerState, PanelState } from "../webview/protocol";

export type ReadOnlyPipeline = {
  definition: PipelineDefinition;
  source: "preset" | "workspace";
  filePath: string;
  scopeRoot?: string;
};

const readPipelineDirectory = async (
  directory: string,
  source: ReadOnlyPipeline["source"],
  scopeRoot?: string,
): Promise<ReadOnlyPipeline[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    },
  );
  const pipelines: ReadOnlyPipeline[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const validated = validatePipelineDefinition(
        JSON.parse(await readFile(filePath, "utf8")) as unknown,
      );
      if (validated.success) {
        pipelines.push({
          definition: validated.data,
          source,
          filePath,
          ...(scopeRoot === undefined ? {} : { scopeRoot }),
        });
      }
    } catch {
      // A pipeline file a reader cannot parse is one the writer will report; a read-only
      // window lists the ones it can read rather than refusing to list any.
    }
  }
  return pipelines;
};

/**
 * The pipelines a read-only window can explain: the shipped presets plus the workspace's own
 * catalog, read from disk. Nothing is written, no lock is taken, and no adapter is probed —
 * explaining a pipeline never needs a provider.
 */
export const readOnlyPipelines = async (input: {
  extensionDirectory: string;
  workspaceRoots: readonly string[];
}): Promise<ReadOnlyPipeline[]> => {
  const presets = await readPipelineDirectory(
    path.join(input.extensionDirectory, "presets"),
    "preset",
  );
  const workspace = (await Promise.all(input.workspaceRoots.map((root) =>
    readPipelineDirectory(path.join(root, ".bachata", "pipelines"), "workspace", root))))
    .flat();
  const byId = new Map<string, ReadOnlyPipeline>();
  [...presets, ...workspace].forEach((pipeline) => {
    // A workspace pipeline shadows a preset of the same id, exactly as the writer resolves it.
    byId.set(pipeline.definition.id, pipeline);
  });
  return [...byId.values()].sort((left, right) =>
    left.definition.name.localeCompare(right.definition.name));
};

const scopedWorkspaceRoots = (
  roots: readonly string[],
  preferredRoot: string | undefined,
): string[] => preferredRoot === undefined
  ? [...roots]
  : [...roots.filter((root) => path.resolve(root) !== path.resolve(preferredRoot)), preferredRoot];

const unavailableReason = "Another Bachata window owns this repository's state.";

const readOnlyLocalModel = (): LocalModelConsumerState => ({
  enabled: false,
  discovering: false,
  status: "disabled",
  detail: "Local models are unavailable in a read-only window.",
  explicit: false,
  availableModels: [],
});

export const readOnlyPanelState = async (input: {
  conversation: ConversationSummary;
  extensionDirectory: string;
  workspaceRoots: readonly string[];
  trusted: boolean;
  browserBridgeEnabled: boolean;
  ownershipReason?: string;
  transcriptWindowSize?: number;
}): Promise<PanelState> => {
  const preferredRoot = input.conversation.pipelineScopeRoot
    ?? input.conversation.workingDirectory;
  const catalog = await readOnlyPipelines({
    extensionDirectory: input.extensionDirectory,
    workspaceRoots: scopedWorkspaceRoots(input.workspaceRoots, preferredRoot),
  });
  const summaries = catalog.map((entry) => {
    const hash = pipelineDefinitionHash(entry.definition);
    const editable = entry.source === "workspace";
    return pipelineSummary(entry.definition, editable, hash, editable
      ? {
          key: `workspace:${path.resolve(entry.scopeRoot ?? path.dirname(path.dirname(entry.filePath)))}`,
          directory: path.dirname(entry.filePath),
          ...(entry.scopeRoot === undefined ? {} : { root: entry.scopeRoot }),
        }
      : { key: "builtin", directory: path.dirname(entry.filePath) });
  });
  const selectedEntry = catalog.find((entry) =>
    entry.definition.id === input.conversation.selectedPipelineId);
  const selectedSummary = summaries.find((entry) =>
    entry.id === input.conversation.selectedPipelineId);
  const selectedPipelineHash = input.conversation.selectedPipelineHash ?? selectedSummary?.hash;
  const slots = selectedEntry === undefined
    ? { slots: [] }
    : assignmentSlots(selectedEntry.definition);
  const reason = input.ownershipReason ?? unavailableReason;
  const agents: PanelState["agents"] = Object.fromEntries((selectedEntry?.definition.agents ?? []).map((agent) => [
    agent.id,
    {
      id: agent.id,
      name: agent.name,
      adapterType: agent.adapter,
      status: "unknown",
      output: "",
    },
  ]));
  return {
    taskId: input.conversation.id,
    workspaceRoots: [...input.workspaceRoots],
    ...(input.conversation.workingDirectory === undefined
      ? {}
      : { workingDirectory: input.conversation.workingDirectory }),
    trusted: input.trusted,
    pipelines: summaries,
    ...(input.conversation.selectedPipelineId === undefined
      ? {}
      : { selectedPipelineId: input.conversation.selectedPipelineId }),
    ...(selectedEntry === undefined
      ? {}
      : { selectedPipelineDefinition: structuredClone(selectedEntry.definition) }),
    ...(selectedPipelineHash === undefined ? {} : { selectedPipelineHash }),
    ...(input.conversation.participants === undefined
      ? {}
      : { executionParticipants: structuredClone(input.conversation.participants) }),
    readiness: {
      ...(input.conversation.selectedPipelineId === undefined
        ? {}
        : { pipelineId: input.conversation.selectedPipelineId }),
      status: "blocked",
      findings: [{
        id: "workspace-read-only",
        label: "Read-only window",
        status: "blocked",
        detail: reason,
      }],
    },
    pipelineScopeKey: selectedSummary?.scopeKey
      ?? (preferredRoot === undefined ? "builtin" : `workspace:${path.resolve(preferredRoot)}`),
    ...(selectedSummary?.scopeRoot === undefined ? {} : { pipelineScopeRoot: selectedSummary.scopeRoot }),
    pipelineMutable: false,
    pipelineMutationReason: reason,
    advancedMode: false,
    browserActionPolicies: {
      readOnly: "ask",
      mutation: "ask",
      destructive: "ask",
      shell: "disabled",
    },
    adapterTypes: [],
    agents,
    agentAssignments: {
      slots: slots.slots.map((slot) => ({
        ...slot,
        assignedAdapter: slot.defaultAdapter,
        ...(slot.defaultModel === undefined ? {} : { assignedModel: slot.defaultModel }),
        overridden: false,
      })),
      assignableAdapters: [],
      availableAdapters: [],
      discovering: false,
      adapterModels: {},
      ...(slots.constraint === undefined ? {} : { constraint: slots.constraint }),
      lockReason: reason,
      modelLockReason: reason,
    },
    localModels: {
      semanticInterpreter: readOnlyLocalModel(),
      selectorHealing: readOnlyLocalModel(),
    },
    roles: {},
    running: false,
    workflowStatus: input.conversation.workflowStatus,
    transcript: [],
    transcriptTotal: 0,
    transcriptHasMore: false,
    transcriptWindowSize: Math.max(50, input.transcriptWindowSize ?? 300),
    approvals: [],
    attachments: [],
    maxAttachmentBytes: 20_971_520,
    maxAttachmentCount: 20,
    maxAttachmentTotalBytes: 52_428_800,
    browserBridge: {
      enabled: input.browserBridgeEnabled,
      connected: false,
      sessions: [],
      error: "Browser Bridge controls are unavailable in a read-only window.",
    },
    queuedMessages: [],
    queuePaused: false,
  };
};
