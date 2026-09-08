import { MAXIMUM_TIMEOUT_MS } from "../state/timeoutBounds";
export type SettingsReader = <T>(key: string, fallback: T) => T;

export type RunSettingValue = string | number | boolean | string[];

export type RunSettingKind = "string" | "number" | "boolean" | "stringList";

export type RunSettingDeclaration = {
  key: string;
  kind: RunSettingKind;
  fallback: RunSettingValue;
  allowed?: readonly string[];
  minimum?: number;
  maximum?: number;
  secretReference?: boolean;
};

export type RunSettingRejection = {
  key: string;
  reason: string;
};

export type RunSettingsSnapshot = {
  schema: "bachata.run-settings.v1";
  values: Record<string, RunSettingValue>;
  recorded: Record<string, RunSettingValue>;
  authority: Record<string, RunSettingValue>;
  secretReferences: string[];
};

// Four classes, decided per setting from where the setting is actually read.
//
// pinned      read through the runtime's one configuration accessor, so a run can execute on
//             the value it started with. Restored on resume and replay.
// recorded    behaviour-affecting, but read at activation time or by the orchestrator and the
//             conversation manager, which the accessor never sees. Recorded so a run states
//             what it ran under; never restored, because restoring it would be a promise the
//             read site cannot keep.
// authority   safety and authority controls: approval policies, permission modes, provider
//             enablement, path and network gates. Recorded, never restored, so withdrawing one
//             takes effect at once — including on a resumed run.
// interface   presentation, retention and admission limits. They do not decide what a run does,
//             so they are neither pinned nor recorded.
export const pinnedRunSettings: readonly RunSettingDeclaration[] = [
  { key: "defaultPipelineIterations", kind: "number", fallback: 1, minimum: 1, maximum: 10 },
  { key: "maxPipelineIterations", kind: "number", fallback: 10, minimum: 1, maximum: 50 },
  { key: "browserOperationTimeoutMs", kind: "number", fallback: 1_800_000, minimum: 10_000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "browserActionMaxRounds", kind: "number", fallback: 32, minimum: 1, maximum: 100 },
  {
    key: "browserManagedConversationMaxBytes",
    kind: "number",
    fallback: 8_388_608,
    minimum: 262_144,
    maximum: 33_554_432,
  },
  { key: "browserActionMaxActions", kind: "number", fallback: 64, minimum: 1, maximum: 1000 },
  { key: "browserActionTimeoutMs", kind: "number", fallback: 120_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "managedTaskTimeoutMs",
    kind: "number",
    fallback: 7_200_000,
    minimum: 60_000,
    maximum: 28_800_000,
  },
  {
    key: "managedContinuationMaxBytes",
    kind: "number",
    fallback: 524_288,
    minimum: 65_536,
    maximum: 1_048_576,
  },
  {
    key: "browserHandoffTotalBudgetBytes",
    kind: "number",
    fallback: 262_144,
    minimum: 16_384,
    maximum: 512_000,
  },
  { key: "browserContextDependencyDepth", kind: "number", fallback: 2, minimum: 0, maximum: 5 },
  {
    key: "browserContextPromotionMaxBytes",
    kind: "number",
    fallback: 786_432,
    minimum: 65_536,
    maximum: 8_388_608,
  },
  {
    key: "browserActionMaxOutputBytes",
    kind: "number",
    fallback: 1_048_576,
    minimum: 65_536,
    maximum: 8_388_608,
  },
  {
    key: "browserActionMaxReadBytes",
    kind: "number",
    fallback: 1_048_576,
    minimum: 65_536,
    maximum: 8_388_608,
  },
  {
    key: "browserActionMaxSearchResults",
    kind: "number",
    fallback: 500,
    minimum: 10,
    maximum: 10_000,
  },
  {
    key: "browserSelectorHealingBackend",
    kind: "string",
    fallback: "auto",
    allowed: ["auto", "lmstudio", "ollama"],
  },
  { key: "browserSelectorHealingModel", kind: "string", fallback: "prism-ml/Bonsai-27B-mlx-1bit" },
  { key: "browserSelectorHealingTimeoutMs", kind: "number", fallback: 30_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "browserSemanticInterpreterBackend",
    kind: "string",
    fallback: "auto",
    allowed: ["auto", "lmstudio", "ollama"],
  },
  { key: "browserSemanticInterpreterModel", kind: "string", fallback: "prism-ml/Bonsai-27B-mlx-1bit" },
  { key: "browserSemanticInterpreterTimeoutMs", kind: "number", fallback: 30_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "browserSemanticInterpreterMaxInputBytes",
    kind: "number",
    fallback: 262_144,
    minimum: 16_384,
    maximum: 1_048_576,
  },
  {
    key: "browserContextInventoryMaxFiles",
    kind: "number",
    fallback: 100_000,
    minimum: 5000,
    maximum: 1_000_000,
  },
  {
    key: "browserContextInventoryTimeoutMs",
    kind: "number",
    fallback: 30_000,
    minimum: 1000,
    maximum: 120_000,
  },
  {
    key: "browserContextIndexTimeoutMs",
    kind: "number",
    fallback: 30_000,
    minimum: 1000,
    maximum: 120_000,
  },
  {
    key: "browserContextSearchMaxFiles",
    kind: "number",
    fallback: 5000,
    minimum: 1,
    maximum: 100_000,
  },
  {
    key: "browserContextSearchMaxBytes",
    kind: "number",
    fallback: 67_108_864,
    minimum: 1_048_576,
    maximum: 1_073_741_824,
  },
  {
    key: "browserContextSearchMaxFileBytes",
    kind: "number",
    fallback: 8_388_608,
    minimum: 1_048_576,
    maximum: 134_217_728,
  },
  {
    key: "browserContextSearchTimeoutMs",
    kind: "number",
    fallback: 15_000,
    minimum: 1000,
    maximum: 120_000,
  },
  { key: "commandCheckTimeoutMs", kind: "number", fallback: 15_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "codexRequestTimeoutMs", kind: "number", fallback: 30_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "agentTurnTimeoutMs", kind: "number", fallback: 1_800_000, minimum: 10_000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "interruptGraceMs", kind: "number", fallback: 5000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "maxStoredResponseBytes",
    kind: "number",
    fallback: 5_242_880,
    minimum: 65_536,
    maximum: 33_554_432,
  },
  { key: "maxConcurrentLocalAgents", kind: "number", fallback: 4, minimum: 1, maximum: 100 },
  { key: "zaiModel", kind: "string", fallback: "" },
];

export const recordedRunSettings: readonly RunSettingDeclaration[] = [
  { key: "todoGlobalCheckConcurrency", kind: "number", fallback: 1, minimum: 1, maximum: 100 },
  { key: "todoCheckSlotTimeoutMs", kind: "number", fallback: 900_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "todoStopTimeoutMs", kind: "number", fallback: 30_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "todoOwnerTimeoutMs", kind: "number", fallback: 2000, minimum: 500, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "gitAdministrationTimeoutMs", kind: "number", fallback: 120_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "todoCheckEnvironmentVariables", kind: "stringList", fallback: [], secretReference: true },
  { key: "todoFile", kind: "string", fallback: "TODO.md" },
  { key: "todoPipeline", kind: "string", fallback: "todo-implementation" },
  { key: "todoMasterPipeline", kind: "string", fallback: "todo-master" },
  { key: "todoMaxConcurrency", kind: "number", fallback: 2, minimum: 1, maximum: 20 },
  { key: "todoRetries", kind: "number", fallback: 1, minimum: 0, maximum: 10 },
  { key: "todoCheckTimeoutMs", kind: "number", fallback: 1_800_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "todoCheckMaxOutputBytes",
    kind: "number",
    fallback: 2_097_152,
    minimum: 65_536,
    maximum: 8_388_608,
  },
  { key: "todoRequireChecks", kind: "boolean", fallback: true },
  { key: "improvePipeline", kind: "string", fallback: "self-improvement" },
  { key: "improveDiscoveryPipeline", kind: "string", fallback: "self-improvement-discovery" },
  { key: "improveConvergencePipeline", kind: "string", fallback: "self-improvement-convergence" },
  { key: "improveReviewPipeline", kind: "string", fallback: "self-improvement-review" },
  { key: "improveRevisionPipeline", kind: "string", fallback: "self-improvement-revision" },
  { key: "improveMaxRevisionCycles", kind: "number", fallback: 1, minimum: 0, maximum: 5 },
  { key: "improveBaselineFailures", kind: "stringList", fallback: [] },
  {
    key: "browserBridgeMaxMessageBytes",
    kind: "number",
    fallback: 83_886_080,
    minimum: 65_536,
    maximum: 134_217_728,
  },
  { key: "browserBridgePort", kind: "number", fallback: 43_127, minimum: 0, maximum: 65_535 },
  { key: "browserBridgeOwnerTimeoutMs", kind: "number", fallback: 2000, minimum: 250, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "browserBridgeCloseTimeoutMs", kind: "number", fallback: 10_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "freshReviewPipelineId", kind: "string", fallback: "" },
  { key: "fixPipelineId", kind: "string", fallback: "" },
  { key: "interactionFallbackTimeoutMs", kind: "number", fallback: 120_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "workspaceOwnerTimeoutMs", kind: "number", fallback: 1500, minimum: 250, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "pipelineCatalogOwnerTimeoutMs", kind: "number", fallback: 5000, minimum: 250, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "pipelineCatalogFileLockTimeoutMs", kind: "number", fallback: 10_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  {
    key: "pipelineCatalogFileLockStaleMs",
    kind: "number",
    fallback: 60_000,
    minimum: 10_000,
    maximum: 3_600_000,
  },
  { key: "maxConcurrentPairRuns", kind: "number", fallback: 4, minimum: 1, maximum: 100 },
  { key: "maxConcurrentRepositoryTasks", kind: "number", fallback: 4, minimum: 1, maximum: 100 },
  { key: "executionSlotTimeoutMs", kind: "number", fallback: 300_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "providerCleanupTimeoutMs", kind: "number", fallback: 15_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "managerInterruptTimeoutMs", kind: "number", fallback: 15_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
  { key: "managerDisposeTimeoutMs", kind: "number", fallback: 30_000, minimum: 1000, maximum: MAXIMUM_TIMEOUT_MS },
];

export const authorityRunSettings: readonly RunSettingDeclaration[] = [
  {
    key: "disabledProviders",
    kind: "stringList",
    fallback: [],
    allowed: ["codex-app-server", "claude-code", "zai-glm", "chatgpt-browser", "claude-browser", "generic-browser"],
  },
  {
    key: "codexWorkspaceScope",
    kind: "string",
    fallback: "refuseNarrowedScope",
    allowed: ["refuseNarrowedScope", "wholeWorkingDirectory"],
  },
  { key: "allowExternalWorkingDirectories", kind: "boolean", fallback: false },
  { key: "managedBrowserAutoApprove", kind: "boolean", fallback: true },
  {
    key: "browserActionReadOnlyPolicy",
    kind: "string",
    fallback: "ask",
    allowed: ["ask", "auto", "disabled"],
  },
  {
    key: "browserActionMutationPolicy",
    kind: "string",
    fallback: "ask",
    allowed: ["ask", "auto", "disabled"],
  },
  {
    key: "browserActionDestructivePolicy",
    kind: "string",
    fallback: "ask",
    allowed: ["ask", "auto", "disabled"],
  },
  { key: "browserSemanticInterpreterAllowRemote", kind: "boolean", fallback: false },
  {
    key: "codexImplementationPermissionMode",
    kind: "string",
    fallback: "workspaceWrite",
    allowed: ["readOnly", "workspaceWrite"],
  },
  {
    key: "codexApprovalPolicy",
    kind: "string",
    fallback: "onRequest",
    allowed: ["onRequest", "unlessTrusted"],
  },
  {
    key: "claudeReviewPermissionMode",
    kind: "string",
    fallback: "plan",
    allowed: ["plan", "default", "manual", "dontAsk"],
  },
  {
    key: "claudeImplementationPermissionMode",
    kind: "string",
    fallback: "acceptEdits",
    allowed: ["default", "manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
  },
  { key: "codexCommand", kind: "string", fallback: "codex" },
  { key: "claudeCommand", kind: "string", fallback: "claude" },
  { key: "zaiCommand", kind: "string", fallback: "claude" },
  { key: "zaiBaseUrl", kind: "string", fallback: "https://api.z.ai/api/anthropic" },
  { key: "zaiAuthTokenEnvironment", kind: "string", fallback: "ZAI_API_KEY", secretReference: true },
  { key: "zaiEnvironmentVariables", kind: "stringList", fallback: [], secretReference: true },
  { key: "providerEnvironmentVariables", kind: "stringList", fallback: [], secretReference: true },
  { key: "browserSemanticInterpreterEndpoint", kind: "string", fallback: "" },
  {
    key: "browserSemanticInterpreterApiKeyEnvironment",
    kind: "string",
    fallback: "",
    secretReference: true,
  },
  { key: "browserSelectorHealingEndpoint", kind: "string", fallback: "" },
  { key: "browserSemanticInterpreterEnabled", kind: "boolean", fallback: false },
  { key: "browserSelectorHealingEnabled", kind: "boolean", fallback: false },
];

export const interfaceSettingKeys: readonly string[] = [
  "advancedMode",
  "localDataRetentionDays",
  "maxActiveConversations",
  "streamThrottleMs",
  "maxAttachmentBytes",
  "maxAttachmentCount",
  "maxAttachmentTotalBytes",
  "maxBrowserAssetBytes",
  "transcriptWindowSize",
  "transcriptMaxEntries",
  "transcriptMaxFileBytes",
  "transcriptPreviewBytes",
  "transcriptDataBytes",
  "maxQueuedMessages",
  "notificationMode",
  "preferredProvider",
];

const collect = (
  read: SettingsReader,
  declarations: readonly RunSettingDeclaration[],
): Record<string, RunSettingValue> =>
  Object.fromEntries(declarations.map((declaration) => [
    declaration.key,
    read(declaration.key, declaration.fallback),
  ]));

// Secret-bearing settings hold the NAME of an environment variable, never its value. The name
// is behaviour, so it is recorded; the value is a credential and is never read here.
export const captureRunSettings = (read: SettingsReader): RunSettingsSnapshot => ({
  schema: "bachata.run-settings.v1",
  values: collect(read, pinnedRunSettings),
  recorded: collect(read, recordedRunSettings),
  authority: collect(read, authorityRunSettings),
  secretReferences: [...pinnedRunSettings, ...recordedRunSettings, ...authorityRunSettings]
    .filter((declaration) => declaration.secretReference === true)
    .map((declaration) => declaration.key)
    .sort(),
});

const matchesKind = (value: unknown, kind: RunSettingKind): value is RunSettingValue =>
  kind === "string"
    ? typeof value === "string"
    : kind === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : kind === "boolean"
        ? typeof value === "boolean"
        : Array.isArray(value) && value.every((entry) => typeof entry === "string");

// A recorded value is checked against the same contract the settings UI enforces: the declared
// type, the declared enum, and the declared bounds. Anything outside them is refused by name,
// never clamped and never quietly kept.
const rejection = (
  declaration: RunSettingDeclaration,
  value: unknown,
): string | undefined => {
  if (!matchesKind(value, declaration.kind)) {
    return `is not a ${declaration.kind}`;
  }
  if (declaration.allowed) {
    const values = Array.isArray(value) ? value : [value];
    const unknown = values.find((entry) => !declaration.allowed?.includes(String(entry)));
    if (unknown !== undefined) {
      return `is ${JSON.stringify(unknown)}, which is not one of ${declaration.allowed.join(", ")}`;
    }
  }
  if (typeof value === "number") {
    if (declaration.minimum !== undefined && value < declaration.minimum) {
      return `is below the declared minimum ${String(declaration.minimum)}`;
    }
    if (declaration.maximum !== undefined && value > declaration.maximum) {
      return `is above the declared maximum ${String(declaration.maximum)}`;
    }
  }
  return undefined;
};

const declared = (
  value: unknown,
  declarations: readonly RunSettingDeclaration[],
  rejected: RunSettingRejection[],
  requireEvery = false,
): Record<string, RunSettingValue> => {
  const source = value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const known = new Set(declarations.map((declaration) => declaration.key));
  Object.keys(source)
    .filter((key) => !known.has(key))
    .forEach((key) => rejected.push({ key, reason: "is not a setting Bachata records" }));
  return Object.fromEntries(declarations.flatMap((declaration) => {
    const candidate = source[declaration.key];
    if (candidate === undefined) {
      // A snapshot Bachata wrote carries every pinned key. One that does not was edited, and the
      // run will silently use the live value unless the omission is named.
      if (requireEvery) rejected.push({ key: declaration.key, reason: "is missing" });
      return [];
    }
    const reason = rejection(declaration, candidate);
    if (reason !== undefined) {
      rejected.push({ key: declaration.key, reason });
      return [];
    }
    return [[declaration.key, candidate as RunSettingValue]];
  }));
};

export const isRunSettingsSnapshot = (value: unknown): value is RunSettingsSnapshot => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === "bachata.run-settings.v1";
};

// A snapshot can arrive from a file someone else wrote. It is therefore rebuilt from Bachata's own
// declarations rather than trusted: a key Bachata does not pin is dropped, a value of the wrong
// type is dropped, and an authority control named inside the pinned values cannot become a
// pinned value. A run recorded before this snapshot existed migrates to nothing rather than to
// a guess, and resumes on live settings.
export const parseRunSettings = (
  value: unknown,
): { snapshot?: RunSettingsSnapshot; rejected: RunSettingRejection[] } => {
  if (!isRunSettingsSnapshot(value)) return { rejected: [] };
  const source = value as Record<string, unknown>;
  const rejected: RunSettingRejection[] = [];
  return {
    snapshot: {
      schema: "bachata.run-settings.v1",
      values: declared(source.values, pinnedRunSettings, rejected, true),
      recorded: declared(source.recorded, recordedRunSettings, rejected),
      authority: declared(source.authority, authorityRunSettings, rejected),
      secretReferences: [...pinnedRunSettings, ...recordedRunSettings, ...authorityRunSettings]
        .filter((declaration) => declaration.secretReference === true)
        .map((declaration) => declaration.key)
        .sort(),
    },
    rejected,
  };
};

export const migrateRunSettings = (value: unknown): RunSettingsSnapshot | undefined =>
  parseRunSettings(value).snapshot;

export const pinnedRunSetting = (
  snapshot: RunSettingsSnapshot | undefined,
  key: string,
): RunSettingValue | undefined =>
  snapshot && Object.prototype.hasOwnProperty.call(snapshot.values, key)
    ? snapshot.values[key]
    : undefined;

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
};

export const runSettingsFingerprint = (snapshot: RunSettingsSnapshot): string =>
  JSON.stringify(stable(snapshot));
