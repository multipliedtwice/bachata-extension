import { AgentAdapter } from "./types";
import {
  BrowserProviderAdapterOptions,
  createBrowserProviderAdapter,
} from "./browserProvider";

export type BrowserClaudeAdapterOptions = Omit<
  BrowserProviderAdapterOptions,
  "provider"
>;

export const createBrowserClaudeAdapter = (
  options: BrowserClaudeAdapterOptions,
): AgentAdapter => createBrowserProviderAdapter({ ...options, provider: "claude" });
