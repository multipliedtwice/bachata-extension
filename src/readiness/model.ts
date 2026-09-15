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
  | "workspace.selectRepository"
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
    /**
     * Whether the selected root is a Git repository. `false` is a different blocker from an absent
     * Git and takes a different remedy: the repository is often a child of the folder that is
     * open, and the reader has to be able to point Bachata at it.
     */
    gitRepository?: boolean | undefined;
    /**
     * The root under which Bachata's own managed worktrees live, when this runtime has one.
     *
     * A task worktree is outside every open workspace folder by construction, and running there
     * is the point of it, so the selected-root check has to know it is legitimate.
     */
    managedRoot?: string | undefined;
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

/**
 * Whether the root this run is pointed at is inside the window's open workspace.
 *
 * A folder holding two checkouts is an ordinary layout, and pointing a run at one of them is the
 * documented remedy for "the selected folder is not a Git repository". Requiring the selected
 * root to be an open root exactly refused that remedy: the reader picked the repository, and
 * readiness answered that the repository was not open.
 */
const selectedRootIsOpen = (selectedRoot: string, roots: readonly string[]): boolean => {
  const trimmed = selectedRoot.replace(/[\\/]+$/u, "");
  return roots.some((root) => {
    const base = root.replace(/[\\/]+$/u, "");
    if (base.length === 0) return false;
    return trimmed === base || trimmed.startsWith(`${base}/`) || trimmed.startsWith(`${base}\\`);
  });
};

export const evaluateReadiness = (input: ReadinessInput): PipelineReadiness => {
  const findings: ReadinessFinding[] = [];
  if (input.workspace.roots.length === 0) {
    findings.push(finding("workspace.root", "Workspace", "blocked", "Open a workspace folder", "workspace.open"));
  } else if (!input.workspace.trusted) {
    findings.push(finding("workspace.trust", "Workspace trust", "blocked", "Trust is required before a pipeline can run", "workspace.trust"));
  } else {
    findings.push(finding("workspace", "Workspace", "ready", input.workspace.roots.join(", ")));
  }
  if (
    input.selectedRoot &&
    !selectedRootIsOpen(input.selectedRoot, [
      ...input.workspace.roots,
      ...(input.workspace.managedRoot === undefined ? [] : [input.workspace.managedRoot]),
    ])
  ) {
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
  const requiresCleanGit = pipeline.steps.some((step) => step.enabled && step.type === "executeChecklist");
  const requiresGit = requiresCleanGit || pipeline.managedPolicy !== undefined;
  // Git answered but the selected root holds no repository. Naming that as "Git is unavailable"
  // sent the reader to install a Git they already have; the root is what has to change.
  const rootIsNotARepository = input.workspace.gitAvailable === false &&
    input.workspace.gitRepository === false;
  findings.push(input.workspace.gitAvailable === true
    ? finding("git", "Git", "ready", input.workspace.gitDetail ?? "Available")
    : requiresGit && rootIsNotARepository
      ? finding(
          "git",
          "Git",
          "blocked",
          input.selectedRoot === undefined
            ? "The selected folder is not a Git repository"
            : `${input.selectedRoot} is not a Git repository`,
          "workspace.selectRepository",
        )
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
  if (requiresCleanGit && input.workspace.gitAvailable === true && blockingDirtyPaths) {
    findings.push(finding(
      "git.clean",
      "Git workspace",
      "blocked",
      "Checklist execution creates worktrees from HEAD; commit or stash changes before running that step",
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
      && (input.codexWorkspaceScope ?? "wholeWorkingDirectory") !== "wholeWorkingDirectory"
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

/**
 * The findings that must stop a run, as opposed to the ones a reader may still be waiting on.
 *
 * `blocked` was the whole test, and it let a browser pipeline start with no bridge connected and no
 * session selected. Those are reported as `needsSetup`, which describes the remedy — it was never a
 * statement that the requirement is optional — and the run reached the participants anyway, where
 * it failed on a transport nobody could have supplied by then.
 *
 * A local provider's availability is deliberately not treated this way. It is transient in both
 * directions: the host may still be discovering it, and one refused turn is not a provider that
 * has gone away. The run's own preflight validates the capabilities the pipeline needs against the
 * adapters it actually built, which is the later, and truer, answer.
 */
export const runBlockingFindings = (
  findings: readonly ReadinessFinding[],
  options: { participatingAgentIds?: readonly string[] | undefined } = {},
): ReadinessFinding[] => {
  const participants = options.participatingAgentIds === undefined
    ? undefined
    : new Set(options.participatingAgentIds);
  const aboutAParticipant = (id: string): boolean => {
    const agentId = /^(?:adapter|bridge)\.(.+)$/u.exec(id)?.[1];
    // A finding about a provider that no enabled step runs is not this run's problem. A pipeline
    // names every provider it could use — a browser candidate for a role filled by a local agent,
    // for one — and refusing on those would refuse every run on a machine without a bridge.
    return agentId === undefined || participants === undefined || participants.has(agentId);
  };
  return findings.filter((entry) =>
    aboutAParticipant(entry.id) &&
    (entry.status === "blocked" ||
      entry.status === "unsupported" ||
      (entry.status === "needsSetup" && entry.id.startsWith("bridge."))));
};

/**
 * The providers an enabled step will actually hand a turn to.
 *
 * A role that is statically assigned resolves to its agent. A role that is not is deliberately left
 * out: none of its candidates is yet the participant, so a requirement missing on one of them is
 * not a requirement missing for this run.
 */
export const participatingAgentIds = (pipeline: PipelineDefinition): string[] => {
  const assigned = new Map<string, string>();
  pipeline.steps.forEach((step) => {
    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => assigned.set(assignment.role, assignment.agentId));
    }
  });
  const roleIds = new Set((pipeline.roles ?? []).map((role) => role.id));
  const participants = new Set<string>();
  pipeline.steps.forEach((step) => {
    if (!step.enabled) return;
    if (step.type !== "agent" && step.type !== "checklist") return;
    step.participants.forEach((participant) => {
      const viaRole = assigned.get(participant);
      if (viaRole !== undefined) {
        participants.add(viaRole);
        return;
      }
      if (roleIds.has(participant)) return;
      participants.add(participant);
    });
  });
  return Array.from(participants);
};

export const recommendedPipelineId = (
  catalog: PipelineDefinition[],
  adapters: AdapterReadiness[],
): string | undefined => {
  const available = new Set(adapters.filter((adapter) => adapter.available).map((adapter) => adapter.type));
  const preferred = ["review", "review-only"];
  return preferred.find((id) => {
    const pipeline = catalog.find((candidate) => candidate.id === id);
    return pipeline?.agents.every((agent) => available.has(agent.adapter));
  }) ?? catalog.find((pipeline) => pipeline.agents.every((agent) => available.has(agent.adapter)))?.id;
};
