import * as path from "node:path";

import * as vscode from "vscode";

import { buildExecutionContract } from "../contract/executionContract";
import { renderContractExplanation } from "../contract/explain";
import { inspectRunBundle, renderRunBundleReport } from "../export/runBundleReport";
import { loadRepositoryPolicy } from "../policy/repositoryPolicy";
import { describeLocalData, formatBytes } from "../state/localData";
import { readOnlyPipelines } from "../state/readOnlyPipelines";
import type { OwnershipView } from "../state/readOnlyWorkspace";
import type { ReadOnlyManager } from "../state/readOnlyManager";
import type { ReadOnlyProductService } from "../state/readOnlyProductState";
import { openPipelinePanel } from "../webview/openPipelinePanel";
import { readOnlyDoctorReport } from "./readOnlyDoctor";
import { report } from "./registerCommands";
import { createReadOnlyLauncherProvider, LAUNCHER_VIEW_ID } from "./launcherView";

/**
 * The commands a window that did not win ownership actually runs.
 *
 * Each one reads: the panel renders the writer's persisted state, Doctor reports what reading
 * proves, Explain reads pipeline definitions from disk, Inspect reads a bundle file the user
 * chooses, and Local Data describes what is stored without offering to delete any of it.
 */
export const registerReadOnlyCommands = (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  manager: ReadOnlyManager,
  service: ReadOnlyProductService,
  ownership: OwnershipView,
): vscode.Disposable[] => {
  const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => folder.uri.fsPath,
  );
  const launcher = createReadOnlyLauncherProvider(ownership.reason);
  const pipelines = async (): ReturnType<typeof readOnlyPipelines> => readOnlyPipelines({
    extensionDirectory: context.extensionUri.fsPath,
    workspaceRoots,
  });

  return [
    launcher,
    vscode.window.registerTreeDataProvider(LAUNCHER_VIEW_ID, launcher),
    vscode.commands.registerCommand("bachata.open", () => {
      openPipelinePanel(context, manager);
    }),
    vscode.commands.registerCommand("bachata.doctor", () => report(output, async () => {
      const state = await service.read();
      const checks = readOnlyDoctorReport({
        ownershipReason: ownership.reason,
        retryCommand: ownership.retryCommand,
        catalogPresent: state.conversations.length > 0 || state.direction.initiative !== undefined,
        catalogPath: path.join(storageRoot, "bachata-state.sqlite"),
        runCount: state.conversations.length,
        ...(state.direction.initiative === undefined
          ? {}
          : { initiativeTitle: state.direction.initiative.title }),
        retainedRuns: state.orchestration.retainedRuns.length,
        retainedWorktrees: service.retainedWorktrees(),
        pipelineCount: (await pipelines()).length,
      });
      checks.forEach((check) => {
        output.appendLine(`${check.ok ? "ok" : check.blocking ? "BLOCK" : "optional"} ${check.name}: ${check.detail}`);
      });
      const choice = await vscode.window.showWarningMessage(
        `Bachata Doctor: this window is read-only. ${ownership.reason}`,
        "Show Output",
        "Check workspace ownership",
      );
      if (choice === "Show Output") output.show(true);
      if (choice === "Check workspace ownership") {
        await vscode.commands.executeCommand("bachata.ownership");
      }
    })),
    vscode.commands.registerCommand("bachata.explainPipeline", () => report(output, async () => {
      const available = await pipelines();
      if (available.length === 0) {
        void vscode.window.showInformationMessage("No pipeline is available to explain.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        available.map((pipeline) => ({
          label: pipeline.definition.name,
          description: pipeline.definition.id,
          detail: pipeline.source === "preset" ? "Shipped preset" : pipeline.filePath,
          pipeline,
        })),
        {
          title: "Explain a pipeline without running it",
          placeHolder: "Select a pipeline",
          ignoreFocusOut: true,
        },
      );
      if (!picked) return;
      const workingDirectory = workspaceRoots[0];
      const policy = workingDirectory === undefined
        ? { policy: undefined, errors: [] as string[] }
        : await loadRepositoryPolicy(workingDirectory);
      const state = service.latest();
      const contract = buildExecutionContract({
        pipeline: picked.pipeline.definition,
        maxIterations: state.maxPipelineIterations,
        iterations: state.defaultPipelineIterations,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
        ...(policy.policy === undefined ? {} : { repositoryPolicy: policy.policy }),
        ...(policy.errors.length === 0 ? {} : { repositoryPolicyErrors: policy.errors }),
      });
      const document = await vscode.workspace.openTextDocument({
        content: [
          `> This window is read-only. ${ownership.reason}`,
          "",
          renderContractExplanation(contract),
        ].join("\n"),
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })),
    vscode.commands.registerCommand("bachata.inspectRunBundle", () => report(output, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Inspect",
        filters: { "Bachata run bundle": ["json"] },
      });
      const file = picked?.[0];
      if (!file) return;
      const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
      const inspection = inspectRunBundle(source);
      const document = await vscode.workspace.openTextDocument({
        content: renderRunBundleReport(inspection),
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: true });
      if ("integrity" in inspection && inspection.integrity.state === "mismatch") {
        void vscode.window.showWarningMessage(
          `This run bundle's recorded digest does not match the file. ${inspection.integrity.statement}`,
        );
      }
    })),
    vscode.commands.registerCommand("bachata.localData", () => report(output, async () => {
      await service.read();
      const entries = await describeLocalData({
        storageRoot,
        catalogPath: path.join(storageRoot, "bachata-state.sqlite"),
        retainedWorktrees: service.retainedWorktrees(),
      });
      entries.forEach((entry) => {
        output.appendLine(`${entry.label}: ${formatBytes(entry.bytes)} · ${String(entry.fileCount)} files · ${entry.path}`);
      });
      const selected = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.label,
          description: `${formatBytes(entry.bytes)} · ${String(entry.fileCount)} file${entry.fileCount === 1 ? "" : "s"}`,
          detail: entry.path,
          entry,
        })),
        {
          title: "Bachata: Local Data (read-only)",
          placeHolder: `Everything Bachata stores locally · ${storageRoot}`,
        },
      );
      if (!selected) return;
      // Deletion belongs to the window that owns the workspace: offering it here would race
      // the writer's own catalog.
      const choice = await vscode.window.showInformationMessage(
        `${selected.entry.label}: ${formatBytes(selected.entry.bytes)} in ${String(selected.entry.fileCount)} file${selected.entry.fileCount === 1 ? "" : "s"} at ${selected.entry.path}. This window cannot delete stored data.`,
        "Reveal in file explorer",
      );
      if (choice === "Reveal in file explorer" && selected.entry.category !== "worktrees") {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(selected.entry.path));
      }
    })),
  ];
};
