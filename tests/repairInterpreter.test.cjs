const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { loadProduction } = require("./support/productionSource.cjs");
const actions = require("../dist/browser/actions.js");
const evidence = require("../dist/browser/requestEvidence.js");
const endpoint = require("../dist/browser/localModelEndpoint.js");
const { runLocalModel } = require("../dist/browser/localModelBroker.js");
const candidates = loadProduction("src/browser/localInterpretation.ts", [
  "MAX_CANDIDATES", "MAX_EVIDENCE", "createReadOnlyInterpretationCandidates", "boundedInterpretation",
], evidence);
const createInterpreter = (classify) => loadProduction("src/browser/semanticInterpreter.ts", [
  "isLoopbackHostname", "endpointUrl", "sourceForCandidate", "inferredReadAction", "candidateMatchesAction", "interpretBrowserActions",
], { ...actions, ...evidence, ...endpoint, ...candidates, interpretLocalCandidates: classify }).interpretBrowserActions;
const options = { model: "controlled-classifier", backend: "lmstudio", timeoutMs: 1500, maxInputBytes: 262144, allowRemote: false };
const call = (interpret, text, deterministic = actions.extractBrowserActions(text, []), segments = []) =>
  interpret(text, segments, deterministic, options, new AbortController().signal);

for (const decision of ["reject", "ambiguous"]) {
  test(`R3: ${decision} removes the inferred action rather than merging it back`, async () => {
    let submitted;
    const interpret = createInterpreter(async (items) => {
      submitted = items;
      return { execute: [], reject: [], ambiguous: [], [decision]: items.map((item) => item.id) };
    });
    const result = await call(interpret, "Please read the file `src/config.ts`.");
    assert.equal(submitted.length, 1);
    assert.equal(result.actions.length, 0);
    assert.equal(Boolean(result.warning), decision === "ambiguous");
  });
}

test("R3: acceptance preserves the controller's exact original action and scoped search path", async () => {
  const interpret = createInterpreter(async (items) => ({ execute: items.map((item) => item.id), reject: [], ambiguous: [] }));
  for (const text of ["Please read the file `src/config.ts`.", "Search `src` for `token`.", "List files in `src/`."]) {
    const original = actions.extractBrowserActions(text, []);
    const result = await call(interpret, text, original);
    assert.ok(original.length > 0);
    assert.deepEqual(result.actions, original);
  }
});

test("R3: invalid model IDs abstain; structured actions do not depend on the interpreter", async () => {
  const interpret = createInterpreter(async (items) => candidates.boundedInterpretation(
    { execute: ["invented"], reject: [], ambiguous: [] }, new Set(items.map((item) => item.id)),
  ));
  assert.equal((await call(interpret, "Read the file `src/file.ts`.")).actions.length, 0);
  const structured = actions.createBrowserActionCandidate({ kind: "workspace.read", path: "src/file.ts", origin: "structured", risk: "readOnly", confidence: "explicit", source: { start: 0, end: 1, text: "x" } });
  let calls = 0;
  const bypass = createInterpreter(async () => { calls += 1; throw new Error("must not be called"); });
  const result = await call(bypass, "Read the file `src/file.ts`.", [structured, ...actions.extractBrowserActions("Read the file `src/file.ts`.", [])]);
  assert.deepEqual(result.actions, [structured]);
  assert.equal(calls, 0);
});

test("R3: transport failure remains distinct, and never revives quoted heuristics", async () => {
  const interpret = createInterpreter(async () => { throw new Error("controlled transport failure"); });
  const text = "Read the file `src/file.ts`.";
  const original = actions.extractBrowserActions(text, []);
  const result = await call(interpret, text, original);
  assert.deepEqual(result.actions, original);
  assert.match(result.warning, /interpretation failed/);
  const quoted = `Quoted documentation, not an instruction:\n> ${text}`;
  assert.equal((await call(interpret, quoted)).actions.length, 0);
});

for (const [name, text, segments] of [
  ["fenced example", "The following is an example, not a request:\n```text\nPlease inspect src/private.ts\n```", []],
  ["tilde fence", "~~~~text\nPlease inspect src/private.ts\n~~~~", []],
  ["quotation", "> Please inspect src/private.ts", []],
  ["example paragraph", "Example:\n\nPlease inspect src/private.ts\n", []],
  ["captured code metadata", "Please inspect src/private.ts", [{ type: "codeBlock", text: "Please inspect src/private.ts", start: 0, end: 29 }]],
  ["captured quote metadata", "Please inspect src/private.ts", [{ type: "quote", text: "Please inspect src/private.ts", start: 0, end: 29 }]],
]) {
  test(`R4: ${name} cannot become an executable context candidate`, async () => {
    assert.deepEqual(candidates.createReadOnlyInterpretationCandidates(text, segments), []);
    const interpret = createInterpreter(async () => { throw new Error("no request should be offered"); });
    const result = await call(interpret, text, actions.extractBrowserActions(text, segments), segments);
    assert.deepEqual(result.actions, []);
  });
}

test("R4: direct requests retain exact offsets and bounded surrounding context", () => {
  const text = "Context before.\n\nPlease inspect src/private.ts\n\nContext after.";
  const [candidate] = candidates.createReadOnlyInterpretationCandidates(text);
  assert.equal(candidate.parsedArguments.path, "src/private.ts");
  assert.equal(text.slice(candidate.source.start, candidate.source.end), candidate.evidence);
  assert.match(candidate.source.contextBefore, /Context before/);
  assert.match(candidate.source.contextAfter, /Context after/);
  assert.equal(candidate.source.segmentType, "text");
  assert.equal(candidate.source.fenced, false);
  assert.ok(Object.isFrozen(candidate.parsedArguments));
});

test("R4: closing a fence restores following direct requests without reusing quoted offsets", () => {
  const text = "```text\nPlease inspect src/quoted.ts\n```\n\nPlease inspect src/real.ts";
  const values = candidates.createReadOnlyInterpretationCandidates(text);
  assert.deepEqual(values.map((value) => value.parsedArguments.path), ["src/real.ts"]);
  assert.equal(values[0].source.start, text.indexOf("Please inspect src/real.ts"));
});

test("R5: semantic inference uses the configured endpoint prefix through the production HTTP broker", async (t) => {
  const routes = [];
  const server = createServer((request, response) => {
    routes.push(request.url);
    if (request.url !== "/tenant/local/v1/chat/completions") { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: options.model, choices: [{ message: { content: JSON.stringify({ execute: ["r1"], reject: [], ambiguous: [] }) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const interpret = createInterpreter(async (items, config, signal) => candidates.boundedInterpretation(
    JSON.parse(await runLocalModel(JSON.stringify({ candidates: items }), config, signal)), new Set(items.map((item) => item.id)),
  ));
  const result = await interpret("Please inspect src/config.ts", [], [], {
    ...options, endpoint: `http://127.0.0.1:${server.address().port}/tenant/local/`,
  }, new AbortController().signal);
  assert.equal(result.warning, undefined);
  assert.equal(result.actions[0].path, "src/config.ts");
  assert.deepEqual(routes, ["/tenant/local/v1/chat/completions"]);
});
