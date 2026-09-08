import { runBundleDigest } from "./runBundle";
import { parseRunBundle } from "./runBundleImport";
import { parseRunResult } from "../results/projectResult";
import type { JsonValue } from "../adapters/types";
import type { RunResultCenter } from "../results/projectResult";

export type BundleIntegrityState = "verified" | "mismatch" | "unrecorded";

export type BundleIntegrity = {
  state: BundleIntegrityState;
  computed: string;
  declared?: string;
  statement: string;
};

export type RunBundleInspection = {
  integrity: BundleIntegrity;
  exportedAt: string;
  runRef: string;
  title: string;
  pipelineId?: string;
  pipelineHash?: string;
  toolVersion?: string;
  workingDirectory?: string;
  providers: Array<{ name: string; adapter: string; model?: string }>;
  result?: RunResultCenter;
  errors: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const integrityStatements: Record<BundleIntegrityState, string> = {
  verified: "The recorded digest matches this file, so it has not been changed by accident. The digest is self-declared: anyone who edits the bundle can recompute it, so this is not proof of authorship or of deliberate tampering.",
  mismatch: "The recorded digest does not match this file: its version, export time, or run section changed after export. Treat every claim in it as unproven.",
  unrecorded: "This bundle records no digest, so Bachata cannot tell whether it changed after it was exported.",
};

export const inspectRunBundleIntegrity = (value: unknown): BundleIntegrity => {
  if (!isRecord(value) || value.run === undefined || value.version !== 1 ||
    typeof value.exportedAt !== "string") {
    return {
      state: "unrecorded",
      computed: "",
      statement: integrityStatements.unrecorded,
    };
  }
  const computed = runBundleDigest({
    version: 1,
    exportedAt: value.exportedAt,
    run: value.run as JsonValue,
  });
  const declared = isRecord(value.integrity) && typeof value.integrity.value === "string"
    ? value.integrity.value
    : undefined;
  const state: BundleIntegrityState = declared === undefined
    ? "unrecorded"
    : declared === computed
      ? "verified"
      : "mismatch";
  return {
    state,
    computed,
    ...(declared === undefined ? {} : { declared }),
    statement: integrityStatements[state],
  };
};

export const inspectRunBundle = (source: string): RunBundleInspection | { errors: string[] } => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return { errors: [`The run bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const integrity = inspectRunBundleIntegrity(value);
  const parsed = parseRunBundle(source);
  const bundle = isRecord(value) && isRecord(value.run) ? value.run : undefined;
  const result = bundle && isRecord(bundle.result) ? parseRunResult(bundle.result) : undefined;
  if (!parsed.replay) {
    return {
      integrity,
      exportedAt: isRecord(value) && typeof value.exportedAt === "string" ? value.exportedAt : "unknown",
      runRef: "unknown",
      title: "Unreadable run bundle",
      providers: [],
      ...(result === undefined ? {} : { result }),
      errors: parsed.errors,
    };
  }
  return {
    integrity,
    exportedAt: parsed.replay.exportedAt,
    runRef: parsed.replay.runRef,
    title: parsed.replay.title,
    ...(parsed.replay.pipelineId === undefined ? {} : { pipelineId: parsed.replay.pipelineId }),
    ...(parsed.replay.pipelineHash === undefined ? {} : { pipelineHash: parsed.replay.pipelineHash }),
    ...(parsed.replay.toolVersion === undefined ? {} : { toolVersion: parsed.replay.toolVersion }),
    ...(parsed.replay.workingDirectory === undefined
      ? {}
      : { workingDirectory: parsed.replay.workingDirectory }),
    providers: parsed.replay.providers,
    ...(result === undefined ? {} : { result }),
    errors: [],
  };
};

const section = (title: string, lines: string[], empty: string): string =>
  `## ${title}\n\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : empty}\n`;

export const renderRunBundleReport = (
  inspection: RunBundleInspection | { errors: string[] },
): string => {
  if (!("integrity" in inspection)) {
    return `# Run bundle\n\nThis file could not be read.\n\n${inspection.errors.map((error) => `- ${error}`).join("\n")}\n`;
  }
  const result = inspection.result;
  return [
    `# ${inspection.title}`,
    "",
    "Read-only inspection. Nothing was created and no run was started.",
    "",
    section("Integrity", [
      `State: ${inspection.integrity.state}`,
      `Recorded digest: ${inspection.integrity.declared ?? "none"}`,
      `Computed digest: ${inspection.integrity.computed || "none"}`,
      inspection.integrity.statement,
    ], ""),
    section("Identity", [
      `Run: ${inspection.runRef}`,
      `Exported: ${inspection.exportedAt}`,
      `Pipeline: ${inspection.pipelineId ?? "unreported"}`,
      `Pipeline hash: ${inspection.pipelineHash ?? "unreported"}`,
      `Extension version: ${inspection.toolVersion ?? "unreported"}`,
      `Working directory: ${inspection.workingDirectory ?? "unreported"}`,
    ], ""),
    section(
      "Providers",
      inspection.providers.map((provider) =>
        `${provider.name} · ${provider.adapter} · model ${provider.model ?? "unreported"}`),
      "This bundle records no provider.",
    ),
    section(
      "Verification",
      (result?.checks ?? []).map((check) =>
        `${check.command}: ${check.status}${check.stale === true ? " (stale)" : ""}`),
      "This bundle records no verification check.",
    ),
    section("Changed files", result?.changedFiles ?? [], "This bundle records no changed file."),
    section(
      "Evidence",
      (result?.evidence ?? []).map((entry) => `${entry.label}: ${entry.state} — ${entry.detail}`),
      "This bundle records no evidence ledger.",
    ),
    section(
      "Unresolved risks",
      result?.unresolvedRisks ?? [],
      "This bundle records no unresolved risk.",
    ),
    section(
      "Model findings",
      (result?.findings ?? []).map((finding) =>
        `${finding.disposition} · ${finding.subject} — ${finding.message}`),
      "This bundle records no typed model finding.",
    ),
    section(
      "Final assessment",
      result
        ? [`${result.finalAssessment.outcome} · ${result.finalAssessment.method}`, result.finalAssessment.summary]
        : [],
      "This bundle records no final assessment.",
    ),
    section("Problems reading this bundle", inspection.errors, "None."),
  ].join("\n");
};
