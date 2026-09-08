const assert = require("node:assert/strict");
const {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  extractBrowserActions,
  patchRisk,
} = require("../dist/browser/actions.js");
const {
  executeBrowserAction,
} = require("../dist/browser/workspaceActions.js");

const candidate = (overrides) => ({
  id: "action-1",
  fingerprint: "fingerprint-1",
  kind: "workspace.read",
  risk: "readOnly",
  origin: "structured",
  confidence: "explicit",
  source: { start: 0, end: 1, text: "x" },
  ...overrides,
});

const options = (workingDirectory, signal) => ({
  workingDirectory,
  signal,
  timeoutMs: 5_000,
  terminateGraceMs: 100,
  maxOutputBytes: 65_536,
  maxReadBytes: 65_536,
  maxSearchResults: 100,
});

const exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
};

test("browser action fingerprints deduplicate identical executable semantics", () => {
  const first = JSON.stringify({
    kind: "workspace.write",
    path: "src/value.txt",
    content: "value",
  });
  const text = `${first}\n${first}`;
  const actions = extractBrowserActions(text, [
    {
      type: "codeBlock",
      language: "bachata-action",
      text: first,
      start: 0,
      end: first.length,
    },
    {
      type: "text",
      text: "\n",
      start: first.length,
      end: first.length + 1,
    },
    {
      type: "codeBlock",
      language: "bachata-action",
      text: first,
      start: first.length + 1,
      end: text.length,
    },
  ]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].origin, "structured");
});

test("structured browser actions can be bound to the active programmatic turn", () => {
  const currentToken = "turn-current";
  const block = (turnToken) => JSON.stringify({
    turnToken,
    kind: "workspace.read",
    path: "src/value.ts",
  });
  const segment = (text) => [{
    type: "codeBlock",
    language: "bachata-action",
    text,
    start: 0,
    end: text.length,
  }];

  const accepted = block(currentToken);
  assert.equal(extractBrowserActions(accepted, segment(accepted), currentToken).length, 1);

  const stale = block("turn-stale");
  assert.equal(extractBrowserActions(stale, segment(stale), currentToken).length, 0);

  const unbound = JSON.stringify({ kind: "workspace.read", path: "src/value.ts" });
  assert.equal(extractBrowserActions(unbound, segment(unbound), currentToken).length, 0);
});

test("natural-language extraction rejects common negations and remains heuristic", () => {
  assert.deepEqual(
    extractBrowserActions("Do not read the file `src/private.ts`.", [
      {
        type: "text",
        text: "Do not read the file `src/private.ts`.",
        start: 0,
        end: 39,
      },
    ]),
    [],
  );

  const actions = extractBrowserActions("Read the file `src/public.ts`.", [
    {
      type: "text",
      text: "Read the file `src/public.ts`.",
      start: 0,
      end: 30,
    },
  ]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].origin, "heuristic");
});

test("file-deleting patches are destructive", () => {
  assert.equal(
    patchRisk("diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ /dev/null\n"),
    "destructive",
  );
  assert.equal(
    patchRisk("diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n"),
    "mutating",
  );
});

test("already-aborted browser writes and shell actions produce no side effects", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-browser-actions-"));
  const controller = new AbortController();
  controller.abort();
  try {
    const writeTarget = path.join(directory, "write.txt");
    const shellTarget = path.join(directory, "shell.txt");
    const writeResult = await executeBrowserAction(
      candidate({
        kind: "workspace.write",
        risk: "mutating",
        path: "write.txt",
        content: "value",
      }),
      options(directory, controller.signal),
    );
    const shellResult = await executeBrowserAction(
      candidate({
        kind: "shell.run",
        risk: "mutating",
        command: `printf value > ${JSON.stringify(shellTarget)}`,
      }),
      options(directory, controller.signal),
    );

    assert.equal(writeResult.status, "failed");
    assert.equal(shellResult.status, "failed");
    assert.equal(await exists(writeTarget), false);
    assert.equal(await exists(shellTarget), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleting a symbolic link removes the link and preserves its target", async (t) => {
  if (process.platform === "win32") {
    t.skip("symbolic-link permissions vary on Windows");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-browser-actions-"));
  const target = path.join(directory, "target");
  const link = path.join(directory, "link");
  await mkdir(target);
  await writeFile(path.join(target, "value.txt"), "value");
  await symlink(target, link);
  try {
    const result = await executeBrowserAction(
      candidate({
        kind: "workspace.delete",
        risk: "destructive",
        path: "link",
        recursive: false,
      }),
      options(directory, new AbortController().signal),
    );

    assert.equal(result.status, "completed");
    assert.equal(await exists(link), false);
    assert.equal((await lstat(target)).isDirectory(), true);
    assert.equal(await readFile(path.join(target, "value.txt"), "utf8"), "value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser shell actions do not inherit arbitrary extension secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-browser-actions-"));
  const previous = process.env.BACHATA_SECRET_TEST;
  process.env.BACHATA_SECRET_TEST = "should-not-leak";
  try {
    const result = await executeBrowserAction(
      candidate({
        kind: "shell.run",
        risk: "readOnly",
        command:
          process.platform === "win32"
            ? "echo %BACHATA_SECRET_TEST%"
            : "printf %s \"$BACHATA_SECRET_TEST\"",
      }),
      options(directory, new AbortController().signal),
    );

    assert.equal(result.status, "failed");
    assert.match(result.stderr ?? "", /Arbitrary shell actions are disabled/u);
  } finally {
    if (previous === undefined) {
      delete process.env.BACHATA_SECRET_TEST;
    } else {
      process.env.BACHATA_SECRET_TEST = previous;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
