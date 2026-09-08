export type FieldRole = "structural" | "text";

export type BundleSpec =
  | { kind: "string"; role: FieldRole }
  | { kind: "boolean" }
  | { kind: "integer"; min: number }
  | { kind: "stringList"; role: FieldRole }
  | { kind: "object"; fields: Record<string, BundleField> }
  | { kind: "list"; of: BundleSpec };

export type BundleField = { spec: BundleSpec; required: boolean };

const structuralString: BundleSpec = { kind: "string", role: "structural" };
const freeText: BundleSpec = { kind: "string", role: "text" };
const structuralList: BundleSpec = { kind: "stringList", role: "structural" };
const textList: BundleSpec = { kind: "stringList", role: "text" };
const flag: BundleSpec = { kind: "boolean" };
const positive: BundleSpec = { kind: "integer", min: 1 };
const counter: BundleSpec = { kind: "integer", min: 0 };

const required = (spec: BundleSpec): BundleField => ({ spec, required: true });
const optional = (spec: BundleSpec): BundleField => ({ spec, required: false });

const object = (fields: Record<string, BundleField>): BundleSpec =>
  ({ kind: "object", fields });
const list = (of: BundleSpec): BundleSpec => ({ kind: "list", of });

const HUMAN_RESOLUTION = object({
  action: required(structuralString),
  resolvedBy: required(freeText),
  resolvedAt: required(structuralString),
  reason: optional(freeText),
  supersededById: optional(structuralString),
  materialEvidenceDelta: optional(textList),
});

const RULING_PROVENANCE = object({
  kind: required(structuralString),
  participants: required(list(object({
    agentId: required(structuralString),
    provider: optional(freeText),
    adapter: optional(freeText),
    model: optional(freeText),
  }))),
  ruledBy: optional(structuralString),
  resolvedBy: optional(freeText),
});

const RECORD_PROVENANCE = object({
  authoredBy: required(structuralString),
  participantIds: required(structuralList),
  runRef: optional(structuralString),
  cycleId: optional(structuralString),
  stepId: optional(structuralString),
  rulingProvenance: optional(RULING_PROVENANCE),
});

const LOCATION = object({
  file: required(freeText),
  startLine: optional(positive),
  endLine: optional(positive),
});

const CYCLE_BASELINE = object({
  commit: required(structuralString),
  branch: optional(freeText),
  dirty: required(flag),
  worktreeDigest: required(structuralString),
  contentComplete: optional(flag),
  capturedAt: required(structuralString),
});

const CYCLE = object({
  schemaVersion: required(positive),
  id: required(structuralString),
  sequence: required(positive),
  initiativeId: required(structuralString),
  type: required(structuralString),
  customType: optional(freeText),
  repositoryBaseline: optional(CYCLE_BASELINE),
  baselineEpoch: optional(positive),
  verifications: optional(list(object({
    runRef: required(structuralString),
    baselineEpoch: optional(positive),
    checks: required(list(object({
      command: required(freeText),
      status: required(structuralString),
      stale: optional(flag),
    }))),
    expected: required(flag),
    recordedAt: required(structuralString),
    baseline: optional(CYCLE_BASELINE),
  }))),
  runRefs: required(structuralList),
  inputArtifactIds: required(structuralList),
  outputArtifactIds: required(structuralList),
  acceptedStateDelta: required(object({
    acceptedArtifactIds: required(structuralList),
    rejectedArtifactIds: required(structuralList),
    acceptedDecisionIds: required(structuralList),
    newFindingIdentities: required(structuralList),
    resolvedFindingIdentities: required(structuralList),
    regressedFindingIdentities: required(structuralList),
    notObservedFindingIdentities: required(structuralList),
  })),
  completion: required(structuralString),
  nextCycleTrigger: optional(freeText),
  createdAt: required(structuralString),
  updatedAt: required(structuralString),
});

const ARTIFACT = object({
  schemaVersion: required(positive),
  id: required(structuralString),
  initiativeId: required(structuralString),
  cycleId: required(structuralString),
  type: required(structuralString),
  customType: optional(freeText),
  title: required(freeText),
  body: required(freeText),
  contentDigest: optional(structuralString),
  revision: required(positive),
  state: required(structuralString),
  provenance: required(RECORD_PROVENANCE),
  evidence: required(textList),
  supersedesId: optional(structuralString),
  supersededById: optional(structuralString),
  humanResolution: optional(HUMAN_RESOLUTION),
  resolutionHistory: required(list(HUMAN_RESOLUTION)),
  createdAt: required(structuralString),
  updatedAt: required(structuralString),
});


const EXTERNAL_EVIDENCE = object({
  schemaVersion: required(positive),
  id: required(structuralString),
  logicalId: required(structuralString),
  revision: required(positive),
  initiativeId: required(structuralString),
  cycleId: required(structuralString),
  source: required(object({
    uri: required(freeText),
    title: required(freeText),
    publisher: optional(freeText),
    publishedAt: optional(structuralString),
    retrievedAt: required(structuralString),
    contentDigest: required(structuralString),
  })),
  claim: required(freeText),
  relation: required(structuralString),
  target: required(object({
    kind: required(structuralString),
    artifactId: optional(structuralString),
    decisionId: optional(structuralString),
    identity: optional(structuralString),
  })),
  authority: required(structuralString),
  freshnessHorizonDays: optional(positive),
  state: required(structuralString),
  disposition: required(structuralString),
  challenges: required(list(object({
    cycleId: required(structuralString),
    participantIds: required(structuralList),
    text: required(freeText),
    recordedAt: required(structuralString),
  }))),
  provenance: required(RECORD_PROVENANCE),
  supersedesId: optional(structuralString),
  supersededById: optional(structuralString),
  humanResolution: optional(HUMAN_RESOLUTION),
  resolutionHistory: required(list(HUMAN_RESOLUTION)),
  createdAt: required(structuralString),
  updatedAt: required(structuralString),
});

const DECISION = object({
  schemaVersion: required(positive),
  id: required(structuralString),
  logicalId: required(structuralString),
  revision: required(positive),
  occurrences: required(positive),
  initiativeId: required(structuralString),
  cycleId: required(structuralString),
  subject: required(freeText),
  affectedScope: required(textList),
  question: required(freeText),
  options: required(list(object({
    id: required(structuralString),
    summary: required(freeText),
    tradeOffs: required(textList),
  }))),
  tradeOffs: required(textList),
  recommendation: optional(freeText),
  evidence: required(textList),
  state: required(structuralString),
  humanResolution: optional(HUMAN_RESOLUTION),
  provenance: required(RECORD_PROVENANCE),
  supersedesId: optional(structuralString),
  supersededById: optional(structuralString),
  reopenReason: optional(freeText),
  materialEvidenceDelta: required(textList),
  resolutionHistory: required(list(HUMAN_RESOLUTION)),
  createdAt: required(structuralString),
  updatedAt: required(structuralString),
});

const OBSERVATION = object({
  message: required(freeText),
  evidence: required(textList),
  challenges: required(textList),
  severity: optional(structuralString),
  location: optional(LOCATION),
});

const FINDING = object({
  schemaVersion: required(positive),
  identity: required(structuralString),
  initiativeId: required(structuralString),
  subject: required(freeText),
  message: required(freeText),
  messageHistory: required(textList),
  severity: optional(structuralString),
  location: optional(LOCATION),
  state: required(structuralString),
  notObservedCycleIds: required(structuralList),
  firstCycleId: required(structuralString),
  lastCycleId: required(structuralString),
  firstSeenAt: required(structuralString),
  lastSeenAt: required(structuralString),
  occurrences: required(positive),
  evidence: required(textList),
  challenges: required(textList),
  challengeHistory: required(list(object({
    cycleId: required(structuralString),
    participantIds: required(structuralList),
    text: required(freeText),
    recordedAt: required(structuralString),
  }))),
  materialDelta: required(textList),
  actionable: required(flag),
  fixState: optional(structuralString),
  humanResolution: optional(HUMAN_RESOLUTION),
  resolutionHistory: required(list(HUMAN_RESOLUTION)),
  latestObservation: optional(OBSERVATION),
});

const ROUND = object({
  schemaVersion: required(positive),
  initiativeId: required(structuralString),
  cycleId: required(structuralString),
  baselineEpoch: optional(positive),
  runRef: required(structuralString),
  executionRef: required(structuralString),
  freshReview: required(flag),
  recordedAt: required(structuralString),
  newMaterialCount: required(counter),
  regressionCount: required(counter),
  notObservedCount: required(counter),
  materialChangeCount: required(counter),
  identities: required(object({
    newIdentities: required(structuralList),
    repeatedIdentities: required(structuralList),
    resolvedIdentities: required(structuralList),
    regressedIdentities: required(structuralList),
    reopenedIdentities: required(structuralList),
    notObservedIdentities: required(structuralList),
  })),
  decisionChanges: required(list(object({
    decisionId: required(structuralString),
    subject: required(freeText),
    from: optional(structuralString),
    to: required(structuralString),
    reason: optional(freeText),
  }))),
  reconciliation: optional(object({
    merged: required(list(object({
      aliasIdentity: required(structuralString),
      canonicalIdentity: required(structuralString),
    }))),
    questions: required(list(object({
      freshIdentity: required(structuralString),
      subject: required(freeText),
      kind: required(structuralString),
      detail: required(freeText),
      candidates: required(list(object({
        identity: required(structuralString),
        subject: required(freeText),
        score: required(counter),
      }))),
    }))),
  })),
  validationErrors: required(textList),
});

export const INITIATIVE_BUNDLE_SPEC: BundleSpec = object({
  bundleVersion: required(positive),
  schemaVersion: required(positive),
  exportedAt: required(structuralString),
  initiative: required(object({
    schemaVersion: required(positive),
    id: required(structuralString),
    repositoryId: required(structuralString),
    repositoryRoot: optional(freeText),
    title: required(freeText),
    goal: required(freeText),
    desiredOutcome: required(freeText),
    scope: required(textList),
    constraints: required(textList),
    acceptanceCriteria: required(textList),
    currentDirection: optional(freeText),
    directionRevisions: optional(list(object({
      revision: required(positive),
      text: required(freeText),
      author: required(freeText),
      source: required(structuralString),
      recordedAt: required(structuralString),
      rationale: optional(freeText),
      supportingDecisionIds: optional(textList),
      evidence: optional(textList),
    }))),
    status: required(structuralString),
    createdAt: required(structuralString),
    updatedAt: required(structuralString),
    currentCycleId: optional(structuralString),
  })),
  cycles: required(list(CYCLE)),
  artifacts: required(list(ARTIFACT)),
  decisions: required(list(DECISION)),
  findings: required(list(FINDING)),
  rounds: required(list(ROUND)),
  findingAliases: required(list(object({
    initiativeId: required(structuralString),
    aliasIdentity: required(structuralString),
    canonicalIdentity: required(structuralString),
    reason: required(freeText),
    createdBy: required(freeText),
    createdAt: required(structuralString),
  }))),
  fixRuns: required(list(object({
    initiativeId: required(structuralString),
    identity: required(structuralString),
    runRef: required(structuralString),
    state: required(structuralString),
    imported: optional(flag),
    updatedAt: required(structuralString),
  }))),
  externalEvidence: optional(list(EXTERNAL_EVIDENCE)),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type BundleVisit = {
  onString?: (value: string, role: FieldRole, at: string) => string;
  onUnknownKey?: (at: string) => void;
  onTypeError?: (at: string, expected: string) => void;
  onMissing?: (at: string) => void;
};

export const walkBundle = (
  value: unknown,
  spec: BundleSpec,
  visit: BundleVisit,
  at = "$",
): unknown => {
  if (value === null) {
    visit.onTypeError?.(at, "a value rather than null");
    return value;
  }
  if (value === undefined) return value;
  if (spec.kind === "string") {
    if (typeof value !== "string") {
      visit.onTypeError?.(at, "a string");
      return value;
    }
    return visit.onString?.(value, spec.role, at) ?? value;
  }
  if (spec.kind === "boolean") {
    if (typeof value !== "boolean") visit.onTypeError?.(at, "a boolean");
    return value;
  }
  if (spec.kind === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min) {
      visit.onTypeError?.(
        at,
        spec.min > 0 ? "a positive whole number" : "a whole number that is not negative",
      );
    }
    return value;
  }
  if (spec.kind === "stringList") {
    if (!Array.isArray(value)) {
      visit.onTypeError?.(at, "a list of strings");
      return value;
    }
    return value.map((item, index) => {
      const itemAt = `${at}[${String(index)}]`;
      if (typeof item !== "string") {
        visit.onTypeError?.(itemAt, "a string");
        return item;
      }
      return visit.onString?.(item, spec.role, itemAt) ?? item;
    });
  }
  if (spec.kind === "list") {
    if (!Array.isArray(value)) {
      visit.onTypeError?.(at, "a list");
      return value;
    }
    return value.map(
      (item, index) => walkBundle(item, spec.of, visit, `${at}[${String(index)}]`),
    );
  }
  if (!isRecord(value)) {
    visit.onTypeError?.(at, "an object");
    return value;
  }
  Object.entries(spec.fields).forEach(([key, field]) => {
    if (!field.required) return;
    if (value[key] === undefined || value[key] === null) visit.onMissing?.(`${at}.${key}`);
  });
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const field = spec.fields[key];
    if (field === undefined) {
      visit.onUnknownKey?.(`${at}.${key}`);
      return [key, item];
    }
    return [key, walkBundle(item, field.spec, visit, `${at}.${key}`)];
  }));
};
