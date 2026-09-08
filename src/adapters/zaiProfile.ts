export const ZAI_ADAPTER_TYPE = "zai-glm";

export const ZAI_ANTHROPIC_ENDPOINT = "https://api.z.ai/api/anthropic";

export const ZAI_TOKEN_TARGET_VARIABLE = "ANTHROPIC_AUTH_TOKEN";

export const ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE = "ZAI_API_KEY";

export type ZaiProfile = {
  command: string;
  baseUrl: string;
  tokenSourceVariable: string;
  model: string;
};

export type ZaiProfileFinding = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const validVariableName = (value: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);

export const zaiProfileFindings = (input: {
  profile: ZaiProfile;
  tokenPresent: boolean;
  commandAvailable?: boolean;
  commandDetail?: string;
}): ZaiProfileFinding[] => {
  const { profile } = input;
  return [
    {
      id: "zai.command",
      label: "Z.AI GLM command",
      ok: input.commandAvailable !== false,
      detail: input.commandDetail
        ?? (input.commandAvailable === false
          ? `${profile.command} is not runnable`
          : `${profile.command} is configured`),
    },
    {
      id: "zai.endpoint",
      label: "Z.AI endpoint",
      ok: isHttpsUrl(profile.baseUrl),
      detail: isHttpsUrl(profile.baseUrl)
        ? profile.baseUrl
        : `${profile.baseUrl || "no endpoint"} is not an https URL`,
    },
    {
      id: "zai.credential",
      label: "Z.AI credential",
      ok: validVariableName(profile.tokenSourceVariable) && input.tokenPresent,
      detail: !validVariableName(profile.tokenSourceVariable)
        ? `${profile.tokenSourceVariable || "no variable"} is not a valid environment variable name`
        : input.tokenPresent
          ? `${profile.tokenSourceVariable} is set in this environment and is forwarded to Z.AI only, as ${ZAI_TOKEN_TARGET_VARIABLE}`
          : `${profile.tokenSourceVariable} is not set in this environment`,
    },
    {
      id: "zai.model",
      label: "Z.AI model",
      ok: profile.model.length > 0,
      detail: profile.model.length > 0
        ? profile.model
        : "No model is selected. Z.AI picks its own default, so evidence cannot name the model.",
    },
  ];
};
