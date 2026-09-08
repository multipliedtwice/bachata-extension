export const DOCUMENTATION_PLACEHOLDER = "todo-release.invalid";

export const documentationUrls = {
  // Verified official provider setup docs. The Codex URL redirects to learn.chatgpt.com/docs/codex/cli.
  codex: "https://developers.openai.com/codex/cli/",
  claude: "https://code.claude.com/docs/en/overview",
  // Bridge stays a placeholder until the owner supplies the canonical public URL; never invented.
  bridge: "https://todo-release.invalid/bachata-browser-bridge/releases",
  git: "https://git-scm.com/downloads",
} as const;

export type DocumentationKey = keyof typeof documentationUrls;

export const verifiedDocumentationUrl = (key: DocumentationKey): string | undefined => {
  const url = documentationUrls[key];
  return url.includes(DOCUMENTATION_PLACEHOLDER) ? undefined : url;
};
