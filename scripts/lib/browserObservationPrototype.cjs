// Research only. No runtime import, setting, production tool registration or persisted state.
const { createHash, randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");
const { controllerPayload, observationStrings } = require("./browserObservationBenchmark.cjs");

const decode = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const wireBytes = (value) => Buffer.byteLength(JSON.stringify(value, null, 2));
const notice = "Observation previews are incomplete controller evidence. Use context.recallObservation with id, offsetBytes and maxBytes for exact stored UTF-8 slices; status and fileVersion remain authoritative metadata.";

const observationStore = () => {
  const scope = randomUUID();
  const objects = new Map();
  const digests = new Map();
  const exposed = new Set();
  let retainedBytes = 0;
  const admit = (text, category) => {
    const bytes = Buffer.from(text, "utf8");
    const digest = createHash("sha256").update(category).update("\0").update(bytes).digest("hex");
    if (digests.has(digest)) return digests.get(digest);
    if (objects.size >= 1024 || retainedBytes + bytes.length > 16 * 1024 * 1024) throw new Error("Research observation store budget exceeded");
    const id = `observation-${scope}-${String(objects.size + 1)}`;
    retainedBytes += bytes.length;
    objects.set(id, bytes);
    digests.set(digest, id);
    return id;
  };
  const recall = ({ id, offsetBytes, maxBytes }) => {
    const bytes = objects.get(id);
    if (!bytes) throw new Error("Unknown observation in this research scope");
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > bytes.length
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024) throw new Error("Invalid observation slice");
    if (offsetBytes < bytes.length && (bytes[offsetBytes] & 0xc0) === 0x80) throw new Error("Offset splits a UTF-8 character");
    let end = Math.min(bytes.length, offsetBytes + maxBytes);
    while (end < bytes.length && end > offsetBytes && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === offsetBytes && offsetBytes < bytes.length) throw new Error("Slice budget cannot hold one UTF-8 character");
    return { id, offsetBytes, nextOffsetBytes: end, totalBytes: bytes.length, text: decode(bytes.subarray(offsetBytes, end)) };
  };
  const receipt = (id) => {
    const bytes = objects.get(id);
    if (!bytes) throw new Error("Unknown observation in this research scope");
    let tail = Math.max(0, bytes.length - 512);
    while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail += 1;
    return { id, totalBytes: bytes.length, incomplete: true, head: recall({ id, offsetBytes: 0, maxBytes: 512 }).text, tail: decode(bytes.subarray(tail)) };
  };
  return { admit, recall, receipt, wasExposed: (id) => exposed.has(id), markExposed: (id) => exposed.add(id) };
};

const project = (prompt, store, policy = "preview-first") => {
  if (!["preview-first", "inline-once"].includes(policy)) throw new Error("Unknown research projection policy");
  const decoded = controllerPayload(prompt);
  if (!decoded) return { prompt, packed: [] };
  const value = structuredClone(decoded.value);
  const packed = [];
  for (const field of observationStrings(value)) {
    if (Buffer.byteLength(field.text) < 8192) continue;
    const id = store.admit(field.text, field.category);
    const alreadyExposed = store.wasExposed(id);
    if (policy === "inline-once" && !alreadyExposed) { store.markExposed(id); continue; }
    let target = value;
    for (const key of field.path.slice(0, -1)) target = target[key];
    target[field.path.at(-1)] = { observation: { ...store.receipt(id), ...(policy === "inline-once" ? { previouslyExposedInThisScope: true } : {}) } };
    packed.push({ id, original: field.text });
  }
  return {
    prompt: packed.length ? `${prompt.slice(0, decoded.start)}${JSON.stringify(value, null, 2)}${prompt.slice(decoded.end)}\n\n${notice}` : prompt,
    packed,
  };
};

const measurePrototype = (records, policy = "preview-first") => {
  let store = observationStore();
  let projectedPromptBytes = 0;
  let packedExposures = 0;
  let partialRecallPromptBytes = 0;
  let fullRecallPromptBytes = 0;
  let partialRecallCalls = 0;
  let fullRecallCalls = 0;
  for (const record of records) {
    const decoded = controllerPayload(record.prompt);
    if (!decoded) continue;
    if (decoded.kind === "handoff") store = observationStore();
    const projected = project(record.prompt, store, policy);
    projectedPromptBytes += Buffer.byteLength(projected.prompt);
    packedExposures += projected.packed.length;
    const framingBytes = Buffer.byteLength(record.prompt) - Buffer.byteLength(decoded.text) + Buffer.byteLength(`\n\n${notice}`);
    for (const field of projected.packed) {
      const original = Buffer.from(field.original);
      let offset = Math.floor(original.length / 2);
      while (offset < original.length && (original[offset] & 0xc0) === 0x80) offset += 1;
      const partial = store.recall({ id: field.id, offsetBytes: offset, maxBytes: Math.min(16 * 1024, Math.ceil(original.length / 10)) });
      if (!Buffer.from(partial.text).equals(original.subarray(offset, partial.nextOffsetBytes))) throw new Error("Partial recall changed exact bytes");
      partialRecallPromptBytes += wireBytes({ results: [{ kind: "context.recallObservation", ...partial }] }) + framingBytes;
      partialRecallCalls += 1;
      const chunks = [];
      for (let cursor = 0; cursor < original.length;) {
        const result = store.recall({ id: field.id, offsetBytes: cursor, maxBytes: 16 * 1024 });
        chunks.push(Buffer.from(result.text));
        cursor = result.nextOffsetBytes;
        fullRecallPromptBytes += wireBytes({ results: [{ kind: "context.recallObservation", ...result }] }) + framingBytes;
        fullRecallCalls += 1;
      }
      if (!Buffer.concat(chunks).equals(original)) throw new Error("Full recall changed exact bytes");
    }
  }
  return {
    provenance: "offline-counterfactual; scripted exact retrieval, no model decisions or provider calls",
    policy,
    previewBytesPerEnd: 512, thresholdBytes: 8192, maxRecallBytes: 16 * 1024,
    projectedPromptBytes, packedExposures,
    noRecall: { sentPromptBytes: projectedPromptBytes, extraCalls: 0 },
    partialRecall: { sentPromptBytes: projectedPromptBytes + partialRecallPromptBytes, extraCalls: partialRecallCalls,
      policy: "Recall a middle slice of about 10% per packed exposure, capped at 16 KiB" },
    fullRecall: { sentPromptBytes: projectedPromptBytes + fullRecallPromptBytes, extraCalls: fullRecallCalls },
  };
};

module.exports = { observationStore, project, measurePrototype };
