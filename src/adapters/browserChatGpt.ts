import { AgentAdapter } from "./types";
import {
  BrowserProviderAdapterOptions,
  createBrowserProviderAdapter,
} from "./browserProvider";

export type BrowserChatGptAdapterOptions = Omit<
  BrowserProviderAdapterOptions,
  "provider"
>;

export const createBrowserChatGptAdapter = (
  options: BrowserChatGptAdapterOptions,
): AgentAdapter => createBrowserProviderAdapter({ ...options, provider: "chatgpt" });
