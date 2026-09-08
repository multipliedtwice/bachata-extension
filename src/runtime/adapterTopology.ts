import { setOptionalProperty } from "../state/optionalProperty";
import { AgentAdapter } from "../adapters/types";
import { AgentDefinition } from "../pipeline/types";
import { AgentPanelState } from "../webview/protocol";
import { BrowserConversationBinding } from "../browser/protocol";
import { ProviderEnvironmentProfile } from "../process/safeEnvironment";

export type PersistedAgentState = Pick<
  AgentPanelState,
  "version" | "sessionId" | "browserBinding"
>;

/**
 * One pipeline's worth of live adapters, the definitions they were built from, and the panel state
 * the editor shows for each. The three always move together: an adapter without its definition
 * cannot be disposed by the same rule that built it, and panel state without its adapter describes
 * an agent nothing can run.
 */
export type AdapterTopology = {
  adapters: Record<string, AgentAdapter>;
  definitions: Record<string, AgentDefinition>;
  agents: Record<string, AgentPanelState>;
};

const commandSettings: Record<string, { setting: string; fallback: string }> = {
  "codex-app-server": { setting: "codexCommand", fallback: "codex" },
  "claude-code": { setting: "claudeCommand", fallback: "claude" },
  "zai-glm": { setting: "zaiCommand", fallback: "claude" },
};

/**
 * The definition an adapter is actually built from: the pipeline's, with the executable replaced by
 * the user's configured command where the adapter has one. A pipeline names a provider; which
 * binary answers for it on this machine is a setting, not part of the pipeline.
 */
export const effectiveAgentDefinition = (
  definition: AgentDefinition,
  readSetting: (settingKey: string, fallback: string) => string,
): AgentDefinition => {
  const command = commandSettings[definition.adapter];
  return command === undefined
    ? definition
    : {
        ...definition,
        command: readSetting(command.setting, definition.command ?? command.fallback),
      };
};

export type ProviderEnvironmentRequest = {
  adapterType: string;
  workingDirectory: string;
  sharedVariables: readonly string[];
  profile?: ProviderEnvironmentProfile;
};

export type ZaiEnvironmentSettings = {
  variables: string[];
  credentialSourceVariable: string;
  baseUrl: string;
};

/**
 * Which environment profile a provider is given. Only the ZAI adapter carries one: it needs its
 * own variable allowlist, and its API key is read from a variable the user names and handed to the
 * adapter under the name the Anthropic client expects. Every other provider gets the shared
 * allowlist and nothing else, so a credential belonging to one provider cannot reach another.
 */
export const providerEnvironmentRequest = (input: {
  adapterType: string;
  workingDirectory: string;
  sharedVariables: readonly string[];
  zai: ZaiEnvironmentSettings;
}): ProviderEnvironmentRequest => {
  const base = {
    adapterType: input.adapterType,
    workingDirectory: input.workingDirectory,
    sharedVariables: input.sharedVariables,
  };
  return input.adapterType === "zai-glm"
    ? {
        ...base,
        profile: {
          adapterType: input.adapterType,
          variables: input.zai.variables,
          credential: {
            sourceVariable: input.zai.credentialSourceVariable,
            targetVariable: "ANTHROPIC_AUTH_TOKEN",
          },
          values: { ANTHROPIC_BASE_URL: input.zai.baseUrl },
        },
      }
    : base;
};

export const agentStateForDefinition = (
  definition: AgentDefinition,
  persistedAgent?: PersistedAgentState,
): AgentPanelState => ({
  id: definition.id,
  name: definition.name,
  adapterType: definition.adapter,
  status: persistedAgent?.sessionId || persistedAgent?.browserBinding
    ? "idle"
    : persistedAgent?.version
      ? "available"
      : "unknown",
  ...(persistedAgent?.version === undefined ? {} : { version: persistedAgent.version }),
  ...(persistedAgent?.sessionId === undefined ? {} : { sessionId: persistedAgent.sessionId }),
  ...(persistedAgent?.browserBinding === undefined
    ? {}
    : { browserBinding: persistedAgent.browserBinding }),
  output: "",
});

const isBrowserAdapter = (adapterType: string): boolean => adapterType.endsWith("-browser");

export type BrowserBindingHost = {
  ownerIdFor: (agentId: string) => string;
  bindConversation: (ownerId: string, binding: BrowserConversationBinding) => void;
  bindSession: (ownerId: string, sessionId: string) => BrowserConversationBinding;
  releaseBinding: (ownerId: string) => void;
  resolveBoundSession: (
    ownerId: string,
    binding: BrowserConversationBinding,
    sessionId?: string,
  ) => { id: string; status: string } | undefined;
};

/**
 * Reattach every browser agent in a topology to the conversation it was persisted against, in
 * place. A binding that no longer resolves leaves the agent visible and explained rather than
 * silently ready, and a binding that throws clears the stale session id instead of keeping an id
 * nothing answers for.
 */
export const bindBrowserAgents = (
  topology: AdapterTopology,
  host: BrowserBindingHost,
): void => {
  Object.entries(topology.definitions).forEach(([agentId, definition]) => {
    if (!isBrowserAdapter(definition.adapter)) {
      return;
    }
    const agentState = topology.agents[agentId];
    if (!agentState) {
      return;
    }
    try {
      const ownerId = host.ownerIdFor(agentId);
      if (agentState.browserBinding) {
        host.bindConversation(ownerId, agentState.browserBinding);
        const liveSession = host.resolveBoundSession(
          ownerId,
          agentState.browserBinding,
          agentState.sessionId,
        );
        setOptionalProperty(agentState, "sessionId", liveSession?.id);
        agentState.status = liveSession?.status === "ready" ? "idle" : "unknown";
        agentState.error = liveSession
          ? undefined
          : "The bound browser conversation is not currently available";
      } else if (agentState.sessionId) {
        agentState.browserBinding = host.bindSession(ownerId, agentState.sessionId);
      }
    } catch (error) {
      agentState.status = "error";
      agentState.error = error instanceof Error ? error.message : String(error);
      delete agentState.sessionId;
    }
  });
};

export const releaseBrowserBindings = (
  topology: AdapterTopology,
  host: Pick<BrowserBindingHost, "ownerIdFor" | "releaseBinding">,
): void => {
  Object.entries(topology.definitions).forEach(([agentId, definition]) => {
    if (isBrowserAdapter(definition.adapter)) {
      host.releaseBinding(host.ownerIdFor(agentId));
    }
  });
};

/**
 * Dispose every adapter in a topology and return the failures rather than raising the first one.
 * A provider that will not shut down must not stop the others from being asked.
 */
export const disposeTopology = async (topology: AdapterTopology): Promise<unknown[]> => {
  const results = await Promise.allSettled(
    Object.values(topology.adapters).map((adapter) => adapter.dispose()),
  );
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
};

export type TopologyBuildHost = {
  effectiveDefinition: (definition: AgentDefinition) => AgentDefinition;
  createAdapter: (definition: AgentDefinition) => AgentAdapter;
  onCandidateFailure: (candidate: AdapterTopology) => Promise<unknown[]>;
};

/**
 * Build a whole topology or none of it. Adapters are constructed into a candidate that nothing
 * else can see, so a provider that fails to start halfway leaves the runtime on the topology it
 * already had rather than on a half-replaced one. The candidate's own adapters are disposed on the
 * way out, and a cleanup that also fails is reported alongside the original cause instead of
 * replacing it — losing the reason the build failed is worse than reporting two.
 */
export const buildAdapterTopology = async (
  agents: readonly AgentDefinition[],
  persistedAgents: Record<string, PersistedAgentState>,
  host: TopologyBuildHost,
): Promise<AdapterTopology> => {
  const candidate: AdapterTopology = { adapters: {}, definitions: {}, agents: {} };
  try {
    for (const original of agents) {
      const definition = host.effectiveDefinition(original);
      candidate.definitions[definition.id] = definition;
      candidate.adapters[definition.id] = host.createAdapter(definition);
      candidate.agents[definition.id] = agentStateForDefinition(
        definition,
        persistedAgents[definition.id],
      );
    }
    return candidate;
  } catch (error) {
    const cleanupFailures = await host.onCandidateFailure(candidate);
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Pipeline adapter preparation failed and candidate cleanup was incomplete",
      );
    }
    throw error;
  }
};

const carriedAgentFields = (agent: AgentPanelState): PersistedAgentState => ({
  ...(agent.version === undefined ? {} : { version: agent.version }),
  ...(agent.sessionId === undefined ? {} : { sessionId: agent.sessionId }),
  ...(agent.browserBinding === undefined ? {} : { browserBinding: agent.browserBinding }),
});

/** Everything a restart may carry forward: the provider version and any live conversation. */
export const persistedAgentsFrom = (
  agents: Record<string, AgentPanelState>,
): Record<string, PersistedAgentState> =>
  Object.fromEntries(
    Object.entries(agents).map(([agentId, agent]) => [agentId, carriedAgentFields(agent)]),
  );

/** A deliberate fresh start: the provider version survives, no conversation does. */
export const freshAgentsFrom = (
  agents: Record<string, AgentPanelState>,
): Record<string, PersistedAgentState> =>
  Object.fromEntries(
    Object.entries(agents).map(([agentId, agent]) => [agentId, { version: agent.version }]),
  );

/**
 * A reset keeps browser conversations and drops local ones. A browser conversation lives in a tab
 * the user still has open and is not this extension's to end; a local provider session is a child
 * process that a reset is entitled to replace.
 */
export const resetAgentsFrom = (
  agents: Record<string, AgentPanelState>,
): Record<string, PersistedAgentState> =>
  Object.fromEntries(
    Object.entries(agents).map(([agentId, agent]) => [
      agentId,
      {
        ...(agent.version === undefined ? {} : { version: agent.version }),
        ...(isBrowserAdapter(agent.adapterType)
          ? { sessionId: agent.sessionId, browserBinding: agent.browserBinding }
          : {}),
      },
    ]),
  );

/**
 * EX-3. What a bridge status means for one browser agent, apart from binding it.
 *
 * Every bridge status change re-derives each browser agent's panel status and error from the same
 * facts: whether the bridge is connected, whether the agent holds a binding, what the session that
 * binding resolved to is doing, whether resolving it failed, and whether any session of the
 * agent's provider is ready to be picked. The rule was inside the fan-out loop that also binds
 * sessions and posts patches, so each of its eight outcomes could only be seen through a bridge.
 */
export type BrowserAgentBridgeStatus = {
  status: "idle" | "available" | "error" | "unknown";
  error?: string | undefined;
};

export const browserAgentBridgeStatus = (input: {
  connected: boolean;
  bridgeError?: string | undefined;
  hasBinding: boolean;
  boundSessionStatus?: string | undefined;
  bindingError?: string | undefined;
  readySessionCount: number;
  providerName: string;
}): BrowserAgentBridgeStatus => {
  const boundReady = input.boundSessionStatus === "ready";
  const boundFailed = input.boundSessionStatus === "failed";
  const status = input.connected && boundReady
    ? "idle"
    : input.connected && !input.hasBinding && input.readySessionCount > 0
      ? "available"
      : boundFailed || input.bindingError !== undefined
        ? "error"
        : "unknown";
  const error =
    input.bindingError ??
    input.bridgeError ??
    (input.hasBinding && input.boundSessionStatus === undefined
      ? "The bound browser conversation is not currently available"
      : boundFailed
        ? `${input.providerName} browser conversation failed`
        : undefined);
  return { status, error };
};

/** The binding a ready session implies: its conversation, and the tab it was seen in. */
export const bindingFromSession = (session: {
  provider: BrowserConversationBinding["provider"];
  conversationUrl: string;
  conversationIdentity: string;
  tabId: number;
}): BrowserConversationBinding => ({
  provider: session.provider,
  conversationUrl: session.conversationUrl,
  conversationIdentity: session.conversationIdentity,
  preferredTabId: session.tabId,
});
