const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  createBrowserActionCandidate,
} = require("../dist/browser/actions.js");
const {
  interpretBrowserActions,
} = require("../dist/browser/semanticInterpreter.js");
const {
  runLocalModel,
} = require("../dist/browser/localModelBroker.js");

const startServer = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const options = (endpoint) => ({
  endpoint,
  model: "prism-ml/Bonsai-27B-mlx-1bit",
  timeoutMs: 2_000,
  maxInputBytes: 1_048_576,
  allowRemote: false,
});

test("semantic interpretation can select a controller-generated read candidate without changing it", async () => {
  const responseText = "Please read the file `src/config.ts` now.";
  const start = responseText.indexOf("read");
  const end = responseText.length;
  let requestBody;
  const server = await startServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                execute: ["r1"],
                reject: [],
                ambiguous: [],
              }),
            },
          }],
        }),
      );
    });
  });
  try {
    const deterministic = createBrowserActionCandidate({
      kind: "workspace.read",
      risk: "readOnly",
      origin: "heuristic",
      confidence: "medium",
      source: {
        start,
        end,
        text: responseText.slice(start, end),
      },
      path: "src/config.ts",
    });
    const result = await interpretBrowserActions(
      responseText,
      [],
      [deterministic],
      options(server.endpoint),
      new AbortController().signal,
    );

    assert.equal(result.warning, undefined);
    assert.deepEqual(result.actions, [deterministic]);
    assert.equal(requestBody.model, "prism-ml/Bonsai-27B-mlx-1bit");
    assert.equal(requestBody.temperature, 0);
    assert.equal(requestBody.response_format, undefined);
    const prompt = JSON.parse(requestBody.messages[1].content);
    assert.equal(prompt.candidates[0].id, "r1");
    assert.equal(prompt.candidates[0].parsedArguments.path, "src/config.ts");
  } finally {
    await server.close();
  }
});

test("semantic interpretation rejects model-invented candidate IDs", async () => {
  const responseText = "Please read `src/config.ts`.";
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              execute: ["invented-secret-file"],
              reject: [],
              ambiguous: [],
            }),
          },
        }],
      }),
    );
  });
  try {
    const result = await interpretBrowserActions(
      responseText,
      [],
      [],
      options(server.endpoint),
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.match(result.warning, /abstained on 1 candidate/);
  } finally {
    await server.close();
  }
});

test("semantic interpretation refuses remote endpoints by default", async () => {
  const result = await interpretBrowserActions(
    "Read `src/config.ts`.",
    [],
    [],
    options("https://example.com/v1"),
    new AbortController().signal,
  );

  assert.deepEqual(result.actions, []);
  assert.match(result.warning, /Remote semantic interpreters are disabled/);
});

test("local model broker enforces loopback endpoints independently", async () => {
  let remoteContacted = false;
  const server = http.createServer(() => {
    remoteContacted = true;
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    for (const endpoint of [
      "http://93.184.216.34:1234",
      "https://example.com/v1",
      "ftp://127.0.0.1:1234",
      "not a url",
    ]) {
      await assert.rejects(
        () => runLocalModel("classify", { backend: "lmstudio", endpoint, timeoutMs: 1_000 }),
        /loopback HTTP\(S\)|not a valid URL/u,
        endpoint,
      );
    }
    assert.equal(remoteContacted, false);
    await assert.rejects(
      () => runLocalModel("classify", { backend: "lmstudio", endpoint: `http://localhost:${String(server.address().port)}`, timeoutMs: 1_500 }),
      (error) => !/loopback|not a valid URL/u.test(error.message),
    );
  } finally {
    server.close();
  }
});

test("semantic interpreter transport failures preserve deterministic extraction and are not disguised as abstention", async () => {
  const responseText = "Read `src/config.ts`.";
  const deterministic = createBrowserActionCandidate({
    kind: "workspace.read",
    risk: "readOnly",
    origin: "heuristic",
    confidence: "medium",
    source: { start: 0, end: responseText.length, text: responseText },
    path: "src/config.ts",
  });
  const server = await startServer((_request, response) => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("model unavailable");
  });
  try {
    const result = await interpretBrowserActions(
      responseText,
      [],
      [deterministic],
      options(server.endpoint),
      new AbortController().signal,
    );
    // EX-R26-02. A transport/config failure must not read as model abstention: no extra actions,
    // and a distinct "interpretation failed" warning rather than "abstained on N candidate(s)".
    assert.deepEqual(result.actions, [deterministic]);
    assert.doesNotMatch(result.warning, /abstained/);
    assert.match(result.warning, /interpretation failed/);
    assert.match(result.warning, /HTTP 500/);
  } finally {
    await server.close();
  }
});

test("semantic interpretation never offers a mutating deletion candidate to the local model", async () => {
  const responseText = "Delete the `tmp` directory.";
  let requests = 0;
  const server = await startServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("must not be called");
  });
  try {
    const result = await interpretBrowserActions(
      responseText,
      [],
      [],
      options(server.endpoint),
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.equal(result.warning, undefined);
    assert.equal(requests, 0);
  } finally {
    await server.close();
  }
});

test("Ollama requests propagate the configured bearer token", async () => {
  const responseText = "Read `src/config.ts`.";
  let authorization;
  let requestPath;
  const server = await startServer((request, response) => {
    authorization = request.headers.authorization;
    requestPath = request.url;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, "prism-ml/Bonsai-27B-mlx-1bit");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        message: {
          content: JSON.stringify({
            execute: ["r1"],
            reject: [],
            ambiguous: [],
          }),
        },
      }));
    });
  });
  try {
    const result = await interpretBrowserActions(
      responseText,
      [],
      [],
      {
        ...options(server.endpoint),
        backend: "ollama",
        apiKey: "test-token",
      },
      new AbortController().signal,
    );
    assert.equal(result.warning, undefined);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].kind, "workspace.read");
    assert.equal(result.actions[0].path, "src/config.ts");
    assert.equal(authorization, "Bearer test-token");
    assert.equal(requestPath, "/api/chat");
  } finally {
    await server.close();
  }
});

// EX-R26-02. Entry-level (interpretBrowserActions) coverage with global fetch stubbed, so no real
// network request is ever made. These pin the opt-in/opt-out authority and the transport-vs-
// abstention distinction at the exact public entry the runtime calls.
test("opt-in remote interpretation reaches the exact configured endpoint with the API key", async () => {
  const realFetch = globalThis.fetch;
  const contacted = [];
  globalThis.fetch = async (url, init) => {
    contacted.push({ url: String(url), authorization: init?.headers?.authorization });
    return {
      ok: true,
      status: 200,
      redirected: false,
      type: "basic",
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ execute: ["r1"], reject: [], ambiguous: [] }) } }] }),
    };
  };
  try {
    const result = await interpretBrowserActions(
      "Read `src/config.ts`.",
      [],
      [],
      {
        endpoint: "http://model.remote.test:1234",
        model: "prism-ml/Bonsai-27B-mlx-1bit",
        timeoutMs: 2_000,
        maxInputBytes: 1_048_576,
        allowRemote: true,
        apiKey: "remote-secret",
      },
      new AbortController().signal,
    );
    assert.equal(result.warning, undefined);
    assert.equal(contacted.length, 1);
    assert.equal(contacted[0].url, "http://model.remote.test:1234/v1/chat/completions");
    assert.equal(contacted[0].authorization, "Bearer remote-secret");
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].kind, "workspace.read");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("opt-out never touches the network for a remote endpoint", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network must not be contacted on the opt-out path");
  };
  try {
    const result = await interpretBrowserActions(
      "Read `src/config.ts`.",
      [],
      [],
      {
        endpoint: "http://model.remote.test:1234",
        model: "prism-ml/Bonsai-27B-mlx-1bit",
        timeoutMs: 2_000,
        maxInputBytes: 1_048_576,
        allowRemote: false,
        apiKey: "remote-secret",
      },
      new AbortController().signal,
    );
    assert.equal(calls, 0);
    assert.deepEqual(result.actions, []);
    assert.match(result.warning, /Remote semantic interpreters are disabled/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an HTTP 503 from the interpreter is a transport failure, not abstention", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    redirected: false,
    type: "basic",
    json: async () => ({}),
  });
  try {
    const result = await interpretBrowserActions(
      "Read `src/config.ts`.",
      [],
      [],
      {
        endpoint: "http://model.remote.test:1234",
        model: "prism-ml/Bonsai-27B-mlx-1bit",
        timeoutMs: 2_000,
        maxInputBytes: 1_048_576,
        allowRemote: true,
      },
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.doesNotMatch(result.warning, /abstained/);
    assert.match(result.warning, /interpretation failed/);
    assert.match(result.warning, /HTTP 503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a model that answers with unparseable output stays safely ambiguous", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    redirected: false,
    type: "basic",
    json: async () => ({ choices: [{ message: { content: "not json at all {{{" } }] }),
  });
  try {
    const result = await interpretBrowserActions(
      "Read `src/config.ts`.",
      [],
      [],
      {
        endpoint: "http://127.0.0.1:1234",
        model: "prism-ml/Bonsai-27B-mlx-1bit",
        timeoutMs: 2_000,
        maxInputBytes: 1_048_576,
        allowRemote: false,
      },
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.match(result.warning, /abstained on 1 candidate/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("weak-model fallback is limited to controller-extracted list and dependency graph candidates", () => {
  const { createReadOnlyInterpretationCandidates } = require("../dist/browser/localInterpretation.js");
  const candidates = createReadOnlyInterpretationCandidates([
    "List talents-backend/src/routes",
    "Show dependencies of talents-backend/src/routes/jobs.ts",
    "Show importers of talents-backend/src/services/jobService.ts",
  ].join("\n"));
  assert.deepEqual(candidates.map((candidate) => ({ kindHint: candidate.kindHint, parsedArguments: candidate.parsedArguments })), [
    { kindHint: "list", parsedArguments: { path: "talents-backend/src/routes" } },
    { kindHint: "dependencies", parsedArguments: { path: "talents-backend/src/routes/jobs.ts" } },
    { kindHint: "dependents", parsedArguments: { path: "talents-backend/src/services/jobService.ts" } },
  ]);
});

test("structured browser actions bypass the weak local interpreter", async () => {
  let requests = 0;
  const server = await startServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("must not be called");
  });
  try {
    const structured = createBrowserActionCandidate({
      kind: "workspace.read",
      risk: "readOnly",
      origin: "structured",
      confidence: "explicit",
      source: { start: 0, end: 10, text: "structured" },
      path: "src/config.ts",
    });
    const result = await interpretBrowserActions(
      "irrelevant prose",
      [],
      [structured],
      options(server.endpoint),
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, [structured]);
    assert.deepEqual(result.contextActions, []);
    assert.equal(requests, 0);
  } finally {
    await server.close();
  }
});

test("dependency graph prose is not offered to the weak interpreter outside managed mode", async () => {
  let requests = 0;
  const server = await startServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("must not be called");
  });
  try {
    const result = await interpretBrowserActions(
      "Show dependencies of talents-backend/src/routes/jobs.ts",
      [],
      [],
      options(server.endpoint),
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.contextActions, []);
    assert.equal(requests, 0);
  } finally {
    await server.close();
  }
});

test("managed semantic fallback may select dependency graph actions", async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ execute: ["p1", "d2"], reject: [], ambiguous: [] }),
        },
      }],
    }));
  });
  try {
    const result = await interpretBrowserActions(
      [
        "Show dependencies of talents-backend/src/routes/jobs.ts",
        "Show importers of talents-backend/src/services/jobService.ts",
      ].join("\n"),
      [],
      [],
      { ...options(server.endpoint), managedContextActions: true },
      new AbortController().signal,
    );
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.contextActions, [
      { kind: "context.dependencies", path: "talents-backend/src/routes/jobs.ts" },
      { kind: "context.dependents", path: "talents-backend/src/services/jobService.ts" },
    ]);
  } finally {
    await server.close();
  }
});
