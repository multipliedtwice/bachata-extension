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
    ...entry,
    text: boundedRedactedText(entry.text, TRANSCRIPT_TEXT_BYTES, {
      structured: isStructuredKind(entry.kind),
      maxUnits: TRANSCRIPT_TEXT_UNITS,
    }),
    ...(data === undefined ? {} : { data }),
  };
};

/** One entry's cost in the window, its separator included. */
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
  }) + 1;

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
  let total = 0;
  let first = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const bytes = transcriptEntryBytes(entry);
    if (total + bytes > maxBytes && first < entries.length) break;
    total += bytes;
    first = index;
  }
  return first === 0 ? [...entries] : entries.slice(first);
};
