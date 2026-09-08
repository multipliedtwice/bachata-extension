import type { McpFormFieldLike } from "./providerInteraction";

/**
 * EX-3. The orchestration around a human interaction, apart from performing one.
 *
 * `providerInteraction.ts` already decides what each request says and what its answer means. What
 * stayed inline was the lifecycle every one of the five flows repeats: where the request can be
 * put at all, when it stops being worth answering, what a deadline is, what a partly answered set
 * amounts to, and which collected fields were secret. Five copies of those rules, each reachable
 * only by driving a provider through a real editor.
 */
export type InteractionRoute =
  | { route: "broker" }
  | { route: "panel" }
  | { route: "unavailable"; reason: "disposed" | "noView" };

/**
 * Where a request for a human decision can go.
 *
 * A broker — a conversation manager standing in front of the runtime — takes precedence when one
 * is configured, because it is the surface that can also fall back to a Lead. Without one, only an
 * attached panel can ask, and a disposed runtime or a runtime with no view asks nobody: the caller
 * gets the refusal its protocol defines rather than a promise that never settles.
 */
export const interactionRoute = (input: {
  hasBroker: boolean;
  panelFallback: boolean;
  disposed: boolean;
  attachedViews: number;
}): InteractionRoute => {
  if (input.hasBroker) return { route: "broker" };
  if (input.disposed) return { route: "unavailable", reason: "disposed" };
  if (input.attachedViews === 0) return { route: "unavailable", reason: "noView" };
  return input.panelFallback
    ? { route: "panel" }
    : { route: "unavailable", reason: "noView" };
};

/** When an unanswered request resolves itself, as a clock reading rather than a duration. */
export const interactionDeadline = (input: {
  now: number;
  autoResolutionMs?: number | undefined;
}): number | undefined =>
  input.autoResolutionMs === undefined ? undefined : input.now + input.autoResolutionMs;

/**
 * Whether the approval still belongs to the thing that asked for it.
 *
 * Four ways it stops: the pending record was replaced by a newer request for the same key, the
 * task moved on, the operation that asked was replaced or aborted, or the runtime was disposed.
 * Any of them means the answer would be delivered to a caller that is gone, so the request is
 * cancelled instead of being left on screen for a person to answer into nothing.
 */
export const approvalStillCurrent = (input: {
  registeredIsThisResolver: boolean;
  operationTaskId: string;
  currentTaskId: string;
  operationOwnerId?: string | undefined;
  activeOwnerId?: string | undefined;
  activeAborted?: boolean | undefined;
  disposed: boolean;
}): boolean => {
  if (!input.registeredIsThisResolver) return false;
  if (input.operationTaskId !== input.currentTaskId) return false;
  if (input.disposed) return false;
  if (input.operationOwnerId === undefined) return true;
  return input.activeOwnerId === input.operationOwnerId && input.activeAborted !== true;
};

/**
 * Asks a set of questions and answers with all of them or none.
 *
 * A request with one question unanswered answers nothing at all: the provider asked for a set, and
 * handing back the part that was answered would let it act on a decision the person did not finish
 * making. The first unanswered question also ends the asking — the rest are never put, because a
 * person who dismissed one box is not waiting to be shown the next.
 *
 * `ask` owns what an unanswered question is recorded as; this owns only what the set amounts to.
 */
export const collectInteractionAnswers = async <Question, Answer>(input: {
  questions: readonly Question[];
  keyOf: (question: Question, index: number) => string;
  ask: (question: Question, index: number) => Promise<Answer | undefined>;
}): Promise<Record<string, Answer> | undefined> => {
  const answers: Record<string, Answer> = {};
  for (const [index, question] of input.questions.entries()) {
    const answer = await input.ask(question, index);
    if (answer === undefined) return undefined;
    answers[input.keyOf(question, index)] = answer;
  }
  return answers;
};

/** Whether the configured Lead answered instead of the person, which is recorded when it happens. */
export const answeredByLead = (source: string): boolean => source === "lead";

export type McpFieldOutcome<Value> =
  | { kind: "keep"; value: Value; secret: boolean }
  | { kind: "skip" }
  | { kind: "cancel" };

/**
 * What an MCP form field with no value means. An optional field the person passed over is skipped;
 * a required one they passed over cancels the form, because a server that declared the field
 * required cannot be handed a form without it.
 */
export const mcpFieldOutcome = <Value>(
  field: Pick<McpFormFieldLike, "required" | "secret">,
  value: Value | undefined,
): McpFieldOutcome<Value> => {
  if (value === undefined) return field.required ? { kind: "cancel" } : { kind: "skip" };
  return { kind: "keep", value, secret: field.secret };
};
