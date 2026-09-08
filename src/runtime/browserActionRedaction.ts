import type { JsonValue } from "../adapters/types";
import type {
  BrowserActionCandidate,
  BrowserActionExecutionResult,
} from "../browser/actions";
import type { CapturedAsset } from "../browser/protocol";
import { redactFreeFormText, redactText } from "../security/redact";

export const toJsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

/**
 * What an approval prompt and the run ledger are allowed to carry about a browser action.
 *
 * Everything a provider response can put in an action is free-form model output, so each
 * text-bearing field is redacted before it leaves the runtime. Fields that are absent stay
 * absent rather than becoming a redacted empty string.
 */
export const sanitizedBrowserAction = (action: BrowserActionCandidate): JsonValue =>
  toJsonValue({
    ...action,
    source: {
      ...action.source,
      text: redactText(action.source.text),
    },
    ...(action.command ? { command: redactText(action.command) } : {}),
    ...(action.query ? { query: redactText(action.query) } : {}),
    ...(action.content !== undefined ? { content: redactText(action.content) } : {}),
    ...(action.patch ? { patch: redactText(action.patch) } : {}),
  });

export const sanitizedBrowserActionResult = (
  value: BrowserActionExecutionResult,
): BrowserActionExecutionResult => ({
  ...value,
  summary: redactText(value.summary),
  ...(value.stdout === undefined ? {} : { stdout: redactText(value.stdout) }),
  ...(value.stderr === undefined ? {} : { stderr: redactText(value.stderr) }),
});

/**
 * The asset facts a ledger entry may keep. The provider-side identifier and the source
 * origin are deliberately not carried: neither is needed to describe what was captured.
 */
export const sanitizedCapturedAsset = (asset: CapturedAsset): JsonValue =>
  toJsonValue({
    id: asset.id,
    provider: asset.provider,
    kind: asset.kind,
    name: redactFreeFormText(asset.name),
    ...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType }),
    ...(asset.size === undefined ? {} : { size: asset.size }),
    sourceElement: asset.sourceElement,
    downloadAvailable: asset.downloadAvailable,
    ...(asset.previewText === undefined
      ? {}
      : { previewText: redactFreeFormText(asset.previewText) }),
  });
