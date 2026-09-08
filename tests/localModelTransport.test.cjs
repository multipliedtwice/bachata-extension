const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { runLocalModel } = require("../dist/browser/localModelBroker.js");

const listen = (handler) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const close = (server) => new Promise((resolve) => server.close(resolve));

// PAIR-R26-01. A loopback service the reader configured can still answer with a redirect. The
// transport must refuse the redirect at the fetch boundary, so the prompt body never reaches the
// redirect destination (same host, different port — a cross-origin destination) — the request to
// that destination is never made.
test("a 307 from the local endpoint never contacts the redirect destination (explicit backend)", async () => {
  let destinationHits = 0;
  const destination = await listen((_request, response) => {
    destinationHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  });
  const off = `http://127.0.0.1:${String(destination.address().port)}/v1/chat/completions`;
  const redirector = await listen((_request, response) => {
    response.writeHead(307, { location: off });
    response.end();
  });
  const endpoint = `http://127.0.0.1:${String(redirector.address().port)}`;
  try {
    await assert.rejects(
      () => runLocalModel("classify", { backend: "lmstudio", endpoint, model: "m", timeoutMs: 2_000 }),
    );
    assert.equal(destinationHits, 0, "a redirect carried the prompt to the redirect destination");
  } finally {
    await close(redirector);
    await close(destination);
  }
});

test("a 308 from the local endpoint never contacts the destination under the auto fallback", async () => {
  let destinationHits = 0;
  const destination = await listen((_request, response) => {
    destinationHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const off = `http://127.0.0.1:${String(destination.address().port)}/api/chat`;
  const redirector = await listen((_request, response) => {
    response.writeHead(308, { location: off });
    response.end();
  });
  const endpoint = `http://127.0.0.1:${String(redirector.address().port)}`;
  try {
    await assert.rejects(
      () => runLocalModel("classify", { endpoint, model: "m", timeoutMs: 2_000 }),
    );
    assert.equal(destinationHits, 0, "the auto fallback followed a redirect to its destination");
  } finally {
    await close(redirector);
    await close(destination);
  }
});

test("a normal 200 from a loopback endpoint still succeeds", async () => {
  const server = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "{\"execute\":[]}" } }] }));
  });
  const endpoint = `http://127.0.0.1:${String(server.address().port)}`;
  try {
    const text = await runLocalModel("classify", { backend: "lmstudio", endpoint, model: "m", timeoutMs: 2_000 });
    assert.equal(text, "{\"execute\":[]}");
  } finally {
    await close(server);
  }
});

// EX-R26-02. Only the explicitly opted-in semantic path carries authority past the loopback guard.
// The remote endpoint is never actually called here — global fetch is stubbed — so no external
// request is made; the assertion is only that the guard is bypassed for the opted-in path and
// enforced for every other.
test("remote authority reaches the authorized remote endpoint; default and opt-out refuse it", async () => {
  const realFetch = globalThis.fetch;
  const contacted = [];
  globalThis.fetch = async (url) => {
    contacted.push(String(url));
    return {
      ok: true,
      status: 200,
      redirected: false,
      type: "basic",
      json: async () => ({ choices: [{ message: { content: "{\"execute\":[]}" } }] }),
    };
  };
  try {
    const remote = "http://model.remote.test:1234";
    const opted = await runLocalModel("classify", {
      backend: "lmstudio",
      endpoint: remote,
      model: "m",
      timeoutMs: 2_000,
      allowRemoteEndpoint: true,
    });
    assert.equal(opted, "{\"execute\":[]}");
    assert.ok(
      contacted.some((url) => url.startsWith(remote)),
      "the opted-in remote endpoint was not the one contacted",
    );

    contacted.length = 0;
    await assert.rejects(
      () => runLocalModel("classify", { backend: "lmstudio", endpoint: remote, model: "m", timeoutMs: 2_000 }),
      /loopback HTTP\(S\)/u,
      "a non-opted-in request reached a remote endpoint",
    );
    assert.equal(contacted.length, 0, "the loopback guard let a default request touch the network");

    await assert.rejects(
      () => runLocalModel("classify", { backend: "lmstudio", endpoint: remote, model: "m", timeoutMs: 2_000, allowRemoteEndpoint: false }),
      /loopback HTTP\(S\)/u,
    );
    assert.equal(contacted.length, 0, "an explicit opt-out let a request touch the network");
  } finally {
    globalThis.fetch = realFetch;
  }
});
