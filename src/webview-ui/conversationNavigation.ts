const conversationScrollBehavior = (): ScrollBehavior =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";

const chatMinimapHtml = (panel: PanelState): string => {
  const turns = panel.transcript.filter((entry) => entry.eventType === "user.message" || (entry.agentId && ["answer", "interrupted", "error"].includes(entry.kind)));
  if (turns.length < 3) return "";
  return `<nav class="chat-minimap" aria-label="Conversation turns">${turns.map((entry, index) => {
    const name = entry.eventType === "user.message" ? "You" : panel.agents[entry.agentId ?? ""]?.name ?? "Participant";
    const kind = entry.eventType === "user.message" ? "user" : "participant";
    return `<button class="${kind}" data-action="jump-message" data-message-id="${escapeAttribute(entry.id)}" tabindex="${index === turns.length - 1 ? "0" : "-1"}" aria-label="Go to ${escapeAttribute(name)}, turn ${String(index + 1)}" title="${escapeAttribute(`${name} · turn ${String(index + 1)}`)}"><span></span></button>`;
  }).join("")}</nav>`;
};

const rememberConversationScroll = (content: HTMLElement): void => {
  const key = content.dataset.scrollKey;
  if (!key) return;
  const distanceFromBottom = Math.max(0, content.scrollHeight - content.scrollTop - content.clientHeight);
  state.scrollPositions.set(key, { top: content.scrollTop, distanceFromBottom, following: distanceFromBottom < 90 });
};

let observedConversation: HTMLElement | undefined;
const conversationSizes = new WeakMap<HTMLElement, { width: number; height: number }>();
const followConversationResize = (content: HTMLElement): void => {
  const previous = conversationSizes.get(content);
  const resized = previous && (previous.width !== content.clientWidth || previous.height !== content.clientHeight);
  if (resized && state.roomView === "chat" && state.scrollPositions.get(content.dataset.scrollKey ?? "")?.following) {
    content.setAttribute("data-restoring", "");
    content.scrollTop = content.scrollHeight;
    content.removeAttribute("data-restoring");
  }
  conversationSizes.set(content, { width: content.clientWidth, height: content.clientHeight });
};
const conversationResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
  if (!observedConversation) return;
  followConversationResize(observedConversation);
  rememberConversationScroll(observedConversation);
  refreshConversationNavigation();
}) : undefined;

const refreshConversationNavigation = (): void => {
  const content = root.querySelector<HTMLElement>(".conversation-scroll");
  if (!content) {
    conversationResizeObserver?.disconnect();
    observedConversation = undefined;
    return;
  }
  if (content !== observedConversation) {
    conversationResizeObserver?.disconnect();
    observedConversation = content;
    conversationSizes.set(content, { width: content.clientWidth, height: content.clientHeight });
    conversationResizeObserver?.observe(content);
  }
  const distanceFromBottom = content.scrollHeight - content.scrollTop - content.clientHeight;
  const latest = root.querySelector<HTMLButtonElement>(".jump-latest");
  if (latest) latest.hidden = distanceFromBottom < 90;
  const rail = root.querySelector<HTMLElement>(".chat-minimap");
  if (!rail) return;
  const bounds = content.getBoundingClientRect();
  const center = bounds.top + bounds.height / 2;
  const entries = Array.from(content.querySelectorAll<HTMLElement>(".message-row[data-entry]"));
  const distance = (entry: HTMLElement): number => {
    const rect = entry.getBoundingClientRect();
    return center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0;
  };
  const closest = entries.reduce<HTMLElement | undefined>((best, entry) => !best || distance(entry) < distance(best) ? entry : best, undefined);
  const ownsFocus = document.activeElement instanceof HTMLElement && document.activeElement.closest(".chat-minimap") === rail;
  rail.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    const current = button.dataset.messageId === closest?.dataset.entry;
    if (current) {
      button.setAttribute("data-current", "");
      button.setAttribute("aria-current", "true");
      if (!ownsFocus) rail.scrollTop = Math.max(0, button.offsetTop - rail.clientHeight / 2 + button.offsetHeight / 2);
    } else {
      button.removeAttribute("data-current");
      button.removeAttribute("aria-current");
    }
    if (ownsFocus) button.tabIndex = button === document.activeElement ? 0 : -1;
    else if (closest) button.tabIndex = current ? 0 : -1;
  });
};

root.addEventListener("scroll", (event) => {
  const content = event.target instanceof HTMLElement && event.target.matches(".conversation-scroll") ? event.target : undefined;
  if (!content) return;
  followConversationResize(content);
  rememberConversationScroll(content);
  refreshConversationNavigation();
}, true);

root.addEventListener("keydown", (event) => {
  if (!(event.target instanceof HTMLButtonElement) || !event.target.closest(".chat-minimap")) return;
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".chat-minimap button"));
  const index = buttons.indexOf(event.target);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
  event.preventDefault();
  buttons.forEach((button, position) => { button.tabIndex = position === next ? 0 : -1; });
  buttons[next]?.focus();
});

root.addEventListener("load", (event) => {
  if (!(event.target instanceof HTMLElement) || !event.target.closest(".conversation-scroll")) return;
  const content = root.querySelector<HTMLElement>(".conversation-scroll");
  if (!content || state.roomView !== "chat") return;
  if (state.scrollPositions.get(content.dataset.scrollKey ?? "")?.following) {
    content.setAttribute("data-restoring", "");
    content.scrollTop = content.scrollHeight;
    content.removeAttribute("data-restoring");
  }
  refreshConversationNavigation();
}, true);
