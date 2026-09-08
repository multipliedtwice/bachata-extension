import { isRuntimeOperation } from "../webview/protocol";
import type { WebviewToExtensionMessage } from "../webview/protocol";

/**
 * EX-3. Where a webview message goes, and what its sender is still owed, decided as a value.
 *
 * The runtime's dispatcher was one chain of thirty type comparisons with a fall-through at the
 * bottom: adding a message meant adding a branch in the middle of an unrelated one, and the three
 * cross-cutting rules — which messages may not run while the host refuses writes, which must be
 * serialised behind the mutation queue, and which leave an editor request open until an
 * `operation.result` answers it — were three lines scattered through it. They are decided here,
 * over the message type alone.
 *
 * The domain table is exhaustive by construction: the assignment below does not compile if a
 * message type is missing from it or listed under a domain it does not belong to.
 */
export type WebviewMessageDomain =
  | "session"
  | "conversation"
  | "run"
  | "catalog"
  | "browser"
  | "transcript"
  | "queue"
  | "attachment"
  | "approval";

export type WebviewMessageType = WebviewToExtensionMessage["type"];

/**
 * Every message the protocol accepts, under the one part of the runtime that answers it. A
 * `Record` over the whole union, so a message type added to the protocol and forgotten here does
 * not compile, and a type listed here that the protocol dropped does not either.
 */
export const WEBVIEW_MESSAGE_DOMAIN: Readonly<Record<WebviewMessageType, WebviewMessageDomain>> = {
  ready: "session",
  "availability.check": "session",
  "contract.acknowledge": "session",
  "session.reset": "session",
  "task.reset": "session",
  "workingDirectory.pick": "session",
  "message.send": "conversation",
  "pipeline.run": "run",
  "run.interrupt": "run",
  "run.gate": "run",
  "workflow.resume": "run",
  "workflow.discard": "run",
  "pipeline.select": "catalog",
  "pipeline.validate": "catalog",
  "pipeline.save": "catalog",
  "pipeline.delete": "catalog",
  "pipeline.import": "catalog",
  "pipeline.fork": "catalog",
  "pipeline.export": "catalog",
  "browser.session.select": "browser",
  "browser.asset.save": "browser",
  "browser.asset.reveal": "browser",
  "bridge.reset": "browser",
  "bridge.discover": "browser",
  "transcript.export": "transcript",
  "transcript.loadOlder": "transcript",
  "queue.cancel": "queue",
  "queue.resume": "queue",
  "attachment.add": "attachment",
  "attachment.remove": "attachment",
  "approval.respond": "approval",
};

const domainByType = new Map<string, WebviewMessageDomain>(
  Object.entries(WEBVIEW_MESSAGE_DOMAIN),
);

export const webviewMessageDomain = (type: string): WebviewMessageDomain | undefined =>
  domainByType.get(type);

/**
 * Messages that run one at a time behind the mutation queue. Everything that reads state, answers
 * a waiting agent, or ends a run stays outside it: a queued interrupt cannot stop the run that is
 * holding the queue.
 */
export const SERIALIZED_WEBVIEW_MESSAGE_TYPES: readonly WebviewMessageType[] = [
  "availability.check",
  "pipeline.select",
  "pipeline.validate",
  "pipeline.save",
  "pipeline.delete",
  "pipeline.import",
  "pipeline.fork",
  "pipeline.export",
  "browser.session.select",
  "browser.asset.save",
  "browser.asset.reveal",
  "transcript.export",
  "workingDirectory.pick",
  "session.reset",
  "task.reset",
  "bridge.reset",
  "bridge.discover",
  "approval.respond",
  "queue.cancel",
  "queue.resume",
  "workflow.discard",
  "attachment.add",
  "attachment.remove",
];

const serializedTypes = new Set<string>(SERIALIZED_WEBVIEW_MESSAGE_TYPES);

/**
 * Whether the host must be writable for this message. `ready` is the one exception: a panel that
 * has just loaded is asking what the state is, and refusing that would leave a read-only host with
 * a blank panel rather than a read-only one.
 */
export const requiresWritableHost = (type: string): boolean => type !== "ready";

export type WebviewDispatchPlan = {
  messageType?: string | undefined;
  requestId?: string | undefined;
  serialize: boolean;
  settlesOnFailure: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * What the dispatcher must do with a raw message before it is even known to be valid.
 *
 * EX-G6-17. The editor holds a request open until an `operation.result` comes back with its id, so
 * the plan is read off the raw value: a message that fails to parse still carries the id the
 * editor is waiting on, and answering it is the difference between a reported error and a request
 * that hangs for the life of the panel.
 */
export const webviewDispatchPlan = (raw: unknown): WebviewDispatchPlan => {
  const messageType = isRecord(raw) && typeof raw.type === "string" ? raw.type : undefined;
  const requestId =
    isRecord(raw) && typeof raw.requestId === "string" && raw.requestId ? raw.requestId : undefined;
  return {
    ...(messageType === undefined ? {} : { messageType }),
    ...(requestId === undefined ? {} : { requestId }),
    serialize: messageType !== undefined && serializedTypes.has(messageType),
    settlesOnFailure: requestId !== undefined && isRuntimeOperation(messageType),
  };
};

/** The message no branch claimed. Unreachable once the parser has accepted the value. */
export const unsupportedWebviewMessage = (message: never): Error =>
  new Error(`Unsupported webview message: ${JSON.stringify(message)}`);
