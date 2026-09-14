import type { ModelFinding, RunResultCenter } from "./projectResult";
import { redactFreeFormText, redactText } from "../security/redact";
import { boundedMarkdown, boundedResultInput, boundedResultKeys, boundedResultValue, RESULT_OMISSION_NOTICE } from "./boundedResultInput";
import { RESULT_TEXT_LIMITS } from "./textLimits";

export const readableResultFields: Readonly<Record<string, string>> = {
  summary: "Summary",
  title: "Title",
  subject: "Subject",
  message: "Message",
  text: "Text",
  statement: "Statement",
  conclusion: "Conclusion",
  recommendation: "Recommendation",
  reason: "Reason",
  rationale: "Rationale",
  description: "Description",
  details: "Details",
  findings: "Findings",
  evidence: "Evidence",
  challenges: "Challenges",
  location: "Location",
  file: "File",
  startLine: "Start line",
  endLine: "End line",
  severity: "Severity",
  disposition: "Provider-reported disposition",
  accepted: "Provider-reported acceptance",
  objections: "Objections",
  unresolvedRisks: "Unresolved risks",
  risks: "Risks",
  tradeOffs: "Trade-offs",
  validationErrors: "Validation errors",
  verification: "Verification",
  checks: "Checks",
  command: "Command",
  status: "Status",
  stale: "Stale evidence",
  evidenceGaps: "Evidence gaps",
  changedFiles: "Changed files",
  candidate: "Conclusion",
  assessment: "Assessment",
  finalAssessment: "Final assessment",
  finalRuling: "Final ruling",
  warning: "Warning",
  error: "Error",
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const parseResultStructuredText = (text: string): { structured: boolean; value?: unknown } => {
  if (text.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits) return { structured: true };
  const trimmed = text.trim();
  if (/^\[[^\]\r\n]+\]\(/u.test(trimmed)) return { structured: false };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  if (!/^[\[{"]/u.test(candidate)) return { structured: false };
  try {
    return { structured: true, value: JSON.parse(candidate) as unknown };
  } catch {
    return { structured: /^\{\s*["}]|^\[\s*(?:[\[{"\]]|(?:-?\d+(?:\.\d+)?|true|false|null)\s*(?:,|\]))/u.test(candidate) };
  }
};

const findingMatches = (value: Record<string, unknown>, finding: ModelFinding): boolean =>
  value.id === finding.id && value.subject === finding.subject && value.message === finding.message;

const projectTextFragments = (text: string, project: (value: unknown) => string): string => {
  let output = "";
  let copied = 0;
  for (let start = 0; start < text.length; start += 1) {
    if (!/^(?:\{\s*"|\[\s*\{)/u.test(text.slice(start, start + 32))) continue;
    let nesting = 0;
    let quoted = false;
    let escaped = false;
    let end = start;
    for (; end < text.length; end += 1) {
      const character = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") nesting += 1;
      else if (character === "}" || character === "]") {
        nesting -= 1;
        if (nesting === 0) break;
      }
    }
    const parsed = parseResultStructuredText(text.slice(start, end + 1));
    output += text.slice(copied, start) + project(parsed.value);
    copied = Math.min(text.length, end + 1);
    start = end;
  }
  return output + text.slice(copied);
};

type ProjectionBudget = { visited: number; text: number; projected: number; omitted: boolean };

const keepProjectedText = (text: string, budget: ProjectionBudget): string => {
  if (budget.projected + text.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) {
    budget.omitted = true;
    return "";
  }
  budget.projected += text.length;
  return text;
};

const publicValue = (value: unknown, findings: readonly ModelFinding[], budget: ProjectionBudget, depth = 0): string => {
  if (value === undefined || value === null) return "";
  if (depth >= RESULT_TEXT_LIMITS.maximumDepth || budget.visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries) {
    budget.omitted = true;
    return "";
  }
  budget.visited += 1;
  if (typeof value === "string") {
    if (value.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits
      || budget.text + value.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) {
      budget.omitted = true;
      return "";
    }
    budget.text += value.length;
    const parsed = parseResultStructuredText(value);
    if (parsed.structured) return publicValue(parsed.value, findings, budget, depth + 1);
    const visible = redactFreeFormText(value).replace(/```(?:json)?\s*\n([\s\S]*?)\n```/giu, (block: string, body: string) => {
      const nested = parseResultStructuredText(body);
      return nested.structured ? publicValue(nested.value, findings, budget, depth + 1) : block;
    });
    return keepProjectedText(projectTextFragments(visible, (fragment) => publicValue(fragment, findings, budget, depth + 1)).trim(), budget);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (Array.isArray(value)) {
    const output: string[] = [];
    const count = Math.min(value.length, RESULT_TEXT_LIMITS.maximumSectionEntries);
    if (count < value.length) budget.omitted = true;
    for (let index = 0; index < count; index += 1) {
      const item = publicValue(value[index], findings, budget, depth + 1);
      if (item) output.push(`- ${item.replaceAll("\n", "\n  ")}`);
      if (budget.visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries) break;
    }
    return keepProjectedText(output.join("\n"), budget);
  }
  const record = recordOf(value);
  if (!record) return "";
  const finding = findings.find((item) => findingMatches(record, item));
  if (finding) return findingMarkdown(finding, findings, budget, depth + 1);
  return keepProjectedText(Object.entries(readableResultFields).flatMap(([key, label]) => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return [];
    const text = publicValue(record[key], findings, budget, depth + 1);
    return text ? [`**${label}:** ${text}`] : [];
  }).join("\n\n"), budget);
};

const locationMarkdown = (finding: ModelFinding, findings: readonly ModelFinding[], budget: ProjectionBudget, depth: number): string => {
  if (!finding.location) return "";
  const file = publicValue(finding.location.file, findings, budget, depth + 1);
  if (!file) return "";
  const start = finding.location.startLine;
  const end = finding.location.endLine;
  return `${file}${start === undefined ? "" : `:${String(start)}${end === undefined || end === start ? "" : `–${String(end)}`}`}`;
};

const findingMarkdown = (finding: ModelFinding, findings: readonly ModelFinding[], budget: ProjectionBudget, depth = 0): string => {
  const subject = publicValue(finding.subject, findings, budget, depth + 1);
  const message = publicValue(finding.message, findings, budget, depth + 1);
  if (!subject && !message) return "";
  const evidence = publicValue(finding.evidence, findings, budget, depth + 1);
  const challenges = publicValue(finding.challenges, findings, budget, depth + 1);
  const location = locationMarkdown(finding, findings, budget, depth);
  return keepProjectedText([
    `**${subject || "Finding"}**`,
    `Recorded disposition: ${finding.disposition}${finding.severity ? ` · Severity: ${finding.severity}` : ""}`,
    ...(location ? [`Location: ${location}`] : []),
    ...(message ? [message] : []),
    ...(evidence ? [`Evidence:\n${evidence}`] : []),
    ...(challenges ? [`Challenges:\n${challenges}`] : []),
  ].join("\n\n"), budget);
};

const assessmentLabels: Readonly<Record<RunResultCenter["finalAssessment"]["outcome"], string>> = {
  completed: "Completed",
  verificationFailed: "Verification failed",
  inconclusive: "Inconclusive",
  failedBeforeRuling: "Failed before a final ruling",
  notApplicable: "Not applicable",
};

const checkLabels: Readonly<Record<RunResultCenter["checks"][number]["status"], string>> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  cancelled: "Cancelled",
};

const rulingMarkdown = (result: RunResultCenter, budget: ProjectionBudget): string[] => {
  const decision = result.finalDecision;
  const resolution = decision?.humanResolution;
  const rationale = publicValue(resolution?.rationale, result.findings, budget);
  if (decision && (decision.status === "pending" || resolution?.action === "acceptUnresolved")) {
    return [
      decision.status === "pending" ? "The review is unresolved." : "The run finished with unresolved findings; no participant conclusion was accepted as the final answer.",
      ...(rationale ? [`Rationale: ${rationale}`] : []),
    ];
  }
  const visible = publicValue(decision?.candidate ?? result.finalRuling, result.findings, budget);
  return [visible, ...(rationale ? [`Rationale: ${rationale}`] : [])].filter(Boolean);
};

const opaqueToken = (value: string): boolean =>
  /^(?:[a-z][a-z\d]*[-_:])?[\da-f]{32,128}$/iu.test(value)
  || /^(?=[\da-f]*\d)[\da-f]{7,31}$/iu.test(value)
  || /^(?:[a-z][a-z\d]*[-_:])?[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(value)
  || /^[0-7][\dA-HJKMNP-TV-Z]{25}$/u.test(value)
  || (value.length >= 24
    && /^[A-Za-z\d_+=-]+$/u.test(value)
    && /[a-z]/u.test(value)
    && /[A-Z]/u.test(value)
    && /\d/u.test(value)
    && new Set(value).size >= 14);

const internalIdentityField = (key: string): boolean =>
  /(^id$|(?:Id|Ids|Ref|Refs|Hash|Digest|Fingerprint)$|^(?:ruledBy|resolvedBy|selectedParticipant|providerSession|session|sessionData|candidateTree|outputReference|reference|digest|hash|fingerprint|retainedWorktree|resultVersion|provenance|metadata)$)/u.test(key);

const opaqueContextKeys = [...new Set([
  "failure", "finalAssessment", "finalDecision", "humanResolution",
  ...boundedResultKeys.filter(internalIdentityField),
  ...boundedResultKeys,
])];

const internalOpaqueValues = (value: unknown, budget: ProjectionBudget, hidden = false, depth = 0): string[] => {
  if (depth >= RESULT_TEXT_LIMITS.maximumDepth
    || budget.visited >= RESULT_TEXT_LIMITS.maximumVisitedEntries
    || value === null || value === undefined) return [];
  budget.visited += 1;
  if (typeof value === "string") {
    if (value.length > RESULT_TEXT_LIMITS.maximumEntryTextUnits
      || budget.text + value.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) return [];
    budget.text += value.length;
    const parsed = parseResultStructuredText(value);
    if (parsed.structured) return internalOpaqueValues(boundedResultValue(parsed.value).value, budget, hidden, depth + 1);
    if (hidden && opaqueToken(value)) return [value];
    const nested: string[] = [];
    projectTextFragments(value, (fragment) => {
      nested.push(...internalOpaqueValues(boundedResultValue(fragment).value, budget, hidden, depth + 1));
      return "";
    });
    return nested;
  }
  if (Array.isArray(value)) return value.slice(0, RESULT_TEXT_LIMITS.maximumSectionEntries).flatMap((item) => internalOpaqueValues(item, budget, hidden, depth + 1));
  const record = recordOf(value);
  return record ? opaqueContextKeys.flatMap((key) => Object.hasOwn(record, key) ? internalOpaqueValues(
    record[key],
    budget,
    hidden || internalIdentityField(key),
    depth + 1,
  ) : []) : [];
};

const scrubGitReferences = (text: string): string => text
  .replace(/\b(git[ \t]+(?:show|diff|log|rev-parse|cat-file|checkout|reset|cherry-pick|revert|merge|rebase)(?:[ \t]+--?[\w=.-]+)*[ \t]+)([\da-f]{7,128}(?:(?:\.\.\.?|[ \t]+)[\da-f]{7,128})?)(?![\p{L}\p{N}_])/giu, (_match, prefix: string, references: string) => `${prefix}${references.replace(/[\da-f]{7,128}/giu, "[hash omitted]")}`)
  .replace(/\b((?:diff[ \t]+)?index[ \t]+)([\da-f]{7,128}\.\.\.?[\da-f]{7,128})(?![\p{L}\p{N}_])/giu, (_match, prefix: string, references: string) => `${prefix}${references.replace(/[\da-f]{7,128}/giu, "[hash omitted]")}`)
  .replace(/\b((?:commit|revision|object|tree|blob|hash|digest|fingerprint|sha-?(?:1|256))(?:[ \t]+(?:id|hash))?(?:[ \t]+|[ \t]*[:=][ \t]*))(`?)([\da-f]{7,128})\2(?![\p{L}\p{N}_])/giu, (match: string, prefix: string, quote: string, reference: string) => quote || /\d/u.test(reference) || reference.length >= 12 || /\b(?:id|hash|digest|fingerprint|sha-?(?:1|256))\b/iu.test(prefix)
    ? `${prefix}${quote}[hash omitted]${quote}`
    : match);

const recordedOpaquePattern = (source: unknown): RegExp | undefined => {
  const budget: ProjectionBudget = { visited: 0, text: 0, projected: 0, omitted: false };
  const values = [...new Set(internalOpaqueValues(source, budget))].sort((left, right) => right.length - left.length);
  if (values.length === 0) return undefined;
  const alternatives = values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "gu");
};

const scrubWithOpaqueValues = (text: string, recorded: RegExp | undefined): string => {
  if (text.length > RESULT_TEXT_LIMITS.maximumInputTextUnits) return RESULT_OMISSION_NOTICE;
  let visible = scrubGitReferences(text);
  if (recorded) visible = visible.replace(recorded, "[internal identifier omitted]");
  return visible
    .replace(/\b[A-Za-z\d_+=-]{24,}\b/gu, (value) => opaqueToken(value) ? "[internal identifier omitted]" : value)
    .replace(/\b(?:session|providerSession|thread|run|execution|agent|participant|step|reference|file|candidate|result|version)[_-][A-Za-z\d_+=-]{16,}\b/gu, (value) => opaqueToken(value) ? "[internal identifier omitted]" : value)
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu, "[internal identifier omitted]")
    .replace(/\b[0-7][\dA-HJKMNP-TV-Z]{25}\b/gu, "[internal identifier omitted]")
    .replace(/\b[\da-f]{32,128}\b/giu, "[hash omitted]");
};

export const createOpaqueResultScrubber = (source?: unknown): ((text: string) => string) => {
  const recorded = recordedOpaquePattern(source);
  return (text) => scrubWithOpaqueValues(text, recorded);
};

export const scrubOpaqueResultTokens = (text: string, source?: unknown): string =>
  createOpaqueResultScrubber(source)(text);

export const readableResultMarkdown = (
  source: RunResultCenter | undefined,
  options: { maximumUnits?: number; omitted?: boolean; opaqueSource?: unknown } = {},
): string => {
  if (!source) return "";
  const bounded = boundedResultInput(source);
  const result = bounded.result;
  const budget: ProjectionBudget = { visited: 0, text: 0, projected: 0, omitted: bounded.omitted || options.omitted === true };
  const summary = publicValue(result.finalAssessment.summary, result.findings, budget);
  const failure = publicValue(result.finalAssessment.failure?.error ?? result.failure?.error, result.findings, budget);
  const ruling = rulingMarkdown(result, budget);
  const pendingSections: Array<Array<() => string>> = [
    result.findings.map((finding) => () => findingMarkdown(finding, result.findings, budget)),
    [...new Set([...result.unresolvedRisks, ...(result.finalDecision?.unresolvedRisks ?? [])])]
      .map((risk) => () => {
        const text = publicValue(risk, result.findings, budget);
        return text ? `- ${text.replaceAll("\n", "\n  ")}` : "";
      }),
    result.evidenceGaps.map((gap) => () => {
      const text = publicValue(gap, result.findings, budget);
      return text ? `- ${text.replaceAll("\n", "\n  ")}` : "";
    }),
    result.changedFiles.map((file) => () => {
      const text = publicValue(file, result.findings, budget);
      return text ? `- ${text.replaceAll("\n", "\n  ")}` : "";
    }),
    result.checks.map((check) => () => {
      const command = redactText(publicValue(check.command, result.findings, budget)).trim();
      return command ? `- ${command.replaceAll("\n", "\n  ")} — ${checkLabels[check.status]}${check.stale ? " (stale; does not verify the current work)" : ""}` : "";
    }),
  ];
  const projectedSections = pendingSections.map(() => [] as string[]);
  const projectEntry = (sectionIndex: number, entryIndex: number): void => {
    const render = pendingSections[sectionIndex]?.[entryIndex];
    const target = projectedSections[sectionIndex];
    if (!render || !target) return;
    const text = render();
    if (text) target.push(text);
  };
  for (let index = 0; index < pendingSections.length; index += 1) projectEntry(index, 0);
  for (let sectionIndex = 0; sectionIndex < pendingSections.length; sectionIndex += 1) {
    const section = pendingSections[sectionIndex];
    if (!section) continue;
    for (let index = 1; index < section.length; index += 1) projectEntry(sectionIndex, index);
  }
  const findings = projectedSections[0] ?? [];
  const risks = projectedSections[1] ?? [];
  const gaps = projectedSections[2] ?? [];
  const files = projectedSections[3] ?? [];
  const checks = projectedSections[4] ?? [];
  const decision = result.finalDecision;
  if (decision) {
    for (const item of decision.objections) {
      const objection = recordOf(item);
      const text = publicValue(objection?.text, result.findings, budget);
      if (!text) continue;
      const disposition = decision.status === "pending" || decision.status === "resolved"
        ? "Unresolved"
        : objection?.accepted === true ? "Aligned" : decision.humanResolution ? "Not resolved" : "Overruled";
      ruling.push(`Ruling objections:\n- ${text} — ${disposition}`);
    }
    if (decision.status === "pending" || decision.humanResolution?.action === "acceptUnresolved") {
      for (const [index, item] of decision.participants.entries()) {
        const conclusion = publicValue(recordOf(item)?.candidate, [], budget);
        if (conclusion) ruling.push(`Participant conclusion ${String(index + 1)} (unresolved):\n\n${conclusion}`);
      }
    }
  }
  if (!summary && !failure && ruling.length === 0 && findings.length === 0 && files.length === 0
    && checks.length === 0 && risks.length === 0 && gaps.length === 0 && !budget.omitted) return "";
  const status = result.status === "error" ? "Failed" : result.status === "interrupted" ? "Interrupted" : "Completed";
  const assessment = result.finalAssessment.outcome;
  const sections = [
    { title: "## Final assessment", entries: [
      [assessment ? `Outcome: ${assessmentLabels[assessment]}` : "", summary || "No final assessment was recorded."].filter(Boolean).join("\n\n"),
      ...(failure ? [`Failure: ${failure}`] : []),
    ] },
    { title: "## Final ruling", entries: ruling },
    { title: "## Findings", entries: findings },
    { title: "## Unresolved risks", entries: risks },
    { title: "## Evidence gaps", entries: gaps },
    { title: "## Changed files", entries: files },
    { title: "## Verification", entries: checks.length > 0 ? checks : [result.expectations.verification === false
      ? "This pipeline declares no controller-owned verification."
      : "No verification evidence was recorded."] },
  ];
  const maximumUnits = Math.min(options.maximumUnits ?? RESULT_TEXT_LIMITS.readableMarkdownUnits, RESULT_TEXT_LIMITS.readableMarkdownUnits);
  const recorded = recordedOpaquePattern(options.opaqueSource ?? source);
  const title = `# Run result: ${status}`;
  const contentLimit = maximumUnits - RESULT_OMISSION_NOTICE.length - 2;
  const retained = sections.map(() => [] as string[]);
  let length = title.length;
  const append = (sectionIndex: number, entryIndex: number): void => {
    const section = sections[sectionIndex];
    const selected = retained[sectionIndex];
    if (!section || !selected) return;
    const raw = section.entries[entryIndex];
    if (raw === undefined) return;
    const entry = scrubWithOpaqueValues(raw, recorded);
    const block = selected.length > 0 ? entry : `${section.title}\n\n${entry}`;
    const complete = boundedMarkdown([block], maximumUnits);
    if (complete !== block || length + block.length + 2 > contentLimit) {
      budget.omitted = true;
      return;
    }
    selected.push(entry);
    length += block.length + 2;
  };
  for (let index = 0; index < sections.length; index += 1) append(index, 0);
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    if (!section) continue;
    for (let index = 1; index < section.entries.length; index += 1) append(sectionIndex, index);
  }
  return boundedMarkdown([
    title,
    ...sections.flatMap((section, index) => {
      const entries = retained[index];
      return entries && entries.length > 0 ? [`${section.title}\n\n${entries.join("\n\n")}`] : [];
    }),
  ], maximumUnits, budget.omitted);
};
