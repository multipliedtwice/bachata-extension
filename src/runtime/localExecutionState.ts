import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentRunResult } from "../adapters/types";
import {
  createExecutionEvidenceStore, evidenceDigest, evidenceObject, readPrivateFile, writePrivateFile,
  type ExecutionEvidenceStore, type EvidenceScope, type EvidencePage, type EvidenceStoreOptions,
} from "../state/executionEvidence";
import {
  EXECUTION_LIMITS, executionAllowedActions, parseExecutionProposal, parseExecutionState,
  reduceExecutionProposal, strictExecutionJson,
  type ExecutionState, type ExecutionRole, type ExecutionProposal,
} from "../pipeline/executionState";
import { executionPrompt } from "../pipeline/executionProjection";
import { redactText } from "../security/redact";

export type LocalExecutionSeed = EvidenceScope & EvidenceStoreOptions & {
  bundleId: string; bundle: string; task: string; instructions: string;
  assignments: ExecutionState["assignments"]; policyId: string; candidate: string;
  baseline: string; restart?: boolean; checks: Array<{ id: string; command: string }>; maxRevisions: number;
};
const resultForPipeline = (state: ExecutionState, proposal: ExecutionProposal): string =>
  state.pending?.role === "reviewer" && proposal.result.status !== "recall"
    ? JSON.stringify({ candidate: state.candidate, review: {
        verdict: proposal.result.status, summary: proposal.result.summary,
        defects: state.defects.filter((defect) => defect.status !== "resolved").map((defect) => ({
          id: defect.id, statement: defect.statement, requiredChange: defect.requiredChange, evidence: defect.evidence,
        })),
      } })
    : proposal.result.summary;
export const createLocalExecutionState = async (storageDirectory: string, seed: LocalExecutionSeed) => {
  const evidence = createExecutionEvidenceStore(storageDirectory, seed, seed);
  const mutate = seed.withMutation ?? (<T>(operation: () => Promise<T>): Promise<T> => operation());
  await evidence.manifest();
  const file = path.join(evidence.directory, "execution-state.json");
  let state: ExecutionState;
  try {
    state = parseExecutionState(strictExecutionJson((await readPrivateFile(file, EXECUTION_LIMITS.state)).toString("utf8"), EXECUTION_LIMITS.state));
    if (state.runId !== seed.runId || state.taskId !== seed.taskId || state.bundleId !== seed.bundleId
      || state.taskDigest !== evidenceDigest(redactText(seed.task)) || state.instructions !== redactText(seed.instructions) || (!seed.restart && state.policyId !== seed.policyId)
      || JSON.stringify(state.assignments) !== JSON.stringify(seed.assignments)) throw new Error("Compact recovery identity changed; explicit task restart required");
    if (state.maxRevisions !== seed.maxRevisions
      || JSON.stringify(state.checks.map(({ id, command }) => ({ id, command }))) !== JSON.stringify(seed.checks)) throw new Error("Compact recovery check or budget contract changed");
    const bundle = await evidence.read(state.bundleRef, "controller");
    const baseline = await evidence.read(state.baselineRef, "controller");
    if (bundle.record.kind !== "bundle" || bundle.content !== redactText(seed.bundle) || baseline.record.kind !== "baseline") throw new Error("Compact recovery immutable evidence mismatch");
    if (baseline.record.redactions.length > 0) throw new Error("Task-start baseline cannot be reconstructed after credential redaction");
    const references = [state.changedPathsRef, state.latestAnswerRef, state.directive, state.consumedDirective,
      state.pending?.promptRef, state.pending?.answerRef, ...state.defects.flatMap((defect) => defect.evidence),
      ...state.checks.map((check) => check.evidence)];
    for (const reference of new Set(references)) if (reference) await evidence.read(reference, "controller");
    for (const check of state.checks) {
      if (!check.evidence) continue;
      const admitted = await evidence.read(check.evidence, "controller");
      if (admitted.record.kind !== "controller" || admitted.record.candidate !== check.candidate) throw new Error("Compact check evidence binding mismatch");
    }
    if (state.pending?.status === "prepared") {
      const pages: EvidencePage[] = [];
      for (const request of state.recall) pages.push(await evidence.page({ ...request, reader: state.pending.role, candidate: state.candidate }));
      const issued = await evidence.read(state.pending.promptRef, "controller");
      if (issued.record.kind !== "prompt" || issued.content !== redactText(executionPrompt(state, pages))) throw new Error("Prepared execution prompt cannot be reconstructed exactly");
    }
    if (seed.restart) {
      await evidence.put({ kind: "controller", source: "explicit task restart superseded state", content: JSON.stringify(state), candidate: seed.candidate });
      throw Object.assign(new Error("Explicit restart"), { code: "EXPLICIT_RESTART" });
    }
  } catch (error) {
    if (!evidenceObject(error) || (error.code !== "ENOENT" && error.code !== "EXPLICIT_RESTART")) throw error;
    const manifest = await evidence.manifest();
    const safeAdmissionRestart = seed.restart && manifest.records.every((record) => ["bundle", "baseline", "task"].includes(record.kind));
    if (manifest.records.length > 0 && error.code !== "EXPLICIT_RESTART" && !safeAdmissionRestart) throw new Error("Partial execution admission requires recovery; no provider dispatch is permitted");
    const task = redactText(seed.task);
    const instructions = redactText(seed.instructions);
    if (Buffer.byteLength(task + instructions, "utf8") > EXECUTION_LIMITS.taskInstructions) throw new Error("Exact task and instructions exceed compact admission limit");
    const bundle = await evidence.put({ kind: "bundle", source: "immutable pipeline bundle", content: seed.bundle });
    const baseline = await evidence.put({ kind: "baseline", source: "task-start repository baseline", content: seed.baseline, candidate: seed.candidate });
    if (baseline.redactions.length > 0) throw new Error("Task-start baseline cannot be reconstructed after credential redaction");
    await evidence.put({ kind: "task", source: "exact task and role instructions", content: JSON.stringify({ task, instructions }),
      redactions: task === seed.task && instructions === seed.instructions ? [] : ["Task or role instructions were credential-redacted before admission."] });
    state = parseExecutionState({
      version: 1, projectionVersion: 1, mode: "localTodoStateV1", runId: seed.runId, taskId: seed.taskId,
      bundleId: seed.bundleId, bundleRef: bundle.id, taskDigest: evidenceDigest(task), task, instructions, assignments: seed.assignments,
      revision: 0, phase: "planning", candidate: seed.candidate, baselineRef: baseline.id, policyId: seed.policyId,
      plan: [], acceptance: [], defects: [], checks: seed.checks.map((check) => ({ ...check, status: "pending", candidate: null, evidence: null })),
      changedPathsRef: null, pending: null, allowedActions: ["setPlan", "recall"], latestResult: "", latestAnswerRef: null,
      revisionsUsed: 0, repairAttempts: 0, maxRevisions: seed.maxRevisions, workflowStep: "lead-plan",
      directive: null, consumedDirective: null, budgetDispatch: null, recall: [],
    });
    executionPrompt(state);
    await mutate(() => writePrivateFile(file, JSON.stringify(state)));
  }
  let tail: Promise<void> = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const save = async (next: ExecutionState): Promise<void> => {
    const accepted = parseExecutionState({ ...next, allowedActions: executionAllowedActions(next) });
    executionPrompt(accepted);
    await mutate(() => writePrivateFile(file, JSON.stringify(accepted)));
    state = accepted;
  };
  const invalidate = async (candidate: string): Promise<void> => {
    if (candidate === state.candidate) return;
    await save({ ...state, candidate, checks: state.checks.map((check) => ({ ...check, status: "pending", candidate: null, evidence: null })), phase: "recovery" });
    throw new Error("Workspace changed outside the issued dispatch; compact execution requires reconciliation");
  };
  const dispatch = (input: {
    procedure: string; role: ExecutionRole; agentId: string; repairAttempt?: number; candidate: () => Promise<string>;
    send: (prompt: string, archiveAnswer: (answer: string) => Promise<void>) => Promise<AgentRunResult>;
    audit: () => Promise<{ candidate: string; changedPaths: string[] }>;
    persistBoundary: () => Promise<void>;
  }): Promise<AgentRunResult> => exclusive(async () => {
    if (state.assignments[input.role] !== input.agentId) throw new Error("Compact dispatch assignment changed");
    const observed = await input.candidate();
    if (state.pending?.status === "dispatched" || state.phase === "recovery") {
      const audit = await input.audit();
      await evidence.put({ kind: "controller", source: "uncertain dispatch reconciliation", content: JSON.stringify({ issuedCandidate: state.pending?.candidate, observedCandidate: audit.candidate, changedPaths: audit.changedPaths, outcome: "uncertain; mutation must not be replayed" }), candidate: audit.candidate });
      await save({ ...state, phase: "recovery", candidate: audit.candidate, checks: state.checks.map((check) => ({ ...check, status: "pending", candidate: null, evidence: null })) });
      throw new Error("A dispatched compact turn is unsettled. Workspace was reconciled; no mutation was replayed. Use existing recovery to inspect and explicitly restart the task.");
    }
    await invalidate(observed);
    if (state.pending?.status === "settled" && state.pending.procedure === input.procedure && state.recall.length === 0 && state.pending.answerRef) {
      const answer = await evidence.read(state.pending.answerRef, "controller");
      return { status: "completed", answer: resultForPipeline(state, parseExecutionProposal(answer.content)) };
    }
    if (state.phase === "complete") throw new Error("Completed execution cannot dispatch another turn");
    if (input.role === "planner" && state.phase !== "planning") throw new Error("Planner is not authorized after the plan was accepted");
    if (input.role === "worker" && state.phase !== "working" && state.phase !== "reviewing") throw new Error("Worker is not authorized in this workflow phase");
    if (input.role === "reviewer" && state.phase !== "reviewing") throw new Error("Reviewer is not authorized before implementation");
    for (let recalls = 0; recalls <= 4; recalls += 1) {
      let prompt: string;
      if (state.pending?.status === "prepared") {
        if (state.pending.procedure !== input.procedure || state.pending.agentId !== input.agentId) throw new Error("Prepared dispatch belongs to another workflow position");
        prompt = (await evidence.read(state.pending.promptRef, "controller")).content;
      } else {
        const pages: EvidencePage[] = [];
        for (const request of state.recall) pages.push(await evidence.page({ ...request, reader: input.role, candidate: state.candidate }));
        const provisional: ExecutionState = {
          ...state, workflowStep: input.procedure, repairAttempts: input.repairAttempt ?? state.repairAttempts,
          consumedDirective: input.role === "worker" ? state.directive : state.consumedDirective,
          directive: input.role === "worker" ? null : state.directive,
          pending: { id: randomUUID(), procedure: input.procedure, role: input.role, agentId: input.agentId, baseRevision: state.revision, candidate: state.candidate, status: "prepared", promptRef: randomUUID(), answerRef: null },
        };
        provisional.allowedActions = executionAllowedActions(provisional);
        prompt = executionPrompt(provisional, pages);
        const record = await evidence.put({ kind: "prompt", source: provisional.pending?.id ?? input.procedure, content: prompt, candidate: state.candidate, revision: state.revision });
        if (!provisional.pending) throw new Error("Missing prepared dispatch");
        provisional.pending.promptRef = record.id;
        prompt = (await evidence.read(record.id, "controller")).content;
        await save(provisional);
      }
      const pending = state.pending;
      if (!pending) throw new Error("Missing compact dispatch");
      await input.persistBoundary();
      await save({ ...state, pending: { ...pending, status: "dispatched" } });
      let answerId: string | undefined;
      const archiveAnswer = async (answer: string): Promise<void> => {
        const record = await evidence.put({ kind: "answer", source: pending.id, content: answer, candidate: pending.candidate, revision: pending.baseRevision });
        answerId = record.id;
      };
      const result = await input.send(prompt, archiveAnswer);
      if (answerId === undefined) await archiveAnswer(result.answer);
      if (answerId === undefined) throw new Error("Exact answer was not archived");
      const answer = { id: answerId };
      if (result.status !== "completed") throw new Error("Compact dispatch interrupted; outcome remains uncertain");
      const proposal = parseExecutionProposal((await evidence.read(answer.id, "controller")).content);
      const audit = await input.audit();
      const manifest = await evidence.manifest();
      const known = manifest.records.filter((record) => record.readers.includes(input.role));
      const validEvidence = proposal.result.status === "recall"
        ? known.map((record) => record.id)
        : known.filter((record) => record.candidate === null || record.candidate === pending.candidate).map((record) => record.id);
      for (const request of proposal.recall ?? []) await evidence.page({ ...request, reader: input.role, candidate: pending.candidate });
      const next = reduceExecutionProposal(state, proposal, { agentId: input.agentId, answerRef: answer.id, observedCandidate: audit.candidate, validEvidence });
      if (input.role === "worker" && proposal.result.status === "worked") {
        const paths = await evidence.put({ kind: "changedPaths", source: pending.id, content: JSON.stringify(audit.changedPaths), candidate: audit.candidate, revision: next.revision });
        next.changedPathsRef = paths.id;
      }
      await save(next);
      await input.persistBoundary();
      if (proposal.result.status !== "recall") return { status: "completed", answer: resultForPipeline(state, proposal) };
    }
    throw new Error("Explicit evidence recall limit reached");
  });
  const verification = (candidate: string, records: Array<{ id: string; status: string; content: string }>): Promise<void> => exclusive(async () => {
    await invalidate(candidate);
    const checks = [];
    for (const check of state.checks) {
      const result = records.find((record) => record.id === check.id);
      const record = await evidence.put({ kind: "controller", source: `verification:${check.id}`, content: result?.content ?? "Required check was not run", candidate, revision: state.revision });
      checks.push({ ...check, status: result?.status === "passed" ? "passed" as const : "failed" as const, candidate, evidence: record.id });
    }
    await save({ ...state, checks });
  });
  const spendRevision = (): Promise<number> => exclusive(async () => {
    if (!state.pending) throw new Error("Revision has no dispatch owner");
    if (state.budgetDispatch === state.pending.id) return state.revisionsUsed;
    const used = state.revisionsUsed + 1;
    if (used > state.maxRevisions) return used;
    await save({ ...state, revisionsUsed: used, repairAttempts: 0, budgetDispatch: state.pending.id });
    return used;
  });
  const budgets = (input: { revisionsUsed?: number; repairAttempts?: number }): Promise<void> => exclusive(async () => {
    await save({ ...state, ...input });
  });
  const locator = async (agentId: string, sessionId: string): Promise<void> => {
    await evidence.put({ kind: "providerLocator", source: agentId, content: sessionId, candidate: state.candidate, revision: state.revision });
  };
  return { evidence, dispatch, verification, budgets, spendRevision, locator, snapshot: (): ExecutionState => structuredClone(state) };
};
export type LocalExecutionState = Awaited<ReturnType<typeof createLocalExecutionState>>;
export const localExecutionScope = (taskId: string): EvidenceScope => ({ runId: taskId, taskId });
export const localEvidenceForTask = (storageDirectory: string, taskId: string): ExecutionEvidenceStore => createExecutionEvidenceStore(storageDirectory, localExecutionScope(taskId));
