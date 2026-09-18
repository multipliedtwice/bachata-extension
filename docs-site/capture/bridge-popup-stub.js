/*
 * Chrome API stub for capturing the real Browser Bridge popup (browser-bridge/dist/popup/index.html)
 * outside an extension context. Inject before page scripts; pick the state with the URL hash:
 * #disconnected, #connected or #bound. Tab titles and URLs are demo data.
 */
(() => {
  const scene = location.hash.slice(1) || "disconnected";
  const capabilities = { submission: "native", completion: "native", interruption: "native", assets: "supported", conversationState: "confirmed" };
  const tabs = [
    { id: 11, provider: "chatgpt", title: "Checkout review", url: "https://chatgpt.com/c/demo", status: "ready", ready: true, reason: "", sessionId: "session-1", conversationIdentity: "demo-1", capabilities },
    { id: 12, provider: "claude", title: "Second opinion", url: "https://claude.ai/chat/demo", status: "ready", ready: true, reason: "", sessionId: "session-2", conversationIdentity: "demo-2", capabilities },
    { id: 13, provider: "chatgpt", title: "ChatGPT", url: "https://chatgpt.com/", status: "notAuthenticated", ready: false, reason: "Sign in to ChatGPT in this tab." },
  ];
  const endpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";
  const states = {
    disconnected: { revision: 1, connected: false, connecting: false, tabs: [] },
    connected: { revision: 1, endpoint, connected: true, connecting: false, tabs },
    bound: { revision: 1, endpoint, connected: true, connecting: false, selectedTabId: 11, tabs },
  };
  const state = states[scene];
  window.chrome = {
    runtime: {
      sendMessage: async (message) => message.type === "BACHATA_GENERIC_MANAGE" ? { ok: true, bindings: [] } : state,
      getURL: () => "",
      onMessage: { addListener() {}, removeListener() {} },
    },
    tabs: { query: async () => [] },
    permissions: { request: async () => false, contains: async () => false },
  };
})();
