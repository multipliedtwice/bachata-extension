import { createHash } from "node:crypto";

import type {
  RuntimeInteractionRequest,
  RuntimeInteractionResponse,
} from "../runtime/createRuntime";

/**
 * EX-3. What brokering a runtime's interaction request decides, apart from the catalog that
 * stores it and the panel that answers it.
 *
 * A request is identified by what it asks, so a repeat of the same question reuses the open
 * interaction and a changed question supersedes it; a checklist request is refused rather than
 * silently re-keyed when the persisted items differ; and a resolution the catalog already holds is
 * read back in the runtime's own shape. Each of those rules sat inside one `async` function that
 * also writes the catalog, persists, emits and schedules, so none was reachable without a store.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type InteractionIdentity = Pick<
  RuntimeInteractionRequest,
  "kind" | "prompt" | "options" | "allowFreeText" | "secret" | "fallback" | "checklistItems"
>;

/** The hash under which a request is the same request: every field the person would read. */
export const interactionPayloadHash = (request: InteractionIdentity): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        kind: request.kind,
        prompt: request.prompt,
        options: request.options,
        allowFreeText: request.allowFreeText,
        secret: request.secret,
        fallback: request.fallback,
        checklistItems: request.checklistItems,
      }),
    )
    .digest("hex");

/** The context an interaction is stored with: how it is presented, and which payload it was. */
export const interactionContextFrom = (
  request: Pick<RuntimeInteractionRequest, "title" | "allowFreeText" | "secret" | "fallback">,
  payloadHash: string,
): {
  title: string;
  allowFreeText: boolean;
  secret: boolean;
  fallback: RuntimeInteractionRequest["fallback"];
  payloadHash: string;
} => ({
  title: request.title,
  allowFreeText: request.allowFreeText,
  secret: request.secret,
  fallback: request.fallback,
  payloadHash,
});

/** A request's own timeout wins; the configured fallback is never under a second. */
export const interactionTimeoutMs = (input: {
  requested?: number | undefined;
  configured: number;
}): number => input.requested ?? Math.max(1_000, input.configured);

/**
 * The open interactions a new request replaces: those from the same source — the exact key, or a
 * key it prefixes with `#` — that ask something different. The one asking the same thing is left
 * open and reused, so a runtime that re-asks after a reload does not put two copies on screen.
 */
export const supersededInteractionRefs = (
  open: readonly { interactionRef: string; sourceKey?: string | undefined; context?: unknown }[],
  target: { sourceKey: string; payloadHash: string },
): string[] => {
  const prefix = `${target.sourceKey}#`;
  return open.flatMap((current) => {
    if (current.sourceKey !== target.sourceKey && !current.sourceKey?.startsWith(prefix)) {
      return [];
    }
    const context = isRecord(current.context) ? current.context : {};
    return context.payloadHash === target.payloadHash ? [] : [current.interactionRef];
  });
};

export type StoredChecklistItem = {
  issueId: string;
  title: string;
  details: string;
  dependencies: string[];
  paths: string[];
};

export type ChecklistStoragePlan =
  | { action: "store"; items: StoredChecklistItem[] }
  | { action: "keep" }
  | { action: "refuse"; message: string };

/**
 * What to do with a request's checklist against what the catalog already holds for the
 * interaction: store it when nothing is stored, keep it when the stored items are the same
 * request, refuse when they differ — a checklist re-keyed under a different list would let the
 * person approve items they never saw.
 */
export const checklistStoragePlan = (input: {
  interactionRef: string;
  stored: readonly StoredChecklistItem[];
  requested: readonly {
    id: string;
    title: string;
    details: string;
    dependencies: string[];
    paths: string[];
  }[];
}): ChecklistStoragePlan => {
  if (input.stored.length === 0) {
    return {
      action: "store",
      items: input.requested.map((item) => ({
        issueId: item.id,
        title: item.title,
        details: item.details,
        dependencies: item.dependencies,
        paths: item.paths,
      })),
    };
  }
  const storedPayload = input.stored.map((item) => ({
    id: item.issueId,
    title: item.title,
    details: item.details,
    dependencies: item.dependencies,
    paths: item.paths,
  }));
  return JSON.stringify(storedPayload) === JSON.stringify(input.requested)
    ? { action: "keep" }
    : {
        action: "refuse",
        message: `Interaction ${input.interactionRef} has a different persisted checklist`,
      };
};

/**
 * A resolution the catalog holds, read back in the runtime's shape. Only strings count as
 * selections, free text is text or nothing, and every way an interaction can end without the
 * person answering — cancelled, superseded — is a cancel to the runtime.
 */
export const responseFromResolution = (interaction: {
  resolution?: unknown;
  resolutionSource?: string | undefined;
}): RuntimeInteractionResponse => {
  const resolution = isRecord(interaction.resolution) ? interaction.resolution : {};
  return {
    selected: Array.isArray(resolution.selected)
      ? resolution.selected.filter((item): item is string => typeof item === "string")
      : [],
    freeText: typeof resolution.freeText === "string" ? resolution.freeText : "",
    source:
      interaction.resolutionSource === "lead"
        ? "lead"
        : interaction.resolutionSource === "timeout"
          ? "timeout"
          : interaction.resolutionSource === "cancel" || interaction.resolutionSource === "superseded"
            ? "cancel"
            : "user",
  };
};
