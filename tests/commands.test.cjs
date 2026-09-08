const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const injectModule = (filename, exports) => {
  const module = new Module(filename);
  module.filename = filename;
  module.loaded = true;
  module.exports = exports;
  require.cache[filename] = module;
};

const uriOf = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });

const loadCommands = (snapshot, options = {}) => {
  const commands = new Map();
  const configurationUpdates = [];
  const informationMessages = [];
  const errors = [];
  const outputLines = [];
  const openCalls = [];
  const executedCommands = [];
  const createdConversations = [];
  const workspaceFolderPicks = [];
  const warnings = [];
  const inputBoxes = [];
  const quickPicks = [];
  const informationDetails = [];
  const terminals = [];
  const publishedDiagnostics = [];
  const openedExternals = [];
  const treeViews = [];
  const status = {
    text: "",
    tooltip: "",
    command: undefined,
    name: "",
    visible: false,
    show: () => { status.visible = true; },
    hide: () => { status.visible = false; },
    dispose: () => undefined,
  };
  const workspaceFolders = (options.workspaceFolders ?? []).map((fsPath) => ({
    uri: uriOf(fsPath),
    name: fsPath.split("/").pop(),
  }));
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose: () => undefined });
      }
      fire() {}
      dispose() {}
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
    window: {
      createStatusBarItem: () => status,
      registerTreeDataProvider: () => ({ dispose: () => undefined }),
      createTreeView: (viewId, viewOptions) => {
        const view = { viewId, options: viewOptions, badge: undefined, dispose: () => undefined };
        treeViews.push(view);
        return view;
      },
      showInformationMessage: async (message, messageOptions, ...actions) => {
        informationMessages.push(message);
        informationDetails.push({ message, options: messageOptions, actions });
        if (options.pickInformationLabel) {
          const picked = actions.find((action) => action === options.pickInformationLabel);
          if (picked) {
            options.pickInformationLabel = undefined;
            return picked;
          }
          return undefined;
        }
        return options.pickInformationAction ? actions[0] : undefined;
      },
      showWarningMessage: async (message, messageOptions, ...rest) => {
        const actions = typeof messageOptions === "string" ? [messageOptions, ...rest] : rest;
        warnings.push({
          message,
          options: typeof messageOptions === "string" ? undefined : messageOptions,
          actions,
        });
        if (options.warningChoice) {
          const choice = actions.find((action) => action === options.warningChoice);
          options.warningChoice = undefined;
          return choice;
        }
        return options.confirmWarning ? actions[0] : undefined;
      },
      showErrorMessage: async (message) => {
        errors.push(message);
        return undefined;
      },
      showInputBox: async (inputOptions) => {
        inputBoxes.push(inputOptions);
        // A git ref prompt answers with the ref; the initiative prompt answers with the goal.
        return /ref|commit|branch/iu.test(String(inputOptions.prompt ?? inputOptions.title ?? ""))
          ? options.inputBoxValue
          : options.initiativeGoal;
      },
      showQuickPick: async (items, pickOptions) => {
        quickPicks.push(items);
        if (pickOptions?.canPickMany === true) {
          if (options.pickSealedPaths !== undefined) {
            return options.pickSealedPaths
              .map((value) => items.find((item) => item.label === value))
              .filter(Boolean);
          }
          return (options.pickMany ?? []).map(
            (value) => items.find((item) => item.provider === value)).filter(Boolean);
        }
        if (items.some((item) => item.mode === "fixed" || item.mode === "untilClean")) {
          return items.find((item) => item.label === (options.pickCompletion ?? "One pass"));
        }
        if (items.some((item) => item.entry || item.cleanup)) {
          return options.pickLocalData
            ? items.find((item) => item.label === options.pickLocalData)
            : undefined;
        }
        if (options.pickRemediation) {
          const item = items.find((candidate) => candidate.remediationId === options.pickRemediation);
          options.pickRemediation = undefined;
          return item;
        }
        if (items.length > 0 && items.every((item) => item.mode && typeof item.mode === "object")) {
          return options.pickMode
            ? items.find((item) => item.mode.mode === options.pickMode)
            : items.find((item) => item.mode.status === "ready");
        }
        if (items.some((item) => typeof item.resume === "boolean")) {
          return options.pickResume === undefined
            ? undefined
            : items.find((item) => item.resume === options.pickResume);
        }
        if (items.some((item) => item.provider !== undefined || item.manageProviders === true)) {
          return options.pickProviders === "manage"
            ? items.find((item) => item.manageProviders === true)
            : items.find((item) => item.provider === options.pickProviders);
        }
        if (options.pickProvidersEntry && items.some((item) => item.providers === true)) {
          options.pickProvidersEntry = false;
          return items.find((item) => item.providers === true);
        }
        if (!options.pickCard) return undefined;
        return items.find((item) => item.card?.id === options.pickCard)
          ?? items.find((item) => !item.card && !item.providers);
      },
      showWorkspaceFolderPick: async (pickOptions) => {
        workspaceFolderPicks.push(pickOptions);
        const selected = options.pickWorkspaceFolder;
        return selected
          ? workspaceFolders.find((folder) => folder.uri.fsPath === selected)
          : undefined;
      },
      activeTextEditor: options.activeTextEditor,
      createTerminal: (terminalOptions) => {
        const terminal = {
          options: terminalOptions,
          shown: false,
          lines: [],
          show: () => { terminal.shown = true; },
          sendText: (line) => terminal.lines.push(line),
          dispose: () => undefined,
        };
        terminals.push(terminal);
        return terminal;
      },
    },
    env: {
      remoteName: options.remoteName,
      openExternal: async (uri) => {
        openedExternals.push(uri.toString());
        return true;
      },
    },
    workspace: {
      workspaceFolders: workspaceFolders.length > 0 ? workspaceFolders : undefined,
      getWorkspaceFolder: (uri) => workspaceFolders.find(
        (folder) => uri.fsPath.startsWith(`${folder.uri.fsPath}/`),
      ),
      getConfiguration: () => ({
        get: (key, fallback) => (options.configuration ?? {})[key] ?? fallback,
        update: async (key, value, target) => {
          configurationUpdates.push({ key, value, target });
          options.configuration = { ...(options.configuration ?? {}), [key]: value };
        },
      }),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    languages: {
      getDiagnostics: () => options.diagnostics ?? [],
      createDiagnosticCollection: (name) => {
        const entries = new Map();
        const collection = {
          name,
          entries,
          set: (uri, diagnostics) => entries.set(uri.fsPath ?? String(uri), diagnostics),
          clear: () => entries.clear(),
          dispose: () => entries.clear(),
        };
        publishedDiagnostics.push(collection);
        return collection;
      },
    },
    Uri: {
      file: (fsPath) => uriOf(fsPath),
      joinPath: (base, ...segments) => uriOf([base.fsPath, ...segments].join("/")),
      parse: (value) => ({ fsPath: value, toString: () => value }),
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: async (id, ...args) => {
        executedCommands.push(id);
        const handler = commands.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
  };
  const openPath = require.resolve("../dist/webview/openPipelinePanel.js");
  injectModule(openPath, {
    openPipelinePanel: () => openCalls.push("open"),
    focusPipelinePanel: () => undefined,
  });
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const commandPath = require.resolve("../dist/commands/registerCommands.js");
  delete require.cache[commandPath];
  // EX-G6-08. The repository resolver holds the `vscode` module it was loaded with, so it has to
  // be reloaded alongside the commands or every harness after the first reads the first one's
  // workspace.
  delete require.cache[require.resolve("../dist/commands/repositoryScope.js")];
  let registerCommands;
  try {
    ({ registerCommands } = require(commandPath));
  } finally {
    Module._load = originalLoad;
  }
  const setupWorkspaceState = options.setupState ?? new Map(Object.entries(options.workspaceState ?? {}));
  const orchestrator = {
    startCalls: 0,
    startOptions: [],
    getSnapshot: () => structuredClone(snapshot),
    dirtyRepositoryPaths: async () => options.todoDirtyPaths ?? [],
    inspectStartReadiness: async () => options.todoReadiness ?? {
      pipelineId: "todo-master",
      status: "ready",
      findings: [],
    },
    onDidChange: () => ({ dispose: () => undefined }),
    start: async (startOptions) => {
      orchestrator.startCalls += 1;
      orchestrator.startOptions.push(startOptions);
      return { status: "completed", integrationBranch: "bachata/integration/run-1" };
    },
    resume: async () => { throw new Error("unused"); },
    stop: async () => undefined,
    abandon: async () => undefined,
    improveCalls: 0,
    improveOptions: [],
    improveReadinessOptions: [],
    inspectImproveReadiness: async (readinessOptions) => {
      orchestrator.improveReadinessOptions.push(readinessOptions);
      // A function lets a test answer differently across the two readiness calls the command
      // makes, which is how the repository moving under an open dialog is expressed.
      if (typeof options.improveReadiness === "function") {
        return options.improveReadiness(orchestrator.improveReadinessOptions.length);
      }
      return options.improveReadiness ?? {
        pipelineId: "todo-master",
        status: "ready",
        findings: [],
        todoExecutable: true,
        repositoryVerifiers: "refused",
        bootstrapPipelineIds: ["self-improvement"],
        taskPipelinesWithOwnSteps: [],
        contract: { taskIds: ["T1"] },
      };
    },
    improve: async (improveOptions) => {
      orchestrator.improveCalls += 1;
      orchestrator.improveOptions.push(improveOptions);
      return {
        path: "existingTodo",
        ledger: { status: "completed", integrationBranch: "bachata/integration/run-1" },
      };
    },
  };
  const definedInitiatives = [];
  const adoptedConversations = [];
  const manager = {
    createConversation: async (createOptions) => {
      createdConversations.push(createOptions);
      return { id: `conversation-${String(createdConversations.length)}` };
    },
    hasInitiative: () => (options.hasInitiative ?? true) || definedInitiatives.length > 0,
    pipelineRequiresInitiative: async () => options.pipelineRequiresInitiative ?? true,
    adoptIdleConversation: async (conversationId, preparedDraft, title, workingDirectory) => {
      if (adoptedConversations.some((entry) => entry.conversationId === conversationId)) return false;
      // Stands in for the real manager's repository check.
      if (options.adoptionWorkingDirectory !== undefined &&
        options.adoptionWorkingDirectory !== workingDirectory) return false;
      adoptedConversations.push({ conversationId, preparedDraft, title, workingDirectory });
      return true;
    },
    defineInitiative: (input) => {
      definedInitiatives.push(input);
    },
    getState: () => ({
      direction: options.longitudinal ?? {
        externalEvidence: [],
        staleExternalEvidenceIds: [],
        direction: { decisionsNeedingHuman: [], outstandingAcceptedFindings: [] },
      },
    }),
    inspectActiveReadiness: async () => ({
      pipelines: [],
      pipelineNames: {},
      pipelineSafetyLevels: {},
      pipelineProviders: {},
      disabledProviders: [],
      preferredProvider: "auto",
      codexWorkspaceScope: "refuseNarrowedScope",
      adapters: [],
      ...(options.readiness ?? {}),
    }),
  };
  const onboardingRecords = [];
  registerCommands(
    {
      workspaceState: {
        get: (key) => setupWorkspaceState.get(key),
        update: async (key, value) => {
          setupWorkspaceState.set(key, value);
        },
      },
      extensionUri: uriOf("/extension"),
      extension: { id: "local.bachata-vscode" },
    },
    manager,
    orchestrator,
    { appendLine: (line) => outputLines.push(line) },
    undefined,
    {
      record: async (entry) => {
        onboardingRecords.push(entry);
      },
    },
  );
  return {
    commands,
    treeViews,
    onboardingRecords,
    informationMessages,
    errors,
    outputLines,
    openCalls,
    status,
    executedCommands,
    createdConversations,
    definedInitiatives,
    adoptedConversations,
    inputBoxes,
    workspaceFolderPicks,
    warnings,
    quickPicks,
    configurationUpdates,
    informationDetails,
    terminals,
    publishedDiagnostics,
    openedExternals,
    orchestrator,
    context: {
      workspaceState: {
        get: (key) => setupWorkspaceState.get(key),
      },
    },
  };
};

const diagnostic = (line, message) => ({
  message,
  source: "ts",
  range: { start: { line }, end: { line } },
});

test("TODO commands explain when no orchestration run is loaded", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] });

  await harness.commands.get("bachata.todo.abandon")();
  assert.deepEqual(harness.informationMessages, [
    "Bachata has no TODO orchestration run to abandon",
  ]);
  assert.equal(harness.openCalls.length, 0);

  await harness.commands.get("bachata.todo.status")();
  assert.deepEqual(harness.informationMessages, [
    "Bachata has no TODO orchestration run to abandon",
    "Bachata has no TODO orchestration run loaded",
  ]);
  assert.deepEqual(harness.outputLines, ["No TODO orchestration run is loaded"]);
  assert.equal(harness.openCalls.length, 1);
  assert.deepEqual(harness.errors, []);
});

test("the status bar entry appears only once there is a run to report", () => {
  const idle = loadCommands({ active: false, retainedRuns: [] });
  assert.equal(idle.status.visible, false, "an idle window still claims a slot in the status bar");
  assert.equal(idle.status.command, "bachata.open");

  const loaded = loadCommands({
    active: true,
    retainedRuns: [],
    run: {
      status: "running",
      integrationBranch: "bachata/integration/run-1",
      tasks: { a: { status: "done" }, b: { status: "pending" } },
    },
  });
  assert.equal(loaded.status.visible, true, "a loaded run must be reported in the status bar");
  assert.match(loaded.status.text, /1\/2/u);
  assert.match(loaded.status.tooltip, /Open Bachata/u);
});

test("the launcher badges the runs that are waiting on the user", () => {
  const idle = loadCommands({ active: false, retainedRuns: [] });
  assert.equal(idle.treeViews.length, 1, "the launcher must be a TreeView so it can carry a badge");
  assert.equal(idle.treeViews[0].viewId, "bachata.launcher");
  assert.equal(typeof idle.treeViews[0].options.treeDataProvider.getChildren, "function");
  assert.equal(idle.treeViews[0].badge, undefined, "nothing waits on the user, so nothing is badged");

  const waiting = loadCommands({
    active: false,
    retainedRuns: [{ runId: "run-0", status: "completed" }],
    run: {
      status: "blocked",
      integrationBranch: "bachata/integration/run-1",
      tasks: { a: { status: "done" } },
    },
  });
  assert.equal(waiting.treeViews[0].badge.value, 2);
  assert.match(waiting.treeViews[0].badge.tooltip, /waiting on you/u);
});

// EX-G6-08. Doctor, setup, evidence and verifier state describe a repository. Improve resolves
// the repository it would execute in from the active editor and refuses a multi-root window that
// leaves the choice open; these commands read the same resolution, so they cannot describe
// repository A while Improve would run in repository B.
test("doctor describes the repository Improve would run in, not the first workspace folder", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/repository-a", "/work/repository-b"],
    activeTextEditor: {
      document: { uri: uriOf("/work/repository-b/src/a.ts"), getText: () => "" },
      selection: { start: { line: 0 }, end: { line: 0 } },
    },
    readiness: {
      pipelines: [],
      pipelineNames: {},
      adapters: [],
      git: { available: true, detail: "git version 2.39.5", clean: true, statusDetail: "Workspace is clean" },
      bridge: { enabled: false, connected: false, sessions: [] },
      workspaceRoots: ["/work/repository-a", "/work/repository-b"],
      trusted: true,
    },
  });

  await harness.commands.get("bachata.doctor")();

  const readiness = harness.onboardingRecords.filter((entry) => entry.kind === "readiness");
  assert.equal(readiness.length, 1);
  assert.equal(readiness[0].repositoryRoot, "/work/repository-b");
});

test("doctor names no repository when a multi-root window leaves the choice open", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/repository-a", "/work/repository-b"],
    readiness: {
      pipelines: [],
      pipelineNames: {},
      adapters: [],
      git: { available: true, detail: "git version 2.39.5", clean: true, statusDetail: "Workspace is clean" },
      bridge: { enabled: false, connected: false, sessions: [] },
      workspaceRoots: ["/work/repository-a", "/work/repository-b"],
      trusted: true,
    },
  });

  await harness.commands.get("bachata.doctor")();

  const readiness = harness.onboardingRecords.filter((entry) => entry.kind === "readiness");
  assert.equal(readiness.length, 1);
  assert.equal(
    readiness[0].repositoryRoot,
    undefined,
    "a command described the first workspace folder as the repository Improve would use",
  );
});

test("review commands bind the run to the repository that owns the target file", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
  });

  await harness.commands.get("bachata.reviewFile")(uriOf("/work/second/src/a.ts"));

  assert.deepEqual(harness.errors, []);
  assert.equal(harness.createdConversations.length, 1);
  assert.equal(harness.createdConversations[0].workingDirectory, "/work/second");
  assert.match(harness.createdConversations[0].preparedDraft, /src\/a\.ts/u);
  assert.equal(harness.workspaceFolderPicks.length, 0);
});

test("staged diff review asks for a repository in multi-root workspaces and records its identity", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
    pickWorkspaceFolder: "/work/second",
  });

  await harness.commands.get("bachata.reviewStagedDiff")();

  assert.equal(harness.workspaceFolderPicks.length, 1);
  assert.equal(harness.createdConversations[0].workingDirectory, "/work/second");
  assert.match(harness.createdConversations[0].title, /second/u);
  assert.match(harness.createdConversations[0].preparedDraft, /repository second/u);
});

test("a canceled repository pick creates no run", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
  });

  await harness.commands.get("bachata.reviewStagedDiff")();

  assert.equal(harness.workspaceFolderPicks.length, 1);
  assert.deepEqual(harness.createdConversations, []);
  assert.deepEqual(harness.errors, []);
});

test("fix diagnostic uses the diagnostic under the cursor", async () => {
  const target = uriOf("/work/first/src/a.ts");
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    activeTextEditor: {
      document: { uri: target, getText: () => "" },
      selection: { start: { line: 41 }, end: { line: 41 } },
    },
    diagnostics: [diagnostic(3, "first diagnostic"), diagnostic(41, "cursor diagnostic")],
  });

  await harness.commands.get("bachata.fixDiagnostic")(target);

  assert.match(harness.createdConversations[0].preparedDraft, /cursor diagnostic/u);
  assert.doesNotMatch(harness.createdConversations[0].preparedDraft, /first diagnostic/u);
  assert.match(harness.createdConversations[0].preparedDraft, /a\.ts:42/u);
});

test("setup binds a workflow run to the selected repository", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
    pickCard: "review",
    pickWorkspaceFolder: "/work/second",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
    },
  });

  await harness.commands.get("bachata.setup")();

  assert.equal(harness.createdConversations.length, 1);
  assert.equal(harness.createdConversations[0].workingDirectory, "/work/second");
  assert.equal(harness.createdConversations[0].pipelineId, "codex-review");
  assert.equal(harness.createdConversations[0].iterationCount, 1);
});

test("setup states the resolved guardrails and needs explicit confirmation", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
      pipelineGuardrails: {
        "codex-review": {
          pipelineId: "codex-review",
          pipelineName: "Review code",
          safetyLevel: "review",
          writeAuthority: "Read-only. Nothing in your repository is written.",
          writablePaths: [],
          readablePaths: [],
          protectedPaths: [],
          checks: [],
          commitPolicy: "never",
          providers: ["Codex (Codex app server)"],
          humanDecisions: [],
          advancedOnly: ["Per-role authority, candidates, and prompt instructions"],
        },
      },
    },
  });

  await harness.commands.get("bachata.setup")();

  assert.equal(harness.createdConversations.length, 0, "no run is created without confirmation");
  const confirmation = harness.informationDetails.find((entry) =>
    entry.message === "Start with these guardrails?"
  );
  assert.ok(confirmation, "no guardrail confirmation was shown");
  assert.equal(confirmation.options.modal, true);
  assert.match(confirmation.options.detail, /Write authority: Read-only/u);
  assert.match(confirmation.options.detail, /Commits: no commits are created/u);
  assert.match(confirmation.options.detail, /Completion: one pass/u);
  assert.equal(
    harness.quickPicks.some((items) =>
      items.some((item) => item.mode === "fixed" || item.mode === "untilClean")),
    false,
    "the first read-only review asked for a completion policy",
  );
  assert.match(confirmation.options.detail, /Set in the advanced editor only/u);
  assert.deepEqual(confirmation.actions, ["Create the run"]);
});

test("setup blocks Run TODO.md when the orchestration preflight fails", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "todo",
    readiness: {
      pipelines: [{ pipelineId: "todo-master", status: "ready", findings: [] }],
      pipelineNames: { "todo-master": "TODO master" },
    },
    todoReadiness: {
      pipelineId: "todo-master",
      status: "blocked",
      findings: [
        { id: "workspace", label: "Workspace", status: "ready", detail: "/work/first" },
        {
          id: "todo.git",
          label: "Git baseline",
          status: "blocked",
          detail: "The repository must be clean before starting TODO orchestration. Dirty paths: src/a.ts",
        },
      ],
    },
  });
  let started = 0;
  harness.commands.set("bachata.todo.start", async () => {
    started += 1;
  });

  await harness.commands.get("bachata.setup")();

  assert.equal(started, 0);
  assert.deepEqual(harness.createdConversations, []);
});

test("setup Run TODO.md starts orchestration instead of opening a watchdog chat", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "todo",
    readiness: {
      pipelines: [{ pipelineId: "todo-master", status: "ready", findings: [] }],
      pipelineNames: { "todo-master": "TODO master" },
    },
  });
  let started = 0;
  harness.commands.set("bachata.todo.start", async () => {
    started += 1;
  });

  await harness.commands.get("bachata.setup")();

  assert.equal(started, 1);
  assert.ok(harness.executedCommands.includes("bachata.todo.start"));
  assert.deepEqual(harness.createdConversations, []);
});

const todoContract = () => ({
  workspaceRoot: "/work/first",
  todoFile: "TODO.md",
  taskIds: ["T1", "T2"],
  taskPipelineIds: ["todo-implementation"],
  masterPipelineId: "todo-master",
  verification: ["bachata:project-checks"],
  finalVerification: ["bachata:workspace-integrity"],
  verificationResources: ["database:api-test"],
  writablePaths: ["src"],
  maxConcurrency: 2,
  retries: 1,
  commitPolicy: "never",
  isolation: "Each task runs in its own Git worktree",
  humanDecisions: ["None while the run is healthy"],
  completion: ["Every incomplete task in TODO.md reaches done"],
});

test("TODO orchestration refuses to start when its preflight reports blockers", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    todoReadiness: {
      pipelineId: "todo-master",
      status: "blocked",
      findings: [{ id: "todo.git", label: "Git baseline", status: "blocked", detail: "Repository must be clean" }],
    },
  });

  await harness.commands.get("bachata.todo.start")();

  assert.equal(harness.orchestrator.startCalls, 0);
  assert.match(harness.warnings.at(-1).message, /cannot start TODO orchestration/u);
  assert.match(harness.warnings.at(-1).options.detail, /Repository must be clean/u);
});

test("TODO orchestration states its contract and starts only after confirmation", async () => {
  const declined = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    todoReadiness: {
      pipelineId: "todo-master",
      status: "ready",
      findings: [],
      contract: todoContract(),
    },
  });

  await declined.commands.get("bachata.todo.start")();
  assert.equal(declined.orchestrator.startCalls, 0);
  const detail = declined.warnings.at(-1).options.detail;
  assert.match(detail, /Tasks: T1, T2/u);
  assert.match(detail, /Verification: bachata:project-checks/u);
  assert.match(detail, /Final verification: bachata:workspace-integrity/u);
  assert.match(detail, /Shared verification resources: database:api-test/u);
  assert.match(detail, /2 concurrent tasks, 1 retries per task/u);
  assert.match(detail, /Commits: none/u);

  const accepted = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    confirmWarning: true,
    todoReadiness: {
      pipelineId: "todo-master",
      status: "ready",
      findings: [],
      contract: todoContract(),
    },
  });

  await accepted.commands.get("bachata.todo.start")();
  assert.equal(accepted.orchestrator.startCalls, 1);
});

test("setup states the safety level of every offered workflow", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "todo",
    readiness: {
      pipelines: [
        { pipelineId: "codex-review", status: "ready", findings: [] },
        { pipelineId: "debug", status: "ready", findings: [] },
        { pipelineId: "todo-master", status: "ready", findings: [] },
      ],
      pipelineNames: { "codex-review": "Codex review", debug: "Debug", "todo-master": "TODO master" },
      pipelineSafetyLevels: { "codex-review": "review", debug: "interactive", "todo-master": "review" },
    },
  });

  await harness.commands.get("bachata.setup")();

  const journey = harness.quickPicks[0];
  assert.match(journey.find((item) => item.card?.id === "review").detail, /read-only/u);
  assert.match(journey.find((item) => item.card?.id === "fix").detail, /you approve actions/u);
  assert.deepEqual(
    journey.filter((item) => item.card).map((item) => item.card.id),
    ["review", "productReview", "plan", "featureDelivery", "fix"],
    "the default journey offered something other than the five first-class goals",
  );
  assert.equal(journey.at(-1).card, undefined, "no Advanced workflows entry was offered");
  assert.match(journey.at(-1).label, /Advanced workflows/u);

  const advanced = harness.quickPicks[1];
  assert.deepEqual(
    advanced.map((item) => item.card.id),
    ["todo", "browser", "custom"],
    "TODO, browser, and custom pipelines are not behind Advanced workflows",
  );
  assert.match(advanced.find((item) => item.card.id === "todo").detail, /isolated retained work you apply selectively/u);
});

test("Doctor resolves a missing local provider with provider-specific steps and direct actions", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickInformationLabel: "Set bachata.codexCommand",
    warningChoice: "Fix a Problem",
    pickRemediation: "provider.install.codex",
    configuration: { codexCommand: "codex" },
    readiness: {
      pipelines: [{
        pipelineId: "codex-review",
        status: "needsSetup",
        findings: [{
          id: "adapter.codex",
          label: "Codex",
          status: "needsSetup",
          detail: "codex unavailable: spawn codex ENOENT",
          remediationId: "provider.install.codex",
        }],
      }],
      pipelineNames: { "codex-review": "Review code" },
      pipelineSafetyLevels: { "codex-review": "review" },
      selectedPipelineId: "codex-review",
      adapters: [{ type: "codex-app-server", available: false, detail: "codex unavailable: spawn codex ENOENT" }],
      git: { available: true, detail: "git version 2.39.5", clean: true, statusDetail: "Workspace is clean" },
      bridge: { enabled: true, connected: true, sessions: [] },
      workspaceRoots: ["/work/first"],
      trusted: true,
    },
  });

  await harness.commands.get("bachata.doctor")();

  const guidance = harness.informationDetails.find((entry) =>
    entry.message === "Codex is not runnable from this workspace"
  );
  assert.ok(guidance, "no provider guidance was shown");
  // Guidance is not a confirmation, so it never blocks the window; the steps it used to hide in
  // a modal detail are in the Output channel, in order, and one button away.
  assert.equal(guidance.options.modal, false);
  const steps = harness.outputLines.join("\n");
  assert.match(steps, /^Codex is not runnable from this workspace: codex unavailable: spawn codex ENOENT/mu);
  assert.match(steps, /^1\. Install the Codex CLI/mu);
  assert.match(steps, /bachata\.codexCommand/u);
  assert.match(steps, /^5\. Recheck Codex/mu);
  assert.deepEqual(guidance.actions, [
    "Run codex --version",
    "Set bachata.codexCommand",
    "Open provider setup notes",
    "Recheck Codex",
    "Show Steps",
  ]);
  assert.ok(harness.executedCommands.includes("workbench.action.openSettings"));
  assert.equal(
    harness.informationMessages.includes("Bachata: Recheck Codex when the change is in place."),
    true,
  );
  assert.equal(harness.executedCommands.filter((id) => id === "bachata.doctor").length, 0);
});

test("Doctor guides Browser Bridge pairing step by step", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickInformationAction: true,
    warningChoice: "Fix a Problem",
    pickRemediation: "bridge.connect",
    readiness: {
      pipelines: [{
        pipelineId: "browser-pair",
        status: "needsSetup",
        findings: [{
          id: "bridge.chatgpt",
          label: "ChatGPT",
          status: "needsSetup",
          detail: "Connect the Browser Bridge",
          remediationId: "bridge.connect",
        }],
      }],
      pipelineNames: { "browser-pair": "Browser pair" },
      pipelineSafetyLevels: { "browser-pair": "managed" },
      selectedPipelineId: "browser-pair",
      adapters: [],
      git: { available: true, detail: "git version 2.39.5", clean: true, statusDetail: "Workspace is clean" },
      bridge: { enabled: true, connected: false, sessions: [] },
      workspaceRoots: ["/work/first"],
      trusted: true,
    },
  });

  await harness.commands.get("bachata.doctor")();

  const guidance = harness.informationDetails.find((entry) =>
    entry.message === "The Browser Bridge is not connected"
  );
  assert.ok(guidance, "no Browser Bridge guidance was shown");
  assert.equal(guidance.options.modal, false);
  const steps = harness.outputLines.join("\n");
  assert.match(steps, /^The Browser Bridge is not connected: Not connected/mu);
  assert.match(steps, /^1\. Install the Bachata Browser Bridge/mu);
  assert.match(steps, /Discover/u);
  assert.match(steps, /pairing token/u);
  assert.match(steps, /^5\. Bind one ready conversation/mu);
  assert.deepEqual(guidance.actions, ["Open Bridge install guide", "Show Steps"]);
  assert.ok(harness.executedCommands.includes("vscode.open"));
});

const reviewReadiness = (pipelines, extra = {}) => ({
  pipelines,
  pipelineNames: {
    "codex-review": "Codex review",
    "claude-review": "Claude review",
    "review-only": "Review only",
  },
  pipelineSafetyLevels: { "codex-review": "review", "claude-review": "review", "review-only": "review" },
  pipelineGuardrails: {
    "codex-review": {
      pipelineId: "codex-review",
      pipelineName: "Review with Codex",
      safetyLevel: "review",
      writeAuthority: "Read-only. Nothing in your repository is written.",
      writablePaths: [],
      readablePaths: [],
      protectedPaths: [],
      checks: [],
      commitPolicy: "never",
      providers: ["Codex (Codex app server)"],
      humanDecisions: [],
      advancedOnly: [],
    },
    "review-only": {
      pipelineId: "review-only",
      pipelineName: "Review only",
      safetyLevel: "review",
      writeAuthority: "Read-only. Nothing in your repository is written.",
      writablePaths: [],
      readablePaths: [],
      protectedPaths: [],
      checks: ["bachata:project-checks"],
      commitPolicy: "never",
      providers: ["Codex (Codex app server)", "Claude (Claude Code)"],
      humanDecisions: [],
      advancedOnly: [],
    },
  },
  ...extra,
});

const modePickOf = (harness) => harness.quickPicks.find((items) =>
  items.length > 0 && items.every((item) => item.mode && typeof item.mode === "object"));

test("setup offers both modes with providers, safety, verification, and iteration limits", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    pickMode: "paired",
    pickInformationAction: true,
    readiness: reviewReadiness([
      { pipelineId: "codex-review", status: "ready", findings: [] },
      { pipelineId: "claude-review", status: "ready", findings: [] },
      { pipelineId: "review-only", status: "ready", findings: [] },
    ]),
  });

  await harness.commands.get("bachata.setup")();

  const modes = modePickOf(harness);
  assert.ok(modes, "no mode choice was offered");
  assert.deepEqual(modes.map((item) => item.mode.mode), ["paired", "single"]);
  const paired = modes.find((item) => item.mode.mode === "paired");
  const single = modes.find((item) => item.mode.mode === "single");
  assert.match(paired.label, /Cross-checked pair/u);
  assert.match(single.label, /Fast single agent/u);
  assert.match(paired.detail, /2 providers: Codex \(Codex app server\), Claude \(Claude Code\)/u);
  assert.match(paired.detail, /Safety: read-only/u);
  assert.match(paired.detail, /Verification: integrity, syntax and types/u);
  assert.match(paired.detail, /At most 10 iterations per run/u);
  assert.match(single.detail, /1 provider: Codex \(Codex app server\)/u);
  assert.match(single.detail, /Verification: none declared/u);

  assert.equal(harness.createdConversations.length, 1);
  assert.equal(harness.createdConversations[0].pipelineId, "review-only");
});

test("setup never picks a single agent when an equally ready pair exists", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    pickInformationAction: true,
    readiness: reviewReadiness([
      { pipelineId: "codex-review", status: "ready", findings: [] },
      { pipelineId: "claude-review", status: "ready", findings: [] },
      { pipelineId: "review-only", status: "ready", findings: [] },
    ]),
  });

  await harness.commands.get("bachata.setup")();

  assert.equal(harness.createdConversations.length, 1);
  assert.equal(
    harness.createdConversations[0].pipelineId,
    "review-only",
    "setup silently chose a single-provider pipeline over an equally ready pair",
  );
});

test("setup explains a blocked pair and offers remediation instead of running it", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    pickMode: "paired",
    warningChoice: "Run Doctor",
    readiness: reviewReadiness([
      { pipelineId: "codex-review", status: "ready", findings: [] },
      { pipelineId: "review-only", status: "needsSetup", findings: [{ status: "needsSetup", detail: "claude unavailable: spawn claude ENOENT" }] },
    ]),
  });

  await harness.commands.get("bachata.setup")();

  const modes = modePickOf(harness);
  assert.match(modes.find((item) => item.mode.mode === "paired").detail, /claude unavailable/u);
  assert.deepEqual(harness.createdConversations, []);
  assert.ok(
    harness.warnings.some((entry) => /claude unavailable/u.test(entry.message ?? entry)),
    "setup did not explain why the pair is unavailable",
  );
  assert.ok(harness.executedCommands.includes("bachata.doctor"));
});

test("setup with neither mode ready creates no run", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    pickMode: "single",
    readiness: reviewReadiness([
      { pipelineId: "codex-review", status: "blocked", findings: [{ status: "blocked", detail: "codex unavailable" }] },
      { pipelineId: "review-only", status: "blocked", findings: [{ status: "blocked", detail: "both providers unavailable" }] },
    ]),
  });

  await harness.commands.get("bachata.setup")();

  assert.deepEqual(harness.createdConversations, []);
});

test("Setup remembers an abandoned choice and offers to continue it", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    pickCard: "review",
    pickMode: "abandoned",
    readiness: {
      pipelines: [
        { pipelineId: "codex-review", status: "ready", findings: [] },
        { pipelineId: "review-only", status: "ready", findings: [] },
      ],
      pipelineNames: { "codex-review": "Codex review", "review-only": "Review only" },
      pipelineSafetyLevels: { "codex-review": "review", "review-only": "review" },
    },
  });

  await harness.commands.get("bachata.setup")();
  const stored = harness.context.workspaceState.get("bachata.setup.v1");
  assert.equal(stored.completed, false, "an abandoned Setup was recorded as completed");
  assert.equal(stored.goalId, "review");

  const resumed = loadCommands({ active: false, retainedRuns: [] }, {
    pickResume: true,
    workspaceState: { "bachata.setup.v1": stored },
    readiness: {
      pipelines: [
        { pipelineId: "codex-review", status: "ready", findings: [] },
        { pipelineId: "review-only", status: "ready", findings: [] },
      ],
      pipelineNames: { "codex-review": "Codex review", "review-only": "Review only" },
      pipelineSafetyLevels: { "codex-review": "review", "review-only": "review" },
    },
  });
  await resumed.commands.get("bachata.setup")();
  assert.match(
    resumed.quickPicks[0].find((item) => item.resume === true).label,
    /Continue: Review code/u,
    "Setup did not offer to continue the abandoned goal",
  );
  assert.equal(
    resumed.quickPicks.some((items) => items.some((item) => item.card?.id === "plan")),
    false,
    "Setup asked for the goal again after the user chose to continue",
  );
});

test("Setup starting over does not resume the abandoned goal", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    pickResume: false,
    pickCard: "plan",
    workspaceState: {
      "bachata.setup.v1": {
        version: 1,
        completed: false,
        goalId: "review",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
    },
    readiness: {
      pipelines: [
        { pipelineId: "codex-plan", status: "ready", findings: [] },
      ],
      pipelineNames: { "codex-plan": "Codex plan" },
      pipelineSafetyLevels: { "codex-plan": "review" },
    },
  });
  await harness.commands.get("bachata.setup")();
  assert.equal(
    harness.quickPicks.some((items) => items.some((item) => item.card?.id === "plan")),
    true,
    "Setup did not ask for the goal again after Start over",
  );
});

test("setup collects the initiative goal before a review, and never invents one", async () => {
  const base = {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
    },
  };

  const stated = loadCommands({ active: false, retainedRuns: [] }, {
    ...base,
    hasInitiative: false,
    initiativeGoal: "every retry path is bounded",
  });
  await stated.commands.get("bachata.setup")();
  assert.equal(stated.inputBoxes.length, 1, "setup did not ask for the goal");
  assert.deepEqual(
    stated.definedInitiatives.map((item) => item.goal),
    ["every retry path is bounded"],
  );
  assert.equal(stated.createdConversations.length, 1, "the review did not start after the goal was stated");

  const refused = loadCommands({ active: false, retainedRuns: [] }, {
    ...base,
    hasInitiative: false,
    initiativeGoal: undefined,
  });
  await refused.commands.get("bachata.setup")();
  assert.deepEqual(refused.definedInitiatives, [], "setup invented an initiative goal");
  assert.deepEqual(
    refused.createdConversations,
    [],
    "setup started a review whose result no initiative could record",
  );
  assert.ok(
    refused.warnings.some((entry) => /none was stated/u.test(entry.message)),
    "setup stopped without saying why",
  );

  const existing = loadCommands({ active: false, retainedRuns: [] }, {
    ...base,
    hasInitiative: true,
  });
  await existing.commands.get("bachata.setup")();
  assert.deepEqual(existing.inputBoxes, [], "setup asked for a goal it already had");
  assert.equal(existing.createdConversations.length, 1);
});

test("a Setup review selection never becomes the authority for another action", async () => {
  const setupChose = {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
    },
  };

  // Review File is the journey's own action, so it fills the run Setup already created
  // with the pipeline Setup chose.
  const review = loadCommands({ active: false, retainedRuns: [] }, setupChose);
  await review.commands.get("bachata.setup")();
  assert.equal(review.createdConversations[0].pipelineId, "codex-review");
  await review.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
  assert.equal(review.adoptedConversations.length, 1, "Review File did not run Setup's workflow");

  // Fix Diagnostic is a different action. It must neither adopt the review run nor
  // inherit a read-only pipeline that cannot write.
  const diagnosticTarget = uriOf("/work/first/src/a.ts");
  const fix = loadCommands({ active: false, retainedRuns: [] }, {
    ...setupChose,
    activeTextEditor: {
      document: { uri: diagnosticTarget, getText: () => "" },
      selection: { start: { line: 3 }, end: { line: 3 } },
    },
    diagnostics: [diagnostic(3, "a real defect")],
  });
  await fix.commands.get("bachata.setup")();
  await fix.commands.get("bachata.fixDiagnostic")(diagnosticTarget);
  assert.deepEqual(fix.adoptedConversations, [], "Fix Diagnostic took over the review run");
  assert.equal(fix.createdConversations.length, 2, "Fix Diagnostic created no conversation");
  assert.equal(
    fix.createdConversations.at(-1).pipelineId,
    undefined,
    "a read-only review pipeline was carried onto Fix Diagnostic, which cannot write",
  );

  // A write-capable selection is not authority for a read-only review.
  const writeCapable = loadCommands({ active: false, retainedRuns: [] }, {
    ...setupChose,
    pickCard: "fix",
    readiness: {
      pipelines: [{ pipelineId: "managed-fix", status: "ready", findings: [] }],
      pipelineNames: { "managed-fix": "Managed fix" },
      pipelineSafetyLevels: { "managed-fix": "managed" },
    },
  });
  await writeCapable.commands.get("bachata.setup")();
  await writeCapable.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
  assert.deepEqual(writeCapable.adoptedConversations, [], "a fix run was taken over by a review");
  assert.equal(writeCapable.createdConversations.length, 2, "Review File created no conversation");
  assert.equal(
    writeCapable.createdConversations.at(-1).pipelineId,
    undefined,
    "a write-capable selection was carried onto Review File, which is read-only",
  );
});

test("the journey produces exactly one run: a review fills the run Setup created", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
    },
  });

  await harness.commands.get("bachata.setup")();
  assert.equal(harness.createdConversations.length, 1, "setup created no run");

  await harness.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
  assert.equal(
    harness.createdConversations.length,
    1,
    "the review created a second run and stranded the one Setup made",
  );
  assert.deepEqual(
    harness.adoptedConversations.map((entry) => entry.conversationId),
    ["conversation-1"],
  );
  assert.match(harness.adoptedConversations[0].preparedDraft, /a\.ts/u);

  await harness.commands.get("bachata.reviewFile")(uriOf("/work/first/src/b.ts"));
  assert.equal(
    harness.createdConversations.length,
    2,
    "a later review reused a run that was already filled",
  );
});

test("the documented journey runs as one connected sequence, in both modes", async () => {
  const readiness = (pipelineId, safety) => ({
    pipelines: [{ pipelineId, status: "ready", findings: [] }],
    pipelineNames: { [pipelineId]: pipelineId },
    pipelineSafetyLevels: { [pipelineId]: safety },
  });

  for (const [mode, pipelineId] of [["fast single agent", "codex-review"], ["cross-checked pair", "review-only"]]) {
    const harness = loadCommands({ active: false, retainedRuns: [] }, {
      workspaceFolders: ["/work/first"],
      pickCard: "review",
      hasInitiative: false,
      initiativeGoal: "Every retry path is bounded",
      readiness: readiness(pipelineId, "review"),
    });

    // Setup: collects the goal, then creates exactly one run carrying the chosen workflow.
    await harness.commands.get("bachata.setup")();
    assert.deepEqual(
      harness.definedInitiatives.map((item) => item.goal),
      ["Every retry path is bounded"],
      `${mode}: setup did not record the stated goal`,
    );
    assert.equal(harness.createdConversations.length, 1, `${mode}: setup did not create one run`);
    assert.equal(
      harness.createdConversations[0].pipelineId,
      pipelineId,
      `${mode}: setup created a run with a workflow the user did not choose`,
    );

    // First review: fills that same run rather than stranding it beside a second.
    await harness.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
    assert.equal(
      harness.createdConversations.length,
      1,
      `${mode}: the first review stranded the run Setup created`,
    );
    assert.deepEqual(
      harness.adoptedConversations.map((entry) => entry.conversationId),
      ["conversation-1"],
      `${mode}: the first review did not reuse Setup's run`,
    );
    assert.deepEqual(harness.errors, [], `${mode}: the journey reported ${harness.errors.join("; ")}`);
  }
});

test("the journey refuses to start a review it could not record, and states why", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    hasInitiative: false,
    initiativeGoal: undefined,
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
    },
  });

  await harness.commands.get("bachata.setup")();
  assert.deepEqual(harness.definedInitiatives, [], "the journey invented a goal");
  assert.deepEqual(harness.createdConversations, [], "a review started with nothing to record it against");
  assert.ok(
    harness.warnings.some((entry) => /none was stated/u.test(entry.message)),
    "the journey stopped without telling the user why",
  );
});

test("a restarted journey resumes rather than repeating what was done", async () => {
  const options = {
    workspaceFolders: ["/work/first"],
    pickCard: "review",
    hasInitiative: true,
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
    },
  };
  const shared = new Map();
  const first = loadCommands({ active: false, retainedRuns: [] }, { ...options, setupState: shared });
  await first.commands.get("bachata.setup")();
  assert.equal(first.createdConversations.length, 1);

  // A second Extension Host reading the same workspace state must see Setup's choice.
  const second = loadCommands({ active: false, retainedRuns: [] }, { ...options, setupState: shared });
  await second.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
  assert.equal(
    second.createdConversations.length,
    0,
    "a restart created a second run instead of filling the one Setup made",
  );
  assert.equal(second.adoptedConversations.length, 1, "a restart lost Setup's run");
});

test("setup adoption refuses a run that belongs to another repository", async () => {
  const shared = new Map();
  const base = {
    pickCard: "review",
    hasInitiative: true,
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      pipelineSafetyLevels: { "codex-review": "review" },
    },
  };

  const setup = loadCommands({ active: false, retainedRuns: [] }, {
    ...base,
    workspaceFolders: ["/work/first"],
    setupState: shared,
  });
  await setup.commands.get("bachata.setup")();
  assert.equal(setup.createdConversations[0].workingDirectory, "/work/first");

  // A review in a different root of the same workspace must not take over that run.
  const elsewhere = loadCommands({ active: false, retainedRuns: [] }, {
    ...base,
    workspaceFolders: ["/work/second"],
    setupState: shared,
    adoptionWorkingDirectory: "/work/first",
  });
  await elsewhere.commands.get("bachata.reviewFile")(uriOf("/work/second/src/a.ts"));
  assert.deepEqual(
    elsewhere.adoptedConversations,
    [],
    "a run created for another repository was adopted",
  );
  assert.equal(
    elsewhere.createdConversations.length,
    1,
    "the review in the second repository created no run of its own",
  );
  assert.equal(elsewhere.createdConversations[0].workingDirectory, "/work/second");
});

test("every delta review binds the exact candidate it read", async () => {
  const scopes = [
    ["bachata.reviewStagedDiff", "stagedDiff", undefined],
    ["bachata.reviewUncommitted", "uncommitted", undefined],
    ["bachata.reviewBranch", "branchAgainstBase", "main"],
    ["bachata.reviewCommit", "commit", "HEAD"],
  ];
  const digests = new Set();
  for (const [command, kind, ref] of scopes) {
    const harness = loadCommands({ active: false, retainedRuns: [] }, {
      workspaceFolders: ["/work/first"],
      hasInitiative: true,
      inputBoxValue: ref,
    });
    await harness.commands.get(command)();
    const created = harness.createdConversations.at(-1);
    assert.ok(created, `${command} created no run`);
    assert.ok(created.reviewCandidate, `${command} bound no candidate`);
    assert.equal(created.reviewCandidate.kind, kind);
    assert.equal(
      created.reviewCandidate.comprehensive,
      false,
      `${command} claimed to be a comprehensive review`,
    );
    assert.match(created.reviewCandidate.inputDigest, /^[0-9a-f]{64}$/u);
    digests.add(created.reviewCandidate.inputDigest);
  }
  assert.equal(digests.size, scopes.length, "two delta scopes shared one candidate identity");
});

test("a file review binds the file it read, not the repository", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    hasInitiative: true,
  });
  await harness.commands.get("bachata.reviewFile")(uriOf("/work/first/src/a.ts"));
  const created = harness.createdConversations.at(-1);
  assert.equal(created.reviewCandidate.kind, "file");
  assert.equal(created.reviewCandidate.source, "/work/first/src/a.ts");
  assert.equal(created.reviewCandidate.comprehensive, false);
});

test("Setup exposes provider selection and records the chosen preference", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickProvidersEntry: true,
    pickProviders: "codex-app-server",
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      adapters: [
        { type: "codex-app-server", available: true, detail: "codex app-server 0.146.0" },
        { type: "claude-code", available: false, detail: "claude unavailable" },
      ],
    },
  });

  await harness.commands.get("bachata.setup")();

  const journey = harness.quickPicks[0];
  const providers = journey.find((item) => item.providers);
  assert.notEqual(providers, undefined, "Setup offered no provider entry");
  assert.match(providers.label, /Providers/u);

  const providerPick = harness.quickPicks[1];
  assert.equal(
    providerPick.some((item) => item.provider === "auto"),
    true,
    "Setup offered no way back to letting readiness decide",
  );
  assert.equal(
    providerPick.some((item) => item.manageProviders === true),
    true,
    "Setup offered no way to disable a provider",
  );
  assert.match(
    providerPick.find((item) => item.provider === "codex-app-server").detail,
    /codex app-server 0\.146\.0/u,
    "the provider entry must state what the probe found",
  );
  assert.deepEqual(
    harness.configurationUpdates.map((update) => [update.key, update.value]),
    [["preferredProvider", "codex-app-server"]],
  );
});

test("Setup disables a provider by writing the setting, not by hiding it", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    pickProvidersEntry: true,
    pickProviders: "manage",
    pickMany: ["codex-app-server"],
    readiness: {
      pipelines: [{ pipelineId: "codex-review", status: "ready", findings: [] }],
      pipelineNames: { "codex-review": "Codex review" },
      adapters: [{ type: "codex-app-server", available: true, detail: "codex app-server 0.146.0" }],
    },
  });

  await harness.commands.get("bachata.setup")();

  assert.deepEqual(
    harness.configurationUpdates.map((update) => [update.key, update.value]),
    [["disabledProviders", ["codex-app-server"]]],
  );
});

test("every alternate review entry point settles the initiative before a draft exists", async () => {
  const fsp = require("node:fs/promises");
  const source = await fsp.readFile(
    require("node:path").join(__dirname, "..", "src", "commands", "registerCommands.ts"),
    "utf8",
  );
  assert.match(
    source,
    /const chosenPipelineId = await reusableSetupPipeline\(scope\);\n\s*if \(!await initiativeReadyForDraft\(workspaceRoot, chosenPipelineId\)\) return;/u,
    "openDraft must settle the initiative before it composes a draft",
  );
  assert.match(
    source,
    /const openGitReviewDraft = async[\s\S]{0,200}await openDraft\(scope, undefined, git\);/u,
    "the Git review commands must route through the guarded openDraft",
  );
  assert.match(
    source,
    /if \(!required\)[\s\S]{0,800}Continue without one/u,
    "a workflow not known to require an initiative is offered, never blocked",
  );
});

test("Improve offers the same working-tree seal as Run TODO.md", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    todoDirtyPaths: ["src/a.ts", "docs/b.md"],
    pickSealedPaths: ["src/a.ts", "docs/b.md"],
    warningChoice: "Seal these changes",
  });
  // Both entry points must be startable on the dirty checkout Bachata is asked to improve.
  await harness.commands.get("bachata.improve")();
  assert.deepEqual(
    harness.orchestrator.improveReadinessOptions[0],
    { sealedInputPaths: ["src/a.ts", "docs/b.md"] },
    "Improve inspected readiness without the paths it would seal",
  );
  assert.deepEqual(harness.errors, []);
});

test("Improve stops when the seal is declined, and starts nothing", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    todoDirtyPaths: ["src/a.ts"],
    pickSealedPaths: ["src/a.ts"],
  });
  await harness.commands.get("bachata.improve")();
  assert.equal(harness.orchestrator.improveCalls, 0);
  assert.deepEqual(harness.orchestrator.improveReadinessOptions, []);
});

// EX-G6-08. A window can hold more than one repository. The command used to name, read
// descriptors from and store approval against `workspaceFolders[0]`, while the orchestrator
// executed the repository the active editor is in — so a person could approve one repository's
// declared checks, read its name in the confirmation, and have the other one orchestrated.
test("Improve names and runs the repository its readiness resolved", async () => {
  const readiness = {
    pipelineId: "todo-master",
    status: "ready",
    findings: [],
    todoExecutable: true,
    repositoryVerifiers: "refused",
    bootstrapPipelineIds: ["self-improvement"],
    taskPipelinesWithOwnSteps: [],
    contract: { taskIds: ["T1"] },
    workspaceRoot: "/work/second",
  };
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
    warningChoice: "Improve this project",
    improveReadiness: readiness,
  });
  await harness.commands.get("bachata.improve")();
  const detail = harness.warnings.map((entry) => entry.options?.detail ?? "").join("\n");
  assert.match(detail, /Repository: \/work\/second/u);
  assert.doesNotMatch(
    detail,
    /Repository: \/work\/first/u,
    "the confirmation named a repository this run would not execute",
  );
  assert.equal(harness.orchestrator.improveCalls, 1);
  assert.deepEqual(
    harness.orchestrator.improveOptions[0],
    { sealedInputPaths: [], workspaceRoot: "/work/second" },
    "the run was started without naming the repository that was approved",
  );
});

test("Improve refuses when the active repository moved while it was asking", async () => {
  const readinessFor = (root) => ({
    pipelineId: "todo-master",
    status: "ready",
    findings: [],
    todoExecutable: true,
    repositoryVerifiers: "refused",
    bootstrapPipelineIds: ["self-improvement"],
    taskPipelinesWithOwnSteps: [],
    contract: { taskIds: ["T1"] },
    workspaceRoot: root,
  });
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first", "/work/second"],
    warningChoice: "Improve this project",
    improveReadiness: (call) => readinessFor(call === 1 ? "/work/second" : "/work/third"),
  });
  await harness.commands.get("bachata.improve")();
  assert.equal(
    harness.orchestrator.improveCalls,
    0,
    "a run started against a repository the person never saw",
  );
  const detail = harness.warnings.map((entry) => entry.options?.detail ?? "").join("\n");
  assert.match(detail, /Approved: \/work\/second/u);
  assert.match(detail, /Active now: \/work\/third/u);
});

test("Improve states what actually reviews before the checks", async () => {
  const harness = loadCommands({ active: false, retainedRuns: [] }, {
    workspaceFolders: ["/work/first"],
    warningChoice: "Improve this project",
    improveReadiness: {
      pipelineId: "todo-master",
      status: "ready",
      findings: [],
      todoExecutable: true,
      repositoryVerifiers: "refused",
      bootstrapPipelineIds: ["self-improvement"],
      taskPipelinesWithOwnSteps: ["todo-implementation"],
      contract: { taskIds: ["T1"] },
    },
  });
  await harness.commands.get("bachata.improve")();
  const detail = harness.warnings.map((entry) => entry.options?.detail ?? "").join("\n");
  assert.match(detail, /before its own Lead review/u);
  assert.match(detail, /may review inside the pipeline, before those checks: todo-implementation/u);
  assert.doesNotMatch(detail, /before every review/u);
});

// The approval a person gives names a repository and the set of checks that repository declared
// when they were asked. Storing it without that set left the approval standing over a registry
// edited afterwards, so the executables that ran unattended were not the ones anyone approved.
const APPROVAL_KEY = "bachata.improve.repositoryVerifiers.v1";

const verifierDescriptor = (overrides = {}) => ({
  id: "suite",
  description: "The repository's own suite",
  executable: "npx",
  args: ["tsc", "--noEmit"],
  workingDirectory: ".",
  environmentAllowlist: ["CI"],
  timeoutMs: 60000,
  maxOutputBytes: 65536,
  expect: { exitCode: 0 },
  ...overrides,
});

const writeVerifierRegistry = (root, ...verifiers) => {
  const fs = require("node:fs");
  const nodePath = require("node:path");
  fs.mkdirSync(nodePath.join(root, ".bachata"), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, ".bachata", "verifiers.json"),
    JSON.stringify({ version: 1, verifiers }),
    "utf8",
  );
};

const registryDigestOf = (...verifiers) => {
  const { parseVerifierRegistry } = require("../dist/orchestrator/verifierRegistry.js");
  const { verifierRegistryDigest } = require("../dist/orchestrator/verifierApproval.js");
  const parsedRegistry = parseVerifierRegistry({ version: 1, verifiers });
  assert.deepEqual(parsedRegistry.errors, []);
  return verifierRegistryDigest(parsedRegistry.registry);
};

const verifierRepository = (...verifiers) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const nodePath = require("node:path");
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "bachata-improve-approval-")));
  writeVerifierRegistry(root, ...verifiers);
  return root;
};

const improveHarness = (root, harnessOptions) => loadCommands({ active: false, retainedRuns: [] }, {
  workspaceFolders: [root],
  improveReadiness: {
    pipelineId: "todo-master",
    status: "ready",
    findings: [],
    todoExecutable: true,
    repositoryVerifiers: "refused",
    bootstrapPipelineIds: ["self-improvement"],
    taskPipelinesWithOwnSteps: [],
    contract: { taskIds: ["T1"] },
    workspaceRoot: root,
  },
  ...harnessOptions,
});

test("Improve discloses the executables it asks about and records the set it disclosed", async () => {
  const fs = require("node:fs");
  const declared = verifierDescriptor();
  const root = verifierRepository(declared);
  try {
    const harness = improveHarness(root, { warningChoice: "Approve these checks" });
    await harness.commands.get("bachata.improve")();

    const approval = harness.warnings[0];
    assert.match(
      approval.options.detail,
      /- bachata:verifier:suite: npx tsc --noEmit/u,
      "the dialog named the descriptor id without the executable it starts",
    );
    assert.deepEqual(
      harness.context.workspaceState.get(APPROVAL_KEY),
      { [root]: registryDigestOf(declared) },
      "the approval was recorded without the descriptor set it was given for",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an approval stops covering a registry that was edited under it", async () => {
  const fs = require("node:fs");
  const approved = verifierDescriptor();
  const root = verifierRepository(approved);
  try {
    writeVerifierRegistry(root, verifierDescriptor({ executable: "node", args: ["scripts/publish.js"] }));
    const harness = improveHarness(root, {
      workspaceState: { [APPROVAL_KEY]: { [root]: registryDigestOf(approved) } },
    });
    await harness.commands.get("bachata.improve")();

    const approval = harness.warnings[0];
    assert.match(approval.message, /start the checks this repository declares/u);
    assert.match(approval.options.detail, /does not cover the checks it declares now/u);
    assert.match(approval.options.detail, /- bachata:verifier:suite: node scripts\/publish\.js/u);
    assert.equal(
      harness.orchestrator.improveCalls,
      0,
      "the dialog was dismissed, so nothing may start",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An approval an older build recorded names no descriptor set at all. Honouring it would keep
// the defect for exactly the people who already have one, so it is asked again — and the dialog
// says why rather than appearing a second time with no explanation.
test("an approval recorded before descriptor sets were bound is asked again", async () => {
  const fs = require("node:fs");
  const declared = verifierDescriptor();
  const root = verifierRepository(declared);
  try {
    const harness = improveHarness(root, {
      workspaceState: { [APPROVAL_KEY]: { [root]: true } },
      warningChoice: "Approve these checks",
    });
    await harness.commands.get("bachata.improve")();

    assert.match(harness.warnings[0].options.detail, /does not cover the checks it declares now/u);
    assert.deepEqual(
      harness.context.workspaceState.get(APPROVAL_KEY),
      { [root]: registryDigestOf(declared) },
      "re-approving must replace the unbound record with the set it covers",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an approval that still covers the declared checks does not ask again", async () => {
  const fs = require("node:fs");
  const declared = verifierDescriptor();
  const root = verifierRepository(declared);
  try {
    const harness = improveHarness(root, {
      workspaceState: { [APPROVAL_KEY]: { [root]: registryDigestOf(declared) } },
      warningChoice: "Improve this project",
    });
    await harness.commands.get("bachata.improve")();

    assert.deepEqual(
      harness.warnings.map((entry) => entry.message).filter(
        (message) => /start the checks this repository declares/u.test(message),
      ),
      [],
      "a standing approval was re-asked, which trains people to click through it",
    );
    assert.equal(harness.orchestrator.improveCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The two reads of one approval want different answers. The run authority asks whether the
// approval covers what this repository declares now; the removal control asks only whether a
// record exists, because a record it cannot see is a record it cannot offer to remove.
test("the run authority reads the approval against the registry, the removal control does not", async () => {
  const fsp = require("node:fs/promises");
  const source = await fsp.readFile(
    require("node:path").join(__dirname, "..", "src", "extension.ts"),
    "utf8",
  );
  assert.match(
    source,
    /approvedRepositoryVerifiers: \(repositoryRoot\) => \{[\s\S]{0,400}declaredVerifierRegistryDigest\(repositoryRoot\)[\s\S]{0,400}declaredDigest !== undefined[\s\S]{0,400}repositoryVerifiersApproved\([\s\S]{0,200}declaredDigest,/u,
    "the run authority honours an approval without checking what the registry declares now",
  );
  assert.match(
    source,
    /isRecorded: \(\) => \{[\s\S]{0,300}repositoryVerifiersApproved\(\s*context\.workspaceState\.get<unknown>\(REPOSITORY_VERIFIER_APPROVAL_KEY\),\s*path\.resolve\(workspaceRoot\(\)\),\s*\)/u,
    "the removal control must ask whether any approval is recorded, not whether it still covers the registry",
  );
});

// docs/CONCURRENCY.md: activation fails instead of continuing without coordination. The channel
// created before the broker was leaked on that failure — created, stored in the panel module's
// global, and never disposed — so the refusal reached a channel nobody could open.
test("a broker that cannot open fails activation without leaking the output channel", async () => {
  const fsp = require("node:fs/promises");
  const source = await fsp.readFile(
    require("node:path").join(__dirname, "..", "src", "extension.ts"),
    "utf8",
  );
  assert.match(
    source,
    /try \{\s*resourceBroker = createResourceBroker\(\{[\s\S]{0,300}\} catch \(error\) \{[\s\S]{0,900}output\.dispose\(\);[\s\S]{0,300}throw error;/u,
    "a broker that cannot open must dispose the channel activation created",
  );
  assert.match(
    source,
    /output\.dispose\(\);\s*void vscode\.window\.showErrorMessage\(reason\)/u,
    "the reason activation refused must be shown, not only written to a disposed channel",
  );
  assert.match(
    source,
    /\} catch \(error\) \{[\s\S]{0,900}throw error;\s*\}\s*(\/\/[^\n]*\n\s*)*setPipelinePanelOutput\(output\);/u,
    "the panel global must not be set until the broker is open",
  );
});
