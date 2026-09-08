import * as vscode from "vscode";

import type { DoctorDependencies } from "../process/doctorChecks";
import { readTimeoutSetting } from "../state/timeoutBounds";
import { createScopedDoctorDependencies, selectDoctorWorkspace } from "./doctorDependencies";
import {
  ZAI_ANTHROPIC_ENDPOINT,
  ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
} from "../adapters/zaiProfile";

export const createDoctorDependencies = (): DoctorDependencies => {
  const configuration = vscode.workspace.getConfiguration("bachata");
  const timeoutMs = readTimeoutSetting(
    (settingKey, settingFallback) => configuration.get(settingKey, settingFallback),
    "commandCheckTimeoutMs",
    15_000,
  );
  const folders = vscode.workspace.workspaceFolders ?? [];
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  const workspace = selectDoctorWorkspace(
    folders.map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath })),
    activeFolder?.uri.fsPath,
  );
  const providerEnvironmentVariables = configuration.get<string[]>(
    "providerEnvironmentVariables",
    [],
  );
  return createScopedDoctorDependencies({
    ...(workspace === undefined ? {} : { workspace }),
    timeoutMs,
    codexCommand: String(configuration.get("codexCommand", "codex")),
    claudeCommand: String(configuration.get("claudeCommand", "claude")),
    providerEnvironmentVariables,
    zai: {
      profile: {
        command: String(configuration.get("zaiCommand", "claude")).trim(),
        baseUrl: String(configuration.get("zaiBaseUrl", ZAI_ANTHROPIC_ENDPOINT)).trim(),
        tokenSourceVariable: String(
          configuration.get("zaiAuthTokenEnvironment", ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE),
        ).trim(),
        model: String(configuration.get("zaiModel", "")).trim(),
      },
      scopedVariables: configuration.get<string[]>("zaiEnvironmentVariables", []),
    },
  });
};
