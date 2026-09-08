export type ConversationReconstruction = "available" | "unavailable" | "unknown";

export type ProviderConversationLocator = {
  chatRef: string;
  agentId: string;
  role: string;
  provider: string;
  adapter: string;
  providerSessionId?: string;
  conversationOrigin?: string;
  createdAt: string;
  lastSeenAt: string;
  reconstruction: ConversationReconstruction;
  reconstructionDetail: string;
};

const RESUMABLE_LOCAL_ADAPTERS = new Set([
  "codex-app-server",
  "claude-code",
  "zai-glm",
]);

const BROWSER_ADAPTER = /-browser$/u;

export const conversationOrigin = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

export const providerConversationLocator = (chat: {
  chatRef: string;
  agentId: string;
  role: string;
  provider: string;
  adapter: string;
  providerSessionId?: string | undefined;
  providerConversationUrl?: string | undefined;
  providerConversationIdentity?: string | undefined;
  createdAt: string;
  updatedAt: string;
}): ProviderConversationLocator => {
  const origin = conversationOrigin(chat.providerConversationUrl);
  const browser = BROWSER_ADAPTER.test(chat.adapter);
  const local = RESUMABLE_LOCAL_ADAPTERS.has(chat.adapter);
  const reconstruction: ConversationReconstruction = local
    ? chat.providerSessionId === undefined ? "unavailable" : "available"
    : browser
      ? chat.providerConversationIdentity === undefined ? "unavailable" : "available"
      : "unknown";
  const reconstructionDetail = reconstruction === "available"
    ? browser
      ? "Bachata can reopen this conversation in the browser through the Browser Bridge."
      : "Bachata can resume this provider session and the provider still owns the full history."
    : reconstruction === "unavailable"
      ? "Bachata recorded no provider conversation locator, so the provider history cannot be reconstructed."
      : "Bachata cannot tell whether this provider can reconstruct old history.";
  return {
    chatRef: chat.chatRef,
    agentId: chat.agentId,
    role: chat.role,
    provider: chat.provider,
    adapter: chat.adapter,
    ...(chat.providerSessionId === undefined
      ? {}
      : { providerSessionId: chat.providerSessionId }),
    ...(origin === undefined ? {} : { conversationOrigin: origin }),
    createdAt: chat.createdAt,
    lastSeenAt: chat.updatedAt,
    reconstruction,
    reconstructionDetail,
  };
};
