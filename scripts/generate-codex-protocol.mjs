import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

// The Codex wire contract is not documented in a form this repository can depend on, so it
// is reproduced from the installed CLI and committed as a fixture. Tests bind to the
// fixture; this script is the only writer. `--check` re-derives the fixture and fails when
// the installed CLI disagrees with what is committed.
//
//   node scripts/generate-codex-protocol.mjs            regenerate from the installed CLI
//   node scripts/generate-codex-protocol.mjs --check    compare without writing
//   node scripts/generate-codex-protocol.mjs --probe    also record live server rejections
//
// The probe is non-billing by construction: every request it sends carries a thread id that
// cannot name a thread, and parameter deserialization is rejected before the id is parsed,
// so no turn is ever created and no model is ever called.

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "codex-protocol.json");
const check = process.argv.includes("--check");
const probe = process.argv.includes("--probe");
const command = process.env.BACHATA_CODEX_COMMAND ?? "codex";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const cliVersion = () => {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`\`${command} --version\` failed: ${result.stderr?.trim() ?? String(result.error)}`);
  }
  return result.stdout.trim();
};

const generateSchemas = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-schema-"));
  const result = spawnSync(command, ["app-server", "generate-json-schema", "--out", directory], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    fail(`\`${command} app-server generate-json-schema\` failed: ${result.stderr?.trim() ?? String(result.error)}`);
  }
  return directory;
};

const readSchema = (directory, relative) =>
  JSON.parse(readFileSync(path.join(directory, relative), "utf8"));

const stringEnum = (definition) => {
  if (Array.isArray(definition.enum)) return [...definition.enum].sort();
  const alternatives = definition.oneOf ?? definition.anyOf ?? [];
  return [...new Set(alternatives.flatMap((entry) => entry.enum ?? []))].sort();
};

const objectVariants = (definition) =>
  (definition.oneOf ?? []).filter((entry) => entry.type === "object" && !entry.enum)
    .flatMap((entry) => entry.required ?? []).sort();

// Each SandboxPolicy variant is identified by the single value its `type` enum allows.
const sandboxPolicyVariants = (definition) =>
  Object.fromEntries((definition.oneOf ?? []).map((variant) => {
    const tag = variant.properties?.type?.enum?.[0];
    return [tag, {
      properties: Object.keys(variant.properties ?? {}).sort(),
      required: [...(variant.required ?? [])].sort(),
    }];
  }));

const parameterNames = (schema) => Object.keys(schema.properties ?? {}).sort();

const derive = (directory) => {
  const turnStart = readSchema(directory, path.join("v2", "TurnStartParams.json"));
  const threadStart = readSchema(directory, path.join("v2", "ThreadStartParams.json"));
  const initialize = readSchema(directory, path.join("v1", "InitializeParams.json"));
  const fileApproval = readSchema(directory, "FileChangeRequestApprovalParams.json");
  const itemStarted = readSchema(directory, path.join("v2", "ItemStartedNotification.json"));
  const fileChangeItem = itemStarted.definitions.ThreadItem.oneOf.find((variant) =>
    variant.properties?.type?.enum?.[0] === "fileChange");
  return {
    fileChangeApprovalParams: parameterNames(fileApproval),
    fileChangeItemRequired: [...fileChangeItem.required].sort(),
    fileUpdateChangeRequired: [...itemStarted.definitions.FileUpdateChange.required].sort(),
    patchChangeKinds: sandboxPolicyVariants(itemStarted.definitions.PatchChangeKind),
    sandboxMode: stringEnum(threadStart.definitions.SandboxMode),
    askForApproval: {
      strings: stringEnum(turnStart.definitions.AskForApproval),
      objectVariants: objectVariants(turnStart.definitions.AskForApproval),
    },
    sandboxPolicy: sandboxPolicyVariants(turnStart.definitions.SandboxPolicy),
    networkAccess: stringEnum(turnStart.definitions.NetworkAccess),
    initializeCapabilities: Object.keys(
      initialize.definitions.InitializeCapabilities.properties ?? {},
    ).sort(),
    clientInfoRequired: [...(initialize.definitions.ClientInfo.required ?? [])].sort(),
    threadStartParams: parameterNames(threadStart),
    turnStartParams: parameterNames(turnStart),
  };
};

const runProbe = async () => {
  const child = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId += 1;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.delete(id)) resolve({ error: { message: "probe timed out" } });
    }, 15000);
  });

  const initialize = await request("initialize", {
    clientInfo: { name: "bachata_protocol_probe", title: "Bachata protocol probe", version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);

  const thread = "bachata-protocol-probe";
  const turn = (params) => request("turn/start", {
    threadId: thread,
    input: [{ type: "text", text: "protocol probe" }],
    ...params,
  });
  const message = (response) => response.error?.message ?? "accepted";
  const observed = {
    initializeResponseFields: Object.keys(initialize.result ?? {}).sort(),
    acceptedReadOnly: message(await turn({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    })),
    acceptedWorkspaceWrite: message(await turn({
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [process.cwd()],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
    })),
    rejectedCamelCaseApproval: message(await turn({
      approvalPolicy: "onRequest",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    })),
    rejectedKebabSandboxPolicyType: message(await turn({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "read-only", networkAccess: false },
    })),
    rejectedReadOnlyAccessField: message(await turn({
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
        access: { type: "restricted", includePlatformDefaults: true, readableRoots: [process.cwd()] },
      },
    })),
    rejectedWorkspaceWriteReadOnlyAccessField: message(await turn({
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [process.cwd()],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
        readOnlyAccess: { type: "restricted", includePlatformDefaults: true, readableRoots: [process.cwd()] },
      },
    })),
    acceptedReadOnlySandboxMode: message(await request("thread/resume", {
      threadId: thread,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      sandbox: "read-only",
    })),
    acceptedWorkspaceWriteSandboxMode: message(await request("thread/resume", {
      threadId: thread,
      cwd: process.cwd(),
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    })),
    rejectedCamelCaseSandboxMode: message(await request("thread/resume", {
      threadId: thread,
      cwd: process.cwd(),
      approvalPolicy: "on-request",
      sandbox: "workspaceWrite",
    })),
    permissionProfiles: (await request("permissionProfile/list", { cwd: process.cwd() }))
      .result?.data?.map((entry) => entry.id).sort() ?? [],
  };
  child.kill("SIGKILL");
  return observed;
};

const directory = generateSchemas();
let derived;
try {
  derived = derive(directory);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

const committed = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : undefined;
const observed = probe ? await runProbe() : committed?.observed;

const fixture = {
  source: {
    schema: `${command} app-server generate-json-schema --out <dir>`,
    probe: `node scripts/generate-codex-protocol.mjs --probe`,
    generator: "scripts/generate-codex-protocol.mjs",
  },
  cliVersion: cliVersion(),
  generated: derived,
  ...(observed ? { observed } : {}),
};

const serialized = `${JSON.stringify(fixture, undefined, 2)}\n`;

if (!check) {
  writeFileSync(fixturePath, serialized);
  console.log(`wrote ${path.relative(process.cwd(), fixturePath)} from ${fixture.cliVersion}`);
  process.exit(0);
}

if (!committed) {
  fail(`${path.relative(process.cwd(), fixturePath)} does not exist; run this script without --check.`);
}
if (JSON.stringify(committed.generated) !== JSON.stringify(derived)) {
  fail(
    `The installed Codex CLI (${fixture.cliVersion}) no longer matches the committed protocol fixture.\n`
    + `committed: ${JSON.stringify(committed.generated)}\n`
    + `installed: ${JSON.stringify(derived)}\n`
    + "Regenerate with `node scripts/generate-codex-protocol.mjs --probe` and re-run the adapter tests.",
  );
}
console.log(`codex protocol fixture matches the installed CLI (${fixture.cliVersion})`);
