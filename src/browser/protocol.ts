export const browserProtocolVersion = 9 as const;

export type BrowserProvider = "chatgpt" | "claude" | "generic";

export type BrowserLocalModelConfig = {
  enabled: boolean;
  backend: "auto" | "lmstudio" | "ollama";
  endpoint?: string;
  model: string;
  timeoutMs: number;
};

export type BrowserSessionStatus =
  | "disconnected"
  | "notAuthenticated"
  | "notReady"
  | "ready"
  | "submitting"
  | "streaming"
  | "failed";

export type BrowserConversationBinding = {
  provider: BrowserProvider;
  conversationUrl: string;
  conversationIdentity: string;
  preferredTabId?: number;
};

export type BrowserAttachment = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  dataBase64: string;
};

export type CapturedSegment = {
  type: "text" | "codeBlock" | "quote";
  text: string;
  start: number;
  end: number;
  language?: string;
};

export type BrowserAssetKind =
  | "generatedFile"
  | "artifact"
  | "canvas"
  | "image"
  | "codeArtifact";

export type BrowserAssetSourceElement = "assistantMessage" | "artifactPane";

export type CapturedAsset = {
  id: string;
  provider: BrowserProvider;
  kind: BrowserAssetKind;
  name: string;
  mimeType?: string;
  size?: number;
  sourceElement: BrowserAssetSourceElement;
  providerAssetId?: string;
  downloadAvailable: boolean;
  previewText?: string;
  // Canonical origin of the provider-supplied source link. A followed redirect may use another
  // origin. This value is shown before the user chooses to save.
  sourceOrigin?: string;
};


export type BrowserSessionCapabilities = {
  submission: "verifiedSend" | "syntheticEnter" | "native";
  completion: "verifiedLifecycle" | "manualOnly" | "native";
  interruption: "confirmed" | "unavailable" | "native";
  assets: "supported" | "textOnly";
  conversationState: "confirmed" | "uncertain";
};

export type BrowserSession = {
  id: string;
  provider: BrowserProvider;
  tabId: number;
  frameId: number;
  documentId?: string;
  documentToken: string;
  conversationUrl: string;
  conversationIdentity: string;
  title?: string;
  capabilities?: BrowserSessionCapabilities;
  status: BrowserSessionStatus;
  createdAt: string;
  updatedAt: string;
};

export type CapturedResponse = {
  requestId: string;
  agentId: string;
  sessionId: string;
  provider: BrowserProvider;
  text: string;
  segments: CapturedSegment[];
  assets: CapturedAsset[];
  captureFormat: "renderedText";
  fidelity: "bestEffort";
  finalConversationUrl: string;
  finalConversationIdentity: string;
  finalSessionId: string;
  startedAt: string;
  completedAt: string;
};

export type BridgeClientMessage =
  | { type: "bridge.pair"; protocolVersion: 9; token: string }
  | {
      type: "bridge.authenticate";
      protocolVersion: 9;
      connectionToken: string;
    }
  | { type: "bridge.ping"; protocolVersion: 9; nonce: string }
  | {
      type: "provider.status";
      protocolVersion: 9;
      sessions: BrowserSession[];
      selectedSessionId?: string;
    }
  | {
      type: "provider.openConversation.result";
      protocolVersion: 9;
      requestId: string;
      provider: BrowserProvider;
      success: boolean;
      session?: BrowserSession;
      code?: string;
      message?: string;
    }
  | {
      type: "conversation.submitted";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
    }
  | {
      type: "conversation.stream";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
      mode: "append" | "replace";
      text: string;
    }
  | ({ type: "conversation.response"; protocolVersion: 9 } & CapturedResponse)
  | {
      type: "conversation.interrupted";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
    }
  | {
      /**
       * BB-A4-N05. The browser could not confirm the person's Stop, and the turn it was aimed at
       * is still running. Nonterminal: the request still has exactly one terminal frame ahead of
       * it, whichever way the turn settles, so a failed Stop can never consume the answer that
       * was still coming.
       */
      type: "conversation.interruptFailed";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      sessionId: string;
      message: string;
    }
  | {
      type: "conversation.error";
      protocolVersion: 9;
      requestId: string;
      agentId?: string;
      sessionId?: string;
      code: string;
      message: string;
    }
  | {
      type: "asset.start";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      name: string;
      mimeType?: string;
      size?: number;
    }
  | {
      type: "asset.chunk";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      sequence: number;
      dataBase64: string;
    }
  | {
      type: "asset.complete";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      size: number;
      sha256: string;
    }
  | {
      type: "asset.error";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      code: string;
      message: string;
    }
  | {
      type: "asset.reveal.result";
      protocolVersion: 9;
      requestId: string;
      assetId: string;
      success: boolean;
      message?: string;
    }
  | { type: "bridge.disconnect"; protocolVersion: 9 };

export type BridgeServerMessage =
  | {
      type: "bridge.paired";
      protocolVersion: 9;
      connectionToken: string;
    }
  | { type: "bridge.connected"; protocolVersion: 9 }
  | { type: "bridge.pong"; protocolVersion: 9; nonce: string }
  | ({ type: "localModel.config"; protocolVersion: 9 } & BrowserLocalModelConfig)
  | { type: "provider.discover"; protocolVersion: 9 }
  | {
      type: "provider.openConversation";
      protocolVersion: 9;
      requestId: string;
      provider: BrowserProvider;
      preferredTabId?: number;
      preferredOrigin?: string;
      preferredConversationIdentity?: string;
      fresh?: boolean;
    }
  | {
      type: "provider.cancelOpenConversation";
      protocolVersion: 9;
      requestId: string;
    }
  | {
      type: "conversation.send";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      provider: BrowserProvider;
      sessionId: string;
      tabId: number;
      frameId: number;
      documentId?: string;
      documentToken: string;
      conversationUrl: string;
      conversationIdentity: string;
      text: string;
      attachments: BrowserAttachment[];
      allowInitialConversationTransition: boolean;
      deadlineAt: number;
    }
  | {
      type: "conversation.interrupt";
      protocolVersion: 9;
      requestId: string;
      agentId: string;
      provider: BrowserProvider;
      sessionId: string;
      tabId: number;
      frameId: number;
      documentId?: string;
      documentToken: string;
      conversationUrl: string;
      conversationIdentity: string;
    }
  | {
      type: "asset.fetch";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
      maxBytes: number;
    }
  | {
      type: "asset.cancel";
      protocolVersion: 9;
      transferId: string;
      assetId: string;
    }
  | {
      type: "asset.reveal";
      protocolVersion: 9;
      requestId: string;
      assetId: string;
    }
  | {
      type: "bridge.error";
      protocolVersion: 9;
      code: string;
      message: string;
    };

export type ParseBridgeMessageResult =
  | { success: true; message: BridgeClientMessage }
  | { success: false; error: string };

const providers = new Set<BrowserProvider>(["chatgpt", "claude", "generic"]);
const statuses = new Set<BrowserSessionStatus>([
  "disconnected",
  "notAuthenticated",
  "notReady",
  "ready",
  "submitting",
  "streaming",
  "failed",
]);
const assetKinds = new Set<BrowserAssetKind>([
  "generatedFile",
  "artifact",
  "canvas",
  "image",
  "codeArtifact",
]);
const assetSources = new Set<BrowserAssetSourceElement>([
  "assistantMessage",
  "artifactPane",
]);
const segmentTypes = new Set<CapturedSegment["type"]>([
  "text",
  "codeBlock",
  "quote",
]);

export const browserAssetMetadataLimits = {
  assetsPerResponse: 100,
  id: 200,
  name: 512,
  mimeType: 255,
  providerAssetId: 500,
  previewText: 20_000,
  sourceOrigin: 2_048,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.trim().length > 0;
const isBoundedNonEmptyString = (
  value: unknown,
  maximumLength: number,
): value is string => isNonEmptyString(value) && value.length <= maximumLength;
// The only shape a source origin may take. A response can link any host, so the value that
// reaches the user before Save must be a canonical HTTP(S) origin and nothing else: parsing has
// to succeed, the scheme has to be one the transfer path actually fetches, the origin cannot be
// opaque, and re-serializing it has to reproduce the input byte for byte. That last check is what
// rejects a path, query, fragment, userinfo, whitespace, a default port written out, or an
// uppercased scheme, none of which URL.origin can ever produce.
export const isCanonicalHttpOrigin = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > browserAssetMetadataLimits.sourceOrigin
  ) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin !== "null" &&
    parsed.origin === value
  );
};

const isNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const isIsoDate = (value: unknown): value is string =>
  isString(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const hasOnlyKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const parseSegment = (value: unknown): CapturedSegment | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["type", "text", "start", "end", "language"]) ||
    !segmentTypes.has(value.type as CapturedSegment["type"]) ||
    // A segment must carry text and must advance. A zero-length segment left the coverage
    // cursor where it was, so any number of them tiled nothing and still satisfied the
    // check that segments cover the text exactly. Length, not `trim()`: a run of newlines
    // between two code blocks is real text and has to stay tileable.
    !isString(value.text) ||
    value.text.length === 0 ||
    !isNonNegativeInteger(value.start) ||
    !isNonNegativeInteger(value.end) ||
    Number(value.end) <= Number(value.start) ||
    (value.language !== undefined && !isString(value.language))
  ) {
    return undefined;
  }
  return value as CapturedSegment;
};

const validSegmentCoverage = (
  text: string,
  segments: CapturedSegment[],
): boolean => {
  let cursor = 0;
  for (const segment of segments) {
    if (
      segment.start !== cursor ||
      segment.end > text.length ||
      text.slice(segment.start, segment.end) !== segment.text ||
      (segment.language !== undefined && segment.type !== "codeBlock")
    ) {
      return false;
    }
    cursor = segment.end;
  }
  return cursor === text.length || (text.length === 0 && segments.length === 0);
};

/** Every key a captured asset may carry, in protocol order. */
export const capturedAssetKeys = [
  "id",
  "provider",
  "kind",
  "name",
  "mimeType",
  "size",
  "sourceElement",
  "providerAssetId",
  "downloadAvailable",
  "previewText",
  "sourceOrigin",
] as const;

/**
 * Whether every field a captured asset declares is valid.
 *
 * This is the single field rule set. The wire parser adds a key allowlist on top of it,
 * because a message from the browser may carry nothing the protocol does not declare. A
 * reader of already-persisted state applies the same field rules without that allowlist —
 * see `runtime/capturedAssetTranscript.ts` — so the two can never drift apart on what a
 * field is allowed to hold.
 */
export const validCapturedAssetFields = (
  value: unknown,
): value is CapturedAsset => {
  if (
    !isRecord(value) ||
    !isBoundedNonEmptyString(value.id, browserAssetMetadataLimits.id) ||
    !providers.has(value.provider as BrowserProvider) ||
    !assetKinds.has(value.kind as BrowserAssetKind) ||
    !isBoundedNonEmptyString(value.name, browserAssetMetadataLimits.name) ||
    (value.mimeType !== undefined &&
      !isBoundedNonEmptyString(
        value.mimeType,
        browserAssetMetadataLimits.mimeType,
      )) ||
    (value.size !== undefined && !isNonNegativeInteger(value.size)) ||
    !assetSources.has(value.sourceElement as BrowserAssetSourceElement) ||
    (value.providerAssetId !== undefined &&
      !isBoundedNonEmptyString(
        value.providerAssetId,
        browserAssetMetadataLimits.providerAssetId,
      )) ||
    typeof value.downloadAvailable !== "boolean" ||
    (value.previewText !== undefined &&
      (!isString(value.previewText) ||
        value.previewText.length > browserAssetMetadataLimits.previewText)) ||
    (value.sourceOrigin !== undefined && !isCanonicalHttpOrigin(value.sourceOrigin))
  ) {
    return false;
  }
  return true;
};

const parseAsset = (value: unknown): CapturedAsset | undefined =>
  isRecord(value) &&
  hasOnlyKeys(value, capturedAssetKeys) &&
  validCapturedAssetFields(value)
    ? value
    : undefined;

const isSessionCapabilities = (value: unknown): value is BrowserSessionCapabilities => {
  if (!isRecord(value) || !hasOnlyKeys(value, ["submission", "completion", "interruption", "assets", "conversationState"])) return false;
  return (value.submission === "verifiedSend" || value.submission === "syntheticEnter" || value.submission === "native")
    && (value.completion === "verifiedLifecycle" || value.completion === "manualOnly" || value.completion === "native")
    && (value.interruption === "confirmed" || value.interruption === "unavailable" || value.interruption === "native")
    && (value.assets === "supported" || value.assets === "textOnly")
    && (value.conversationState === "confirmed" || value.conversationState === "uncertain");
};

const parseSession = (value: unknown): BrowserSession | undefined => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "provider",
      "tabId",
      "frameId",
      "documentId",
      "documentToken",
      "conversationUrl",
      "conversationIdentity",
      "title",
      "capabilities",
      "status",
      "createdAt",
      "updatedAt",
    ]) ||
    !isNonEmptyString(value.id) ||
    !providers.has(value.provider as BrowserProvider) ||
    !Number.isInteger(value.tabId) ||
    !Number.isInteger(value.frameId) ||
    (value.documentId !== undefined && !isNonEmptyString(value.documentId)) ||
    !isNonEmptyString(value.documentToken) ||
    !isNonEmptyString(value.conversationUrl) ||
    !isNonEmptyString(value.conversationIdentity) ||
    (value.title !== undefined && !isString(value.title)) ||
    (value.capabilities !== undefined && !isSessionCapabilities(value.capabilities)) ||
    !statuses.has(value.status as BrowserSessionStatus) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    return undefined;
  }
  return value as BrowserSession;
};

const validTransferIdentity = (value: Record<string, unknown>): boolean =>
  isBoundedNonEmptyString(value.transferId, browserAssetMetadataLimits.id) &&
  isBoundedNonEmptyString(value.assetId, browserAssetMetadataLimits.id);

const parseMessage = (value: unknown): BridgeClientMessage => {
  if (!isRecord(value) || !isNonEmptyString(value.type)) {
    throw new Error("Bridge message must be an object with a type");
  }
  if (value.protocolVersion !== browserProtocolVersion) {
    throw new Error("Browser bridge protocol version mismatch");
  }

  if (value.type === "bridge.pair") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "token"]) || !isNonEmptyString(value.token)) {
      throw new Error("Invalid bridge.pair message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "bridge.authenticate") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "connectionToken"]) || !isNonEmptyString(value.connectionToken)) {
      throw new Error("Invalid bridge.authenticate message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "bridge.ping") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "nonce"]) || !isNonEmptyString(value.nonce)) {
      throw new Error("Invalid bridge.ping message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "bridge.disconnect") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion"])) {
      throw new Error("Invalid bridge.disconnect message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "provider.status") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "sessions", "selectedSessionId"]) || !Array.isArray(value.sessions)) {
      throw new Error("Invalid provider.status message");
    }
    const parsedSessions = value.sessions.map(parseSession);
    if (parsedSessions.some((session) => session === undefined)) {
      throw new Error("provider.status contains an invalid session");
    }
    if (value.selectedSessionId !== undefined && !isNonEmptyString(value.selectedSessionId)) {
      throw new Error("provider.status selectedSessionId is invalid");
    }
    const sessionsValue = parsedSessions.filter((session): session is BrowserSession => session !== undefined);
    if (value.selectedSessionId !== undefined && !sessionsValue.some((session) => session.id === value.selectedSessionId)) {
      throw new Error("provider.status selectedSessionId is not present in sessions");
    }
    return {
      type: "provider.status",
      protocolVersion: 9,
      sessions: sessionsValue,
      ...(typeof value.selectedSessionId === "string"
        ? { selectedSessionId: value.selectedSessionId }
        : {}),
    };
  }
  if (value.type === "provider.openConversation.result") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "provider",
        "success",
        "session",
        "code",
        "message",
      ]) ||
      !isNonEmptyString(value.requestId) ||
      !providers.has(value.provider as BrowserProvider) ||
      typeof value.success !== "boolean" ||
      (value.code !== undefined && !isNonEmptyString(value.code)) ||
      (value.message !== undefined && !isNonEmptyString(value.message))
    ) {
      throw new Error("Invalid provider.openConversation.result message");
    }
    const session = value.session === undefined ? undefined : parseSession(value.session);
    if (
      (value.success && (!session || session.provider !== value.provider || session.status !== "ready")) ||
      (!value.success && value.session !== undefined)
    ) {
      throw new Error("Invalid provider.openConversation.result session");
    }
    return {
      type: "provider.openConversation.result",
      protocolVersion: 9,
      requestId: value.requestId,
      provider: value.provider as BrowserProvider,
      success: value.success,
      ...(session ? { session } : {}),
      ...(value.code !== undefined ? { code: value.code as string } : {}),
      ...(value.message !== undefined ? { message: value.message as string } : {}),
    };
  }
  if (value.type === "conversation.submitted") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "requestId", "agentId", "sessionId"]) || !isNonEmptyString(value.requestId) || !isNonEmptyString(value.agentId) || !isNonEmptyString(value.sessionId)) {
      throw new Error("Invalid conversation.submitted message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "conversation.stream") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "requestId", "agentId", "sessionId", "mode", "text"]) || !isNonEmptyString(value.requestId) || !isNonEmptyString(value.agentId) || !isNonEmptyString(value.sessionId) || (value.mode !== "append" && value.mode !== "replace") || !isString(value.text)) {
      throw new Error("Invalid conversation.stream message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "conversation.response") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "agentId",
        "sessionId",
        "provider",
        "text",
        "segments",
        "assets",
        "captureFormat",
        "fidelity",
        "finalConversationUrl",
        "finalConversationIdentity",
        "finalSessionId",
        "startedAt",
        "completedAt",
      ]) ||
      !isNonEmptyString(value.requestId) ||
      !isNonEmptyString(value.agentId) ||
      !isNonEmptyString(value.sessionId) ||
      !providers.has(value.provider as BrowserProvider) ||
      !isString(value.text) ||
      !Array.isArray(value.segments) ||
      value.segments.some((segment) => parseSegment(segment) === undefined) ||
      !validSegmentCoverage(value.text, value.segments as CapturedSegment[]) ||
      !Array.isArray(value.assets) ||
      value.assets.length > browserAssetMetadataLimits.assetsPerResponse ||
      value.assets.some((asset) => parseAsset(asset) === undefined) ||
      new Set((value.assets as CapturedAsset[]).map((asset) => asset.id)).size !== value.assets.length ||
      value.captureFormat !== "renderedText" ||
      value.fidelity !== "bestEffort" ||
      !isNonEmptyString(value.finalConversationUrl) ||
      !isNonEmptyString(value.finalConversationIdentity) ||
      !isNonEmptyString(value.finalSessionId) ||
      !isIsoDate(value.startedAt) ||
      !isIsoDate(value.completedAt)
    ) {
      throw new Error("Invalid conversation.response message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "conversation.interrupted") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "requestId", "agentId", "sessionId"]) || !isNonEmptyString(value.requestId) || !isNonEmptyString(value.agentId) || !isNonEmptyString(value.sessionId)) {
      throw new Error("Invalid conversation.interrupted message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "conversation.interruptFailed") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "requestId", "agentId", "sessionId", "message"]) || !isNonEmptyString(value.requestId) || !isNonEmptyString(value.agentId) || !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.message)) {
      throw new Error("Invalid conversation.interruptFailed message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "conversation.error") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "requestId", "agentId", "sessionId", "code", "message"]) || !isNonEmptyString(value.requestId) || (value.agentId !== undefined && !isNonEmptyString(value.agentId)) || (value.sessionId !== undefined && !isNonEmptyString(value.sessionId)) || !isNonEmptyString(value.code) || !isNonEmptyString(value.message)) {
      throw new Error("Invalid conversation.error message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "asset.start") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "transferId",
        "assetId",
        "name",
        "mimeType",
        "size",
      ]) ||
      !validTransferIdentity(value) ||
      !isBoundedNonEmptyString(value.name, browserAssetMetadataLimits.name) ||
      (value.mimeType !== undefined &&
        !isBoundedNonEmptyString(
          value.mimeType,
          browserAssetMetadataLimits.mimeType,
        )) ||
      (value.size !== undefined && !isNonNegativeInteger(value.size))
    ) {
      throw new Error("Invalid asset.start message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "asset.chunk") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "transferId", "assetId", "sequence", "dataBase64"]) || !validTransferIdentity(value) || !isNonNegativeInteger(value.sequence) || !isNonEmptyString(value.dataBase64)) {
      throw new Error("Invalid asset.chunk message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "asset.complete") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "transferId", "assetId", "size", "sha256"]) || !validTransferIdentity(value) || !isNonNegativeInteger(value.size) || !/^[a-f0-9]{64}$/i.test(String(value.sha256))) {
      throw new Error("Invalid asset.complete message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "asset.error") {
    if (!hasOnlyKeys(value, ["type", "protocolVersion", "transferId", "assetId", "code", "message"]) || !validTransferIdentity(value) || !isNonEmptyString(value.code) || !isNonEmptyString(value.message)) {
      throw new Error("Invalid asset.error message");
    }
    return value as BridgeClientMessage;
  }
  if (value.type === "asset.reveal.result") {
    if (
      !hasOnlyKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "assetId",
        "success",
        "message",
      ]) ||
      !isNonEmptyString(value.requestId) ||
      !isNonEmptyString(value.assetId) ||
      typeof value.success !== "boolean" ||
      (value.message !== undefined && !isNonEmptyString(value.message))
    ) {
      throw new Error("Invalid asset.reveal.result message");
    }
    return value as BridgeClientMessage;
  }

  throw new Error(`Unsupported bridge message type: ${value.type}`);
};

export const parseBridgeClientMessage = (
  value: unknown,
): ParseBridgeMessageResult => {
  try {
    return { success: true, message: parseMessage(value) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
