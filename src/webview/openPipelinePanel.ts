import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import { ConversationManager } from "../conversations/createConversationManager";
import { ConversationManagerToWebviewMessage, isRuntimeOperation } from "./protocol";
import { getWebviewHtml } from "./html";

let panel: vscode.WebviewPanel | undefined;
let panelReady = false;
let output: vscode.OutputChannel | undefined;
let pendingFocus:
  | { conversationId: string; interactionRef?: string }
  | undefined;
type PanelReadyWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const panelReadyWaiters = new Set<PanelReadyWaiter>();

type HumanE2eUiResult = {
  requestId: string;
  conversationId: string;
  runCreated: boolean;
  pipelineCreated: boolean;
  drawerOpened: boolean;
  newDraftDeleteHidden: boolean;
  sourcePipelineIdLocked: boolean;
  pendingOperationCloseLocked: boolean;
  editorOpened: boolean;
  editorSaved: boolean;
  interactionAnswered: boolean;
  submitted: boolean;
  iterationCount: number;
  // What the catalog actually served this window, by id, read before the scenario adds anything.
  // A default that fails to validate disappears from this list, which is the failure the built-in
  // loader exists to prevent and the one an in-process test cannot observe.
  catalogPipelineIds: string[];
  // Whether every catalog entry could be selected, and whether Structured -> JSON -> Structured
  // completed in the real editor.
  everyCatalogPipelineSelectable: boolean;
  editorModeRoundTrip: boolean;
  /** The ids the rendered picker actually offers, not the ids state happens to hold. */
  renderedPipelineIds: string[];
  /** The description the structured form shows after a JSON edit was made and the tab switched back. */
  editorJsonEditSurvived: boolean;
  /** With unparsable JSON on screen: both mode tabs still enabled, no dialog backdrop over them. */
  invalidJsonKeepsTabsUsable: boolean;
  /** With unparsable JSON on screen: the text the person typed is still in the buffer. */
  invalidJsonKeepsText: boolean;
  /** How many separate lines the editor showed for one unparsable buffer. */
  invalidJsonErrorLines: number;
  /** Advanced run options are behind their disclosure control on a first render. */
  advancedOptionsHiddenByDefault: boolean;
  /**
   * EX-UI-04. The run tab strip measured at each side-panel width: the selected tab's action menu
   * and New run must be distinct, reachable controls at every one of them.
   */
  tabStripHitRegions: TabStripHitRegion[];
  // Global alerts standing at the end of the journey. Anything but zero is a visible failure.
  globalAlertCount: number;
  browserEndpoint?: string | undefined;
  pairingToken?: string | undefined;
};

export type TabStripHitRegion = {
  width: number;
  menuHit: boolean;
  newHit: boolean;
  overlap: boolean;
  menuOpensWithoutRun: boolean;
  menuFocusable: boolean;
};

const isTabStripHitRegion = (value: unknown): value is TabStripHitRegion =>
  typeof value === "object" &&
  value !== null &&
  "width" in value &&
  typeof value.width === "number" &&
  "menuHit" in value &&
  typeof value.menuHit === "boolean" &&
  "newHit" in value &&
  typeof value.newHit === "boolean" &&
  "overlap" in value &&
  typeof value.overlap === "boolean" &&
  "menuOpensWithoutRun" in value &&
  typeof value.menuOpensWithoutRun === "boolean" &&
  "menuFocusable" in value &&
  typeof value.menuFocusable === "boolean";

type HumanE2eUiWaiter = {
  resolve: (result: HumanE2eUiResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type HumanE2eUiAction =
  | "selectRun"
  | "resumeWorkflow"
  | "archiveRun"
  | "unarchiveRun"
  | "deleteRun"
  | "startTodo"
  | "stopTodo"
  | "resumeTodo"
  | "abandonTodo"
  | "cleanupTodo"
  | "discoverBridge"
  | "selectBrowserSession"
  | "submitPreparedRun";

export type HumanE2eUiActionResult = {
  requestId: string;
  action: HumanE2eUiAction;
  completed: boolean;
};

const humanE2eUiActions: readonly HumanE2eUiAction[] = [
  "selectRun",
  "resumeWorkflow",
  "archiveRun",
  "unarchiveRun",
  "deleteRun",
  "startTodo",
  "stopTodo",
  "resumeTodo",
  "abandonTodo",
  "cleanupTodo",
  "discoverBridge",
  "selectBrowserSession",
  "submitPreparedRun",
];

const isHumanE2eUiAction = (value: unknown): value is HumanE2eUiAction =>
  typeof value === "string" && humanE2eUiActions.includes(value as HumanE2eUiAction);

type HumanE2eUiActionWaiter = {
  resolve: (result: HumanE2eUiActionResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

const humanE2eUiWaiters = new Map<string, HumanE2eUiWaiter>();
const humanE2eUiActionWaiters = new Map<string, HumanE2eUiActionWaiter>();

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The channel the panel reveals when the webview asks for it. The render-failure boundary is
 * the one control that has to work when the rest of the panel did not render, so it is handled
 * here rather than behind a manager: a window that owns nothing still answers it.
 */
export const setPipelinePanelOutput = (channel: vscode.OutputChannel): void => {
  output = channel;
};

const resolvePanelReadyWaiters = (): void => {
  panelReadyWaiters.forEach((waiter) => {
    clearTimeout(waiter.timeout);
    waiter.resolve();
  });
  panelReadyWaiters.clear();
};

const rejectPanelReadyWaiters = (message: string): void => {
  panelReadyWaiters.forEach((waiter) => {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error(message));
  });
  panelReadyWaiters.clear();
};

export const waitForPipelinePanelReady = (timeoutMs = 10_000): Promise<void> => {
  if (panelReady) {
    return Promise.resolve();
  }
  if (!panel) {
    return Promise.reject(new Error("Bachata webview is not open"));
  }
  return new Promise<void>((resolve, reject) => {
    let waiter: PanelReadyWaiter | undefined;
    const timeout = setTimeout(() => {
      if (waiter) {
        panelReadyWaiters.delete(waiter);
      }
      reject(new Error("Bachata webview did not become ready"));
    }, timeoutMs);
    waiter = { resolve, reject, timeout };
    panelReadyWaiters.add(waiter);
  });
};

export const runPipelinePanelUiScenario = async (
  prompt: string,
  iterationCount: number,
  pipeline: unknown,
  timeoutMs = 10_000,
  submit = true,
): Promise<HumanE2eUiResult> => {
  if (process.env.BACHATA_HUMAN_E2E !== "1") {
    throw new Error("Human E2E UI controls are disabled");
  }
  await waitForPipelinePanelReady(timeoutMs);
  const currentPanel = panel;
  if (!currentPanel) {
    throw new Error("Bachata webview is not open");
  }
  const requestId = randomUUID();
  return new Promise<HumanE2eUiResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      humanE2eUiWaiters.delete(requestId);
      reject(new Error("Bachata webview UI scenario timed out"));
    }, timeoutMs);
    humanE2eUiWaiters.set(requestId, { resolve, reject, timeout });
    void currentPanel.webview.postMessage({
      type: "humanE2e.uiRun",
      requestId,
      prompt,
      iterationCount,
      pipeline,
      submit,
    }).then(
      (sent: boolean) => {
        if (sent) {
          return;
        }
        const waiter = humanE2eUiWaiters.get(requestId);
        if (!waiter) {
          return;
        }
        clearTimeout(waiter.timeout);
        humanE2eUiWaiters.delete(requestId);
        reject(new Error("Bachata webview rejected the UI scenario"));
      },
      (error: unknown) => {
        const waiter = humanE2eUiWaiters.get(requestId);
        if (!waiter) {
          return;
        }
        clearTimeout(waiter.timeout);
        humanE2eUiWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

export const runPipelinePanelUiAction = async (
  action: HumanE2eUiAction,
  targetId?: string,
  timeoutMs = 10_000,
): Promise<HumanE2eUiActionResult> => {
  if (process.env.BACHATA_HUMAN_E2E !== "1") {
    throw new Error("Human E2E UI controls are disabled");
  }
  await waitForPipelinePanelReady(timeoutMs);
  const currentPanel = panel;
  if (!currentPanel) {
    throw new Error("Bachata webview is not open");
  }
  const requestId = randomUUID();
  return new Promise<HumanE2eUiActionResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      humanE2eUiActionWaiters.delete(requestId);
      reject(new Error(`Bachata webview ${action} action timed out`));
    }, timeoutMs);
    humanE2eUiActionWaiters.set(requestId, { resolve, reject, timeout });
    void currentPanel.webview.postMessage({
      type: "humanE2e.uiAction",
      requestId,
      action,
      targetId,
    }).then(
      (sent: boolean) => {
        if (sent) return;
        const waiter = humanE2eUiActionWaiters.get(requestId);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        humanE2eUiActionWaiters.delete(requestId);
        reject(new Error(`Bachata webview rejected the ${action} action`));
      },
      (error: unknown) => {
        const waiter = humanE2eUiActionWaiters.get(requestId);
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        humanE2eUiActionWaiters.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
};

/**
 * What the webview keeps in `vscode.setState`: prepared-prompt drafts by conversation and the
 * unsaved pipeline-editor draft. VS Code hands the last saved copy back to the serializer, so the
 * host holds it until the restored webview reports ready and can take it.
 */
type RestoredWebviewState = {
  drafts?: Record<string, string>;
  editor?: Record<string, unknown>;
};

let pendingRestoredState: RestoredWebviewState | undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const restoredWebviewState = (state: unknown): RestoredWebviewState | undefined => {
  const value = asRecord(state);
  if (!value) {
    return undefined;
  }
  const storedDrafts = asRecord(value.drafts);
  const drafts: Record<string, string> = storedDrafts
    ? Object.fromEntries(
        Object.entries(storedDrafts).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  const editor = asRecord(value.editor);
  const hasDrafts = Object.keys(drafts).length > 0;
  if (!hasDrafts && !editor) {
    return undefined;
  }
  const restored: RestoredWebviewState = {};
  if (hasDrafts) {
    restored.drafts = drafts;
  }
  if (editor) {
    restored.editor = editor;
  }
  return restored;
};

const postPendingRestoredState = (): void => {
  if (!panel || !panelReady || !pendingRestoredState) {
    return;
  }
  const state = pendingRestoredState;
  pendingRestoredState = undefined;
  void panel.webview.postMessage({ type: "manager.restoreState", state });
};

const postPendingFocus = (): void => {
  if (!panel || !panelReady || !pendingFocus) {
    return;
  }
  const target = pendingFocus;
  pendingFocus = undefined;
  void panel.webview.postMessage({
    type: "manager.focus",
    conversationId: target.conversationId,
    ...(target.interactionRef === undefined ? {} : { interactionRef: target.interactionRef }),
  } satisfies ConversationManagerToWebviewMessage);
};

/**
 * What the panel needs from whatever is behind it. The writer passes its conversation
 * manager; a window that did not win ownership passes a read-only manager, so both open the
 * same panel rather than one of them showing a message instead of the product.
 */
export type WebviewHost = Pick<ConversationManager, "attachWebview" | "handleMessage">;

const webviewOptions = (context: vscode.ExtensionContext): vscode.WebviewOptions & vscode.WebviewPanelOptions => ({
  enableScripts: true,
  retainContextWhenHidden: true,
  localResourceRoots: [
    vscode.Uri.joinPath(context.extensionUri, "dist"),
    context.storageUri,
    context.globalStorageUri,
  ].filter((uri): uri is vscode.Uri => Boolean(uri)),
});

export const openPipelinePanel = (
  context: vscode.ExtensionContext,
  manager: WebviewHost,
  restoredPanel?: vscode.WebviewPanel,
  restoredState?: unknown,
): void => {
  if (panel) {
    if (restoredPanel && restoredPanel !== panel) {
      restoredPanel.dispose();
    }
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.One);
    postPendingFocus();
    return;
  }

  panelReady = false;
  pendingRestoredState = restoredWebviewState(restoredState);
  const options = webviewOptions(context);
  panel = restoredPanel ?? vscode.window.createWebviewPanel(
    "bachata",
    "Bachata",
    vscode.ViewColumn.One,
    options,
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  panel.webview.options = options;
  panel.webview.html = getWebviewHtml(panel.webview, context.extensionUri);
  const detach = manager.attachWebview(panel.webview);
  const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (
      message !== null &&
      typeof message === "object" &&
      (message as Record<string, unknown>).type === "diagnostics.revealOutput"
    ) {
      output?.show(true);
      return;
    }
    if (
      message !== null &&
      typeof message === "object" &&
      (message as Record<string, unknown>).type === "humanE2e.uiResult" &&
      typeof (message as Record<string, unknown>).requestId === "string"
    ) {
      const value = message as Record<string, unknown>;
      const requestId = value.requestId as string;
      const actionWaiter = humanE2eUiActionWaiters.get(requestId);
      if (actionWaiter) {
        clearTimeout(actionWaiter.timeout);
        humanE2eUiActionWaiters.delete(requestId);
        const action = value.action;
        if (isHumanE2eUiAction(action)) {
          actionWaiter.resolve({
            requestId,
            action,
            completed: value.completed === true,
          });
        } else {
          actionWaiter.reject(new Error("Bachata webview returned an invalid UI action"));
        }
        return;
      }
      const waiter = humanE2eUiWaiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timeout);
        humanE2eUiWaiters.delete(requestId);
        waiter.resolve({
          requestId,
          conversationId: typeof value.conversationId === "string" ? value.conversationId : "",
          runCreated: value.runCreated === true,
          pipelineCreated: value.pipelineCreated === true,
          drawerOpened: value.drawerOpened === true,
          newDraftDeleteHidden: value.newDraftDeleteHidden === true,
          sourcePipelineIdLocked: value.sourcePipelineIdLocked === true,
          pendingOperationCloseLocked: value.pendingOperationCloseLocked === true,
          editorOpened: value.editorOpened === true,
          editorSaved: value.editorSaved === true,
          interactionAnswered: value.interactionAnswered === true,
          submitted: value.submitted === true,
          iterationCount: typeof value.iterationCount === "number" ? value.iterationCount : 0,
          catalogPipelineIds: Array.isArray(value.catalogPipelineIds)
            ? value.catalogPipelineIds.filter((id): id is string => typeof id === "string")
            : [],
          everyCatalogPipelineSelectable: value.everyCatalogPipelineSelectable === true,
          editorModeRoundTrip: value.editorModeRoundTrip === true,
          renderedPipelineIds: Array.isArray(value.renderedPipelineIds)
            ? value.renderedPipelineIds.filter((id): id is string => typeof id === "string")
            : [],
          editorJsonEditSurvived: value.editorJsonEditSurvived === true,
          invalidJsonKeepsTabsUsable: value.invalidJsonKeepsTabsUsable === true,
          invalidJsonKeepsText: value.invalidJsonKeepsText === true,
          invalidJsonErrorLines: typeof value.invalidJsonErrorLines === "number" ? value.invalidJsonErrorLines : -1,
          advancedOptionsHiddenByDefault: value.advancedOptionsHiddenByDefault === true,
          tabStripHitRegions: Array.isArray(value.tabStripHitRegions)
            ? value.tabStripHitRegions.filter(isTabStripHitRegion)
            : [],
          globalAlertCount: typeof value.globalAlertCount === "number" ? value.globalAlertCount : -1,
          browserEndpoint: typeof value.browserEndpoint === "string" ? value.browserEndpoint : undefined,
          pairingToken: typeof value.pairingToken === "string" ? value.pairingToken : undefined,
        });
      }
      return;
    }
    void manager.handleMessage(message).then(() => {
      if (
        message !== null &&
        typeof message === "object" &&
        (message as Record<string, unknown>).type === "manager.ready"
      ) {
        panelReady = true;
        resolvePanelReadyWaiters();
        postPendingRestoredState();
        postPendingFocus();
      }
    }).catch((error) => {
      const value =
        message !== null && typeof message === "object"
          ? (message as Record<string, unknown>)
          : undefined;
      const runtimeMessage =
        value?.type === "conversation.runtime" &&
        value.message !== null &&
        typeof value.message === "object"
          ? (value.message as Record<string, unknown>)
          : undefined;
      // EX-A5-R17. The operations an editor request can wait on are a value the protocol owns, so
      // this path reads that classifier rather than repeating the list. The copy it used to keep
      // was missing `pipeline.fork`, which is the one operation whose refusals happen before the
      // runtime ever posts a result: the editor's request stayed pending for the life of the
      // panel and the failure surfaced as an uncorrelated banner.
      const runtimeOperation = isRuntimeOperation(runtimeMessage?.type)
        ? runtimeMessage.type
        : undefined;
      const response: ConversationManagerToWebviewMessage =
        value?.type === "conversation.runtime" &&
        typeof value.conversationId === "string"
          ? {
              type: "conversation.message",
              conversationId: value.conversationId,
              message:
                runtimeMessage?.type === "attachment.add" &&
                typeof runtimeMessage.clientId === "string"
                  ? {
                      type: "attachment.failed",
                      clientId: runtimeMessage.clientId,
                      message: errorMessage(error),
                    }
                  : runtimeOperation && typeof runtimeMessage?.requestId === "string"
                    ? {
                        type: "operation.result",
                        requestId: runtimeMessage.requestId,
                        operation: runtimeOperation,
                        status: "failed",
                        message: errorMessage(error),
                      }
                    : { type: "error", message: errorMessage(error) },
            }
          : { type: "manager.error", message: errorMessage(error) };
      void panel?.webview.postMessage(response);
    });
  });

  panel.onDidDispose(() => {
    messageListener.dispose();
    detach.dispose();
    panel = undefined;
    panelReady = false;
    pendingRestoredState = undefined;
    rejectPanelReadyWaiters("Bachata webview closed before it became ready");
    humanE2eUiWaiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bachata webview closed during the UI scenario"));
    });
    humanE2eUiWaiters.clear();
    humanE2eUiActionWaiters.forEach((waiter) => {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Bachata webview closed during the UI action"));
    });
    humanE2eUiActionWaiters.clear();
  });
};

export const registerPipelinePanelSerializer = (
  context: vscode.ExtensionContext,
  manager: WebviewHost,
): vscode.Disposable =>
  vscode.window.registerWebviewPanelSerializer("bachata", {
    deserializeWebviewPanel: async (restoredPanel, state: unknown): Promise<void> => {
      openPipelinePanel(context, manager, restoredPanel, state);
    },
  });

export const focusPipelinePanel = (
  context: vscode.ExtensionContext,
  manager: WebviewHost,
  target: { conversationId: string; interactionRef?: string },
): void => {
  pendingFocus = target;
  openPipelinePanel(context, manager);
  postPendingFocus();
};
