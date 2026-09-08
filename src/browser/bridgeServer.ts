import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { createAsyncQueue } from "../process/asyncQueue";
import { DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES } from "./limits";
import { redactText } from "../security/redact";
import {
  BridgeClientMessage,
  BridgeServerMessage,
  BrowserAttachment,
  BrowserConversationBinding,
  BrowserLocalModelConfig,
  BrowserProvider,
  BrowserSession,
  CapturedResponse,
  browserProtocolVersion,
  parseBridgeClientMessage,
} from "./protocol";
import {
  createTextWebSocketServer,
  TextSocket,
  TextWebSocketServer,
} from "./webSocketServer";

export type BrowserBridgeSecretStore = {
  get: (key: string) => PromiseLike<string | undefined>;
  store: (key: string, value: string) => PromiseLike<void>;
  delete: (key: string) => PromiseLike<void>;
};

export type BrowserBridgeStatus = {
  enabled: boolean;
  endpoint?: string;
  pairingToken?: string;
  pairingExpiresAt?: string;
  connected: boolean;
  selectedSessionId?: string;
  sessions: BrowserSession[];
  error?: string;
};

export type BrowserConversationEvent =
  | { type: "session"; sessionId: string }
  | { type: "submitted" }
  | { type: "text"; mode: "append" | "replace"; text: string }
  | { type: "response"; response: CapturedResponse }
  | { type: "interrupted" }
  /**
   * BB-A4-N05. The Stop did not take and the turn is still running. Nonterminal: the operation
   * stays open and still ends in exactly one of `response`, `interrupted` or a failure.
   */
  | { type: "interruptFailed"; message: string };

export type BrowserAssetTransferEvent =
  | {
      type: "start";
      assetId: string;
      name: string;
      mimeType?: string;
      size?: number;
    }
  | {
      type: "chunk";
      assetId: string;
      sequence: number;
      data: Buffer;
    }
  | {
      type: "complete";
      assetId: string;
      size: number;
      sha256: string;
    };

export type BrowserBridgeServer = {
  start: () => Promise<void>;
  getStatus: () => BrowserBridgeStatus;
  subscribeStatus: (
    listener: (status: BrowserBridgeStatus) => void,
  ) => { dispose: () => void };
  resetPairing: () => Promise<void>;
  discover: () => void;
  refreshLocalModelConfig: () => void;
  openConversation: (
    provider: BrowserProvider,
    signal?: AbortSignal,
    preferredBinding?: BrowserConversationBinding,
    fresh?: boolean,
  ) => Promise<BrowserSession>;
  bindSession: (ownerId: string, sessionId: string) => BrowserConversationBinding;
  bindConversation: (ownerId: string, binding: BrowserConversationBinding) => void;
  releaseBinding: (ownerId: string) => void;
  resolveBoundSession: (
    ownerId: string,
    binding: BrowserConversationBinding | undefined,
    expectedSessionId?: string,
  ) => BrowserSession | undefined;
  sendConversation: (
    agentId: string,
    text: string,
    expectedSessionId: string | undefined,
    signal: AbortSignal,
    attachments?: BrowserAttachment[],
    deadlineAt?: number,
  ) => AsyncIterable<BrowserConversationEvent>;
  fetchAsset: (
    assetId: string,
    maxBytes: number,
    signal: AbortSignal,
  ) => AsyncIterable<BrowserAssetTransferEvent>;
  revealAsset: (assetId: string) => Promise<void>;
  interrupt: (requestId?: string) => Promise<void>;
  close: () => Promise<void>;
};

export type BrowserBridgeServerOptions = {
  enabled: boolean;
  secretStore: BrowserBridgeSecretStore;
  log: (message: string) => void;
  onStatusChange: (status: BrowserBridgeStatus) => void;
  pairingTtlMs?: number | undefined;
  maxMessageBytes?: number | undefined;
  preAuthenticationMaxMessageBytes?: number | undefined;
  interruptTimeoutMs?: number | undefined;
  authenticationTimeoutMs?: number | undefined;
  maxConnections?: number | undefined;
  maxMessagesPerSecond?: number | undefined;
  maxQueuedMessages?: number | undefined;
  maxQueuedBytes?: number | undefined;
  assetTransferTimeoutMs?: number | undefined;
  assetRevealTimeoutMs?: number | undefined;
  providerOpenTimeoutMs?: number | undefined;
  port?: number | undefined;
  originOverrideForTests?: string | undefined;
  localModelConfig?: (() => BrowserLocalModelConfig) | undefined;
};

type PendingConversation = {
  requestId: string;
  agentId: string;
  session: BrowserSession;
  queue: ReturnType<typeof createAsyncQueue<BrowserConversationEvent>>;
  signal: AbortSignal;
  abortListener: () => void;
  interruptTimer?: NodeJS.Timeout;
  interruptRequested: boolean;
  allowSessionTransition: boolean;
  boundSessionIds: Set<string>;
  transitionSession?: BrowserSession;
};

type PendingAssetReveal = {
  requestId: string;
  assetId: string;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
};

type PendingProviderOpen = {
  requestId: string;
  provider: BrowserProvider;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (session: BrowserSession) => void;
  reject: (error: Error) => void;
};

type PendingAssetTransfer = {
  transferId: string;
  assetId: string;
  maxBytes: number;
  signal: AbortSignal;
  abortListener: () => void;
  timer: NodeJS.Timeout;
  queue: ReturnType<typeof createAsyncQueue<BrowserAssetTransferEvent>>;
  name?: string | undefined;
  mimeType?: string | undefined;
  declaredSize?: number | undefined;
  started: boolean;
  nextSequence: number;
  receivedBytes: number;
  hash: ReturnType<typeof createHash>;
};

const connectionSecretKey = "bachata.browserBridge.connectionToken.v8";
const connectionOriginSecretKey = "bachata.browserBridge.extensionOrigin.v8";
// PAIR-ID-01. Both spellings, newest version first. A released build stored its connection token
// under `pair.browserBridge.connectionToken.v7`, so a list carrying only the current spelling
// migrates nothing and then deletes nothing — the old secret would sit in the store for ever while
// the user is asked to pair again. Correct whichever name PAIR-ID-01 settles on.
const legacyConnectionSecretKeys = [7, 6, 5, 4].flatMap((version) => [
  `bachata.browserBridge.connectionToken.v${String(version)}`,
  `pair.browserBridge.connectionToken.v${String(version)}`,
]);
const endpointPath = "/bachata-browser-bridge-v9";
const extensionOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/u;

const secureToken = (): string => randomBytes(32).toString("base64url");

// Token comparison is length-checked first, then constant-time. `!==` short-circuits on the
// first differing character, and while a loopback WebSocket is a poor oracle, every other
// control on this server is written to the stricter standard.
const secretMatches = (candidate: unknown, expected: string | undefined): boolean => {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};


const isLoopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

export const createBrowserBridgeServer = (
  options: BrowserBridgeServerOptions,
): BrowserBridgeServer => {
  const log = (message: string): void => options.log(redactText(message));
  const pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES;
  const preAuthenticationMaxMessageBytes = Math.min(
    maxMessageBytes,
    options.preAuthenticationMaxMessageBytes ?? 65_536,
  );
  const interruptTimeoutMs = options.interruptTimeoutMs ?? 10_000;
  const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 10_000;
  const maxConnections = options.maxConnections ?? 4;
  const maxMessagesPerSecond = options.maxMessagesPerSecond ?? 120;
  const maxQueuedMessages = options.maxQueuedMessages ?? 32;
  const maxQueuedBytes = options.maxQueuedBytes ?? maxMessageBytes * 2;
  const assetTransferTimeoutMs = options.assetTransferTimeoutMs ?? 5 * 60_000;
  const assetRevealTimeoutMs = options.assetRevealTimeoutMs ?? 10_000;
  const providerOpenTimeoutMs = options.providerOpenTimeoutMs ?? 60_000;
  let server: TextWebSocketServer | undefined;
  let port: number | undefined;
  let pairingToken: string | undefined;
  let pairingExpiresAt = 0;
  let pairingExpirationTimer: NodeJS.Timeout | undefined;
  let connectionToken: string | undefined;
  let connectionOrigin: string | undefined;
  let socket: TextSocket | undefined;
  let authenticated = false;
  let sessions: BrowserSession[] = [];
  let selectedSessionId: string | undefined;
  let lastError: string | undefined;
  const pending = new Map<string, PendingConversation>();
  const pendingBySession = new Map<string, string>();
  const pendingAssetTransfers = new Map<string, PendingAssetTransfer>();
  const pendingAssetReveals = new Map<string, PendingAssetReveal>();
  const pendingProviderOpens = new Map<string, PendingProviderOpen>();
  const bindingOwnerByConversation = new Map<string, string>();
  const conversationByBindingOwner = new Map<string, string>();
  const authenticationTimers = new Map<TextSocket, NodeJS.Timeout>();
  const configuredOriginOverride = options.originOverrideForTests;
  if (configuredOriginOverride !== undefined && !extensionOriginPattern.test(configuredOriginOverride)) {
    throw new Error("Invalid Browser Bridge origin override");
  }
  const originForConnection = (connection: TextSocket): string | undefined =>
    connection.origin ?? configuredOriginOverride;
  const restoreCredentials = async (
    token: string | undefined,
    origin: string | undefined,
  ): Promise<void> => {
    if (token) {
      await options.secretStore.store(connectionSecretKey, token);
    } else {
      await options.secretStore.delete(connectionSecretKey);
    }
    if (origin) {
      await options.secretStore.store(connectionOriginSecretKey, origin);
    } else {
      await options.secretStore.delete(connectionOriginSecretKey);
    }
  };
  const preAuthenticationMessages = new Map<TextSocket, number>();
  const messageRates = new Map<
    TextSocket,
    { windowStartedAt: number; count: number }
  >();
  const messageQueues = new Map<TextSocket, Promise<void>>();
  const queuedMessageCounts = new Map<TextSocket, number>();
  const queuedMessageBytes = new Map<TextSocket, number>();
  const liveConnections = new Set<TextSocket>();
  let authenticationGeneration = 0;
  let authenticationOperationCount = 0;
  let authenticationQueue = Promise.resolve();
  let closing = false;
  let closeOperation: Promise<void> | undefined;
  const statusListeners = new Set<(status: BrowserBridgeStatus) => void>([
    options.onStatusChange,
  ]);

  const enqueueAuthentication = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    authenticationOperationCount += 1;
    const guarded = async (): Promise<T> => {
      try {
        return await operation();
      } finally {
        authenticationOperationCount -= 1;
      }
    };
    const next = authenticationQueue.then(guarded, guarded);
    authenticationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const status = (): BrowserBridgeStatus => {
    if (pairingToken && Date.now() > pairingExpiresAt) {
      pairingToken = undefined;
      pairingExpiresAt = 0;
    }
    // A pairing token is only meaningful while there is an endpoint to present it to. A
    // browser cannot pair against a server that never started or has been closed, so no
    // token is published without one.
    if (!endpointAvailable()) {
      clearPairingExpirationTimer();
      pairingToken = undefined;
      pairingExpiresAt = 0;
    }
    return {
      enabled: options.enabled,
      ...(port ? { endpoint: `ws://127.0.0.1:${String(port)}${endpointPath}` } : {}),
      ...(pairingToken === undefined ? {} : { pairingToken }),
      ...(pairingExpiresAt > 0
        ? { pairingExpiresAt: new Date(pairingExpiresAt).toISOString() }
        : {}),
      connected: authenticated && Boolean(socket),
      ...(selectedSessionId === undefined ? {} : { selectedSessionId }),
      sessions: structuredClone(sessions),
      ...(lastError === undefined ? {} : { error: lastError }),
    };
  };

  const sendLocalModelConfig = (connection: TextSocket): void => {
    const config = options.localModelConfig?.();
    if (!config) return;
    connection.send(JSON.stringify({
      type: "localModel.config",
      protocolVersion: browserProtocolVersion,
      ...config,
    } satisfies BridgeServerMessage));
  };

  const conversationClaimKey = (
    binding: Pick<BrowserConversationBinding, "provider" | "conversationIdentity" | "preferredTabId">,
  ): string => binding.provider === "generic" && binding.preferredTabId !== undefined
    ? `${binding.provider}:tab:${String(binding.preferredTabId)}:${binding.conversationIdentity}`
    : `${binding.provider}:${binding.conversationIdentity}`;

  const bindConversation = (
    ownerId: string,
    binding: BrowserConversationBinding,
  ): void => {
    const key = conversationClaimKey(binding);
    const existingOwner = bindingOwnerByConversation.get(key);
    if (existingOwner && existingOwner !== ownerId) {
      throw new Error("The browser conversation is already bound to another pair participant");
    }
    const previousKey = conversationByBindingOwner.get(ownerId);
    if (previousKey && previousKey !== key && bindingOwnerByConversation.get(previousKey) === ownerId) {
      bindingOwnerByConversation.delete(previousKey);
    }
    bindingOwnerByConversation.set(key, ownerId);
    conversationByBindingOwner.set(ownerId, key);
  };

  const releaseBinding = (ownerId: string): void => {
    const key = conversationByBindingOwner.get(ownerId);
    conversationByBindingOwner.delete(ownerId);
    if (key && bindingOwnerByConversation.get(key) === ownerId) {
      bindingOwnerByConversation.delete(key);
    }
  };

  const bindingForSession = (session: BrowserSession): BrowserConversationBinding => ({
    provider: session.provider,
    conversationUrl: session.conversationUrl,
    conversationIdentity: session.conversationIdentity,
    preferredTabId: session.tabId,
  });

  const resolveBoundSession = (
    ownerId: string,
    binding: BrowserConversationBinding | undefined,
    expectedSessionId?: string,
  ): BrowserSession | undefined => {
    const exact = expectedSessionId
      ? sessions.find((session) => session.id === expectedSessionId)
      : undefined;
    if (exact) {
      const exactBinding = bindingForSession(exact);
      if (binding && (binding.provider !== exactBinding.provider || binding.conversationIdentity !== exactBinding.conversationIdentity)) {
        throw new Error("The browser session does not match its persisted conversation binding");
      }
      bindConversation(ownerId, binding ?? exactBinding);
      return structuredClone(exact);
    }
    if (!binding) {
      return undefined;
    }
    bindConversation(ownerId, binding);
    if (binding.provider === "generic") {
      return undefined;
    }
    const candidates = sessions.filter(
      (session) =>
        session.provider === binding.provider &&
        session.conversationIdentity === binding.conversationIdentity,
    );
    const preferred = binding.preferredTabId === undefined
      ? undefined
      : candidates.find((session) => session.tabId === binding.preferredTabId);
    if (preferred) {
      return structuredClone(preferred);
    }
    return candidates.length === 1 ? structuredClone(candidates[0]) : undefined;
  };

  const emitStatus = (): void => {
    const next = status();
    statusListeners.forEach((listener) => {
      try {
        listener(next);
      } catch (error) {
        log(
          `Browser bridge status listener failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  const serializeMessage = (message: BridgeServerMessage): string => {
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, "utf8") > maxMessageBytes) {
      throw new Error("Browser bridge message exceeds the configured transport limit");
    }
    return serialized;
  };

  const send = (message: BridgeServerMessage): void => {
    if (!socket || !authenticated) {
      throw new Error("Browser bridge is not connected");
    }
    socket.send(serializeMessage(message));
  };

  const removePending = (
    requestId: string,
  ): PendingConversation | undefined => {
    const operation = pending.get(requestId);
    if (!operation) {
      return undefined;
    }
    operation.signal.removeEventListener("abort", operation.abortListener);
    if (operation.interruptTimer) {
      clearTimeout(operation.interruptTimer);
    }
    pending.delete(requestId);
    for (const sessionId of operation.boundSessionIds) {
      if (pendingBySession.get(sessionId) === requestId) pendingBySession.delete(sessionId);
    }
    return operation;
  };

  const rejectPending = (error: Error): void => {
    Array.from(pending.keys()).forEach((requestId) => {
      removePending(requestId)?.queue.fail(error);
    });
  };

  const removePendingAssetTransfer = (
    transferId: string,
  ): PendingAssetTransfer | undefined => {
    const transfer = pendingAssetTransfers.get(transferId);
    if (!transfer) {
      return undefined;
    }
    pendingAssetTransfers.delete(transferId);
    clearTimeout(transfer.timer);
    transfer.signal.removeEventListener("abort", transfer.abortListener);
    return transfer;
  };

  const rejectPendingAssetTransfers = (error: Error): void => {
    Array.from(pendingAssetTransfers.keys()).forEach((transferId) => {
      removePendingAssetTransfer(transferId)?.queue.fail(error);
    });
  };

  const removePendingAssetReveal = (
    requestId: string,
  ): PendingAssetReveal | undefined => {
    const request = pendingAssetReveals.get(requestId);
    if (!request) {
      return undefined;
    }
    pendingAssetReveals.delete(requestId);
    clearTimeout(request.timer);
    return request;
  };

  const rejectPendingAssetReveals = (error: Error): void => {
    Array.from(pendingAssetReveals.keys()).forEach((requestId) => {
      removePendingAssetReveal(requestId)?.reject(error);
    });
  };

  const removePendingProviderOpen = (
    requestId: string,
  ): PendingProviderOpen | undefined => {
    const request = pendingProviderOpens.get(requestId);
    if (!request) {
      return undefined;
    }
    pendingProviderOpens.delete(requestId);
    clearTimeout(request.timer);
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
    return request;
  };

  const rejectPendingProviderOpens = (error: Error): void => {
    Array.from(pendingProviderOpens.keys()).forEach((requestId) => {
      removePendingProviderOpen(requestId)?.reject(error);
    });
  };

  const decodeAssetChunk = (value: string): Buffer | undefined => {
    if (
      !value ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
    ) {
      return undefined;
    }
    try {
      const data = Buffer.from(value, "base64");
      return data.toString("base64") === value ? data : undefined;
    } catch {
      return undefined;
    }
  };

  const endpointAvailable = (): boolean => Boolean(server) && port !== undefined;

  const clearPairingExpirationTimer = (): void => {
    if (pairingExpirationTimer) {
      clearTimeout(pairingExpirationTimer);
      pairingExpirationTimer = undefined;
    }
  };

  const setPairingToken = (token: string, expiresAt: number): void => {
    clearPairingExpirationTimer();
    pairingToken = token;
    pairingExpiresAt = expiresAt;
    const remainingMs = Math.max(0, expiresAt - Date.now());
    pairingExpirationTimer = setTimeout(() => {
      pairingExpirationTimer = undefined;
      if (pairingToken === token) {
        pairingToken = undefined;
        pairingExpiresAt = 0;
        emitStatus();
      }
    }, remainingMs);
  };

  const createPairingToken = (): void => {
    setPairingToken(secureToken(), Date.now() + pairingTtlMs);
  };

  const disconnect = (reason?: string): void => {
    authenticated = false;
    socket = undefined;
    sessions = [];
    selectedSessionId = undefined;
    if (reason) {
      lastError = reason;
    }
    const error = new Error(reason ?? "Browser bridge disconnected");
    rejectPending(error);
    rejectPendingAssetTransfers(error);
    rejectPendingAssetReveals(error);
    rejectPendingProviderOpens(error);
    emitStatus();
  };

  const matchesOperation = (
    operation: PendingConversation,
    message: {
      agentId: string;
      sessionId: string;
    },
  ): boolean =>
    operation.agentId === message.agentId &&
    operation.session.id === message.sessionId;

  const requestInterrupt = (operation: PendingConversation): void => {
    if (operation.interruptRequested) {
      return;
    }
    operation.interruptRequested = true;
    try {
      send({
        type: "conversation.interrupt",
        protocolVersion: browserProtocolVersion,
        requestId: operation.requestId,
        agentId: operation.agentId,
        provider: operation.session.provider,
        sessionId: operation.session.id,
        tabId: operation.session.tabId,
        frameId: operation.session.frameId,
        ...(operation.session.documentId === undefined
          ? {}
          : { documentId: operation.session.documentId }),
        documentToken: operation.session.documentToken,
        conversationUrl: operation.session.conversationUrl,
        conversationIdentity: operation.session.conversationIdentity,
      });
    } catch (error) {
      removePending(operation.requestId)?.queue.fail(error);
      return;
    }
    operation.interruptTimer = setTimeout(() => {
      removePending(operation.requestId)?.queue.fail(
        new Error("Browser interruption was not confirmed"),
      );
    }, interruptTimeoutMs);
  };

  const canonicalConversationUrl = (
    provider: BrowserProvider,
    value: string,
  ): string => {
    const url = new URL(value);
    if (provider === "chatgpt" && url.origin !== "https://chatgpt.com") {
      throw new Error("Invalid ChatGPT conversation URL");
    }
    if (provider === "claude" && url.origin !== "https://claude.ai") {
      throw new Error("Invalid Claude conversation URL");
    }
    if (provider === "generic" && url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Invalid generic browser conversation URL");
    }
    if (provider !== "generic") {
      url.hash = "";
      url.search = "";
    }
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  };

  const conversationIdentityFor = (
    provider: BrowserProvider,
    value: string,
  ): string => `${provider}:${canonicalConversationUrl(provider, value)}`;

  const sessionIdFor = (
    provider: BrowserProvider,
    tabId: number,
    documentToken: string,
    conversationIdentity: string,
  ): string =>
    `${provider}:${String(tabId)}:${documentToken}:${encodeURIComponent(conversationIdentity)}`;

  const supportedInitialTransition = (
    provider: BrowserProvider,
    previousUrl: string,
    nextUrl: string,
  ): boolean => {
    try {
      const previous = new URL(previousUrl);
      const next = new URL(nextUrl);
      if (next.origin !== previous.origin) {
        return false;
      }
      if (provider === "chatgpt") {
        return (
          previous.origin === "https://chatgpt.com" &&
          previous.pathname === "/" &&
          next.pathname.startsWith("/c/")
        );
      }
      if (provider === "claude") {
        return (
          previous.origin === "https://claude.ai" &&
          (previous.pathname === "/" || previous.pathname === "/new") &&
          (next.pathname.startsWith("/chat/") ||
            next.pathname.startsWith("/chats/"))
        );
      }
      return previous.origin === next.origin;
    } catch {
      return false;
    }
  };

  const isInitialConversationPage = (
    provider: BrowserProvider,
    value: string,
  ): boolean => {
    try {
      const url = new URL(value);
      if (provider === "chatgpt") {
        return url.origin === "https://chatgpt.com" && url.pathname === "/";
      }
      if (provider === "claude") {
        return url.origin === "https://claude.ai" &&
          (url.pathname === "/" || url.pathname === "/new");
      }
      return provider === "generic";
    } catch {
      return false;
    }
  };

  const validFinalResponseBinding = (
    operation: PendingConversation,
    response: CapturedResponse,
  ): boolean => {
    if (response.provider !== operation.session.provider) {
      return false;
    }
    try {
      const finalUrl = canonicalConversationUrl(
        operation.session.provider,
        response.finalConversationUrl,
      );
      const finalIdentity = conversationIdentityFor(
        operation.session.provider,
        finalUrl,
      );
      if (response.finalConversationIdentity !== finalIdentity) {
        return false;
      }
      const unchanged =
        finalUrl === operation.session.conversationUrl &&
        finalIdentity === operation.session.conversationIdentity;
      const supportedTransition = operation.allowSessionTransition && supportedInitialTransition(
        operation.session.provider,
        operation.session.conversationUrl,
        finalUrl,
      );
      if (!unchanged && !supportedTransition) return false;
      const expectedSessionId = sessionIdFor(
        operation.session.provider,
        operation.session.tabId,
        operation.session.documentToken,
        finalIdentity,
      );
      if (response.finalSessionId === expectedSessionId) return true;
      const finalSession = operation.transitionSession?.id === response.finalSessionId
        ? operation.transitionSession
        : sessions.find((session) => session.id === response.finalSessionId);
      return Boolean(
        supportedTransition
        && finalSession
        && finalSession.id === response.finalSessionId
        && finalSession.provider === operation.session.provider
        && finalSession.tabId === operation.session.tabId
        && finalSession.frameId === operation.session.frameId
        && canonicalConversationUrl(finalSession.provider, finalSession.conversationUrl) === finalUrl
        && finalSession.conversationIdentity === finalIdentity,
      );
    } catch {
      return false;
    }
  };

  const handleAuthenticatedMessage = (message: BridgeClientMessage): void => {
    if (message.type === "bridge.ping") {
      send({
        type: "bridge.pong",
        protocolVersion: browserProtocolVersion,
        nonce: message.nonce,
      });
      return;
    }

    if (message.type === "provider.openConversation.result") {
      const request = pendingProviderOpens.get(message.requestId);
      if (!request || request.provider !== message.provider) {
        return;
      }
      const completed = removePendingProviderOpen(message.requestId);
      if (!completed) {
        return;
      }
      if (!message.success || !message.session) {
        completed.reject(
          new Error(`${message.code ?? "OPEN_CONVERSATION_FAILED"}: ${message.message ?? "The provider conversation could not be opened"}`),
        );
        return;
      }
      sessions = [
        ...sessions.filter((session) => session.id !== message.session?.id),
        message.session,
      ].sort((left, right) => left.tabId - right.tabId);
      lastError = undefined;
      emitStatus();
      completed.resolve(structuredClone(message.session));
      return;
    }

    if (message.type === "provider.status") {
      sessions = message.sessions;
      selectedSessionId = message.selectedSessionId;
      Array.from(pending.values()).forEach((operation) => {
        const current = sessions.find(
          (session) =>
            session.id === operation.session.id &&
            session.tabId === operation.session.tabId &&
            session.frameId === operation.session.frameId &&
            session.documentId === operation.session.documentId &&
            session.documentToken === operation.session.documentToken &&
            session.conversationUrl === operation.session.conversationUrl &&
            session.conversationIdentity === operation.session.conversationIdentity,
        );
        if (current && current.status !== "failed" && current.status !== "disconnected") return;
        const transitioned = operation.allowSessionTransition
          ? sessions.find((session) => {
              if (session.provider !== operation.session.provider
                || session.tabId !== operation.session.tabId
                || session.frameId !== operation.session.frameId
                || session.status === "failed"
                || session.status === "disconnected") return false;
              try {
                return supportedInitialTransition(
                  operation.session.provider,
                  operation.session.conversationUrl,
                  session.conversationUrl,
                );
              } catch {
                return false;
              }
            })
          : undefined;
        if (transitioned) {
          const owner = pendingBySession.get(transitioned.id);
          if (owner && owner !== operation.requestId) {
            removePending(operation.requestId)?.queue.fail(
              new Error("The transitioned browser conversation already has an active request"),
            );
            return;
          }
          operation.transitionSession = structuredClone(transitioned);
          operation.boundSessionIds.add(transitioned.id);
          pendingBySession.set(transitioned.id, operation.requestId);
          return;
        }
        removePending(operation.requestId)?.queue.fail(
          new Error("The bound browser conversation changed during the active request"),
        );
      });
      lastError = undefined;
      emitStatus();
      return;
    }

    if (message.type === "conversation.submitted") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (!matchesOperation(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser submission does not match the active request"),
        );
        return;
      }
      operation.queue.push({ type: "submitted" });
      return;
    }

    if (message.type === "conversation.stream") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (!matchesOperation(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser stream does not match the active request"),
        );
        return;
      }
      operation.queue.push({
        type: "text",
        mode: message.mode,
        text: message.text,
      });
      return;
    }

    if (message.type === "conversation.response") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (!matchesOperation(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser response does not match the active request"),
        );
        return;
      }
      if (!validFinalResponseBinding(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser response final conversation binding is invalid"),
        );
        return;
      }
      if (message.finalSessionId !== operation.session.id) {
        operation.queue.push({
          type: "session",
          sessionId: message.finalSessionId,
        });
      }
      operation.queue.push({ type: "response", response: message });
      operation.queue.end();
      removePending(message.requestId);
      return;
    }

    if (message.type === "conversation.interrupted") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (!matchesOperation(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser interruption does not match the active request"),
        );
        return;
      }
      operation.queue.push({ type: "interrupted" });
      operation.queue.end();
      removePending(message.requestId);
      return;
    }

    if (message.type === "conversation.interruptFailed") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (!matchesOperation(operation, message)) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser interruption failure does not match the active request"),
        );
        return;
      }
      // BB-A4-N05. The Stop failed and the turn continues, so the operation is not ended here and
      // its interruption deadline is stood down: a request that is provably still running must
      // not be failed for an interruption that was answered. Asking again is allowed, because the
      // request the person wanted stopped is still live.
      if (operation.interruptTimer) {
        clearTimeout(operation.interruptTimer);
        delete operation.interruptTimer;
      }
      operation.interruptRequested = false;
      operation.queue.push({ type: "interruptFailed", message: message.message });
      return;
    }
    if (message.type === "conversation.error") {
      const operation = pending.get(message.requestId);
      if (!operation) {
        return;
      }
      if (
        (message.agentId && operation.agentId !== message.agentId) ||
        (message.sessionId && operation.session.id !== message.sessionId)
      ) {
        removePending(message.requestId)?.queue.fail(
          new Error("Browser error does not match the active request"),
        );
        return;
      }
      operation.queue.fail(
        new Error(`${message.code}: ${message.message}`),
      );
      removePending(message.requestId);
      return;
    }

    if (message.type === "asset.start") {
      const transfer = pendingAssetTransfers.get(message.transferId);
      if (!transfer) {
        return;
      }
      if (
        transfer.assetId !== message.assetId ||
        transfer.started ||
        (message.size !== undefined && message.size > transfer.maxBytes)
      ) {
        removePendingAssetTransfer(message.transferId)?.queue.fail(
          new Error("Browser asset transfer start is invalid"),
        );
        return;
      }
      transfer.started = true;
      transfer.name = message.name;
      transfer.mimeType = message.mimeType;
      transfer.declaredSize = message.size;
      transfer.queue.push({
        type: "start",
        assetId: message.assetId,
        name: message.name,
        ...(message.mimeType ? { mimeType: message.mimeType } : {}),
        ...(message.size !== undefined ? { size: message.size } : {}),
      });
      return;
    }

    if (message.type === "asset.chunk") {
      const transfer = pendingAssetTransfers.get(message.transferId);
      const data = decodeAssetChunk(message.dataBase64);
      if (
        !transfer ||
        transfer.assetId !== message.assetId ||
        !transfer.started ||
        message.sequence !== transfer.nextSequence ||
        !data ||
        transfer.receivedBytes + data.length > transfer.maxBytes
      ) {
        const rejected = removePendingAssetTransfer(message.transferId);
        rejected?.queue.fail(
          new Error("Browser asset transfer sent an invalid chunk"),
        );
        return;
      }
      transfer.nextSequence += 1;
      transfer.receivedBytes += data.length;
      transfer.hash.update(data);
      transfer.queue.push({
        type: "chunk",
        assetId: message.assetId,
        sequence: message.sequence,
        data,
      });
      return;
    }

    if (message.type === "asset.complete") {
      const transfer = pendingAssetTransfers.get(message.transferId);
      if (
        !transfer ||
        transfer.assetId !== message.assetId ||
        !transfer.started ||
        !transfer.name ||
        message.size !== transfer.receivedBytes ||
        (transfer.declaredSize !== undefined &&
          transfer.declaredSize !== transfer.receivedBytes)
      ) {
        const rejected = removePendingAssetTransfer(message.transferId);
        rejected?.queue.fail(
          new Error("Browser asset transfer completion is invalid"),
        );
        return;
      }
      const sha256 = transfer.hash.digest("hex");
      if (sha256 !== message.sha256.toLowerCase()) {
        removePendingAssetTransfer(message.transferId)?.queue.fail(
          new Error("Browser asset checksum does not match"),
        );
        return;
      }
      const completed = removePendingAssetTransfer(message.transferId);
      if (completed) {
        completed.queue.push({
          type: "complete",
          assetId: message.assetId,
          size: transfer.receivedBytes,
          sha256,
        });
        completed.queue.end();
      }
      return;
    }

    if (message.type === "asset.error") {
      const transfer = pendingAssetTransfers.get(message.transferId);
      if (!transfer || transfer.assetId !== message.assetId) {
        return;
      }
      removePendingAssetTransfer(message.transferId)?.queue.fail(
        new Error(`${message.code}: ${message.message}`),
      );
      return;
    }

    if (message.type === "asset.reveal.result") {
      const request = pendingAssetReveals.get(message.requestId);
      if (!request || request.assetId !== message.assetId) {
        return;
      }
      const completed = removePendingAssetReveal(message.requestId);
      if (!completed) {
        return;
      }
      if (message.success) {
        completed.resolve();
      } else {
        completed.reject(
          new Error(message.message ?? "The provider asset could not be opened"),
        );
      }
      return;
    }

    if (message.type === "bridge.disconnect") {
      socket?.close();
    }
  };

  const sendProtocolError = (
    connection: TextSocket,
    code: string,
    message: string,
  ): void => {
    connection.send(
      JSON.stringify({
        type: "bridge.error",
        protocolVersion: browserProtocolVersion,
        code,
        message,
      } satisfies BridgeServerMessage),
    );
  };

  const authenticateConnection = (connection: TextSocket): void => {
    const authenticationTimer = authenticationTimers.get(connection);
    if (authenticationTimer) {
      clearTimeout(authenticationTimer);
      authenticationTimers.delete(connection);
    }
    preAuthenticationMessages.delete(connection);
    if (socket && socket !== connection) {
      const previous = socket;
      disconnect("Browser bridge connection was replaced");
      previous.close();
    }
    authenticated = true;
    socket = connection;
    lastError = undefined;
  };

  const handleMessage = async (
    connection: TextSocket,
    text: string,
  ): Promise<void> => {
    if (closing) {
      connection.close();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      sendProtocolError(connection, "INVALID_JSON", "Bridge message is not valid JSON");
      return;
    }

    const parsed = parseBridgeClientMessage(value);
    if (parsed.success === false) {
      sendProtocolError(connection, "INVALID_MESSAGE", parsed.error);
      return;
    }

    const message = parsed.message;
    if (!authenticated || connection !== socket) {
      if (
        authenticationOperationCount > 0 &&
        (message.type === "bridge.pair" ||
          message.type === "bridge.authenticate")
      ) {
        sendProtocolError(
          connection,
          "AUTHENTICATION_BUSY",
          "Another browser bridge authentication is in progress",
        );
        return;
      }
      if (message.type === "bridge.pair") {
        const acceptedOrigin = originForConnection(connection);
        if (
          !acceptedOrigin ||
          !extensionOriginPattern.test(acceptedOrigin) ||
          !pairingToken ||
          Date.now() > pairingExpiresAt ||
          !secretMatches(message.token, pairingToken)
        ) {
          sendProtocolError(
            connection,
            "PAIRING_REJECTED",
            "Pairing token is invalid or expired",
          );
          return;
        }
        const acceptedPairingToken = pairingToken;
        const acceptedPairingExpiresAt = pairingExpiresAt;
        const previousConnectionToken = connectionToken;
        const previousConnectionOrigin = connectionOrigin;
        const nextConnectionToken = secureToken();
        const generation = authenticationGeneration;
        clearPairingExpirationTimer();
        pairingToken = undefined;
        pairingExpiresAt = 0;
        await enqueueAuthentication(async () => {
          try {
            await options.secretStore.store(
              connectionOriginSecretKey,
              acceptedOrigin,
            );
            await options.secretStore.store(
              connectionSecretKey,
              nextConnectionToken,
            );
          } catch (error) {
            await restoreCredentials(previousConnectionToken, previousConnectionOrigin).catch((rollbackError) => {
              log(
                `Browser bridge credential rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              );
            });
            if (
              generation === authenticationGeneration &&
              !authenticated &&
              !pairingToken &&
              acceptedPairingExpiresAt > Date.now()
            ) {
              setPairingToken(acceptedPairingToken, acceptedPairingExpiresAt);
            }
            emitStatus();
            throw error;
          }
          if (generation !== authenticationGeneration) {
            try {
              await restoreCredentials(previousConnectionToken, previousConnectionOrigin);
            } catch (error) {
              log(
                `Browser bridge stale credential rollback failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            connectionToken = previousConnectionToken;
            connectionOrigin = previousConnectionOrigin;
            return;
          }
          if (!liveConnections.has(connection) || !connection.isOpen()) {
            try {
              await restoreCredentials(previousConnectionToken, previousConnectionOrigin);
            } catch (error) {
              log(
                `Browser bridge credential rollback failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            connectionToken = previousConnectionToken;
            connectionOrigin = previousConnectionOrigin;
            if (
              generation === authenticationGeneration &&
              !authenticated &&
              !pairingToken &&
              acceptedPairingExpiresAt > Date.now()
            ) {
              setPairingToken(acceptedPairingToken, acceptedPairingExpiresAt);
            }
            emitStatus();
            return;
          }
          connectionToken = nextConnectionToken;
          connectionOrigin = acceptedOrigin;
          authenticateConnection(connection);
          connection.send(
            JSON.stringify({
              type: "bridge.paired",
              protocolVersion: browserProtocolVersion,
              connectionToken: nextConnectionToken,
            } satisfies BridgeServerMessage),
          );
          connection.send(
            JSON.stringify({
              type: "bridge.connected",
              protocolVersion: browserProtocolVersion,
            } satisfies BridgeServerMessage),
          );
          sendLocalModelConfig(connection);
          emitStatus();
          send({
            type: "provider.discover",
            protocolVersion: browserProtocolVersion,
          });
        });
        return;
      }

      if (message.type === "bridge.authenticate") {
        const generation = authenticationGeneration;
        await enqueueAuthentication(async () => {
          const storedToken =
            connectionToken ??
            (await options.secretStore.get(connectionSecretKey));
          const storedOrigin =
            connectionOrigin ??
            (await options.secretStore.get(connectionOriginSecretKey));
          const requestOrigin = originForConnection(connection);
          if (
            generation !== authenticationGeneration ||
            !liveConnections.has(connection) ||
            !connection.isOpen()
          ) {
            return;
          }
          if (
            !storedToken ||
            !storedOrigin ||
            !extensionOriginPattern.test(storedOrigin) ||
            requestOrigin !== storedOrigin ||
            !secretMatches(message.connectionToken, storedToken)
          ) {
            sendProtocolError(
              connection,
              "AUTHENTICATION_REJECTED",
              "Connection token is invalid",
            );
            return;
          }
          connectionToken = storedToken;
          connectionOrigin = storedOrigin;
          clearPairingExpirationTimer();
          pairingToken = undefined;
          pairingExpiresAt = 0;
          authenticateConnection(connection);
          connection.send(
            JSON.stringify({
              type: "bridge.connected",
              protocolVersion: browserProtocolVersion,
            } satisfies BridgeServerMessage),
          );
          sendLocalModelConfig(connection);
          emitStatus();
          send({
            type: "provider.discover",
            protocolVersion: browserProtocolVersion,
          });
        });
        return;
      }

      sendProtocolError(
        connection,
        "AUTHENTICATION_REQUIRED",
        "Pair or authenticate before sending bridge messages",
      );
      return;
    }

    handleAuthenticatedMessage(message);
  };

  const loadConnectionToken = async (): Promise<string | undefined> => {
    const current = await options.secretStore.get(connectionSecretKey);
    if (current) {
      return current;
    }
    for (const legacyKey of legacyConnectionSecretKeys) {
      const legacy = await options.secretStore.get(legacyKey);
      if (!legacy) {
        continue;
      }
      await options.secretStore.store(connectionSecretKey, legacy);
      for (const key of legacyConnectionSecretKeys) {
        await Promise.resolve(options.secretStore.delete(key)).catch((error: unknown) => {
          log(
            `Browser bridge legacy credential cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return legacy;
    }
    return undefined;
  };

  return {
    start: async () => {
      if (closing) {
        throw new Error("Browser bridge server is closed");
      }
      if (!options.enabled || server) {
        emitStatus();
        return;
      }
      connectionToken = await loadConnectionToken();
      connectionOrigin = await options.secretStore.get(connectionOriginSecretKey);
      if (
        (connectionToken && (!connectionOrigin || !extensionOriginPattern.test(connectionOrigin))) ||
        (!connectionToken && connectionOrigin)
      ) {
        await Promise.all([
          options.secretStore.delete(connectionSecretKey),
          options.secretStore.delete(connectionOriginSecretKey),
        ]);
        connectionToken = undefined;
        connectionOrigin = undefined;
        lastError = "Browser Bridge pairing must be renewed after the security upgrade";
      }
      server = createTextWebSocketServer({
        host: "127.0.0.1",
        port: options.port ?? 43127,
        path: endpointPath,
        maxMessageBytes,
        maxMessageBytesForSocket: (connection) =>
          authenticated && socket === connection
            ? maxMessageBytes
            : preAuthenticationMaxMessageBytes,
        maxConnections,
        allowOrigin: (origin) =>
          extensionOriginPattern.test(origin ?? configuredOriginOverride ?? ""),
        onConnection: (connection) => {
          if (!isLoopback(connection.remoteAddress)) {
            connection.close();
            return;
          }
          liveConnections.add(connection);
          messageQueues.set(connection, Promise.resolve());
          queuedMessageCounts.set(connection, 0);
          queuedMessageBytes.set(connection, 0);
          preAuthenticationMessages.set(connection, 0);
          messageRates.set(connection, {
            windowStartedAt: Date.now(),
            count: 0,
          });
          authenticationTimers.set(
            connection,
            setTimeout(() => {
              authenticationTimers.delete(connection);
              preAuthenticationMessages.delete(connection);
              if (!authenticated || socket !== connection) {
                connection.close();
              }
            }, authenticationTimeoutMs),
          );
        },
        onMessage: (connection, text) => {
          if (closing || !liveConnections.has(connection) || !connection.isOpen()) {
            connection.close();
            return;
          }
          const now = Date.now();
          const rate = messageRates.get(connection);
          if (!rate || now - rate.windowStartedAt >= 1_000) {
            messageRates.set(connection, { windowStartedAt: now, count: 1 });
          } else {
            rate.count += 1;
            if (rate.count > maxMessagesPerSecond) {
              sendProtocolError(
                connection,
                "RATE_LIMITED",
                "Too many browser bridge messages",
              );
              connection.close();
              return;
            }
          }
          if (!authenticated || connection !== socket) {
            const count = (preAuthenticationMessages.get(connection) ?? 0) + 1;
            preAuthenticationMessages.set(connection, count);
            if (count > 3) {
              connection.close();
              return;
            }
          }
          const bytes = Buffer.byteLength(text, "utf8");
          const count = (queuedMessageCounts.get(connection) ?? 0) + 1;
          const totalBytes = (queuedMessageBytes.get(connection) ?? 0) + bytes;
          if (
            bytes > maxMessageBytes ||
            count > maxQueuedMessages ||
            totalBytes > maxQueuedBytes
          ) {
            sendProtocolError(
              connection,
              "RATE_LIMITED",
              "Browser bridge message queue limit exceeded",
            );
            connection.close();
            return;
          }
          queuedMessageCounts.set(connection, count);
          queuedMessageBytes.set(connection, totalBytes);
          const previous = messageQueues.get(connection) ?? Promise.resolve();
          const next = previous
            .then(() => handleMessage(connection, text))
            .finally(() => {
              if (!queuedMessageCounts.has(connection)) {
                return;
              }
              queuedMessageCounts.set(
                connection,
                Math.max(0, (queuedMessageCounts.get(connection) ?? 1) - 1),
              );
              queuedMessageBytes.set(
                connection,
                Math.max(0, (queuedMessageBytes.get(connection) ?? bytes) - bytes),
              );
            });
          messageQueues.set(connection, next.catch(() => undefined));
          void next.catch((error) => {
            log(
              `Browser bridge message failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            connection.close();
          });
        },
        onClose: (connection) => {
          liveConnections.delete(connection);
          const timer = authenticationTimers.get(connection);
          if (timer) {
            clearTimeout(timer);
            authenticationTimers.delete(connection);
          }
          preAuthenticationMessages.delete(connection);
          messageRates.delete(connection);
          messageQueues.delete(connection);
          queuedMessageCounts.delete(connection);
          queuedMessageBytes.delete(connection);
          if (connection === socket) {
            disconnect("Browser bridge disconnected");
          }
        },
        onError: (error) => {
          lastError = error.message;
          log(`Browser bridge error: ${error.message}`);
          emitStatus();
        },
      });
      try {
        port = await server.listen();
        lastError = undefined;
        // The pairing token's lifetime starts here, not before listen: a token minted
        // earlier spends its window on startup, and a listen that fails would leave a
        // usable token published for an endpoint that does not exist.
        createPairingToken();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`Browser bridge could not listen: ${message}`);
        lastError = message;
        await server.close().catch(() => undefined);
        server = undefined;
        port = undefined;
        clearPairingExpirationTimer();
        pairingToken = undefined;
        pairingExpiresAt = 0;
      }
      emitStatus();
    },
    getStatus: status,
    subscribeStatus: (listener) => {
      statusListeners.add(listener);
      listener(status());
      return {
        dispose: () => {
          statusListeners.delete(listener);
        },
      };
    },
    resetPairing: () => {
      const generation = ++authenticationGeneration;
      const connections = Array.from(liveConnections);
      disconnect();
      connections.forEach((connection) => connection.close());
      clearPairingExpirationTimer();
      pairingToken = undefined;
      pairingExpiresAt = 0;
      // A reset cannot repair an endpoint that does not exist, so the reason the endpoint
      // is unavailable survives the reset instead of being replaced by a clean state that
      // offers a token nothing can use.
      if (endpointAvailable()) {
        lastError = undefined;
      }
      return enqueueAuthentication(async () => {
        await Promise.all([
          options.secretStore.delete(connectionSecretKey),
          options.secretStore.delete(connectionOriginSecretKey),
          ...legacyConnectionSecretKeys.map((key) =>
            options.secretStore.delete(key),
          ),
        ]);
        if (generation !== authenticationGeneration) {
          return;
        }
        connectionToken = undefined;
        connectionOrigin = undefined;
        if (endpointAvailable()) {
          createPairingToken();
        }
        emitStatus();
      });
    },
    discover: () => {
      if (authenticated) {
        send({
          type: "provider.discover",
          protocolVersion: browserProtocolVersion,
        });
      }
    },
    refreshLocalModelConfig: () => {
      if (!authenticated || !socket || !socket.isOpen()) return;
      sendLocalModelConfig(socket);
    },
    openConversation: (provider, signal, preferredBinding, fresh = false) => {
      if (!authenticated || !socket) {
        return Promise.reject(new Error("Browser bridge is not connected"));
      }
      if (signal?.aborted) {
        return Promise.reject(new Error("Opening the provider conversation was cancelled"));
      }
      const requestId = randomUUID();
      return new Promise<BrowserSession>((resolve, reject) => {
        const cancelRemote = (): void => {
          if (!authenticated || !socket) {
            return;
          }
          try {
            send({
              type: "provider.cancelOpenConversation",
              protocolVersion: browserProtocolVersion,
              requestId,
            });
          } catch {
            // EX-AUD-13. Telling the browser to stop opening is best effort: a send that
            // fails means the socket is already gone, which is itself the cancellation.
          }
        };
        const timer = setTimeout(() => {
          const pendingOpen = removePendingProviderOpen(requestId);
          if (!pendingOpen) {
            return;
          }
          cancelRemote();
          pendingOpen.reject(
            new Error("Opening the provider conversation timed out"),
          );
        }, providerOpenTimeoutMs);
        const abortListener = signal
          ? (): void => {
              const pendingOpen = removePendingProviderOpen(requestId);
              if (!pendingOpen) {
                return;
              }
              cancelRemote();
              pendingOpen.reject(
                new Error("Opening the provider conversation was cancelled"),
              );
            }
          : undefined;
        pendingProviderOpens.set(requestId, {
          requestId,
          provider,
          timer,
          ...(signal === undefined ? {} : { signal }),
          ...(abortListener === undefined ? {} : { abortListener }),
          resolve,
          reject,
        });
        signal?.addEventListener("abort", abortListener as () => void, { once: true });
        try {
          let preferredOrigin: string | undefined;
          if (preferredBinding?.provider === provider) {
            try {
              preferredOrigin = new URL(preferredBinding.conversationUrl).origin;
            } catch {
              preferredOrigin = undefined;
            }
          }
          send({
            type: "provider.openConversation",
            protocolVersion: browserProtocolVersion,
            requestId,
            provider,
            ...(preferredBinding?.preferredTabId === undefined
              ? {}
              : { preferredTabId: preferredBinding.preferredTabId }),
            ...(preferredOrigin ? { preferredOrigin } : {}),
            ...(preferredBinding?.provider === provider
              ? { preferredConversationIdentity: preferredBinding.conversationIdentity }
              : {}),
            ...(fresh ? { fresh: true } : {}),
          });
        } catch (error) {
          removePendingProviderOpen(requestId)?.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    },
    bindSession: (ownerId, sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) {
        throw new Error("The requested browser conversation is no longer available");
      }
      const binding = bindingForSession(session);
      bindConversation(ownerId, binding);
      return binding;
    },
    bindConversation,
    releaseBinding,
    resolveBoundSession,
    sendConversation: (
      agentId,
      text,
      expectedSessionId,
      signal,
      attachments = [],
      deadlineAt = Date.now() + 30 * 60_000,
    ) => {
      const queue = createAsyncQueue<BrowserConversationEvent>();
      const requestId = randomUUID();
      const selected = sessions.find(
        (session) => session.id === (expectedSessionId ?? selectedSessionId),
      );
      if (!authenticated || !socket) {
        queue.fail(new Error("Browser bridge is not connected"));
        return queue.iterable;
      }
      if (!selected) {
        queue.fail(
          new Error(
            expectedSessionId
              ? "The requested browser conversation is no longer available"
              : "Select a ready browser conversation for this agent",
          ),
        );
        return queue.iterable;
      }
      if (selected.status !== "ready") {
        queue.fail(
          new Error(`The requested browser conversation is ${selected.status}`),
        );
        return queue.iterable;
      }
      if (pendingBySession.has(selected.id)) {
        queue.fail(
          new Error("The bound browser conversation already has an active request"),
        );
        return queue.iterable;
      }
      const operation: PendingConversation = {
        requestId,
        agentId,
        session: structuredClone(selected),
        queue,
        signal,
        abortListener: () => undefined,
        interruptRequested: false,
        allowSessionTransition: selected.provider === "generic" || isInitialConversationPage(selected.provider, selected.conversationUrl),
        boundSessionIds: new Set([selected.id]),
      };
      operation.abortListener = () => requestInterrupt(operation);
      pending.set(requestId, operation);
      pendingBySession.set(selected.id, requestId);

      if (signal.aborted) {
        queue.push({ type: "interrupted" });
        queue.end();
        removePending(requestId);
        return queue.iterable;
      }
      signal.addEventListener("abort", operation.abortListener, { once: true });
      queue.push({ type: "session", sessionId: selected.id });
      try {
        send({
          type: "conversation.send",
          protocolVersion: browserProtocolVersion,
          requestId,
          agentId,
          provider: selected.provider,
          sessionId: selected.id,
          tabId: selected.tabId,
          frameId: selected.frameId,
          ...(selected.documentId === undefined ? {} : { documentId: selected.documentId }),
          documentToken: selected.documentToken,
          conversationUrl: selected.conversationUrl,
          conversationIdentity: selected.conversationIdentity,
          text,
          attachments,
          allowInitialConversationTransition: isInitialConversationPage(
            selected.provider,
            selected.conversationUrl,
          ),
          deadlineAt,
        });
      } catch (error) {
        removePending(requestId);
        queue.fail(error);
      }
      return queue.iterable;
    },
    fetchAsset: (assetId, maxBytes, signal) => {
      const queue = createAsyncQueue<BrowserAssetTransferEvent>();
      if (!authenticated || !socket) {
        queue.fail(new Error("Browser bridge is not connected"));
        return queue.iterable;
      }
      if (!assetId || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        queue.fail(new Error("Browser asset transfer parameters are invalid"));
        return queue.iterable;
      }
      if (signal.aborted) {
        queue.fail(new Error("Browser asset transfer was cancelled"));
        return queue.iterable;
      }
      const transferId = randomUUID();
      const abortListener = (): void => {
        try {
          send({
            type: "asset.cancel",
            protocolVersion: browserProtocolVersion,
            transferId,
            assetId,
          });
        } catch {
          // EX-AUD-13. The notice is best effort; the transfer is failed locally below
          // whether or not the browser can still be told.
        }
        removePendingAssetTransfer(transferId)?.queue.fail(
          new Error("Browser asset transfer was cancelled"),
        );
      };
      const timer = setTimeout(() => {
        try {
          send({
            type: "asset.cancel",
            protocolVersion: browserProtocolVersion,
            transferId,
            assetId,
          });
        } catch {
          // EX-AUD-13. Best effort, as above: the timeout is decided locally.
        }
        removePendingAssetTransfer(transferId)?.queue.fail(
          new Error("Browser asset transfer timed out"),
        );
      }, assetTransferTimeoutMs);
      const transfer: PendingAssetTransfer = {
        transferId,
        assetId,
        maxBytes,
        signal,
        abortListener,
        timer,
        queue,
        started: false,
        nextSequence: 0,
        receivedBytes: 0,
        hash: createHash("sha256"),
      };
      pendingAssetTransfers.set(transferId, transfer);
      signal.addEventListener("abort", abortListener, { once: true });
      try {
        send({
          type: "asset.fetch",
          protocolVersion: browserProtocolVersion,
          transferId,
          assetId,
          maxBytes,
        });
      } catch (error) {
        removePendingAssetTransfer(transferId)?.queue.fail(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return queue.iterable;
    },
    revealAsset: (assetId) => {
      if (!authenticated || !socket) {
        return Promise.reject(new Error("Browser bridge is not connected"));
      }
      if (!assetId) {
        return Promise.reject(new Error("Browser asset identifier is invalid"));
      }
      const requestId = randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          removePendingAssetReveal(requestId)?.reject(
            new Error("Opening the provider asset timed out"),
          );
        }, assetRevealTimeoutMs);
        pendingAssetReveals.set(requestId, {
          requestId,
          assetId,
          timer,
          resolve,
          reject,
        });
        try {
          send({
            type: "asset.reveal",
            protocolVersion: browserProtocolVersion,
            requestId,
            assetId,
          });
        } catch (error) {
          removePendingAssetReveal(requestId)?.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
    },
    interrupt: async (requestId) => {
      const operations = requestId
        ? [pending.get(requestId)].filter(
            (value): value is PendingConversation => Boolean(value),
          )
        : Array.from(pending.values());
      operations.forEach(requestInterrupt);
    },
    close: () => {
      if (closeOperation) {
        return closeOperation;
      }
      closing = true;
      authenticationGeneration += 1;
      const connections = Array.from(liveConnections);
      connections.forEach((connection) => connection.close());
      closeOperation = (async (): Promise<void> => {
        const closeError = new Error("Browser bridge server closed");
        rejectPending(closeError);
        rejectPendingAssetTransfers(closeError);
        rejectPendingAssetReveals(closeError);
        rejectPendingProviderOpens(closeError);
        authenticationTimers.forEach((timer) => clearTimeout(timer));
        authenticationTimers.clear();
        clearPairingExpirationTimer();
        pairingToken = undefined;
        pairingExpiresAt = 0;
        messageRates.clear();
        preAuthenticationMessages.clear();
        queuedMessageCounts.clear();
        queuedMessageBytes.clear();
        await authenticationQueue;
        await server?.close();
        server = undefined;
        port = undefined;
        socket = undefined;
        authenticated = false;
        sessions = [];
        selectedSessionId = undefined;
        bindingOwnerByConversation.clear();
        conversationByBindingOwner.clear();
        emitStatus();
      })();
      return closeOperation;
    },
  };
};
