import { readTimeoutSetting } from "./state/timeoutBounds";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { registerAdapterType, AdapterRegistration } from "./adapters/registry";
import { registerCommands } from "./commands/registerCommands";
import { registerReadOnlyCommands } from "./commands/registerReadOnlyCommands";
import { createOnboardingTracker } from "./onboarding/tracker";
import { registerTodoAuthoring } from "./todo/authoring";
import { registerConfigurationAuthoring } from "./policy/registerConfigurationAuthoring";
import {
  createResourceBroker,
  ResourceBroker,
  ResourceLease,
  resourceKey,
} from "./concurrency/resourceBroker";
import { resolveWorkspaceOwnershipAfterFailure } from "./concurrency/resolveWorkspaceOwnership";
import { ownershipReport } from "./concurrency/ownershipHandoff";
import type { OwnershipActionId } from "./concurrency/ownershipHandoff";
import {
  ConversationManager,
  createConversationManager,
  } from "./conversations/createConversationManager";
import {
  createTodoOrchestrator,
  TodoOrchestrator,
} from "./orchestrator/controller";
import {
  REPOSITORY_VERIFIER_APPROVAL_KEY,
  repositoryVerifiersApproved,
  verifierRegistryDigest,
  withoutRepositoryVerifierApproval,
} from "./orchestrator/verifierApproval";
import { parseVerifierRegistry, VERIFIER_REGISTRY_PATH } from "./orchestrator/verifierRegistry";
import {
  createWorkspaceMutationFence,
  WorkspaceMutationFence,
} from "./state/workspaceMutationFence";
import { canonicalWorkspaceStateIdentity } from "./state/workspaceIdentity";
import { resolveRepositoryScope } from "./commands/repositoryScope";
import { mutationClassForCommand, refuseMutation } from "./state/readOnlyWorkspace";
import { createReadOnlyProductService } from "./state/readOnlyProductState";
import { createReadOnlyManager } from "./state/readOnlyManager";
import type { OwnershipView } from "./state/readOnlyWorkspace";
import {
  focusPipelinePanel,
  registerPipelinePanelSerializer,
  runPipelinePanelUiAction,
  runPipelinePanelUiScenario,
  setPipelinePanelOutput,
  waitForPipelinePanelReady,
} from "./webview/openPipelinePanel";

export type HumanE2eApi = {
  getManagerState: ConversationManager["getState"];
  flush: ConversationManager["flush"];
  waitForWebviewReady: () => Promise<void>;
  runWebviewScenario: typeof runPipelinePanelUiScenario;
  runWebviewAction: typeof runPipelinePanelUiAction;
};

export type BachataExtensionApi = {
  registerAdapter: (
    adapterType: string,
    registration: AdapterRegistration,
  ) => { dispose: () => void };
  humanE2e?: HumanE2eApi;
};

let manager: ConversationManager | undefined;
let orchestrator: TodoOrchestrator | undefined;
let resourceBroker: ResourceBroker | undefined;
let workspaceStateLease: ResourceLease | undefined;
let workspaceMutationFence: WorkspaceMutationFence | undefined;
const checklistOrchestrators = new Set<TodoOrchestrator>();

const workspaceRoot = (): string => {
  const scope = resolveRepositoryScope();
  if (scope.root !== undefined) {
    return scope.root;
  }
  if (scope.empty) {
    throw new Error("Open a workspace folder before running TODO orchestration");
  }
  throw new Error("Open a file in the target workspace folder before running TODO orchestration");
};

/*
 * The descriptor set this repository declares right now, as the approval records it. The run
 * authority is a synchronous answer given while a run is starting, so the registry is read
 * synchronously here; a registry that cannot be read or does not parse yields no digest, and
 * the authority that asked refuses rather than honouring an approval it cannot match.
 */
const declaredVerifierRegistryDigest = (repositoryRoot: string): string | undefined => {
  try {
    const source = readFileSync(
      path.join(repositoryRoot, ...VERIFIER_REGISTRY_PATH.split("/")),
      "utf8",
    );
    if (source.length > 262_144) return undefined;
    const parsed = parseVerifierRegistry(JSON.parse(source));
    return parsed.registry === undefined ? undefined : verifierRegistryDigest(parsed.registry);
  } catch {
    return undefined;
  }
};

let readOnlyOwnership: OwnershipView | undefined;

// Commands a read-only window may still run: they read state and never write it.
const READ_ONLY_COMMANDS = new Set([
  "bachata.open",
  "bachata.doctor",
  "bachata.explainPipeline",
  "bachata.inspectRunBundle",
  "bachata.localData",
  "bachata.ownership",
]);

const registerBlockedCommands = (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  broker: ResourceBroker,
  reason: string,
): vscode.Disposable[] => {
  const blocked = [
    "bachata.open",
    "bachata.setup",
    "bachata.doctor",
    "bachata.reviewFile",
    "bachata.reviewSelection",
    "bachata.reviewStagedDiff",
    "bachata.reviewUncommitted",
    "bachata.reviewBranch",
    "bachata.reviewCommit",
    "bachata.reviewCommitRange",
    "bachata.publishFindings",
    "bachata.recordExternalEvidence",
    "bachata.replayRun",
    "bachata.inspectRunBundle",
    "bachata.explainPipeline",
    "bachata.verifiers",
    "bachata.bootstrapConfiguration",
    "bachata.fixDiagnostic",
    "bachata.improve",
    "bachata.todo.start",
    "bachata.todo.resume",
    "bachata.todo.stop",
    "bachata.todo.abandon",
    "bachata.todo.status",
    "bachata.todo.preview",
    "bachata.localData",
    "bachata.remediate",
  ].filter((command) => !READ_ONLY_COMMANDS.has(command))
    .map((command) => vscode.commands.registerCommand(command, async () => {
      // Every mutation class refuses here, whether it was invoked from the UI or
      // programmatically, and says who owns the repository and how to take it.
      const refusal = refuseMutation(
        mutationClassForCommand(command),
        readOnlyOwnership ?? { owned: false, reason, retryCommand: "Bachata: Workspace Ownership" },
      );
      output.appendLine(refusal.message);
      await vscode.window.showErrorMessage(`Bachata: ${refusal.message}`);
    }));
  const clear = vscode.commands.registerCommand("bachata.resources.clearQuarantine", async () => {
    const quarantined = broker.listQuarantine();
    if (quarantined.length === 0) {
      await vscode.window.showInformationMessage("No resources are quarantined.");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      quarantined.map((item) => ({
        label: item.key,
        description: item.reason,
        detail: new Date(item.quarantinedAt).toLocaleString(),
        key: item.key,
      })),
      {
        canPickMany: true,
        placeHolder: "Select resources only after confirming their processes and services are stopped",
        title: "Bachata: Clear Resource Quarantine",
      },
    );
    if (!selected || selected.length === 0) {
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Clear quarantine for ${String(selected.length)} resource${selected.length === 1 ? "" : "s"}?`,
      { modal: true, detail: "Clearing quarantine does not stop orphan processes or reset databases." },
      "Clear",
    );
    if (confirmation !== "Clear") {
      return;
    }
    broker.clearQuarantine(selected.map((item) => item.key));
  });
  context.subscriptions.push(...blocked, clear);
  return [...blocked, clear];
};

const workspaceOwnerStaleMs = 15_000;

const SHOW_OUTPUT_LABEL = "Show Output";

// An ownership report states a situation; it never confirms anything, so it interrupts nothing.
// Its detail is longer than a notification renders, so the Output channel carries it in full.
const presentOwnershipReport = async (
  report: ReturnType<typeof ownershipReport>,
  output: vscode.OutputChannel,
): Promise<OwnershipActionId | undefined> => {
  output.appendLine(`${report.title}\n${report.detail}`);
  const choice = await vscode.window.showInformationMessage(
    report.title,
    { modal: false },
    ...report.actions.map((action) => action.label),
    SHOW_OUTPUT_LABEL,
  );
  if (choice === SHOW_OUTPUT_LABEL) {
    output.show(true);
    return undefined;
  }
  return report.actions.find((action) => action.label === choice)?.id;
};

type GitExtensionExports = {
  readonly getAPI: (version: 1) => { readonly repositories: readonly unknown[] };
};

const workspaceIsGitRepository = async (): Promise<boolean> => {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return false;
  const git = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (git) {
    try {
      const api = (git.isActive ? git.exports : await git.activate()).getAPI(1);
      if (api.repositories.length > 0) return true;
    } catch {
      // The built-in Git extension is disabled or still starting; the entry below is the proof.
    }
  }
  const probed = await Promise.all(folders.map(async (folder) => {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ".git"));
      return true;
    } catch {
      return false;
    }
  }));
  return probed.some((present) => present);
};

const activeEditorHasDiagnostics = (): boolean => {
  const editor = vscode.window.activeTextEditor;
  return editor !== undefined && vscode.languages.getDiagnostics(editor.document.uri).length > 0;
};

// The states menus and command enablement are allowed to read. Each one is recomputed from the
// event that can change it, never polled, and nothing here blocks activation.
const registerContextKeys = (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  todoOrchestrator: TodoOrchestrator,
): void => {
  const publish = (key: string, value: boolean): void => {
    void Promise.resolve(vscode.commands.executeCommand("setContext", key, value)).then(
      undefined,
      (error: unknown) => {
        output.appendLine(
          `Context key ${key} could not be published: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  };
  const refreshGitRepository = (): void => {
    void workspaceIsGitRepository().then(
      (present) => publish("bachata.workspaceIsGitRepository", present),
      (error: unknown) => {
        output.appendLine(
          `Git repository detection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        publish("bachata.workspaceIsGitRepository", false);
      },
    );
  };
  const refreshDiagnostics = (): void => {
    publish("bachata.activeEditorHasDiagnostics", activeEditorHasDiagnostics());
  };
  const refreshTodoRun = (): void => {
    publish("bachata.todoRunLoaded", todoOrchestrator.getSnapshot().run !== undefined);
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refreshGitRepository),
    vscode.window.onDidChangeActiveTextEditor(refreshDiagnostics),
    vscode.languages.onDidChangeDiagnostics(refreshDiagnostics),
    todoOrchestrator.onDidChange(refreshTodoRun),
  );
  refreshGitRepository();
  refreshDiagnostics();
  refreshTodoRun();
};

export const activate = async (context: vscode.ExtensionContext): Promise<BachataExtensionApi> => {
  const output = vscode.window.createOutputChannel("Bachata");
  const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
  try {
    resourceBroker = createResourceBroker({
      databasePath: path.join(context.globalStorageUri.fsPath, "concurrency", "resources.sqlite"),
    });
  } catch (error) {
    // Activation still fails: this window coordinates with every other one through the broker
    // and must not run without it (docs/CONCURRENCY.md). What is repaired here is the way out —
    // the channel is disposed instead of leaked, and because there is then no channel to read
    // the reason in, it is shown instead.
    const reason = `Bachata could not open its coordination store, so this window did not start: ${error instanceof Error ? error.message : String(error)}`;
    output.dispose();
    void vscode.window.showErrorMessage(reason).then(undefined, () => undefined);
    throw error;
  }
  // Set only once the broker is open: a failed activation must leave no disposed channel behind
  // in the panel module's global.
  setPipelinePanelOutput(output);
  const broker = resourceBroker;
  const brokerStartedAt = Date.now();
  const writerIdentity = canonicalWorkspaceStateIdentity(storageRoot);
  const acquireWorkspaceWriterLease = async (): Promise<ResourceLease> =>
    broker.acquire({
      resources: [{
        key: resourceKey("workspace-state-writer", writerIdentity),
        kind: "abstract",
      }],
      deadlineAt: Date.now() + Math.max(
        250,
        readTimeoutSetting(
          (settingKey, settingFallback) =>
            vscode.workspace.getConfiguration("bachata").get(settingKey, settingFallback),
          "workspaceOwnerTimeoutMs",
          1_500,
        ),
      ),
      label: "workspace state ownership",
    });
  // Everything this window can learn about the writer that holds the workspace: whether the
  // lease is held and how long ago that owner last reported. The broker records its owner as an
  // opaque id, so there is nothing here to name the other window by.
  const describeWorkspaceWriter = (): { held: boolean; ageMs: number | undefined } => {
    const holder = broker.describeLeaseHolder(resourceKey("workspace-state-writer", writerIdentity));
    return {
      held: holder.held,
      ageMs: holder.held && holder.heartbeatAt !== undefined
        ? Math.max(0, Date.now() - holder.heartbeatAt)
        : undefined,
    };
  };
  try {
    workspaceStateLease = await acquireWorkspaceWriterLease();
  } catch (error) {
    const holderAgeMs = describeWorkspaceWriter().ageMs;
    const holderNote = holderAgeMs === undefined
      ? ""
      : ` The other writer was active ${Math.round(holderAgeMs / 1_000)}s ago.`;
    const reason = `This workspace is already controlled by another Bachata Extension Host using the same profile state store. Close the other window, then reload this window.${holderNote}`;
    output.appendLine(`${reason} ${error instanceof Error ? error.message : String(error)}`);
    workspaceStateLease = await resolveWorkspaceOwnershipAfterFailure({
      initialReason: reason,
      prompt: async (message) => vscode.window.showErrorMessage(`Bachata: ${message}`, "Retry", "Dismiss"),
      waitForRetry: async () => {
        const graceElapsed = Date.now() - brokerStartedAt;
        if (graceElapsed < 15_000) {
          await new Promise((resolve) => setTimeout(resolve, 15_000 - graceElapsed + 250));
        }
      },
      acquire: acquireWorkspaceWriterLease,
      retryReason: () => `${reason} Still unavailable after retry.`,
      block: (blockedReason) => {
        // A window that did not win ownership is read-only, not dead: it still shows the
        // product, and every mutation refuses at the command boundary below.
        const blockedHolderAgeMs = describeWorkspaceWriter().ageMs;
        readOnlyOwnership = {
          owned: false,
          reason: blockedReason,
          ...(blockedHolderAgeMs === undefined
            ? {}
            : { holderLastSeenSecondsAgo: Math.round(blockedHolderAgeMs / 1_000) }),
          retryCommand: "Bachata: Workspace Ownership",
        };
        output.appendLine(blockedReason);
        registerBlockedCommands(context, output, broker, blockedReason);
        // The real read-only product: the normal panel, opened over the state the writer
        // persisted. It takes no lease and no fencing token, and constructs no runtime,
        // provider, Bridge, orchestrator or writable catalog. Every mutation refuses at the
        // command boundary above and at the protocol boundary below the panel.
        const configuration = vscode.workspace.getConfiguration("bachata");
        const readOnlyState = createReadOnlyProductService({
          storageRoot,
          ...(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath === undefined
            ? {}
            : { repositoryRoot: vscode.workspace.workspaceFolders[0].uri.fsPath }),
          ownership: readOnlyOwnership,
          defaultPipelineIterations: configuration.get<number>("defaultPipelineIterations", 1),
          maxPipelineIterations: configuration.get<number>("maxPipelineIterations", 10),
          onError: (message) => output.appendLine(message),
        });
        const readOnlyManager = createReadOnlyManager({
          service: readOnlyState,
          ownership: readOnlyOwnership,
          onRefusal: (message) => output.appendLine(message),
        });
        context.subscriptions.push(
          registerPipelinePanelSerializer(context, readOnlyManager),
          { dispose: () => readOnlyManager.dispose() },
          { dispose: () => readOnlyState.dispose() },
          ...registerReadOnlyCommands(
            context,
            output,
            readOnlyManager,
            readOnlyState,
            readOnlyOwnership,
          ),
        );
        context.subscriptions.push(vscode.commands.registerCommand("bachata.ownership", async () => {
          const current = describeWorkspaceWriter();
          const action = await presentOwnershipReport(ownershipReport({
            owned: false,
            blockedReason,
            holderHeld: current.held,
            ...(current.ageMs === undefined ? {} : { holderHeartbeatAgeMs: current.ageMs }),
            staleOwnerMs: workspaceOwnerStaleMs,
            activeWork: [],
          }), output);
          if (action === "reload") {
            await vscode.commands.executeCommand("workbench.action.reloadWindow");
            return;
          }
          if (action !== "retry") return;
          try {
            const lease = await acquireWorkspaceWriterLease();
            await lease.release();
            const reload = await vscode.window.showInformationMessage(
              "Bachata can take ownership of this workspace now. Reload the window to start.",
              "Reload window",
            );
            if (reload === "Reload window") {
              await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          } catch (retryError) {
            await vscode.window.showWarningMessage(
              `Bachata still cannot take ownership: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
            );
          }
        }));
      },
      notifyRetryFailure: async (retryReason) => {
        await vscode.window.showErrorMessage(`Bachata: ${retryReason}`);
      },
    });
    if (!workspaceStateLease) {
      context.subscriptions.push(output);
      return { registerAdapter: registerAdapterType };
    }
  }
  try {
    const workspaceResourceKey = workspaceStateLease.resources.find((resource) =>
      resource.key.startsWith("workspace-state-writer:")
    )?.key;
    const workspaceFenceToken = workspaceResourceKey
      ? workspaceStateLease.fences[workspaceResourceKey]
      : undefined;
    if (!workspaceResourceKey || workspaceFenceToken === undefined) {
      throw new Error("Workspace ownership lease has no writer fencing token");
    }
    workspaceMutationFence = await createWorkspaceMutationFence(storageRoot, {
      resourceKey: workspaceResourceKey,
      token: workspaceFenceToken,
      assertWritable: () => workspaceStateLease?.assertValid(),
    });
    const withWorkspaceMutation = workspaceMutationFence.run;
    manager = createConversationManager(context, output, {
      resourceBroker,
      workspaceLease: workspaceStateLease,
      withWorkspaceMutation,
      focusInteraction: (target) => {
        if (manager) {
          focusPipelinePanel(context, manager, target);
        }
      },
    });
    context.subscriptions.push(registerPipelinePanelSerializer(context, manager));
    orchestrator = createTodoOrchestrator({
      storageRoot,
      workspaceRoot,
      isWorkspaceTrusted: () => vscode.workspace.isTrusted,
      configuration: () => vscode.workspace.getConfiguration("bachata"),
      output,
      manager,
      resourceBroker,
      workspaceLease: workspaceStateLease,
      withWorkspaceMutation,
      // The run authority asks whether the approval covers the descriptor set this repository
      // declares now, not whether some approval was recorded once: a registry edited after the
      // approval — or an approval recorded before digests existed — is not authority to run.
      // The digest travels with the answer, not just the verdict. Checks execute inside a task
      // worktree and read that worktree's copy of the registry, so the authority decided here at
      // the repository root has to name the descriptor set it granted; without it a task that
      // rewrote the registry in its own worktree would be checked against its own rewrite.
      approvedRepositoryVerifiers: (repositoryRoot) => {
        const declaredDigest = declaredVerifierRegistryDigest(repositoryRoot);
        const approved = vscode.workspace.isTrusted &&
          declaredDigest !== undefined &&
          repositoryVerifiersApproved(
            context.workspaceState.get<unknown>(REPOSITORY_VERIFIER_APPROVAL_KEY),
            repositoryRoot,
            declaredDigest,
          );
        return approved && declaredDigest !== undefined
          ? { approved, registryDigest: declaredDigest }
          : { approved };
      },
    });
    manager.setTodoOrchestrator(orchestrator);
    manager.setChecklistExecutor(async ({
      conversationId,
      runRef,
      title,
      workingDirectory,
      request,
    }) => {
      if (request.checklist.selectedIssueIds.length === 0) {
        return {
          runRef,
          status: "completed",
          workingDirectory,
        };
      }
      if (request.signal?.aborted) {
        return {
          runRef,
          status: "stopped",
          workingDirectory,
        };
      }
      if (!request.pipelineSnapshot) {
        throw new Error(
          `Checklist step ${request.step.id} has no immutable task-pipeline snapshot`,
        );
      }
      const sourceHash = createHash("sha256")
        .update(JSON.stringify({
          step: request.step,
          checklist: request.checklist,
          pipelineSnapshot: {
            hash: request.pipelineSnapshot.hash,
            scopeKey: request.pipelineSnapshot.scopeKey,
            scopeRoot: request.pipelineSnapshot.scopeRoot,
          },
        }))
        .digest("hex")
        .slice(0, 16);
      const childStorageRoot = path.join(
        storageRoot,
        "orchestration",
        "embedded",
        runRef,
        request.step.id,
        sourceHash,
      );
      const child = createTodoOrchestrator({
        storageRoot: childStorageRoot,
        workspaceRoot: () => workingDirectory,
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        configuration: () => vscode.workspace.getConfiguration("bachata"),
        output,
        manager: manager as ConversationManager,
        ...(resourceBroker === undefined ? {} : { resourceBroker }),
        ...(workspaceStateLease === undefined ? {} : { workspaceLease: workspaceStateLease }),
        withWorkspaceMutation,
      });
      checklistOrchestrators.add(child);
      const stop = (): void => {
        void child.stop().catch((error: unknown) => {
          output.appendLine(`Bachata checklist orchestrator stop failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      request.signal?.addEventListener("abort", stop, { once: true });
      try {
        const result =
          (await child.resumeIfAvailable()) ??
          (await child.startChecklist({
            workspaceRoot: workingDirectory,
            parentRunRef: runRef,
            parentConversationId: conversationId,
            title,
            pipelineId: request.step.pipelineId,
            pipelineSnapshot: request.pipelineSnapshot,
            issues: request.checklist.issues,
            selectedIssueIds: request.checklist.selectedIssueIds,
            userNote: request.checklist.userNote,
            allowedPaths: request.step.allowedPaths,
            checks: request.step.checks,
            checkResources: request.step.checkResources ?? [],
            allowedDirtyPaths: request.allowedDirtyPaths ?? [],
            allowNoChecks: request.step.allowNoChecks === true,
            retries: request.step.retries ?? 1,
            maxConcurrency: request.step.maxConcurrency ?? 2,
          }));
        const status =
          result.status === "completed" ||
          result.status === "stopped" ||
          result.status === "failed" ||
          result.status === "blocked" ||
          result.status === "abandoned"
            ? result.status
            : "failed";
        return {
          runRef: result.runId,
          status,
          workingDirectory: result.integrationWorktree,
          ...(result.integrationBranch === undefined
            ? {}
            : { integrationBranch: result.integrationBranch }),
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      } finally {
        request.signal?.removeEventListener("abort", stop);
        checklistOrchestrators.delete(child);
        await child.dispose();
      }
    }, async ({ workingDirectory, allowedDirtyPaths }) => {
      if (!orchestrator) {
        throw new Error("Checklist execution preflight is unavailable");
      }
      await orchestrator.preflightChecklist({
        workspaceRoot: workingDirectory,
        allowedDirtyPaths,
      });
    });
    const onboarding = createOnboardingTracker(context);
    await onboarding.publish();
    manager.setOnboardingObserver((event) => {
      void onboarding.record(event).then(undefined, (onboardingError) => {
        output.appendLine(
          `Onboarding progress could not be stored: ${onboardingError instanceof Error ? onboardingError.message : String(onboardingError)}`,
        );
      });
    });
    const activeOrchestrator = orchestrator;
    const ownershipCommand = vscode.commands.registerCommand("bachata.ownership", async () => {
      const snapshot = activeOrchestrator.getSnapshot();
      const activeWork = [
        ...(snapshot.active ? ["a TODO orchestration run is executing"] : []),
        ...(snapshot.retainedRuns.length > 0
          ? [`${String(snapshot.retainedRuns.length)} retained run${snapshot.retainedRuns.length === 1 ? "" : "s"} still hold Git worktrees`]
          : []),
      ];
      const action = await presentOwnershipReport(ownershipReport({
        owned: true,
        holderHeld: true,
        staleOwnerMs: workspaceOwnerStaleMs,
        activeWork,
      }), output);
      if (action !== "release") return;
      const confirmation = await vscode.window.showWarningMessage(
        "Release workspace ownership?",
        {
          modal: true,
          detail: "This window stops writing Bachata state and reloads. Another window can then take ownership. Nothing is deleted.",
        },
        "Release and reload",
      );
      if (confirmation !== "Release and reload") return;
      output.appendLine("Releasing workspace state ownership on request");
      await deactivate();
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
    const commands = registerCommands(context, manager, orchestrator, output, resourceBroker, onboarding);
    context.subscriptions.push(ownershipCommand);
    const todoAuthoring = registerTodoAuthoring(context, output);
    const configurationAuthoring = registerConfigurationAuthoring(
      output,
      context.extensionUri.fsPath,
      {
        // EX-G6-08. Approval is per repository now, so this reports and removes the approval
        // for the repository this window resolves rather than one flag for the whole window.
        isRecorded: () => {
          try {
            return repositoryVerifiersApproved(
              context.workspaceState.get<unknown>(REPOSITORY_VERIFIER_APPROVAL_KEY),
              path.resolve(workspaceRoot()),
            );
          } catch {
            return false;
          }
        },
        remove: async () => {
          await context.workspaceState.update(
            REPOSITORY_VERIFIER_APPROVAL_KEY,
            withoutRepositoryVerifierApproval(
              context.workspaceState.get<unknown>(REPOSITORY_VERIFIER_APPROVAL_KEY),
              path.resolve(workspaceRoot()),
            ),
          );
        },
      },
    );
    context.subscriptions.push(output, ...commands, ...todoAuthoring, ...configurationAuthoring);
    registerContextKeys(context, output, orchestrator);
    const setupOfferedKey = "bachata.setup.offered.v1";
    // Setup walks the user into choosing a workflow and creating its run. A restricted-mode
    // window brings up everything that only reads, and offers Setup when trust arrives instead.
    const offerFirstRunSetup = async (): Promise<void> => {
      if (
        !vscode.workspace.isTrusted ||
        !vscode.workspace.workspaceFolders?.length ||
        context.workspaceState.get<boolean>(setupOfferedKey) === true
      ) {
        return;
      }
      await context.workspaceState.update(setupOfferedKey, true);
      void vscode.commands.executeCommand("bachata.setup").then(undefined, (setupError) => {
        output.appendLine(`First-run Setup could not open: ${setupError instanceof Error ? setupError.message : String(setupError)}`);
      });
    };
    await offerFirstRunSetup();
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void offerFirstRunSetup().then(undefined, (trustError: unknown) => {
        output.appendLine(`First-run Setup could not open after workspace trust was granted: ${trustError instanceof Error ? trustError.message : String(trustError)}`);
      });
    }));
    const activeManager = manager;
    const humanE2e =
      process.env.BACHATA_HUMAN_E2E === "1" &&
      // `--extensionTestsPath` puts the host in Test mode, not Development mode, so a suite driven
      // that way was refused the API it exists to drive. Both are development modes; neither is a
      // published install, and the environment variable is still the gate.
      (context.extensionMode === vscode.ExtensionMode.Development ||
        context.extensionMode === vscode.ExtensionMode.Test)
        ? {
          getManagerState: activeManager.getState,
          flush: activeManager.flush,
          waitForWebviewReady: waitForPipelinePanelReady,
          runWebviewScenario: runPipelinePanelUiScenario,
          runWebviewAction: runPipelinePanelUiAction,
        }
      : undefined;
    return {
      registerAdapter: registerAdapterType,
      ...(humanE2e ? { humanE2e } : {}),
    };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await deactivate();
    } catch (failure) {
      cleanupError = failure;
    }
    output.dispose();
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Bachata activation failed and cleanup could not be confirmed",
      );
    }
    throw error;
  }
};

export const deactivate = async (): Promise<void> => {
  const failures: unknown[] = [];
  const capture = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  await capture(async () => {
    const results = await Promise.allSettled(
      Array.from(checklistOrchestrators, (value) => value.dispose()),
    );
    results.forEach((result) => {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    });
  });
  checklistOrchestrators.clear();
  await capture(async () => orchestrator?.dispose());
  orchestrator = undefined;
  await capture(async () => manager?.dispose());
  manager = undefined;
  await capture(async () => workspaceMutationFence?.dispose());
  workspaceMutationFence = undefined;
  if (workspaceStateLease) {
    const lease = workspaceStateLease;
    try {
      await lease.release();
    } catch (releaseError) {
      try {
        await lease.quarantine(
          `Workspace state ownership cleanup was not confirmed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
      } catch (quarantineError) {
        failures.push(new AggregateError(
          [releaseError, quarantineError],
          "Workspace state ownership could neither be released nor quarantined",
        ));
      }
    } finally {
      if (workspaceStateLease === lease) {
        workspaceStateLease = undefined;
      }
    }
  }
  await capture(async () => resourceBroker?.dispose());
  resourceBroker = undefined;
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Bachata deactivation cleanup failed: ${failures
        .map((failure) => failure instanceof Error ? failure.message : String(failure))
        .join("; ")}`,
    );
  }
};
