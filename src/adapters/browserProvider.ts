import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { BrowserBridgeServer } from "../browser/bridgeServer";
import {
  BrowserAttachment,
  BrowserProvider,
  CapturedResponse,
} from "../browser/protocol";
import { createAsyncQueue } from "../process/asyncQueue";
import { AgentAdapter, AgentEvent, SendRequest } from "./types";

export type BrowserProviderAdapterOptions = {
  id: string;
  ownerId?: string;
  provider: BrowserProvider;
  bridge: BrowserBridgeServer;
  turnTimeoutMs: number;
  supportsAttachments?: boolean;
};

const mimeTypes = new Map<string, BrowserAttachment["mimeType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

export const isSupportedBrowserAttachmentPath = (filePath: string): boolean =>
  mimeTypes.has(path.extname(filePath).toLowerCase());

const providerName = (provider: BrowserProvider): string =>
  provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "Generic";

const attachmentFor = async (filePath: string): Promise<BrowserAttachment> => {
  const mimeType = mimeTypes.get(path.extname(filePath).toLowerCase());
  if (!mimeType) {
    throw new Error(`Unsupported browser attachment type: ${path.extname(filePath)}`);
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error(`Browser attachment is invalid: ${path.basename(filePath)}`);
  }
  const data = await readFile(filePath);
  if (data.length !== fileStat.size) {
    throw new Error(`Browser attachment changed while it was being read: ${path.basename(filePath)}`);
  }
  return {
    name: path.basename(filePath),
    mimeType,
    size: data.length,
    dataBase64: data.toString("base64"),
  };
};

export const createBrowserProviderAdapter = (
  options: BrowserProviderAdapterOptions,
): AgentAdapter => {
  let activeController: AbortController | undefined;
  const ownerId = options.ownerId || options.id;

  const resolveSession = (
    sessionId?: string,
    binding = undefined as SendRequest["browserBinding"],
  ) => {
    let session = options.bridge.resolveBoundSession(ownerId, binding, sessionId);
    const status = options.bridge.getStatus();
    const ready = status.sessions.filter(
      (candidate) =>
        candidate.provider === options.provider && candidate.status === "ready",
    );
    const onlyReady = ready.length === 1 ? ready[0] : undefined;
    if (!session && !binding && !sessionId && onlyReady) {
      options.bridge.bindSession(ownerId, onlyReady.id);
      session = onlyReady;
    }
    if (!session || session.provider !== options.provider) {
      throw new Error(
        binding
          ? `${providerName(options.provider)} browser conversation is not currently available`
          : ready.length > 1
            ? `Select a ${providerName(options.provider)} browser conversation for this agent`
            : `No ${providerName(options.provider)} browser conversation is available`,
      );
    }
    if (session.status !== "ready") {
      throw new Error(
        `${providerName(options.provider)} browser conversation is ${session.status}`,
      );
    }
    return session;
  };

  const send = (
    request: SendRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> => {
    const queue = createAsyncQueue<AgentEvent>();
    if (activeController) {
      queue.fail(new Error(`${providerName(options.provider)} Browser is already running`));
      return queue.iterable;
    }
    if (signal.aborted) {
      queue.fail(new Error(`${providerName(options.provider)} Browser request was interrupted before it started`));
      return queue.iterable;
    }

    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const deadlineAt = Date.now() + options.turnTimeoutMs;
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, deadlineAt - Date.now()));

    const execute = async (): Promise<void> => {
      try {
        queue.push({ type: "status", value: "starting" });
        if (controller.signal.aborted) throw new Error(`${providerName(options.provider)} Browser request was interrupted before it started`);
        const session = resolveSession(request.sessionId, request.browserBinding);
        if (options.supportsAttachments === false && request.attachments.length > 0) {
          throw new Error(`${providerName(options.provider)} browser does not support image attachments`);
        }
        const attachments = await Promise.all(request.attachments.map(attachmentFor));
        if (controller.signal.aborted) throw new Error(`${providerName(options.provider)} Browser request was interrupted before submission`);
        let answer = "";
        let interrupted = false;
        let captured: CapturedResponse | undefined;
        for await (const event of options.bridge.sendConversation(
          options.id,
          request.prompt,
          session.id,
          controller.signal,
          attachments,
          deadlineAt,
        )) {
          if (event.type === "session") {
            queue.push({ type: "session", sessionId: event.sessionId });
            continue;
          }
          if (event.type === "submitted") {
            queue.push({ type: "status", value: "running" });
            continue;
          }
          if (event.type === "text") {
            if (event.mode === "replace") {
              answer = event.text;
              queue.push({ type: "replace", text: event.text });
            } else {
              answer += event.text;
              queue.push({ type: "text", text: event.text });
            }
            continue;
          }
          if (event.type === "interrupted") {
            interrupted = true;
            continue;
          }
          // BB-A4-N05. The Stop did not take and the turn is still running. Said as a notice, not
          // as a failure: the request still ends in exactly one terminal outcome, and nothing is
          // resent.
          if (event.type === "interruptFailed") {
            queue.push({
              type: "notice",
              message: `${providerName(options.provider)} Browser could not stop this turn: ${event.message}. It is still running; stopping it again is safe.`,
            });
            continue;
          }
          if (event.type === "response") {
            captured = event.response;
            const final = captured.text;
            if (final !== answer) {
              answer = final;
              queue.push({ type: "replace", text: final });
            }
            if (captured.finalSessionId !== session.id) {
              queue.push({ type: "session", sessionId: captured.finalSessionId });
            }
            queue.push({ type: "captured", response: captured });
          }
        }
        if (timedOut) {
          throw new Error(
            `${providerName(options.provider)} Browser turn timed out after ${String(options.turnTimeoutMs)} ms`,
          );
        }
        if (!interrupted && !captured) {
          throw new Error(`${providerName(options.provider)} Browser returned no captured response`);
        }
        queue.push({
          type: "complete",
          status:
            interrupted || controller.signal.aborted
              ? "interrupted"
              : "completed",
          answer,
        });
        queue.end();
      } catch (error) {
        queue.fail(
          timedOut
            ? new Error(
                `${providerName(options.provider)} Browser turn timed out after ${String(options.turnTimeoutMs)} ms`,
                { cause: error },
              )
            : error,
        );
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (activeController === controller) {
          activeController = undefined;
        }
      }
    };

    void execute();
    return queue.iterable;
  };

  return {
    id: options.id,
    adapterType: `${options.provider}-browser`,
    capabilities: {
      streaming: true,
      resume: true,
      interrupt: options.provider !== "generic",
      attachments: options.supportsAttachments !== false,
      repositoryTools: true,
      browserSessionSelection: true,
      passiveActionLoop: options.provider !== "generic",
    },
    checkAvailability: async (sessionId, browserBinding) => {
      const status = options.bridge.getStatus();
      if (!status.enabled) {
        throw new Error("Browser Bridge is disabled in remote VS Code workspaces");
      }
      if (!status.connected) {
        throw new Error("Browser Bridge is not paired");
      }
      const session = resolveSession(sessionId, browserBinding);
      return `${providerName(options.provider)} browser tab ${String(session.tabId)}${session.title ? ` · ${session.title}` : ""}`;
    },
    send,
    interrupt: async () => {
      activeController?.abort();
    },
    dispose: async () => {
      activeController?.abort();
      activeController = undefined;
      options.bridge.releaseBinding(ownerId);
    },
  };
};
