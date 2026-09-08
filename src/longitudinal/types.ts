import type { ModelFindingLocation, ModelFindingSeverity } from "../results/modelFindings";
import type { VerificationResult } from "../results/projectResult";
import type { RulingProvenance } from "../results/rulingProvenance";

export const LONGITUDINAL_SCHEMA_VERSION = 1;

export type LifecycleState =
  | "proposed"
  | "accepted"
  | "rejected"
  | "deferred"
  | "superseded";

export type HumanResolutionAction =
  | "accept"
  | "reject"
  | "defer"
  | "supersede"
  | "reopen";

export type HumanResolution = {
  action: HumanResolutionAction;
  resolvedBy: string;
  resolvedAt: string;
  reason?: string;
  supersededById?: string;
  materialEvidenceDelta?: string[];
};

export type AuthoredBy = "model" | "human" | "controller";

export type RecordProvenance = {
  authoredBy: AuthoredBy;
  participantIds: string[];
  runRef?: string;
  cycleId?: string;
  stepId?: string;
  rulingProvenance?: RulingProvenance;
};

export type InitiativeStatus = "active" | "paused" | "completed" | "abandoned";

export type Initiative = {
  schemaVersion: number;
  id: string;
  repositoryId: string;
  repositoryRoot?: string;
  title: string;
  goal: string;
  desiredOutcome: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  currentDirection?: string;
  // Append-only. currentDirection stays the latest revision's text so every reader that
  // predates this record keeps working; the history is what makes a change inspectable.
  directionRevisions?: DirectionRevision[];
  status: InitiativeStatus;
  createdAt: string;
  updatedAt: string;
  currentCycleId?: string;
};

export type DirectionRevision = {
  revision: number;
  text: string;
  author: string;
  source: "human";
  recordedAt: string;
  rationale?: string;
  supportingDecisionIds?: string[];
  evidence?: string[];
};

export type CycleType =
  | "framing"
  | "research"
  | "planning"
  | "execution"
  | "validation"
  | "review"
  | "debugging"
  | "custom";

export type CycleCompletion = "open" | "completed" | "abandoned";

export type AcceptedStateDelta = {
  acceptedArtifactIds: string[];
  rejectedArtifactIds: string[];
  acceptedDecisionIds: string[];
  newFindingIdentities: string[];
  resolvedFindingIdentities: string[];
  regressedFindingIdentities: string[];
  notObservedFindingIdentities: string[];
};

export const EMPTY_ACCEPTED_STATE_DELTA: AcceptedStateDelta = {
  acceptedArtifactIds: [],
  rejectedArtifactIds: [],
  acceptedDecisionIds: [],
  newFindingIdentities: [],
  resolvedFindingIdentities: [],
  regressedFindingIdentities: [],
  notObservedFindingIdentities: [],
};

export type RoundDecisionChange = {
  decisionId: string;
  subject: string;
  from?: LifecycleState;
  to: LifecycleState;
  reason?: string;
};

export type RoundIdentities = {
  newIdentities: string[];
  repeatedIdentities: string[];
  resolvedIdentities: string[];
  regressedIdentities: string[];
  reopenedIdentities: string[];
  notObservedIdentities: string[];
};

export const EMPTY_ROUND_IDENTITIES: RoundIdentities = {
  newIdentities: [],
  repeatedIdentities: [],
  resolvedIdentities: [],
  regressedIdentities: [],
  reopenedIdentities: [],
  notObservedIdentities: [],
};

export type ReconciliationQuestionKind = "ambiguous" | "split" | "conflict";

export type FindingReconciliationQuestion = {
  freshIdentity: string;
  subject: string;
  kind: ReconciliationQuestionKind;
  detail: string;
  candidates: Array<{ identity: string; subject: string; score: number }>;
};

export type RoundReconciliation = {
  merged: Array<{ aliasIdentity: string; canonicalIdentity: string }>;
  questions: FindingReconciliationQuestion[];
};

export const EMPTY_ROUND_RECONCILIATION: RoundReconciliation = {
  merged: [],
  questions: [],
};

export type LongitudinalRound = {
  schemaVersion: number;
  initiativeId: string;
  cycleId: string;
  baselineEpoch?: number;
  runRef: string;
  executionRef: string;
  freshReview: boolean;
  recordedAt: string;
  newMaterialCount: number;
  regressionCount: number;
  notObservedCount: number;
  materialChangeCount: number;
  identities: RoundIdentities;
  decisionChanges: RoundDecisionChange[];
  reconciliation?: RoundReconciliation;
  validationErrors: string[];
};

export type RunCycleBinding = {
  runRef: string;
  initiativeId: string;
  cycleId: string;
  baselineEpoch: number;
  freshReview: boolean;
  boundAt: string;
};

export type CycleBaseline = {
  commit: string;
  branch?: string;
  dirty: boolean;
  worktreeDigest: string;
  contentComplete?: boolean;
  capturedAt: string;
};

export type CycleVerification = {
  runRef: string;
  baselineEpoch: number;
  checks: VerificationResult[];
  expected: boolean;
  recordedAt: string;
  baseline?: CycleBaseline;
};

export type Cycle = {
  schemaVersion: number;
  id: string;
  sequence: number;
  initiativeId: string;
  type: CycleType;
  customType?: string;
  repositoryBaseline?: CycleBaseline;
  baselineEpoch?: number;
  verifications?: CycleVerification[];
  runRefs: string[];
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  acceptedStateDelta: AcceptedStateDelta;
  completion: CycleCompletion;
  nextCycleTrigger?: string;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactType =
  | "hypothesis"
  | "requirement"
  | "recommendation"
  | "decision"
  | "plan"
  | "design"
  | "protocol"
  | "patch"
  | "findingSet"
  | "custom";

export type InitiativeArtifact = {
  schemaVersion: number;
  id: string;
  initiativeId: string;
  cycleId: string;
  type: ArtifactType;
  customType?: string;
  title: string;
  body: string;
  contentDigest?: string;
  revision: number;
  state: LifecycleState;
  provenance: RecordProvenance;
  evidence: string[];
  supersedesId?: string;
  supersededById?: string;
  humanResolution?: HumanResolution | undefined;
  resolutionHistory: HumanResolution[];
  createdAt: string;
  updatedAt: string;
};

export type DecisionOption = {
  id: string;
  summary: string;
  tradeOffs: string[];
};

export type DecisionRecord = {
  schemaVersion: number;
  id: string;
  logicalId: string;
  revision: number;
  occurrences: number;
  initiativeId: string;
  cycleId: string;
  subject: string;
  affectedScope: string[];
  question: string;
  options: DecisionOption[];
  tradeOffs: string[];
  recommendation?: string;
  evidence: string[];
  state: LifecycleState;
  humanResolution?: HumanResolution | undefined;
  provenance: RecordProvenance;
  supersedesId?: string;
  supersededById?: string;
  reopenReason?: string;
  materialEvidenceDelta: string[];
  resolutionHistory: HumanResolution[];
  createdAt: string;
  updatedAt: string;
};


// External evidence is what the repository cannot settle: a standard, a vendor answer, a
// measurement taken elsewhere. It is neither an artifact nor a decision. An artifact is
// something this work produced; a decision is a judgment this work leaves to a human. External
// evidence is a claim someone outside this repository makes, which Bachata records, challenges,
// ages, supersedes and lets a human rule on — with its own identity, so it never borrows an
// artifact's or a decision's lifecycle.
export type ExternalEvidenceRelation = "supports" | "contradicts" | "qualifies";

export type ExternalEvidenceAuthority =
  | "standard"
  | "vendorDocumentation"
  | "firstPartyMeasurement"
  | "thirdPartyReport"
  | "community"
  | "unattributed";

export type ExternalEvidenceClaimTarget =
  | { kind: "artifact"; artifactId: string }
  | { kind: "decision"; decisionId: string }
  | { kind: "finding"; identity: string }
  | { kind: "initiative" };

export type ExternalEvidenceSource = {
  uri: string;
  title: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  contentDigest: string;
};

export type ExternalEvidenceChallenge = {
  cycleId: string;
  participantIds: string[];
  text: string;
  recordedAt: string;
};

export type ExternalEvidenceRecord = {
  schemaVersion: number;
  id: string;
  logicalId: string;
  revision: number;
  initiativeId: string;
  cycleId: string;
  source: ExternalEvidenceSource;
  claim: string;
  relation: ExternalEvidenceRelation;
  target: ExternalEvidenceClaimTarget;
  authority: ExternalEvidenceAuthority;
  // How long the claim is treated as current. A record past its freshness horizon is stale,
  // never silently discarded: staleness is stated so a human can refresh or supersede it.
  freshnessHorizonDays?: number;
  state: LifecycleState;
  disposition: ExternalEvidenceRelation | "unresolved";
  challenges: ExternalEvidenceChallenge[];
  provenance: RecordProvenance;
  supersedesId?: string;
  supersededById?: string;
  humanResolution?: HumanResolution | undefined;
  resolutionHistory: HumanResolution[];
  createdAt: string;
  updatedAt: string;
};

export type FindingLifecycleState =
  | "new"
  | "repeated"
  | "accepted"
  | "rejected"
  | "unresolved"
  | "resolved"
  | "regressed"
  | "reopened";

export type FindingFixState =
  | "awaitingFix"
  | "fixRunning"
  | "fixApplied"
  | "verified";

export type FindingFixRun = {
  initiativeId: string;
  identity: string;
  runRef: string;
  state: FindingFixState;
  imported?: boolean;
  updatedAt: string;
};

export type FindingChallenge = {
  cycleId: string;
  participantIds: string[];
  text: string;
  recordedAt: string;
};

export type FindingObservation = {
  message: string;
  evidence: string[];
  challenges: string[];
  severity?: ModelFindingSeverity;
  location?: ModelFindingLocation;
};

export type FindingHistoryEntry = {
  schemaVersion: number;
  identity: string;
  initiativeId: string;
  subject: string;
  message: string;
  messageHistory: string[];
  severity?: ModelFindingSeverity;
  location?: ModelFindingLocation;
  state: FindingLifecycleState;
  notObservedCycleIds: string[];
  firstCycleId: string;
  lastCycleId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrences: number;
  evidence: string[];
  challenges: string[];
  challengeHistory: FindingChallenge[];
  materialDelta: string[];
  actionable: boolean;
  fixState?: FindingFixState | undefined;
  humanResolution?: HumanResolution | undefined;
  resolutionHistory: HumanResolution[];
  latestObservation?: FindingObservation;
};

export type FindingAlias = {
  initiativeId: string;
  aliasIdentity: string;
  canonicalIdentity: string;
  reason: string;
  createdBy: string;
  createdAt: string;
};

export type LongitudinalSnapshot = {
  initiative?: Initiative;
  cycles: Cycle[];
  artifacts: InitiativeArtifact[];
  decisions: DecisionRecord[];
  findings: FindingHistoryEntry[];
  findingAliases: FindingAlias[];
  fixRuns: FindingFixRun[];
};

export const EMPTY_LONGITUDINAL_SNAPSHOT: LongitudinalSnapshot = {
  cycles: [],
  artifacts: [],
  decisions: [],
  findings: [],
  findingAliases: [],
  fixRuns: [],
};
