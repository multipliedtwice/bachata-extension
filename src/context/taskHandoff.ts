export type HandoffSnippet = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
  hashScope?: "file" | "range";
  reason: string[];
  text: string;
};

export type HandoffVerification = {
  id: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  scope?: "workspaceIntegrity" | "controllerProjectChecks";
  workspaceFingerprint?: string;
};

export type HandoffContextCoverage = {
  inventoryCount: number;
  maxInventoryFiles: number;
  inventoryTruncated: boolean;
  inventoryTimedOut?: boolean;
  ignoreFileCount?: number;
  indexedCount: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  indexedBytes: number;
  indexingTimedOut?: boolean;
  truncated: boolean;
  skippedTooLarge: number;
  skippedUnreadable: number;
  skippedBudget: number;
  skippedFileLimit: number;
};

export type HandoffContextOmission = {
  path: string;
  score: number;
  reason: string[];
};

export type HandoffContextManifestEntry = {
  path: string;
  lineCount: number;
  exports: string[];
};

export type HandoffContextManifestCoverage = {
  total: number;
  included: number;
  omitted: number;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
};

export type ManagedTaskHandoffInput = {
  taskId: string;
  originalTask: string;
  constraints: string[];
  commitMode: "never" | "allow";
  readOnly: boolean;
  readPaths?: string[];
  allowedPaths: string[];
  requiredVerificationCheckIds: string[];
  worktreePath: string;
  workspaceRevision: number;
  changedFiles: string[];
  preexistingChangedFiles: string[];
  repositoryPolicyViolations: string[];
  diff: string;
  diffOmittedFileCount: number;
  snippets: HandoffSnippet[];
  initialContextOmitted: HandoffContextOmission[];
  initialContextOmittedTotal?: number;
  contextManifest?: HandoffContextManifestEntry[];
  contextCoverage: HandoffContextCoverage;
  verification: HandoffVerification[];
  unresolved: string[];
  roleSummary?: string;
};


export type HandoffMetadataField =
  | "constraints"
  | "readPaths"
  | "allowedPaths"
  | "requiredVerificationCheckIds"
  | "changedFiles"
  | "preexistingChangedFiles"
  | "policyViolations"
  | "verification"
  | "unresolved";

export type HandoffMetadataListCoverage = {
  total: number;
  included: number;
  omitted: number;
  retrieval?: {
    kind: "context.readMetadata";
    field: HandoffMetadataField;
    nextOffset: number;
    workspaceRevision: number;
  };
};

export type ManagedTaskHandoff = {
  protocol: "bachata-task-handoff-v1";
  role: "worker" | "lead";
  taskId: string;
  originalTask: string;
  constraints: string[];
  policy: {
    commitMode: "never" | "allow";
    readPaths: string[];
    allowedPaths: string[];
    readOnly: boolean;
    requiredVerificationCheckIds: string[];
  };
  repository: {
    worktreePath: string;
    workspaceRevision: number;
    changedFiles: string[];
    preexistingChangedFiles: string[];
    policyViolations: string[];
    diff: string;
    diffTruncated: boolean;
    diffOriginalBytes: number;
    diffRetainedBytes: number;
    diffOmittedFileCount: number;
  };
  contextSelection: {
    omittedCount: number;
    omitted: HandoffContextOmission[];
  };
  contextCoverage: HandoffContextCoverage;
  context: Array<{
    id: string;
    path: string;
    lines: string;
    sha256: string;
    hashScope?: "file" | "range";
    reason: string[];
    text: string;
  }>;
  contextManifest: HandoffContextManifestEntry[];
  contextManifestCoverage: HandoffContextManifestCoverage;
  verification: HandoffVerification[];
  unresolved: string[];
  roleSummary: string;
  omittedSnippetIds: string[];
  metadataCoverage: {
    originalTask: {
      originalBytes: number;
      retainedBytes: number;
      truncated: boolean;
      retrieval?: { kind: "context.readTask"; nextOffsetBytes: number };
    };
    constraints: HandoffMetadataListCoverage;
    readPaths: HandoffMetadataListCoverage;
    allowedPaths: HandoffMetadataListCoverage;
    requiredVerificationCheckIds: HandoffMetadataListCoverage;
    changedFiles: HandoffMetadataListCoverage;
    preexistingChangedFiles: HandoffMetadataListCoverage;
    policyViolations: HandoffMetadataListCoverage;
    verification: HandoffMetadataListCoverage;
    unresolved: HandoffMetadataListCoverage;
  };
};

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safePrefix(value: string, end: number): string {
  let safeEnd = Math.max(0, Math.min(end, value.length));
  if (safeEnd > 0) {
    const code = value.charCodeAt(safeEnd - 1);
    if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;
  }
  return value.slice(0, safeEnd);
}

function bounded(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Length(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Length(safePrefix(value, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return safePrefix(value, low);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function renderedLength(handoff: ManagedTaskHandoff): number {
  return utf8Length(JSON.stringify(handoff, null, 2));
}

const CONTEXT_MANIFEST_MAX_BYTES = 8 * 1024;
const CONTEXT_MANIFEST_MAX_EXPORTS_PER_ENTRY = 16;

function fitRenderedString(
  value: string,
  maxBytes: number,
  totalBudgetBytes: number,
  assign: (value: string) => void,
  measure: () => number,
): string {
  const candidate = bounded(value, maxBytes);
  assign(candidate);
  if (measure() <= totalBudgetBytes) return candidate;
  let low = 0;
  let high = candidate.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const prefix = safePrefix(candidate, mid);
    assign(prefix);
    if (measure() <= totalBudgetBytes) {
      best = prefix;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  assign(best);
  return best;
}

function snippetEntry(snippet: HandoffSnippet): ManagedTaskHandoff["context"][number] {
  return {
    id: snippet.id,
    path: snippet.path,
    lines: `${snippet.startLine}-${snippet.endLine}`,
    sha256: snippet.sha256,
    ...(snippet.hashScope ? { hashScope: snippet.hashScope } : {}),
    reason: [...snippet.reason],
    text: snippet.text,
  };
}

export function buildManagedTaskHandoff(
  role: "worker" | "lead",
  input: ManagedTaskHandoffInput,
  options?: {
    totalBudgetBytes?: number;
    diffBudgetBytes?: number;
    snippetBudgetBytes?: number;
  },
): ManagedTaskHandoff {
  const totalBudgetBytes = Math.max(16_384, Math.min(options?.totalBudgetBytes ?? 96_000, 512_000));
  const diffBudgetBytes = Math.max(0, Math.min(options?.diffBudgetBytes ?? 24_000, Math.floor(totalBudgetBytes * 0.4)));
  const snippetBudgetBytes = Math.max(0, Math.min(options?.snippetBudgetBytes ?? 48_000, totalBudgetBytes));
  const metadataBudgetBytes = Math.max(
    8_192,
    totalBudgetBytes - diffBudgetBytes - Math.min(snippetBudgetBytes, Math.floor(totalBudgetBytes * 0.35)),
  );
  const constraints = uniqueSorted(input.constraints);
  const readPaths = uniqueSorted(input.readPaths ?? []);
  const allowedPaths = uniqueSorted(input.allowedPaths);
  const requiredVerificationCheckIds = uniqueSorted(input.requiredVerificationCheckIds);
  const changedFiles = uniqueSorted(input.changedFiles);
  const preexistingChangedFiles = uniqueSorted(input.preexistingChangedFiles);
  const policyViolations = uniqueSorted(input.repositoryPolicyViolations);
  const handoff: ManagedTaskHandoff = {
    protocol: "bachata-task-handoff-v1",
    role,
    taskId: bounded(input.taskId, 4_096),
    originalTask: "",
    constraints: [],
    policy: {
      commitMode: input.commitMode,
      readPaths: [],
      allowedPaths: [],
      readOnly: role === "lead" || input.readOnly,
      requiredVerificationCheckIds: [],
    },
    repository: {
      worktreePath: bounded(input.worktreePath, 4_096),
      workspaceRevision: input.workspaceRevision,
      changedFiles: [],
      preexistingChangedFiles: [],
      policyViolations: [],
      diff: "",
      diffTruncated: utf8Length(input.diff) > 0,
      diffOriginalBytes: utf8Length(input.diff),
      diffRetainedBytes: 0,
      diffOmittedFileCount: Math.max(0, Math.floor(input.diffOmittedFileCount)),
    },
    contextSelection: {
      omittedCount: Math.max(input.initialContextOmitted.length, input.initialContextOmittedTotal ?? input.initialContextOmitted.length),
      omitted: [],
    },
    contextCoverage: { ...input.contextCoverage },
    context: [],
    contextManifest: [],
    contextManifestCoverage: { total: 0, included: 0, omitted: 0, truncated: false, originalBytes: 0, retainedBytes: 0 },
    verification: [],
    unresolved: [],
    roleSummary: "",
    omittedSnippetIds: [],
    metadataCoverage: {
      originalTask: { originalBytes: utf8Length(input.originalTask), retainedBytes: 0, truncated: false },
      constraints: { total: constraints.length, included: 0, omitted: constraints.length },
      readPaths: { total: readPaths.length, included: 0, omitted: readPaths.length },
      allowedPaths: { total: allowedPaths.length, included: 0, omitted: allowedPaths.length },
      requiredVerificationCheckIds: { total: requiredVerificationCheckIds.length, included: 0, omitted: requiredVerificationCheckIds.length },
      changedFiles: { total: changedFiles.length, included: 0, omitted: changedFiles.length },
      preexistingChangedFiles: { total: preexistingChangedFiles.length, included: 0, omitted: preexistingChangedFiles.length },
      policyViolations: { total: policyViolations.length, included: 0, omitted: policyViolations.length },
      verification: { total: input.verification.length, included: 0, omitted: input.verification.length },
      unresolved: { total: input.unresolved.length, included: 0, omitted: input.unresolved.length },
    },
  };
  const measure = (): number => renderedLength(handoff);
  fitRenderedString(input.originalTask, Math.min(16_384, Math.floor(metadataBudgetBytes * 0.55)), metadataBudgetBytes, (value) => {
    handoff.originalTask = value;
    handoff.metadataCoverage.originalTask.retainedBytes = utf8Length(value);
    handoff.metadataCoverage.originalTask.truncated = utf8Length(value) < utf8Length(input.originalTask);
    if (handoff.metadataCoverage.originalTask.truncated) {
      handoff.metadataCoverage.originalTask.retrieval = {
        kind: "context.readTask",
        nextOffsetBytes: handoff.metadataCoverage.originalTask.retainedBytes,
      };
    } else {
      delete handoff.metadataCoverage.originalTask.retrieval;
    }
  }, measure);

  const appendStrings = (
    values: string[],
    target: string[],
    coverage: HandoffMetadataListCoverage,
  ): void => {
    for (const value of values) {
      target.push(value);
      coverage.included = target.length;
      coverage.omitted = Math.max(0, coverage.total - coverage.included);
      if (measure() > metadataBudgetBytes) {
        target.pop();
        coverage.included = target.length;
        coverage.omitted = Math.max(0, coverage.total - coverage.included);
        break;
      }
    }
  };

  appendStrings(constraints, handoff.constraints, handoff.metadataCoverage.constraints);
  appendStrings(readPaths, handoff.policy.readPaths, handoff.metadataCoverage.readPaths);
  appendStrings(allowedPaths, handoff.policy.allowedPaths, handoff.metadataCoverage.allowedPaths);
  appendStrings(requiredVerificationCheckIds, handoff.policy.requiredVerificationCheckIds, handoff.metadataCoverage.requiredVerificationCheckIds);
  appendStrings(changedFiles, handoff.repository.changedFiles, handoff.metadataCoverage.changedFiles);
  appendStrings(preexistingChangedFiles, handoff.repository.preexistingChangedFiles, handoff.metadataCoverage.preexistingChangedFiles);
  appendStrings(policyViolations, handoff.repository.policyViolations, handoff.metadataCoverage.policyViolations);

  for (const entry of input.verification) {
    handoff.verification.push({ ...entry, summary: bounded(entry.summary, 4_096) });
    handoff.metadataCoverage.verification.included = handoff.verification.length;
    handoff.metadataCoverage.verification.omitted = Math.max(0, input.verification.length - handoff.verification.length);
    if (measure() > metadataBudgetBytes) {
      handoff.verification.pop();
      handoff.metadataCoverage.verification.included = handoff.verification.length;
      handoff.metadataCoverage.verification.omitted = Math.max(0, input.verification.length - handoff.verification.length);
      break;
    }
  }
  appendStrings(input.unresolved.map((value) => bounded(value, 4_096)), handoff.unresolved, handoff.metadataCoverage.unresolved);

  const retrievalFields: Array<[HandoffMetadataField, HandoffMetadataListCoverage]> = [
    ["constraints", handoff.metadataCoverage.constraints],
    ["readPaths", handoff.metadataCoverage.readPaths],
    ["allowedPaths", handoff.metadataCoverage.allowedPaths],
    ["requiredVerificationCheckIds", handoff.metadataCoverage.requiredVerificationCheckIds],
    ["changedFiles", handoff.metadataCoverage.changedFiles],
    ["preexistingChangedFiles", handoff.metadataCoverage.preexistingChangedFiles],
    ["policyViolations", handoff.metadataCoverage.policyViolations],
    ["verification", handoff.metadataCoverage.verification],
    ["unresolved", handoff.metadataCoverage.unresolved],
  ];
  for (const [field, coverage] of retrievalFields) {
    if (coverage.omitted > 0) {
      coverage.retrieval = {
        kind: "context.readMetadata",
        field,
        nextOffset: coverage.included,
        workspaceRevision: input.workspaceRevision,
      };
    } else {
      delete coverage.retrieval;
    }
  }

  const preSnippetBudgetBytes = Math.max(metadataBudgetBytes, totalBudgetBytes - Math.min(snippetBudgetBytes, Math.floor(totalBudgetBytes * 0.3)));
  fitRenderedString(input.roleSummary ?? "", 4_096, preSnippetBudgetBytes, (value) => {
    handoff.roleSummary = value;
  }, measure);
  fitRenderedString(input.diff, diffBudgetBytes, totalBudgetBytes, (value) => {
    handoff.repository.diff = value;
    handoff.repository.diffRetainedBytes = utf8Length(value);
    handoff.repository.diffTruncated = handoff.repository.diffRetainedBytes < handoff.repository.diffOriginalBytes;
  }, measure);

  for (const omission of input.initialContextOmitted) {
    handoff.contextSelection.omitted.push({
      path: bounded(omission.path, 4_096),
      score: omission.score,
      reason: omission.reason.map((value) => bounded(value, 1_024)),
    });
    if (measure() > preSnippetBudgetBytes) {
      handoff.contextSelection.omitted.pop();
      break;
    }
  }

  const manifestEntries = input.contextManifest ?? [];
  let manifestBytes = 0;
  let manifestOriginalBytes = 0;
  for (const entry of manifestEntries) {
    const rendered: HandoffContextManifestEntry = {
      path: bounded(entry.path, 1_024),
      lineCount: Math.max(0, Math.floor(entry.lineCount)),
      exports: entry.exports.slice(0, CONTEXT_MANIFEST_MAX_EXPORTS_PER_ENTRY).map((value) => bounded(value, 256)),
    };
    const entryBytes = utf8Length(JSON.stringify(rendered));
    manifestOriginalBytes += entryBytes;
    if (handoff.contextManifest.length > 0 && manifestBytes + entryBytes > CONTEXT_MANIFEST_MAX_BYTES) {
      break;
    }
    handoff.contextManifest.push(rendered);
    manifestBytes += entryBytes;
    if (measure() > preSnippetBudgetBytes) {
      handoff.contextManifest.pop();
      manifestBytes -= entryBytes;
      break;
    }
  }
  handoff.contextManifestCoverage = {
    total: manifestEntries.length,
    included: handoff.contextManifest.length,
    omitted: Math.max(0, manifestEntries.length - handoff.contextManifest.length),
    truncated: handoff.contextManifest.length < manifestEntries.length,
    originalBytes: manifestOriginalBytes,
    retainedBytes: manifestBytes,
  };

  let snippetBytes = 0;
  const omitted: string[] = [];
  for (const snippet of input.snippets) {
    const entry = snippetEntry(snippet);
    const entryBytes = utf8Length(JSON.stringify(entry));
    if (snippetBytes + entryBytes > snippetBudgetBytes) {
      omitted.push(snippet.id);
      continue;
    }
    handoff.context.push(entry);
    if (measure() > totalBudgetBytes) {
      handoff.context.pop();
      omitted.push(snippet.id);
      continue;
    }
    snippetBytes += entryBytes;
  }

  for (const id of omitted) {
    handoff.omittedSnippetIds.push(id);
    if (measure() > totalBudgetBytes) {
      handoff.omittedSnippetIds.pop();
      break;
    }
  }

  if (measure() > totalBudgetBytes) {
    throw new Error(`Managed task handoff exceeds the ${String(totalBudgetBytes)} byte budget`);
  }
  return handoff;
}

export function renderManagedTaskHandoff(handoff: ManagedTaskHandoff): string {
  return JSON.stringify(handoff, null, 2);
}
