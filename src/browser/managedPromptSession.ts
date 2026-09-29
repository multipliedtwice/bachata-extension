import type { BrowserConversationBinding, BrowserSession } from "./protocol";
import { isStableRecoveryIdentity } from "./recovery";
import { managedConversationRolloverRequired } from "./managedConversationBudget";

export type ManagedPrompt = {
  full: string;
  compact?: string | undefined;
  fullContract?: boolean | undefined;
};

export const freshManagedBrowserBinding = (binding?: BrowserConversationBinding): BrowserConversationBinding | undefined => {
  if (!binding || binding.provider === "generic") return binding;
  return isStableRecoveryIdentity(binding.provider, binding.conversationUrl, binding.conversationIdentity) ? binding : undefined;
};

export const managedPromptGeneration = (session?: BrowserSession): string | undefined => {
  if (!session?.documentToken || !session.conversationIdentity
    || session.capabilities?.conversationState !== "confirmed"
    || ["failed", "disconnected", "notAuthenticated"].includes(session.status)) return undefined;
  if (session.provider !== "generic"
    && !isStableRecoveryIdentity(session.provider, session.conversationUrl, session.conversationIdentity)) return undefined;
  return JSON.stringify([session.provider, session.tabId, session.frameId, session.documentToken, session.conversationIdentity]);
};

// Exposure is deliberately ephemeral. A resumed operation starts with a new full
// handoff, never with a flag inferred from persisted browser or checkpoint state.
export const createManagedPromptSender = <T extends { result: { answer: string; status: string } }>(input: {
  compactReadOnly: boolean;
  maxBytes: number;
  initialPrompt: string;
  initialAnswer: string;
  initialSucceeded: boolean;
  generation: () => string | undefined;
  framePrompt?: ((prompt: string) => string) | undefined;
  rehydrate: (fullContinuation: string, reason: "budget" | "generation") => Promise<string>;
  send: (prompt: string, eventType: string) => Promise<T>;
}): ((prompt: ManagedPrompt, eventType: string) => Promise<T>) => {
  let bytes = Buffer.byteLength(input.initialPrompt, "utf8") + Buffer.byteLength(input.initialAnswer, "utf8");
  let exposedGeneration = input.initialSucceeded ? input.generation() : undefined;
  let rehydrateRequired = false;
  return async (prompt, eventType) => {
    const generation = input.generation();
    const compact = input.compactReadOnly && generation !== undefined && generation === exposedGeneration
      && prompt.compact !== undefined;
    let effective = compact ? prompt.compact ?? prompt.full : prompt.full;
    effective = input.framePrompt?.(effective) ?? effective;
    let fullContract = !compact && prompt.fullContract === true;
    let dispatchedGeneration = generation;
    const changed = input.compactReadOnly && (rehydrateRequired
      || exposedGeneration !== undefined && generation !== exposedGeneration);
    if (changed || managedConversationRolloverRequired(bytes, Buffer.byteLength(effective, "utf8"), input.maxBytes)) {
      exposedGeneration = undefined;
      effective = await input.rehydrate(prompt.full, changed ? "generation" : "budget");
      effective = input.framePrompt?.(effective) ?? effective;
      if (Buffer.byteLength(effective, "utf8") > input.maxBytes) throw new Error("Managed rehydration exceeds the cumulative conversation limit");
      bytes = 0;
      fullContract = true;
      rehydrateRequired = false;
      dispatchedGeneration = input.generation();
    }
    try {
      const result = await input.send(effective, eventType);
      bytes += Buffer.byteLength(effective, "utf8") + Buffer.byteLength(result.result.answer, "utf8");
      const after = input.generation();
      if (dispatchedGeneration !== undefined && after !== dispatchedGeneration) rehydrateRequired = true;
      if (result.result.status !== "completed") exposedGeneration = undefined;
      else if (fullContract) exposedGeneration = after;
      else if (after !== exposedGeneration) exposedGeneration = undefined;
      return result;
    } catch (error) {
      exposedGeneration = undefined;
      throw error;
    }
  };
};
