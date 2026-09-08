const providerNames: Record<string, string> = {
  "codex-app-server": "Codex CLI",
  "claude-code": "Claude Code",
  "zai-glm": "Z.AI GLM",
  "chatgpt-browser": "ChatGPT browser",
  "claude-browser": "Claude browser",
  "generic-browser": "Generic browser",
};

export const providerDisplayName = (adapter: string): string =>
  providerNames[adapter] ?? adapter;

export const knownProviderAdapters: readonly string[] = Object.keys(providerNames);
