import { evaluateGitVersionSupport } from "./gitVersionSupport";
import { zaiProfileFindings, type ZaiProfile } from "../adapters/zaiProfile";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  blocking: boolean;
  remediationId?: string;
};

export type DoctorDependencies = {
  workspaceLabel: string | undefined;
  gitVersion: () => Promise<string>;
  providerVersion: (command: string, adapterType?: string) => Promise<string>;
  gitStatus?: () => Promise<string>;
  codexCommand: string;
  claudeCommand: string;
  zai?: {
    profile: ZaiProfile;
    tokenPresent: boolean;
  };
};

export const runDoctorChecks = async (
  dependencies: DoctorDependencies,
): Promise<DoctorCheck[]> => {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "Workspace",
    ok: Boolean(dependencies.workspaceLabel),
    detail: dependencies.workspaceLabel ?? "No folder is open",
    blocking: !dependencies.workspaceLabel,
    ...(dependencies.workspaceLabel ? {} : { remediationId: "workspace.open" as const }),
  });
  try {
    const reported = await dependencies.gitVersion();
    const support = evaluateGitVersionSupport(reported);
    checks.push({
      name: "Git",
      ok: support.supported,
      detail: support.supported ? reported : support.requirementText,
      blocking: !support.supported,
      ...(support.supported ? {} : { remediationId: "git.install" as const }),
    });
  } catch (error) {
    checks.push({
      name: "Git",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      blocking: true,
      remediationId: "git.install",
    });
  }
  const providers: ReadonlyArray<readonly [string, string]> = [
    ["Codex", dependencies.codexCommand],
    ["Claude Code", dependencies.claudeCommand],
  ];
  for (const [name, command] of providers) {
    try {
      const reported = await dependencies.providerVersion(command);
      checks.push({ name, ok: true, detail: `${command}: ${reported}`, blocking: false });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      checks.push({
        name,
        ok: false,
        detail: `${command} unavailable: ${reason}`,
        blocking: false,
        remediationId: name === "Codex" ? "provider.install.codex" : "provider.install.claude",
      });
    }
  }
  const zai = dependencies.zai;
  if (zai !== undefined) {
    let commandAvailable: boolean | undefined;
    let commandDetail: string | undefined;
    try {
      const reported = await dependencies.providerVersion(zai.profile.command, "zai-glm");
      commandAvailable = true;
      commandDetail = `${zai.profile.command}: ${reported}`;
    } catch (error) {
      commandAvailable = false;
      commandDetail = `${zai.profile.command} unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    zaiProfileFindings({
      profile: zai.profile,
      tokenPresent: zai.tokenPresent,
      commandAvailable,
      ...(commandDetail === undefined ? {} : { commandDetail }),
    }).forEach((finding) => {
      checks.push({
        name: `Z.AI GLM · ${finding.label}`,
        ok: finding.ok,
        detail: finding.detail,
        blocking: false,
        ...(finding.ok ? {} : { remediationId: "provider.install.zai" as const }),
      });
    });
  }
  return checks;
};
