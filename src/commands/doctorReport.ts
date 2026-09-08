import type { RuntimeReadinessReport } from "../runtime/createRuntime";
import { providerDisplayName } from "../pipeline/providerNames";

export type ProductDoctorFinding = {
  name: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  remediationId?: string | undefined;
};

export type RepositoryVerifierState = {
  registryPresent: boolean;
  proposalCount: number;
  declaredVerifierIds: string[];
};

/*
 * Never blocking. A repository that declares a test suite Bachata does not run unattended is a
 * true and useful fact, but it is not a defect in the run about to start: the built-in
 * checks still do exactly what their label says.
 */
export const repositoryVerifierFinding = (
  state: RepositoryVerifierState,
): ProductDoctorFinding => {
  if (state.declaredVerifierIds.length > 0) {
    return {
      name: "Repository verifiers",
      ok: true,
      blocking: false,
      detail: `Declared: ${state.declaredVerifierIds.join(", ")}. Bachata starts these only during Bachata: Improve This Project, and only after you approve this workspace once. Every other run refuses them, so run the underlying check yourself.`,
    };
  }
  if (state.proposalCount > 0) {
    return {
      name: "Repository verifiers",
      ok: false,
      blocking: false,
      detail: `This repository declares ${String(state.proposalCount)} check that could be recorded as a descriptor, and none is declared. Bachata verification is integrity, syntax and types only, and no repository test suite runs until a descriptor is declared and this workspace approves it.`,
      remediationId: "verifier.bootstrap",
    };
  }
  return {
    name: "Repository verifiers",
    ok: true,
    blocking: false,
    detail: state.registryPresent
      ? "A registry exists and declares no verifier."
      : "No repository check was discovered to propose. Unattended verification covers integrity, syntax and types only, and no repository test suite runs.",
  };
};

export const buildProductDoctorReport = (
  readiness: RuntimeReadinessReport,
  recovery?: { active: boolean; retainedRuns: number; integrationWorktree?: string },
  verifiers?: RepositoryVerifierState,
): ProductDoctorFinding[] => {
  const selected = readiness.pipelines.find((pipeline) =>
    pipeline.pipelineId === readiness.selectedPipelineId
  ) ?? readiness.pipelines[0];
  const selectedFailures = selected?.findings.filter((finding) => finding.status !== "ready") ?? [];
  const findings: ProductDoctorFinding[] = selected?.findings.map((finding) => ({
    name: finding.label,
    ok: finding.status === "ready",
    blocking: finding.status !== "ready",
    detail: finding.detail,
    ...(finding.remediationId === undefined ? {} : { remediationId: finding.remediationId }),
  })) ?? [];
  const providerRemediation: Record<string, string> = {
    "codex-app-server": "provider.install.codex",
    "claude-code": "provider.install.claude",
    "zai-glm": "provider.install.zai",
  };
  readiness.adapters.forEach((adapter) => {
    const remediationId = providerRemediation[adapter.type];
    const required = remediationId !== undefined && selectedFailures.some((finding) =>
      finding.remediationId === remediationId
    );
    findings.push({
      name: providerDisplayName(adapter.type),
      ok: adapter.available,
      blocking: required,
      detail: adapter.detail ?? (adapter.available ? "Available" : "Unavailable"),
      ...(adapter.available || remediationId === undefined ? {} : { remediationId }),
    });
  });
  if (readiness.git.statusDetail) {
    findings.push({
      name: "Git workspace state",
      ok: readiness.git.clean !== false,
      blocking: selectedFailures.some((finding) => finding.id === "git.clean"),
      detail: readiness.git.statusDetail,
      remediationId: readiness.git.clean === false ? "doctor.run" : undefined,
    });
  }
  const selectedUsesBridge = selected?.findings.some((finding) => finding.id.startsWith("bridge.")) ?? false;
  // The Browser Bridge is installed separately and only some workflows drive one. Not having
  // it is a fact about an optional feature, not a finding to clear, unless the selected
  // workflow needs it.
  const bridgeReady = readiness.bridge.enabled && readiness.bridge.connected;
  findings.push({
    name: "Browser Bridge",
    ok: bridgeReady || !selectedUsesBridge,
    blocking: selectedUsesBridge && !bridgeReady,
    detail: bridgeReady
      ? `${String(readiness.bridge.sessions.length)} session${readiness.bridge.sessions.length === 1 ? "" : "s"} connected`
      : !readiness.bridge.enabled
        ? "Unavailable in a remote Extension Host"
        : selectedUsesBridge
          ? readiness.bridge.error ?? "Not connected"
          : "Not connected. Optional: the selected workflow does not use it.",
    remediationId: bridgeReady || !selectedUsesBridge
      ? undefined
      : readiness.bridge.enabled ? "bridge.connect" : "bridge.useLocalWindow",
  });
  findings.push({
    name: "Extension Host",
    ok: !readiness.remoteName || !selectedUsesBridge,
    blocking: Boolean(readiness.remoteName && selectedUsesBridge),
    detail: readiness.remoteName ? `Remote host: ${readiness.remoteName}` : "Local VS Code window",
    remediationId: readiness.remoteName && selectedUsesBridge ? "bridge.useLocalWindow" : undefined,
  });
  if (recovery) {
    findings.push({
      name: "Recovery state",
      ok: true,
      blocking: false,
      detail: recovery.integrationWorktree
        ? `Active retained worktree: ${recovery.integrationWorktree}`
        : `${String(recovery.retainedRuns)} retained run${recovery.retainedRuns === 1 ? "" : "s"}`,
    });
  }
  if (verifiers) findings.push(repositoryVerifierFinding(verifiers));
  const unique = new Map<string, ProductDoctorFinding>();
  findings.forEach((finding) => {
    const existing = unique.get(finding.name);
    if (!existing || (!finding.ok && existing.ok) || (finding.blocking && !existing.blocking)) {
      unique.set(finding.name, finding);
    }
  });
  return Array.from(unique.values());
};
