import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { IncomingMessage, request, ServerResponse } from "node:http";
import { connect, createServer } from "node:net";

import type {
  BrowserAssetTransferEvent,
  BrowserBridgeReservation,
  BrowserBridgeServer,
  BrowserBridgeStatus,
  BrowserConversationEvent,
} from "./bridgeServer";
import type { BrowserAttachment, BrowserConversationBinding, BrowserProvider, BrowserSession } from "./protocol";
import { DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES } from "./limits";

const rpcPath = "/bachata-browser-bridge-shared-v1";
const maxBytes = DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES;
const unavailable = (): Error => new Error("Browser unavailable — retrying.");
const endpointUrl = (endpoint: string): URL => {
  const url = new URL(endpoint);
  if (!["ws:", "http:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash) {
    throw unavailable();
  }
  url.protocol = "http:";
  url.pathname = rpcPath;
  return url;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
};
const string = (value: unknown, limit = 16_384): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) throw unavailable();
  return value;
};
const optionalString = (value: unknown): string | undefined => value === undefined ? undefined : string(value);
const provider = (value: unknown): BrowserProvider => {
  if (value !== "chatgpt" && value !== "claude" && value !== "generic") throw unavailable();
  return value;
};
const binding = (value: unknown): BrowserConversationBinding => {
  const item = object(value);
  if (item.preferredTabId !== undefined && (!Number.isSafeInteger(item.preferredTabId) || Number(item.preferredTabId) < 0)) throw unavailable();
  return {
    provider: provider(item.provider),
    conversationUrl: string(item.conversationUrl),
    conversationIdentity: string(item.conversationIdentity),
    ...(item.preferredTabId === undefined ? {} : { preferredTabId: Number(item.preferredTabId) }),
  };
};
const attachments = (value: unknown): BrowserAttachment[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw unavailable();
  return value.map((raw) => {
    const item = object(raw);
    const mimeType = item.mimeType;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp" && mimeType !== "image/gif") throw unavailable();
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 0 || Number(item.size) > maxBytes) throw unavailable();
    const dataBase64 = string(item.dataBase64, maxBytes);
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(dataBase64) || Buffer.from(dataBase64, "base64").length !== item.size) throw unavailable();
    return { name: string(item.name, 1024), mimeType, size: Number(item.size), dataBase64 };
  });
};
const readBody = async (incoming: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of incoming) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += data.length;
    if (length > maxBytes) throw unavailable();
    chunks.push(data);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
};
const reply = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
  response.end(JSON.stringify({ value }));
};

type SharedPeer = {
  lastSeen: number;
  bindings: Map<string, BrowserConversationBinding>;
  operations: Map<string, AbortController>;
};

export const createSharedBridgeRequestHandler = (options: {
  getToken: () => string | undefined;
  getBridge: () => BrowserBridgeServer;
  interruptConversation?: (ownerIds: readonly string[], requestId: string) => Promise<void>;
}): { handle: (incoming: IncomingMessage, response: ServerResponse) => void; close: () => void } => {
  const peers = new Map<string, SharedPeer>();
  let cleanupTimer: NodeJS.Timeout | undefined;
  const release = (id: string): void => {
    const peer = peers.get(id);
    if (!peer) return;
    peer.operations.forEach((operation) => operation.abort());
    peer.bindings.forEach((_binding, owner) => options.getBridge().releaseBinding(owner));
    peers.delete(id);
  };
  const execute = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
    const token = options.getToken();
    const authorization = incoming.headers.authorization;
    const expected = Buffer.from(`Bearer ${token ?? ""}`);
    const candidate = Buffer.from(authorization ?? "");
    if (
      incoming.url !== rpcPath || incoming.method !== "POST" ||
      incoming.socket.remoteAddress !== "127.0.0.1" || incoming.headers.origin !== undefined ||
      incoming.headers.host !== `127.0.0.1:${String(incoming.socket.localPort)}` ||
      incoming.headers["content-type"] !== "application/json" || !token ||
      expected.length !== candidate.length || !timingSafeEqual(expected, candidate)
    ) {
      response.writeHead(403, { "Connection": "close" });
      response.end();
      return;
    }
    const body = await readBody(incoming);
    if (body.method === "probe") { reply(response, options.getBridge().getStatus()); return; }
    const clientId = string(body.clientId, 64);
    if (!/^[a-f0-9-]{36}$/u.test(clientId)) throw unavailable();
    const method = string(body.method, 40);
    if (!peers.has(clientId) && peers.size >= 64) throw unavailable();
    const peer = peers.get(clientId) ?? { lastSeen: Date.now(), bindings: new Map<string, BrowserConversationBinding>(), operations: new Map<string, AbortController>() };
    peer.lastSeen = Date.now();
    peers.set(clientId, peer);
    cleanupTimer ??= setInterval(() => {
      for (const [id, item] of peers) if (Date.now() - item.lastSeen > 45_000) release(id);
    }, 15_000);
    cleanupTimer.unref();
    const args = object(body.args ?? {});
    const bridge = options.getBridge();
    const owner = (): string => `${clientId}:${string(args.ownerId, 1024)}`;
    if (method === "status") { reply(response, bridge.getStatus()); return; }
    if (method === "close") { release(clientId); reply(response, null); return; }
    if (method === "discover") { bridge.discover(); reply(response, null); return; }
    if (method === "refreshLocalModelConfig") { bridge.refreshLocalModelConfig(); reply(response, null); return; }
    if (method === "resetPairing") { await bridge.resetPairing(); reply(response, null); return; }
    if (method === "releaseBinding") {
      const id = owner();
      bridge.releaseBinding(id);
      peer.bindings.delete(id);
      reply(response, null);
      return;
    }
    if (method === "bindConversation") {
      const id = owner();
      const value = binding(args.binding);
      if (!peer.bindings.has(id) && peer.bindings.size >= 1024) throw unavailable();
      bridge.bindConversation(id, value);
      peer.bindings.set(id, value);
      reply(response, null);
      return;
    }
    if (method === "interrupt") {
      const id = optionalString(args.requestId);
      if (id) {
        const operation = peer.operations.get(id);
        if (operation) operation.abort();
        else await options.interruptConversation?.([...peer.bindings.keys()], id);
      } else peer.operations.forEach((operation) => operation.abort());
      reply(response, null);
      return;
    }
    if (method === "revealAsset") { await bridge.revealAsset(string(args.assetId)); reply(response, null); return; }
    if (method !== "openConversation" && method !== "sendConversation" && method !== "fetchAsset") throw unavailable();
    const operationId = string(args.operationId, 64);
    if (!/^[a-f0-9-]{36}$/u.test(operationId) || peer.operations.has(operationId) || peer.operations.size >= 32) throw unavailable();
    const controller = new AbortController();
    peer.operations.set(operationId, controller);
    const abort = (): void => controller.abort();
    response.once("close", abort);
    try {
      if (method === "openConversation") {
        const result = await bridge.openConversation(provider(args.provider), controller.signal, args.binding === undefined ? undefined : binding(args.binding), args.fresh === true);
        reply(response, result);
        return;
      }
      let stream: AsyncIterable<BrowserConversationEvent | BrowserAssetTransferEvent>;
      if (method === "sendConversation") {
        const id = owner();
        if (!peer.bindings.has(id)) throw new Error("Choose a browser conversation before sending.");
        const expectedSessionId = optionalString(args.expectedSessionId);
        const selected = bridge.resolveBoundSession(id, peer.bindings.get(id), expectedSessionId);
        if (!selected) throw new Error("Choose a browser conversation before sending.");
        const text = typeof args.text === "string" && args.text.length <= maxBytes ? args.text : undefined;
        if (text === undefined) throw unavailable();
        const deadline = args.deadlineAt === undefined ? undefined : Number(args.deadlineAt);
        if (deadline !== undefined && (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 24 * 60 * 60_000)) throw unavailable();
        stream = bridge.sendConversation(id, text, selected.id, controller.signal, attachments(args.attachments), deadline);
      } else {
        if (!Number.isSafeInteger(args.maxBytes) || Number(args.maxBytes) <= 0 || Number(args.maxBytes) > 1024 * 1024 * 1024) throw unavailable();
        stream = bridge.fetchAsset(string(args.assetId), Number(args.maxBytes), controller.signal);
      }
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "Connection": "close" });
      for await (const event of stream) {
        if (response.destroyed) break;
        const value = event.type === "chunk" ? { ...event, data: event.data.toString("base64") } : event;
        if (!response.write(`${JSON.stringify({ event: value })}\n`)) await once(response, "drain", { signal: controller.signal });
      }
      if (!response.destroyed) response.end(`${JSON.stringify({ complete: true })}\n`);
    } finally {
      response.off("close", abort);
      peer.operations.delete(operationId);
    }
  };
  return {
    handle: (incoming, response) => {
      void execute(incoming, response).catch(() => {
        if (response.destroyed) return;
        if (response.headersSent) response.end(`${JSON.stringify({ error: "Browser unavailable — retrying." })}\n`);
        else {
          response.writeHead(409, { "Content-Type": "application/json", "Connection": "close" });
          response.end(JSON.stringify({ error: "Browser unavailable — retrying." }));
        }
      });
    },
    close: () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      for (const id of peers.keys()) release(id);
    },
  };
};

const rpc = async function* (endpoint: string, token: string, clientId: string, method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  const url = endpointUrl(endpoint);
  const body = JSON.stringify({ clientId, method, args });
  if (Buffer.byteLength(body) > maxBytes || signal?.aborted) throw unavailable();
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      ...(signal ? { signal } : {}),
    }, (incoming) => { incoming.setTimeout(0); resolve(incoming); });
    outgoing.once("error", reject);
    outgoing.setTimeout(method === "openConversation" ? 70_000 : 15_000, () => outgoing.destroy(unavailable()));
    outgoing.end(body);
  });
  try {
    if (response.statusCode !== 200) throw unavailable();
    let buffer = "";
    const streaming = response.headers["content-type"] === "application/x-ndjson";
    const decoder = new TextDecoder();
    for await (const chunk of response) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      if (Buffer.byteLength(buffer) > maxBytes) throw unavailable();
      if (!streaming) continue;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const value = object(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
        if (value.error) throw unavailable();
        yield value;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield object(JSON.parse(buffer));
  } finally {
    response.destroy();
  }
};
const call = async (endpoint: string, token: string, clientId: string, method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
  for await (const result of rpc(endpoint, token, clientId, method, args, signal)) return result.value;
  throw unavailable();
};

export const probeBrowserBridgeEndpoint = async (endpoint: string, token?: string, timeoutMs = 1000, signal?: AbortSignal): Promise<{ reachable: boolean; status?: BrowserBridgeStatus; blockedReason?: "accessDenied" }> => {
  const url = endpointUrl(endpoint);
  if (signal?.aborted) throw unavailable();
  let blockedReason: "accessDenied" | undefined;
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: Number(url.port) });
    const abort = (): void => finish(true);
    const finish = (value: boolean): void => { signal?.removeEventListener("abort", abort); socket.destroy(); resolve(value); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") blockedReason = "accessDenied";
      finish(error.code !== "ECONNREFUSED");
    });
    socket.setTimeout(timeoutMs, () => finish(true));
  });
  if (signal?.aborted) throw unavailable();
  if (blockedReason) return { reachable, blockedReason };
  if (!reachable || !token) return { reachable };
  try {
    const value = await call(endpoint, token, randomUUID(), "probe", {}, AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]));
    const status = object(value);
    if (typeof status.enabled !== "boolean" || typeof status.connected !== "boolean" || !Array.isArray(status.sessions)) return { reachable };
    return { reachable, status: status as unknown as BrowserBridgeStatus };
  } catch {
    if (signal?.aborted) throw unavailable();
    return { reachable };
  }
};

export const reserveBrowserBridgeEndpoint = async (endpoint: string, signal?: AbortSignal): Promise<BrowserBridgeReservation> => {
  const url = endpointUrl(endpoint);
  if (signal?.aborted) throw unavailable();
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { signal?.removeEventListener("abort", abort); reject(error); };
    const abort = (): void => { server.close(); failed(unavailable()); };
    signal?.addEventListener("abort", abort, { once: true });
    server.once("error", failed);
    server.listen({ host: "127.0.0.1", port: Number(url.port), exclusive: true, ...(signal ? { signal } : {}) }, () => {
      signal?.removeEventListener("abort", abort);
      server.off("error", failed);
      if (signal?.aborted) { server.close(); reject(unavailable()); return; }
      resolve();
    });
  });
  return {
    endpoint,
    isHeld: () => server.listening,
    release: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
};

export const createSharedBrowserBridgeClient = (options: {
  endpoint: string;
  token: string;
  onStatusChange?: (status: BrowserBridgeStatus) => void;
  pollIntervalMs?: number;
}): BrowserBridgeServer => {
  endpointUrl(options.endpoint);
  const clientId = randomUUID();
  let current: BrowserBridgeStatus = { enabled: true, connected: false, sessions: [] };
  let closed = false;
  const lifetime = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let polling: Promise<void> | undefined;
  let pollSucceeded = false;
  let pending: Promise<void> = Promise.resolve();
  let bindingFailure: unknown;
  const listeners = new Set<(status: BrowserBridgeStatus) => void>();
  const localBindings = new Map<string, BrowserConversationBinding>();
  const operations = new Map<string, AbortController>();
  const pendingOpens = new Set<string>();
  const emit = (): void => {
    options.onStatusChange?.(structuredClone(current));
    listeners.forEach((listener) => listener(structuredClone(current)));
  };
  const invoke = (method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    if (closed && method !== "close") return Promise.reject(unavailable());
    return call(options.endpoint, options.token, clientId, method, args, AbortSignal.any([
      signal ?? AbortSignal.timeout(10_000),
      ...(method === "close" ? [] : [lifetime.signal]),
    ]));
  };
  const synchronize = async (): Promise<void> => {
    await pending;
    if (bindingFailure) { const error = bindingFailure; bindingFailure = undefined; throw error; }
  };
  const enqueue = (method: string, args?: Record<string, unknown>): void => {
    pending = pending.then(async () => { await invoke(method, args); }).catch((error: unknown) => { bindingFailure = error; });
  };
  const poll = (): Promise<void> => {
    if (polling) return polling;
    polling = (async () => {
      try {
        const status = object(await invoke("status"));
        if (typeof status.enabled !== "boolean" || typeof status.connected !== "boolean" || !Array.isArray(status.sessions)) throw unavailable();
        current = status as unknown as BrowserBridgeStatus;
        pollSucceeded = true;
      } catch {
        pollSucceeded = false;
        current = { enabled: true, connected: false, connectionState: "retrying", sessions: [], error: "Browser unavailable — retrying." };
      }
      if (!closed) emit();
    })().finally(() => { polling = undefined; });
    return polling;
  };
  const registerOperation = (signal?: AbortSignal, opening = false): {
    operationId: string;
    controller: AbortController;
    dispose: () => void;
  } => {
    const operationId = randomUUID();
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    operations.set(operationId, controller);
    if (opening) pendingOpens.add(operationId);
    return {
      operationId,
      controller,
      dispose: () => {
        signal?.removeEventListener("abort", abort);
        controller.abort();
        operations.delete(operationId);
        pendingOpens.delete(operationId);
      },
    };
  };
  const stream = async function* (method: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<BrowserConversationEvent | BrowserAssetTransferEvent> {
    await synchronize();
    if (method === "sendConversation") {
      const ownerId = string(args.ownerId);
      const saved = localBindings.get(ownerId);
      if (!saved) throw unavailable();
      await invoke("bindConversation", { ownerId, binding: saved });
    }
    const operation = registerOperation(signal);
    const { operationId, controller } = operation;
    try {
      for await (const item of rpc(options.endpoint, options.token, clientId, method, { ...args, operationId }, controller.signal)) {
        if (item.complete === true) return;
        const event = object(item.event);
        if (event.type === "chunk") yield { ...event, data: Buffer.from(string(event.data, maxBytes), "base64") } as BrowserAssetTransferEvent;
        else if (event.type === "response") {
          const response = object(event.response);
          yield { type: "response", response: { ...response, agentId: args.ownerId } } as BrowserConversationEvent;
        } else yield event as unknown as BrowserConversationEvent;
      }
      throw unavailable();
    } finally {
      operation.dispose();
    }
  };
  const bind = (ownerId: string, value: BrowserConversationBinding): void => {
    localBindings.set(ownerId, value);
    enqueue("bindConversation", { ownerId, binding: value });
  };
  const fromSession = (session: BrowserSession): BrowserConversationBinding => ({ provider: session.provider, conversationIdentity: session.conversationIdentity, conversationUrl: session.conversationUrl, preferredTabId: session.tabId });
  return {
    start: async () => {
      if (closed) throw unavailable();
      await poll();
      if (!pollSucceeded) throw unavailable();
      if (!timer) {
        timer = setInterval(() => { void poll(); }, Math.max(500, options.pollIntervalMs ?? 1500));
        timer.unref();
      }
    },
    getStatus: () => structuredClone(current),
    subscribeStatus: (listener) => { listeners.add(listener); listener(structuredClone(current)); return { dispose: () => { listeners.delete(listener); } }; },
    resetPairing: async () => { await synchronize(); await invoke("resetPairing"); await poll(); },
    discover: () => enqueue("discover"),
    refreshLocalModelConfig: () => enqueue("refreshLocalModelConfig"),
    openConversation: async (value, signal, preferredBinding, fresh) => {
      await synchronize();
      const operation = registerOperation(signal, true);
      try {
        const opened = await invoke("openConversation", {
          provider: value,
          binding: preferredBinding,
          fresh,
          operationId: operation.operationId,
        }, AbortSignal.any([operation.controller.signal, AbortSignal.timeout(70_000)])) as BrowserSession;
        if (closed) throw unavailable();
        current = {
          ...current,
          sessions: [...current.sessions.filter((session) => session.id !== opened.id), structuredClone(opened)],
        };
        emit();
        return structuredClone(opened);
      } finally {
        operation.dispose();
      }
    },
    bindSession: (ownerId, sessionId) => {
      const session = current.sessions.find((value) => value.id === sessionId);
      if (!session) throw unavailable();
      const value = fromSession(session);
      bind(ownerId, value);
      return value;
    },
    bindConversation: bind,
    releaseBinding: (ownerId) => { localBindings.delete(ownerId); enqueue("releaseBinding", { ownerId }); },
    resolveBoundSession: (ownerId, value, expectedSessionId) => {
      const exact = expectedSessionId ? current.sessions.find((session) => session.id === expectedSessionId) : undefined;
      if (exact) {
        if (value && (value.provider !== exact.provider || value.conversationIdentity !== exact.conversationIdentity)) throw unavailable();
        bind(ownerId, value ?? fromSession(exact));
        return structuredClone(exact);
      }
      if (!value) return undefined;
      bind(ownerId, value);
      if (value.provider === "generic") return undefined;
      const candidates = current.sessions.filter((session) => session.provider === value.provider && session.conversationIdentity === value.conversationIdentity);
      const selected = candidates.find((session) => session.tabId === value.preferredTabId) ?? (candidates.length === 1 ? candidates[0] : undefined);
      return selected ? structuredClone(selected) : undefined;
    },
    sendConversation: (ownerId, text, expectedSessionId, signal, items, deadlineAt) => stream("sendConversation", { ownerId, text, expectedSessionId, attachments: items, deadlineAt }, signal) as AsyncIterable<BrowserConversationEvent>,
    fetchAsset: (assetId, limit, signal) => stream("fetchAsset", { assetId, maxBytes: limit }, signal) as AsyncIterable<BrowserAssetTransferEvent>,
    revealAsset: async (assetId) => { await synchronize(); await invoke("revealAsset", { assetId }); },
    interrupt: async (requestId) => {
      if (!requestId) pendingOpens.forEach((id) => operations.get(id)?.abort());
      await invoke("interrupt", requestId ? { requestId } : {});
    },
    close: async () => {
      if (closed) return;
      closed = true;
      lifetime.abort();
      if (timer) clearInterval(timer);
      operations.forEach((operation) => operation.abort());
      await pending;
      await invoke("close").catch(() => undefined);
      listeners.clear();
      localBindings.clear();
    },
  };
};
