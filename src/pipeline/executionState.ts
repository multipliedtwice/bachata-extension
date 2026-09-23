import { evidenceDigest, evidenceObject, exactKeys } from "../state/executionEvidence";
import { jsonCandidates } from "./output";

export const EXECUTION_LIMITS = {
  prompt: 128 * 1024,
  projection: 32 * 1024,
  taskInstructions: 32 * 1024,
  observation: 16 * 1024,
  recall: 16 * 1024,
  proposal: 32 * 1024,
  state: 128 * 1024,
  text: 4096,
  id: 128,
  planItems: 16,
  defects: 10,
  checks: 16,
  depth: 8,
} as const;
export type ExecutionRole = "planner" | "worker" | "reviewer";
export type ExecutionPhase = "planning" | "working" | "reviewing" | "complete" | "recovery";
export type ExecutionCheck = { id: string; command: string; status: "pending" | "passed" | "failed"; candidate: string | null; evidence: string | null };
export type ExecutionDefect = { id: string; statement: string; requiredChange: string; attribution: "lead"; evidence: string[]; status: "open" | "proposedResolved" | "resolved"; candidate: string };
export type ExecutionPlanItem = { id: string; text: string; status: "pending" | "reported" };
export type ExecutionDispatch = {
  id: string; procedure: string; role: ExecutionRole; agentId: string; baseRevision: number;
  candidate: string; status: "prepared" | "dispatched" | "settled";
  promptRef: string; answerRef: string | null;
};
export type ExecutionState = {
  version: 1; projectionVersion: 1; mode: "localTodoStateV1";
  runId: string; taskId: string; bundleId: string; bundleRef: string; taskDigest: string;
  task: string; instructions: string; assignments: { planner: string; worker: string; reviewer: string };
  revision: number; phase: ExecutionPhase; candidate: string; baselineRef: string; policyId: string;
  plan: ExecutionPlanItem[]; acceptance: string[]; defects: ExecutionDefect[]; checks: ExecutionCheck[];
  changedPathsRef: string | null; pending: ExecutionDispatch | null;
  allowedActions: string[]; latestResult: string; latestAnswerRef: string | null;
  revisionsUsed: number; repairAttempts: number; maxRevisions: number; workflowStep: string;
  directive: string | null; consumedDirective: string | null; budgetDispatch: string | null; recall: EvidenceRecall[];
};
export type EvidenceRecall = { id: string; start: number; end: number; use: "history" | "current" };
export type ExecutionOperation =
  | { type: "setPlan"; items: Array<{ id: string; text: string }>; acceptance: string[] }
  | { type: "reportWork"; planIds: string[] }
  | { type: "proposeResolution"; defectId: string }
  | { type: "raiseDefect"; id: string; statement: string; requiredChange: string; evidence: string[] }
  | { type: "resolveDefect"; defectId: string };
export type ExecutionProposal = {
  version: 1; dispatchId: string; baseRevision: number; procedure: string;
  operations: ExecutionOperation[];
  result: { status: "planned" | "worked" | "accept" | "reject" | "recall"; summary: string };
  recall?: EvidenceRecall[];
};
export const boundedText = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value, "utf8") <= max
  && Buffer.from(value, "utf8").toString("utf8") === value;
const int = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fail: (message: string) => never = (message) => { throw new Error(`Execution state refused: ${message}`); };
const obj = (value: unknown, keys: string[], required = keys): Record<string, unknown> =>
  evidenceObject(value) && exactKeys(value, keys, required) ? value : fail("unknown or missing field");
const str = (value: unknown, max: number = EXECUTION_LIMITS.text, empty = false): string =>
  boundedText(value, max, empty) ? value : fail("invalid UTF-8 text bound");
const num = (value: unknown): number => int(value) ? value : fail("invalid integer");
const arr = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail("invalid item bound");
const strings = (value: unknown, max: number, bytes: number = EXECUTION_LIMITS.text): string[] => arr(value, max).map((item) => str(item, bytes));
const id = (value: unknown): string => str(value, EXECUTION_LIMITS.id);
const ref = (value: unknown): string => {
  const result = id(value);
  return /^[a-f0-9-]{36}$/.test(result) ? result : fail("invalid evidence reference");
};
const unique = (values: readonly string[]): void => {
  if (new Set(values).size !== values.length) fail("duplicate identifier");
};
const role = (value: unknown): ExecutionRole => value === "planner" || value === "worker" || value === "reviewer" ? value : fail("invalid role");
const phase = (value: unknown): ExecutionPhase => value === "planning" || value === "working" || value === "reviewing" || value === "complete" || value === "recovery" ? value : fail("invalid phase");
const nullable = (value: unknown, read: (input: unknown) => string): string | null => value === null ? null : read(value);

export const strictExecutionJson = (source: string, maxBytes: number): unknown => {
  if (Buffer.byteLength(source, "utf8") > maxBytes) fail("JSON byte limit");
  let index = 0;
  const whitespace = (): void => { while (/\s/u.test(source[index] ?? "") && index < source.length) index += 1; };
  const string = (): string => {
    const start = index++;
    for (; index < source.length; index += 1) {
      if (source[index] === "\\") { index += 1; continue; }
      if (source[index] === '"') {
        index += 1;
        const value: unknown = JSON.parse(source.slice(start, index));
        if (typeof value !== "string") fail("JSON string");
        return value;
      }
    }
    return fail("unterminated JSON string");
  };
  const visit = (depth: number): void => {
    if (depth > EXECUTION_LIMITS.depth) fail("JSON nesting limit");
    whitespace();
    const c = source[index];
    if (c === '"') { string(); return; }
    if (c === "{" || c === "[") {
      const object = c === "{";
      const end = object ? "}" : "]";
      const seen = new Set<string>();
      index += 1;
      whitespace();
      if (source[index] === end) { index += 1; return; }
      for (;;) {
        whitespace();
        if (object) {
          if (source[index] !== '"') fail("JSON property");
          const key = string();
          if (seen.has(key)) fail("duplicate JSON property");
          seen.add(key);
          whitespace();
          if (source[index++] !== ":") fail("JSON colon");
        }
        visit(depth + 1);
        whitespace();
        if (source[index] === end) { index += 1; return; }
        if (source[index++] !== ",") fail("JSON separator");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(index));
    if (!token) fail("JSON value");
    index += token[0].length;
  };
  visit(0);
  whitespace();
  if (index !== source.length) fail("trailing JSON material");
  return JSON.parse(source);
};
const readRecall = (value: unknown): EvidenceRecall => {
  const item = obj(value, ["id", "start", "end", "use"]);
  const start = num(item.start);
  const end = num(item.end);
  if (end <= start || end - start > EXECUTION_LIMITS.recall) fail("recall range");
  if (item.use !== "history" && item.use !== "current") fail("recall use");
  return { id: ref(item.id), start, end, use: item.use };
};
const readOperation = (value: unknown): ExecutionOperation => {
  if (!evidenceObject(value)) fail("operation object");
  switch (value.type) {
    case "setPlan": {
      const item = obj(value, ["type", "items", "acceptance"]);
      const items = arr(item.items, EXECUTION_LIMITS.planItems).map((entry) => {
        const plan = obj(entry, ["id", "text"]);
        return { id: id(plan.id), text: str(plan.text) };
      });
      unique(items.map((entry) => entry.id));
      const acceptance = strings(item.acceptance, EXECUTION_LIMITS.planItems);
      if (items.length === 0 || acceptance.length === 0) fail("plan and acceptance required");
      return { type: "setPlan", items, acceptance };
    }
    case "reportWork": {
      const item = obj(value, ["type", "planIds"]);
      const planIds = strings(item.planIds, EXECUTION_LIMITS.planItems, EXECUTION_LIMITS.id);
      unique(planIds);
      return { type: "reportWork", planIds };
    }
    case "proposeResolution":
    case "resolveDefect": {
      const item = obj(value, ["type", "defectId"]);
      return { type: value.type, defectId: id(item.defectId) };
    }
    case "raiseDefect": {
      const item = obj(value, ["type", "id", "statement", "requiredChange", "evidence"]);
      const evidence = arr(item.evidence, 16).map(ref);
      if (evidence.length === 0) fail("defect evidence required");
      unique(evidence);
      return { type: "raiseDefect", id: str(item.id, 80), statement: str(item.statement), requiredChange: str(item.requiredChange), evidence };
    }
    default: return fail("unauthorized operation");
  }
};
export const parseExecutionProposal = (source: string): ExecutionProposal => {
  const value = obj(strictExecutionJson(source, EXECUTION_LIMITS.proposal), ["version", "dispatchId", "baseRevision", "procedure", "operations", "result", "recall"], ["version", "dispatchId", "baseRevision", "procedure", "operations", "result"]);
  if (value.version !== 1) fail("proposal version");
  const result = obj(value.result, ["status", "summary"]);
  if (result.status !== "planned" && result.status !== "worked" && result.status !== "accept" && result.status !== "reject" && result.status !== "recall") fail("result status");
  const operations = arr(value.operations, 32).map(readOperation);
  const recall = value.recall === undefined ? undefined : arr(value.recall, 8).map(readRecall);
  if (recall && recall.reduce((sum, item) => sum + item.end - item.start, 0) > EXECUTION_LIMITS.recall) fail("aggregate recall limit");
  if (recall) unique(recall.map((item) => `${item.id}:${String(item.start)}:${String(item.end)}`));
  if ((result.status === "recall") !== ((recall?.length ?? 0) > 0) || (result.status === "recall" && operations.length > 0)) fail("incomplete recall result");
  return {
    version: 1, dispatchId: id(value.dispatchId), baseRevision: num(value.baseRevision), procedure: id(value.procedure),
    operations, result: { status: result.status, summary: str(result.summary) }, ...(recall ? { recall } : {}),
  };
};
export const parseFramedExecutionProposal = (source: string): ExecutionProposal => {
  let failure: unknown;
  for (const candidate of jsonCandidates(source)) {
    try {
      return parseExecutionProposal(candidate);
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
};
export const executionAllowedActions = (state: ExecutionState): string[] => {
  if (state.phase === "complete" || state.phase === "recovery") return [];
  const activeRole = state.pending && state.pending.status !== "settled"
    ? state.pending.role
    : state.phase === "planning" ? "planner" : state.phase === "working" ? "worker" : "reviewer";
  if (activeRole === "planner") return ["setPlan", "recall"];
  if (activeRole === "worker") return ["reportWork", "proposeResolution", "recall"];
  if (activeRole === "reviewer") return ["raiseDefect", "resolveDefect", "reject", ...(verificationPasses(state) ? ["accept"] : []), "recall"];
  return [];
};
export const verificationPasses = (state: ExecutionState): boolean => state.checks.length > 0
  && state.checks.every((check) => check.status === "passed" && check.candidate === state.candidate && check.evidence !== null);
export const reduceExecutionProposal = (state: ExecutionState, proposal: ExecutionProposal, input: {
  agentId: string; answerRef: string; observedCandidate: string; validEvidence: readonly string[];
}): ExecutionState => {
  const pending = state.pending;
  if (!pending || pending.status !== "dispatched" || state.phase === "recovery" || state.phase === "complete"
    || proposal.baseRevision !== state.revision || pending.baseRevision !== state.revision
    || proposal.dispatchId !== pending.id || proposal.procedure !== pending.procedure || input.agentId !== pending.agentId
    || pending.candidate !== state.candidate) fail("stale proposal or dispatch ownership");
  if (pending.role !== "worker" && input.observedCandidate !== pending.candidate) fail("read-only candidate drift");
  const allowed = executionAllowedActions(state);
  const next = structuredClone(state);
  const touched = new Set<string>();
  for (const operation of proposal.operations) {
    if (!allowed.includes(operation.type)) fail("field ownership");
    const key = operation.type === "setPlan" || operation.type === "reportWork" ? operation.type : operation.type === "raiseDefect" ? operation.id : operation.defectId;
    if (touched.has(key)) fail("duplicate operation target");
    touched.add(key);
    if (operation.type === "setPlan") {
      if (next.plan.length > 0) fail("plan already accepted");
      next.plan = operation.items.map((item) => ({ ...item, status: "pending" }));
      next.acceptance = [...operation.acceptance];
    } else if (operation.type === "reportWork") {
      for (const planId of operation.planIds) {
        const item = next.plan.find((entry) => entry.id === planId);
        if (!item) fail("unknown plan item");
        item.status = "reported";
      }
    } else if (operation.type === "raiseDefect") {
      if (next.defects.some((item) => item.id === operation.id)) fail("defect identifiers are immutable");
      if (operation.evidence.some((handle) => !input.validEvidence.includes(handle))) fail("unknown or stale evidence reference");
      next.defects.push({ id: operation.id, statement: operation.statement, requiredChange: operation.requiredChange, attribution: "lead", evidence: [...operation.evidence], status: "open", candidate: state.candidate });
    } else {
      const defect = next.defects.find((item) => item.id === operation.defectId);
      if (!defect || defect.status === "resolved") fail("unknown or resolved defect");
      if (operation.type === "resolveDefect" && !verificationPasses(state)) fail("unverified defect resolution");
      defect.status = operation.type === "resolveDefect" ? "resolved" : "proposedResolved";
    }
  }
  const status = proposal.result.status;
  if (status === "recall") {
    if (input.observedCandidate !== pending.candidate) fail("recall cannot conceal a mutation");
    if (proposal.recall?.some((request) => !input.validEvidence.includes(request.id))) fail("unknown recall handle");
    next.recall = proposal.recall ?? [];
  } else if (pending.role === "planner") {
    if (status !== "planned" || next.plan.length === 0 || next.acceptance.length === 0) fail("incomplete planner result");
    next.phase = "working";
  } else if (pending.role === "worker") {
    if (status !== "worked" || !proposal.operations.some((operation) => operation.type === "reportWork")) fail("incomplete worker result");
    next.phase = "reviewing";
    next.candidate = input.observedCandidate;
    next.checks = next.checks.map((check) => ({ ...check, status: "pending", candidate: null, evidence: null }));
  } else if (status === "accept") {
    if (!verificationPasses(state) || next.defects.some((defect) => defect.status !== "resolved")) fail("completion requires verification and defect resolution");
    next.phase = "complete";
  } else if (status === "reject") {
    if (!next.defects.some((defect) => defect.status !== "resolved")) fail("rejection needs an exact defect");
    next.phase = "working";
    next.directive = input.answerRef;
  } else fail("invalid reviewer result");
  if (next.defects.filter((defect) => defect.status !== "resolved").length > EXECUTION_LIMITS.defects || next.defects.length > 32) fail("defect admission limit");
  if (status !== "recall") next.recall = [];
  next.revision += 1;
  next.latestResult = proposal.result.summary;
  next.latestAnswerRef = input.answerRef;
  next.pending = { ...pending, status: "settled", answerRef: input.answerRef };
  next.allowedActions = executionAllowedActions(next);
  return parseExecutionState(next);
};

export const parseExecutionState = (input: unknown): ExecutionState => {
  const keys = ["version", "projectionVersion", "mode", "runId", "taskId", "bundleId", "bundleRef", "taskDigest", "task", "instructions", "assignments", "revision", "phase", "candidate", "baselineRef", "policyId", "plan", "acceptance", "defects", "checks", "changedPathsRef", "pending", "allowedActions", "latestResult", "latestAnswerRef", "revisionsUsed", "repairAttempts", "maxRevisions", "workflowStep", "directive", "consumedDirective", "budgetDispatch", "recall"];
  const value = obj(input, keys);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > EXECUTION_LIMITS.state) fail("state byte limit");
  if (value.version !== 1 || value.projectionVersion !== 1 || value.mode !== "localTodoStateV1") fail("state version");
  const assignments = obj(value.assignments, ["planner", "worker", "reviewer"]);
  const task = str(value.task, EXECUTION_LIMITS.taskInstructions);
  const instructions = str(value.instructions, EXECUTION_LIMITS.taskInstructions);
  if (Buffer.byteLength(task + instructions, "utf8") > EXECUTION_LIMITS.taskInstructions || evidenceDigest(task) !== value.taskDigest) fail("task admission or digest");
  const plan = arr(value.plan, EXECUTION_LIMITS.planItems).map((entry): ExecutionPlanItem => {
    const item = obj(entry, ["id", "text", "status"]);
    if (item.status !== "pending" && item.status !== "reported") fail("plan status");
    return { id: id(item.id), text: str(item.text), status: item.status };
  });
  const defects = arr(value.defects, 32).map((entry): ExecutionDefect => {
    const item = obj(entry, ["id", "statement", "requiredChange", "attribution", "evidence", "status", "candidate"]);
    if (item.attribution !== "lead" || (item.status !== "open" && item.status !== "proposedResolved" && item.status !== "resolved")) fail("defect state");
    return { id: str(item.id, 80), statement: str(item.statement), requiredChange: str(item.requiredChange), attribution: "lead", evidence: arr(item.evidence, 16).map(ref), status: item.status, candidate: id(item.candidate) };
  });
  if (defects.filter((item) => item.status !== "resolved").length > EXECUTION_LIMITS.defects) fail("unresolved defect limit");
  const checks = arr(value.checks, EXECUTION_LIMITS.checks).map((entry): ExecutionCheck => {
    const item = obj(entry, ["id", "command", "status", "candidate", "evidence"]);
    if (item.status !== "pending" && item.status !== "passed" && item.status !== "failed") fail("check state");
    const candidate = nullable(item.candidate, id);
    const evidence = nullable(item.evidence, ref);
    if (item.status !== "pending" && (!candidate || !evidence)) fail("check binding");
    return { id: id(item.id), command: str(item.command), status: item.status, candidate, evidence };
  });
  if (checks.length === 0) fail("required checks are missing");
  unique(plan.map((item) => item.id)); unique(defects.map((item) => item.id)); unique(checks.map((item) => item.id));
  let pending: ExecutionDispatch | null = null;
  if (value.pending !== null) {
    const item = obj(value.pending, ["id", "procedure", "role", "agentId", "baseRevision", "candidate", "status", "promptRef", "answerRef"]);
    if (item.status !== "prepared" && item.status !== "dispatched" && item.status !== "settled") fail("dispatch status");
    pending = { id: id(item.id), procedure: id(item.procedure), role: role(item.role), agentId: id(item.agentId), baseRevision: num(item.baseRevision), candidate: id(item.candidate), status: item.status, promptRef: ref(item.promptRef), answerRef: nullable(item.answerRef, ref) };
  }
  const state: ExecutionState = {
    version: 1, projectionVersion: 1, mode: "localTodoStateV1", runId: id(value.runId), taskId: id(value.taskId), bundleId: id(value.bundleId), bundleRef: ref(value.bundleRef), taskDigest: id(value.taskDigest), task, instructions,
    assignments: { planner: id(assignments.planner), worker: id(assignments.worker), reviewer: id(assignments.reviewer) },
    revision: num(value.revision), phase: phase(value.phase), candidate: id(value.candidate), baselineRef: ref(value.baselineRef), policyId: id(value.policyId),
    plan, acceptance: strings(value.acceptance, EXECUTION_LIMITS.planItems), defects, checks, changedPathsRef: nullable(value.changedPathsRef, ref), pending,
    allowedActions: strings(value.allowedActions, 8, EXECUTION_LIMITS.id), latestResult: str(value.latestResult, EXECUTION_LIMITS.text, true), latestAnswerRef: nullable(value.latestAnswerRef, ref),
    revisionsUsed: num(value.revisionsUsed), repairAttempts: num(value.repairAttempts), maxRevisions: num(value.maxRevisions), workflowStep: id(value.workflowStep),
    directive: nullable(value.directive, ref), consumedDirective: nullable(value.consumedDirective, ref), budgetDispatch: nullable(value.budgetDispatch, id), recall: arr(value.recall, 8).map(readRecall),
  };
  if (pending) {
    if (pending.agentId !== state.assignments[pending.role]) fail("persisted dispatch ownership");
    if (pending.status === "settled") {
      if (pending.baseRevision + 1 !== state.revision || pending.answerRef === null) fail("settled dispatch revision");
    } else if (pending.baseRevision !== state.revision || pending.answerRef !== null
      || (state.phase !== "recovery" && pending.candidate !== state.candidate)) fail("pending dispatch revision");
  }
  if (state.phase !== "planning" && state.phase !== "recovery" && (state.plan.length === 0 || state.acceptance.length === 0)) fail("required plan material missing");
  if (state.phase === "complete" && (pending?.role !== "reviewer" || pending.status !== "settled")) fail("completion has no Lead decision");
  if (state.revisionsUsed > state.maxRevisions || state.repairAttempts > state.maxRevisions || state.maxRevisions > 50) fail("revision budget");
  if (state.phase === "complete" && !verificationPasses(state)) fail("completion is unverified");
  if (state.phase === "complete" && state.defects.some((defect) => defect.status !== "resolved")) fail("completion has unresolved defects");
  if (state.recall.reduce((sum, item) => sum + item.end - item.start, 0) > EXECUTION_LIMITS.recall) fail("aggregate recall limit");
  unique(state.recall.map((item) => `${item.id}:${String(item.start)}:${String(item.end)}`));
  for (const defect of state.defects) {
    if (defect.evidence.length === 0) fail("defect evidence required");
    unique(defect.evidence);
  }
  if (JSON.stringify(state.allowedActions) !== JSON.stringify(executionAllowedActions(state))) fail("allowed actions are controller derived");
  return state;
};
