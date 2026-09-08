import { createGenericBrowserAdapter } from "./genericBrowserAdapter";
import { BrowserBridgeServer } from "../browser/bridgeServer";
import {
  AgentDefinition,
  PipelineDefinition,
  RoleDefinition,
} from "../pipeline/types";
import {
  adapterHasApprovalVocabulary,
  adapterHasPermissionVocabulary,
  adapterIndependentPermissionModes,
  effectivePermissionMode,
} from "../pipeline/permissionModes";
import { createBrowserChatGptAdapter } from "./browserChatGpt";
import { createBrowserClaudeAdapter } from "./browserClaude";
import { createClaudeCodeAdapter } from "./claudeCode";
import {
  ClaudePermissionRequest,
  ClaudePermissionResponse,
  ClaudeUserInputRequest,
  ClaudeUserInputResponse,
} from "./claudeHooks";
import {
  CodexApprovalRequest,
  CodexMcpElicitationRequest,
  CodexMcpElicitationResponse,
  CodexUserInputRequest,
  CodexUserInputResponse,
  createCodexAppServerAdapter,
} from "./codexAppServer";
import { AgentAdapter, CodexApprovalPolicy } from "./types";
import type { CodexWorkspaceScope } from "./codexWire";

export type AdapterFactoryContext = {
  bridge: BrowserBridgeServer;
  browserOwnerId: string;
  log: (message: string) => void;
  commandCheckTimeoutMs: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  interruptGraceMs: number;
  environment: NodeJS.ProcessEnv;
  providerEnvironment?: (adapterType: string) => NodeJS.ProcessEnv;
  zaiModel?: string;
  codexWorkspaceScope?: CodexWorkspaceScope;
  requestCodexApproval: (
    agentId: string,
    request: CodexApprovalRequest,
  ) => Promise<string>;
  requestCodexUserInput: (
    agentId: string,
    request: CodexUserInputRequest,
  ) => Promise<CodexUserInputResponse>;
  requestCodexMcpElicitation: (
    agentId: string,
    request: CodexMcpElicitationRequest,
  ) => Promise<CodexMcpElicitationResponse>;
  requestClaudeUserInput: (
    agentId: string,
    request: ClaudeUserInputRequest,
  ) => Promise<ClaudeUserInputResponse>;
  requestClaudePermission: (
    agentId: string,
    request: ClaudePermissionRequest,
  ) => Promise<ClaudePermissionResponse>;
};

export type AdapterFactory = (
  definition: AgentDefinition,
  context: AdapterFactoryContext,
) => AgentAdapter;

export type AdapterRegistry = {
  create: (
    definition: AgentDefinition,
    context: AdapterFactoryContext,
  ) => AgentAdapter;
  has: (adapterType: string) => boolean;
  types: () => string[];
  validateDefinition: (definition: AgentDefinition) => string[];
  validatePipeline: (pipeline: PipelineDefinition) => string[];
};

export type AdapterRegistration = {
  create: AdapterFactory;
  validateDefinition: (definition: AgentDefinition) => string[];
  validateOptions: (options: {
    permissionMode?: string;
    approvalPolicy?: CodexApprovalPolicy;
  }) => string[];
};


export const BUILT_IN_ADAPTER_TYPES = [
  "codex-app-server",
  "claude-code",
  "zai-glm",
  "chatgpt-browser",
  "claude-browser",
  "generic-browser",
] as const;

const providerEnvironmentFor = (
  context: AdapterFactoryContext,
  adapterType: string,
): NodeJS.ProcessEnv => context.providerEnvironment?.(adapterType) ?? context.environment;

const externalRegistrations = new Map<string, AdapterRegistration>();
const adapterTypePattern = /^[a-z][a-z0-9-]{1,63}$/u;

export const registerAdapterType = (
  adapterType: string,
  registration: AdapterRegistration,
): { dispose: () => void } => {
  if (!adapterTypePattern.test(adapterType)) {
    throw new Error(`Invalid adapter type: ${adapterType}`);
  }
  if ((BUILT_IN_ADAPTER_TYPES as readonly string[]).includes(adapterType)) {
    throw new Error(`Built-in adapter type cannot be replaced: ${adapterType}`);
  }
  if (externalRegistrations.has(adapterType)) {
    throw new Error(`Adapter type is already registered: ${adapterType}`);
  }
  externalRegistrations.set(adapterType, registration);
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (externalRegistrations.get(adapterType) === registration) {
        externalRegistrations.delete(adapterType);
      }
    },
  };
};

const codexPermissionModes = new Set(["readOnly", "workspaceWrite"]);
const codexApprovalPolicies = new Set<CodexApprovalPolicy>([
  "onRequest",
  "unlessTrusted",
]);
const claudePermissionModes = new Set([
  "plan",
  "default",
  "manual",
  "dontAsk",
  "acceptEdits",
  "auto",
  "bypassPermissions",
]);

const unsupportedFields = (
  definition: AgentDefinition,
  fields: Array<keyof AgentDefinition>,
): string[] =>
  fields
    .filter((field) => definition[field] !== undefined)
    .map(
      (field) =>
        `Agent ${definition.id} adapter ${definition.adapter} does not support ${field}`,
    );

const resolveOption = <T>(
  values: Record<string, T> | undefined,
  participant: string,
  agentId: string,
): T | undefined => values?.[participant] ?? values?.[agentId];

export const createAdapterRegistry = (): AdapterRegistry => {
  const registrations = new Map<string, AdapterRegistration>();

  registrations.set("codex-app-server", {
    create: (definition, context) =>
      createCodexAppServerAdapter({
        id: definition.id,
        ...(definition.resourceId === undefined ? {} : { resourceId: definition.resourceId }),
        command: definition.command ?? "codex",
        log: context.log,
        commandCheckTimeoutMs: context.commandCheckTimeoutMs,
        requestTimeoutMs: context.requestTimeoutMs,
        turnTimeoutMs: context.turnTimeoutMs,
        interruptGraceMs: context.interruptGraceMs,
        environment: providerEnvironmentFor(context, "codex-app-server"),
        workspaceScope: context.codexWorkspaceScope,
        requestApproval: (request) =>
          context.requestCodexApproval(definition.id, request),
        requestUserInput: (request) =>
          context.requestCodexUserInput(definition.id, request),
        requestMcpElicitation: (request) =>
          context.requestCodexMcpElicitation(definition.id, request),
      }),
    validateDefinition: (definition) => {
      const errors: string[] = [];
      if (
        definition.permissionMode !== undefined &&
        !codexPermissionModes.has(definition.permissionMode)
      ) {
        errors.push(
          `Agent ${definition.id} has unsupported Codex permission mode ${definition.permissionMode}`,
        );
      }
      if (
        definition.approvalPolicy !== undefined &&
        !codexApprovalPolicies.has(definition.approvalPolicy)
      ) {
        errors.push(
          `Agent ${definition.id} has unsupported Codex approval policy ${definition.approvalPolicy}`,
        );
      }
      return errors;
    },
    validateOptions: (options) => {
      const errors: string[] = [];
      if (
        options.permissionMode !== undefined &&
        !codexPermissionModes.has(options.permissionMode)
      ) {
        errors.push(`unsupported Codex permission mode ${options.permissionMode}`);
      }
      if (
        options.approvalPolicy !== undefined &&
        !codexApprovalPolicies.has(options.approvalPolicy)
      ) {
        errors.push(`unsupported Codex approval policy ${options.approvalPolicy}`);
      }
      return errors;
    },
  });

  registrations.set("claude-code", {
    create: (definition, context) =>
      createClaudeCodeAdapter({
        id: definition.id,
        ...(definition.resourceId === undefined ? {} : { resourceId: definition.resourceId }),
        command: definition.command ?? "claude",
        log: context.log,
        commandTimeoutMs: context.commandCheckTimeoutMs,
        turnTimeoutMs: context.turnTimeoutMs,
        interruptGraceMs: context.interruptGraceMs,
        environment: providerEnvironmentFor(context, "claude-code"),
        requestUserInput: (request) =>
          context.requestClaudeUserInput(definition.id, request),
        requestPermission: (request) =>
          context.requestClaudePermission(definition.id, request),
      }),
    validateDefinition: (definition) => {
      const errors = unsupportedFields(definition, ["approvalPolicy"]);
      if (
        definition.permissionMode !== undefined &&
        !claudePermissionModes.has(definition.permissionMode)
      ) {
        errors.push(
          `Agent ${definition.id} has unsupported Claude permission mode ${definition.permissionMode}`,
        );
      }
      return errors;
    },
    validateOptions: (options) => {
      const errors: string[] = [];
      if (
        options.permissionMode !== undefined &&
        !claudePermissionModes.has(options.permissionMode)
      ) {
        errors.push(`unsupported Claude permission mode ${options.permissionMode}`);
      }
      if (options.approvalPolicy !== undefined) {
        errors.push("Claude does not support Codex approval policies");
      }
      return errors;
    },
  });

  registrations.set("zai-glm", {
    create: (definition, context) =>
      createClaudeCodeAdapter({
        id: definition.id,
        adapterType: "zai-glm",
        ...(definition.resourceId === undefined ? {} : { resourceId: definition.resourceId }),
        command: definition.command ?? "claude",
        ...(context.zaiModel === undefined || context.zaiModel.length === 0
          ? {}
          : { defaultModel: context.zaiModel }),
        log: context.log,
        commandTimeoutMs: context.commandCheckTimeoutMs,
        turnTimeoutMs: context.turnTimeoutMs,
        interruptGraceMs: context.interruptGraceMs,
        environment: providerEnvironmentFor(context, "zai-glm"),
        requestUserInput: (request) =>
          context.requestClaudeUserInput(definition.id, request),
        requestPermission: (request) =>
          context.requestClaudePermission(definition.id, request),
      }),
    validateDefinition: (definition) => {
      const errors = unsupportedFields(definition, ["approvalPolicy"]);
      if (
        definition.permissionMode !== undefined &&
        !claudePermissionModes.has(definition.permissionMode)
      ) {
        errors.push(
          `Agent ${definition.id} has unsupported Z.AI GLM permission mode ${definition.permissionMode}`,
        );
      }
      return errors;
    },
    validateOptions: (options) => {
      const errors: string[] = [];
      if (
        options.permissionMode !== undefined &&
        !claudePermissionModes.has(options.permissionMode)
      ) {
        errors.push(`unsupported Z.AI GLM permission mode ${options.permissionMode}`);
      }
      if (options.approvalPolicy !== undefined) {
        errors.push("Z.AI GLM does not support Codex approval policies");
      }
      return errors;
    },
  });

  registrations.set("chatgpt-browser", {
    create: (definition, context) =>
      createBrowserChatGptAdapter({
        id: definition.id,
        bridge: context.bridge,
        ownerId: `${context.browserOwnerId}:${definition.id}`,
        turnTimeoutMs: context.turnTimeoutMs,
      }),
    validateDefinition: (definition) =>
      unsupportedFields(definition, [
        "command",
        "model",
        "permissionMode",
        "approvalPolicy",
      ]),
    validateOptions: (options) => {
      const errors: string[] = [];
      if (options.permissionMode !== undefined) {
        errors.push("ChatGPT Browser does not support permission modes");
      }
      if (options.approvalPolicy !== undefined) {
        errors.push("ChatGPT Browser does not support approval policies");
      }
      return errors;
    },
  });

  registrations.set("generic-browser", {
    create: (definition, context) =>
      createGenericBrowserAdapter({
        id: definition.id,
        bridge: context.bridge,
        ownerId: `${context.browserOwnerId}:${definition.id}`,
        turnTimeoutMs: context.turnTimeoutMs,
      }),
    validateDefinition: (definition) =>
      unsupportedFields(definition, [
        "command",
        "model",
        "permissionMode",
        "approvalPolicy",
      ]),
    validateOptions: (options) => {
      const errors: string[] = [];
      if (options.permissionMode !== undefined) {
        errors.push("Generic Browser does not support permission modes");
      }
      if (options.approvalPolicy !== undefined) {
        errors.push("Generic Browser does not support approval policies");
      }
      return errors;
    },
  });

  registrations.set("claude-browser", {
    create: (definition, context) =>
      createBrowserClaudeAdapter({
        id: definition.id,
        bridge: context.bridge,
        ownerId: `${context.browserOwnerId}:${definition.id}`,
        turnTimeoutMs: context.turnTimeoutMs,
      }),
    validateDefinition: (definition) =>
      unsupportedFields(definition, [
        "command",
        "model",
        "permissionMode",
        "approvalPolicy",
      ]),
    validateOptions: (options) => {
      const errors: string[] = [];
      if (options.permissionMode !== undefined) {
        errors.push("Claude Browser does not support permission modes");
      }
      if (options.approvalPolicy !== undefined) {
        errors.push("Claude Browser does not support approval policies");
      }
      return errors;
    },
  });

  const registrationFor = (adapterType: string): AdapterRegistration | undefined =>
    registrations.get(adapterType) ?? externalRegistrations.get(adapterType);
  const adapterTypes = (): string[] =>
    Array.from(new Set([...registrations.keys(), ...externalRegistrations.keys()])).sort();

  const validatePipeline = (pipeline: PipelineDefinition): string[] => {
    const errors: string[] = [];
    const definitions = new Map(
      pipeline.agents.map((definition) => [definition.id, definition]),
    );
    const roles: Record<string, string> = {};
    const roleDefinitions = new Map(
      (pipeline.roles ?? []).map((role) => [role.id, role]),
    );
    // Which agents a role may resolve to: its declared candidates, or the whole roster when it
    // declares none, because that is what the run itself chooses from.
    const candidateAgentIds = (participant: string, role: RoleDefinition): string[] => {
      const declared = (role.candidateAgentIds ?? []).filter((id) => definitions.has(id));
      if (declared.length > 0) {
        return declared;
      }
      const assigned = roles[participant];
      return assigned ? [assigned] : [...definitions.keys()];
    };

    pipeline.agents.forEach((definition) => {
      const registration = registrationFor(definition.adapter);
      if (!registration) {
        errors.push(
          `Agent ${definition.id} uses unsupported adapter ${definition.adapter}`,
        );
        return;
      }
      errors.push(...registration.validateDefinition(definition));
    });

    pipeline.steps.forEach((step) => {
      if (!step.enabled) {
        return;
      }
      if (step.type === "assignRoles") {
        step.roleAssignments.forEach((assignment) => {
          roles[assignment.role] = assignment.agentId;
        });
        return;
      }
      if (step.type === "executeChecklist") {
        return;
      }
      const executionStep = step;
      executionStep.participants.forEach((participant) => {
        const role = roleDefinitions.get(participant);
        // A participant that is not an agent id is a role key, whether the pipeline declares a
        // RoleDefinition for it or only assigns it with `assignRoles`. Which agent holds it is a
        // run-time decision, so the only vocabulary that can be judged there is the
        // adapter-independent one.
        const roleKeyed = !definitions.has(participant);
        const declaredForRole = roleKeyed
          ? executionStep.permissionModes?.[participant]
          : undefined;
        const roleModeRejected =
          declaredForRole !== undefined &&
          !adapterIndependentPermissionModes.has(declaredForRole);
        if (roleModeRejected) {
          errors.push(
            `Step ${step.id}, ${participant}: a role permission mode must be read or write, not ${declaredForRole}`,
          );
        }
        // A role is validated against every agent that could hold it, not only the one an
        // assignRoles step happens to name. A run picks from the candidates by availability, so a
        // mode that suits only the declared assignment is a failure waiting for the day the other
        // candidate answers.
        const agentIds = definitions.has(participant)
          ? [participant]
          : role
            ? candidateAgentIds(participant, role)
            : roles[participant]
              ? [roles[participant]]
              : [];
        agentIds.forEach((agentId) => {
          const definition = definitions.get(agentId);
          if (!definition) {
            return;
          }
          const registration = registrationFor(definition.adapter);
          if (!registration) {
            return;
          }
          // A step option written against a role is inert for a candidate whose adapter has no
          // such setting, and is only judged for the candidates that do have one. An option
          // written against an agent id names one adapter and is judged as it always was.
          // Permission and approval are separate capabilities, asked separately. Claude has
          // permission modes and no approval policies; a single test for "has options" made a
          // role-keyed Codex approval policy an error as soon as a Claude candidate could hold
          // the role.
          // A role mode already refused above is not then judged again against each candidate:
          // one authoring mistake is one error, not one per agent that could hold the role.
          const inertPermission =
            roleKeyed &&
            (roleModeRejected || !adapterHasPermissionVocabulary(definition.adapter));
          const inertApproval = roleKeyed && !adapterHasApprovalVocabulary(definition.adapter);
          // The mode the adapter is actually sent, resolved by the same function execution uses.
          // Judging the declared word instead is what rejected the shipped feature-delivery
          // preset for a Claude mode its Codex Worker would never have received.
          const permissionMode = effectivePermissionMode({
            adapter: definition.adapter,
            requested:
              (inertPermission
                ? undefined
                : resolveOption(executionStep.permissionModes, participant, agentId)) ??
              definition.permissionMode,
            roleReadOnly: role?.readOnly === true,
          });
          const approvalPolicy =
            (inertApproval
              ? undefined
              : resolveOption(executionStep.approvalPolicies, participant, agentId)) ??
            definition.approvalPolicy;
          const optionErrors = registration.validateOptions({
            ...(permissionMode === undefined ? {} : { permissionMode }),
            ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
          });
          errors.push(
            ...optionErrors.map((error) =>
              agentIds.length > 1
                ? `Step ${step.id}, ${participant} as ${agentId}: ${error}`
                : `Step ${step.id}, ${participant}: ${error}`,
            ),
          );
        });
      });
    });

    return errors;
  };

  return {
    create: (definition, context) => {
      const registration = registrationFor(definition.adapter);
      if (!registration) {
        throw new Error(`Unsupported adapter type: ${definition.adapter}`);
      }
      return registration.create(definition, context);
    },
    has: (adapterType) => registrationFor(adapterType) !== undefined,
    types: adapterTypes,
    validateDefinition: (definition) => {
      const registration = registrationFor(definition.adapter);
      return registration
        ? registration.validateDefinition(definition)
        : [`Unsupported adapter type: ${definition.adapter}`];
    },
    validatePipeline,
  };
};
