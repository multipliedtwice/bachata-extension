import * as path from "node:path";

import * as vscode from "vscode";

import {
  configurationDiagnostics,
  declaredVerifiers,
  bachataConfigurationFile,
  VERIFIER_REGISTRY_TEMPLATE,
} from "./configurationDiagnostics";
import {
  parseVerifierRegistry,
  verifierCommand,
  VERIFIER_REGISTRY_PATH,
} from "../orchestrator/verifierRegistry";
import {
  discoverVerifiers,
  verifierRegistryDocument,
} from "../bootstrap/discoverVerifiers";
import type { VerifierProposal } from "../bootstrap/discoverVerifiers";
import { policyDocument, policyTemplateRefusals, policyTemplates } from "../bootstrap/policyTemplates";
import { validatePipelineDefinition } from "../pipeline/schema";
import type { PipelineDefinition } from "../pipeline/types";
import { REPOSITORY_POLICY_PATH } from "./repositoryPolicy";

const normalized = (uri: vscode.Uri): string => uri.fsPath.replaceAll("\\", "/");

const SHOW_OUTPUT_LABEL = "Show Output";

const loadBuiltInPipelines = async (
  extensionDirectory: string | undefined,
): Promise<PipelineDefinition[]> => {
  if (!extensionDirectory) return [];
  const directory = vscode.Uri.file(path.join(extensionDirectory, "presets"));
  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [];
  }
  const definitions: PipelineDefinition[] = [];
  for (const [name, kind] of entries) {
    if (kind !== vscode.FileType.File || !name.endsWith(".json")) continue;
    try {
      const source = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, name)),
      ).toString("utf8");
      const validated = validatePipelineDefinition(JSON.parse(source));
      if (validated.success) definitions.push(validated.data);
    } catch {
      continue;
    }
  }
  return definitions;
};

export type RepositoryVerifierApprovalControl = {
  isRecorded: () => boolean;
  remove: () => Promise<void>;
};

export const registerConfigurationAuthoring = (
  output: vscode.OutputChannel,
  extensionDirectory?: string,
  approval?: RepositoryVerifierApprovalControl,
): vscode.Disposable[] => {
  const diagnostics = vscode.languages.createDiagnosticCollection("bachata.configuration");

  const refresh = (document: vscode.TextDocument): void => {
    if (document.uri.scheme !== "file") return;
    const file = bachataConfigurationFile(normalized(document.uri));
    if (!file) return;
    diagnostics.set(
      document.uri,
      configurationDiagnostics(file, document.getText()).map((entry) => {
        const line = Math.max(0, Math.min(entry.line - 1, document.lineCount - 1));
        const text = document.lineAt(line).text;
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, 0, line, Math.max(1, text.length)),
          entry.message,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "Bachata";
        diagnostic.code = file;
        return diagnostic;
      }),
    );
  };

  const clear = (document: vscode.TextDocument): void => {
    if (bachataConfigurationFile(normalized(document.uri))) diagnostics.delete(document.uri);
  };

  vscode.workspace.textDocuments.forEach(refresh);

  const showVerifiers = async (): Promise<void> => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) throw new Error("Open a workspace folder before listing repository verifiers");
    const file = vscode.Uri.file(path.join(root.fsPath, ...VERIFIER_REGISTRY_PATH.split("/")));
    let source: string | undefined;
    try {
      source = Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    } catch {
      source = undefined;
    }
    if (source === undefined) {
      const create = await vscode.window.showInformationMessage(
        `This repository declares no ${VERIFIER_REGISTRY_PATH}. Bachata can create it from a template of fixed descriptors, reviewed and versioned like any other file.`,
        { modal: false },
        "Create from template",
      );
      if (create !== "Create from template") return;
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.fsPath)));
      await vscode.workspace.fs.writeFile(file, Buffer.from(VERIFIER_REGISTRY_TEMPLATE, "utf8"));
      output.appendLine(`Created ${VERIFIER_REGISTRY_PATH} from template`);
      const created = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(created);
      refresh(created);
      return;
    }
    const verifiers = declaredVerifiers(source);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    refresh(document);
    if (verifiers.length === 0) {
      void vscode.window.showWarningMessage(
        `${VERIFIER_REGISTRY_PATH} declares no usable verifier. Problems lists why.`,
      );
      return;
    }
    const approvalRecorded = approval?.isRecorded() === true;
    const removeApprovalLabel = "Remove this workspace's approval";
    const picked = await vscode.window.showQuickPick(
      [
        ...(approvalRecorded
          ? [{
              label: removeApprovalLabel,
              description: "approved",
              detail: "Bachata may start these descriptors during Bachata: Improve This Project. Removing the approval refuses every one of them again.",
            }]
          : []),
        ...verifiers.map((verifier) => ({
          label: verifier.command,
          description: verifier.id,
          detail: verifier.description,
        })),
      ],
      {
        title: "Repository verifiers",
        placeHolder: approvalRecorded
          ? "Copy a descriptor command, or remove this workspace's approval"
          : "Copy a descriptor command",
      },
    );
    if (!picked) return;
    if (picked.label === removeApprovalLabel) {
      await approval?.remove();
      output.appendLine("Removed the repository verifier approval for this workspace");
      void vscode.window.showInformationMessage(
        "Bachata refuses every repository verifier in this workspace again. Bachata: Improve This Project will ask before it starts one.",
      );
      return;
    }
    await vscode.env.clipboard.writeText(picked.label);
    void vscode.window.showInformationMessage(`Copied ${picked.label} to the clipboard.`);
  };

  const workspaceFile = (root: vscode.Uri, relative: string): vscode.Uri =>
    vscode.Uri.file(path.join(root.fsPath, ...relative.split("/")));

  const readOptional = async (file: vscode.Uri): Promise<string | undefined> => {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8");
    } catch {
      return undefined;
    }
  };

  const writeConfiguration = async (
    file: vscode.Uri,
    relative: string,
    contents: string,
  ): Promise<boolean> => {
    if (await readOptional(file) !== undefined) {
      const overwrite = await vscode.window.showWarningMessage(
        `${relative} already exists.`,
        {
          modal: true,
          detail: "Bachata will replace it with the file you just reviewed. The previous content is not kept.",
        },
        "Replace it",
      );
      if (overwrite !== "Replace it") return false;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file.fsPath)));
    await vscode.workspace.fs.writeFile(file, Buffer.from(contents, "utf8"));
    output.appendLine(`Wrote ${relative}`);
    const written = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(written, { preview: false });
    refresh(written);
    return true;
  };

  const previewDocument = async (contents: string): Promise<void> => {
    const preview = await vscode.workspace.openTextDocument({ content: contents, language: "json" });
    await vscode.window.showTextDocument(preview, { preview: true });
  };

  const bootstrapRoot = async (): Promise<vscode.Uri | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const [firstFolder] = folders;
    if (!firstFolder) {
      throw new Error("Open a workspace folder before bootstrapping repository verifiers");
    }
    if (folders.length === 1) return firstFolder.uri;
    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: "Which repository should these verifiers and this policy belong to?",
      ignoreFocusOut: true,
    });
    return picked?.uri;
  };

  const bootstrapConfiguration = async (): Promise<void> => {
    const root = await bootstrapRoot();
    if (!root) return;
    const discovery = await discoverVerifiers(root.fsPath);
    discovery.skipped.forEach((reason) => output.appendLine(`Bootstrap skipped ${reason}`));
    if (discovery.proposals.length === 0) {
      [
        "Bachata proposes only checks this repository already declares: npm scripts, Cargo, Go, or Python project files.",
        `Write ${VERIFIER_REGISTRY_PATH} by hand, or run Bachata: Repository Verifiers for a template.`,
      ].forEach((line) => output.appendLine(line));
      // Nothing was found and nothing will change, so this states a result rather than
      // confirming one: the reasons and the next step are in the Output channel, one button away.
      const choice = await vscode.window.showInformationMessage(
        "Bachata found no repository check it can propose.",
        { modal: false },
        SHOW_OUTPUT_LABEL,
      );
      if (choice === SHOW_OUTPUT_LABEL) output.show(true);
      return;
    }
    type ProposalPick = vscode.QuickPickItem & { proposal: VerifierProposal };
    const picked = await vscode.window.showQuickPick<ProposalPick>(
      discovery.proposals.map((proposal) => ({
        label: verifierCommand(proposal.descriptor.id),
        description: `${proposal.descriptor.executable} ${proposal.descriptor.args.join(" ")}`,
        detail: `${proposal.descriptor.description} · found in ${proposal.source}${proposal.confidence === "conventional" ? " · convention, not declared" : ""}`,
        picked: proposal.confidence === "declared",
        proposal,
      })),
      {
        title: `Propose repository verifiers for ${VERIFIER_REGISTRY_PATH}`,
        placeHolder: "Choose the checks Bachata may run without asking. Nothing is written yet.",
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked || picked.length === 0) return;
    const descriptors = picked.map((item) => item.proposal.descriptor);
    const registry = verifierRegistryDocument(descriptors);
    const validation = parseVerifierRegistry(JSON.parse(registry));
    if (validation.errors.length > 0) {
      throw new Error(`Bachata proposed an invalid registry: ${validation.errors.join("; ")}`);
    }
    await previewDocument(registry);
    const confirmed = await vscode.window.showInformationMessage(
      `Write ${String(descriptors.length)} verifier${descriptors.length === 1 ? "" : "s"} to ${VERIFIER_REGISTRY_PATH}?`,
      {
        modal: true,
        detail: [
          "Every descriptor is fixed: Bachata spawns the executable and arguments exactly as written, never through a shell.",
          "A model may select a descriptor id. It can never write a command.",
          "Review the preview, then commit this file like any other repository file.",
        ].join("\n"),
      },
      "Write the registry",
    );
    if (confirmed !== "Write the registry") return;
    if (!await writeConfiguration(workspaceFile(root, VERIFIER_REGISTRY_PATH), VERIFIER_REGISTRY_PATH, registry)) {
      return;
    }

    const commands = descriptors.map((entry) => verifierCommand(entry.id));
    const template = await vscode.window.showQuickPick(
      policyTemplates.map((candidate) => ({
        label: candidate.name,
        detail: candidate.detail,
        template: candidate,
      })),
      {
        title: `Also write ${REPOSITORY_POLICY_PATH}?`,
        placeHolder: "Choose an assurance profile, or press Escape to skip",
        ignoreFocusOut: true,
      },
    );
    if (!template) return;
    const resolved = template.template.policy(commands);
    const refused = policyTemplateRefusals(resolved, await loadBuiltInPipelines(extensionDirectory));
    const policy = policyDocument(resolved);
    await previewDocument(policy);
    const confirmedPolicy = await vscode.window.showInformationMessage(
      `Write ${REPOSITORY_POLICY_PATH} as "${template.template.name}"?`,
      {
        modal: true,
        detail: [
          template.template.detail,
          "",
          "A repository policy can only narrow authority. It can never widen what a pipeline or a setting already allows.",
          "",
          refused.length === 0
            ? "This policy refuses none of the built-in pipelines it covers."
            : `This policy refuses ${String(refused.length)} built-in pipeline${refused.length === 1 ? "" : "s"}:`,
          ...refused.slice(0, 12).map((entry) => `  ${entry.pipelineId}: ${entry.reasons[0]}`),
        ].join("\n"),
      },
      "Write the policy",
    );
    if (confirmedPolicy !== "Write the policy") return;
    await writeConfiguration(workspaceFile(root, REPOSITORY_POLICY_PATH), REPOSITORY_POLICY_PATH, policy);
  };

  return [
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument(clear),
    vscode.commands.registerCommand("bachata.verifiers", async () => {
      try {
        await showVerifiers();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`bachata.verifiers failed: ${message}`);
        void vscode.window.showErrorMessage(`Bachata: ${message}`);
      }
    }),
    vscode.commands.registerCommand("bachata.bootstrapConfiguration", async () => {
      try {
        await bootstrapConfiguration();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`bachata.bootstrapConfiguration failed: ${message}`);
        void vscode.window.showErrorMessage(`Bachata: ${message}`);
      }
    }),
  ];
};
