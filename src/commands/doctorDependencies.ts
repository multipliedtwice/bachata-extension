import { checkCommand } from "../process/checkCommand";
import { probeCodexAppServer } from "../adapters/codexAppServer";
import type { CheckCommandOptions } from "../process/checkCommand";
import type { DoctorDependencies } from "../process/doctorChecks";
import {
  gitProcessEnvironment,
  providerProcessEnvironment,
  providerScopedEnvironment,
} from "../process/safeEnvironment";
import {
  ZAI_TOKEN_TARGET_VARIABLE,
  type ZaiProfile,
} from "../adapters/zaiProfile";

export type DoctorWorkspace = { name: string; fsPath: string };

export const selectDoctorWorkspace = (
  folders: DoctorWorkspace[],
  activeWorkspacePath?: string,
): DoctorWorkspace | undefined =>
  folders.find((folder) => folder.fsPath === activeWorkspacePath)
    ?? (folders.length === 1 ? folders[0] : undefined);

export const doctorCommandOptions = (
  kind: "git" | "provider",
  workingDirectory: string,
  timeoutMs: number,
  providerEnvironmentVariables: string[] = [],
): CheckCommandOptions => ({
  timeoutMs,
  workingDirectory,
  environment: kind === "git"
    ? gitProcessEnvironment(workingDirectory)
    : providerProcessEnvironment(workingDirectory, providerEnvironmentVariables),
});

export const createScopedDoctorDependencies = ({
  workspace,
  timeoutMs,
  codexCommand,
  claudeCommand,
  providerEnvironmentVariables,
  zai,
}: {
  workspace?: DoctorWorkspace;
  timeoutMs: number;
  codexCommand: string;
  claudeCommand: string;
  providerEnvironmentVariables: string[];
  zai?: { profile: ZaiProfile; scopedVariables?: string[] };
}): DoctorDependencies => {
  const workingDirectory = workspace?.fsPath ?? process.cwd();
  const zaiEnvironment = zai === undefined
    ? undefined
    : providerScopedEnvironment({
        adapterType: "zai-glm",
        workingDirectory,
        sharedVariables: providerEnvironmentVariables,
        profile: {
          adapterType: "zai-glm",
          variables: zai.scopedVariables ?? [],
          credential: {
            sourceVariable: zai.profile.tokenSourceVariable,
            targetVariable: ZAI_TOKEN_TARGET_VARIABLE,
          },
          values: { ANTHROPIC_BASE_URL: zai.profile.baseUrl },
        },
      });
  return {
    workspaceLabel: workspace?.name,
    codexCommand,
    claudeCommand,
    ...(zai === undefined || zaiEnvironment === undefined
      ? {}
      : {
          zai: {
            profile: zai.profile,
            tokenPresent: zaiEnvironment[ZAI_TOKEN_TARGET_VARIABLE] !== undefined,
          },
        }),
    gitVersion: () => checkCommand(
      "git",
      ["--version"],
      doctorCommandOptions("git", workingDirectory, timeoutMs),
    ),
    providerVersion: (command: string, adapterType?: string) => {
      const options = adapterType === "zai-glm" && zaiEnvironment !== undefined
        ? { timeoutMs, workingDirectory, environment: zaiEnvironment }
        : doctorCommandOptions(
            "provider",
            workingDirectory,
            timeoutMs,
            providerEnvironmentVariables,
          );
      return adapterType === "codex-app-server"
        ? probeCodexAppServer({
            command,
            commandCheckTimeoutMs: timeoutMs,
            requestTimeoutMs: timeoutMs,
            interruptGraceMs: 5_000,
            ...(options.environment ? { environment: options.environment } : {}),
            ...(workingDirectory === undefined ? {} : { workingDirectory }),
          })
        : checkCommand(command, ["--version"], options);
    },
    gitStatus: () => checkCommand(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { ...doctorCommandOptions("git", workingDirectory, timeoutMs), trim: false },
    ),
  };
};
