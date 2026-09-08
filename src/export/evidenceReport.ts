import { redactText } from "../security/redact";
import { rulingProvenanceDetail } from "../results/rulingProvenance";
import type { RunResultCenter } from "../results/projectResult";

export type EvidenceReportInput = {
  title: string;
  runRef: string;
  exportedAt: string;
  toolVersion: string;
  workingDirectory?: string;
  pipelineName?: string;
  result: RunResultCenter;
  omissions: string[];
};

const clean = (value: string): string => redactText(value).trim();

const bullet = (values: string[], empty: string): string =>
  values.length === 0 ? `_${empty}_\n` : `${values.map((value) => `- ${clean(value)}`).join("\n")}\n`;

const findingLine = (finding: RunResultCenter["findings"][number]): string => {
  const location = finding.location === undefined
    ? ""
    : ` · ${finding.location.file}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}${finding.location.endLine === undefined ? "" : `-${String(finding.location.endLine)}`}`}`;
  const evidence = finding.evidence.length === 0 ? "none recorded" : finding.evidence.join("; ");
  const challenges = finding.challenges.length === 0 ? "none recorded" : finding.challenges.join("; ");
  return `[${finding.disposition}] ${finding.subject}${location} — ${finding.message}. Evidence: ${evidence}. Challenges: ${challenges}. Decision ${finding.provenance.stepId} by ${finding.provenance.participantIds.join(", ")}`;
};

export const renderEvidenceMarkdown = (input: EvidenceReportInput): string => {
  const { result } = input;
  const checks = result.checks.length === 0
    ? "_No verification evidence was recorded._\n"
    : `| Check | Status |\n| --- | --- |\n${result.checks
        .map((check) => `| \`${clean(check.command)}\` | ${check.status} |`)
        .join("\n")}\n`;
  const providers = result.providers.length === 0
    ? "_No provider was recorded._\n"
    : bullet(
        result.providers.map((provider) =>
          provider.model
            ? `${provider.name} (${provider.adapter} · ${provider.model})`
            : `${provider.name} (${provider.adapter})`,
        ),
        "",
      );
  return [
    `# ${clean(input.title)}`,
    "",
    `- Run: \`${input.runRef}\``,
    `- Status: ${result.status}`,
    `- Exported: ${input.exportedAt}`,
    `- Tool: Bachata ${input.toolVersion}`,
    ...(input.pipelineName ? [`- Pipeline: ${clean(input.pipelineName)}`] : []),
    ...(input.workingDirectory ? [`- Working directory: \`${input.workingDirectory}\``] : []),
    "",
    "## Changed files",
    "",
    bullet(result.changedFiles, "No changed files were recorded."),
    ...(result.diffSummary ? ["```", clean(result.diffSummary), "```", ""] : []),
    "## Verification",
    "",
    checks,
    "## Final ruling",
    "",
    result.finalRuling ? `${clean(result.finalRuling)}\n` : "_No final ruling was recorded._\n",
    ...(result.rulingProvenance
      ? [`${clean(rulingProvenanceDetail(result.rulingProvenance))}.`, ""]
      : result.rulingBy
        ? [`Ruled by ${clean(result.rulingBy)}.`, ""]
        : []),
    "## Providers",
    "",
    providers,
    "## Unresolved risks",
    "",
    bullet(result.unresolvedRisks, "No unresolved risks were recorded."),
    "## Model findings",
    "",
    bullet((result.findings ?? []).map(findingLine), "No typed model findings were recorded."),
    "## Recovered errors",
    "",
    bullet(result.recoveredErrors, "No recovered errors were recorded."),
    "## Evidence gaps",
    "",
    bullet(result.evidenceGaps, "No evidence gaps were recorded."),
    ...(result.retainedWorktree
      ? ["## Recovery worktree", "", `\`${result.retainedWorktree}\``, ""]
      : []),
    "## Export omissions",
    "",
    bullet(input.omissions, "None declared."),
  ].join("\n");
};

type SarifResult = {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations?: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number; endLine?: number };
    };
  }>;
};

const sarifRules = [
  {
    id: "bachata.model-finding",
    name: "AcceptedModelFinding",
    shortDescription: { text: "An evidence-challenged model finding accepted for action" },
    fullDescription: { text: "A typed model finding reached an explicit accepted disposition with multi-participant provenance." },
    defaultConfiguration: { level: "warning" },
  },
  {
    id: "bachata.failed-check",
    name: "FailedCheck",
    shortDescription: { text: "A controller-owned verification check did not pass" },
    fullDescription: { text: "A deterministic check declared by the run reported a non-passing status." },
    defaultConfiguration: { level: "error" },
  },
  {
    id: "bachata.evidence-gap",
    name: "EvidenceGap",
    shortDescription: { text: "Something the run did not prove" },
    fullDescription: { text: "The run states explicitly that this was not verified." },
    defaultConfiguration: { level: "note" },
  },
] as const;

export const renderEvidenceSarif = (input: EvidenceReportInput): string => {
  const { result } = input;
  const artifacts = result.changedFiles.map((file) => ({
    location: { uri: file.replaceAll("\\", "/") },
  }));
  const results: SarifResult[] = [
    ...result.checks
      .filter((check) => check.status === "failed" || check.status === "timedOut")
      .map((check): SarifResult => ({
        ruleId: "bachata.failed-check",
        level: "error",
        message: { text: `${clean(check.command)} ${check.status}` },
      })),
    ...(result.findings ?? [])
      .filter((finding) => finding.disposition === "accepted")
      .map((finding): SarifResult => ({
        ruleId: "bachata.model-finding",
        level: finding.severity === "error"
          ? "error"
          : finding.severity === "information"
            ? "note"
            : "warning",
        message: { text: clean(finding.message) },
        ...(finding.location === undefined
          ? {}
          : {
              locations: [{
                physicalLocation: {
                  artifactLocation: { uri: finding.location.file.replaceAll("\\", "/") },
                  ...(finding.location.startLine === undefined
                    ? {}
                    : {
                        region: {
                          startLine: finding.location.startLine,
                          ...(finding.location.endLine === undefined
                            ? {}
                            : { endLine: finding.location.endLine }),
                        },
                      }),
                },
              }],
            }),
      })),
    ...result.evidenceGaps.map((gap): SarifResult => ({
      ruleId: "bachata.evidence-gap",
      level: "note",
      message: { text: clean(gap) },
    })),
  ];
  const document = {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spectool/main/schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Bachata",
            version: input.toolVersion,
            rules: sarifRules,
          },
        },
        automationDetails: { id: `bachata/${input.runRef}` },
        invocations: [
          {
            executionSuccessful: result.status === "completed",
            ...(input.workingDirectory
              ? { workingDirectory: { uri: input.workingDirectory.replaceAll("\\", "/") } }
              : {}),
            endTimeUtc: input.exportedAt,
          },
        ],
        artifacts,
        results,
      },
    ],
  };
  return `${JSON.stringify(document, undefined, 2)}\n`;
};
