/**
 * How a provider is asked whether it is installed, in one place.
 *
 * The extension host runs this at startup and a runtime runs it for a participant whose executable
 * the machine has not been asked about. Both must ask the same question the same way: an answer
 * obtained differently is a different answer, and the whole point of the shared registry is that
 * there is only one.
 *
 * Standard installation locations are already handled by `providerProcessEnvironment`, which puts
 * `~/.local/bin`, `/usr/local/bin` and Homebrew's `bin` on the PATH the probe runs with. So a
 * normally installed Codex or Claude answers here without the reader configuring a path.
 */
import {
  ZAI_ANTHROPIC_ENDPOINT,
  ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
  ZAI_TOKEN_TARGET_VARIABLE,
} from "../adapters/zaiProfile";
import { checkCommand } from "../process/checkCommand";
import { readTimeoutSetting } from "../state/timeoutBounds";
import { probeCodexAppServer } from "../adapters/codexAppServer";
import { providerScopedEnvironment } from "../process/safeEnvironment";
import { resolveCodexExecutable } from "./codexExecutable";
import { providerEnvironmentRequest } from "../runtime/adapterTopology";
import type { ProviderIdentity, ProviderModel } from "./providerRegistry";
import {
  JsonFetch,
  LocalBackendDefinition,
  probeLocalBackend,
} from "./localModelDiscovery";
import type { ProviderProbeOutcome } from "../readiness/readinessReport";

/** The settings a probe reads, so a caller can supply the host's or a runtime's configuration. */
export type ProviderDiscoverySettings = {
  get: <Value>(key: string, fallback: Value) => Value;
};

/** The adapter types this build discovers, and the setting naming each one's executable. */
export const DISCOVERABLE_PROVIDERS: ReadonlyArray<{ adapterType: string; setting: string; fallback: string }> = [
  { adapterType: "codex-app-server", setting: "codexCommand", fallback: "codex" },
  { adapterType: "claude-code", setting: "claudeCommand", fallback: "claude" },
  { adapterType: "zai-glm", setting: "zaiCommand", fallback: "claude" },
];

/**
 * The executable one discoverable provider answers on, after any provider-specific resolution.
 *
 * Codex is the one provider whose default name resolves to more than one build on a normal
 * machine, so the default is resolved here rather than left to the PATH. Discovery, readiness,
 * Doctor and the adapter that runs the turn all reach this same function, which is what makes the
 * version a probe reported the version a run actually uses.
 */
export const configuredProviderCommand = (
  provider: { adapterType: string; setting: string; fallback: string },
  settings: ProviderDiscoverySettings,
): string => {
  const configured = settings.get<string>(provider.setting, provider.fallback);
  return provider.adapterType === "codex-app-server"
    ? resolveCodexExecutable(configured)
    : configured;
};

/** Every provider identity this machine is configured to offer, whatever any pipeline names. */
export const configuredProviderIdentities = (
  settings: ProviderDiscoverySettings,
  workingDirectory: string,
): ProviderIdentity[] =>
  DISCOVERABLE_PROVIDERS.map((provider) => ({
    adapterType: provider.adapterType,
    command: configuredProviderCommand(provider, settings),
    workingDirectory,
  }));

export const providerDiscoveryEnvironment = (
  identity: ProviderIdentity,
  settings: ProviderDiscoverySettings,
): NodeJS.ProcessEnv =>
  providerScopedEnvironment(
    providerEnvironmentRequest({
      adapterType: identity.adapterType,
      workingDirectory: identity.workingDirectory,
      sharedVariables: settings.get<string[]>("providerEnvironmentVariables", []),
      zai: {
        variables: settings.get<string[]>("zaiEnvironmentVariables", []),
        credentialSourceVariable: settings
          .get<string>("zaiAuthTokenEnvironment", ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE)
          .trim(),
        baseUrl: settings.get<string>("zaiBaseUrl", ZAI_ANTHROPIC_ENDPOINT).trim(),
      },
    }),
  );

/**
 * A local inference backend answers a model list rather than a version, so its probe is a reachable
 * check plus that list. Nothing is started and nothing is downloaded: a server that is not running
 * simply does not answer, which is the fact the reader needs.
 */
export const probeLocalBackendIdentity = async (input: {
  identity: ProviderIdentity;
  backend: LocalBackendDefinition;
  fetchJson: JsonFetch;
}): Promise<{ outcome: ProviderProbeOutcome; models: ProviderModel[] }> => {
  try {
    const probe = await probeLocalBackend(input.backend.id, input.identity.command, input.fetchJson);
    return {
      outcome: { outcome: "version", command: input.identity.command, version: probe.detail },
      models: probe.models.map((model) => ({
        id: model.id,
        availability: model.availability,
        ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
        ...(model.family === undefined ? {} : { family: model.family }),
        ...(model.parameterSize === undefined ? {} : { parameterSize: model.parameterSize }),
        ...(model.quantization === undefined ? {} : { quantization: model.quantization }),
      })),
    };
  } catch (error) {
    return {
      outcome: { outcome: "failed", command: input.identity.command, error },
      models: [],
    };
  }
};

/**
 * Ask one provider for its version. A provider whose credential the environment does not carry is
 * reported as needing that credential rather than as missing, because the executable may be
 * perfectly well installed and the reader's fix is a different one.
 */
export const probeProvider = async (input: {
  identity: ProviderIdentity;
  settings: ProviderDiscoverySettings;
  log: (message: string) => void;
}): Promise<ProviderProbeOutcome> => {
  const { identity, settings } = input;
  // Every timeout reaches a child process through the shared clamp: an unbounded value read
  // straight from settings is a probe that can hang the discovery pass for the life of the window.
  const readTimeout = (key: string, fallback: number): number =>
    readTimeoutSetting((settingKey, settingFallback) => settings.get(settingKey, settingFallback), key, fallback);
  const timeoutMs = readTimeout("commandCheckTimeoutMs", 15_000);
  const environment = providerDiscoveryEnvironment(identity, settings);
  if (identity.adapterType === "zai-glm" && environment[ZAI_TOKEN_TARGET_VARIABLE] === undefined) {
    return {
      outcome: "missingToken",
      tokenVariable: settings
        .get<string>("zaiAuthTokenEnvironment", ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE)
        .trim(),
      endpoint: settings.get<string>("zaiBaseUrl", ZAI_ANTHROPIC_ENDPOINT).trim(),
    };
  }
  try {
    const version = identity.adapterType === "codex-app-server"
      ? await probeCodexAppServer({
          command: identity.command,
          commandCheckTimeoutMs: timeoutMs,
          requestTimeoutMs: readTimeout("codexRequestTimeoutMs", 30_000),
          interruptGraceMs: readTimeout("interruptGraceMs", 5_000),
          environment,
          workingDirectory: identity.workingDirectory,
          log: input.log,
        })
      : await checkCommand(identity.command, ["--version"], {
          workingDirectory: identity.workingDirectory,
          environment,
          timeoutMs,
        });
    return { outcome: "version", command: identity.command, version };
  } catch (error) {
    return { outcome: "failed", command: identity.command, error };
  }
};
