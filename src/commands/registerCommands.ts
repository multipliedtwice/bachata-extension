import { sha256EvidenceCopy } from "../security/fileHash";
import * as path from "node:path";

import * as vscode from "vscode";

import { ConversationManager } from "../conversations/createConversationManager";
import { ResourceBroker } from "../concurrency/resourceBroker";
import { TodoOrchestrator } from "../orchestrator/controller";
import { focusPipelinePanel, openPipelinePanel } from "../webview/openPipelinePanel";
import { resolveRepositoryRoot } from "./repositoryScope";
import {
  completeSetup,
  parseSetupState,
  pendingSetup,
  resolveWorkflowCards,
  resumableSetup,
  workflowCards,
} from "../workflows/catalog";
import type { WorkflowCardState, WorkflowModeState } from "../workflows/catalog";
import { createCommandDraft, DraftScope, isReviewableGitRef } from "../context/commandDraft";
import { reviewCandidate } from "../context/reviewScope";
import { publishRunFindings } from "../results/publishFindings";
import { extensionVersion } from "../version";
import { parseRunBundle, replayDriftSummary, replayPlan } from "../export/runBundleImport";
import { inspectRunBundle, renderRunBundleReport } from "../export/runBundleReport";
import { buildExecutionContract, controllerCheckSummary } from "../contract/executionContract";
import { renderContractExplanation } from "../contract/explain";
import { loadRepositoryPolicy } from "../policy/repositoryPolicy";
import type { GitReviewScope } from "../context/commandDraft";
import { buildProductDoctorReport } from "./doctorReport";
import type { RepositoryVerifierState } from "./doctorReport";
import { discoverVerifiers } from "../bootstrap/discoverVerifiers";
import { loadVerifierRegistry } from "../orchestrator/verifierRegistryStore";
import { verifierCommand } from "../orchestrator/verifierRegistry";
import {
  REPOSITORY_VERIFIER_APPROVAL_KEY,
  repositoryVerifiersApproved,
  withRepositoryVerifierApproval,
  REPOSITORY_VERIFIER_APPROVAL_TITLE,
  repositoryVerifierApprovalDetail,
  verifierRegistryDigest,
} from "../orchestrator/verifierApproval";
import { createDoctorDependencies } from "./doctor";
import { resolveCodexCommandSetting } from "../providers/codexExecutable";
import { createLauncherProvider, LAUNCHER_VIEW_ID } from "./launcherView";
import { evaluateGitVersionSupport } from "../process/gitVersionSupport";
import { parsePorcelainDirtyPaths } from "../readiness/gitStatus";
import { remediationPlan } from "../readiness/remediation";
import { archivedRunCandidates, describeLocalData, formatBytes } from "../state/localData";
import { guardrailStatements } from "../workflows/guardrails";
import { captureRunSettings } from "../runtime/settingsSnapshot";
import { knownProviderAdapters, providerDisplayName } from "../pipeline/providerNames";
import {
  recommendWorkflow,
  workflowRecommendationStatement,
  type WorkflowConsequence,
} from "../workflows/recommendation";
import type { OnboardingTracker } from "../onboarding/tracker";
import type { RemediationAction, RemediationRecheck } from "../readiness/remediation";

const setupStorageKey = "bachata.setup.v1";

const missingExecutable = (message: string): string | undefined =>
  /spawn (\S+) ENOENT/u.exec(message)?.[1];

const SHOW_OUTPUT_LABEL = vscode.l10n.t("Show Output");
const SHOW_STEPS_LABEL = vscode.l10n.t("Show Steps");

// The detail is already in the Output channel, so every failure offers the way to it rather
// than leaving the exception text as the whole of what the user is told.
export const report = async (
  output: vscode.OutputChannel,
  operation: () => Promise<void>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    const missing = missingExecutable(message);
    const choice = await vscode.window.showErrorMessage(
      missing === undefined
        ? vscode.l10n.t("Bachata: {0}", message)
        : vscode.l10n.t("Bachata could not start \"{0}\". Install it, or set its command in the Bachata settings.", missing),
      ...(missing === undefined ? [SHOW_OUTPUT_LABEL] : [SHOW_OUTPUT_LABEL, vscode.l10n.t("Run Doctor")]),
    );
    if (choice === SHOW_OUTPUT_LABEL) {
      output.show(true);
      return;
    }
    if (choice === vscode.l10n.t("Run Doctor")) await vscode.commands.executeCommand("bachata.doctor");
  }
};

export const registerCommands = (
  context: vscode.ExtensionContext,
  manager: ConversationManager,
  orchestrator: TodoOrchestrator,
  output: vscode.OutputChannel,
  resourceBroker?: ResourceBroker,
  onboarding?: OnboardingTracker,
): vscode.Disposable[] => {
  // EX-G6-08. Readiness belongs to the repository whose providers and workflows were inspected,
  // and that is the repository Improve would execute in — the same resolution, not the first
  // workspace folder, which in a multi-root window is a different repository.
  const activeRepositoryRoot = resolveRepositoryRoot;

  const availableLocalProviders = (
    adapters: Array<{ type: string; available: boolean }> | undefined,
  ): number => new Set(
    (adapters ?? [])
      .filter((adapter) => adapter.available &&
        (adapter.type === "codex-app-server" || adapter.type === "claude-code" ||
          adapter.type === "zai-glm"))
      .map((adapter) => adapter.type),
  ).size;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = "bachata.open";
  status.name = vscode.l10n.t("Bachata TODO orchestration");
  const updateStatus = (): void => {
    const snapshot = orchestrator.getSnapshot();
    const run = snapshot.run;
    if (!run) {
      // Nothing to report is not a status: the entry comes back the moment a run does.
      status.hide();
      return;
    }
    const tasks = Object.values(run.tasks);
    const completed = tasks.filter((task) => task.status === "done").length;
    status.text = `${snapshot.active ? "$(sync~spin)" : "$(git-branch)"} Bachata ${String(completed)}/${String(tasks.length)}`;
    status.tooltip = vscode.l10n.t("Open Bachata · {0} · {1}", run.status, run.integrationBranch);
    status.show();
  };
  updateStatus();
  const statusSubscription = orchestrator.onDidChange(updateStatus);
  // The explorer and editor menus invoke with a Uri; the Source Control menu invokes with the
  // resource state of the changed file, whose Uri is one field in.
  const commandTargetUri = (
    target: vscode.Uri | vscode.SourceControlResourceState | undefined,
  ): vscode.Uri | undefined => {
    if (target === undefined) return undefined;
    return "resourceUri" in target ? target.resourceUri : target;
  };
  const resolveDraftRoot = async (
    target: vscode.Uri | undefined,
  ): Promise<{ root?: string; canceled: boolean }> => {
    const owner = target ? vscode.workspace.getWorkspaceFolder(target) : undefined;
    if (owner) return { root: owner.uri.fsPath, canceled: false };
    const folders = vscode.workspace.workspaceFolders ?? [];
    const [onlyFolder] = folders;
    if (!onlyFolder) return { canceled: false };
    if (folders.length === 1) return { root: onlyFolder.uri.fsPath, canceled: false };
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: vscode.l10n.t("Select the repository this Bachata run targets"),
    });
    return picked ? { root: picked.uri.fsPath, canceled: false } : { canceled: true };
  };
  const selectDiagnostic = (
    target: vscode.Uri,
    editor: vscode.TextEditor | undefined,
  ): vscode.Diagnostic | undefined => {
    const diagnostics = vscode.languages.getDiagnostics(target);
    if (diagnostics.length === 0) return undefined;
    if (!editor || editor.document.uri.toString() !== target.toString()) {
      return diagnostics[0];
    }
    const line = editor.selection.start.line;
    return diagnostics.find(
      (item) => item.range.start.line <= line && item.range.end.line >= line,
    ) ?? diagnostics.reduce((closest, item) =>
      Math.abs(item.range.start.line - line) < Math.abs(closest.range.start.line - line)
        ? item
        : closest,
    );
  };
  // The Problems panel passes the right-clicked marker as the command's second argument. It is
  // used only when it carries the fields the draft reads; anything else falls back to the
  // diagnostic under the cursor.
  const invokedDiagnostic = (
    value: vscode.Diagnostic | undefined,
  ): vscode.Diagnostic | undefined =>
    value !== undefined && typeof value.message === "string" &&
      typeof value.range?.start?.line === "number"
      ? value
      : undefined;
  const askRef = async (prompt: string, value?: string): Promise<string | undefined> => {
    const answer = await vscode.window.showInputBox({
      prompt,
      ...(value === undefined ? {} : { value }),
      ignoreFocusOut: true,
      validateInput: (candidate) => candidate.trim().length === 0
        ? vscode.l10n.t("A Git ref is required")
        : isReviewableGitRef(candidate.trim())
          ? undefined
          : vscode.l10n.t("This is not a reviewable Git ref"),
    });
    return answer?.trim() || undefined;
  };

  const askGitScope = async (
    scope: GitReviewScope["scope"],
  ): Promise<Omit<GitReviewScope, "scope"> | undefined> => {
    if (scope === "stagedDiff" || scope === "uncommitted") return {};
    if (scope === "branchAgainstBase") {
      const baseRef = await askRef(vscode.l10n.t("Base ref to compare this branch against"), "main");
      return baseRef === undefined ? undefined : { baseRef, headRef: "HEAD" };
    }
    if (scope === "commit") {
      const commit = await askRef(vscode.l10n.t("Commit to review"), "HEAD");
      return commit === undefined ? undefined : { commit };
    }
    const baseRef = await askRef(vscode.l10n.t("First commit of the range"));
    if (baseRef === undefined) return undefined;
    const headRef = await askRef(vscode.l10n.t("Last commit of the range"), "HEAD");
    return headRef === undefined ? undefined : { baseRef, headRef };
  };

  const openGitReviewDraft = async (scope: GitReviewScope["scope"]): Promise<void> => {
    const git = await askGitScope(scope);
    if (git === undefined) return;
    await openDraft(scope, undefined, git);
  };

  // A review command must run the workflow Setup chose, but a stored selection is only
  // authority for the goal it was chosen for. Carrying it onto another action would let a
  // read-only pipeline take a Fix, or a write-capable one take a Review.
  const readOnlyDraftScope = (scope: DraftScope): boolean => scope !== "diagnostic";

  const reusableSetupPipeline = async (scope: DraftScope): Promise<string | undefined> => {
    const setup = parseSetupState(context.workspaceState.get(setupStorageKey));
    const pipelineId = setup?.pipelineId;
    if (pipelineId === undefined || setup?.goalId !== "review") return undefined;
    if (!readOnlyDraftScope(scope)) return undefined;
    const readiness = await manager.inspectActiveReadiness([pipelineId]);
    return readiness.pipelineSafetyLevels?.[pipelineId] === "review" ? pipelineId : undefined;
  };

  /*
   * An initiative-required workflow states its need before a draft exists, not after the
   * human has written a prompt and pressed send. Run-local workflows are untouched: the
   * requirement is read from the pipeline that will actually run.
   */
  // Read-only: discovery proposes, it never writes. `.bachata/verifiers.json` is written only
  // by the bootstrap command, behind a preview and a modal confirmation.
  const repositoryVerifierState = async (
    workspaceRoot: string | undefined,
  ): Promise<RepositoryVerifierState | undefined> => {
    if (workspaceRoot === undefined) return undefined;
    const [registry, discovery] = await Promise.all([
      loadVerifierRegistry(workspaceRoot),
      discoverVerifiers(workspaceRoot),
    ]);
    return {
      registryPresent: registry.present,
      proposalCount: discovery.proposals.length,
      declaredVerifierIds: (registry.registry?.verifiers ?? []).map((verifier) => verifier.id),
    };
  };

  /*
   * A dirty checkout is the normal state of the repository Bachata is asked to improve. Both
   * orchestration entry points offer the same seal: the selected changes are copied into the
   * isolated run as its starting point, and the branch, index and working tree are untouched.
   */
  const collectSealedInput = async (): Promise<{ sealedInputPaths: string[]; canceled: boolean }> => {
    const dirty = await orchestrator.dirtyRepositoryPaths();
    if (dirty.length === 0) return { sealedInputPaths: [], canceled: false };
    const picked = await vscode.window.showQuickPick(
      dirty.map((value) => ({ label: value, picked: true })),
      {
        title: vscode.l10n.t("Seal working-tree changes as this run's input?"),
        placeHolder: vscode.l10n.t("Selected changes are copied into the isolated run. Your branch and index are not touched."),
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (picked === undefined) return { sealedInputPaths: [], canceled: true };
    const sealedInputPaths = picked.map((item) => item.label);
    if (sealedInputPaths.length === 0) return { sealedInputPaths, canceled: false };
    const sealConfirmation = await vscode.window.showWarningMessage(
      (sealedInputPaths.length === 1 ? vscode.l10n.t("Seal {0} working-tree path as this run's input?", String(sealedInputPaths.length)) : vscode.l10n.t("Seal {0} working-tree paths as this run's input?", String(sealedInputPaths.length))),
      {
        modal: true,
        detail: [
          vscode.l10n.t("Bachata copies these changes into the run's isolated worktree and records them as the run's starting point."),
          vscode.l10n.t("Nothing is committed, your branch does not move, and your index and working tree are not modified."),
          vscode.l10n.t("The run's own diff is measured against this sealed input, so applying the result never re-applies your own changes."),
          "",
          ...sealedInputPaths.slice(0, 20),
        ].join("\n"),
      },
      vscode.l10n.t("Seal these changes"),
    );
    if (sealConfirmation !== vscode.l10n.t("Seal these changes")) return { sealedInputPaths: [], canceled: true };
    return { sealedInputPaths, canceled: false };
  };

  const collectInitiative = async (
    workspaceRoot: string | undefined,
    title: string,
  ): Promise<boolean> => {
    if (manager.hasInitiative(workspaceRoot)) return true;
    const goal = await vscode.window.showInputBox({
      title,
      prompt: vscode.l10n.t("Bachata records this work against a durable goal you state. It never invents one."),
      placeHolder: vscode.l10n.t("e.g. every retry path is bounded and cancellable"),
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length === 0
        ? vscode.l10n.t("State the goal, or press Escape to stop.")
        : undefined,
    });
    if (goal === undefined || goal.trim().length === 0) return false;
    manager.defineInitiative({
      title: goal.trim().slice(0, 200),
      goal: goal.trim(),
      ...(workspaceRoot === undefined ? {} : { workingDirectory: workspaceRoot }),
    });
    return true;
  };

  const initiativeReadyForDraft = async (
    workspaceRoot: string | undefined,
    pipelineId: string | undefined,
  ): Promise<boolean> => {
    if (manager.hasInitiative(workspaceRoot)) return true;
    const required = await manager.pipelineRequiresInitiative(pipelineId);
    if (!required) {
      // The workflow is not known to need one. Offer rather than block, so a run-local
      // workflow is never gated and an unselected one still gets the chance to record.
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t("This repository has no initiative. Work that records against one refuses to start without it."),
        { modal: true, detail: vscode.l10n.t("State the goal now, or continue and choose a run-local workflow.") },
        vscode.l10n.t("State the goal"),
        vscode.l10n.t("Continue without one"),
      );
      if (choice === vscode.l10n.t("State the goal")) {
        await collectInitiative(workspaceRoot, vscode.l10n.t("Bachata: what is this initiative's goal?"));
      }
      return choice !== undefined;
    }
    const stated = await collectInitiative(
      workspaceRoot,
      vscode.l10n.t("Bachata: what is this initiative's goal?"),
    );
    if (!stated) {
      await vscode.window.showWarningMessage(
        vscode.l10n.t("Bachata stopped: this workflow records its result against an initiative, and none was stated."),
      );
    }
    return stated;
  };

  const openDraft = async (
    scope: DraftScope,
    uri?: vscode.Uri,
    git?: Omit<GitReviewScope, "scope">,
    selected?: vscode.Diagnostic,
  ): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    const target = uri ?? editor?.document.uri;
    const resolvedRoot = await resolveDraftRoot(target);
    if (resolvedRoot.canceled) return;
    const workspaceRoot = resolvedRoot.root;
    const diagnostic = scope !== "diagnostic"
      ? undefined
      : selected ?? (target ? selectDiagnostic(target, editor) : undefined);
    const draft = createCommandDraft({
      scope,
      ...(target?.fsPath === undefined ? {} : { filePath: target.fsPath }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ...(scope === "selection" && editor && target?.toString() === editor.document.uri.toString()
        ? {
          selection: {
            startLine: editor.selection.start.line + 1,
            endLine: editor.selection.end.line + 1,
            text: editor.document.getText(editor.selection),
          },
        }
        : {}),
      ...(diagnostic
        ? {
          diagnostic: {
            message: diagnostic.message,
            ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
            line: diagnostic.range.start.line + 1,
          },
        }
        : {}),
      ...(git === undefined ? {} : { git }),
    });
    const chosenPipelineId = await reusableSetupPipeline(scope);
    if (!await initiativeReadyForDraft(workspaceRoot, chosenPipelineId)) return;
    // Setup already created a run for this workflow and is waiting for a prompt. Filling it
    // is the journey's one run; creating a second would strand the first empty forever.
    const setupState = parseSetupState(context.workspaceState.get(setupStorageKey));
    const adoptable = chosenPipelineId !== undefined ? setupState?.conversationId : undefined;
    if (adoptable !== undefined &&
      await manager.adoptIdleConversation(adoptable, draft.prompt, draft.title, workspaceRoot)) {
      await context.workspaceState.update(
        setupStorageKey,
        completeSetup(setupState?.goalId ?? "review", chosenPipelineId, new Date()),
      );
      focusPipelinePanel(context, manager, { conversationId: adoptable });
      return;
    }
    // What this review actually reads, recorded with the run so its evidence states the
    // exact scope and can never be relabelled as a comprehensive fresh review.
    const candidate = reviewCandidate({
      scope,
      ...(git === undefined ? {} : { git }),
      ...(target?.fsPath === undefined ? {} : { filePath: target.fsPath }),
    });
    const conversation = await manager.createConversation({
      title: draft.title,
      preparedDraft: draft.prompt,
      ...(workspaceRoot === undefined ? {} : { workingDirectory: workspaceRoot }),
      reviewCandidate: candidate,
      ...(chosenPipelineId === undefined ? {} : { pipelineId: chosenPipelineId }),
    });
    focusPipelinePanel(context, manager, { conversationId: conversation.id });
  };
  const openBundledDocument = async (document: string): Promise<void> => {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(
        vscode.Uri.joinPath(context.extensionUri, ...document.split("/")).fsPath,
      ),
    );
  };
  const performRemediationAction = async (action: RemediationAction): Promise<void> => {
    if (action.kind === "chooseWorkingDirectory") {
      // The panel owns the run, so the choice is made there. Opening a folder through VS Code
      // would change the window instead of the root this run is pointed at.
      openPipelinePanel(context, manager);
      await manager.chooseWorkingDirectory();
      return;
    }
    if (action.kind === "runCommand") {
      await vscode.commands.executeCommand(action.command);
      return;
    }
    if (action.kind === "openSettings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", action.setting);
      return;
    }
    if (action.kind === "openDocument") {
      await openBundledDocument(action.document);
      return;
    }
    if (action.kind === "openExternal") {
      await vscode.env.openExternal(vscode.Uri.parse(action.url));
      return;
    }
    const terminalCwd = vscode.workspace.workspaceFolders?.[0]?.uri;
    const terminal = vscode.window.createTerminal({
      name: vscode.l10n.t("Bachata remediation"),
      ...(terminalCwd === undefined ? {} : { cwd: terminalCwd }),
    });
    terminal.show(true);
    terminal.sendText([action.command, ...action.args].join(" "), true);
  };
  const runRemediationRecheck = async (
    recheck: RemediationRecheck,
  ): Promise<{ ok: boolean; detail: string } | undefined> => {
    if (recheck.kind === "none") return undefined;
    if (recheck.kind === "readiness") {
      await vscode.commands.executeCommand("bachata.doctor");
      return undefined;
    }
    const dependencies = createDoctorDependencies();
    if (recheck.kind === "provider") {
      const command = recheck.provider === "codex"
        ? dependencies.codexCommand
        : dependencies.claudeCommand;
      try {
        return { ok: true, detail: `${command}: ${await dependencies.providerVersion(command)}` };
      } catch (error) {
        return {
          ok: false,
          detail: vscode.l10n.t("{0} is still unavailable: {1}", command, error instanceof Error ? error.message : String(error)),
        };
      }
    }
    if (recheck.kind === "git") {
      try {
        const support = evaluateGitVersionSupport(await dependencies.gitVersion());
        return { ok: support.supported, detail: support.supported ? support.reported : support.requirementText };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!dependencies.gitStatus) return undefined;
    try {
      const dirty = parsePorcelainDirtyPaths(await dependencies.gitStatus());
      return dirty.length === 0
        ? { ok: true, detail: vscode.l10n.t("Workspace is clean") }
        : { ok: false, detail: vscode.l10n.t("Still uncommitted: {0}", dirty.slice(0, 8).join(", ")) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  };
  const reportRecheck = async (
    label: string,
    result: { ok: boolean; detail: string } | undefined,
  ): Promise<void> => {
    if (!result) return;
    output.appendLine(`${result.ok ? "ok" : "BLOCK"} ${label}: ${result.detail}`);
    if (result.ok) {
      await vscode.window.showInformationMessage(vscode.l10n.t("Bachata: {0}", result.detail));
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Bachata: {0}", result.detail),
      vscode.l10n.t("Run Doctor"),
    );
    if (choice === vscode.l10n.t("Run Doctor")) await vscode.commands.executeCommand("bachata.doctor");
  };
  const runDoctorRemediation = async (
    remediationId: string,
    detail?: string,
  ): Promise<void> => {
    const configuration = vscode.workspace.getConfiguration("bachata");
    const plan = remediationPlan(remediationId, {
      ...(detail === undefined ? {} : { detail }),
      codexCommand: resolveCodexCommandSetting((key, fallback) =>
        String(configuration.get(key, fallback)),
      ),
      claudeCommand: String(configuration.get("claudeCommand", "claude")),
      ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
    });
    if (remediationId === "bridge.connect" || remediationId === "bridge.selectSession") {
      openPipelinePanel(context, manager);
    }
    const offeredActions = plan.actions.slice(0, 3);
    const buttons = [
      ...offeredActions.map((action) => action.label),
      ...(plan.recheck.kind === "none" || plan.recheck.kind === "readiness"
        ? []
        : [plan.recheck.label]),
    ];
    // Guidance is not a confirmation: the steps go to the Output channel, which keeps them
    // readable and copyable, and the notification stays out of the way.
    const numberedSteps = plan.steps.map((step, index) => `${String(index + 1)}. ${step}`);
    output.appendLine(`${plan.title}: ${plan.condition}`);
    numberedSteps.forEach((step) => output.appendLine(step));
    // A plan whose first action is the remedy itself opens that remedy. Choosing the working
    // directory is the whole of "the selected folder is not a Git repository", and a notification
    // asking the reader to press a second button to reach the picker explained nothing the panel
    // had not already said. The guidance is still written to the Output channel above.
    const [leadAction] = plan.actions;
    if (leadAction?.kind === "chooseWorkingDirectory") {
      await performRemediationAction(leadAction);
      await reportRecheck(
        plan.recheck.kind === "none" ? plan.id : plan.recheck.label,
        await runRemediationRecheck(plan.recheck),
      );
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      plan.title,
      { modal: false },
      ...buttons,
      ...(numberedSteps.length === 0 ? [] : [SHOW_STEPS_LABEL]),
    );
    if (!choice) return;
    if (choice === SHOW_STEPS_LABEL) {
      output.show(true);
      return;
    }
    const action = offeredActions.find((candidate) => candidate.label === choice);
    if (!action) {
      await reportRecheck(
        plan.recheck.kind === "none" ? plan.id : plan.recheck.label,
        await runRemediationRecheck(plan.recheck),
      );
      return;
    }
    await performRemediationAction(action);
    if (action.kind === "openSettings" || action.kind === "runInTerminal" || action.kind === "openExternal") {
      if (plan.recheck.kind === "none" || plan.recheck.kind === "readiness") return;
      const follow = await vscode.window.showInformationMessage(
        vscode.l10n.t("Bachata: {0} when the change is in place.", plan.recheck.label),
        plan.recheck.label,
      );
      if (follow === plan.recheck.label) {
        await reportRecheck(plan.recheck.label, await runRemediationRecheck(plan.recheck));
      }
      return;
    }
    await reportRecheck(
      plan.recheck.kind === "none" ? plan.id : plan.recheck.label,
      await runRemediationRecheck(plan.recheck),
    );
  };

  const findingsDiagnostics = vscode.languages.createDiagnosticCollection("bachata.findings");

  const launcher = createLauncherProvider(orchestrator);
  const launcherView = vscode.window.createTreeView(LAUNCHER_VIEW_ID, {
    treeDataProvider: launcher,
  });
  // A run that is blocked, and a retained run still holding a worktree, both wait on a decision
  // only the user can make, so the Activity Bar carries their count.
  const updateLauncherBadge = (): void => {
    const snapshot = orchestrator.getSnapshot();
    const waiting = (snapshot.run?.status === "blocked" ? 1 : 0) + snapshot.retainedRuns.length;
    launcherView.badge = waiting === 0
      ? undefined
      : {
        value: waiting,
        tooltip: (waiting === 1 ? vscode.l10n.t("{0} run waiting on you", String(waiting)) : vscode.l10n.t("{0} runs waiting on you", String(waiting))),
      };
  };
  updateLauncherBadge();
  const launcherBadgeSubscription = orchestrator.onDidChange(updateLauncherBadge);

  return [
    status,
    statusSubscription,
    launcher,
    launcherView,
    launcherBadgeSubscription,
    vscode.commands.registerCommand("bachata.open", () => {
      openPipelinePanel(context, manager);
    }),
    vscode.commands.registerCommand(
      "bachata.reviewFile",
      (target?: vscode.Uri | vscode.SourceControlResourceState) =>
        report(output, () => openDraft("file", commandTargetUri(target))),
    ),
    vscode.commands.registerCommand(
      "bachata.reviewSelection",
      (target?: vscode.Uri | vscode.SourceControlResourceState) =>
        report(output, () => openDraft("selection", commandTargetUri(target))),
    ),
    findingsDiagnostics,
    vscode.commands.registerCommand("bachata.publishFindings", () => report(output, async () => {
      const managerState = manager.getState();
      const conversation = managerState.conversations.find(
        (candidate) => candidate.id === managerState.activeConversationId,
      );
      const published = publishRunFindings(
        findingsDiagnostics,
        managerState.resultsByConversation[managerState.activeConversationId],
        conversation?.workingDirectory,
      );
      if (published.located === 0 && published.unlocated === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t("This run recorded no findings to publish."));
        return;
      }
      await vscode.commands.executeCommand("workbench.actions.view.problems");
      void vscode.window.showInformationMessage(
        published.unlocated === 0
          ? vscode.l10n.t("Published {0} run finding(s) to Problems.", String(published.located))
          : vscode.l10n.t("Published {0} run finding(s) to Problems. {1} finding(s) name no file inside this repository and stay in the Result Center.", String(published.located), String(published.unlocated)),
      );
    })),
    vscode.commands.registerCommand("bachata.explainPipeline", () => report(output, async () => {
      const readiness = await manager.inspectActiveReadiness();
      type PipelinePick = vscode.QuickPickItem & { pipelineId: string };
      const choices: PipelinePick[] = readiness.pipelines.flatMap((pipeline) =>
        pipeline.pipelineId === undefined
          ? []
          : [{
            label: readiness.pipelineNames[pipeline.pipelineId] ?? pipeline.pipelineId,
            description: pipeline.pipelineId,
            detail: `${pipeline.status}${pipeline.findings.filter((finding) => finding.status !== "ready").length > 0 ? vscode.l10n.t(" · {0} unresolved", String(pipeline.findings.filter((finding) => finding.status !== "ready").length)) : ""}`,
            pipelineId: pipeline.pipelineId,
          }]);
      if (choices.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t("No pipeline is available to explain."));
        return;
      }
      const picked = await vscode.window.showQuickPick(choices, {
        title: vscode.l10n.t("Explain a pipeline without running it"),
        placeHolder: vscode.l10n.t("Select a pipeline"),
        ignoreFocusOut: true,
      });
      if (!picked?.pipelineId) return;
      const snapshot = await manager.resolvePipelineSnapshot(
        manager.getState().activeConversationId,
        picked.pipelineId,
      );
      const policy = readiness.workingDirectory === undefined
        ? { policy: undefined, errors: [] as string[] }
        : await loadRepositoryPolicy(readiness.workingDirectory);
      const pickedReadiness = readiness.pipelines.find(
        (pipeline) => pipeline.pipelineId === picked.pipelineId,
      );
      const contract = buildExecutionContract({
        pipeline: snapshot.definition,
        maxIterations: manager.getState().maxPipelineIterations,
        iterations: manager.getState().defaultPipelineIterations,
        ...(pickedReadiness === undefined ? {} : { readiness: pickedReadiness }),
        ...(readiness.workingDirectory === undefined ? {} : { workingDirectory: readiness.workingDirectory }),
        ...(policy.policy === undefined ? {} : { repositoryPolicy: policy.policy }),
        ...(policy.errors.length === 0 ? {} : { repositoryPolicyErrors: policy.errors }),
      });
      const document = await vscode.workspace.openTextDocument({
        content: renderContractExplanation(contract),
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: true });
    })),
    vscode.commands.registerCommand("bachata.replayRun", () => report(output, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t("Replay"),
        filters: { [vscode.l10n.t("Bachata run bundle")]: ["json"] },
      });
      const file = picked?.[0];
      if (!file) return;
      const source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
      const inspection = inspectRunBundle(source);
      if (!("integrity" in inspection) || inspection.integrity.state !== "verified") {
        const statement = "integrity" in inspection
          ? inspection.integrity.statement
          : inspection.errors.join("; ");
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Bachata replays only a run bundle whose recorded digest matches the file."),
          {
            modal: true,
            detail: [
              statement,
              "",
              vscode.l10n.t("The digest detects accidental change after export. It is not a signature: anyone who edits a bundle can recompute it, and it says nothing about who produced the file."),
            ].join("\n"),
          },
        );
        return;
      }
      const parsed = parseRunBundle(source);
      if (!parsed.replay) {
        throw new Error(parsed.errors.join("; ") || "This file is not a Bachata run bundle");
      }
      const readiness = await manager.inspectActiveReadiness(
        parsed.replay.pipelineId ? [parsed.replay.pipelineId] : undefined,
      );
      const pipelineHashesById: Record<string, string> = {};
      if (parsed.replay.pipelineId) {
        try {
          const snapshot = await manager.resolvePipelineSnapshot(
            manager.getState().activeConversationId,
            parsed.replay.pipelineId,
          );
          pipelineHashesById[parsed.replay.pipelineId] = snapshot.hash;
        } catch {
          // The recorded pipeline is not in this catalog; replayPlan reports it as blocking drift.
        }
      }
      const plan = replayPlan(parsed.replay, {
        pipelineHashesById,
        availableAdapters: readiness.adapters.filter((adapter) => adapter.available).map((adapter) => adapter.type),
        toolVersion: extensionVersion,
        ...(readiness.workingDirectory === undefined ? {} : { workingDirectory: readiness.workingDirectory }),
        runSettings: captureRunSettings(<T,>(key: string, fallback: T): T =>
          vscode.workspace.getConfiguration("bachata").get<T>(key, fallback)),
      });
      const summary = replayDriftSummary(plan);
      if (!plan.replayable) {
        void vscode.window.showErrorMessage(vscode.l10n.t("This run bundle cannot be replayed here.\n\n{0}", summary));
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        vscode.l10n.t("Replay {0} as a new run?", plan.source.runRef),
        {
          modal: true,
          detail: [
            vscode.l10n.t("A replay creates a new run with the recorded input and the recorded settings. It does not reuse the recorded answers, evidence, or worktree."),
            "",
            summary,
          ].join("\n"),
        },
        vscode.l10n.t("Create replay run"),
      );
      if (confirmed !== vscode.l10n.t("Create replay run")) return;
      const conversation = await manager.createConversation({
        title: vscode.l10n.t("Replay of {0}", plan.source.title),
        preparedDraft: plan.source.prompt,
        ...(plan.source.pipelineId ? { pipelineId: plan.source.pipelineId } : {}),
        ...(plan.source.runSettings ? { runSettings: plan.source.runSettings } : {}),
        ...(readiness.workingDirectory === undefined ? {} : { workingDirectory: readiness.workingDirectory }),
      });
      focusPipelinePanel(context, manager, { conversationId: conversation.id });
    })),
    vscode.commands.registerCommand("bachata.inspectRunBundle", () => report(output, async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t("Inspect"),
        filters: { [vscode.l10n.t("Bachata run bundle")]: ["json"] },
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
          vscode.l10n.t("This run bundle's recorded digest does not match the file. {0}", inspection.integrity.statement),
        );
      }
    })),
    vscode.commands.registerCommand("bachata.reviewStagedDiff", () => report(output, () => openDraft("stagedDiff"))),
    vscode.commands.registerCommand("bachata.reviewUncommitted", () => report(output, () => openGitReviewDraft("uncommitted"))),
    vscode.commands.registerCommand("bachata.reviewBranch", () => report(output, () => openGitReviewDraft("branchAgainstBase"))),
    vscode.commands.registerCommand("bachata.reviewCommit", () => report(output, () => openGitReviewDraft("commit"))),
    vscode.commands.registerCommand("bachata.reviewCommitRange", () => report(output, () => openGitReviewDraft("commitRange"))),
    vscode.commands.registerCommand(
      "bachata.fixDiagnostic",
      (uri?: vscode.Uri, selected?: vscode.Diagnostic) =>
        report(output, () => openDraft("diagnostic", uri, undefined, invokedDiagnostic(selected))),
    ),
    vscode.commands.registerCommand("bachata.setup", () =>
      report(output, async () => {
        const cards = workflowCards();
        const [readiness, todoReadiness] = await Promise.all([
          manager.inspectActiveReadiness(cards.flatMap((card) => card.pipelineIds)),
          orchestrator.inspectStartReadiness(),
        ]);
        const projected = resolveWorkflowCards(
          cards,
          readiness.pipelines,
          readiness.pipelineNames,
          { todo: todoReadiness },
          {
            pipelineProviders: readiness.pipelineProviders,
            preferredProvider: readiness.preferredProvider,
          },
        );
        const readinessRepositoryRoot = activeRepositoryRoot();
        await onboarding?.record({
          kind: "readiness",
          ...(readinessRepositoryRoot === undefined
            ? {}
            : { repositoryRoot: readinessRepositoryRoot }),
          availableProviders: availableLocalProviders(readiness.adapters),
          blockingFindings: readiness.pipelines
            .filter((pipeline) => pipeline.pipelineId === readiness.selectedPipelineId)
            .flatMap((pipeline) => pipeline.findings)
            .filter((finding) => finding.status === "blocked").length,
          ...(readiness.selectedPipelineId ? { selectedPipelineId: readiness.selectedPipelineId } : {}),
          ...(readiness.selectedPipelineId
            ? { selectedSafetyLevel: readiness.pipelineSafetyLevels?.[readiness.selectedPipelineId] }
            : {}),
        });
        const icon = { ready: "$(pass)", needsSetup: "$(tools)", blocked: "$(error)", unsupported: "$(circle-slash)" } as const;
        const statusWord = { ready: vscode.l10n.t("Ready"), needsSetup: vscode.l10n.t("Needs setup"), blocked: vscode.l10n.t("Blocked"), unsupported: vscode.l10n.t("Unsupported") } as const;
        const safetyLabel = {
          review: vscode.l10n.t("read-only"),
          interactive: vscode.l10n.t("you approve actions"),
          managed: vscode.l10n.t("controller-owned scope; writes your selected workspace with no automatic rollback"),
          orchestration: vscode.l10n.t("isolated retained work you apply selectively"),
        } as const;
        const safetyFor = (card: { id: string; pipelineId?: string }): string | undefined => {
          if (card.id === "todo") return safetyLabel.orchestration;
          const level = card.pipelineId
            ? readiness.pipelineSafetyLevels?.[card.pipelineId]
            : undefined;
          return level ? safetyLabel[level] : undefined;
        };
        const maxIterations = Math.max(
          1,
          Number(vscode.workspace.getConfiguration("bachata").get("maxPipelineIterations", 10)),
        );
        const providerLabel = (adapter: string): string =>
          adapter === "auto" ? vscode.l10n.t("Any available provider") : providerDisplayName(adapter);
        const providerDetail = (adapter: string): string => {
          if (readiness.disabledProviders.includes(adapter)) return vscode.l10n.t("Disabled in bachata.disabledProviders");
          const probe = readiness.adapters.find(
            (candidate) => candidate.agentId === undefined && candidate.type === adapter,
          );
          if (!probe) return vscode.l10n.t("Not probed on this machine");
          return probe.available ? probe.detail ?? vscode.l10n.t("Available") : probe.detail ?? vscode.l10n.t("Unavailable");
        };
        type ProviderPick = vscode.QuickPickItem & { provider?: string; manageProviders?: boolean };
        const chooseProviders = async (): Promise<void> => {
          const items: ProviderPick[] = [
            {
              label: vscode.l10n.t("{0} Any available provider", readiness.preferredProvider === "auto" ? "$(check)" : "$(blank)"),
              description: vscode.l10n.t("Bachata picks the readiest workflow"),
              detail: vscode.l10n.t("No provider is preferred. Readiness alone decides which workflow is offered."),
              provider: "auto",
            },
            ...knownProviderAdapters.map((adapter): ProviderPick => ({
              label: `${readiness.preferredProvider === adapter ? "$(check)" : "$(blank)"} ${providerLabel(adapter)}`,
              ...(readiness.disabledProviders.includes(adapter) ? { description: vscode.l10n.t("Disabled") } : {}),
              detail: providerDetail(adapter),
              provider: adapter,
            })),
            {
              label: `$(circle-slash) ${vscode.l10n.t("Manage disabled providers")}`,
              description: readiness.disabledProviders.length === 0
                ? vscode.l10n.t("None disabled")
                : readiness.disabledProviders.map(providerDisplayName).join(", "),
              detail: vscode.l10n.t("A disabled provider is refused before any turn starts and is never selected by Setup."),
              manageProviders: true,
            },
          ];
          const picked = await vscode.window.showQuickPick(items, {
            title: vscode.l10n.t("Bachata Setup: providers"),
            placeHolder: vscode.l10n.t("Which provider should run your work?"),
          });
          if (!picked) return;
          // Which provider a person can run, and which they refuse to run, is a property of
          // their machine and their accounts. Writing it into the opened folder would commit a
          // shared repository to one person's installation.
          const settingsTarget = vscode.ConfigurationTarget.Global;
          const settings = vscode.workspace.getConfiguration("bachata");
          if (picked.manageProviders) {
            const chosen = await vscode.window.showQuickPick(
              knownProviderAdapters.map((adapter) => ({
                label: providerDisplayName(adapter),
                detail: providerDetail(adapter),
                picked: readiness.disabledProviders.includes(adapter),
                provider: adapter,
              })),
              {
                title: vscode.l10n.t("Bachata Setup: disabled providers"),
                placeHolder: vscode.l10n.t("Selected providers are refused before any turn starts"),
                canPickMany: true,
              },
            );
            if (!chosen) return;
            const disabled = chosen.map((entry) => entry.provider);
            await settings.update("disabledProviders", disabled, settingsTarget);
            // A stated preference outranks readiness, so a preferred provider that is now
            // disabled would keep pinning every card to a workflow that cannot run.
            if (disabled.includes(readiness.preferredProvider)) {
              await settings.update("preferredProvider", "auto", settingsTarget);
            }
          } else if (picked.provider !== undefined) {
            if (readiness.disabledProviders.includes(picked.provider)) {
              await settings.update(
                "disabledProviders",
                readiness.disabledProviders.filter((entry) => entry !== picked.provider),
                settingsTarget,
              );
            }
            await settings.update("preferredProvider", picked.provider, settingsTarget);
          }
          await vscode.commands.executeCommand("bachata.setup");
        };
        type CardPick = vscode.QuickPickItem & { card?: WorkflowCardState; providers?: boolean };
        const cardItem = (card: WorkflowCardState): CardPick => ({
          label: `${icon[card.status]} ${card.title}`,
          description: card.status === "ready" ? vscode.l10n.t("Ready · {0}", card.readinessDetail) : statusWord[card.status],
          detail: [card.status === "ready" ? card.detail : card.readinessDetail, safetyFor(card)]
            .filter(Boolean)
            .join(" · "),
          card,
        });
        const providersEntry: CardPick = {
          label: `$(server) ${vscode.l10n.t("Providers")}`,
          description: providerLabel(readiness.preferredProvider),
          detail: readiness.disabledProviders.length === 0
            ? vscode.l10n.t("Choose which provider runs your work, or disable one.")
            : vscode.l10n.t("Disabled: {0}", readiness.disabledProviders.map(providerDisplayName).join(", ")),
          providers: true,
        };
        const advancedEntry: CardPick = {
          label: `$(gear) ${vscode.l10n.t("Advanced workflows")}`,
          description: vscode.l10n.t("TODO orchestration, browser providers, custom pipelines"),
          detail: vscode.l10n.t("Expert surfaces. A first run needs none of them."),
        };
        const journey = projected.filter((item) => item.advanced !== true);
        const advanced = projected.filter((item) => item.advanced === true);
        const unfinished = resumableSetup(
          parseSetupState(context.workspaceState.get(setupStorageKey)),
          cards,
        );
        const resumed = unfinished
          ? await vscode.window.showQuickPick(
              [
                { label: `$(debug-continue) ${vscode.l10n.t("Continue: {0}", unfinished.title)}`, resume: true },
                { label: `$(discard) ${vscode.l10n.t("Start over")}`, resume: false },
              ],
              {
                title: vscode.l10n.t("Bachata Setup"),
                placeHolder: vscode.l10n.t("You left Setup at \"{0}\". Continue where you stopped?", unfinished.title),
              },
            )
          : undefined;
        if (unfinished && !resumed) return;
        const resumedCard = resumed?.resume === true
          ? projected.find((item) => item.id === unfinished?.goalId)
          : undefined;
        const first: CardPick | undefined = resumedCard
          ? { label: resumedCard.title, card: resumedCard }
          : await vscode.window.showQuickPick(
              [...journey.map(cardItem), providersEntry, advancedEntry],
              { title: vscode.l10n.t("Bachata Setup"), placeHolder: vscode.l10n.t("What do you want to do?") },
            );
        if (!first) return;
        if (first.providers) {
          await chooseProviders();
          return;
        }
        const selected = first.card
          ? first
          : await vscode.window.showQuickPick(advanced.map(cardItem), {
              title: vscode.l10n.t("Bachata Setup: advanced workflows"),
              placeHolder: vscode.l10n.t("Expert workflows. Bachata has no hosted service; selected content goes to the providers you configure."),
            });
        const card = selected?.card;
        if (!card) return;
        await context.workspaceState.update(setupStorageKey, pendingSetup(card.id));
        if (card.id === "custom") {
          openPipelinePanel(context, manager);
          return;
        }
        type ModePick = vscode.QuickPickItem & { mode: WorkflowModeState };
        const modeItem = (mode: WorkflowModeState): ModePick => {
          const guardrails = mode.pipelineId
            ? readiness.pipelineGuardrails?.[mode.pipelineId]
            : undefined;
          const facts = guardrails
            ? [
                (guardrails.providers.length === 1 ? vscode.l10n.t("{0} provider: {1}", String(guardrails.providers.length), guardrails.providers.join(", ")) : vscode.l10n.t("{0} providers: {1}", String(guardrails.providers.length), guardrails.providers.join(", "))),
                vscode.l10n.t("Assurance: {0}", guardrails.assuranceLabel),
                vscode.l10n.t("Safety: {0}", safetyLabel[guardrails.safetyLevel]),
                vscode.l10n.t("Verification: {0}", guardrails.checks.length > 0 ? controllerCheckSummary(guardrails.checks) : vscode.l10n.t("none declared")),
                (maxIterations === 1 ? vscode.l10n.t("At most {0} iteration per run", String(maxIterations)) : vscode.l10n.t("At most {0} iterations per run", String(maxIterations))),
              ]
            : [];
          return {
            label: `${icon[mode.status]} ${mode.label}`,
            description: mode.status === "ready"
              ? vscode.l10n.t("Ready · {0}", mode.readinessDetail)
              : statusWord[mode.status],
            detail: (mode.status === "ready" ? facts : [mode.readinessDetail, ...facts]).join(" · "),
            mode,
          };
        };
        const consequenceFor = (modes: WorkflowModeState[]): WorkflowConsequence => {
          const longitudinal = manager.getState().direction;
          const level = modes
            .map((mode) => (mode.pipelineId
              ? readiness.pipelineSafetyLevels?.[mode.pipelineId]
              : undefined))
            .find((value) => value !== undefined);
          const current = (longitudinal?.externalEvidence ?? [])
            .filter((record) => record.supersededById === undefined);
          return {
            writesWorkspace: level !== undefined && level !== "review",
            // Only orchestration retains its work outside the selected workspace. A managed
            // run writes the workspace directly and Bachata never rolls it back.
            isolatedRetainedWork: level === "orchestration",
            openDecisions: (longitudinal?.direction.decisionsNeedingHuman ?? []).length,
            regressions: longitudinal?.latestComparison?.regressed.length ?? 0,
            outstandingAcceptedFindings:
              (longitudinal?.direction.outstandingAcceptedFindings ?? []).length,
            unresolvedExternalClaims: current.filter(
              (record) => record.state === "proposed" && record.humanResolution === undefined).length,
            staleExternalClaims: (longitudinal?.staleExternalEvidenceIds ?? []).length,
            contestedExternalClaims: current.filter(
              (record) => new Set(record.challenges.flatMap((entry) => entry.participantIds)).size > 1,
            ).length,
          };
        };
        const chooseMode = async (): Promise<WorkflowModeState | undefined> => {
          if (card.modes.length === 0) {
            return {
              mode: "single",
              label: card.title,
              status: card.status,
              ...(card.pipelineId === undefined ? {} : { pipelineId: card.pipelineId }),
              readinessDetail: card.readinessDetail,
            };
          }
          const runnable = card.modes.filter((mode) => mode.status === "ready");
          const singleAgentStatus = card.modes.find((mode) => mode.mode === "single")?.status;
          const pairedStatus = card.modes.find((mode) => mode.mode === "paired")?.status;
          const recommendation = recommendWorkflow({
            consequence: consequenceFor(card.modes),
            availability: {
              ...(singleAgentStatus === undefined ? {} : { singleAgent: singleAgentStatus }),
              ...(pairedStatus === undefined ? {} : { paired: pairedStatus }),
            },
          });
          // The recommendation may be that no execution shape settles the question. Setup
          // offers that route directly instead of silently substituting a shape it already
          // said would not answer. The human still chooses; nothing is blocked.
          if (recommendation.substituted?.preferred === "externalEvidenceHeavy"
            || recommendation.shape === "externalEvidenceHeavy") {
            const settle = await vscode.window.showQuickPick(
              [
                {
                  label: `$(law) ${vscode.l10n.t("Record or rule on an outside claim first")}`,
                  detail: recommendation.reasons.join("; ")
                    || vscode.l10n.t("Claims from outside this repository are unsettled."),
                  settle: true,
                },
                {
                  label: `$(debug-continue) ${vscode.l10n.t("Choose a workflow anyway")}`,
                  detail: vscode.l10n.t("The outside claims stay unsettled and keep bubbling up."),
                  settle: false,
                },
              ],
              {
                title: vscode.l10n.t("Bachata Setup: {0}", card.title),
                placeHolder: workflowRecommendationStatement(recommendation),
              },
            );
            if (settle === undefined) return undefined;
            if (settle.settle) {
              await vscode.commands.executeCommand("bachata.recordExternalEvidence");
              return undefined;
            }
          }
          const chosen = await vscode.window.showQuickPick(card.modes.map(modeItem), {
            title: vscode.l10n.t("Bachata Setup: {0}", card.title),
            placeHolder: runnable.length === 1
              ? vscode.l10n.t("Only {0} is runnable here. The other states what it needs.", runnable[0]?.label ?? vscode.l10n.t("one mode"))
              : workflowRecommendationStatement(recommendation),
          });
          return chosen?.mode;
        };
        const mode = await chooseMode();
        if (!mode) return;
        if (mode.status !== "ready" || !mode.pipelineId) {
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata Setup: {0}", mode.readinessDetail),
            vscode.l10n.t("Run Doctor"),
          ).then((choice) => choice === vscode.l10n.t("Run Doctor")
            ? vscode.commands.executeCommand("bachata.doctor")
            : undefined);
          return;
        }
        const pipelineId = mode.pipelineId;
        // Said once, where the workflow is chosen: the built-in checks are not a test suite.
        const verifierState = await repositoryVerifierState(activeRepositoryRoot());
        if (verifierState
          && verifierState.declaredVerifierIds.length === 0
          && verifierState.proposalCount > 0
          && (readiness.pipelineGuardrails?.[pipelineId]?.checks ?? []).length > 0) {
          const bootstrap = await vscode.window.showInformationMessage(
            vscode.l10n.t("This repository declares {0} check Bachata could run, and none is approved.", String(verifierState.proposalCount)),
            {
              modal: false,
              detail: vscode.l10n.t("Bachata verification covers integrity, syntax and types. No repository test suite runs until you approve a verifier, and even then Bachata starts it only during Bachata: Improve This Project."),
            },
            vscode.l10n.t("Propose repository verifiers"),
          );
          if (bootstrap === vscode.l10n.t("Propose repository verifiers")) {
            await vscode.commands.executeCommand("bachata.bootstrapConfiguration");
          }
        }
        await context.workspaceState.update(
          setupStorageKey,
          pendingSetup(card.id, pipelineId),
        );
        const setupRepositoryRoot = activeRepositoryRoot();
        await onboarding?.record({
          kind: "readiness",
          ...(setupRepositoryRoot === undefined
            ? {}
            : { repositoryRoot: setupRepositoryRoot }),
          availableProviders: availableLocalProviders(readiness.adapters),
          blockingFindings: 0,
          selectedPipelineId: pipelineId,
          ...(readiness.pipelineSafetyLevels?.[pipelineId]
            ? { selectedSafetyLevel: readiness.pipelineSafetyLevels[pipelineId] }
            : {}),
        });
        if (card.id === "todo") {
          const before = orchestrator.getSnapshot().run?.runId;
          await vscode.commands.executeCommand("bachata.todo.start");
          const after = orchestrator.getSnapshot().run?.runId;
          if (after !== undefined && after !== before) {
            await context.workspaceState.update(setupStorageKey, completeSetup(card.id, pipelineId));
          }
          return;
        }
        const resolvedRoot = await resolveDraftRoot(vscode.window.activeTextEditor?.document.uri);
        if (resolvedRoot.canceled) return;
        // A review is recorded against an initiative. Setup collects the goal here rather
        // than letting the run succeed and be dropped from Direction in silence. The goal is
        // the user's words; Bachata never invents one, and refuses instead.
        if (!await collectInitiative(resolvedRoot.root, vscode.l10n.t("Bachata Setup: what is this initiative's goal?"))) {
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata Setup stopped: a review is recorded against an initiative, and none was stated."),
          );
          return;
        }
        const readOnlyReview = readiness.pipelineSafetyLevels?.[pipelineId] === "review";
        const completion = readOnlyReview
          ? { iterations: 1, mode: "fixed" as const, requiredCleanPasses: undefined }
          : await vscode.window.showQuickPick(
              [
                {
                  label: vscode.l10n.t("One pass"),
                  detail: vscode.l10n.t("The pipeline runs once."),
                  iterations: 1,
                  mode: "fixed" as const,
                },
                {
                  label: vscode.l10n.t("Fixed iterations"),
                  detail: vscode.l10n.t("Repeat with a fresh chat up to {0} times.", String(maxIterations)),
                  iterations: Math.min(3, maxIterations),
                  mode: "fixed" as const,
                },
                {
                  label: vscode.l10n.t("Until clean"),
                  detail: vscode.l10n.t("Stop when two consecutive iterations change nothing, at most {0}.", String(maxIterations)),
                  iterations: maxIterations,
                  mode: "untilClean" as const,
                  requiredCleanPasses: 2,
                },
              ],
              { title: vscode.l10n.t("Bachata Setup: completion policy"), placeHolder: vscode.l10n.t("When is this run done?") },
            );
        if (!completion) return;
        const guardrails = readiness.pipelineGuardrails?.[pipelineId];
        if (guardrails) {
          const statements = guardrailStatements(guardrails, {
            ...(resolvedRoot.root === undefined ? {} : { workingDirectory: resolvedRoot.root }),
            iterations: completion.iterations,
            iterationMode: completion.mode,
            ...(completion.requiredCleanPasses === undefined
              ? {}
              : { requiredCleanPasses: completion.requiredCleanPasses }),
          });
          const confirmation = await vscode.window.showInformationMessage(
            vscode.l10n.t("Start with these guardrails?"),
            {
              modal: true,
              detail: [
                ...statements,
                "",
                vscode.l10n.t("Set in the advanced editor only: {0}.", guardrails.advancedOnly.join("; ")),
                "",
                vscode.l10n.t("Nothing runs until you enter a prompt and send it."),
              ].join("\n"),
            },
            vscode.l10n.t("Create the run"),
          );
          if (confirmation !== vscode.l10n.t("Create the run")) return;
        }
        const conversation = await manager.createConversation({
          title: card.title,
          pipelineId,
          ...(resolvedRoot.root === undefined ? {} : { workingDirectory: resolvedRoot.root }),
          iterationCount: completion.iterations,
        });
        await context.workspaceState.update(
          setupStorageKey,
          completeSetup(card.id, pipelineId, new Date(), conversation.id),
        );
        focusPipelinePanel(context, manager, { conversationId: conversation.id });
      }),
    ),
    vscode.commands.registerCommand("bachata.improve", () =>
      report(output, async () => {
        const sealed = await collectSealedInput();
        if (sealed.canceled) return;
        const sealedInputPaths = sealed.sealedInputPaths;
        const readiness = await orchestrator.inspectImproveReadiness({ sealedInputPaths });
        const blockers = readiness.findings.filter((finding) => finding.status !== "ready");
        if (blockers.length > 0) {
          const detail = blockers.map((finding) => `${finding.label}: ${finding.detail}`).join("\n");
          output.appendLine(`Bachata Improve preflight failed:\n${detail}`);
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata cannot improve this project yet"),
            { modal: true, detail },
          );
          return;
        }
        // EX-G6-08. The repository the readiness was computed against is the one this run would
        // execute in. Everything below — which descriptors are read, what the approval is stored
        // under, what the dialog names, and what `improve` is finally asked to run — is that one
        // repository. `activeRepositoryRoot()` is the first workspace folder, which in a
        // multi-root window is a different repository than the one that would execute.
        const workspaceRoot = readiness.workspaceRoot;
        // Approval is asked once per repository, only when it actually declares descriptors, and
        // only for the descriptors it declares today: the approval records the digest of the
        // descriptor set it was given for, so an approval that does not answer for the registry
        // on disk right now — a registry edited since, or one approved by a build that recorded
        // no descriptor set at all — asks again rather than standing.
        if (workspaceRoot !== undefined) {
          const registry = await loadVerifierRegistry(workspaceRoot);
          const descriptors = registry.registry?.verifiers ?? [];
          const commands = descriptors.map((verifier) => verifierCommand(verifier.id));
          const digest = verifierRegistryDigest(registry.registry);
          const stored = context.workspaceState.get<unknown>(REPOSITORY_VERIFIER_APPROVAL_KEY);
          const repositoryRoot = path.resolve(workspaceRoot);
          if (
            registry.present &&
            registry.errors.length === 0 &&
            commands.length > 0 &&
            !repositoryVerifiersApproved(stored, repositoryRoot, digest)
          ) {
            // A person who already approved this repository is told why they are being asked
            // again, rather than seeing the first-approval dialog a second time.
            const supersededNote = repositoryVerifiersApproved(stored, repositoryRoot)
              ? vscode.l10n.t("An earlier approval for this repository does not cover the checks it declares now, so Bachata is asking again.\n\n")
              : "";
            const approval = await vscode.window.showWarningMessage(
              REPOSITORY_VERIFIER_APPROVAL_TITLE,
              {
                modal: true,
                detail: `${supersededNote}${repositoryVerifierApprovalDetail({ workspaceRoot, commands, descriptors })}`,
              },
              vscode.l10n.t("Approve these checks"),
              vscode.l10n.t("Run without them"),
            );
            if (approval === undefined) return;
            if (approval === vscode.l10n.t("Approve these checks")) {
              await context.workspaceState.update(
                REPOSITORY_VERIFIER_APPROVAL_KEY,
                withRepositoryVerifierApproval(
                  context.workspaceState.get<unknown>(REPOSITORY_VERIFIER_APPROVAL_KEY),
                  repositoryRoot,
                  digest,
                ),
              );
            }
          }
        }
        const confirmed = await orchestrator.inspectImproveReadiness({ sealedInputPaths });
        // EX-G6-08. The window resolves its repository from the active editor, so it can have
        // moved while the approval dialog was open. The run that would start is no longer the
        // run that was approved.
        if (confirmed.workspaceRoot !== workspaceRoot) {
          await vscode.window.showWarningMessage(
            vscode.l10n.t("The active repository changed while Bachata was asking about this run"),
            {
              modal: true,
              detail: [
                vscode.l10n.t("Approved: {0}", workspaceRoot ?? vscode.l10n.t("unknown")),
                vscode.l10n.t("Active now: {0}", confirmed.workspaceRoot ?? vscode.l10n.t("unknown")),
                "",
                vscode.l10n.t("Open a file in the repository you want to improve, then run this command again."),
              ].join("\n"),
            },
          );
          return;
        }
        const contract = confirmed.contract;
        const confirmation = await vscode.window.showWarningMessage(
          confirmed.todoExecutable
            ? vscode.l10n.t("Improve this project by running its executable TODO?")
            : vscode.l10n.t("Improve this project by discovering the work first?"),
          {
            modal: true,
            detail: [
              vscode.l10n.t("Repository: {0}", workspaceRoot ?? vscode.l10n.t("unknown")),
              confirmed.todoExecutable
                ? vscode.l10n.t("Tasks: {0}", contract?.taskIds.join(", ") ?? vscode.l10n.t("declared in the TODO"))
                : vscode.l10n.t("No executable TODO ({0}). Codex and Claude audit this repository independently, cross-check every claim against source, and converge on one plan before anything is implemented.", confirmed.todoDiagnostic ?? vscode.l10n.t("unknown")),
              vscode.l10n.t("Pipelines: {0}", confirmed.bootstrapPipelineIds.join(", ")),
              vscode.l10n.t("Sealed input: {0}", sealedInputPaths.join(", ") || vscode.l10n.t("none; the run starts from HEAD")),
              vscode.l10n.t("Codex plans and reviews. Claude implements and performs one bounded revision when the review rejects a candidate."),
              vscode.l10n.t("Bachata runs the declared checks before its own Lead review, and again on the integration tree."),
              confirmed.taskPipelinesWithOwnSteps.length > 0
                ? vscode.l10n.t("These task pipelines declare their own steps and may review inside the pipeline, before those checks: {0}.", confirmed.taskPipelinesWithOwnSteps.join(", "))
                : vscode.l10n.t("No task pipeline declares a review of its own, so each candidate is reviewed once, after its checks."),
              confirmed.repositoryVerifiers === "humanApproved"
                ? vscode.l10n.t("Repository verifiers: approved for this workspace. Approval is not proof that those executables are safe.")
                : vscode.l10n.t("Repository verifiers: refused. Only bachata:workspace-integrity and bachata:project-checks run."),
              vscode.l10n.t("Commits: none. {0}", contract?.isolation ?? vscode.l10n.t("Each task runs in its own Git worktree and results merge through a separate integration worktree.")),
              vscode.l10n.t("The successful result is retained for one Apply action. Nothing is committed, pushed, or applied to your working tree automatically."),
            ].join("\n"),
          },
          vscode.l10n.t("Improve this project"),
        );
        if (confirmation !== vscode.l10n.t("Improve this project")) return;
        openPipelinePanel(context, manager);
        output.appendLine("Starting Bachata self-improvement");
        const result = await orchestrator.improve({
          sealedInputPaths,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        });
        const conversationId = result.ledger.parentConversationId ?? result.ledger.masterConversationId;
        if (conversationId) {
          focusPipelinePanel(context, manager, { conversationId });
        }
        output.appendLine(
          `Bachata Improve ${result.ledger.status} via ${result.path}: ${result.ledger.integrationBranch}`,
        );
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Bachata Improve {0}. Integration branch: {1}", result.ledger.status, result.ledger.integrationBranch),
        );
      }),
    ),
    vscode.commands.registerCommand("bachata.todo.start", () =>
      report(output, async () => {
        const sealed = await collectSealedInput();
        if (sealed.canceled) return;
        const sealedInputPaths = sealed.sealedInputPaths;
        const readiness = await orchestrator.inspectStartReadiness({ sealedInputPaths });
        const blockers = readiness.findings.filter((finding) => finding.status !== "ready");
        if (blockers.length > 0 || !readiness.contract) {
          const detail = blockers.map((finding) => `${finding.label}: ${finding.detail}`).join("\n")
            || "TODO orchestration preflight produced no run contract";
          output.appendLine(`TODO orchestration preflight failed:\n${detail}`);
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata cannot start TODO orchestration yet"),
            { modal: true, detail },
          );
          return;
        }
        const contract = readiness.contract;
        const confirmation = await vscode.window.showWarningMessage(
          vscode.l10n.t("Start unattended TODO orchestration?"),
          {
            modal: true,
            detail: [
              vscode.l10n.t("Repository: {0}", contract.workspaceRoot),
              vscode.l10n.t("Tasks: {0}", contract.taskIds.join(", ")),
              vscode.l10n.t("Task pipelines: {0} · Master: {1}", contract.taskPipelineIds.join(", "), contract.masterPipelineId),
              vscode.l10n.t("Writable paths: {0}", contract.writablePaths.join(", ") || vscode.l10n.t("declared per task")),
              vscode.l10n.t("Sealed input: {0}", sealedInputPaths.join(", ") || vscode.l10n.t("none; the run starts from HEAD")),
              vscode.l10n.t("Verification: {0}", contract.verification.join(", ") || vscode.l10n.t("none declared")),
              vscode.l10n.t("Final verification: {0}", contract.finalVerification.join(", ") || vscode.l10n.t("none declared")),
              vscode.l10n.t("Shared verification resources: {0}", contract.verificationResources.join(", ") || vscode.l10n.t("none declared")),
              vscode.l10n.t("Limits: {0} concurrent tasks, {1} retries per task", String(contract.maxConcurrency), String(contract.retries)),
              vscode.l10n.t("Commits: none. {0}.", contract.isolation),
              vscode.l10n.t("Human decisions: {0}", contract.humanDecisions.join("; ")),
              vscode.l10n.t("Completion: {0}", contract.completion.join("; ")),
            ].join("\n"),
          },
          vscode.l10n.t("Start orchestration"),
        );
        if (confirmation !== vscode.l10n.t("Start orchestration")) {
          return;
        }
        openPipelinePanel(context, manager);
        output.appendLine("Starting deterministic TODO orchestration");
        // EX-A5-R06. The repository this dialog named and the human approved, threaded into the
        // run rather than resolved again from whatever the editor is on by the time it starts.
        const result = await orchestrator.start({
          sealedInputPaths,
          ...(contract.workspaceRoot === undefined ? {} : { workspaceRoot: contract.workspaceRoot }),
        });
        const conversationId = result.parentConversationId ?? result.masterConversationId;
        if (conversationId) {
          focusPipelinePanel(context, manager, { conversationId });
        }
        output.appendLine(`TODO orchestration ${result.status}: ${result.integrationBranch}`);
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Bachata TODO {0}. Integration branch: {1}", result.status, result.integrationBranch),
        );
      }),
    ),
    vscode.commands.registerCommand("bachata.todo.resume", () =>
      report(output, async () => {
        // Every other orchestration entry point refuses an untrusted workspace before it claims
        // an owner or creates a conversation; resume is reached from the command only.
        if (!vscode.workspace.isTrusted) {
          throw new Error("Trust the workspace before running TODO orchestration");
        }
        openPipelinePanel(context, manager);
        output.appendLine("Resuming deterministic TODO orchestration");
        const result = await orchestrator.resume();
        const conversationId = result.parentConversationId ?? result.masterConversationId;
        if (conversationId) {
          focusPipelinePanel(context, manager, { conversationId });
        }
        output.appendLine(`TODO orchestration ${result.status}: ${result.integrationBranch}`);
        await vscode.window.showInformationMessage(
          vscode.l10n.t("Bachata TODO {0}. Integration branch: {1}", result.status, result.integrationBranch),
        );
      }),
    ),
    vscode.commands.registerCommand("bachata.todo.stop", () =>
      report(output, async () => {
        if (!orchestrator.getSnapshot().run) {
          await vscode.window.showInformationMessage(vscode.l10n.t("Bachata has no TODO orchestration run to stop"));
          return;
        }
        openPipelinePanel(context, manager);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Bachata is stopping the TODO orchestration run") },
          async () => {
            await orchestrator.stop();
          },
        );
        output.appendLine("TODO orchestration stopped");
        await vscode.window.showInformationMessage(vscode.l10n.t("Bachata stopped the TODO orchestration run"));
      }),
    ),
    vscode.commands.registerCommand("bachata.todo.abandon", () =>
      report(output, async () => {
        const run = orchestrator.getSnapshot().run;
        if (!run) {
          await vscode.window.showInformationMessage(vscode.l10n.t("Bachata has no TODO orchestration run to abandon"));
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t("Abandon this TODO orchestration run?"),
          {
            modal: true,
            detail: vscode.l10n.t("Integration branch: {0}\nIntegration worktree: {1}\nThe task chat history will be retained. Extension-owned worktrees and branches will be removed.", run.integrationBranch, run.integrationWorktree),
          },
          vscode.l10n.t("Abandon"),
        );
        if (choice !== vscode.l10n.t("Abandon")) {
          return;
        }
        openPipelinePanel(context, manager);
        await orchestrator.abandon();
        output.appendLine("TODO orchestration abandoned");
      }),
    ),
    vscode.commands.registerCommand("bachata.resources.clearQuarantine", () =>
      report(output, async () => {
        if (!resourceBroker) {
          throw new Error("The shared-resource broker is unavailable");
        }
        const quarantined = resourceBroker.listQuarantine();
        if (quarantined.length === 0) {
          await vscode.window.showInformationMessage(vscode.l10n.t("No resources are quarantined."));
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
            placeHolder: vscode.l10n.t("Select resources only after confirming their processes and services are stopped"),
            title: vscode.l10n.t("Bachata: Clear Resource Quarantine"),
          },
        );
        if (!selected || selected.length === 0) {
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          (selected.length === 1 ? vscode.l10n.t("Clear quarantine for {0} resource?", String(selected.length)) : vscode.l10n.t("Clear quarantine for {0} resources?", String(selected.length))),
          { modal: true, detail: vscode.l10n.t("Clearing quarantine does not stop orphan processes or reset databases.") },
          vscode.l10n.t("Clear"),
        );
        if (confirmation !== vscode.l10n.t("Clear")) {
          return;
        }
        const cleared = resourceBroker.clearQuarantine(selected.map((item) => item.key));
        output.appendLine(`Cleared ${String(cleared)} quarantined Bachata resource${cleared === 1 ? "" : "s"}`);
      }),
    ),
    vscode.commands.registerCommand(
      "bachata.remediate",
      (request?: { remediationId?: string; detail?: string }) =>
        report(output, async () => {
          if (!request?.remediationId) {
            throw new Error("A remediation id is required");
          }
          await runDoctorRemediation(request.remediationId, request.detail);
        }),
    ),
    vscode.commands.registerCommand("bachata.recordExternalEvidence", () =>
      report(output, async () => {
        // A claim from outside the repository is only evidence if the copy it was read from can
        // be identified again. The human names a saved copy and Bachata records its SHA-256; the
        // copy itself stays where the human put it and is never stored by Bachata. Without a copy
        // there is nothing to fingerprint, so Bachata refuses rather than recording an
        // unverifiable citation.
        const evidenceRepositoryRoot = activeRepositoryRoot();
        const evidenceInitiativeId = manager.getState().direction?.initiative?.id;
        const ask = async (
          title: string,
          prompt: string,
          placeHolder?: string,
          maxLength = 8000,
        ): Promise<string | undefined> => {
          const value = await vscode.window.showInputBox({
            title,
            prompt,
            ...(placeHolder === undefined ? {} : { placeHolder }),
            ignoreFocusOut: true,
            validateInput: (input) => input.length > maxLength
              ? vscode.l10n.t("Use at most {0} characters.", String(maxLength))
              : input.trim().length === 0
              ? vscode.l10n.t("State a value, or press Escape to stop.")
              : undefined,
          });
          if (value !== undefined && value.length > maxLength) throw new Error(`Evidence values must fit within ${String(maxLength)} characters`);
          return value?.trim() ? value.trim() : undefined;
        };
        const uri = await ask(
          vscode.l10n.t("Record external evidence: source"),
          vscode.l10n.t("The address this claim was read from. Bachata records it; it does not fetch it."),
          "https://…",
        );
        if (!uri) return;
        const title = await ask(vscode.l10n.t("Record external evidence: title"), vscode.l10n.t("What the source is called."));
        if (!title) return;
        const claim = await ask(
          vscode.l10n.t("Record external evidence: claim"),
          vscode.l10n.t("What this source states, in your words. Bachata never paraphrases a source for you."),
        );
        if (!claim) return;
        const relationPick = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t("Supports"), relation: "supports" as const },
            { label: vscode.l10n.t("Contradicts"), relation: "contradicts" as const },
            { label: vscode.l10n.t("Qualifies"), relation: "qualifies" as const },
          ],
          { title: vscode.l10n.t("Record external evidence: relation"), placeHolder: vscode.l10n.t("How does this claim bear on the work?") },
        );
        if (!relationPick) return;
        const authorityPick = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t("Standard"), authority: "standard" as const },
            { label: vscode.l10n.t("Vendor documentation"), authority: "vendorDocumentation" as const },
            { label: vscode.l10n.t("First-party measurement"), authority: "firstPartyMeasurement" as const },
            { label: vscode.l10n.t("Third-party report"), authority: "thirdPartyReport" as const },
            { label: vscode.l10n.t("Community"), authority: "community" as const },
            { label: vscode.l10n.t("Unattributed"), authority: "unattributed" as const },
          ],
          { title: vscode.l10n.t("Record external evidence: authority"), placeHolder: vscode.l10n.t("What stands behind this claim?") },
        );
        if (!authorityPick) return;
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: vscode.l10n.t("Fingerprint this copy"),
          title: vscode.l10n.t("Record external evidence: the copy you read"),
        });
        const file = picked?.[0];
        if (!file) {
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata records the SHA-256 of the copy a claim was read from, so the copy can be identified again. Save a copy of the source and record it again."),
          );
          return;
        }
        if (file.scheme !== "file") throw new Error("Select a saved local evidence copy");
        const evidenceDigest = await sha256EvidenceCopy(file.fsPath);
        const findings = manager.getState().direction?.findings ?? [];
        const targetPick = await vscode.window.showQuickPick([
          { label: vscode.l10n.t("Initiative"), identity: "", description: vscode.l10n.t("Record a citation without changing a finding") },
          ...findings.filter((finding) => finding.state !== "resolved" && finding.state !== "rejected")
            .map((finding) => ({ label: finding.subject, identity: finding.identity, description: finding.message })),
        ], { title: vscode.l10n.t("Record external evidence: target") });
        if (!targetPick) return;
        let verifyFinding: { requirement: string; environment: string } | undefined;
        if (targetPick.identity && relationPick.relation === "supports") {
          const purpose = await vscode.window.showQuickPick([
            { label: vscode.l10n.t("Citation about this finding"), verifies: false },
            { label: vscode.l10n.t("Evidence that this finding is fixed"), verifies: true,
              description: vscode.l10n.t("Accepting it in Direction resolves this finding only for the unchanged current candidate") },
          ], { title: vscode.l10n.t("What does this evidence establish?") });
          if (!purpose) return;
          if (purpose.verifies) {
            const requirement = await ask(vscode.l10n.t("Fix verification: acceptance criterion"), vscode.l10n.t("State the specific condition this evidence proves is satisfied."));
            if (!requirement) return;
            const environment = await ask(vscode.l10n.t("Fix verification: environment"), vscode.l10n.t("Where and how was the current candidate verified?"), undefined, 2000);
            if (!environment) return;
            verifyFinding = { requirement, environment };
          }
        }
        if (activeRepositoryRoot() !== evidenceRepositoryRoot || manager.getState().direction?.initiative?.id !== evidenceInitiativeId) {
          throw new Error("The active workspace or initiative changed while recording evidence; reopen the command for the intended initiative");
        }
        const recorded = await manager.recordExternalEvidence({
          ...(verifyFinding === undefined ? {} : { verifyFinding }),
          source: {
            uri,
            title,
            retrievedAt: new Date().toISOString(),
            contentDigest: evidenceDigest,
          },
          claim,
          relation: relationPick.relation,
          target: targetPick.identity ? { kind: "finding", identity: targetPick.identity } : { kind: "initiative" },
          authority: authorityPick.authority,
          authoredBy: "human",
          ...(evidenceRepositoryRoot === undefined
            ? {}
            : { workingDirectory: evidenceRepositoryRoot }),
        });
        if (recorded === undefined) {
          await vscode.window.showWarningMessage(
            vscode.l10n.t("Bachata recorded nothing: check the evidence fields and ensure this repository has an initiative with an open cycle."),
          );
          return;
        }
        await vscode.window.showInformationMessage(
          recorded.verification
            ? vscode.l10n.t("Recorded {0} as candidate-bound fix verification. Rule on it in Direction.", recorded.source.title)
            : vscode.l10n.t("Recorded {0} as external evidence. Rule on it in Direction.", recorded.source.title),
        );
      })),
    vscode.commands.registerCommand("bachata.localData", () =>
      report(output, async () => {
        const storageRoot = (context.storageUri ?? context.globalStorageUri).fsPath;
        const snapshot = orchestrator.getSnapshot();
        const retainedWorktrees = [
          ...(snapshot.run?.integrationWorktree ? [snapshot.run.integrationWorktree] : []),
          ...snapshot.retainedRuns
            .map((retained) => retained.integrationWorktree)
            .filter((value): value is string => typeof value === "string"),
        ];
        const entries = await describeLocalData({
          storageRoot,
          catalogPath: path.join(storageRoot, "bachata-state.sqlite"),
          retainedWorktrees: Array.from(new Set(retainedWorktrees)),
        });
        const retentionDays = Math.max(
          0,
          Number(vscode.workspace.getConfiguration("bachata").get("localDataRetentionDays", 0)),
        );
        const managerState = manager.getState();
        const candidates = await archivedRunCandidates({
          storageRoot,
          conversations: managerState.conversations.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            updatedAt: conversation.updatedAt,
            archived: conversation.archived,
            running: conversation.running,
          })),
          retentionDays,
          nowMs: Date.now(),
        });
        entries.forEach((entry) => {
          output.appendLine(`${entry.label}: ${formatBytes(entry.bytes)} · ${String(entry.fileCount)} files · ${entry.path}`);
        });
        const items = [
          ...entries.map((entry) => ({
            label: entry.label,
            description: (entry.fileCount === 1 ? vscode.l10n.t("{0} · {1} file", formatBytes(entry.bytes), String(entry.fileCount)) : vscode.l10n.t("{0} · {1} files", formatBytes(entry.bytes), String(entry.fileCount))),
            detail: entry.path,
            entry,
          })),
          {
            label: retentionDays > 0
              ? vscode.l10n.t("Delete archived run data older than {0} days", String(retentionDays))
              : vscode.l10n.t("Retention is off; set bachata.localDataRetentionDays to enable cleanup"),
            description: retentionDays > 0
              ? (candidates.length === 1 ? vscode.l10n.t("{0} run · {1}", String(candidates.length), formatBytes(candidates.reduce((total, item) => total + item.bytes, 0))) : vscode.l10n.t("{0} runs · {1}", String(candidates.length), formatBytes(candidates.reduce((total, item) => total + item.bytes, 0))))
              : vscode.l10n.t("No automatic deletion happens"),
            detail: retentionDays > 0
              ? vscode.l10n.t("Removes transcripts and attachments of archived runs. Catalog metadata and repository files stay.")
              : vscode.l10n.t("Open settings to choose a retention period"),
            cleanup: true,
          },
        ];
        const selected = await vscode.window.showQuickPick(items, {
          title: vscode.l10n.t("Bachata: Local Data"),
          placeHolder: vscode.l10n.t("Everything Bachata stores locally · {0}", storageRoot),
        });
        if (!selected) return;
        if (!("cleanup" in selected)) {
          const size = selected.entry.fileCount === 1
            ? vscode.l10n.t("{0} in {1} file", formatBytes(selected.entry.bytes), selected.entry.fileCount)
            : vscode.l10n.t("{0} in {1} files", formatBytes(selected.entry.bytes), selected.entry.fileCount);
          output.appendLine([
            selected.entry.label,
            `Location: ${selected.entry.path}`,
            `Size: ${size}`,
            `Deleting this removes: ${selected.entry.removes}`,
            `It keeps: ${selected.entry.keeps}`,
          ].join("\n"));
          const choice = await vscode.window.showInformationMessage(
            `${selected.entry.label} · ${size} · ${selected.entry.path}`,
            vscode.l10n.t("Reveal in file explorer"),
            vscode.l10n.t("Show Output"),
          );
          if (choice === vscode.l10n.t("Show Output")) output.show(true);
          if (choice === vscode.l10n.t("Reveal in file explorer") && selected.entry.category !== "worktrees") {
            await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(selected.entry.path));
          }
          return;
        }
        if (retentionDays <= 0) {
          await vscode.commands.executeCommand("workbench.action.openSettings", "bachata.localDataRetentionDays");
          return;
        }
        if (candidates.length === 0) {
          await vscode.window.showInformationMessage(vscode.l10n.t("No archived run data is older than the retention period."));
          return;
        }
        const confirmation = await vscode.window.showWarningMessage(
          (candidates.length === 1 ? vscode.l10n.t("Delete stored data for {0} archived run?", String(candidates.length)) : vscode.l10n.t("Delete stored data for {0} archived runs?", String(candidates.length))),
          {
            modal: true,
            detail: [
              vscode.l10n.t("Removed: stored transcripts and attachment files of these runs."),
              vscode.l10n.t("Kept: catalog metadata, run titles, history search, repository files, worktrees."),
              "",
              ...candidates.slice(0, 20).map((candidate) =>
                `${candidate.title} · ${candidate.updatedAt.slice(0, 10)} · ${formatBytes(candidate.bytes)}`),
              ...(candidates.length > 20 ? [vscode.l10n.t("… and {0} more", String(candidates.length - 20))] : []),
            ].join("\n"),
          },
          vscode.l10n.t("Delete"),
        );
        if (confirmation !== vscode.l10n.t("Delete")) return;
        let removed = 0;
        for (const candidate of candidates) {
          // EX-A5-R15. A conversation's data is a set of paths, not one directory: the initial
          // conversation lives in the storage root beside the catalog and every other
          // conversation, so only the entries it owns are removed.
          for (const target of candidate.paths) {
            await vscode.workspace.fs.delete(vscode.Uri.file(target), {
              recursive: true,
              useTrash: false,
            }).then(() => undefined, (error: unknown) => {
              if ((error as { code?: string }).code === "FileNotFound") return;
              throw error;
            });
            output.appendLine(`Deleted archived run storage: ${target}`);
          }
          removed += 1;
        }
        await vscode.window.showInformationMessage(
          (removed === 1 ? vscode.l10n.t("Bachata deleted stored data for {0} archived run", String(removed)) : vscode.l10n.t("Bachata deleted stored data for {0} archived runs", String(removed))),
        );
      }),
    ),
    vscode.commands.registerCommand("bachata.doctor", () =>
      report(output, async () => {
        const readiness = await manager.inspectActiveReadiness();
        const orchestration = orchestrator.getSnapshot();
        const verifiers = await repositoryVerifierState(activeRepositoryRoot());
        const checks = buildProductDoctorReport(readiness, {
          active: orchestration.active,
          retainedRuns: orchestration.retainedRuns.length,
          ...(orchestration.run?.integrationWorktree === undefined
            ? {}
            : { integrationWorktree: orchestration.run.integrationWorktree }),
        }, verifiers);
        checks.forEach((check) => {
          output.appendLine(`${check.ok ? "ok" : check.blocking ? "BLOCK" : "optional"} ${check.name}: ${check.detail}`);
        });
        const failed = checks.filter((check) => !check.ok);
        const blocking = failed.filter((check) => check.blocking);
        const doctorRepositoryRoot = activeRepositoryRoot();
        await onboarding?.record({
          kind: "readiness",
          ...(doctorRepositoryRoot === undefined
            ? {}
            : { repositoryRoot: doctorRepositoryRoot }),
          availableProviders: availableLocalProviders(readiness.adapters),
          blockingFindings: blocking.length,
          ...(readiness.selectedPipelineId ? { selectedPipelineId: readiness.selectedPipelineId } : {}),
          ...(readiness.selectedPipelineId
            ? { selectedSafetyLevel: readiness.pipelineSafetyLevels?.[readiness.selectedPipelineId] }
            : {}),
        });
        if (failed.length === 0) {
          await vscode.window.showInformationMessage(
            vscode.l10n.t("Bachata Doctor: all {0} checks passed", String(checks.length)),
          );
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          blocking.length > 0
            ? (blocking.length === 1 ? vscode.l10n.t("Bachata Doctor: {0} blocking problem", String(blocking.length)) : vscode.l10n.t("Bachata Doctor: {0} blocking problems", String(blocking.length)))
            : (failed.length === 1 ? vscode.l10n.t("Bachata Doctor: selected workflow is ready; {0} optional check needs attention", String(failed.length)) : vscode.l10n.t("Bachata Doctor: selected workflow is ready; {0} optional checks need attention", String(failed.length))),
          vscode.l10n.t("Show Output"),
          vscode.l10n.t("Fix a Problem"),
        );
        if (choice === vscode.l10n.t("Show Output")) {
          output.show(true);
        } else if (choice === vscode.l10n.t("Fix a Problem")) {
          const remedies = Array.from(new Map(failed
            .filter((check) => check.remediationId)
            .map((check) => [check.remediationId, check])).values());
          const selected = await vscode.window.showQuickPick(remedies.map((check) => ({
            label: check.name,
            description: check.blocking ? vscode.l10n.t("Blocking") : vscode.l10n.t("Optional"),
            detail: check.detail,
            remediationId: check.remediationId,
          })), { title: vscode.l10n.t("Bachata Doctor: choose a remediation") });
          if (selected?.remediationId) {
            await runDoctorRemediation(selected.remediationId, selected.detail);
          }
        }
      }),
    ),
    vscode.commands.registerCommand("bachata.todo.status", () =>
      report(output, async () => {
        openPipelinePanel(context, manager);
        const snapshot = orchestrator.getSnapshot();
        if (!snapshot.run) {
          output.appendLine("No TODO orchestration run is loaded");
          await vscode.window.showInformationMessage(vscode.l10n.t("Bachata has no TODO orchestration run loaded"));
          return;
        }
        const run = snapshot.run;
        output.appendLine(`Run: ${run.runId}`);
        output.appendLine(`Status: ${run.status}`);
        output.appendLine(`Integration branch: ${run.integrationBranch}`);
        Object.values(run.tasks).forEach((task) => {
          output.appendLine(`${task.spec.id}: ${task.status}${task.lastError ? ` · ${task.lastError}` : ""}`);
        });
      }),
    ),
  ];
};
