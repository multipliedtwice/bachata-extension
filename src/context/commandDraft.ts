import * as path from "node:path";

import { pathInsideRelative } from "../process/pathBoundary";

export type DraftScope =
  | "file"
  | "selection"
  | "stagedDiff"
  | "uncommitted"
  | "branchAgainstBase"
  | "commit"
  | "commitRange"
  | "diagnostic";

export type GitReviewScope = {
  scope: "stagedDiff" | "uncommitted" | "branchAgainstBase" | "commit" | "commitRange";
  baseRef?: string;
  headRef?: string;
  commit?: string;
};

const REF_PATTERN = /^[A-Za-z0-9._\-\/]{1,255}$/u;

export const isReviewableGitRef = (value: string): boolean =>
  REF_PATTERN.test(value) &&
  !value.startsWith("-") &&
  !value.includes("..") &&
  !value.endsWith("/") &&
  !value.endsWith(".lock");

export const gitReviewCommand = (scope: GitReviewScope): string => {
  if (scope.scope === "stagedDiff") return "git diff --cached";
  if (scope.scope === "uncommitted") return "git diff HEAD";
  if (scope.scope === "branchAgainstBase") {
    const base = scope.baseRef ?? "";
    const head = scope.headRef ?? "HEAD";
    if (!isReviewableGitRef(base)) throw new Error("A base ref is required to review a branch");
    if (!isReviewableGitRef(head)) throw new Error("The head ref is not a reviewable Git ref");
    return `git diff ${base}...${head}`;
  }
  if (scope.scope === "commit") {
    const commit = scope.commit ?? "";
    if (!isReviewableGitRef(commit)) throw new Error("A commit is required to review one commit");
    return `git show ${commit}`;
  }
  const base = scope.baseRef ?? "";
  const head = scope.headRef ?? "";
  if (!isReviewableGitRef(base) || !isReviewableGitRef(head)) {
    throw new Error("A commit range needs two reviewable Git refs");
  }
  return `git diff ${base}..${head}`;
};

export type CommandDraft = { title: string; prompt: string };

const normalizedPath = (filePath: string, workspaceRoot?: string): string => {
  if (!workspaceRoot) return path.normalize(filePath);
  const relative = pathInsideRelative(workspaceRoot, filePath);
  return relative ? relative : path.normalize(filePath);
};

const gitScopeLabels: Record<GitReviewScope["scope"], (git: Omit<GitReviewScope, "scope">) => string> = {
  stagedDiff: () => "the staged Git diff",
  uncommitted: () => "all uncommitted changes",
  branchAgainstBase: (git) => `this branch against ${git.baseRef ?? "its base"}`,
  commit: (git) => `commit ${git.commit ?? "HEAD"}`,
  commitRange: (git) => `commits ${git.baseRef ?? ""}..${git.headRef ?? ""}`,
};

export const createCommandDraft = (input: {
  scope: DraftScope;
  filePath?: string;
  workspaceRoot?: string;
  selection?: { startLine: number; endLine: number; text: string };
  diagnostic?: { message: string; source?: string; line: number };
  git?: Omit<GitReviewScope, "scope">;
}): CommandDraft => {
  if (
    input.scope === "stagedDiff" ||
    input.scope === "uncommitted" ||
    input.scope === "branchAgainstBase" ||
    input.scope === "commit" ||
    input.scope === "commitRange"
  ) {
    const repository = input.workspaceRoot ? path.basename(path.resolve(input.workspaceRoot)) : undefined;
    const command = gitReviewCommand({ scope: input.scope, ...(input.git ?? {}) });
    const label = gitScopeLabels[input.scope](input.git ?? {});
    return {
      title: repository ? `Review ${label} in ${repository}` : `Review ${label}`,
      prompt: `Review ${label} (\`${command}\`)${repository ? ` of repository ${repository}` : ""}. Report only evidence-backed findings and name the file and line of each. Do not modify files unless I explicitly approve a follow-up implementation workflow.`,
    };
  }
  if (!input.filePath) throw new Error("This action requires a file");
  const file = normalizedPath(input.filePath, input.workspaceRoot);
  if (input.scope === "file") return { title: `Review ${path.basename(file)}`, prompt: `Review file: ${file}\n\nReport only evidence-backed findings. Do not modify files.` };
  if (input.scope === "selection") {
    if (!input.selection || input.selection.text.length === 0) throw new Error("Select code before running this action");
    const text = input.selection.text.slice(0, 32_768);
    return {
      title: `Review selection in ${path.basename(file)}`,
      prompt: `Review ${file}:${String(input.selection.startLine)}-${String(input.selection.endLine)}. Report only evidence-backed findings. Do not modify files.\n\nSelected code:\n\`\`\`\n${text}\n\`\`\``,
    };
  }
  if (!input.diagnostic) throw new Error("No diagnostic is available for this file");
  return {
    title: `Fix diagnostic in ${path.basename(file)}`,
    prompt: `Prepare a fix for ${file}:${String(input.diagnostic.line)}. Preserve this as a draft; do not run until I submit it.\n\n${input.diagnostic.source ? `${input.diagnostic.source}: ` : ""}${input.diagnostic.message}`,
  };
};
