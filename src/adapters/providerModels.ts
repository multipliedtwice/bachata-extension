/**
 * Which models a provider will actually accept, asked of the provider rather than assumed.
 *
 * Bachata ships no model catalog. A catalog written here would be a guess about a product that
 * changes without this extension changing: it would go stale silently, and a stale catalog is
 * worse than none, because it presents a name the installed executable rejects as a name the
 * reader may choose. So the question is put to the installed provider, and the answer is only ever
 * one of three things — a list it reported, a statement that it cannot list, or an error.
 *
 * A provider that cannot list is not a provider with no models. It keeps a validated explicit
 * model name instead, because refusing to run without a list would make the reader's own knowledge
 * of their provider unusable.
 */

export type ProviderModelOption = {
  id: string;
  label: string;
  /** The provider's own default, so the reader can see what "Provider default" resolves to. */
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts?: Array<{ id: string; description: string }>;
};

export type ProviderModelCatalog =
  | {
      supported: true;
      models: ProviderModelOption[];
      /** The executable that answered, so a refusal can name what it asked. */
      commandPath?: string;
      runtimeVersion?: string;
    }
  | {
      supported: false;
      /** Why the list is unavailable, in the provider's own terms. */
      reason: string;
      commandPath?: string;
      runtimeVersion?: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/**
 * The Codex app-server `model/list` result, reduced to identity and label.
 *
 * The wire form is `{ data: [ { id, model, displayName, hidden, isDefault, ... } ] }`. Only `id`
 * is required here: a row with no id names nothing the reader could select and is dropped rather
 * than shown as an unnamed choice. A hidden row is dropped too — the server marks it as one the
 * reader is not offered — while everything else about a row is left alone, because reasoning
 * effort, service tiers and modalities are Codex's business and not a model's identity.
 *
 * A result with no `data` array is not an empty catalog: it is a server that did not answer this
 * question, and it returns undefined so the caller reports "cannot list" instead of "no models".
 */
export const parseCodexModelList = (result: unknown): ProviderModelOption[] | undefined => {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return undefined;
  }
  return result.data.flatMap((entry) => {
    if (!isRecord(entry) || entry.hidden === true) {
      return [];
    }
    const id = nonEmptyString(entry.id) ?? nonEmptyString(entry.model);
    if (id === undefined) {
      return [];
    }
    const defaultReasoningEffort = nonEmptyString(entry.defaultReasoningEffort);
    const reasoningEfforts = Array.isArray(entry.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.flatMap((effort) => {
          if (!isRecord(effort)) return [];
          const effortId = nonEmptyString(effort.reasoningEffort);
          return effortId === undefined
            ? []
            : [{ id: effortId, description: nonEmptyString(effort.description) ?? effortId }];
        })
      : [];
    return [{
      id,
      label: nonEmptyString(entry.displayName) ?? id,
      ...(entry.isDefault === true ? { isDefault: true as const } : {}),
      ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
      ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
    }];
  });
};

/**
 * Why the selected model cannot run on the selected executable, or nothing.
 *
 * Only a catalog the provider actually reported can establish an incompatibility. Where listing is
 * unsupported the answer is always "nothing": Bachata does not know the model is unavailable, and
 * refusing on an unknown would block a model the provider would have accepted. An empty reported
 * catalog is treated the same way — a server that lists nothing has told us nothing about this
 * model — because refusing every model on the strength of an empty list would take a run away over
 * a provider quirk rather than over evidence.
 *
 * The refusal names the four facts needed to act on it: which executable was asked, which runtime
 * version answered, which model was selected, and what that executable offers instead.
 */
export const providerModelRefusal = (input: {
  providerLabel: string;
  commandPath: string;
  runtimeVersion?: string | undefined;
  selectedModel: string | undefined;
  catalog: ProviderModelCatalog;
}): string | undefined => {
  if (input.selectedModel === undefined || !input.catalog.supported) {
    return undefined;
  }
  const offered = input.catalog.models;
  if (offered.length === 0 || offered.some((model) => model.id === input.selectedModel)) {
    return undefined;
  }
  const version = input.runtimeVersion ?? input.catalog.runtimeVersion;
  return [
    `${input.providerLabel} at ${input.commandPath}`,
    version === undefined ? "" : ` (${version})`,
    ` does not offer the selected model "${input.selectedModel}".`,
    ` It reports ${String(offered.length)} model${offered.length === 1 ? "" : "s"}: `,
    offered.map((model) => model.id).join(", "),
    ".",
    " Choose one of those, or install a provider version that offers the selected model.",
    " Bachata does not switch the executable or the model for you.",
  ].join("");
};
