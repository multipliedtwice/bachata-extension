import {
  parseRunSettings,
  type RunSettingRejection,
  type RunSettingsSnapshot,
} from "../runtime/settingsSnapshot";

export type ReplaySource = {
  runRef: string;
  runSettings?: RunSettingsSnapshot;
  rejectedRunSettings?: RunSettingRejection[];
  title: string;
  prompt: string;
  pipelineId?: string;
  pipelineHash?: string;
  workingDirectory?: string;
  toolVersion?: string;
  providers: Array<{ name: string; adapter: string; model?: string }>;
  exportedAt: string;
};

export type ReplayDrift = {
  label: string;
  recorded: string;
  current: string;
  blocking: boolean;
};

export type ReplayPlan = {
  source: ReplaySource;
  drift: ReplayDrift[];
  replayable: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const parseRunBundle = (
  source: string,
): { replay?: ReplaySource; errors: string[] } => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { errors: [`The run bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isRecord(value)) return { errors: ["The run bundle must be a JSON object"] };
  if (value.version !== 1) return { errors: ['The run bundle must declare "version": 1'] };
  const exportedAt = optionalString(value.exportedAt);
  const bundle = value.run;
  if (!isRecord(bundle) || bundle.schema !== "bachata.run-bundle.v1") {
    return { errors: ["The run bundle does not declare schema bachata.run-bundle.v1"] };
  }
  const run = isRecord(bundle.run) ? bundle.run : undefined;
  if (!run) return { errors: ["The run bundle carries no run record"] };
  const prompt = optionalString(run.input);
  if (!prompt) return { errors: ["The run bundle carries no run input to replay"] };
  const snapshot = isRecord(bundle.pipelineSnapshot) ? bundle.pipelineSnapshot : undefined;
  const definition = snapshot && isRecord(snapshot.definition) ? snapshot.definition : undefined;
  const result = isRecord(bundle.result) ? bundle.result : undefined;
  const recordedSettings = parseRunSettings(bundle.runSettings);
  const providers = Array.isArray(result?.providers)
    ? result.providers.flatMap((item) => {
        if (!isRecord(item)) return [];
        const name = optionalString(item.name);
        const adapter = optionalString(item.adapter);
        return name && adapter
          ? [{ name, adapter, ...(optionalString(item.model) ? { model: optionalString(item.model) as string } : {}) }]
          : [];
      })
    : [];
  return {
    replay: {
      runRef: optionalString(run.runRef) ?? "unknown",
      title: optionalString(run.title) ?? "Replayed run",
      prompt,
      ...(optionalString(definition?.id) ?? optionalString(run.selectedPipelineId)
        ? { pipelineId: (optionalString(definition?.id) ?? optionalString(run.selectedPipelineId)) as string }
        : {}),
      ...(optionalString(snapshot?.hash) ?? optionalString(run.selectedPipelineHash)
        ? { pipelineHash: (optionalString(snapshot?.hash) ?? optionalString(run.selectedPipelineHash)) as string }
        : {}),
      ...(optionalString(run.workingDirectory) === undefined
        ? {}
        : { workingDirectory: optionalString(run.workingDirectory) as string }),
      ...(optionalString(bundle.toolVersion) === undefined
        ? {}
        : { toolVersion: optionalString(bundle.toolVersion) as string }),
      ...(recordedSettings.snapshot === undefined
        ? {}
        : { runSettings: recordedSettings.snapshot }),
      ...(recordedSettings.rejected.length === 0
        ? {}
        : { rejectedRunSettings: recordedSettings.rejected }),
      providers,
      exportedAt: exportedAt ?? "unknown",
    },
    errors: [],
  };
};

export const replayPlan = (
  source: ReplaySource,
  current: {
    pipelineHashesById: Readonly<Record<string, string>>;
    availableAdapters: string[];
    toolVersion: string;
    workingDirectory?: string;
    runSettings?: RunSettingsSnapshot;
  },
): ReplayPlan => {
  const drift: ReplayDrift[] = [];
  const currentHash = source.pipelineId === undefined
    ? undefined
    : current.pipelineHashesById[source.pipelineId];
  if (source.pipelineId === undefined) {
    drift.push({
      label: "Pipeline",
      recorded: "not recorded",
      current: "unknown",
      blocking: true,
    });
  } else if (currentHash === undefined) {
    drift.push({
      label: "Pipeline",
      recorded: source.pipelineId,
      current: "not present in this catalog",
      blocking: true,
    });
  } else if (source.pipelineHash !== undefined && source.pipelineHash !== currentHash) {
    drift.push({
      label: "Pipeline definition",
      recorded: source.pipelineHash,
      current: currentHash,
      blocking: false,
    });
  }
  const missing = source.providers
    .map((provider) => provider.adapter)
    .filter((adapter, index, all) => all.indexOf(adapter) === index)
    .filter((adapter) => !current.availableAdapters.includes(adapter));
  if (missing.length > 0) {
    drift.push({
      label: "Providers",
      recorded: source.providers.map((provider) => provider.adapter).join(", ") || "none recorded",
      current: `${missing.join(", ")} not available now`,
      blocking: false,
    });
  }
  if (source.toolVersion !== undefined && source.toolVersion !== current.toolVersion) {
    drift.push({
      label: "Extension version",
      recorded: source.toolVersion,
      current: current.toolVersion,
      blocking: false,
    });
  }
  if (
    source.workingDirectory !== undefined &&
    current.workingDirectory !== undefined &&
    source.workingDirectory !== current.workingDirectory
  ) {
    drift.push({
      label: "Working directory",
      recorded: source.workingDirectory,
      current: current.workingDirectory,
      blocking: false,
    });
  }
  // A replay runs on the settings the source run pinned. Authority controls and settings read
  // outside the runtime accessor were recorded, not pinned, and are not restored; only the
  // pinned values are, so only those are compared.
  // A recorded value Bachata will not apply is named, not dropped in silence. The replay still
  // runs, on the live value for that setting, and says so.
  if (source.rejectedRunSettings && source.rejectedRunSettings.length > 0) {
    drift.push({
      label: "Rejected run settings",
      recorded: source.rejectedRunSettings
        .map((entry) => `${entry.key} ${entry.reason}`)
        .join("; "),
      current: "Bachata refused these recorded values and will use the live ones",
      blocking: false,
    });
  }
  if (source.runSettings === undefined) {
    drift.push({
      label: "Run settings",
      recorded: "not recorded",
      current: "the replay will use the current settings",
      blocking: false,
    });
  } else if (current.runSettings) {
    // Compared over every key the live snapshot holds, not only the ones the source carries: a
    // key the source omits is a difference, and reporting only its own keys would hide it.
    const keys = Array.from(new Set([
      ...Object.keys(source.runSettings.values),
      ...Object.keys(current.runSettings.values),
    ]));
    const changed = keys
      .filter((key) =>
        JSON.stringify(source.runSettings?.values[key])
        !== JSON.stringify(current.runSettings?.values[key]))
      .sort();
    if (changed.length > 0) {
      drift.push({
        label: "Run settings",
        recorded: `${String(changed.length)} recorded ${changed.length === 1 ? "value differs" : "values differ"}: ${changed.join(", ")}`,
        current: "the replay uses the recorded values for these; authority controls stay live",
        blocking: false,
      });
    }
  }
  return { source, drift, replayable: !drift.some((entry) => entry.blocking) };
};

export const replayDriftSummary = (plan: ReplayPlan): string => plan.drift.length === 0
  ? `No drift: ${plan.source.runRef} replays under the same pipeline, providers, and version.`
  : plan.drift
      .map((entry) => `${entry.blocking ? "Blocking" : "Drift"} · ${entry.label}: recorded ${entry.recorded}, now ${entry.current}`)
      .join("\n");
