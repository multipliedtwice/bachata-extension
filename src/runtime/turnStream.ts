import type {
  AgentEvent,
  AgentRunResult,
  JsonValue,
  SendRequest,
  WorkspaceWriteScope,
} from "../adapters/types";
import type { BrowserConversationBinding, CapturedResponse } from "../browser/protocol";
import { sanitizedCapturedAsset, toJsonValue } from "./browserActionRedaction";

/**
 * EX-3. What an agent turn's stream means, apart from the adapter that produces it.
 *
 * A turn is one `for await` over adapter events. Every judgement it made — how many bytes have
 * been streamed, whether that crossed the stored-response ceiling, which event replaces the
 * output rather than appending to it, which one carries a binding, which one ends the turn and
 * which one only says something on the way — lived inside that loop, so it could only be reached
 * by driving a whole conversation through a real adapter. The loop keeps the adapter call and the
 * output delivery; what an event means and what the turn owes afterwards is decided here.
 *
 * The reducer is deliberately total and order-independent: a late event after a completion is
 * still accounted, and a second completion still replaces the first, because that is what the
 * inline loop did and a turn's public behaviour must not change with the extraction.
 */
/**
 * What the adapter is told about the workspace for one turn.
 *
 * Two invariants live here and nowhere else: a turn never commits, and an automated turn — one the
 * person did not type — gets neither a shell nor the network. Both were single lines inside a
 * request literal in the turn loop, reachable only by running a turn, and both are the kind of
 * thing a refactor silently loosens.
 */
export const turnWorkspacePolicy = (input: {
  readOnly: boolean;
  writeScope?: WorkspaceWriteScope | undefined;
  readPaths?: readonly string[] | undefined;
  allowedPaths: readonly string[];
  protectedPaths?: readonly string[] | undefined;
  automated: boolean;
}): NonNullable<SendRequest["workspacePolicy"]> => ({
  readOnly: input.readOnly,
  writeScope: input.writeScope,
  ...(input.readPaths ? { readPaths: [...input.readPaths] } : {}),
  allowedPaths: [...input.allowedPaths],
  ...(input.protectedPaths ? { restrictedPaths: [...input.protectedPaths] } : {}),
  commitMode: "never",
  disableShell: input.automated,
  disableNetwork: input.automated,
  automated: input.automated,
});

export type TurnStreamState = {
  streamedBytes: number;
  result?: AgentRunResult | undefined;
  capturedResponse?: CapturedResponse | undefined;
};

export const emptyTurnStream = (): TurnStreamState => ({ streamedBytes: 0 });

/**
 * What the boundary must do with one event. `overflow` and `failure` end the turn by throwing;
 * every other action is delivery the composition root owns.
 */
export type TurnStreamAction =
  | { kind: "ignore" }
  | { kind: "session"; sessionId: string }
  | { kind: "append"; text: string }
  | { kind: "replace"; text: string }
  | { kind: "notice"; message: string }
  | { kind: "captured"; response: CapturedResponse }
  | { kind: "completed" }
  | { kind: "overflow"; message: string }
  | { kind: "failure"; message: string };

export const responseOverflowMessage = (agentId: string, maxStoredResponseBytes: number): string =>
  `${agentId} response exceeded ${String(maxStoredResponseBytes)} bytes`;

const textBytes = (text: string): number => Buffer.byteLength(text, "utf8");

export const turnStreamStep = (
  state: TurnStreamState,
  event: AgentEvent,
  limits: { agentId: string; maxStoredResponseBytes: number },
): { state: TurnStreamState; action: TurnStreamAction } => {
  const overflow = (streamedBytes: number): { state: TurnStreamState; action: TurnStreamAction } => ({
    state: { ...state, streamedBytes },
    action: {
      kind: "overflow",
      message: responseOverflowMessage(limits.agentId, limits.maxStoredResponseBytes),
    },
  });
  switch (event.type) {
    case "session":
      return { state, action: { kind: "session", sessionId: event.sessionId } };
    case "text": {
      const streamedBytes = state.streamedBytes + textBytes(event.text);
      if (streamedBytes > limits.maxStoredResponseBytes) return overflow(streamedBytes);
      return { state: { ...state, streamedBytes }, action: { kind: "append", text: event.text } };
    }
    case "replace": {
      const streamedBytes = textBytes(event.text);
      if (streamedBytes > limits.maxStoredResponseBytes) return overflow(streamedBytes);
      return { state: { ...state, streamedBytes }, action: { kind: "replace", text: event.text } };
    }
    case "status":
      return { state, action: { kind: "ignore" } };
    // BB-A4-N05. A notice is said and the turn goes on. It is not a completion and not a failure,
    // so the one terminal outcome this turn still owes the reader is unchanged.
    case "notice":
      return { state, action: { kind: "notice", message: event.message } };
    case "captured":
      return {
        state: { ...state, capturedResponse: event.response },
        action: { kind: "captured", response: event.response },
      };
    case "error":
      return { state, action: { kind: "failure", message: event.message } };
    default:
      return {
        state: { ...state, result: { status: event.status, answer: event.answer } },
        action: { kind: "completed" },
      };
  }
};

/**
 * The binding a captured response implies, for a browser agent only. A local adapter that somehow
 * captured a response binds nothing: the conversation it names is not one this runtime can rejoin.
 * A preferred tab already chosen by the person is carried through rather than re-derived.
 */
export const capturedBrowserBinding = (input: {
  adapterType: string;
  response: CapturedResponse;
  preferredTabId?: number | undefined;
}): BrowserConversationBinding | undefined =>
  input.adapterType.endsWith("-browser")
    ? {
        provider: input.response.provider,
        conversationUrl: input.response.finalConversationUrl,
        conversationIdentity: input.response.finalConversationIdentity,
        ...(input.preferredTabId === undefined ? {} : { preferredTabId: input.preferredTabId }),
      }
    : undefined;

/** The ledger payload a captured response carries. Assets are sanitised; nothing else travels. */
export const capturedResponseTranscript = (response: CapturedResponse): JsonValue =>
  toJsonValue({
    requestId: response.requestId,
    provider: response.provider,
    sessionId: response.sessionId,
    finalSessionId: response.finalSessionId,
    segments: response.segments,
    assets: response.assets.map(sanitizedCapturedAsset),
    startedAt: response.startedAt,
    completedAt: response.completedAt,
  });

export type TurnStreamOutcome =
  | { failure: string; entry?: undefined }
  | {
      failure?: undefined;
      entry: {
        kind: "answer" | "interrupted";
        answer: string;
        eventType?: string | undefined;
        payload?: JsonValue | undefined;
      };
      result: AgentRunResult;
      capturedResponse?: CapturedResponse | undefined;
    };

/**
 * What the turn owes once the stream is exhausted. A stream that never completed is a failure
 * rather than an empty answer, and a final answer over the ceiling is refused even when nothing
 * streamed crossed it — a `replace` resets the running count, so the last answer is measured on
 * its own.
 */
export const turnStreamOutcome = (
  state: TurnStreamState,
  limits: { agentId: string; maxStoredResponseBytes: number },
): TurnStreamOutcome => {
  const result = state.result;
  if (!result) return { failure: `${limits.agentId} stream ended without a completion event` };
  if (textBytes(result.answer) > limits.maxStoredResponseBytes) {
    return { failure: responseOverflowMessage(limits.agentId, limits.maxStoredResponseBytes) };
  }
  const captured = state.capturedResponse;
  return {
    result,
    ...(captured === undefined ? {} : { capturedResponse: captured }),
    entry: {
      kind: result.status === "interrupted" ? "interrupted" : "answer",
      answer: result.answer,
      ...(captured === undefined
        ? {}
        : { eventType: "browser.response", payload: capturedResponseTranscript(captured) }),
    },
  };
};

/**
 * Which of the deadlines it was handed a turn has already crossed.
 *
 * The caller says which deadlines are in scope at that point, because they are not all in scope
 * everywhere: the check between the prompt entry and the request weighs only the browser
 * operation, and the checks after the stream weigh both but abort nothing. Order is the caller's
 * too — the first breach in the list is the one reported.
 */
export type TurnDeadline = {
  kind: "managed" | "browserOperation";
  at?: number | undefined;
  expired: boolean;
};

export const turnDeadlineMessages: Record<TurnDeadline["kind"], string> = {
  managed: "Managed task deadline expired",
  browserOperation: "Browser operation deadline expired",
};

export const turnDeadlineBreach = (
  deadlines: readonly TurnDeadline[],
  now: number,
): { kind: TurnDeadline["kind"]; message: string } | undefined => {
  const breached = deadlines.find(
    (deadline) => deadline.at !== undefined && (deadline.expired || now >= deadline.at),
  );
  return breached === undefined
    ? undefined
    : { kind: breached.kind, message: turnDeadlineMessages[breached.kind] };
};
