import { pipelineDefinitionHash } from "./identity";
import { validatePipelineDefinition } from "./schema";
import { PipelineDefinition } from "./types";
import { assignmentSlots } from "./agentAssignment";
import { grantsNoWrite } from "./permissionModes";
import { providerDisplayName } from "./providerNames";
import type { PipelineScope } from "./catalogStorage";
import type { PipelineSummary } from "../webview/protocol";

const prominentWorkflowOrder = new Map([
  ["code-review-refine", 0],
  ["feature-delivery", 1],
  ["debug", 2],
  ["paired-managed-fix", 3],
  ["review-only", 4],
  ["plan", 5],
  ["ui-ux-review", 6],
  ["fix", 7],
  ["review", 8],
  ["implementation-plan", 9],
  ["managed-fix", 10],
]);

const internalWorkflows = new Set([
  "self-improvement-convergence",
  "self-improvement-discovery",
  "self-improvement-review",
  "self-improvement-revision",
  "self-improvement",
  "todo-implementation",
  "todo-master",
]);

const pipelinePromptPlaceholders = new Map<string, string>([
  ["code-review-refine", "Review this code, reconcile findings, and fix confirmed issues…"],
  ["core-decisions", "Identify and reconcile the product decisions required for…"],
  ["cross-reference-development", "Review this code and prepare a confirmed implementation task list for…"],
  ["debug", "Diagnose this failure, implement a fix, and review the result…"],
  ["feature-delivery", "Define, implement, and review this feature within the declared scope…"],
  ["fix", "Diagnose and fix this bug, then run the declared checks…"],
  ["implementation-plan", "Inspect the codebase and produce a bounded implementation plan for…"],
  ["managed-fix", "Fix this issue within the configured paths and verification scope…"],
  ["paired-managed-fix", "Diagnose this bug, reconcile the findings, and execute the selected fixes…"],
  ["plan", "Reconcile independent implementation proposals for…"],
  ["product-review", "Review this product decision and reconcile the recommendations…"],
  ["review", "Review this code for correctness, regressions, and missing tests…"],
  ["review-only", "Review this code independently and reconcile the findings…"],
  ["self-improvement-convergence", "Reconcile the supplied improvement audits and resolve disagreements…"],
  ["self-improvement-discovery", "Audit the supplied candidate independently for improvement opportunities…"],
  ["self-improvement-review", "Review the supplied improvement candidate and check results…"],
  ["self-improvement-revision", "Apply the requested bounded revision to the supplied candidate…"],
  ["self-improvement", "Plan and implement the supplied improvement task…"],
  ["todo-implementation", "Plan, implement, and review this bounded TODO task…"],
  ["todo-master", "Inspect the supplied TODO execution state and report what remains…"],
  ["ui-ux-review", "Review this interface for usability, accessibility, and visual hierarchy…"],
]);

const pipelinePresentationIcon = (pipelineId: string): string => {
  if (pipelineId.includes("browser")) return "globe";
  if (pipelineId.includes("fix") || pipelineId === "debug") return "wrench";
  if (pipelineId.includes("plan") || pipelineId === "core-decisions") return "lightbulb";
  if (pipelineId.includes("todo")) return "checklist";
  if (pipelineId === "feature-delivery" || pipelineId.includes("improvement")) return "tools";
  if (pipelineId === "product-review") return "compass";
  return "search";
};

export const pipelinePresentation = (
  pipeline: Pick<PipelineDefinition, "id" | "name">,
  editable: boolean,
): NonNullable<PipelineSummary["presentation"]> => ({
  promptPlaceholder: editable
    ? `Describe the outcome for ${pipeline.name}…`
    : pipelinePromptPlaceholders.get(pipeline.id) ?? `Describe the outcome for ${pipeline.name}…`,
  icon: editable ? "symbol-method" : pipelinePresentationIcon(pipeline.id),
});

export const pipelinePickerMetadata = (
  pipelineId: string,
  editable: boolean,
): Pick<PipelineSummary, "pickerCategory" | "prominentOrder"> => {
  if (editable) return { pickerCategory: "custom" };
  const prominentOrder = prominentWorkflowOrder.get(pipelineId);
  if (prominentOrder !== undefined) return { pickerCategory: "common", prominentOrder };
  if (internalWorkflows.has(pipelineId)) return { pickerCategory: "internal" };
  return { pickerCategory: "specialized" };
};

const pipelineWritesCode = (pipeline: PipelineDefinition): boolean => {
  if (pipeline.managedPolicy?.writeScope === "readOnly") return false;
  if (pipeline.managedPolicy?.writeScope !== undefined) return true;
  const agents = new Map(pipeline.agents.map((agent) => [agent.id, agent]));
  const roles = new Map((pipeline.roles ?? []).map((role) => [role.id, role]));
  return pipeline.steps.some((step) => {
    if (!step.enabled) return false;
    if (step.type === "executeChecklist") return true;
    if (step.type === "assignRoles") return false;
    return step.participants.some((participant) => {
      const role = roles.get(participant);
      const agent = agents.get(participant);
      if (role === undefined && agent === undefined) return false;
      return !grantsNoWrite({
        requested: step.permissionModes?.[participant] ?? agent?.permissionMode,
        roleReadOnly: role?.readOnly === true,
      });
    });
  });
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const pipelineDetails = (pipeline: PipelineDefinition): PipelineSummary["details"] => {
  const slots = assignmentSlots(pipeline).slots;
  const policy = pipeline.managedPolicy;
  const writesCode = pipelineWritesCode(pipeline);
  const roles = pipeline.roles ?? [];
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const roleProviders = slots.map((slot) => {
    const model = (slot.roleId === undefined ? undefined : rolesById.get(slot.roleId)?.model) ?? slot.defaultModel;
    return {
      role: slot.responsibility,
      provider: providerDisplayName(slot.defaultAdapter),
      ...(model === undefined ? {} : { model }),
    };
  });
  const authorities = (roles.length > 0 ? roles : [{ id: "pipeline", name: "Pipeline", instructions: "" }]).map((role) => {
    const readOnly = policy?.writeScope === "readOnly" || ("readOnly" in role ? role.readOnly === true : !writesCode);
    return {
      role: role.name,
      managed: "managed" in role ? role.managed === true : policy !== undefined,
      readOnly,
      writeScope: readOnly ? "readOnly" as const : policy?.writeScope ?? ("writeScope" in role ? role.writeScope : undefined) ?? "workspace",
      writablePaths: unique(policy?.allowedPaths ?? ("allowedPaths" in role ? role.allowedPaths : undefined) ?? []),
      protectedPaths: unique(policy?.protectedPaths ?? ("protectedPaths" in role ? role.protectedPaths : undefined) ?? []),
      commitMode: policy?.commitMode ?? ("commitMode" in role ? role.commitMode : undefined) ?? "never",
      checks: unique((policy?.verificationChecks ?? ("verificationChecks" in role ? role.verificationChecks : undefined) ?? []).map((check) => check.command)),
    };
  });
  const limits: PipelineSummary["details"]["limits"] = [];
  pipeline.steps.forEach((step) => {
    if (!step.enabled) return;
    if (step.type === "agent" && step.consensus) {
      limits.push({ kind: "consensusRounds", value: step.consensusConfig?.maxRounds ?? 1, stepName: step.name });
    }
    if (step.type === "checklist" && step.timeoutMs !== undefined) {
      limits.push({ kind: "stepTimeout", value: step.timeoutMs, stepName: step.name });
    }
    if (step.type === "executeChecklist") {
      if (step.retries !== undefined) limits.push({ kind: "checklistRetries", value: step.retries, stepName: step.name });
      if (step.maxConcurrency !== undefined) limits.push({ kind: "checklistConcurrency", value: step.maxConcurrency, stepName: step.name });
    }
  });
  if (policy?.maxRevisionCycles !== undefined) {
    limits.push({ kind: "revisionCycles", value: policy.maxRevisionCycles });
  }
  const humanDecisions: PipelineSummary["details"]["humanDecisions"] = pipeline.steps.flatMap((step) => {
    if (!step.enabled) return [];
    const timing = step.humanGate;
    const explicit = timing === "before" || timing === "after" || timing === "both"
      ? [{ stepName: step.name, timing }]
      : [];
    const consensusLimit = step.type === "agent" && step.consensus &&
      (step.consensusConfig?.onMaxRounds ?? "humanGate") === "humanGate"
      ? [{ stepName: step.name, timing: "consensusLimit" as const }]
      : [];
    return [...explicit, ...consensusLimit];
  });
  return { roleProviders, authorities, limits, humanDecisions };
};

export const pipelineSummary = (
  pipeline: PipelineDefinition,
  editable: boolean,
  hash: string,
  scope: PipelineScope,
): PipelineSummary => {
  const slots = assignmentSlots(pipeline).slots;
  return {
    id: pipeline.id,
    name: pipeline.name,
    ...(pipeline.description === undefined ? {} : { description: pipeline.description }),
    editable,
    hash,
    scopeKey: editable ? scope.key : "builtin",
    ...pipelinePickerMetadata(pipeline.id, editable),
    participantCount: slots.length,
    participantNames: slots.map((slot) => slot.responsibility),
    writesCode: pipelineWritesCode(pipeline),
    stepCount: pipeline.steps.filter((step) => step.enabled).length,
    presentation: pipelinePresentation(pipeline, editable),
    details: pipelineDetails(pipeline),
    ...(editable && scope.root ? { scopeRoot: scope.root } : {}),
  };
};

export type PipelineValidator = (value: unknown, source: string) => PipelineDefinition;

export const createPipelineValidator = (
  validateAgainstAdapters: (pipeline: PipelineDefinition) => string[],
): PipelineValidator => (value, source) => {
  const validated = validatePipelineDefinition(value);
  if (validated.success === false) {
    throw new Error(`Invalid pipeline ${source}: ${validated.errors.join("; ")}`);
  }
  const adapterErrors = validateAgainstAdapters(validated.data);
  if (adapterErrors.length > 0) {
    throw new Error(`Invalid pipeline ${source}: ${adapterErrors.join("; ")}`);
  }
  return validated.data;
};

export type CatalogDirectoryEntry = {
  name: string;
  isFile: () => boolean;
};

export type BuiltInCatalogRead = {
  loaded: Map<string, PipelineDefinition>;
  quarantined: string[];
};

export type BuiltInCatalogSources = {
  readDirectory: () => Promise<CatalogDirectoryEntry[]>;
  readText: (name: string) => Promise<string>;
  validate: PipelineValidator;
};

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The built-in catalog, loaded whole or not at all — and never partly.
 *
 * Two faults compounded before this was one function. An invalid preset threw out of the loop, so
 * one shipped file taking a Codex-incompatible permission mode removed EVERY default pipeline from
 * the editor rather than itself. And because the map was populated as the loop went and "loaded"
 * was read as `size > 0`, whatever had been added before the throw stayed behind and every later
 * call returned that partial catalog as if it were complete.
 *
 * So the read builds a separate map, an unusable preset is quarantined by name with its reason
 * instead of taking the others down, and the caller publishes the catalog in one assignment once
 * the whole directory has been read. Nothing is published when nothing loaded: an empty catalog is
 * a hard failure and throws here.
 *
 * Two files claiming one id are both wrong, and neither is more right for having been read first.
 * Keeping the first made directory order the arbiter of which definition the editor served, so the
 * same two files could ship different behaviour on two machines. Every definition in the conflict
 * is quarantined and every filename in it is named.
 */
export const readBuiltInPipelineCatalog = async (
  sources: BuiltInCatalogSources,
): Promise<BuiltInCatalogRead> => {
  const entries = await sources.readDirectory();
  const parsed: { file: string; pipeline: PipelineDefinition }[] = [];
  const quarantined: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      parsed.push({
        file: entry.name,
        pipeline: sources.validate(
          JSON.parse(await sources.readText(entry.name)) as unknown,
          entry.name,
        ),
      });
    } catch (error) {
      quarantined.push(`${entry.name}: ${describeFailure(error)}`);
    }
  }
  const filesById = new Map<string, string[]>();
  parsed.forEach(({ file, pipeline }) => {
    filesById.set(pipeline.id, [...(filesById.get(pipeline.id) ?? []), file]);
  });
  const conflictingEntries = [...filesById.entries()]
    .filter(([, files]) => files.length > 1);
  const conflictingIds = new Set(conflictingEntries.map(([pipelineId]) => pipelineId));
  conflictingEntries.forEach(([pipelineId, declaredFiles]) => {
    const files = [...declaredFiles].sort();
    files.forEach((file) => {
      quarantined.push(
        `${file}: duplicate pipeline id ${pipelineId}, also declared by ${files.filter((other) => other !== file).join(", ")}`,
      );
    });
  });
  const loaded = new Map<string, PipelineDefinition>(
    parsed
      .filter(({ pipeline }) => !conflictingIds.has(pipeline.id))
      .map(({ pipeline }) => [pipeline.id, pipeline] as const),
  );
  quarantined.sort();
  if (loaded.size === 0) {
    throw new Error(
      quarantined.length > 0
        ? `No pipeline preset could be loaded: ${quarantined.join("; ")}`
        : "No pipeline presets were found",
    );
  }
  return { loaded, quarantined };
};

export type CustomCatalogEntry = {
  pipeline: PipelineDefinition;
  filePath: string;
  hash: string;
};

export type CustomCatalogRead = {
  loaded: CustomCatalogEntry[];
  error?: string;
};

export type CustomCatalogSources = {
  readDirectory: () => Promise<CatalogDirectoryEntry[]>;
  resolveFile: (name: string) => string;
  readText: (filePath: string) => Promise<string | undefined>;
  validate: PipelineValidator;
  isBuiltIn: (pipelineId: string) => boolean;
};

/**
 * The custom catalog is a directory a user edits, so every fault it can hold is reported together
 * rather than at the first one: a bad file, a misnamed file, a file shadowing a built-in id, and
 * two files claiming one id are all named in a single refusal. An invalid catalog loads nothing,
 * and the entries read before the fault are still returned so the caller can say what was found.
 */
export const readCustomPipelineCatalog = async (
  sources: CustomCatalogSources,
): Promise<CustomCatalogRead> => {
  const entries = await sources.readDirectory();
  const loaded: CustomCatalogEntry[] = [];
  const issues: string[] = [];
  const filesById = new Map<string, string[]>();
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".pipeline.json")) {
      continue;
    }
    if (!entry.isFile()) {
      issues.push(`Pipeline path ${entry.name} is not a regular file`);
      continue;
    }
    const filePath = sources.resolveFile(entry.name);
    try {
      const source = await sources.readText(filePath);
      if (source === undefined) {
        throw new Error(`Pipeline file ${entry.name} changed while the catalog was loading`);
      }
      const pipeline = sources.validate(JSON.parse(source) as unknown, filePath);
      const expectedName = `${pipeline.id}.pipeline.json`;
      if (entry.name !== expectedName) {
        throw new Error(`Pipeline file ${entry.name} must be named ${expectedName}`);
      }
      if (sources.isBuiltIn(pipeline.id)) {
        throw new Error(`Custom pipeline ${pipeline.id} conflicts with a built-in preset`);
      }
      filesById.set(pipeline.id, [...(filesById.get(pipeline.id) ?? []), filePath]);
      loaded.push({ pipeline, filePath, hash: pipelineDefinitionHash(pipeline) });
    } catch (error) {
      issues.push(describeFailure(error));
    }
  }
  filesById.forEach((files, pipelineId) => {
    if (files.length > 1) {
      issues.push(`Duplicate custom pipeline id ${pipelineId}: ${files.join(", ")}`);
    }
  });
  if (issues.length > 0) {
    return { loaded, error: `Custom pipeline catalog is invalid: ${issues.join("; ")}` };
  }
  return { loaded };
};

/**
 * The four maps the runtime serves its catalog from. They are passed in rather than owned here
 * because other parts of the runtime hold references to the same instances, so a reload refills
 * them instead of replacing them.
 */
export type PipelineCatalogMaps = {
  pipelines: Map<string, PipelineDefinition>;
  hashes: Map<string, string>;
  customIds: Set<string>;
  customFiles: Map<string, string>;
};

export const resetPipelineCatalog = (
  catalog: PipelineCatalogMaps,
  builtIn: ReadonlyMap<string, PipelineDefinition>,
): void => {
  catalog.pipelines.clear();
  catalog.hashes.clear();
  catalog.customIds.clear();
  catalog.customFiles.clear();
  builtIn.forEach((pipeline, pipelineId) => {
    catalog.pipelines.set(pipelineId, pipeline);
    catalog.hashes.set(pipelineId, pipelineDefinitionHash(pipeline));
  });
};

export const addCustomPipelines = (
  catalog: PipelineCatalogMaps,
  loaded: readonly CustomCatalogEntry[],
): void => {
  loaded.forEach(({ pipeline, filePath, hash }) => {
    catalog.pipelines.set(pipeline.id, pipeline);
    catalog.hashes.set(pipeline.id, hash);
    catalog.customIds.add(pipeline.id);
    catalog.customFiles.set(pipeline.id, filePath);
  });
};

export type LegacyMigrationPlan = {
  pipelines: PipelineDefinition[];
  ignored: string[];
};

/**
 * Which of a legacy workspace-state array may be written into the on-disk catalog. A value that
 * is not an array was never a catalog and yields no plan at all, which is how the caller tells
 * "nothing to migrate" from "migrate nothing". A legacy entry whose id now belongs to a built-in
 * preset is ignored with its reason rather than shadowing the preset.
 */
export const planLegacyCustomPipelineMigration = (
  values: unknown,
  validate: PipelineValidator,
  isBuiltIn: (pipelineId: string) => boolean,
): LegacyMigrationPlan | undefined => {
  if (!Array.isArray(values)) {
    return undefined;
  }
  const pipelines: PipelineDefinition[] = [];
  const ignored: string[] = [];
  values.forEach((value, index) => {
    try {
      const pipeline = validate(value, `legacy custom ${String(index + 1)}`);
      if (isBuiltIn(pipeline.id)) {
        ignored.push(
          `Ignored legacy custom pipeline ${pipeline.id}: the id belongs to a built-in preset`,
        );
        return;
      }
      pipelines.push(pipeline);
    } catch (error) {
      ignored.push(describeFailure(error));
    }
  });
  return { pipelines, ignored };
};
