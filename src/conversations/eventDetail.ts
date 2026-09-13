import type { JsonValue } from "../adapters/types";
import {
  isSensitiveJsonKey,
  isStructuredTextKey,
  redactFreeFormText,
  redactText,
  secretBoundaryCut,
} from "../security/redact";

/**
 * What an event may tell a reader who opens a disclosure, and nothing more.
 *
 * The panel used to receive no payload at all except a published decision's. That kept free-form
 * provider text out of the webview, and it also emptied the two places built to show technical
 * detail: a pipeline step's "Technical detail" and the raw event history both render only when an
 * event carries something, so both were blank for every event that was not a ruling. A reader
 * looking for what actually happened in a step had nowhere left to look.
 *
 * So a payload travels, bounded and redacted rather than whole. The bound is global, not
 * per-container. Per-container caps compose multiplicatively — 24 fields at each of four levels is
 * about 24^4 retained leaves — so depth, width and length caps alone bound no total at all. The
 * guarantee here is stated in the two units that actually cost something: the serialized size of
 * the projection, and the amount of the source it had to look at to produce it.
 *
 *  - one traversal carries a shared budget of retained values, serialized UTF-8 bytes and examined
 *    source units. Every byte is charged before it is kept, against a budget that is never allowed
 *    to go negative, so `JSON.stringify` of the result is at or below `MAX_EVENT_DETAIL_BYTES` for
 *    any input;
 *  - nothing is measured, lowercased, redacted or copied before it is bounded. A string is cut to a
 *    fixed prefix before a redaction rule sees it, a property key is cut before it is normalised,
 *    an array is read at a fixed number of indices, and the traversal as a whole stops after
 *    `MAX_EXAMINED_UNITS`. A hostile payload of any size costs a fixed amount of work;
 *  - a prefix is not a safe place to stop on its own: a credential that begins near the cut
 *    continues past it, and a redaction rule that terminates its match at the end of the input
 *    emits the half it could see. So the prefix is pulled back to the last point where no secret
 *    construct may have begun — see `secretBoundaryCut` — and what crosses the boundary is withheld
 *    whole rather than shown in part;
 *  - credentials and secrets are removed, and provider session handles withheld, while
 *    traversing — before the value is measured, so the replacement's own size is what is charged.
 *    Property keys are provider-originated too, and are redacted and bounded like any other string
 *    before they are measured or retained;
 *  - what was cut is said. Bytes *and* a retained node are held back at every container so the
 *    marker survives an exhausted budget, and counts are reported where they are cheap to know —
 *    an array's length and a string's length are O(1) — with a generic marker where an exact count
 *    would mean enumerating a remainder that may be enormous.
 *
 * None of this is the primary flow: the panel renders every one of these behind a disclosure that
 * is closed on arrival.
 */
const MAX_DEPTH = 4;
const MAX_FIELDS = 24;
const MAX_ITEMS = 12;
const MAX_STRING = 1_024;

/** The most of a property key that is retained, after redaction and before the elision mark. */
const MAX_KEY = 128;

/**
 * The whole guarantee, in the unit the webview pays: one event's projection serializes to at most
 * this many UTF-8 bytes, keys, JSON punctuation, escaping, truncation markers and replacement
 * values included.
 */
export const MAX_EVENT_DETAIL_BYTES = 16 * 1_024;

/**
 * A second, independent ceiling on retained values. The byte budget already bounds these — no
 * value serializes to nothing — but a payload of millions of empty strings should stop being
 * traversed on a count rather than on arithmetic about how small a value can be.
 */
const MAX_NODES = 4_096;

/**
 * The input examination limit: the whole guarantee about work done *before* anything is retained.
 *
 * One unit is one source code unit read out of a string or a key, or one element visited in an
 * array or an object. Nothing in this module reads source material without charging for it first,
 * so a projection of a ten-megabyte payload costs the same as a projection of a small one.
 */
const MAX_EXAMINED_UNITS = 128 * 1_024;

/** The most of any one source string that is read, before the boundary pull-back below. */
const STRING_EXAMINATION = 4_096;

/** The most of any one property key that is read. */
const KEY_EXAMINATION = 512;

/** The most indices read out of any one array, however long the array says it is. */
const ARRAY_INDEX_LOOKAHEAD = 48;

/**
 * How far past the fields it keeps the projection will walk an object to report an exact count of
 * what it cut. Beyond this the marker is generic: an exact number is not worth enumerating a
 * million keys for.
 */
const FIELD_COUNT_LOOKAHEAD = 256;

/**
 * Bytes held back at every container so its truncation marker can always be written. Without it
 * the honest statement that something was cut is the first thing an exhausted budget cuts. The
 * largest marker is an object's — a `"…"` key, a colon, a comma and `[N more fields not shown]` —
 * which is well under this. A retained node is held back with it, for the same reason: a budget
 * that ran out of nodes rather than bytes would otherwise drop the marker just as silently.
 */
const MARKER_RESERVE = 64;

/**
 * Keys whose value is a handle to a provider conversation rather than a fact about this run.
 * Named here rather than in the shared redactor because these are not secrets everywhere — they
 * are this projection's refusal to hand the panel something it could be resumed from.
 */
const providerSessionKeys = new Set([
  "sessionid",
  "session",
  "providersessionid",
  "conversationid",
  "threadid",
  "rolloutpath",
  "resumepath",
  "resumetoken",
  "subscriptionid",
]);

const WITHHELD = "[WITHHELD]";
const REDACTED = "[REDACTED]";
const ELISION = "…";

const normalizedKey = (key: string): string => key.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();

const elided = (count: number, noun: string): string => `[${String(count)} ${noun} not shown]`;

const elidedUnknown = (noun: string): string => `[more ${noun} not shown]`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Whether this value has a JSON form at all.
 *
 * A field with none is dropped rather than counted as cut: serialising a non-finite number as
 * `null` would report a measurement that was never taken, and saying a field was "not shown"
 * would claim the budget refused something it never saw. Everything the budget *does* refuse is
 * counted, which is what the truncation markers are for.
 */
const hasJsonForm = (value: unknown): boolean => {
  const type = typeof value;
  if (type === "number") return Number.isFinite(value);
  if (type === "object") return true;
  return type === "string" || type === "boolean";
};

/**
 * How many own fields an object has, or as much of that as is cheap to learn.
 *
 * Stops at `lookahead`, because the reason this projection exists is that the object on the other
 * side may be enormous, and walking all of it to print an exact number is the cost the bound is
 * meant to refuse.
 */
const countFields = (value: object, lookahead: number): { count: number; exact: boolean } => {
  let count = 0;
  for (const key in value) {
    if (!isOwn(value, key)) continue;
    count += 1;
    if (count > lookahead) return { count, exact: false };
  }
  return { count, exact: true };
};

// Escapes `JSON.stringify` writes as two bytes rather than as `\u00XX`.
const shortEscapes = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/**
 * The exact number of UTF-8 bytes `JSON.stringify` writes for this string, quotes included.
 *
 * UTF-16 code units are not the unit that travels: a three-byte BMP character counts as one unit,
 * an astral pair as two, and a control character or a lone surrogate is escaped into six ASCII
 * bytes. Counting units instead of bytes is what would let a multibyte payload pass a byte cap it
 * exceeds by three times.
 *
 * Every caller measures a string it has already bounded. Nothing in this module hands this function
 * an unbounded provider string or key.
 */
const jsonStringBytes = (value: string): number => {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
      continue;
    }
    if (code < 0x20) {
      bytes += shortEscapes.has(code) ? 2 : 6;
      continue;
    }
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
      bytes += 6;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
      continue;
    }
    bytes += 3;
  }
  return bytes;
};

/**
 * The exact number of UTF-8 bytes this value serializes to. What the projection charges itself, and
 * what an aggregate budget over many projections spends.
 */
export const serializedJsonBytes = (value: JsonValue): number => {
  if (typeof value === "string") return jsonStringBytes(value);
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return String(value).length;
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item, index) => total + (index === 0 ? 0 : 1) + serializedJsonBytes(item),
      2,
    );
  }
  return Object.entries(value).reduce<number>(
    (total, [key, item], index) =>
      total + (index === 0 ? 0 : 1) + jsonStringBytes(key) + 1 + serializedJsonBytes(item),
    2,
  );
};

type Budget = {
  bytes: number;
  nodes: number;
  units: number;
  maxStringUnits: number;
  stringExamination: number;
};

const exhausted = (budget: Budget): boolean =>
  budget.bytes <= 0 || budget.nodes <= 0 || budget.units <= 0;

/** Commit these bytes and one retained value, or refuse. A budget never goes negative. */
const charge = (budget: Budget, bytes: number): boolean => {
  if (budget.nodes <= 0 || bytes > budget.bytes) return false;
  budget.bytes -= bytes;
  budget.nodes -= 1;
  return true;
};

/**
 * Charge for looking at `wanted` units of source and report how many may actually be read. Every
 * read of provider material goes through here, which is what makes the traversal's total work a
 * property of this module rather than of the payload.
 */
const examine = (budget: Budget, wanted: number): number => {
  const allowed = wanted < budget.units ? wanted : Math.max(0, budget.units);
  budget.units -= allowed;
  return allowed;
};

/**
 * Open a container: two bytes of brackets, plus the bytes and the one retained node held back so
 * that this container's truncation marker can always be written.
 */
const openContainer = (budget: Budget): boolean => {
  if (budget.nodes < 2 || 2 + MARKER_RESERVE > budget.bytes) return false;
  budget.bytes -= 2 + MARKER_RESERVE;
  budget.nodes -= 2;
  return true;
};

const releaseMarkerReserve = (budget: Budget): void => {
  budget.bytes += MARKER_RESERVE;
  budget.nodes += 1;
};

const literal = (budget: Budget, text: string): JsonValue | undefined =>
  charge(budget, jsonStringBytes(text)) ? text : undefined;

/**
 * Where a prefix of `units` code units may end. A cut between the halves of an astral pair leaves
 * a lone surrogate, which `JSON.stringify` escapes into six bytes of nothing legible.
 */
const wholeUnits = (value: string, units: number): number => {
  const code = units > 0 && units < value.length ? value.charCodeAt(units - 1) : 0;
  return code >= 0xd800 && code <= 0xdbff ? units - 1 : units;
};

/**
 * The bounded, redacted form of one source string, and how much of the source it leaves unsaid.
 *
 * The order is the whole point. A fixed prefix is taken first, so no rule ever sees more than
 * `STRING_EXAMINATION` code units. The prefix is then pulled back to a point where no secret
 * construct may have begun, so a credential that straddles the cut is withheld rather than half
 * shown. Only then is the — now bounded — text redacted.
 */
type Examined = { text: string; omitted: number };

const examinedString = (
  value: string,
  budget: Budget,
  parentKey: string | undefined,
  examination = STRING_EXAMINATION,
): Examined => {
  const read = examine(budget, Math.min(value.length, examination));
  const complete = read >= value.length;
  const head = value.slice(0, read);
  const end = complete ? head.length : wholeUnits(head, secretBoundaryCut(head));
  const source = end >= head.length ? head : head.slice(0, end);
  const text = parentKey !== undefined && isStructuredTextKey(parentKey)
    ? redactText(source)
    : redactFreeFormText(source);
  return { text, omitted: value.length - end };
};

const truncatedTo = (value: string, units: number, omitted: number): string => {
  const kept = wholeUnits(value, units);
  return `${value.slice(0, kept)}${ELISION} ${elided(value.length - kept + omitted, "more characters")}`;
};

/**
 * The most of this examined string that fits, as the string the panel will actually receive.
 *
 * A string's length is O(1), so the cut says exactly how much was cut: what the retained prefix
 * leaves out, plus whatever the examination boundary already withheld. The search is over the
 * prefix length — adding a code unit adds at least one byte and can only shorten the marker's
 * digits, so cost rises with length and a binary search finds the longest prefix that fits.
 *
 * The marker counts against the limit rather than being added on top of it. That makes the stated
 * cap true of what actually travels, and it makes the bound a fixed point: bounding an already
 * bounded string returns it unchanged, which is what lets an entry survive a write and a reload
 * without being trimmed a little further each time.
 */
const boundedString = (
  examined: Examined,
  remaining: number,
  maxUnits = MAX_STRING,
): string | undefined => {
  const { text, omitted } = examined;
  if (omitted === 0 && text.length <= maxUnits && jsonStringBytes(text) <= remaining) return text;
  let low = 0;
  // With nothing withheld at the examination boundary there is no honest marker to write at full
  // length, so the search stops one unit short of it.
  let high = Math.min(maxUnits, omitted === 0 ? text.length - 1 : text.length);
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncatedTo(text, middle, omitted);
    if (candidate.length <= maxUnits && jsonStringBytes(candidate) <= remaining) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
};

/**
 * A property key as it may be retained: bounded, redacted, and distinct from the keys beside it.
 *
 * A key is provider-originated material like any value. It used to be measured at full length and
 * emitted verbatim, so a key could carry a credential into the webview and a megabyte-long key
 * could be scanned in full only to be refused.
 */
const boundedKey = (key: string, budget: Budget): string | undefined => {
  const read = examine(budget, Math.min(key.length, KEY_EXAMINATION));
  if (read === 0 && key.length > 0) return undefined;
  const complete = read >= key.length;
  const head = key.slice(0, read);
  const end = complete ? head.length : wholeUnits(head, secretBoundaryCut(head));
  const redacted = redactFreeFormText(end >= head.length ? head : head.slice(0, end));
  if (redacted.length > MAX_KEY) {
    return `${redacted.slice(0, wholeUnits(redacted, MAX_KEY))}${ELISION}`;
  }
  return complete && end >= head.length ? redacted : `${redacted}${ELISION}`;
};

/**
 * The same key, made unique among the keys already kept in this object.
 *
 * Two distinct source keys can bound to one string — both truncated at the same prefix, or both
 * redacted to the same replacement — and an object cannot hold both. Colliding keys are numbered in
 * the order they were visited, so the same payload always projects to the same object.
 */
const COLLISION_LIMIT = 64;

const distinctKey = (key: string, taken: Set<string>): string | undefined => {
  if (!taken.has(key)) return key;
  for (let suffix = 2; suffix <= COLLISION_LIMIT; suffix += 1) {
    const candidate = `${key} (${String(suffix)})`;
    if (!taken.has(candidate)) return candidate;
  }
  return undefined;
};

type FieldSpec = { name: string; entries?: readonly FieldSpec[] };

type Projector = (
  value: unknown,
  depth: number,
  budget: Budget,
  parentKey: string | undefined,
) => JsonValue | undefined;

/**
 * An array, at a fixed number of indices.
 *
 * `ARRAY_INDEX_LOOKAHEAD` is the declared read-ahead: an array of a hundred thousand participants
 * is read at no more indices than an array of twenty. The count of what was left out comes from
 * `length`, which is O(1), so the marker stays exact without reading any of it.
 */
const boundedArray = (
  value: readonly unknown[],
  depth: number,
  budget: Budget,
  parentKey: string | undefined,
  entries: readonly FieldSpec[] | undefined,
  project: Projector,
): JsonValue | undefined => {
  if (depth === 0) return literal(budget, elided(value.length, "items"));
  if (!openContainer(budget)) return undefined;
  const kept: JsonValue[] = [];
  let read = 0;
  while (read < value.length && read < ARRAY_INDEX_LOOKAHEAD && kept.length < MAX_ITEMS) {
    if (examine(budget, 1) === 0) break;
    const index = read;
    read += 1;
    const overhead = kept.length === 0 ? 0 : 1;
    if (overhead > budget.bytes) break;
    budget.bytes -= overhead;
    const item = value[index];
    if (!hasJsonForm(item)) {
      budget.bytes += overhead;
      continue;
    }
    const inner = entries === undefined
      ? project(item, depth - 1, budget, parentKey)
      : projectFields(item, entries, depth - 1, budget);
    if (inner === undefined) {
      budget.bytes += overhead;
      if (exhausted(budget)) break;
      continue;
    }
    kept.push(inner);
  }
  releaseMarkerReserve(budget);
  const omitted = value.length - read;
  if (omitted > 0) {
    const overhead = kept.length === 0 ? 0 : 1;
    const marker = elided(omitted, "more items");
    if (overhead <= budget.bytes) {
      budget.bytes -= overhead;
      const written = literal(budget, marker);
      if (written === undefined) budget.bytes += overhead;
      else kept.push(written);
    }
  }
  return kept;
};

/**
 * Write one already-bounded key and its projected value into the object being built, or report
 * that nothing was written. The key's bytes are committed before the value is projected, and
 * refunded when the value did not fit, so the budget never pays for a field that is not kept.
 */
const putField = (
  kept: [string, JsonValue][],
  taken: Set<string>,
  budget: Budget,
  key: string,
  produce: (budget: Budget) => JsonValue | undefined,
): boolean => {
  const unique = distinctKey(key, taken);
  if (unique === undefined) return false;
  const overhead = jsonStringBytes(unique) + 1 + (kept.length === 0 ? 0 : 1);
  if (overhead > budget.bytes) return false;
  budget.bytes -= overhead;
  const inner = produce(budget);
  if (inner === undefined) {
    budget.bytes += overhead;
    return false;
  }
  kept.push([unique, inner]);
  taken.add(unique);
  return true;
};

const markerField = (
  kept: [string, JsonValue][],
  taken: Set<string>,
  budget: Budget,
  marker: string,
): void => {
  putField(kept, taken, budget, ELISION, (inner) => literal(inner, marker));
};

const boundedRecord = (
  value: Record<string, unknown>,
  depth: number,
  budget: Budget,
  project: Projector,
): JsonValue | undefined => {
  if (depth === 0) {
    const fields = countFields(value, FIELD_COUNT_LOOKAHEAD);
    return literal(
      budget,
      fields.exact ? elided(fields.count, "fields") : elidedUnknown("fields"),
    );
  }
  if (!openContainer(budget)) return undefined;
  const kept: [string, JsonValue][] = [];
  const taken = new Set<string>();
  let omitted = 0;
  let unknownRemainder = false;
  let stopped = false;
  for (const key in value) {
    if (!isOwn(value, key)) continue;
    if (examine(budget, 1) === 0) {
      unknownRemainder = true;
      omitted += 1;
      break;
    }
    if (stopped || kept.length >= MAX_FIELDS) {
      omitted += 1;
      if (omitted > FIELD_COUNT_LOOKAHEAD) {
        unknownRemainder = true;
        break;
      }
      continue;
    }
    const bounded = boundedKey(key, budget);
    if (bounded === undefined) {
      unknownRemainder = true;
      omitted += 1;
      break;
    }
    // Both replacements happen here rather than after the traversal: what is charged has to be the
    // string that travels, and a secret removed after it was measured is a secret that was copied.
    // The sensitivity test reads the examined prefix of the key, not the key, for the same reason.
    const normalized = normalizedKey(key.slice(0, KEY_EXAMINATION));
    const item = value[key];
    const sensitive = providerSessionKeys.has(normalized) || isSensitiveJsonKey(normalized);
    if (!sensitive && !hasJsonForm(item)) continue;
    const written = putField(kept, taken, budget, bounded, (inner) =>
      providerSessionKeys.has(normalized)
        ? literal(inner, WITHHELD)
        : isSensitiveJsonKey(normalized)
          ? literal(inner, REDACTED)
          : project(item, depth - 1, inner, key.slice(0, KEY_EXAMINATION)));
    if (!written) {
      omitted += 1;
      if (exhausted(budget)) stopped = true;
    }
  }
  releaseMarkerReserve(budget);
  if (omitted > 0) {
    markerField(
      kept,
      taken,
      budget,
      unknownRemainder ? elidedUnknown("fields") : elided(omitted, "more fields"),
    );
  }
  return Object.fromEntries(kept);
};

/**
 * A record projected over a fixed field list, in the order the reader can afford to lose them.
 *
 * Nothing is copied out of the source first: each named field is read, projected under the shared
 * budget and either kept or counted. The list is this module's own, so its keys are not
 * provider-originated and need no redaction — only the values under them do.
 */
const projectFields = (
  value: unknown,
  fields: readonly FieldSpec[],
  depth: number,
  budget: Budget,
): JsonValue | undefined => {
  if (!isRecord(value)) return project(value, depth, budget, undefined);
  if (depth === 0) {
    const found = countFields(value, FIELD_COUNT_LOOKAHEAD);
    return literal(budget, found.exact ? elided(found.count, "fields") : elidedUnknown("fields"));
  }
  if (!openContainer(budget)) return undefined;
  const kept: [string, JsonValue][] = [];
  const taken = new Set<string>();
  let omitted = 0;
  for (const field of fields) {
    if (!isOwn(value, field.name)) continue;
    const item = value[field.name];
    if (!hasJsonForm(item)) continue;
    if (examine(budget, 1) === 0) {
      omitted += 1;
      continue;
    }
    const written = putField(kept, taken, budget, field.name, (inner) =>
      field.entries !== undefined && Array.isArray(item)
        ? boundedArray(item, depth - 1, inner, field.name, field.entries, project)
        : project(item, depth - 1, inner, field.name));
    if (!written) omitted += 1;
  }
  releaseMarkerReserve(budget);
  if (omitted > 0) markerField(kept, taken, budget, elided(omitted, "more fields"));
  return Object.fromEntries(kept);
};

const project: Projector = (value, depth, budget, parentKey) => {
  if (budget.nodes <= 0) return undefined;
  if (value === null) return charge(budget, 4) ? null : undefined;
  if (typeof value === "boolean") return charge(budget, value ? 4 : 5) ? value : undefined;
  // A non-finite number has no JSON form. Dropping the field is the honest answer; serialising it
  // as null would report a measurement that was never taken.
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return charge(budget, String(value).length) ? value : undefined;
  }
  if (typeof value === "string") {
    const kept = boundedString(
      examinedString(value, budget, parentKey, budget.stringExamination),
      budget.bytes,
      budget.maxStringUnits,
    );
    if (kept === undefined) return undefined;
    budget.bytes -= jsonStringBytes(kept);
    budget.nodes -= 1;
    return kept;
  }
  if (Array.isArray(value)) return boundedArray(value, depth, budget, parentKey, undefined, project);
  if (!isRecord(value)) return undefined;
  return boundedRecord(value, depth, budget, project);
};

const empty = (value: JsonValue): boolean =>
  Array.isArray(value)
    ? value.length === 0
    : typeof value === "object" && value !== null && Object.keys(value).length === 0;

const newBudget = (
  maxBytes: number,
  maxStringUnits = MAX_STRING,
  stringExamination = STRING_EXAMINATION,
): Budget => ({
  bytes: maxBytes,
  nodes: MAX_NODES,
  units: MAX_EXAMINED_UNITS,
  maxStringUnits,
  stringExamination,
});

const finished = (value: JsonValue | undefined): JsonValue | undefined =>
  value === undefined || value === null || empty(value) ? undefined : value;

/**
 * One event's technical detail as the panel may hold it, or nothing when the event recorded no
 * detail worth a disclosure that would open on an empty box.
 */
export const boundedEventDetail = (
  payload: unknown,
  maxBytes = MAX_EVENT_DETAIL_BYTES,
): JsonValue | undefined =>
  finished(project(payload, MAX_DEPTH, newBudget(maxBytes), undefined));

/**
 * A published decision as the panel renders it.
 *
 * This one event is the run's conclusion rather than a disclosure, so it travelled whole — and
 * "controller-generated" was never the same claim as "bounded": every free-form part of it is
 * provider-originated. The candidate, the objections, the risks and each participant's validation
 * errors are whatever a model wrote.
 *
 * So it is bounded like any other payload, with two differences the ruling card needs. The fields
 * the card reads are named and projected in the order it can afford to lose them — the candidate
 * last, because one enormous candidate must not be what costs the reader the objections and risks
 * beside it. And the depth allowance is larger, because a candidate is a structured document
 * rather than a flat record, and its width is already fixed by the field list above.
 *
 * The field list is walked during the traversal rather than copied out of the payload first. The
 * subset used to be materialised by `flatMap` over every participant and every objection before
 * anything was bounded, which read and copied the whole of two arrays a provider controls in order
 * to keep twelve entries of each.
 */
const DECISION_DEPTH = 6;

const OBJECTION_FIELDS: readonly FieldSpec[] = [
  { name: "agentId" },
  { name: "text" },
  { name: "accepted" },
];

const PARTICIPANT_FIELDS: readonly FieldSpec[] = [
  { name: "agentId" },
  { name: "valid" },
  { name: "accepted" },
  { name: "candidateHash" },
  { name: "validationErrors" },
  { name: "objections", entries: OBJECTION_FIELDS },
  { name: "unresolvedRisks" },
  { name: "candidate" },
];

const DECISION_FIELDS: readonly FieldSpec[] = [
  { name: "stepId" },
  { name: "round" },
  { name: "policy" },
  { name: "status" },
  { name: "humanResolution" },
  { name: "candidateId" },
  { name: "candidateHash" },
  { name: "ruledBy" },
  { name: "rulingProvenance" },
  { name: "unresolvedRisks" },
  { name: "objections", entries: OBJECTION_FIELDS },
  { name: "participants", entries: PARTICIPANT_FIELDS },
  { name: "candidate" },
];

export const boundedDecisionDetail = (
  payload: unknown,
  maxBytes = MAX_EVENT_DETAIL_BYTES,
): JsonValue | undefined =>
  isRecord(payload)
    ? finished(projectFields(payload, DECISION_FIELDS, DECISION_DEPTH, newBudget(maxBytes)))
    : boundedEventDetail(payload, maxBytes);

/** A complete-enough decision for the result view, still bounded and redacted. */
export const MAX_RESULT_DECISION_BYTES = 64 * 1_024;
const MAX_RESULT_DECISION_STRING = 16 * 1_024;
const RESULT_DECISION_DEPTH = 10;

export const boundedResultDecision = (payload: unknown): JsonValue | undefined =>
  isRecord(payload)
    ? finished(projectFields(
        payload,
        DECISION_FIELDS,
        RESULT_DECISION_DEPTH,
        newBudget(
          MAX_RESULT_DECISION_BYTES,
          MAX_RESULT_DECISION_STRING,
          MAX_RESULT_DECISION_STRING + STRING_EXAMINATION,
        ),
      ))
    : undefined;

/** The hardest ceiling on a single string: no caller may ask for more examination than this. */
const TEXT_EXAMINATION_CEILING = 64 * 1_024;

/**
 * One free-form provider string, bounded and redacted under this module's rules and nothing else.
 *
 * The transcript needs the same guarantee for a single string that an event payload gets for a
 * whole object: a fixed examination limit, the secret-boundary pull-back, and an explicit marker
 * saying what was left out. `structured` selects the stricter redaction used for commands,
 * arguments, headers and process output; `maxUnits` raises how much is retained for a caller whose
 * byte budget is larger than an event row's, and is itself capped here rather than by the caller.
 *
 * Neither option can weaken redaction: there is no way in from outside to choose which rules run or
 * to skip them.
 */
export const boundedRedactedText = (
  value: string,
  maxBytes: number,
  options: { structured?: boolean; maxUnits?: number } = {},
): string => {
  const maxUnits = Math.min(options.maxUnits ?? MAX_STRING, TEXT_EXAMINATION_CEILING);
  const examination = Math.min(TEXT_EXAMINATION_CEILING, maxUnits + STRING_EXAMINATION);
  const budget: Budget = {
    bytes: maxBytes,
    nodes: MAX_NODES,
    units: examination,
    maxStringUnits: maxUnits,
    stringExamination: examination,
  };
  const examined = examinedString(
    value,
    budget,
    options.structured === true ? "command" : undefined,
    examination,
  );
  return boundedString(examined, maxBytes, maxUnits) ?? "";
};

/**
 * A transcript entry's `data` as it may be held in memory, written to disk and posted to the panel.
 *
 * Same traversal as an event's detail, with a deeper allowance: transcript data is a controller-
 * composed record rather than a provider document, and the byte, node and examination budgets are
 * what bound it either way. Unlike an event's detail an empty record is kept, because an entry that
 * recorded `{}` recorded something different from an entry that recorded nothing.
 */
const TRANSCRIPT_DATA_DEPTH = 8;

export const boundedTranscriptData = (
  payload: JsonValue,
  maxBytes: number,
): JsonValue | undefined => project(payload, TRANSCRIPT_DATA_DEPTH, newBudget(maxBytes), undefined);
