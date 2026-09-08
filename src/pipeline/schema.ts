import { MAXIMUM_TIMEOUT_MS } from "../state/timeoutBounds";
import {
  AgentCapabilities,
  CodexApprovalPolicy,
} from "../adapters/types";
import { CANDIDATE_SHAPE_NAMES, isCandidateShapeName } from "./candidateShapes";
import { extractTemplateKeys } from "./template";
import { PipelineDefinition } from "./types";
import { isDeclarableVerificationCommand } from "../orchestrator/verificationPolicy";

export type ValidationResult =
  | { success: true; data: PipelineDefinition }
  | { success: false; errors: string[] };

const ROOT_KEYS = new Set([
  "version",
  "id",
  "name",
  "description",
  "managedPolicy",
  "agents",
  "roles",
  "steps",
  "resourceDependencies",
  "longitudinalIntent",
]);
const AGENT_KEYS = new Set([
  "id",
  "name",
  "adapter",
  "command",
  "model",
  "workingDirectory",
  "permissionMode",
  "approvalPolicy",
  "resourceId",
]);
const STEP_BASE_KEYS = ["type", "id", "name", "enabled", "humanGate"];
const RESOURCE_DEPENDENCY_KINDS = new Set(["mcpServer", "skill", "tool", "adapterResource"]);
const RESOURCE_DEPENDENCY_KEYS = new Set([
  "id", "kind", "name", "version", "configurationDigest",
  "required", "allowedRoles", "requiredCapabilities",
]);

// A declared dependency is the reproducible half of the contract, so it is validated as
// strictly as the rest of it. An inherited provider resource is still allowed; it is simply
// not declared, and Bachata never reports it as reproducible.
const validateResourceDependencies = (
  value: unknown,
  path: string,
  knownRoleIds: ReadonlySet<string>,
  errors: string[],
): void => {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${String(index)}]`;
    if (!isRecord(entry)) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    Object.keys(entry).forEach((key) => {
      if (!RESOURCE_DEPENDENCY_KEYS.has(key)) errors.push(`${entryPath}.${key} is not a known key`);
    });
    if (!isNonEmptyString(entry.id) || !IDENTIFIER_PATTERN.test(entry.id)) {
      errors.push(`${entryPath}.id must be an identifier`);
    } else if (seen.has(entry.id)) {
      errors.push(`${entryPath}.id duplicates dependency ${entry.id}`);
    } else {
      seen.add(entry.id);
    }
    if (!isNonEmptyString(entry.kind) || !RESOURCE_DEPENDENCY_KINDS.has(entry.kind)) {
      errors.push(`${entryPath}.kind must be one of ${[...RESOURCE_DEPENDENCY_KINDS].sort().join(", ")}`);
    }
    if (!isNonEmptyString(entry.name)) errors.push(`${entryPath}.name is required`);
    if (typeof entry.required !== "boolean") errors.push(`${entryPath}.required must be a boolean`);
    (["version", "configurationDigest"] as const).forEach((field) => {
      if (entry[field] !== undefined && !isNonEmptyString(entry[field])) {
        errors.push(`${entryPath}.${field} must be a non-empty string when present`);
      }
    });
    if (entry.allowedRoles !== undefined) {
      if (!Array.isArray(entry.allowedRoles) || entry.allowedRoles.length === 0) {
        errors.push(`${entryPath}.allowedRoles must be a non-empty array when present`);
      } else {
        entry.allowedRoles.forEach((role) => {
          if (!isNonEmptyString(role) || !knownRoleIds.has(role)) {
            errors.push(`${entryPath}.allowedRoles names ${String(role)}, which is not an agent or role in this pipeline`);
          }
        });
      }
    }
    if (entry.requiredCapabilities !== undefined) {
      if (
        !Array.isArray(entry.requiredCapabilities) ||
        !entry.requiredCapabilities.every((name) =>
          isNonEmptyString(name) && CAPABILITIES.has(name as keyof AgentCapabilities))
      ) {
        errors.push(`${entryPath}.requiredCapabilities contains an unknown capability`);
      }
    }
  });
};

const CORE_DECISION_OUTPUT_KEYS = new Set(["field", "producedBy"]);

// A step promoting core decisions must have a structured output to read them from, and on a
// paired step must say which participant's judgment is recorded.
const validateCoreDecisionOutput = (
  value: unknown,
  path: string,
  participants: readonly string[],
  output: unknown,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  Object.keys(value).forEach((key) => {
    if (!CORE_DECISION_OUTPUT_KEYS.has(key)) errors.push(`${path}.${key} is not a known key`);
  });
  if (!isRecord(output) || !isNonEmptyString(output.name)) {
    errors.push(`${path} requires this step to declare a structured output to read decisions from`);
  }
  if (value.field !== undefined &&
    (!isNonEmptyString(value.field) || !IDENTIFIER_PATTERN.test(value.field))) {
    errors.push(`${path}.field must be an identifier naming a field of the step output`);
  }
  if (value.producedBy === undefined) {
    if (participants.length > 1) {
      errors.push(
        `${path}.producedBy is required because this step has ${String(participants.length)} participants`,
      );
    }
  } else if (!isNonEmptyString(value.producedBy) || !participants.includes(value.producedBy)) {
    errors.push(`${path}.producedBy must name one of this step's participants`);
  }
};

const ARTIFACT_PROMOTION_TYPES = new Set([
  "hypothesis", "requirement", "recommendation", "decision", "plan",
  "design", "protocol", "patch", "findingSet", "custom",
]);

const ARTIFACT_PROMOTION_KEYS = new Set([
  "type", "customType", "titleField", "bodyField", "evidenceField", "producedBy",
]);

// Promotion writes durable initiative state, so an unknown or half-declared contract is
// refused here rather than producing an artifact nobody declared.
const validateArtifactPromotion = (
  value: unknown,
  path: string,
  participants: readonly string[],
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  Object.keys(value).forEach((key) => {
    if (!ARTIFACT_PROMOTION_KEYS.has(key)) errors.push(`${path}.${key} is not a known key`);
  });
  if (!isNonEmptyString(value.type) || !ARTIFACT_PROMOTION_TYPES.has(value.type)) {
    errors.push(`${path}.type must be one of ${[...ARTIFACT_PROMOTION_TYPES].sort().join(", ")}`);
    return;
  }
  // One durable representation per kind of record. A core decision is a DecisionRecord with
  // its own identity, revisions, supersession and human resolution; promoting it a second
  // time as a generic artifact would give the same judgment two lifecycles.
  if (value.type === "decision") {
    errors.push(
      `${path}.type cannot be decision: a core decision is recorded as a DecisionRecord from a declared decision output, not as a generic artifact`,
    );
  }
  if (value.type === "custom") {
    if (!isNonEmptyString(value.customType) || !IDENTIFIER_PATTERN.test(value.customType)) {
      errors.push(`${path}.customType is required for a custom artifact and must be an identifier`);
    }
  } else if (value.customType !== undefined) {
    errors.push(`${path}.customType is only allowed when type is custom`);
  }
  // Ambiguity is refused rather than resolved by whichever answer was stored last.
  if (value.producedBy === undefined) {
    if (participants.length > 1) {
      errors.push(
        `${path}.producedBy is required because this step has ${String(participants.length)} participants, and only one of them can produce the artifact`,
      );
    }
  } else if (!isNonEmptyString(value.producedBy) || !participants.includes(value.producedBy)) {
    errors.push(`${path}.producedBy must name one of this step's participants`);
  }
  (["titleField", "bodyField", "evidenceField"] as const).forEach((field) => {
    const candidate = value[field];
    if (candidate === undefined) return;
    if (!isNonEmptyString(candidate) || !IDENTIFIER_PATTERN.test(candidate)) {
      errors.push(`${path}.${field} must be an identifier naming a field of the step output`);
    }
  });
};

const AGENT_STEP_KEYS = new Set([
  ...STEP_BASE_KEYS,
  "participants",
  "promptTemplate",
  "parallel",
  "consensus",
  "consensusConfig",
  "permissionModes",
  "approvalPolicies",
  "attachments",
  "requiredCapabilities",
  "output",
  "artifactPromotion",
  "coreDecisionOutput",
]);
const ROLE_STEP_KEYS = new Set([...STEP_BASE_KEYS, "roleAssignments"]);
const CHECKLIST_STEP_KEYS = new Set([
  ...STEP_BASE_KEYS,
  "participants",
  "promptTemplate",
  "outputName",
  "timeoutMs",
  "permissionModes",
  "approvalPolicies",
  "attachments",
  "requiredCapabilities",
]);
const EXECUTE_CHECKLIST_STEP_KEYS = new Set([
  ...STEP_BASE_KEYS,
  "inputName",
  "pipelineId",
  "allowedPaths",
  "checks",
  "checkResources",
  "allowNoChecks",
  "retries",
  "maxConcurrency",
]);
const CONSENSUS_KEYS = new Set([
  "mode",
  "maxRounds",
  "candidateField",
  "acceptedField",
  "objectionsField",
  "risksField",
  "acceptedValue",
  "arbiter",
  "onMaxRounds",
  "resultFormat",
  "resultField",
  "candidateShape",
]);
const OUTPUT_KEYS = new Set(["name", "format", "schema", "shape"]);
const JSON_SCHEMA_KEYS = new Set([
  "type",
  "enum",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);
const JSON_SCHEMA_TYPES = new Set([
  "null",
  "boolean",
  "number",
  "integer",
  "string",
  "array",
  "object",
]);
const MAX_ROUND_POLICIES = new Set([
  "humanGate",
  "fail",
  "requestArbiterRuling",
]);
const ROLE_ASSIGNMENT_KEYS = new Set(["agentId", "role"]);
const MANAGED_POLICY_KEYS = new Set(["writeScope", "readPaths", "allowedPaths", "protectedPaths", "commitMode", "verificationChecks", "maxRevisionCycles"]);
const VERIFICATION_CHECK_KEYS = new Set(["id", "command"]);
const ROLE_DEFINITION_KEYS = new Set([
  "id",
  "name",
  "instructions",
  "model",
  "requiredCapabilities",
  "preferredAdapters",
  "candidateAgentIds",
  "resourceId",
  "readOnly",
  "managed",
  "managedRole",
  "managedOptional",
  "writeScope",
  "readPaths",
  "allowedPaths",
  "protectedPaths",
  "commitMode",
  "verificationChecks",
]);
const HUMAN_GATES = new Set(["none", "before", "after", "both"]);
const ATTACHMENT_MODES = new Set(["none", "selected"]);
const APPROVAL_POLICIES = new Set<CodexApprovalPolicy>([
  "onRequest",
  "unlessTrusted",
]);
const CAPABILITIES = new Set<keyof AgentCapabilities>([
  "streaming",
  "resume",
  "interrupt",
  "attachments",
  "repositoryTools",
  "browserSessionSelection",
  "passiveActionLoop",
]);

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_IDENTIFIERS = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

const TEMPLATE_KEYS = new Set([
  "userPrompt",
  "previousAnswer",
  "latestAgentAnswer",
  "previousStepAnswer",
  "previousStepAnswers",
  "peerAnswer",
  "peerAnswers",
  "peerAnswersTagged",
  "peerAnswersJson",
  "interventionAnswer",
  "interventionAnswers",
  "interventionAnswersTagged",
  "currentAgentId",
  "currentParticipant",
  "roleId",
  "roleName",
  "roleInstructions",
  "outputsJson",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateIdentifier = (
  value: unknown,
  valuePath: string,
  errors: string[],
): value is string => {
  if (!isNonEmptyString(value)) {
    errors.push(`${valuePath} is required`);
    return false;
  }
  if (!IDENTIFIER_PATTERN.test(value) || RESERVED_IDENTIFIERS.has(value)) {
    errors.push(
      `${valuePath} must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens`,
    );
    return false;
  }
  return true;
};

const validateKnownKeys = (
  value: Record<string, unknown>,
  allowed: Set<string>,
  valuePath: string,
  errors: string[],
): void => {
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) {
      errors.push(`${valuePath}.${key} is not supported`);
    }
  });
};

const validateVerificationChecks = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  const ids = new Set<string>();
  value.forEach((check, checkIndex) => {
    const checkPath = `${path}.${String(checkIndex)}`;
    if (!isRecord(check)) {
      errors.push(`${checkPath} must be an object`);
      return;
    }
    validateKnownKeys(check, VERIFICATION_CHECK_KEYS, checkPath, errors);
    if (!validateIdentifier(check.id, `${checkPath}.id`, errors)) {
      return;
    }
    if (ids.has(check.id)) {
      errors.push(`${path} must not contain duplicate ids`);
    }
    ids.add(check.id);
    if (!isNonEmptyString(check.command)) {
      errors.push(`${checkPath}.command is required`);
    }
  });
};

const validateManagedVerificationChecks = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  validateVerificationChecks(value, path, errors);
  if (!Array.isArray(value)) {
    return;
  }
  value.forEach((check, checkIndex) => {
    if (!isRecord(check) || !isNonEmptyString(check.command)) {
      return;
    }
    if (!isDeclarableVerificationCommand(check.command)) {
      errors.push(`${path}.${String(checkIndex)}.command must be bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id> declared in .bachata/verifiers.json. The first two execute unattended; a descriptor runs only under one recorded workspace approval during an explicit Improve run.`);
    }
  });
};

const validateOptionalString = (
  value: unknown,
  valuePath: string,
  errors: string[],
): void => {
  if (value !== undefined && typeof value !== "string") {
    errors.push(`${valuePath} must be a string`);
  }
};

const validateApprovalPolicy = (
  value: unknown,
  valuePath: string,
  errors: string[],
): void => {
  if (
    value !== undefined &&
    (typeof value !== "string" ||
      !APPROVAL_POLICIES.has(value as CodexApprovalPolicy))
  ) {
    errors.push(`${valuePath} must be onRequest or unlessTrusted`);
  }
};

const validateStringMap = (
  value: unknown,
  valuePath: string,
  validKeys: Set<string>,
  errors: string[],
): void => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object`);
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    if (!validKeys.has(key)) {
      errors.push(`${valuePath}.${key} does not reference a known agent or role`);
    }
    if (!isNonEmptyString(item)) {
      errors.push(`${valuePath}.${key} must be a non-empty string`);
    }
  });
};

const validateApprovalPolicyMap = (
  value: unknown,
  valuePath: string,
  validKeys: Set<string>,
  errors: string[],
): void => {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object`);
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    if (!validKeys.has(key)) {
      errors.push(`${valuePath}.${key} does not reference a known agent or role`);
    }
    validateApprovalPolicy(item, `${valuePath}.${key}`, errors);
  });
};

const validateJsonSchema = (
  value: unknown,
  valuePath: string,
  errors: string[],
  depth = 0,
): void => {
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object`);
    return;
  }
  if (depth > 8) {
    errors.push(`${valuePath} is nested too deeply`);
    return;
  }
  validateKnownKeys(value, JSON_SCHEMA_KEYS, valuePath, errors);
  if (
    value.type !== undefined &&
    (typeof value.type !== "string" || !JSON_SCHEMA_TYPES.has(value.type))
  ) {
    errors.push(`${valuePath}.type is invalid`);
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    errors.push(`${valuePath}.enum must be a non-empty array`);
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || !value.required.every(isNonEmptyString)) {
      errors.push(`${valuePath}.required must be a string array`);
    } else if (new Set(value.required).size !== value.required.length) {
      errors.push(`${valuePath}.required must not contain duplicates`);
    }
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      errors.push(`${valuePath}.properties must be an object`);
    } else {
      Object.entries(value.properties).forEach(([key, schema]) => {
        if (!key) {
          errors.push(`${valuePath}.properties contains an empty key`);
          return;
        }
        validateJsonSchema(schema, `${valuePath}.properties.${key}`, errors, depth + 1);
      });
    }
  }
  if (value.items !== undefined) {
    validateJsonSchema(value.items, `${valuePath}.items`, errors, depth + 1);
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    errors.push(`${valuePath}.additionalProperties must be boolean`);
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || Number(value[key]) < 0)) {
      errors.push(`${valuePath}.${key} must be a non-negative integer`);
    }
  }
  for (const key of ["minimum", "maximum"]) {
    if (value[key] !== undefined && typeof value[key] !== "number") {
      errors.push(`${valuePath}.${key} must be a number`);
    }
  }
};

const validateOutput = (
  value: unknown,
  valuePath: string,
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object`);
    return;
  }
  validateKnownKeys(value, OUTPUT_KEYS, valuePath, errors);
  validateIdentifier(value.name, `${valuePath}.name`, errors);
  if (value.format !== "json") {
    errors.push(`${valuePath}.format must be json`);
  }
  if (value.shape !== undefined && !isCandidateShapeName(value.shape)) {
    errors.push(
      `${valuePath}.shape must be one of ${CANDIDATE_SHAPE_NAMES.join(", ")}`,
    );
  }
  if (value.schema === undefined && value.shape === undefined) {
    errors.push(`${valuePath} must declare schema or shape`);
  } else if (value.schema !== undefined && value.shape !== undefined) {
    errors.push(`${valuePath} must declare only one of schema or shape`);
  } else if (value.schema !== undefined) {
    validateJsonSchema(value.schema, `${valuePath}.schema`, errors);
  }
};

const validateConsensusConfig = (
  value: unknown,
  valuePath: string,
  participants: string[],
  errors: string[],
): void => {
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object`);
    return;
  }

  validateKnownKeys(value, CONSENSUS_KEYS, valuePath, errors);

  if (value.mode !== "unanimous" && value.mode !== "arbiter") {
    errors.push(`${valuePath}.mode must be unanimous or arbiter`);
  }
  if (!Number.isInteger(value.maxRounds) || Number(value.maxRounds) <= 0) {
    errors.push(`${valuePath}.maxRounds must be a positive integer`);
  }
  for (const key of [
    "candidateField",
    "acceptedField",
    "objectionsField",
    "risksField",
    "resultField",
  ]) {
    if (value[key] !== undefined && !isNonEmptyString(value[key])) {
      errors.push(`${valuePath}.${key} must be a non-empty string`);
    }
  }
  if (value.resultFormat !== undefined && value.resultFormat !== "json") {
    errors.push(`${valuePath}.resultFormat must be json`);
  }
  if (value.acceptedValue !== undefined && typeof value.acceptedValue !== "boolean") {
    errors.push(`${valuePath}.acceptedValue must be boolean`);
  }
  if (value.candidateShape !== undefined && !isCandidateShapeName(value.candidateShape)) {
    errors.push(
      `${valuePath}.candidateShape must be one of ${CANDIDATE_SHAPE_NAMES.join(", ")}`,
    );
  }
  if (
    value.onMaxRounds !== undefined &&
    (typeof value.onMaxRounds !== "string" || !MAX_ROUND_POLICIES.has(value.onMaxRounds))
  ) {
    errors.push(`${valuePath}.onMaxRounds is invalid`);
  }
  if (value.mode === "arbiter") {
    if (!isNonEmptyString(value.arbiter) || !participants.includes(value.arbiter)) {
      errors.push(`${valuePath}.arbiter must name one step participant`);
    }
  } else if (value.arbiter !== undefined) {
    errors.push(`${valuePath}.arbiter is only valid in arbiter mode`);
  }
  if (value.onMaxRounds === "requestArbiterRuling" && value.mode !== "arbiter") {
    errors.push(`${valuePath}.onMaxRounds requestArbiterRuling requires arbiter mode`);
  }
};

const validateBaseStep = (
  step: Record<string, unknown>,
  stepPath: string,
  stepIds: string[],
  errors: string[],
): void => {
  if (validateIdentifier(step.id, `${stepPath}.id`, errors)) {
    stepIds.push(step.id);
  }
  if (!isNonEmptyString(step.name)) {
    errors.push(`${stepPath}.name is required`);
  }
  if (typeof step.enabled !== "boolean") {
    errors.push(`${stepPath}.enabled must be boolean`);
  }
  if (
    typeof step.humanGate !== "string" ||
    !HUMAN_GATES.has(step.humanGate)
  ) {
    errors.push(`${stepPath}.humanGate is invalid`);
  }
};

export const validatePipelineDefinition = (value: unknown): ValidationResult => {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { success: false, errors: ["Pipeline must be an object"] };
  }

  validateKnownKeys(value, ROOT_KEYS, "pipeline", errors);

  if (value.version !== 1) {
    errors.push("version must be 1");
  }
  validateIdentifier(value.id, "id", errors);
  if (!isNonEmptyString(value.name)) {
    errors.push("name is required");
  }
  validateOptionalString(value.description, "description", errors);

  if (value.managedPolicy !== undefined) {
    if (!isRecord(value.managedPolicy)) {
      errors.push("managedPolicy must be an object");
    } else {
      validateKnownKeys(value.managedPolicy, MANAGED_POLICY_KEYS, "managedPolicy", errors);
      if (value.managedPolicy.writeScope !== undefined
        && !["task", "configured", "workspace", "readOnly"].includes(String(value.managedPolicy.writeScope))) {
        errors.push("managedPolicy.writeScope must be task, configured, workspace, or readOnly");
      }
      if (value.managedPolicy.readPaths !== undefined) {
        if (!Array.isArray(value.managedPolicy.readPaths) || !value.managedPolicy.readPaths.every(isNonEmptyString)) {
          errors.push("managedPolicy.readPaths must be a string array");
        } else if (new Set(value.managedPolicy.readPaths).size !== value.managedPolicy.readPaths.length) {
          errors.push("managedPolicy.readPaths must not contain duplicates");
        }
      }
      if (value.managedPolicy.allowedPaths !== undefined) {
        if (!Array.isArray(value.managedPolicy.allowedPaths) || !value.managedPolicy.allowedPaths.every(isNonEmptyString)) {
          errors.push("managedPolicy.allowedPaths must be a string array");
        } else if (new Set(value.managedPolicy.allowedPaths).size !== value.managedPolicy.allowedPaths.length) {
          errors.push("managedPolicy.allowedPaths must not contain duplicates");
        }
      }
      if (value.managedPolicy.protectedPaths !== undefined) {
        if (!Array.isArray(value.managedPolicy.protectedPaths) || !value.managedPolicy.protectedPaths.every(isNonEmptyString)) {
          errors.push("managedPolicy.protectedPaths must be a string array");
        } else if (new Set(value.managedPolicy.protectedPaths).size !== value.managedPolicy.protectedPaths.length) {
          errors.push("managedPolicy.protectedPaths must not contain duplicates");
        }
      }
      if (value.managedPolicy.commitMode !== undefined && value.managedPolicy.commitMode !== "never") {
        errors.push("managedPolicy.commitMode must be never");
      }
      if (value.managedPolicy.verificationChecks !== undefined) {
        validateManagedVerificationChecks(value.managedPolicy.verificationChecks, "managedPolicy.verificationChecks", errors);
      }
      if (value.managedPolicy.maxRevisionCycles !== undefined
        && (!Number.isSafeInteger(value.managedPolicy.maxRevisionCycles)
          || Number(value.managedPolicy.maxRevisionCycles) < 0
          || Number(value.managedPolicy.maxRevisionCycles) > 2)) {
        errors.push("managedPolicy.maxRevisionCycles must be an integer from 0 to 2");
      }
    }
  }

  if (!Array.isArray(value.agents) || value.agents.length === 0) {
    errors.push("agents must be a non-empty array");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  }

  const agents = Array.isArray(value.agents) ? value.agents : [];
  const roleDefinitions = Array.isArray(value.roles) ? value.roles : [];
  const steps = Array.isArray(value.steps) ? value.steps : [];
  const agentIds: string[] = [];
  const roleIds: string[] = [];
  const stepIds: string[] = [];

  if (value.roles !== undefined && !Array.isArray(value.roles)) {
    errors.push("roles must be an array");
  }

  agents.forEach((agent, index) => {
    const agentPath = `agents.${String(index)}`;
    if (!isRecord(agent)) {
      errors.push(`${agentPath} must be an object`);
      return;
    }

    validateKnownKeys(agent, AGENT_KEYS, agentPath, errors);

    if (validateIdentifier(agent.id, `${agentPath}.id`, errors)) {
      agentIds.push(agent.id);
    }
    if (!isNonEmptyString(agent.name)) {
      errors.push(`${agentPath}.name is required`);
    }
    if (!isNonEmptyString(agent.adapter)) {
      errors.push(`${agentPath}.adapter is required`);
    }
    validateOptionalString(agent.command, `${agentPath}.command`, errors);
    validateOptionalString(agent.model, `${agentPath}.model`, errors);
    validateOptionalString(
      agent.workingDirectory,
      `${agentPath}.workingDirectory`,
      errors,
    );
    validateOptionalString(
      agent.permissionMode,
      `${agentPath}.permissionMode`,
      errors,
    );
    validateApprovalPolicy(
      agent.approvalPolicy,
      `${agentPath}.approvalPolicy`,
      errors,
    );
    validateOptionalString(agent.resourceId, `${agentPath}.resourceId`, errors);
  });

  if (new Set(agentIds).size !== agentIds.length) {
    errors.push("Agent ids must be unique");
  }

  const knownAgentIds = new Set(agentIds);
  roleDefinitions.forEach((role, index) => {
    const rolePath = `roles.${String(index)}`;
    if (!isRecord(role)) {
      errors.push(`${rolePath} must be an object`);
      return;
    }
    validateKnownKeys(role, ROLE_DEFINITION_KEYS, rolePath, errors);
    if (validateIdentifier(role.id, `${rolePath}.id`, errors)) {
      roleIds.push(role.id);
      if (knownAgentIds.has(role.id)) {
        errors.push(`${rolePath}.id must not shadow an agent id`);
      }
    }
    if (!isNonEmptyString(role.name)) {
      errors.push(`${rolePath}.name is required`);
    }
    if (!isNonEmptyString(role.instructions)) {
      errors.push(`${rolePath}.instructions is required`);
    }
    // Empty is not "unset": the runner prefers the role's model with ??, so an empty string
    // would silently replace the agent's model with nothing.
    if (role.model !== undefined && !isNonEmptyString(role.model)) {
      errors.push(`${rolePath}.model must be a non-empty string when present`);
    }
    if (role.requiredCapabilities !== undefined) {
      if (
        !Array.isArray(role.requiredCapabilities) ||
        !role.requiredCapabilities.every(
          (item) =>
            typeof item === "string" &&
            CAPABILITIES.has(item as keyof AgentCapabilities),
        )
      ) {
        errors.push(
          `${rolePath}.requiredCapabilities contains an unknown capability`,
        );
      } else if (
        new Set(role.requiredCapabilities).size !==
        role.requiredCapabilities.length
      ) {
        errors.push(
          `${rolePath}.requiredCapabilities must not contain duplicates`,
        );
      }
    }
    if (role.preferredAdapters !== undefined) {
      if (
        !Array.isArray(role.preferredAdapters) ||
        !role.preferredAdapters.every(isNonEmptyString)
      ) {
        errors.push(`${rolePath}.preferredAdapters must be a string array`);
      } else if (
        new Set(role.preferredAdapters).size !== role.preferredAdapters.length
      ) {
        errors.push(`${rolePath}.preferredAdapters must not contain duplicates`);
      }
    }
    if (role.candidateAgentIds !== undefined) {
      if (!Array.isArray(role.candidateAgentIds) || !role.candidateAgentIds.every(isNonEmptyString)) {
        errors.push(`${rolePath}.candidateAgentIds must be a string array`);
      } else {
        const unknown = role.candidateAgentIds.filter((agentId) => !knownAgentIds.has(agentId));
        if (unknown.length > 0) {
          errors.push(`${rolePath}.candidateAgentIds contains unknown agents: ${unknown.join(", ")}`);
        }
        if (new Set(role.candidateAgentIds).size !== role.candidateAgentIds.length) {
          errors.push(`${rolePath}.candidateAgentIds must not contain duplicates`);
        }
      }
    }
    validateOptionalString(role.resourceId, `${rolePath}.resourceId`, errors);
    if (role.readOnly !== undefined && typeof role.readOnly !== "boolean") {
      errors.push(`${rolePath}.readOnly must be boolean`);
    }
    if (role.managed !== undefined && typeof role.managed !== "boolean") {
      errors.push(`${rolePath}.managed must be boolean`);
    }
    if (role.managedRole !== undefined && role.managedRole !== "worker" && role.managedRole !== "lead") {
      errors.push(`${rolePath}.managedRole must be worker or lead`);
    }
    if (role.managed === true && role.managedRole === undefined) {
      errors.push(`${rolePath}.managedRole is required when managed is true`);
    }
    if (role.managedRole !== undefined && role.managed !== true) {
      errors.push(`${rolePath}.managedRole requires managed: true`);
    }
    if (role.managedOptional !== undefined && typeof role.managedOptional !== "boolean") {
      errors.push(`${rolePath}.managedOptional must be boolean`);
    }
    if (role.managedOptional === true && role.managed !== true) {
      errors.push(`${rolePath}.managedOptional requires managed: true`);
    }
    if (role.managedOptional === true && role.managedRole !== "lead") {
      errors.push(`${rolePath}.managedOptional is only valid for a managed Lead`);
    }
    if (role.managedRole === "lead" && role.readOnly !== true) {
      errors.push(`${rolePath}.managed Lead must set readOnly: true`);
    }
    if (role.readPaths !== undefined) {
      if (!Array.isArray(role.readPaths) || !role.readPaths.every(isNonEmptyString)) {
        errors.push(`${rolePath}.readPaths must be a string array`);
      } else if (new Set(role.readPaths).size !== role.readPaths.length) {
        errors.push(`${rolePath}.readPaths must not contain duplicates`);
      }
    }
    if (role.allowedPaths !== undefined) {
      if (!Array.isArray(role.allowedPaths) || !role.allowedPaths.every(isNonEmptyString)) {
        errors.push(`${rolePath}.allowedPaths must be a string array`);
      } else if (new Set(role.allowedPaths).size !== role.allowedPaths.length) {
        errors.push(`${rolePath}.allowedPaths must not contain duplicates`);
      }
    }
    if (role.protectedPaths !== undefined) {
      if (!Array.isArray(role.protectedPaths) || !role.protectedPaths.every(isNonEmptyString)) {
        errors.push(`${rolePath}.protectedPaths must be a string array`);
      } else if (new Set(role.protectedPaths).size !== role.protectedPaths.length) {
        errors.push(`${rolePath}.protectedPaths must not contain duplicates`);
      }
    }
    if (role.managed === true && role.commitMode !== undefined && role.commitMode !== "never") {
      errors.push(`${rolePath}.commitMode must be never for managed execution`);
    } else if (role.managed !== true && role.commitMode !== undefined && role.commitMode !== "never" && role.commitMode !== "allow") {
      errors.push(`${rolePath}.commitMode must be never or allow`);
    }
    if (role.verificationChecks !== undefined) {
      if (role.managed === true) {
        validateManagedVerificationChecks(role.verificationChecks, `${rolePath}.verificationChecks`, errors);
      } else {
        validateVerificationChecks(role.verificationChecks, `${rolePath}.verificationChecks`, errors);
      }
    }
  });

  if (new Set(roleIds).size !== roleIds.length) {
    errors.push("Role ids must be unique");
  }

  const declaredIntent = value.longitudinalIntent;
  if (declaredIntent !== undefined &&
    declaredIntent !== "initiativeRequired" && declaredIntent !== "runLocal") {
    errors.push('longitudinalIntent must be "initiativeRequired" or "runLocal"');
  }
  // A workflow that writes durable state must say so. Declaring run-local while promoting an
  // artifact or a core decision is a contradiction, not a preference.
  const promotesDurableState = steps.some((step) =>
    isRecord(step) && step.type === "agent" &&
    (step.artifactPromotion !== undefined || step.coreDecisionOutput !== undefined));
  if (promotesDurableState && declaredIntent !== "initiativeRequired") {
    errors.push(
      declaredIntent === "runLocal"
        ? "longitudinalIntent is runLocal, but a step declares artifactPromotion or coreDecisionOutput, which write durable initiative state"
        : "a step declares artifactPromotion or coreDecisionOutput, so longitudinalIntent must be initiativeRequired",
    );
  }

  if (value.resourceDependencies !== undefined) {
    validateResourceDependencies(
      value.resourceDependencies,
      "resourceDependencies",
      new Set([...agentIds, ...roleIds]),
      errors,
    );
  }

  const predefinedRoles = new Set(roleIds);
  const declaredRoles = new Set<string>(roleIds);
  const enabledRoles = new Set<string>();
  const enabledRoleTargets = new Map<string, string>();
  const declaredOutputs = new Set<string>();

  steps.forEach((step, index) => {
    const stepPath = `steps.${String(index)}`;
    if (!isRecord(step)) {
      errors.push(`${stepPath} must be an object`);
      return;
    }

    validateBaseStep(step, stepPath, stepIds, errors);

    if (step.type === "assignRoles") {
      validateKnownKeys(step, ROLE_STEP_KEYS, stepPath, errors);
      if (!Array.isArray(step.roleAssignments) || step.roleAssignments.length === 0) {
        errors.push(`${stepPath}.roleAssignments must be a non-empty array`);
        return;
      }
      const rolesAssignedHere = new Set<string>();
      step.roleAssignments.forEach((assignment, assignmentIndex) => {
        const assignmentPath = `${stepPath}.roleAssignments.${String(assignmentIndex)}`;
        if (!isRecord(assignment)) {
          errors.push(`${assignmentPath} must be an object`);
          return;
        }
        validateKnownKeys(
          assignment,
          ROLE_ASSIGNMENT_KEYS,
          assignmentPath,
          errors,
        );
        if (!isNonEmptyString(assignment.agentId)) {
          errors.push(`${assignmentPath}.agentId is required`);
        } else if (!knownAgentIds.has(assignment.agentId)) {
          errors.push(`${assignmentPath}.agentId is unknown`);
        }
        if (!validateIdentifier(assignment.role, `${assignmentPath}.role`, errors)) {
          return;
        }
        if (predefinedRoles.size > 0 && !predefinedRoles.has(assignment.role)) {
          errors.push(`${assignmentPath}.role is not declared in pipeline.roles`);
        }
        if (knownAgentIds.has(assignment.role)) {
          errors.push(`${assignmentPath}.role must not shadow an agent id`);
        }
        if (rolesAssignedHere.has(assignment.role)) {
          errors.push(`${stepPath} assigns role ${assignment.role} more than once`);
        }
        rolesAssignedHere.add(assignment.role);
      });
      rolesAssignedHere.forEach((role) => {
        declaredRoles.add(role);
        if (step.enabled === true) {
          enabledRoles.add(role);
        }
      });
      if (step.enabled === true) {
        step.roleAssignments.forEach((assignment) => {
          if (
            isRecord(assignment) &&
            isNonEmptyString(assignment.role) &&
            isNonEmptyString(assignment.agentId) &&
            knownAgentIds.has(assignment.agentId)
          ) {
            enabledRoleTargets.set(assignment.role, assignment.agentId);
          }
        });
      }
      return;
    }

    const checklist = step.type === "checklist";
    const executeChecklist = step.type === "executeChecklist";
    if (step.type !== "agent" && !checklist && !executeChecklist) {
      errors.push(`${stepPath}.type must be agent, checklist, executeChecklist, or assignRoles`);
      return;
    }

    if (executeChecklist) {
      validateKnownKeys(step, EXECUTE_CHECKLIST_STEP_KEYS, stepPath, errors);
      if (!isNonEmptyString(step.inputName)) {
        errors.push(`${stepPath}.inputName is required`);
      } else if (!IDENTIFIER_PATTERN.test(step.inputName) || RESERVED_IDENTIFIERS.has(step.inputName)) {
        errors.push(`${stepPath}.inputName is invalid`);
      } else if (!declaredOutputs.has(step.inputName)) {
        errors.push(`${stepPath}.inputName must reference an earlier output`);
      }
      if (!validateIdentifier(step.pipelineId, `${stepPath}.pipelineId`, errors)) {
        errors.push(`${stepPath}.pipelineId is required`);
      }
      if (!Array.isArray(step.allowedPaths) || step.allowedPaths.length === 0 || !step.allowedPaths.every(isNonEmptyString)) {
        errors.push(`${stepPath}.allowedPaths must be a non-empty string array`);
      } else if (new Set(step.allowedPaths).size !== step.allowedPaths.length) {
        errors.push(`${stepPath}.allowedPaths must not contain duplicates`);
      }
      if (!Array.isArray(step.checks) || !step.checks.every(isNonEmptyString)) {
        errors.push(`${stepPath}.checks must be a string array`);
      } else if (new Set(step.checks).size !== step.checks.length) {
        errors.push(`${stepPath}.checks must not contain duplicates`);
      } else if (step.checks.length === 0 && step.allowNoChecks !== true) {
        errors.push(`${stepPath}.checks must contain at least one command unless allowNoChecks is true`);
      }
      if (Array.isArray(step.checks)) {
        step.checks.forEach((command, commandIndex) => {
          if (isNonEmptyString(command) && !isDeclarableVerificationCommand(command)) {
            errors.push(`${stepPath}.checks.${String(commandIndex)} must be bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id>`);
          }
        });
      }
      if (step.checkResources !== undefined && (
        !Array.isArray(step.checkResources) ||
        !step.checkResources.every(isNonEmptyString) ||
        new Set(step.checkResources).size !== step.checkResources.length
      )) {
        errors.push(`${stepPath}.checkResources must be a unique string array`);
      }
      if (step.allowNoChecks !== undefined && typeof step.allowNoChecks !== "boolean") {
        errors.push(`${stepPath}.allowNoChecks must be boolean`);
      }
      if (
        step.retries !== undefined &&
        (!Number.isSafeInteger(step.retries) || Number(step.retries) < 0 || Number(step.retries) > 10)
      ) {
        errors.push(`${stepPath}.retries must be an integer from 0 to 10`);
      }
      if (
        step.maxConcurrency !== undefined &&
        (!Number.isSafeInteger(step.maxConcurrency) || Number(step.maxConcurrency) < 1 || Number(step.maxConcurrency) > 20)
      ) {
        errors.push(`${stepPath}.maxConcurrency must be an integer from 1 to 20`);
      }
      if (step.humanGate === "after" || step.humanGate === "both") {
        errors.push(`${stepPath}.humanGate cannot run after checklist execution`);
      }
      if (steps.slice(index + 1).some((value) => isRecord(value) && value.enabled === true)) {
        errors.push(`${stepPath} must be the final enabled pipeline step`);
      }
      return;
    }

    validateKnownKeys(
      step,
      checklist ? CHECKLIST_STEP_KEYS : AGENT_STEP_KEYS,
      stepPath,
      errors,
    );

    if (
      !Array.isArray(step.participants) ||
      !step.participants.every(isNonEmptyString)
    ) {
      errors.push(`${stepPath}.participants must be a string array`);
    }
    if (typeof step.promptTemplate !== "string") {
      errors.push(`${stepPath}.promptTemplate must be a string`);
    }
    if (!checklist && typeof step.parallel !== "boolean") {
      errors.push(`${stepPath}.parallel must be boolean`);
    }
    if (!checklist && typeof step.consensus !== "boolean") {
      errors.push(`${stepPath}.consensus must be boolean`);
    }
    if (checklist) {
      if (!isNonEmptyString(step.outputName)) {
        errors.push(`${stepPath}.outputName is required`);
      } else if (!IDENTIFIER_PATTERN.test(step.outputName) || RESERVED_IDENTIFIERS.has(step.outputName)) {
        errors.push(`${stepPath}.outputName is invalid`);
      } else if (declaredOutputs.has(step.outputName)) {
        errors.push(`${stepPath}.outputName duplicates output ${step.outputName}`);
      }
      if (
        step.timeoutMs !== undefined &&
        (!Number.isSafeInteger(step.timeoutMs)
          || Number(step.timeoutMs) < 1000
          || Number(step.timeoutMs) > MAXIMUM_TIMEOUT_MS)
      ) {
        errors.push(
          `${stepPath}.timeoutMs must be an integer between 1000 and ${String(MAXIMUM_TIMEOUT_MS)}`,
        );
      }
    }
    if (
      step.attachments !== undefined &&
      (typeof step.attachments !== "string" ||
        !ATTACHMENT_MODES.has(step.attachments))
    ) {
      errors.push(`${stepPath}.attachments must be none or selected`);
    }
    if (!checklist && step.coreDecisionOutput !== undefined) {
      validateCoreDecisionOutput(
        step.coreDecisionOutput,
        `${stepPath}.coreDecisionOutput`,
        Array.isArray(step.participants)
          ? step.participants.filter((item): item is string => typeof item === "string")
          : [],
        step.output,
        errors,
      );
    }
    if (!checklist && step.artifactPromotion !== undefined) {
      validateArtifactPromotion(
        step.artifactPromotion,
        `${stepPath}.artifactPromotion`,
        Array.isArray(step.participants)
          ? step.participants.filter((item): item is string => typeof item === "string")
          : [],
        errors,
      );
    }
    let outputName: string | undefined;
    if (!checklist && step.output !== undefined) {
      validateOutput(step.output, `${stepPath}.output`, errors);
      if (
        isRecord(step.output) &&
        isNonEmptyString(step.output.name) &&
        IDENTIFIER_PATTERN.test(step.output.name) &&
        !RESERVED_IDENTIFIERS.has(step.output.name)
      ) {
        outputName = step.output.name;
        if (declaredOutputs.has(outputName)) {
          errors.push(`${stepPath}.output.name duplicates output ${outputName}`);
        }
      }
    }
    if (step.requiredCapabilities !== undefined) {
      if (
        !Array.isArray(step.requiredCapabilities) ||
        !step.requiredCapabilities.every(
          (item) => typeof item === "string" && CAPABILITIES.has(item as keyof AgentCapabilities),
        )
      ) {
        errors.push(`${stepPath}.requiredCapabilities contains an unknown capability`);
      } else if (new Set(step.requiredCapabilities).size !== step.requiredCapabilities.length) {
        errors.push(`${stepPath}.requiredCapabilities must not contain duplicates`);
      }
    }

    const participants = Array.isArray(step.participants)
      ? step.participants.filter(isNonEmptyString)
      : [];
    if (participants.length === 0) {
      errors.push(`${stepPath}.participants must contain at least one participant`);
    }
    if (checklist && participants.length !== 1) {
      errors.push(`${stepPath}.participants must contain exactly one summarizer`);
    }
    participants.forEach((participant, participantIndex) => {
      validateIdentifier(
        participant,
        `${stepPath}.participants.${String(participantIndex)}`,
        errors,
      );
    });
    if (new Set(participants).size !== participants.length) {
      errors.push(`${stepPath}.participants must not contain duplicates`);
    }
    const availableParticipants = new Set([
      ...knownAgentIds,
      ...(step.enabled === true ? enabledRoles : declaredRoles),
    ]);

    participants.forEach((participant) => {
      if (!availableParticipants.has(participant)) {
        errors.push(
          `${stepPath}.participants contains unknown agent or role: ${participant}`,
        );
      }
    });

    if (step.enabled === true) {
      const resolvedParticipants = participants
        .map((participant) =>
          knownAgentIds.has(participant)
            ? participant
            : enabledRoleTargets.get(participant),
        )
        .filter((participant): participant is string => Boolean(participant));
      if (new Set(resolvedParticipants).size !== resolvedParticipants.length) {
        errors.push(
          `${stepPath}.participants resolve more than once to the same agent`,
        );
      }
    }

    if (!isNonEmptyString(step.promptTemplate)) {
      errors.push(`${stepPath}.promptTemplate must be non-empty`);
    } else {
      try {
        extractTemplateKeys(step.promptTemplate).forEach((key) => {
          if (TEMPLATE_KEYS.has(key)) {
            return;
          }
          const [namespace, identifier, extra] = key.split(".");
          if (
            extra === undefined &&
            namespace === "outputs" &&
            identifier &&
            IDENTIFIER_PATTERN.test(identifier) &&
            declaredOutputs.has(identifier)
          ) {
            return;
          }
          if (
            extra === undefined &&
            (namespace === "answers" || namespace === "interventions") &&
            identifier &&
            availableParticipants.has(identifier)
          ) {
            return;
          }
          errors.push(`${stepPath}.promptTemplate contains unknown template value: ${key}`);
        });
      } catch (error) {
        errors.push(
          `${stepPath}.promptTemplate is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!checklist && step.consensus === true) {
      validateConsensusConfig(
        step.consensusConfig,
        `${stepPath}.consensusConfig`,
        participants,
        errors,
      );
      if (participants.length < 2) {
        errors.push(`${stepPath}.consensus requires at least two participants`);
      }
    } else if (!checklist && step.consensusConfig !== undefined) {
      errors.push(
        `${stepPath}.consensusConfig is only valid when consensus is true`,
      );
    }

    validateStringMap(
      step.permissionModes,
      `${stepPath}.permissionModes`,
      availableParticipants,
      errors,
    );
    validateApprovalPolicyMap(
      step.approvalPolicies,
      `${stepPath}.approvalPolicies`,
      availableParticipants,
      errors,
    );
    if (outputName && !declaredOutputs.has(outputName)) {
      declaredOutputs.add(outputName);
    }
    if (
      checklist &&
      isNonEmptyString(step.outputName) &&
      IDENTIFIER_PATTERN.test(step.outputName) &&
      !RESERVED_IDENTIFIERS.has(step.outputName) &&
      !declaredOutputs.has(step.outputName)
    ) {
      declaredOutputs.add(step.outputName);
    }
  });

  if (new Set(stepIds).size !== stepIds.length) {
    errors.push("Step ids must be unique");
  }
  if (!steps.some((step) => isRecord(step) && step.enabled === true)) {
    errors.push("At least one step must be enabled");
  }

  return errors.length > 0
    ? { success: false, errors }
    : { success: true, data: structuredClone(value) as PipelineDefinition };
};
