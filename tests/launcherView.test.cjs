const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const loadLauncher = (snapshot, changeSink) => {
  const vscode = {
    EventEmitter: class {
      constructor() {
        this.listeners = [];
        this.event = (listener) => {
          this.listeners.push(listener);
          return { dispose: () => undefined };
        };
      }
      fire(value) {
        for (const listener of this.listeners) listener(value);
      }
      dispose() {
        this.listeners = [];
      }
    },
    TreeItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../dist/commands/launcherView.js");
  delete require.cache[modulePath];
  let mod;
  try {
    mod = require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
  const orchestrator = {
    getSnapshot: () => structuredClone(snapshot),
    onDidChange: (listener) => {
      if (changeSink) changeSink.push(listener);
      return { dispose: () => undefined };
    },
  };
  return { mod, orchestrator };
};

test("the launcher view is registered in the Activity Bar manifest", () => {
  const container = packageJson.contributes.viewsContainers.activitybar.find((entry) => entry.id === "bachata");
  assert.ok(container, "activity bar container 'Bachata' is contributed");
  assert.equal(typeof container.icon, "string");
  const views = packageJson.contributes.views.bachata;
  assert.ok(Array.isArray(views), "views for the Bachata container are contributed");
  assert.ok(views.some((view) => view.id === "bachata.launcher"), "bachata.launcher view is contributed");
  assert.ok(packageJson.activationEvents.includes("onView:bachata.launcher"), "the view activates the extension");
});

test("every launcher action maps to a contributed command", () => {
  const { mod, orchestrator } = loadLauncher({ active: false, run: undefined });
  const items = mod.launcherItems(orchestrator);
  const contributedCommands = new Set(packageJson.contributes.commands.map((entry) => entry.command));
  const wired = items.filter((item) => item.command).map((item) => item.command);
  assert.deepEqual(wired, ["bachata.open", "bachata.reviewUncommitted", "bachata.setup", "bachata.doctor"]);
  for (const command of wired) {
    assert.ok(contributedCommands.has(command), `${command} is a contributed command`);
  }
});

test("every launcher item carries an accessibility label", () => {
  const { mod, orchestrator } = loadLauncher({ active: false, run: undefined });
  for (const item of mod.launcherItems(orchestrator)) {
    assert.equal(typeof item.ariaLabel, "string");
    assert.ok(item.ariaLabel.length > 0);
  }
});

test("getTreeItem wires the command and accessibility information onto the tree item", () => {
  const { mod, orchestrator } = loadLauncher({ active: false, run: undefined });
  const provider = mod.createLauncherProvider(orchestrator);
  const children = provider.getChildren();
  const openItem = children.find((item) => item.command === "bachata.open");
  const treeItem = provider.getTreeItem(openItem);
  assert.equal(treeItem.command.command, "bachata.open");
  assert.equal(treeItem.accessibilityInformation.label, "Open the Bachata panel");
  assert.equal(treeItem.iconPath.id, "window");
  const identity = provider.getTreeItem(children[0]);
  assert.equal(identity.command, undefined);
  assert.equal(provider.getChildren(openItem).length, 0);
  provider.dispose();
});

test("the status item reflects the current run and refreshes on orchestrator change", () => {
  const changeSink = [];
  const { mod, orchestrator } = loadLauncher(
    {
      active: true,
      run: {
        status: "running",
        integrationBranch: "bachata/integration/run-1",
        tasks: { a: { status: "done" }, b: { status: "pending" } },
      },
    },
    changeSink,
  );
  const provider = mod.createLauncherProvider(orchestrator);
  const status = provider.getChildren()[1];
  assert.match(status.label, /^Running\b/u, "a running orchestration must say so in plain words");
  assert.match(status.label, /1\/2/);
  assert.equal(status.icon, "sync");
  assert.match(status.ariaLabel, /1 of 2 tasks done/);
  let fired = 0;
  provider.onDidChangeTreeData(() => {
    fired += 1;
  });
  assert.equal(changeSink.length, 1);
  changeSink[0]();
  assert.equal(fired, 1);
  provider.dispose();
});

test("the status item states when no run is loaded", () => {
  const { mod, orchestrator } = loadLauncher({ active: false, run: undefined });
  const status = mod.launcherItems(orchestrator)[1];
  // The row is always rendered, and it names the one thing that is missing — a TODO run —
  // rather than telling a review user that Bachata has nothing loaded.
  assert.match(status.label, /^No TODO run loaded$/u);
  assert.match(status.description, /panel/u);
  assert.equal(status.icon, "circle-outline");
});

test("a read-only window opens the product from its launcher instead of a dead end", () => {
  const reason = "This workspace is already controlled by another Bachata Extension Host.";
  const { mod } = loadLauncher({ active: false, run: undefined });
  const provider = mod.createReadOnlyLauncherProvider(reason);
  const children = provider.getChildren();
  assert.ok(children.length > 0, "a read-only launcher must never render empty");
  assert.match(children[0].label, /Open Bachata \(read-only\)/u);
  assert.equal(children[0].description, reason, "the reason must be visible, not tooltip-only");
  assert.equal(children[0].command, "bachata.open", "the read-only launcher must open the panel first");
  const rendered = provider.getTreeItem(children[0]);
  assert.equal(rendered.command.command, "bachata.open");
  children.forEach((item) => {
    assert.equal(typeof item.ariaLabel, "string");
    assert.ok(item.ariaLabel.length > 0);
  });
  const commands = children.filter((item) => item.command).map((item) => item.command);
  assert.deepEqual(commands, [
    "bachata.open",
    "bachata.doctor",
    "bachata.localData",
    "bachata.ownership",
    "workbench.action.reloadWindow",
  ]);
  const contributedCommands = new Set(packageJson.contributes.commands.map((entry) => entry.command));
  ["bachata.open", "bachata.doctor", "bachata.localData", "bachata.ownership"].forEach((command) => {
    assert.ok(contributedCommands.has(command), `${command} is not a contributed command`);
  });
  assert.equal(provider.getChildren(children[0]).length, 0);
  provider.dispose();
});

test("the read-only launcher introduces no retry command of its own", () => {
  const source = fs.readFileSync(path.join(root, "src", "commands", "launcherView.ts"), "utf8");
  assert.equal(
    /registerCommand/u.test(source),
    false,
    "the launcher view must reuse existing commands rather than registering its own",
  );
  const readOnlySource = fs.readFileSync(
    path.join(root, "src", "commands", "registerReadOnlyCommands.ts"),
    "utf8",
  );
  assert.match(
    readOnlySource,
    /createReadOnlyLauncherProvider/u,
    "a read-only window must register the read-only launcher",
  );
  const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  const registrations = extensionSource.match(/registerCommand\("bachata\.ownership"/gu) ?? [];
  assert.equal(registrations.length, 2, "bachata.ownership stays one command per activation path, read-only or owned");
});

test("an activation that registers no provider still explains itself through view welcome content", () => {
  const welcome = packageJson.contributes.viewsWelcome;
  assert.ok(Array.isArray(welcome), "viewsWelcome is contributed");
  const entry = welcome.find((item) => item.view === "bachata.launcher");
  assert.ok(entry, "the launcher view declares welcome content for the empty case");
  assert.ok(entry.contents.trim().length > 0);
  const linked = Array.from(entry.contents.matchAll(/\(command:([^)]+)\)/gu), (match) => match[1]);
  assert.ok(linked.length > 0, "the welcome content must offer at least one action");
  // Welcome content is what a viewer sees when activation failed before any Bachata command
  // was registered, so every link must be a built-in VS Code command.
  linked.forEach((command) => {
    assert.equal(
      command.startsWith("bachata."),
      false,
      `${command} is contributed by Bachata, which may be unregistered exactly when this content shows`,
    );
    assert.match(command, /^workbench\./u);
  });
  assert.ok(linked.includes("workbench.action.reloadWindow"));
  // The built-in command opens the Output panel; which channel it shows is the viewer's
  // last selection, so the copy must not promise the Bachata channel.
  if (linked.includes("workbench.action.output.toggleOutput")) {
    const label = /\[([^\]]+)\]\(command:workbench\.action\.output\.toggleOutput\)/u.exec(entry.contents);
    assert.notEqual(label, null);
    assert.equal(
      /Bachata (?:output )?channel/iu.test(label[1]),
      false,
      `"${label[1]}" claims the built-in command opens the Bachata channel, which it does not`,
    );
    assert.match(entry.contents, /choose Bachata in its channel list/u);
  }
});
