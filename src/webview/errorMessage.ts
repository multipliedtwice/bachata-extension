import { boundedRedactedText } from "../conversations/eventDetail";

export const WEBVIEW_ERROR_BYTES = 8192;

/** Errors from initialization and dispatch share the same outbound secret/size contract. */
export const webviewErrorMessage = (error: unknown): string => boundedRedactedText(
  error instanceof Error ? error.message : String(error),
  WEBVIEW_ERROR_BYTES,
  { structured: true },
);
