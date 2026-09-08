import { RulingProvenance } from "../results/rulingProvenance";
import {
  AgentCapabilities,
  CodexApprovalPolicy,
  JsonValue,
  WorkspaceWriteScope,
} from "../adapters/types";

export type AgentDefinition = {
  id: string;
  name: string;
  adapter: string;
  resourceId?: string;
  capabilities?: string[];
  command?: string;
  model?: string;
  workingDirectory?: string;
  permissionMode?: string;
  approvalPolicy?: CodexApprovalPolicy;
};

export type JsonOutputSchema = {
  type?: "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";
  enum?: JsonValue[];
  properties?: Record<string, JsonOutputSchema>;
  required?: string[];
  items?: JsonOutputSchema;
  additionalProperties?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type StepOutputConfig = {
  name: string;
  format: "json";
  schema?: JsonOutputSchema;
  shape?: string;
};

export type ConsensusConfig = {
  mode: "unanimous" | "arbiter";
  maxRounds: number;
  candidateField?: string;
  acceptedField?: string;
  objectionsField?: string;
  risksField?: string;
  acceptedValue?: boolean;
  arbiter?: string;
  onMaxRounds?: "humanGate" | "fail" | "requestArbiterRuling";
  resultFormat?: "json";
  resultField?: string;
  candidateShape?: string;
};

export type RoleAssignment = {
  agentId: string;
  role: string;
};

export type ManagedVerificationCheck = {
  id: string;
  command: string;
};

export type ManagedPipelinePolicy = {
  writeScope?: WorkspaceWriteScope;
  readPaths?: string[];
  allowedPaths?: string[];
  protectedPaths?: string[];
  commitMode?: "never" | "allow";
  verificationChecks?: ManagedVerificationCheck[];
  maxRevisionCycles?: number;
};

export type RoleDefinition = {
  id: string;
  name: string;
  instructions: string;
  // A role may name the model it should run on, so a cheaper Worker can pair with a
  // stronger Lead without editing either agent. Unset means the agent's own model, and
  // unset there means the provider's default.
  model?: string;
  requiredCapabilities?: AgentCapabilityName[];
  preferredAdapters?: string[];
  candidateAgentIds?: string[];
  resourceId?: string;
  readOnly?: boolean;
  managed?: boolean;
  managedRole?: "worker" | "lead";
  managedOptional?: boolean;
  writeScope?: WorkspaceWriteScope;
  readPaths?: string[];
  allowedPaths?: string[];
  protectedPaths?: string[];
  commitMode?: "never" | "allow";
  verificationChecks?: ManagedVerificationCheck[];
};

// A workflow can declare the exact external resources it needs. Provider-native resources a
// model happens to inherit still work, but only a declared dependency is reproducible: it is
// named, checked before the run, bound to roles, and recorded in the run's provenance.
export type ResourceDependencyKind = "mcpServer" | "skill" | "tool" | "adapterResource";

export type ResourceDependency = {
  id: string;
  kind: ResourceDependencyKind;
  name: string;
  version?: string;
  configurationDigest?: string;
  required: boolean;
  allowedRoles?: string[];
  requiredCapabilities?: AgentCapabilityName[];
};

// Whether a workflow's result belongs to a durable initiative. Declared, never inferred from
// a command name: the same review pipeline is a journey step in one place and a fixture in
// another, and only the definition can say which.
export type LongitudinalIntent = "initiativeRequired" | "runLocal";

export type PipelineAttachmentMode = "none" | "selected";
export type AgentCapabilityName = keyof AgentCapabilities;
export type HumanGateMode = "none" | "before" | "after" | "both";

// A step promotes its structured output into durable initiative state only when it says
// so. Without this declaration the output stays run-local, which is what every preset that
// does not name an artifact still gets.
export type ArtifactPromotion = {
  // Required when the step has more than one participant: two agents each produce a valid
  // answer, and which one becomes durable state is a product decision, not a race.
  producedBy?: string;
  type:
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
  customType?: string;
  titleField?: string;
  bodyField?: string;
  evidenceField?: string;
};

export type PipelineStepBase = {
  id: string;
  name: string;
  enabled: boolean;
  humanGate: HumanGateMode;
};

export type AgentTurnStep = PipelineStepBase & {
  type: "agent";
  participants: string[];
  promptTemplate: string;
  parallel: boolean;
  consensus: boolean;
  consensusConfig?: ConsensusConfig;
  output?: StepOutputConfig;
  permissionModes?: Record<string, string>;
  approvalPolicies?: Record<string, CodexApprovalPolicy>;
  attachments?: PipelineAttachmentMode;
  requiredCapabilities?: AgentCapabilityName[];
  artifactPromotion?: ArtifactPromotion;
  // Declares that this step's structured output carries core-decision candidates. Only a
  // step that says so contributes decisions; an ordinary consensus ruling stays run
  // evidence, because agreeing on an answer is not the same as recording a human judgment.
  coreDecisionOutput?: CoreDecisionOutput;
};

export type CoreDecisionOutput = {
  field?: string;
  producedBy?: string;
};

export type RoleAssignmentStep = PipelineStepBase & {
  type: "assignRoles";
  roleAssignments: RoleAssignment[];
};

export type ChecklistStep = PipelineStepBase & {
  type: "checklist";
  participants: string[];
  promptTemplate: string;
  outputName: string;
  timeoutMs?: number;
  permissionModes?: Record<string, string>;
  approvalPolicies?: Record<string, CodexApprovalPolicy>;
  attachments?: PipelineAttachmentMode;
  requiredCapabilities?: AgentCapabilityName[];
};

export type ExecuteChecklistStep = PipelineStepBase & {
  type: "executeChecklist";
  inputName: string;
  pipelineId: string;
  allowedPaths: string[];
  checks: string[];
  checkResources?: string[];
  allowNoChecks?: boolean;
  retries?: number;
  maxConcurrency?: number;
};

export type PipelineStep =
  | AgentTurnStep
  | RoleAssignmentStep
  | ChecklistStep
  | ExecuteChecklistStep;

export type PipelineDefinition = {
  version: 1;
  id: string;
  name: string;
  description?: string;
  managedPolicy?: ManagedPipelinePolicy;
  agents: AgentDefinition[];
  roles?: RoleDefinition[];
  steps: PipelineStep[];
  // Absent means runLocal: a legacy or custom pipeline with no durable output keeps working
  // and records nothing.
  longitudinalIntent?: LongitudinalIntent;
  resourceDependencies?: ResourceDependency[];
};

export type StepOutputArtifact = {
  stepId: string;
  agentId: string;
  // The participant the step declared, which may be a role such as "lead". The agent above
  // is who actually answered; this is what the pipeline asked for, and the two are not the
  // same once a role is resolved.
  participant?: string;
  name: string;
  value: JsonValue;
  hash: string;
  validationErrors: string[];
};

export type DecisionParticipantRecord = {
  agentId: string;
  valid: boolean;
  accepted: boolean;
  candidate: JsonValue;
  candidateHash: string;
  objections: string[];
  unresolvedRisks: string[];
  validationErrors: string[];
};

export type DecisionArtifact = {
  stepId: string;
  round: number;
  policy: "unanimous" | "arbiter";
  status: "pending" | "accepted" | "ruled" | "failed";
  candidateId?: string;
  candidateHash?: string;
  candidate?: JsonValue;
  participants: DecisionParticipantRecord[];
  objections: Array<{ agentId: string; text: string; accepted: boolean }>;
  unresolvedRisks: string[];
  ruledBy?: string;
  rulingProvenance?: RulingProvenance;
};

export type ExecutionChecklistIssue = {
  id: string;
  title: string;
  details: string;
  dependencies: string[];
  paths: string[];
};

export type ExecutionChecklistValue = {
  issues: ExecutionChecklistIssue[];
  selectedIssueIds: string[];
  userNote: string;
};
