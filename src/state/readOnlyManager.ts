import * as vscode from "vscode";

import type {
  ConversationManagerState,
  ConversationManagerToWebviewMessage,
  ConversationSummary,
  PanelState,
} from "../webview/protocol";
import { mutationClassForProtocolMessage, refuseMutation } from "./readOnlyWorkspace";
import type { OwnershipView } from "./readOnlyWorkspace";
import type { ReadOnlyProductService } from "./readOnlyProductState";

export type ReadOnlyManager = {
  handleMessage: (message: unknown) => Promise<void>;
  attachWebview: (webview: vscode.Webview) => vscode.Disposable;
  getState: () => ConversationManagerState;
  dispose: () => void;
};

// What the panel may ask a read-only window for. Everything else changes state and refuses.
const READABLE_MESSAGES = new Set([
  "manager.ready",
  "conversation.select",
  "conversation.viewExecution",
  "workspace.ownership",
]);

const messageType = (message: unknown): string | undefined =>
  message !== null && typeof message === "object" &&
  typeof (message as { type?: unknown }).type === "string"
    ? (message as { type: string }).type
    : undefined;

const selectedConversationId = (message: unknown): string | undefined =>
  message !== null && typeof message === "object" &&
  typeof (message as { conversationId?: unknown }).conversationId === "string"
    ? (message as { conversationId: string }).conversationId
    : undefined;

/**
 * The manager a read-only window gives the normal panel.
 *
 * It answers with the same snapshot shape the writer's manager posts, so the panel renders
 * the real product, and it refuses every state-changing message below the UI: a control the
 * webview failed to disable still cannot mutate through this boundary.
 */
export const createReadOnlyManager = (input: {
  service: ReadOnlyProductService;
  ownership: OwnershipView;
  panelState: (conversation: ConversationSummary) => Promise<PanelState>;
  requestOwnership: () => Promise<void>;
  onRefusal?: (message: string) => void;
}): ReadOnlyManager => {
  const webviews = new Set<vscode.Webview>();
  let state = input.service.latest();
  let selected: string | undefined;

  const projected = (): ConversationManagerState => ({
    ...state,
    activeConversationId: selected !== undefined &&
      state.conversations.some((conversation) => conversation.id === selected)
      ? selected
      : state.activeConversationId,
    readOnly: input.ownership,
  });

  const post = (message: ConversationManagerToWebviewMessage): void => {
    webviews.forEach((webview) => {
      void webview.postMessage(message);
    });
  };

  const emitManager = (): void => {
    post({ type: "manager.snapshot", state: projected() });
  };

  const emitPanel = async (): Promise<void> => {
    const current = projected();
    const conversation = current.conversations.find((entry) =>
      entry.id === current.activeConversationId);
    if (conversation === undefined) return;
    try {
      const panel = await input.panelState(conversation);
      post({
        type: "conversation.message",
        conversationId: conversation.id,
        message: { type: "state.snapshot", state: panel },
      });
    } catch (error) {
      post({
        type: "manager.error",
        message: `Bachata could not read this run's pipeline information: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const emit = (): void => {
    emitManager();
    void emitPanel();
  };

  const subscription = input.service.onDidChange((current) => {
    state = current;
    emit();
  });

  const refresh = async (): Promise<void> => {
    state = await input.service.read();
    emitManager();
    await emitPanel();
  };

  const handleMessage = async (message: unknown): Promise<void> => {
    const type = messageType(message);
    if (type === undefined) return;
    if (READABLE_MESSAGES.has(type)) {
      if (type === "workspace.ownership") {
        await input.requestOwnership();
        return;
      }
      if (type === "conversation.select" || type === "conversation.viewExecution") {
        const conversationId = selectedConversationId(message);
        if (conversationId !== undefined) selected = conversationId;
        emitManager();
        await emitPanel();
        return;
      }
      await refresh();
      return;
    }
    const refusal = refuseMutation(mutationClassForProtocolMessage(type), input.ownership);
    input.onRefusal?.(refusal.message);
    post({ type: "manager.error", message: refusal.message });
  };

  return {
    handleMessage,
    attachWebview: (webview) => {
      webviews.add(webview);
      void refresh().catch(() => {
        // A catalog that cannot be read leaves the panel on the last snapshot rather than
        // failing to open; the refusal boundary and ownership banner still render.
        emit();
      });
      return new vscode.Disposable(() => {
        webviews.delete(webview);
      });
    },
    getState: () => projected(),
    dispose: () => {
      subscription.dispose();
      webviews.clear();
    },
  };
};
