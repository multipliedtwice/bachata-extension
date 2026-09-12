import { boundedRedactedText, boundedTranscriptData, serializedJsonBytes } from "../conversations/eventDetail";
import type { TranscriptEntry } from "../webview/protocol";

/**
 * The transcript's half of the same guarantee the event history gets.
 *
 * A transcript entry's `text` and `data` are provider-originated: a prompt, an answer, a failure
 * message, a captured payload. Both were redacted and neither was bounded — redaction lowercased
 * and rewrote the whole of a string of any length, `redactJsonValue` walked and rebuilt a structure
 * of any depth and width, and only the file on disk was ever trimmed. The in-memory window and the
 * message posted to the panel held whatever the provider wrote.
 *
 * They are bounded first now, by the same traversal the event projection uses, before anything is
 * persisted, retained or posted:
 *
 *  - each entry is bounded on its own — text and data have separate ceilings, so an enormous
 *    captured payload cannot cost the reader the message beside it;
 *  - the retained window has a ceiling of its own, because a per-entry limit bounds one entry and
 *    says nothing about three hundred of them. The oldest entries leave first: the transcript is
 *    read from the bottom, and what is dropped here is still on disk;
 *  - what was cut is said, in the entry itself, rather than left to look like the whole of what the
 *    provider wrote.
 *
 * The text ceiling is deliberately generous — a prompt or an actionable error has to survive intact
 * for normal use, and both are far below it.
 */
export const TRANSCRIPT_TEXT_BYTES = 8 * 1_024;
export const TRANSCRIPT_TEXT_UNITS = 8 * 1_024;
export const TRANSCRIPT_DATA_BYTES = 16 * 1_024;

/** The whole retained transcript window, in serialized UTF-8 bytes. */
export const TRANSCRIPT_WINDOW_BYTES = 4 * 1_024 * 1_024;
export const TRANSCRIPT_ID_BYTES = 512;
export const TRANSCRIPT_CREATED_AT_BYTES = 64;
export const TRANSCRIPT_AGENT_ID_BYTES = 128;
export const TRANSCRIPT_STEP_BYTES = 256;
export const TRANSCRIPT_EVENT_TYPE_BYTES = 128;

/**
 * `text` carries process output, command lines and headers for an error or an event entry, so those
 * two kinds get the stricter assignment-aware redaction; a prompt or an answer is prose.
 */
const isStructuredKind = (kind: TranscriptEntry["kind"]): boolean =>
  kind === "error" || kind === "event";

export const boundedTranscriptEntry = (entry: TranscriptEntry): TranscriptEntry => {
  const data = entry.data === undefined
    ? undefined
    : boundedTranscriptData(entry.data, TRANSCRIPT_DATA_BYTES);
  return {
    id: boundedRedactedText(entry.id, TRANSCRIPT_ID_BYTES, { structured: true }),
    kind: entry.kind,
    text: boundedRedactedText(entry.text, TRANSCRIPT_TEXT_BYTES, {
      structured: isStructuredKind(entry.kind),
      maxUnits: TRANSCRIPT_TEXT_UNITS,
    }),
    createdAt: boundedRedactedText(entry.createdAt, TRANSCRIPT_CREATED_AT_BYTES, { structured: true }),
    ...(typeof entry.agentId !== "string" || entry.agentId.length === 0
      ? {}
      : { agentId: boundedRedactedText(entry.agentId, TRANSCRIPT_AGENT_ID_BYTES, { structured: true }) }),
    ...(typeof entry.step !== "string" || entry.step.length === 0
      ? {}
      : { step: boundedRedactedText(entry.step, TRANSCRIPT_STEP_BYTES, { structured: true }) }),
    ...(typeof entry.eventType !== "string" || entry.eventType.length === 0
      ? {}
      : { eventType: boundedRedactedText(entry.eventType, TRANSCRIPT_EVENT_TYPE_BYTES, { structured: true }) }),
    ...(data === undefined ? {} : { data }),
  };
};

/** One entry's serialized cost, excluding the window's brackets and separators. */
export const transcriptEntryBytes = (entry: TranscriptEntry): number =>
  serializedJsonBytes({
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    createdAt: entry.createdAt,
    ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }),
    ...(entry.step === undefined ? {} : { step: entry.step }),
    ...(entry.eventType === undefined ? {} : { eventType: entry.eventType }),
    ...(entry.data === undefined ? {} : { data: entry.data }),
  });

/**
 * The newest entries that fit the window ceiling, oldest dropped first.
 *
 * At least one entry is always kept: an entry larger than the whole ceiling cannot exist, because
 * every entry has already been bounded, but a window that returned nothing would render as a
 * conversation that never happened.
 */
export const boundedTranscriptWindow = (
  entries: readonly TranscriptEntry[],
  maxBytes = TRANSCRIPT_WINDOW_BYTES,
): TranscriptEntry[] => {
  if (maxBytes < 2) return [];
  let total = 2;
  let first = entries.length;
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const bytes = transcriptEntryBytes(entry) + (count === 0 ? 0 : 1);
    if (total + bytes > maxBytes) break;
    total += bytes;
    first = index;
    count += 1;
  }
  return first === 0 ? [...entries] : entries.slice(first);
};
