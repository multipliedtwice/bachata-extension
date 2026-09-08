import * as vscode from "vscode";

import type { TodoOrchestrator } from "../orchestrator/controller";
import type { OrchestrationRunStatus } from "../orchestrator/types";
import { extensionVersion } from "../version";

export const LAUNCHER_VIEW_ID = "bachata.launcher";

export type LauncherItem = {
  readonly label: string;
  readonly description?: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly ariaLabel: string;
  readonly command?: string;
};

const identityItem = (): LauncherItem => ({
  label: `Bachata ${extensionVersion}`,
  tooltip: "Human-directed multi-agent review and refinement",
  icon: "verified",
  ariaLabel: `Bachata version ${extensionVersion}`,
});

// The stored status is an internal state name. What the sidebar shows, and what a screen
// reader announces, is what that state means to the person reading it.
const runStatusLabels: Record<OrchestrationRunStatus, string> = {
  preparing: "Preparing",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  completed: "Completed",
  blocked: "Waiting on you",
  failed: "Failed",
  abandoning: "Abandoning",
  cleanupPending: "Cleaning up",
  abandoned: "Abandoned",
};

const statusItem = (orchestrator: TodoOrchestrator): LauncherItem => {
  const snapshot = orchestrator.getSnapshot();
  const run = snapshot.run;
  if (!run) {
    return {
      label: "No TODO run loaded",
      description: "Reviews and fixes run in the panel",
      tooltip: "No TODO orchestration run is loaded. Reviews and fixes run in the Bachata panel.",
      icon: "circle-outline",
      ariaLabel: "Bachata status: no TODO orchestration run is loaded",
    };
  }
  const tasks = Object.values(run.tasks);
  const completed = tasks.filter((task) => task.status === "done").length;
  const state = runStatusLabels[run.status];
  const blocked = run.status === "blocked";
  return {
    label: `${state} · ${String(completed)}/${String(tasks.length)}`,
    description: run.integrationBranch,
    tooltip: blocked
      ? `This run is waiting on your decision · ${run.integrationBranch}`
      : `${state} · ${run.integrationBranch}`,
    icon: blocked ? "warning" : snapshot.active ? "sync" : "git-branch",
    ariaLabel: `Bachata status: ${state}, ${String(completed)} of ${String(tasks.length)} tasks done`,
  };
};

const actionItems: readonly LauncherItem[] = [
  {
    label: "Open Bachata",
    tooltip: "Open the Bachata panel",
    icon: "window",
    ariaLabel: "Open the Bachata panel",
    command: "bachata.open",
  },
  {
    label: "Review uncommitted changes",
    tooltip: "Start a review of your uncommitted changes",
    icon: "git-pull-request",
    ariaLabel: "Start a review of your uncommitted changes",
    command: "bachata.reviewUncommitted",
  },
  {
    label: "Set up a workflow",
    tooltip: "Choose a workflow",
    icon: "settings-gear",
    ariaLabel: "Open Bachata Setup",
    command: "bachata.setup",
  },
  {
    label: "Run Doctor",
    tooltip: "Check provider readiness",
    icon: "pulse",
    ariaLabel: "Run Bachata Doctor",
    command: "bachata.doctor",
  },
];

export const launcherItems = (orchestrator: TodoOrchestrator): LauncherItem[] => [
  identityItem(),
  statusItem(orchestrator),
  ...actionItems,
];

export type LauncherProvider = vscode.TreeDataProvider<LauncherItem> & vscode.Disposable;

const RELOAD_COMMAND = "workbench.action.reloadWindow";

const launcherTreeItem = (element: LauncherItem): vscode.TreeItem => {
  const item = new vscode.TreeItem(element.label);
  if (element.description !== undefined) {
    item.description = element.description;
  }
  item.tooltip = element.tooltip;
  item.iconPath = new vscode.ThemeIcon(element.icon);
  item.accessibilityInformation = { label: element.ariaLabel };
  if (element.command) {
    item.command = { command: element.command, title: element.label };
  }
  return item;
};

/**
 * A read-only window still shows the product, so its launcher opens the panel first and then
 * offers the readable commands and the ownership report. It offers no command that mutates.
 */
export const readOnlyLauncherItems = (reason: string): LauncherItem[] => [
  {
    label: "Open Bachata (read-only)",
    description: reason,
    tooltip: reason,
    icon: "window",
    ariaLabel: `Open the Bachata panel in read-only mode: ${reason}`,
    command: "bachata.open",
  },
  {
    label: "Run Doctor",
    tooltip: "Check what this window can see without owning the workspace",
    icon: "pulse",
    ariaLabel: "Run Bachata Doctor",
    command: "bachata.doctor",
  },
  {
    label: "Show local data",
    tooltip: "Show everything Bachata stores locally for this workspace",
    icon: "database",
    ariaLabel: "Show Bachata local data",
    command: "bachata.localData",
  },
  {
    label: "Check workspace ownership",
    tooltip: reason,
    icon: "key",
    ariaLabel: "Check which window owns this workspace",
    command: "bachata.ownership",
  },
  {
    label: "Reload window",
    tooltip: "Reload this window once the other window has released the workspace",
    icon: "refresh",
    ariaLabel: "Reload this window",
    command: RELOAD_COMMAND,
  },
];

export const createReadOnlyLauncherProvider = (reason: string): LauncherProvider => {
  const emitter = new vscode.EventEmitter<void>();
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (element) => launcherTreeItem(element),
    getChildren: (element) => (element ? [] : readOnlyLauncherItems(reason)),
    dispose: () => {
      emitter.dispose();
    },
  };
};

export const createLauncherProvider = (orchestrator: TodoOrchestrator): LauncherProvider => {
  const emitter = new vscode.EventEmitter<void>();
  const subscription = orchestrator.onDidChange(() => emitter.fire());
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (element) => launcherTreeItem(element),
    getChildren: (element) => (element ? [] : launcherItems(orchestrator)),
    dispose: () => {
      subscription.dispose();
      emitter.dispose();
    },
  };
};
