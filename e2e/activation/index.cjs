/**
 * Activation smoke: the journey a user takes on a cold window, driven in a real Extension Host.
 *
 * Every in-process test loads the catalog through a harness. This one loads it the way the
 * shipped extension does — `readdir` over the packaged `presets/` directory, inside an activated
 * extension, rendering into the real webview — because the defect this smoke exists for was a
 * catalog that validated in a test and served nothing in the product.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const waitFor = async (predicate, message, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

const customPipeline = {
  version: 1,
  id: "activation-smoke-custom",
  name: "Activation smoke custom",
  description: "A custom pipeline created through the real editor.",
  agents: [{ id: "smoke-agent", name: "Smoke agent", adapter: "claude-code", command: "claude" }],
  steps: [{
    id: "smoke-step",
    name: "Smoke step",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["smoke-agent"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "none",
  }],
};

const shippedPresetIds = (extensionRoot) => {
  const directory = path.join(extensionRoot, "presets");
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")).id)
    .sort();
};

const run = async () => {
  assert.equal(process.env.BACHATA_HUMAN_E2E, "1");
  // The publisher segment is still an unresolved owner input, so the extension is found by the
  // half of its identity this repository actually owns.
  const extension = vscode.extensions.all.find((candidate) => candidate.id.endsWith(".bachata-vscode"));
  assert.ok(
    extension,
    `Bachata development extension is unavailable. Loaded: ${vscode.extensions.all.map((candidate) => candidate.id).join(", ")}`,
  );
  const api = await extension.activate();
  assert.ok(api.humanE2e, "Human E2E API is unavailable");

  await vscode.commands.executeCommand("bachata.open");
  // The panel reports itself ready over its own channel. The workbench's tab model is not read
  // here: in a `--extensionTestsPath` host it is not always populated by the time the panel is
  // live, and a tab that has not been indexed yet is not evidence that the panel is absent.
  await api.humanE2e.waitForWebviewReady();
  await waitFor(
    () => vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => tab.input?.viewType?.endsWith("bachata") === true),
    ),
    "Bachata webview did not open",
    5_000,
  ).catch(() => undefined);

  const result = await api.humanE2e.runWebviewScenario(
    "Activation smoke",
    1,
    customPipeline,
    // Every shipped default is selected in turn, and each selection is a real validate-and-configure
    // round trip, so the journey is given room for the whole catalog rather than one pipeline.
    300_000,
    false,
  );

  assert.equal(result.runCreated, true, "A fresh conversation was not created");

  // Every shipped default reached the editor through the real catalog path.
  const expected = shippedPresetIds(extension.extensionPath);
  assert.deepEqual(
    result.catalogPipelineIds.slice().sort(),
    expected,
    "The default pipeline list does not match the shipped presets",
  );
  assert.equal(
    result.everyCatalogPipelineSelectable,
    true,
    "A default pipeline could not be selected",
  );
  // The picker a person sees, not the state behind it: a catalog held in state and never drawn
  // into the select is not a catalog anyone can choose from.
  assert.deepEqual(
    result.renderedPipelineIds.slice().sort(),
    expected,
    "The rendered pipeline picker does not offer the shipped presets",
  );

  assert.equal(result.pipelineCreated, true, "The custom pipeline was not created");
  assert.equal(result.editorOpened, true, "The saved pipeline could not be reopened");
  assert.equal(result.editorSaved, true, "The reopened pipeline could not be saved");
  assert.equal(result.editorModeRoundTrip, true, "Structured and JSON did not round-trip");
  assert.equal(
    result.editorJsonEditSurvived,
    true,
    "An edit made in the JSON view was discarded on the way back to the structured form",
  );
  assert.equal(
    result.invalidJsonKeepsText,
    true,
    "Unparsable JSON was taken out of the buffer the person was repairing it in",
  );
  assert.equal(
    result.invalidJsonKeepsTabsUsable,
    true,
    "Unparsable JSON left the editor's mode tabs unusable or covered",
  );
  // EX-UI-04. At every side-panel width the selected tab's action menu and New run are distinct,
  // reachable controls: no box intersection, each hit at its own centre, the menu opens without
  // creating a run, and the menu takes keyboard focus.
  assert.equal(
    result.tabStripHitRegions.length,
    1,
    "The tab strip was not measured in the host",
  );
  result.tabStripHitRegions.forEach((entry) => {
    assert.ok(entry.width > 0, "The tab strip was measured at no width at all");
    assert.equal(entry.overlap, false, `At ${String(entry.width)}px New run overlaps the run tab's action menu`);
    assert.equal(entry.menuHit, true, `At ${String(entry.width)}px the action menu is not what the pointer meets at its centre`);
    assert.equal(entry.newHit, true, `At ${String(entry.width)}px New run is not what the pointer meets at its centre`);
    assert.equal(entry.menuOpensWithoutRun, true, `At ${String(entry.width)}px pressing the action menu did not open it, or created a run`);
    assert.equal(entry.menuFocusable, true, `At ${String(entry.width)}px the action menu does not take keyboard focus`);
  });
  assert.ok(
    result.invalidJsonErrorLines >= 1 && result.invalidJsonErrorLines <= 2,
    `One unparsable buffer produced ${String(result.invalidJsonErrorLines)} error lines`,
  );
  assert.equal(
    result.advancedOptionsHiddenByDefault,
    true,
    "Advanced run options were on screen before anyone asked for them",
  );

  assert.equal(result.globalAlertCount, 0, "The window ended the journey with a global alert");

  // The Extension Host's stdout is not the runner's, so what was observed is written where the
  // runner can read it back and print it.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Activation smoke workspace is unavailable");
  const evidencePath = path.join(workspaceFolder.uri.fsPath, "activation-evidence.json");
  {
    fs.writeFileSync(evidencePath, `${JSON.stringify({
      conversationId: result.conversationId,
      catalogPipelineIds: result.catalogPipelineIds.slice().sort(),
      renderedPipelineIds: result.renderedPipelineIds.slice().sort(),
      everyCatalogPipelineSelectable: result.everyCatalogPipelineSelectable,
      editorJsonEditSurvived: result.editorJsonEditSurvived,
      invalidJsonKeepsText: result.invalidJsonKeepsText,
      invalidJsonKeepsTabsUsable: result.invalidJsonKeepsTabsUsable,
      invalidJsonErrorLines: result.invalidJsonErrorLines,
      advancedOptionsHiddenByDefault: result.advancedOptionsHiddenByDefault,
      pipelineCreated: result.pipelineCreated,
      editorOpened: result.editorOpened,
      editorSaved: result.editorSaved,
      editorModeRoundTrip: result.editorModeRoundTrip,
      globalAlertCount: result.globalAlertCount,
    }, null, 2)}\n`, "utf8");
  }

  await api.humanE2e.flush();
};

module.exports = { run };
