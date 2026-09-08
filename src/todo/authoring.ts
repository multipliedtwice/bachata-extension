import * as path from "node:path";

import * as vscode from "vscode";

import { analyzeTodo, renderTodoPlan } from "../orchestrator/todoAnalysis";
import type { TodoAnalysis, TodoQuickFix } from "../orchestrator/todoAnalysis";
import { metadataAliases } from "../orchestrator/todoParser";

const analysisOptions = (): {
  pipelineId: string;
  retries: number;
  requirePaths: boolean;
  requireControllerVerification: boolean;
} => {
  const configuration = vscode.workspace.getConfiguration("bachata");
  return {
    pipelineId: configuration.get<string>("todoPipeline", "todo-implementation"),
    retries: configuration.get<number>("todoRetries", 1),
    requirePaths: true,
    requireControllerVerification: true,
  };
};

const todoFileName = (): string =>
  vscode.workspace.getConfiguration("bachata").get<string>("todoFile", "TODO.md");

export const isTodoDocument = (document: vscode.TextDocument, fileName: string): boolean =>
  document.uri.scheme === "file" && path.basename(document.uri.fsPath) === path.basename(fileName);

const verificationValues = [
  "bachata:project-checks",
  "bachata:workspace-integrity",
  "none",
];

const applyFix = async (uri: vscode.Uri, fix: TodoQuickFix): Promise<void> => {
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  if (fix.mode === "replaceLine") {
    edit.replace(uri, document.lineAt(fix.line - 1).range, fix.text);
  } else {
    const anchor = document.lineAt(Math.min(fix.line, document.lineCount) - 1);
    edit.insert(uri, anchor.range.end, `\n${fix.text}`);
  }
  await vscode.workspace.applyEdit(edit);
};

export const registerTodoAuthoring = (
  _context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): vscode.Disposable[] => {
  const diagnostics = vscode.languages.createDiagnosticCollection("bachata.todo");
  const analyses = new Map<string, TodoAnalysis>();

  const refresh = (document: vscode.TextDocument): void => {
    if (!isTodoDocument(document, todoFileName())) return;
    const analysis = analyzeTodo(document.getText(), analysisOptions());
    analyses.set(document.uri.toString(), analysis);
    diagnostics.set(
      document.uri,
      analysis.diagnostics.map((entry) => {
        const line = Math.max(0, Math.min(entry.line - 1, document.lineCount - 1));
        const text = document.lineAt(line).text;
        const start = Math.max(0, Math.min(entry.column, text.length));
        const end = Math.max(start + 1, Math.min(start + entry.length, text.length));
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(line, start, line, end),
          entry.message,
          entry.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "Bachata";
        diagnostic.code = entry.code;
        return diagnostic;
      }),
    );
  };

  const clear = (document: vscode.TextDocument): void => {
    diagnostics.delete(document.uri);
    analyses.delete(document.uri.toString());
  };

  vscode.workspace.textDocuments.forEach(refresh);

  const subscriptions: vscode.Disposable[] = [
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument(clear),
    vscode.languages.registerCompletionItemProvider(
      { language: "markdown", scheme: "file" },
      {
        provideCompletionItems: (document, position) => {
          if (!isTodoDocument(document, todoFileName())) return undefined;
          const prefix = document.lineAt(position.line).text.slice(0, position.character);
          const metadata = /^\s*[-*+]\s+([^:]*)$/u.exec(prefix);
          if (metadata) {
            return Array.from(
              new Map(Array.from(metadataAliases.values()).map((alias) => [alias.label, alias])).values(),
            ).map((alias) => {
              const item = new vscode.CompletionItem(alias.label, vscode.CompletionItemKind.Property);
              item.insertText = new vscode.SnippetString(`${alias.label}: $0`);
              item.detail = "Bachata TODO metadata";
              return item;
            });
          }
          const value = /^\s*[-*+]\s+(Verify|Check|Verify Final|Final Verify|Final Check)\s*:\s*([^,]*)$/iu.exec(prefix);
          if (value) {
            return verificationValues.map((command) => {
              const item = new vscode.CompletionItem(command, vscode.CompletionItemKind.Value);
              item.detail = command === "none"
                ? "No verification for this task"
                : "Controller-owned verification";
              return item;
            });
          }
          return undefined;
        },
      },
      "-",
      " ",
      ":",
    ),
    vscode.languages.registerCodeActionsProvider(
      { language: "markdown", scheme: "file" },
      {
        provideCodeActions: (document, range) => {
          const analysis = analyses.get(document.uri.toString());
          if (!analysis) return undefined;
          return analysis.diagnostics
            .filter((entry) => entry.fixes.length > 0)
            .filter((entry) => entry.line - 1 >= range.start.line && entry.line - 1 <= range.end.line)
            .flatMap((entry) => entry.fixes.map((fix) => {
              const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
              action.command = {
                command: "bachata.todo.applyFix",
                title: fix.title,
                arguments: [document.uri, fix],
              };
              return action;
            }));
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand(
      "bachata.todo.applyFix",
      (uri: vscode.Uri, fix: TodoQuickFix) => applyFix(uri, fix),
    ),
    vscode.commands.registerCommand("bachata.todo.preview", async () => {
      const fileName = todoFileName();
      const active = vscode.window.activeTextEditor?.document;
      const document = active && isTodoDocument(active, fileName)
        ? active
        : await (async () => {
            const found = await vscode.workspace.findFiles(`**/${path.basename(fileName)}`, "**/node_modules/**", 1);
            return found[0] ? vscode.workspace.openTextDocument(found[0]) : undefined;
          })();
      if (!document) {
        await vscode.window.showWarningMessage(`Bachata found no ${fileName} in this workspace`);
        return;
      }
      const analysis = analyzeTodo(document.getText(), analysisOptions());
      analyses.set(document.uri.toString(), analysis);
      output.appendLine(
        `${fileName}: ${String(analysis.tasks.length)} tasks, ${String(analysis.waves.length)} execution groups, ${String(analysis.diagnostics.length)} problems`,
      );
      const preview = await vscode.workspace.openTextDocument({
        content: renderTodoPlan(analysis, path.basename(fileName)),
        language: "markdown",
      });
      await vscode.window.showTextDocument(preview, { preview: true });
    }),
  ];
  return subscriptions;
};
