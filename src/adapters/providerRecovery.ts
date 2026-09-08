import { ProviderFailure, providerFailureRequiresHumanChoice } from "./providerFailure";

export type ProviderRecoveryChoiceId =
  | "runDoctor"
  | "openProviderSettings"
  | "disableProvider"
  | "acceptWholeWorkingDirectory"
  | "chooseAnotherProvider"
  | "stop";

export type ProviderRecoveryChoice = {
  id: ProviderRecoveryChoiceId;
  label: string;
  detail: string;
  setting?: string;
};

export type ProviderRecovery = {
  provider: string;
  code: ProviderFailure["code"];
  title: string;
  statement: string;
  choices: ProviderRecoveryChoice[];
};

const runDoctor: ProviderRecoveryChoice = {
  id: "runDoctor",
  label: "Run Doctor",
  detail: "Re-check the installed provider and report what its app-server accepts.",
};

const openProviderSettings: ProviderRecoveryChoice = {
  id: "openProviderSettings",
  label: "Open provider settings",
  detail: "Point Bachata at a different executable or change the provider's execution settings.",
  setting: "bachata.codexCommand",
};

const disableProvider: ProviderRecoveryChoice = {
  id: "disableProvider",
  label: "Disable this provider",
  detail: "Add the provider to bachata.disabledProviders so no workflow selects it.",
  setting: "bachata.disabledProviders",
};

const chooseAnotherProvider: ProviderRecoveryChoice = {
  id: "chooseAnotherProvider",
  label: "Choose another provider",
  detail: "Reopen Setup and pick a workflow backed by a provider Bachata can drive.",
};

const stop: ProviderRecoveryChoice = {
  id: "stop",
  label: "Stop",
  detail: "Leave the run stopped and change nothing.",
};

const acceptWholeWorkingDirectory: ProviderRecoveryChoice = {
  id: "acceptWholeWorkingDirectory",
  label: "Let Codex read the whole working directory",
  detail:
    "Set bachata.codexWorkspaceScope to wholeWorkingDirectory. Codex then reads every path in the"
    + " working directory, including the version-control, credential and bachata-internal paths Bachata"
    + " withholds from other providers.",
  setting: "bachata.codexWorkspaceScope",
};

// A protocol rejection and a refused read scope are both permanent properties of the installed
// provider. Bachata states what happened and lets the human decide; it never answers either by
// running the same work on a different provider.
// A run-scoped refusal is one the run itself asked for: it declared its own read paths or its
// own protected paths. Accepting whole-directory reads would not make that run runnable, so the
// acknowledgement is not offered for it. The reason is read from the refusal Bachata wrote.
const runScopedRefusal = (failure: ProviderFailure): boolean =>
  /declares explicit read paths|withholds explicit paths/u.test(failure.message);

export const providerRecoveryStatement = (recovery: ProviderRecovery): string => [
  recovery.title,
  recovery.statement,
  "Bachata will not run this somewhere else on its own. Choose:",
  ...recovery.choices.map((choice) => `- ${choice.label}: ${choice.detail}`),
].join("\n");

export const providerRecovery = (
  failure: ProviderFailure,
  options: { runScopedRefusal?: boolean } = {},
): ProviderRecovery | undefined => {
  if (!providerFailureRequiresHumanChoice(failure)) {
    return undefined;
  }
  if (failure.code === "scopeUnsupported") {
    const scoped = options.runScopedRefusal ?? runScopedRefusal(failure);
    return {
      provider: failure.provider,
      code: failure.code,
      title: `${failure.provider} cannot keep this run's read scope`,
      statement: failure.message,
      choices: [
        ...(scoped ? [] : [acceptWholeWorkingDirectory]),
        chooseAnotherProvider,
        disableProvider,
        stop,
      ],
    };
  }
  return {
    provider: failure.provider,
    code: failure.code,
    title: `${failure.provider} rejected Bachata's request`,
    statement: failure.message,
    choices: [runDoctor, openProviderSettings, chooseAnotherProvider, disableProvider, stop],
  };
};
