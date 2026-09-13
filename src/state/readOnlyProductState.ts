import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import * as path from "node:path";

import { conversationSummaryFromCatalog } from "../conversations/catalogSummary";
import { catalogEventHistories } from "../conversations/catalogViews";
import {
  emptyOrchestrationSummary,
  retainedOrchestrationSummary,
  summarizeOrchestration,
} from "../orchestrator/summarize";
import { createOrchestrationStore } from "../orchestrator/store";
import type { OrchestrationLedger } from "../orchestrator/types";
import type {
  ConversationManagerState,
  ConversationSummary,
  WorkflowEventSummary,
} from "../webview/protocol";
import type { RunResultCenter } from "../results/projectResult";
import { openReadOnlyStateCatalog } from "./readOnlyCatalog";
import type { ReadOnlyStateCatalog } from "./readOnlyCatalog";
import type { OwnershipView } from "./readOnlyWorkspace";
import { emptyLongitudinalSummary } from "../longitudinal/service";

export type ReadOnlyProductInput = {
  storageRoot: string;
  repositoryRoot?: string;
  ownership: OwnershipView;
  defaultPipelineIterations?: number;
  maxPipelineIterations?: number;
  onError?: (message: string) => void;
  /** Off in tests that drive refresh explicitly; on in a real window. */
  watchStorage?: boolean;
  /**
   * How a directory is watched. The default is `node:fs`. A caller supplies its own only to
   * drive the platform behaviours a test cannot provoke: recursive watching being refused,
   * and a watcher the platform has already closed.
   */
  watchFactory?: (
    target: string,
    options: { recursive: boolean },
    listener: () => void,
  ) => FSWatcher;
};

export type ReadOnlyProductService = {
  /** Re-reads persisted state and returns what the panel renders. */
  read: () => Promise<ConversationManagerState>;
  /** The most recent read, without touching storage again. */
  latest: () => ConversationManagerState;
  onDidChange: (listener: (state: ConversationManagerState) => void) => { dispose: () => void };
  /** Retained runs still holding a Git worktree, as the writer recorded them. */
  retainedWorktrees: () => string[];
  dispose: () => void;
};

const DEFAULT_ITERATIONS = 1;
const MAXIMUM_ITERATIONS = 10;

const emptyState = (
  ownership: OwnershipView,
  defaultPipelineIterations: number,
  maxPipelineIterations: number,
): ConversationManagerState => ({
  conversations: [],
  activeConversationId: "",
  defaultPipelineIterations,
  maxPipelineIterations,
  interactions: [],
  eventsByConversation: {},
  resultsByConversation: {},
  orchestration: emptyOrchestrationSummary(),
  direction: emptyLongitudinalSummary(),
  notifications: { mode: "material", unread: 0, events: [] },
  conversationLocators: {},
  readOnly: ownership,
});

/**
 * The history a read-only window shows, projected exactly as the writing window projects it.
 *
 * This used to send a published decision's payload whole and nothing at all for every other event:
 * the same unbounded ruling the writing window sent, and the same empty disclosures beside it. It
 * shares the one projection now, so a read-only window is bounded, redacted and as informative as
 * the window that owns the workspace.
 */
const eventHistories = (
  catalog: ReadOnlyStateCatalog,
  conversations: readonly ConversationSummary[],
  activeConversationId: string,
): Record<string, WorkflowEventSummary[]> => catalogEventHistories({
  histories: conversations.map((conversation) => ({
    conversationId: conversation.id,
    events: catalog.listEvents(conversation.runRef, 500),
  })),
  activeConversationId,
});

/**
 * The product a window shows when another window owns the workspace.
 *
 * Everything it renders comes from what the writer persisted: the run catalog opened
 * read-only, the longitudinal store, and the orchestration ledgers on disk. It constructs no
 * runtime, no provider, no Browser Bridge and no orchestrator, holds no lease and no fencing
 * token, and writes nothing — reading state never changes it.
 */
export const createReadOnlyProductService = (
  input: ReadOnlyProductInput,
): ReadOnlyProductService => {
  const defaultPipelineIterations = input.defaultPipelineIterations ?? DEFAULT_ITERATIONS;
  const maxPipelineIterations = Math.max(
    defaultPipelineIterations,
    input.maxPipelineIterations ?? MAXIMUM_ITERATIONS,
  );
  let catalog = openReadOnlyStateCatalog(input.storageRoot);
  if (catalog.unavailable) input.onError?.(catalog.unavailable);
  const orchestration = createOrchestrationStore(input.storageRoot);
  const listeners = new Set<(state: ConversationManagerState) => void>();
  let state = emptyState(input.ownership, defaultPipelineIterations, maxPipelineIterations);
  let disposed = false;
  const watchers: FSWatcher[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const note = (error: unknown): void => {
    input.onError?.(error instanceof Error ? error.message : String(error));
  };

  const loadLedgers = async (): Promise<{
    active?: OrchestrationLedger;
    retained: OrchestrationLedger[];
  }> => {
    try {
      const runIds = await orchestration.listRunIds();
      const activeRunId = await orchestration.getActiveRun();
      const ledgers: OrchestrationLedger[] = [];
      for (const runId of runIds) {
        try {
          ledgers.push(await orchestration.load(runId));
        } catch (error) {
          note(error);
        }
      }
      const activeLedger = activeRunId === undefined
        ? undefined
        : ledgers.find((ledger) => ledger.runId === activeRunId);
      return {
        ...(activeLedger === undefined ? {} : { active: activeLedger }),
        retained: ledgers.filter((ledger) =>
          ledger.status === "completed" || ledger.status === "cleanupPending"),
      };
    } catch (error) {
      note(error);
      return { retained: [] };
    }
  };

  const read = async (): Promise<ConversationManagerState> => {
    if (disposed) return state;
    if (!catalog.present) {
      // The writer may have created the catalog after this window opened.
      const reopened = openReadOnlyStateCatalog(input.storageRoot);
      if (reopened.present) {
        catalog.close();
        catalog = reopened;
      } else if (reopened.unavailable && reopened.unavailable !== catalog.unavailable) {
        input.onError?.(reopened.unavailable);
        reopened.close();
      } else {
        reopened.close();
      }
    }
    const runs = catalog.listRuns(true);
    const conversations = runs.map((run) =>
      conversationSummaryFromCatalog(run, maxPipelineIterations));
    const activeRunRef = catalog.getActiveRunRef();
    const active = conversations.find((conversation) =>
      conversation.runRef === activeRunRef && !conversation.archived)
      ?? conversations.find((conversation) => !conversation.archived)
      ?? conversations[0];
    const results: Record<string, RunResultCenter> = {};
    runs.forEach((run) => {
      if (!run.terminalResult) return;
      results[run.legacyConversationId ?? run.runRef] = run.terminalResult;
    });
    const ledgers = await loadLedgers();
    const orchestrationSummary = summarizeOrchestration({
      // A read-only window runs nothing, so no orchestration is active in it.
      active: false,
      ...(ledgers.active ? { run: ledgers.active } : {}),
      retainedRuns: ledgers.retained.map(retainedOrchestrationSummary),
    });
    state = {
      conversations,
      activeConversationId: active?.id ?? "",
      defaultPipelineIterations,
      maxPipelineIterations,
      interactions: [],
      eventsByConversation: eventHistories(catalog, conversations, active?.id ?? ""),
      resultsByConversation: results,
      orchestration: orchestrationSummary,
      direction: catalog.longitudinalSummary(input.repositoryRoot),
      notifications: { mode: "material", unread: 0, events: [] },
      conversationLocators: {},
      readOnly: input.ownership,
    };
    return state;
  };

  const notify = (): void => {
    void read().then(
      (current) => listeners.forEach((listener) => listener(current)),
      note,
    );
  };

  const scheduleRefresh = (): void => {
    if (disposed) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      notify();
    }, 120);
    refreshTimer.unref?.();
  };

  const startPolling = (): void => {
    if (disposed || pollTimer !== undefined) return;
    pollTimer = setInterval(notify, 1_000);
    pollTimer.unref?.();
  };

  if (input.watchStorage !== false) {
    const watchDirectory = input.watchFactory
      ?? ((target, options, listener) => watch(target, options, listener));
    // The writer persists into this directory; a change there is the only signal a
    // read-only window needs to show the writer's newest state.
    let fallbackInstalled = false;
    const retainWatcher = (watcher: FSWatcher, onFailure: () => void): void => {
      watcher.unref();
      watchers.push(watcher);
      if (typeof watcher.on !== "function") return;
      watcher.on("error", (error) => {
        const index = watchers.indexOf(watcher);
        if (index >= 0) watchers.splice(index, 1);
        try {
          watcher.close();
        } catch {
          // The error may already have closed the platform handle.
        }
        note(error);
        onFailure();
      });
    };
    const watchPath = (target: string, recursive: boolean): boolean => {
      try {
        const watcher = watchDirectory(target, { recursive }, () => scheduleRefresh());
        retainWatcher(watcher, startPolling);
        return true;
      } catch (error) {
        note(error);
        return false;
      }
    };
    const installFallback = (): void => {
      if (fallbackInstalled || disposed) return;
      fallbackInstalled = true;
      const storageWatched = watchPath(input.storageRoot, false);
      const orchestrationWatched = watchPath(path.join(input.storageRoot, "orchestration"), false);
      if (!storageWatched || !orchestrationWatched) startPolling();
    };
    try {
      const watcher = watchDirectory(
        input.storageRoot,
        { recursive: true },
        () => scheduleRefresh(),
      );
      retainWatcher(watcher, installFallback);
    } catch (error) {
      note(error);
      // Recursive watching is not available on every platform: watch the two directories
      // whose contents a reader projects instead.
      installFallback();
    }
  }

  return {
    read,
    latest: () => state,
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    retainedWorktrees: () => Array.from(new Set([
      ...(state.orchestration.integrationWorktree ? [state.orchestration.integrationWorktree] : []),
      ...state.orchestration.retainedRuns.map((retained) => retained.integrationWorktree),
    ].filter((value): value is string => typeof value === "string" && value.length > 0))),
    dispose: () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      watchers.forEach((watcher) => {
        try {
          watcher.close();
        } catch {
          // A watcher the platform already closed is not a failure to report.
        }
      });
      watchers.length = 0;
      listeners.clear();
      catalog.close();
    },
  };
};
