import type { BrowserConversationBinding, BrowserSession } from "./protocol";

export const isProvisionalConversation = (
  binding: Pick<BrowserConversationBinding, "provider" | "conversationUrl">,
): boolean => {
  try {
    const url = new URL(binding.conversationUrl);
    const path = url.pathname.replace(/\/$/, "") || "/";
    return binding.provider === "chatgpt"
      ? url.origin === "https://chatgpt.com" && path === "/"
      : binding.provider === "claude" && url.origin === "https://claude.ai" && (path === "/" || path === "/new");
  } catch {
    return false;
  }
};

export const browserBindingForSession = (session: Pick<BrowserSession,
  "provider" | "conversationUrl" | "conversationIdentity" | "tabId"
> & { documentToken?: string | undefined }): BrowserConversationBinding => ({
  provider: session.provider,
  conversationUrl: session.conversationUrl,
  conversationIdentity: session.conversationIdentity,
  preferredTabId: session.tabId,
  ...(isProvisionalConversation(session) && session.documentToken
    ? { provisionalDocumentToken: session.documentToken }
    : {}),
});

export const browserConversationClaimKey = (binding: BrowserConversationBinding): string => {
  if (isProvisionalConversation(binding)) {
    if (binding.preferredTabId === undefined) throw new Error("Select the initial browser tab again");
    return JSON.stringify([binding.provider, "provisional", binding.preferredTabId,
      binding.provisionalDocumentToken ?? "unresolved", binding.conversationIdentity]);
  }
  return binding.provider === "generic" && binding.preferredTabId !== undefined
    ? JSON.stringify([binding.provider, "tab", binding.preferredTabId, binding.conversationIdentity])
    : JSON.stringify([binding.provider, binding.conversationIdentity]);
};

export const resolveBrowserSession = (
  sessions: readonly BrowserSession[],
  binding: BrowserConversationBinding | undefined,
  expectedSessionId?: string,
): BrowserSession | undefined => {
  const exact = expectedSessionId ? sessions.find((session) => session.id === expectedSessionId) : undefined;
  if (exact) {
    if (binding && (binding.provider !== exact.provider || binding.conversationIdentity !== exact.conversationIdentity
      || (isProvisionalConversation(binding) && (
        (binding.preferredTabId !== undefined && binding.preferredTabId !== exact.tabId)
        || (binding.provisionalDocumentToken !== undefined && binding.provisionalDocumentToken !== exact.documentToken)
      )))) throw new Error("The browser session does not match its persisted conversation binding");
    return structuredClone(exact);
  }
  if (!binding || binding.provider === "generic" || isProvisionalConversation(binding)) return undefined;
  const candidates = sessions.filter((session) => session.provider === binding.provider
    && session.conversationIdentity === binding.conversationIdentity);
  const selected = candidates.find((session) => session.tabId === binding.preferredTabId)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  return selected ? structuredClone(selected) : undefined;
};
