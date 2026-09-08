import { AgentAdapter } from "./types";
import {
  BrowserProviderAdapterOptions,
  createBrowserProviderAdapter,
} from "./browserProvider";

export type GenericBrowserAdapterOptions = Omit<
  BrowserProviderAdapterOptions,
  "provider"
>;

export const createGenericBrowserAdapter = (
  options: GenericBrowserAdapterOptions,
): AgentAdapter => createBrowserProviderAdapter({
  ...options,
  provider: "generic",
  supportsAttachments: false,
});
