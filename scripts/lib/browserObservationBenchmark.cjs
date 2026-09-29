const crypto = require("node:crypto");

const bytes = (text) => Buffer.byteLength(text, "utf8");
const checkpoints = [10, 50, 100, 200];
const largeTextBytes = 8 * 1024;
const markers = [
  "Bachata processed your managed control request. Continue the same task using only controller results below.",
  "Bachata managed task handoff. Treat this controller-provided state as authoritative.",
];

// Decode the controller's JSON block without treating braces in source strings as structure.
// Only known prompt boundaries are eligible. An arbitrary model answer is never an observation.
const controllerPayload = (prompt) => {
  const marker = markers.map((value) => ({ value, at: prompt.indexOf(value) }))
    .filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at)[0];
  if (!marker) return undefined;
  const start = prompt.indexOf("{", marker.at + marker.value.length);
  if (start < 0) throw new Error("Managed prompt has no controller JSON block");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let cursor = start; cursor < prompt.length; cursor += 1) {
    const character = prompt[cursor];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      const text = prompt.slice(start, cursor + 1);
      return { text, value: JSON.parse(text), start, end: cursor + 1, kind: marker.value === markers[1] ? "handoff" : "continuation" };
    }
  }
  throw new Error("Managed prompt has an incomplete controller JSON block");
};

const observationStrings = (payload) => {
  const found = [];
  const walk = (value, location = [], verification = false) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, [...location, index], verification));
      return;
    }
    if (!value || typeof value !== "object") return;
    const isVerification = verification || value.kind === "verification.run";
    for (const [key, child] of Object.entries(value)) {
      const next = [...location, key];
      const category = key === "diff" ? "diff"
        : key === "text" && location.some((part) => ["context", "snippet", "snippets"].includes(part)) ? "source"
        : ["stdout", "stderr"].includes(key) ? "commandOutput"
        : key === "summary" && (isVerification || location.includes("verification")) ? "verification"
        : undefined;
      if (category && typeof child === "string") found.push({ category, text: child, path: next });
      else walk(child, next, isVerification || key === "verification");
    }
  };
  walk(payload);
  return found;
};

const countOmissions = (payload) => {
  let count = 0;
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["resultTruncated", "resultPayloadTruncated", "diffTruncated", "truncated"].includes(key) && child === true) count += 1;
      if (child && typeof child === "object") walk(child);
    }
  };
  walk(payload);
  return count;
};

const analyzeTrajectory = (records, provenance) => {
  const totals = {
    prompts: 0, handoffs: 0, promptBytes: 0, answerBytes: 0, controllerJsonBytes: 0,
    observationTextWireBytes: 0, largeObservationTextWireBytes: 0,
    repeatedObservationTextWireBytes: 0, omissionFlags: 0,
  };
  const categories = {};
  const seen = new Set();
  const turns = [];
  const growth = [];
  for (const record of records) {
    const decoded = controllerPayload(record.prompt);
    if (!decoded) continue;
    // A fresh handoff can be a different role, revision or rollover; sharing is not authorized.
    if (decoded.kind === "handoff") { seen.clear(); totals.handoffs += 1; }
    const promptBytes = bytes(record.prompt);
    const answerBytes = bytes(record.answer ?? "");
    const strings = observationStrings(decoded.value);
    let observationBytes = 0;
    let largeBytes = 0;
    let repeatedBytes = 0;
    for (const { category, text } of strings) {
      // Escaping is paid on the wire. Include the string's quotes, exclude its key/indentation.
      const wireBytes = bytes(JSON.stringify(text));
      const large = bytes(text) >= largeTextBytes;
      const digest = crypto.createHash("sha256").update(category).update("\0").update(text).digest("hex");
      const repeated = seen.has(digest);
      seen.add(digest);
      observationBytes += wireBytes;
      if (large) largeBytes += wireBytes;
      if (repeated) repeatedBytes += wireBytes;
      const group = categories[category] ??= { strings: 0, wireBytes: 0, largeWireBytes: 0, repeatedWireBytes: 0 };
      group.strings += 1;
      group.wireBytes += wireBytes;
      if (large) group.largeWireBytes += wireBytes;
      if (repeated) group.repeatedWireBytes += wireBytes;
    }
    totals.prompts += 1;
    totals.promptBytes += promptBytes;
    totals.answerBytes += answerBytes;
    totals.controllerJsonBytes += bytes(decoded.text);
    totals.observationTextWireBytes += observationBytes;
    totals.largeObservationTextWireBytes += largeBytes;
    totals.repeatedObservationTextWireBytes += repeatedBytes;
    totals.omissionFlags += countOmissions(decoded.value);
    turns.push({ turn: totals.prompts, promptBytes, controllerJsonBytes: bytes(decoded.text), observationTextWireBytes: observationBytes });
    if (checkpoints.includes(totals.prompts)) growth.push({
      turns: totals.prompts,
      sentPromptBytes: totals.promptBytes,
      recordedTextBytes: totals.promptBytes + totals.answerBytes,
      largeObservationTextWireBytes: totals.largeObservationTextWireBytes,
    });
  }
  const ratio = (value) => totals.promptBytes ? Number((value / totals.promptBytes).toFixed(4)) : 0;
  return {
    provenance, largeTextThresholdBytes: largeTextBytes, ...totals,
    protocolAndWrapperBytes: totals.promptBytes - totals.controllerJsonBytes,
    controllerMetadataJsonBytes: totals.controllerJsonBytes - totals.observationTextWireBytes,
    observationShare: ratio(totals.observationTextWireBytes),
    largeObservationShare: ratio(totals.largeObservationTextWireBytes),
    repeatedObservationShare: ratio(totals.repeatedObservationTextWireBytes),
    categories, growth, turns,
  };
};

// Accept a native transcript export, native JSONL, or explicit research records. Do not mix
// local-provider calls into a browser trajectory. Raw prompts and paths never enter the report.
const parseTrace = (text) => {
  let value;
  try { value = JSON.parse(text); } catch {
    value = text.split("\n").filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid transcript JSON on nonempty line ${String(index + 1)}`); }
    });
  }
  const entries = Array.isArray(value) ? value : value.transcript ?? value.entries;
  if (!Array.isArray(entries)) throw new Error("Expected transcript entries or research prompt records");
  const records = [];
  const pending = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid transcript entry");
    const explicit = typeof entry.prompt === "string";
    const native = entry.kind === "prompt" && (entry.eventType === "agent.prompt" || entry.eventType?.startsWith("browser.managed."));
    const prompt = explicit ? entry.prompt : native ? entry.text : undefined;
    if (typeof prompt === "string" && markers.some((marker) => prompt.includes(marker))) {
      const record = { prompt, ...(explicit && typeof entry.answer === "string" ? { answer: entry.answer } : {}) };
      records.push(record);
      pending.set(entry.agentId ?? "research", record);
    } else if (native) pending.delete(entry.agentId ?? "research");
    else if (entry.kind === "answer" || entry.kind === "interrupted") {
      const previous = pending.get(entry.agentId ?? "research");
      if (previous && typeof entry.text === "string") previous.answer = entry.text;
      pending.delete(entry.agentId ?? "research");
    }
  }
  return records;
};

module.exports = { analyzeTrajectory, controllerPayload, observationStrings, parseTrace };
