import type { BrowserSession, BrowserSessionCapabilities } from "../browser/protocol";
import type { PipelineDefinition } from "../pipeline/types";
import { describeCapabilities } from "../pipeline/capabilities";
import { relativePathWithinDirectory } from "./paths";
import type { CodexWorkspaceScope } from "../adapters/codexWire";

export type ReadinessStatus = "ready" | "blocked" | "needsSetup" | "unsupported";

export type ReadinessRemediationId =
  | "workspace.open"
  | "workspace.trust"
  | "git.install"
  | "doctor.run"
  | "provider.install.codex"
  | "provider.install.claude"
  | "provider.install.zai"
  | "bridge.useLocalWindow"
  | "bridge.connect"
  | "bridge.selectSession"
  | "pipeline.select"
  | "pipeline.chooseSupported"
  | "provider.enable"
  | "provider.readScope";

export type ReadinessFinding = {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  remediationId?: ReadinessRemediationId;
};

export type AdapterReadiness = {
  agentId?: string;
  type: string;
  available: boolean;
  capabilities?: string[];
  detail?: string;
};

export type BridgeReadiness = {
  enabled: boolean;
  connected: boolean;
  selectedSessionId?: string;
  sessions: BrowserSession[];
  error?: string;
};

export type ReadinessInput = {
  workspace: {
    trusted: boolean;
    roots: string[];
    gitAvailable?: boolean | undefined;
    gitDetail?: string | undefined;
    gitClean?: boolean | undefined;
    dirtyPaths?: string[] | undefined;
  };
  adapters: AdapterReadiness[];
  bridge: BridgeReadiness;
  remoteName?: string | undefined;
  selectedRoot?: string | undefined;
  catalogError?: string | undefined;
  browserBindings?: Record<string, string | undefined> | undefined;
  disabledProviders?: string[] | undefined;
  codexWorkspaceScope?: CodexWorkspaceScope | undefined;
  catalog: PipelineDefinition[];
  selectedPipelineId?: string | undefined;
  allowedDirtyPaths?: string[] | undefined;
};

export type PipelineReadiness = {
  pipelineId?: string;
  status: ReadinessStatus;
  findings: ReadinessFinding[];
};

const statusRank: Record<ReadinessStatus, number> = {
  ready: 0,
  needsSetup: 1,
  blocked: 2,
  unsupported: 3,
};

const combineStatus = (findings: ReadinessFinding[]): ReadinessStatus =>
  findings.reduce<ReadinessStatus>(
    (result, finding) => statusRank[finding.status] > statusRank[result] ? finding.status : result,
    "ready",
  );

const providerRemediation = (adapter: string): ReadinessRemediationId | undefined => {
  if (adapter === "codex-app-server") return "provider.install.codex";
  if (adapter === "claude-code") return "provider.install.claude";
  if (adapter === "zai-glm") return "provider.install.zai";
  return undefined;
};

const browserProvider = (adapter: string): BrowserSession["provider"] | undefined => {
  if (adapter === "chatgpt-browser") return "chatgpt";
  if (adapter === "claude-browser") return "claude";
  if (adapter === "generic-browser") return "generic";
  return undefined;
};

const capabilitiesReady = (
  capabilities: BrowserSessionCapabilities | undefined,
  provider?: BrowserSession["provider"],
): boolean => {
  if (capabilities === undefined) return false;
  if (provider === "generic") {
    return capabilities.submission === "verifiedSend" &&
      capabilities.completion === "verifiedLifecycle" &&
      capabilities.interruption === "confirmed" &&
      capabilities.conversationState === "confirmed";
  }
  return capabilities.completion !== "manualOnly" &&
    capabilities.conversationState !== "uncertain";
};

const dirtyPathAllowed = (candidate: string, allowed: string[]): boolean =>
  allowed.some((prefix) => relativePathWithinDirectory(prefix, candidate));

const finding = (
  id: string,
  label: string,
  status: ReadinessStatus,
  detail: string,
  remediationId?: ReadinessRemediationId,
): ReadinessFinding => ({
  id,
  label,
  status,
  detail,
  ...(remediationId === undefined ? {} : { remediationId }),
});

export const evaluateReadiness = (input: ReadinessInput): PipelineReadiness => {
  const findings: ReadinessFinding[] = [];
  if (input.workspace.roots.length === 0) {
    findings.push(finding("workspace.root", "Workspace", "blocked", "Open a workspace folder", "workspace.open"));
  } else if (!input.workspace.trusted) {
    findings.push(finding("workspace.trust", "Workspace trust", "blocked", "Trust is required before a pipeline can run", "workspace.trust"));
  } else {
    findings.push(finding("workspace", "Workspace", "ready", input.workspace.roots.join(", ")));
  }
  if (input.selectedRoot && !input.workspace.roots.includes(input.selectedRoot)) {
    findings.push(finding("workspace.selectedRoot", "Selected root", "blocked", "The selected root is not open", "workspace.open"));
  }
  if (input.catalogError) {
    findings.push(finding("catalog", "Pipeline catalog", "blocked", input.catalogError, "pipeline.chooseSupported"));
  }

  const pipeline = input.catalog.find((candidate) => candidate.id === input.selectedPipelineId);
  if (!pipeline) {
    findings.push(finding("pipeline", "Pipeline", "needsSetup", "Choose a pipeline", "pipeline.select"));
    return {
      ...(input.selectedPipelineId === undefined ? {} : { pipelineId: input.selectedPipelineId }),
      status: combineStatus(findings),
      findings,
    };
  }
  const requiresGit = pipeline.steps.some((step) => step.type === "executeChecklist") || pipeline.managedPolicy !== undefined;
  findings.push(input.workspace.gitAvailable === true
    ? finding("git", "Git", "ready", input.workspace.gitDetail ?? "Available")
    : requiresGit && input.workspace.gitAvailable === false
      ? finding("git", "Git", "blocked", input.workspace.gitDetail ?? "Git is unavailable", "git.install")
      : requiresGit && input.workspace.gitAvailable === undefined
        ? finding("git", "Git", "needsSetup", input.workspace.gitDetail ?? "Run Doctor to verify Git", "doctor.run")
        : finding("git", "Git", "ready", input.workspace.gitDetail ?? "Not required by this pipeline"));
  const blockingDirtyPaths = input.workspace.gitClean === false &&
    (input.workspace.dirtyPaths === undefined ||
      input.workspace.dirtyPaths.some(
        (candidate) => !dirtyPathAllowed(candidate, input.allowedDirtyPaths ?? []),
      ));
  if (requiresGit && input.workspace.gitAvailable === true && blockingDirtyPaths) {
    findings.push(finding(
      "git.clean",
      "Git workspace",
      "blocked",
      "Commit, stash, or remove workspace changes before managed execution",
      "doctor.run",
    ));
  }

  const assignedRoles = new Map<string, string>();
  pipeline.steps.forEach((step) => {
    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => assignedRoles.set(assignment.role, assignment.agentId));
    }
  });
  const requiredCapabilities = (agentId: string): string[] => {
    const required = new Set(pipeline.agents.find((agent) => agent.id === agentId)?.capabilities ?? []);
    pipeline.roles?.forEach((role) => {
      if (assignedRoles.get(role.id) === agentId || role.candidateAgentIds?.includes(agentId)) {
        role.requiredCapabilities?.forEach((capability) => required.add(capability));
      }
    });
    pipeline.steps.forEach((step) => {
      if (step.type !== "agent" && step.type !== "checklist") return;
      const participates = step.participants.some((participant) =>
        participant === agentId || assignedRoles.get(participant) === agentId,
      );
      if (participates) step.requiredCapabilities?.forEach((capability) => required.add(capability));
    });
    return Array.from(required);
  };
  pipeline.agents.forEach((agent) => {
    if (input.disabledProviders?.includes(agent.adapter)) {
      findings.push(finding(
        `adapter.${agent.id}`,
        agent.name,
        "unsupported",
        `${agent.name} (${agent.adapter}) is disabled in bachata.disabledProviders`,
        "provider.enable",
      ));
      return;
    }
    if (
      agent.adapter === "codex-app-server"
      && (input.codexWorkspaceScope ?? "refuseNarrowedScope") !== "wholeWorkingDirectory"
    ) {
      findings.push(finding(
        `adapter.${agent.id}`,
        agent.name,
        "blocked",
        `${agent.name} (${agent.adapter}) cannot withhold version-control, credential or bachata-internal paths:`
        + " the installed Codex app-server protocol has no per-path readable-root capability",
        "provider.readScope",
      ));
      return;
    }
    const provider = browserProvider(agent.adapter);
    if (!provider) {
      const agentRecord = input.adapters.find((candidate) => candidate.agentId === agent.id);
      const probeRecord = input.adapters.find(
        (candidate) => !candidate.agentId && candidate.type === agent.adapter,
      );
      const adapter = agentRecord && probeRecord
        ? {
            ...agentRecord,
            available: agentRecord.available ||
              (probeRecord.available && agentRecord.detail === undefined),
            capabilities: agentRecord.capabilities?.length
              ? agentRecord.capabilities
              : probeRecord.capabilities,
            detail: agentRecord.detail ?? probeRecord.detail,
          }
        : agentRecord ?? probeRecord;
      const missingCapabilities = requiredCapabilities(agent.id).filter(
        (capability) => !adapter?.capabilities?.includes(capability),
      );
      findings.push(adapter?.available && missingCapabilities.length === 0
        ? finding(`adapter.${agent.id}`, agent.name, "ready", adapter.detail ?? `${agent.adapter} available`)
        : finding(
            `adapter.${agent.id}`,
            agent.name,
            "needsSetup",
            missingCapabilities.length > 0
              ? `${agent.name} (${agent.adapter}) cannot provide ${describeCapabilities(missingCapabilities)} in this workspace`
              : adapter?.detail ?? `${agent.adapter} is unavailable or not installed`,
            providerRemediation(agent.adapter) ?? "pipeline.chooseSupported",
          ));
      return;
    }
    if (input.remoteName || !input.bridge.enabled) {
      findings.push(finding(
        `bridge.${agent.id}`,
        agent.name,
        "unsupported",
        "Browser providers require a local VS Code window",
        "bridge.useLocalWindow",
      ));
      return;
    }
    if (!input.bridge.connected) {
      findings.push(finding(`bridge.${agent.id}`, agent.name, "needsSetup", "Connect the Browser Bridge", "bridge.connect"));
      return;
    }
    const bindingId = input.browserBindings?.[agent.id] ?? input.bridge.selectedSessionId;
    const selected = input.bridge.sessions.find((session) =>
      session.id === bindingId && session.provider === provider,
    );
    if (!selected) {
      findings.push(finding(`bridge.${agent.id}`, agent.name, "needsSetup", `Select a ready ${provider} browser session`, "bridge.selectSession"));
      return;
    }
    const sessionCapabilities = [
      ...(selected.capabilities ? ["browserSessionSelection"] : []),
      ...(capabilitiesReady(selected.capabilities, provider) ? ["passiveActionLoop"] : []),
    ];
    const missingCapabilities = requiredCapabilities(agent.id).filter(
      (capability) => !sessionCapabilities.includes(capability),
    );
    findings.push(selected.status === "ready" && capabilitiesReady(selected.capabilities, provider) && missingCapabilities.length === 0
      ? finding(`bridge.${agent.id}`, agent.name, "ready", "Browser session ready")
      : finding(
          `bridge.${agent.id}`,
          agent.name,
          "needsSetup",
          missingCapabilities.length > 0
            ? `The selected ${provider} conversation cannot provide ${describeCapabilities(missingCapabilities)}`
            : provider === "generic" && selected.status === "ready"
              ? "The generic browser conversation must report verified Send, verified completion lifecycle, confirmed interruption, and confirmed conversation state"
              : "Selected browser session is not ready",
          "bridge.selectSession",
        ));
  });

  return { pipelineId: pipeline.id, status: combineStatus(findings), findings };
};

export const recommendedPipelineId = (
  catalog: PipelineDefinition[],
  adapters: AdapterReadiness[],
): string | undefined => {
  const available = new Set(adapters.filter((adapter) => adapter.available).map((adapter) => adapter.type));
  const preferred = ["codex-review", "claude-review"];
  return preferred.find((id) => {
    const pipeline = catalog.find((candidate) => candidate.id === id);
    return pipeline?.agents.every((agent) => available.has(agent.adapter));
  }) ?? catalog.find((pipeline) => pipeline.agents.every((agent) => available.has(agent.adapter)))?.id;
};
