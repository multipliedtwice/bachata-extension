export type ScopedConfigurationValue<T> = {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
};

export const mostSpecificPositiveNumber = (
  setting: ScopedConfigurationValue<number> | undefined,
): number | undefined =>
  [
    setting?.workspaceFolderValue,
    setting?.workspaceValue,
    setting?.globalValue,
  ].find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
