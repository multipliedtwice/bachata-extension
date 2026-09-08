import { EXPORT_POLICY_PATH, EXPORT_REVIEW_WARNING, exportRedactionRules } from "./exportPolicy";
import type { ExportPolicy } from "./exportPolicy";

/**
 * EX-3. What an export is called, how it is rendered, what it declares it removed, and when it is
 * refused.
 *
 * This is not the wiring around an export — the runtime read, the preview document, the modal, the
 * save dialog and the write all stay in the composition root, because each is an effect on VS Code
 * and none of them is a decision. What was sitting between them is: the format a request defaults
 * to, the refusal for a format the run cannot satisfy, which renderer answers it, the extension and
 * the suffix the saved file carries, the language the preview is opened in, and the disclosure the
 * person reads before agreeing to write the file.
 *
 * It was sitting there twice. The run export and the initiative export each assembled the same rule
 * list — the policy's own rules, a count of excluded paths, one line per redacted literal, pluralised
 * by hand — and each pasted the same modal body around it. Two copies of one contract means the
 * disclosure a person reads before a run export and the one they read before an initiative export
 * could drift apart, and nothing would have said so. There is one copy now, and it is a total
 * function of what the policy did rather than of where it was called from.
 */

export type ExportFormat = "bundle" | "markdown" | "sarif";

export type ExportPlan = {
  format: ExportFormat;
  /** Which renderer answers the request. `bundle` is the run bundle itself. */
  render: ExportFormat;
  /** A run bundle is resealed after redaction; a rendered report is not. */
  reseal: boolean;
  language: "markdown" | "json";
  extension: "md" | "json";
  suffix: string;
  fileName: string;
  saveFilter: Record<string, string[]>;
  saveLabel: string;
  /** The question the modal asks, in the person's terms rather than the format's. */
  prompt: string;
};

export type ExportPlanVerdict =
  | { refusal: string }
  | { refusal?: undefined; plan: ExportPlan };

const FORMAT_NAMES: Record<ExportFormat, string> = {
  bundle: "run bundle",
  markdown: "evidence as Markdown",
  sarif: "evidence as SARIF",
};

const SUFFIXES: Record<ExportFormat, string> = {
  bundle: "bachata-run",
  markdown: "bachata-evidence",
  sarif: "bachata-evidence.sarif",
};

/**
 * A format the run cannot satisfy is refused before anything is rendered.
 *
 * Only the bundle can be produced from a run that never recorded a result: the evidence formats
 * report findings, and a run with no result has none. Refusing here rather than rendering an empty
 * report is what stops an export that says nothing from looking like an export that found nothing.
 */
export const runExportPlan = (input: {
  format?: ExportFormat | undefined;
  hasEvidence: boolean;
  runRef: string;
}): ExportPlanVerdict => {
  const format = input.format ?? "bundle";
  if (format !== "bundle" && !input.hasEvidence) {
    return { refusal: "This run has no recorded result to export as evidence" };
  }
  const extension = format === "markdown" ? "md" : "json";
  const suffix = SUFFIXES[format];
  return {
    plan: {
      format,
      render: format,
      reseal: format === "bundle",
      language: format === "markdown" ? "markdown" : "json",
      extension,
      suffix,
      fileName: `${input.runRef}.${suffix}.${extension}`,
      saveFilter: format === "markdown"
        ? { "Bachata evidence report": ["md"] }
        : { "Bachata export": ["json"] },
      saveLabel: "Export",
      prompt: `Export ${FORMAT_NAMES[format]}?`,
    },
  };
};

/**
 * Everything the export removed, in one list, in the order a person reads it: what the policy
 * removes by rule, how many paths it dropped whole, and how many times each repository-owned
 * literal was replaced.
 *
 * `excluded` is a count and not the paths themselves. The paths are what the policy exists to keep
 * out of the file, and a disclosure that named them would put them back in front of whoever the
 * file is shared with.
 */
export const exportDisclosureRules = (input: {
  policy?: ExportPolicy | undefined;
  policyErrors: string[];
  excluded: number;
  excludedNote?: string | undefined;
  literals: ReadonlyArray<{ occurrences: number }>;
}): string[] => [
  ...exportRedactionRules(input.policy, input.policyErrors),
  ...(input.excluded > 0
    ? [input.excludedNote ?? `${String(input.excluded)} paths were excluded by ${EXPORT_POLICY_PATH}.`]
    : []),
  ...input.literals.map((entry) =>
    `Repository literal redacted ${String(entry.occurrences)} time${entry.occurrences === 1 ? "" : "s"}.`),
];

/**
 * The body of the modal that asks for the write. The size is the bytes that would be written, not
 * the bytes before redaction, so the number a person agrees to is the number that lands on disk.
 */
export const exportConfirmationDetail = (input: {
  content: string;
  rules: string[];
  contents?: string | undefined;
}): string =>
  [
    `Size: ${String(Buffer.byteLength(input.content, "utf8"))} bytes.`,
    ...(input.contents === undefined ? [] : [input.contents]),
    "",
    "Applied redaction rules:",
    ...input.rules.map((rule) => `- ${rule}`),
    "",
    EXPORT_REVIEW_WARNING,
  ].join("\n");
