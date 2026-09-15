const widths = [320, 360, 400, 480, 700, 792, 900, 1280];
const themes = ["light", "dark", "high-contrast"];

const debuggerCommand = (command, params) =>
  Cypress.automation("remote:debugger:protocol", { command, params });

const emulateTheme = (theme) =>
  debuggerCommand("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" },
      { name: "forced-colors", value: theme === "high-contrast" ? "active" : "none" },
    ],
  });

const pressKey = (key, code, keyCode, modifiers = 0) =>
  cy.wrap(null).then(async () => {
    await debuggerCommand("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
      ...(key === "Enter" ? { text: "\r" } : {}),
    });
    await debuggerCommand("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    });
  }).wait(120);

const prepareDecision = (win) => {
  const manager = win.__managerState;
  const panel = win.__panelState;
  manager.conversations[0].running = true;
  manager.conversations[0].workflowStatus = "paused";
  panel.running = true;
  panel.operationActive = true;
  panel.workflowStatus = "paused";
  panel.agents.worker = {
    id: "worker",
    name: "Accessibility reviewer",
    adapterType: "claude-code",
    status: "idle",
    output: "",
  };
  panel.pendingGate = {
    stepId: "step-1",
    stepName: "Independent specialist review",
    reason: "maxConsensusRounds",
    round: 3,
    decisionRound: 2,
    allowedActions: ["acceptParticipant", "acceptUnresolved", "retry", "cancel"],
    rollbackTargets: [],
    conclusionOptions: [
      { agentId: "lead", label: "Usability reviewer" },
      { agentId: "worker", label: "Accessibility reviewer" },
    ],
    detail: "The reviewers reached the round limit without agreeing. Choose a conclusion or request one more review round.",
  };
  panel.transcript = [
    { id: "request", kind: "prompt", eventType: "user.message", text: "Review the extension interface and identify release blockers.", createdAt: "2026-09-13T00:00:00Z" },
    { id: "lead-answer", kind: "answer", agentId: "lead", text: "The navigation is clear, but the compact layout needs stronger gutters.", createdAt: "2026-09-13T00:01:00Z" },
    { id: "worker-answer", kind: "answer", agentId: "worker", text: "Keyboard focus works, but the final decision needs a visible owner.", createdAt: "2026-09-13T00:02:00Z" },
  ];
  panel.transcriptTotal = panel.transcript.length;
  win.__boot();
};

const expectNoHorizontalScroll = () =>
  cy.document().then((doc) => {
    const content = doc.querySelector(".conversation-scroll");
    expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1);
    expect(content.scrollWidth).to.be.at.most(content.clientWidth + 1);
  });

describe("UI re-audit release states", { browser: "chrome" }, () => {
  for (const theme of themes) {
    for (const width of widths) {
      it(`keeps a pending consensus decision usable in ${theme} at ${String(width)}px`, () => {
        cy.viewport(width, 900);
        cy.visit("tests/fixtures/webview-layout/index.html");
        cy.window().its("__boot").should("be.a", "function");
        cy.wrap(null).then(() => emulateTheme(theme));
        cy.window().then(prepareDecision);
        cy.get('.run-tab.selected .run-tab-tools [data-action="room-view"][data-view="execution"]').click();
        cy.get("#pending-gate").should("be.visible").within(() => {
          cy.contains("Independent specialist review");
          cy.get("#gate-rationale").should("be.visible");
          cy.get('[data-gate-action="acceptParticipant"]').should("have.length", 2);
          cy.get("button").each(($button) => {
            expect($button[0].getBoundingClientRect().height).to.be.at.least(24);
          });
        });
        cy.get('.header-action-menu [data-action="availability-check"]').should("be.disabled");
        expectNoHorizontalScroll();
        cy.screenshot(`ui-reaudit/decision-${theme}-${String(width)}`);
      });
    }
  }

  it("submits the chosen conclusion and rationale", () => {
    cy.viewport(700, 900);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then(prepareDecision);
    cy.get("#gate-rationale").type("Use the accessibility review as the release decision.");
    cy.get('[data-gate-action="acceptParticipant"][data-participant="worker"]').click();
    cy.window().its("__posted").then((messages) => {
      expect(messages.at(-1)).to.deep.equal({
        type: "conversation.runtime",
        conversationId: "run-1",
        message: {
          type: "run.gate",
          action: "acceptParticipant",
          selectedParticipant: "worker",
          rationale: "Use the accessibility review as the release decision.",
        },
      });
    });
  });

  it("keeps notification settings in Notifications even when notifications are off", () => {
    cy.viewport(480, 800);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then((win) => {
      win.__managerState.notifications = { mode: "off", unread: 0, events: [] };
      win.__boot();
    });
    cy.get(".notification-center").should("exist");
    cy.get(".notification-center > summary").click();
    cy.get('.notification-center [data-action="notification-settings"]').click();
    cy.get("#notification-mode").select("decisions");
    cy.window().its("__posted").then((messages) => {
      expect(messages.at(-1)).to.deep.equal({ type: "notifications.setMode", mode: "decisions" });
    });
  });

  it("renders a resumed workflow as a quiet chronological marker between messages", () => {
    cy.viewport(480, 800);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then((win) => {
      win.__panelState.transcript = [
        { id: "before-resume", kind: "answer", agentId: "lead", text: "Work before the interruption", createdAt: "2026-09-13T00:00:00Z" },
        { id: "resume-marker", kind: "event", eventType: "workflow.resumed", text: "Legacy resume wording", data: { pipelineId: "custom-a", nextStepIndex: 1 }, createdAt: "2026-09-13T00:01:00Z" },
        { id: "after-resume", kind: "answer", agentId: "worker", text: "Work after the interruption", createdAt: "2026-09-13T00:02:00Z" },
      ];
      win.__panelState.transcriptTotal = 3;
      win.__boot();
    });
    cy.get('[data-entry="resume-marker"]')
      .should("have.class", "workflow-transition")
      .and("have.attr", "role", "separator")
      .and("have.attr", "aria-label", "Continued after interruption · from step 2")
      .and("not.contain.text", "Structured data")
      .within(() => {
        cy.get("details, time").should("not.exist");
      });
    cy.get('[data-entry="resume-marker"]').then(($marker) => {
      const markerStyle = $marker[0].ownerDocument.defaultView.getComputedStyle($marker[0]);
      const messageStyle = $marker[0].ownerDocument.defaultView.getComputedStyle($marker[0].previousElementSibling.querySelector(".message-text"));
      expect(parseFloat(markerStyle.fontSize)).to.be.at.most(parseFloat(messageStyle.fontSize));
      expect($marker[0].previousElementSibling.getAttribute("data-entry")).to.equal("before-resume");
      expect($marker[0].nextElementSibling.getAttribute("data-entry")).to.equal("after-resume");
    });
  });

  it("reaches specialized workflows with a real keyboard sequence", () => {
    cy.viewport(480, 800);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then((win) => {
      win.__panelState.pipelines.push({
        id: "specialized-z",
        name: "Zebra specialized review",
        editable: false,
        hash: "c".repeat(64),
        scopeKey: "builtin",
        pickerCategory: "specialized",
      });
      win.__boot();
    });
    cy.get("#pipeline-picker-button").focus();
    pressKey("ArrowDown", "ArrowDown", 40);
    cy.focused().should("have.id", "pipeline-picker-search").type("Zebra");
    cy.get('[data-pipeline-id="specialized-z"]').should("exist");
    pressKey("End", "End", 35);
    pressKey("Enter", "Enter", 13);
    cy.window().its("__posted").then((messages) => {
      expect(messages.at(-1).message).to.include({ type: "pipeline.select", pipelineId: "specialized-z" });
    });
  });

  it("offers minimap navigation and returns focus to the live edge", () => {
    cy.viewport(400, 600);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then(prepareDecision);
    cy.get(".chat-minimap button").should("have.length", 3);
    cy.get(".conversation-scroll").scrollTo("top", { ensureScrollable: false }).trigger("scroll");
    cy.get('[data-action="jump-latest"]').should("be.visible").click();
    cy.focused().should("have.id", "conversation-scroll");
    cy.get(".conversation-scroll").then(($content) => {
      const content = $content[0];
      expect(content.scrollHeight - content.scrollTop - content.clientHeight).to.be.lessThan(90);
    });
  });
});

describe("Pipeline-specific empty states", { browser: "chrome" }, () => {
  afterEach(() => emulateTheme("light"));
  it("ranks multi-participant write pipelines before review and single-participant pipelines", () => {
    cy.viewport(900, 900);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().then((win) => {
      win.__panelState.pipelines = [
        { id: "single-common", name: "Single common", editable: false, hash: "a".repeat(64), scopeKey: "builtin", pickerCategory: "common", prominentOrder: 0, participantCount: 1, writesCode: true },
        { id: "multi-review", name: "Multi review", editable: false, hash: "b".repeat(64), scopeKey: "builtin", pickerCategory: "common", prominentOrder: 1, participantCount: 2, writesCode: false },
        { id: "multi-write-common", name: "Multi write common", editable: false, hash: "c".repeat(64), scopeKey: "builtin", pickerCategory: "common", prominentOrder: 2, participantCount: 2, writesCode: true },
        { id: "multi-write-specialized", name: "Multi write specialized", editable: false, hash: "d".repeat(64), scopeKey: "builtin", pickerCategory: "specialized", participantCount: 3, writesCode: true },
        { id: "single-specialized", name: "Single specialized", editable: false, hash: "e".repeat(64), scopeKey: "builtin", pickerCategory: "specialized", participantCount: 1, writesCode: false },
        { id: "multi-write-custom", name: "Multi write custom", editable: true, hash: "f".repeat(64), scopeKey: "workspace:/workspace", pickerCategory: "custom", participantCount: 2, writesCode: true },
      ];
      win.__panelState.selectedPipelineId = "multi-write-common";
      win.__boot();
    });
    cy.get("#pipeline-picker-button").click();
    cy.get('[data-action="pipeline-picker-filter"][data-pipeline-filter="all"]').click();
    cy.get('[data-action="pipeline-picker-select"]').then((options) => {
      expect([...options].map((option) => option.getAttribute("data-pipeline-id"))).to.deep.equal([
        "multi-write-common",
        "multi-write-specialized",
        "multi-write-custom",
        "multi-review",
        "single-common",
        "single-specialized",
      ]);
    });
  });
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 480, 900]) {
      it(`keeps the selected pipeline splash and prompt usable in ${theme} at ${String(width)}px`, () => {
        cy.viewport(width, 900);
        cy.visit("tests/fixtures/webview-layout/index.html");
        cy.wrap(null).then(() => emulateTheme(theme));
        cy.window().then((win) => {
          win.__panelState.pipelines = [
            {
              id: "review-splash",
              name: "Review the change",
              description: "Find correctness, regression, and test coverage risks.",
              editable: false,
              hash: "a".repeat(64),
              scopeKey: "builtin",
              pickerCategory: "common",
              prominentOrder: 0,
              participantCount: 2,
              stepCount: 3,
              presentation: { promptPlaceholder: "Review this candidate before release…", icon: "search" },
            },
            {
              id: "plan-splash",
              name: "Plan the work",
              description: "Produce a bounded implementation plan without editing files.",
              editable: false,
              hash: "b".repeat(64),
              scopeKey: "builtin",
              pickerCategory: "common",
              prominentOrder: 1,
              participantCount: 1,
              stepCount: 1,
              presentation: { promptPlaceholder: "Plan this implementation…", icon: "lightbulb" },
            },
          ];
          win.__panelState.selectedPipelineId = "review-splash";
          win.__managerState.eventsByConversation = {
            "run-1": [{ id: 1, type: "pipeline.selected", status: "idle", title: "Pipeline selected", createdAt: "2026-09-15T00:00:00Z" }],
          };
          win.__boot();
        });
        cy.get('.pipeline-intro[data-intro-pipeline-id="review-splash"]')
          .should("be.visible")
          .and("contain.text", "Review the change")
          .and("contain.text", "3 steps · 2 participants");
        cy.get("#composer-prompt").should("have.attr", "placeholder", "Review this candidate before release…");
        cy.get("#pipeline-picker-button").click();
        cy.get('[data-action="pipeline-picker-select"][data-pipeline-id="plan-splash"]').click();
        cy.get('.pipeline-intro[data-intro-pipeline-id="plan-splash"]')
          .should("be.visible")
          .and("contain.text", "Plan the work")
          .and("contain.text", "1 step · 1 participant");
        cy.get("#composer-prompt").should("have.attr", "placeholder", "Plan this implementation…");
        cy.document().then((doc) => {
          expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1);
        });
        cy.screenshot(`pipeline-splash-${theme}-${String(width)}`);
      });
    }
  }
});


describe("Result release regression coverage", { browser: "chrome" }, () => {
  const themeColors = require("../fixtures/webview-layout/theme-colors.json");
  const fixture = "tests/fixtures/webview-layout/index.html";
  const recordedAt = "2026-09-14T10:00:00.000Z";
  const stepNames = ["Plan the repair", "Implement and verify the behavior", "Review the implementation"];
  const copyMarkdown = "# Run result\n\n## Final assessment\nThe lead will review the result before implementation.\n\n## Final ruling\nKeep the review evidence readable.\n\n## Findings\n- Confirm the action in src/webview-ui/executionRender.ts.\n\n## Unresolved risks\nThe review still needs confirmation.";
  const longOutput = [
    "Participant assessment before the recorded examples.",
    "```json",
    JSON.stringify(Array.from({ length: 130 }, (_, index) => ({ index, evidence: "readable participant evidence ".repeat(12) })), null, 2),
    "```",
    ...Array.from({ length: 55 }, (_, index) => `Paragraph ${index + 1}: preserve the recorded conclusion and its evidence.`),
    "```typescript",
    ...Array.from({ length: 130 }, (_, index) => `const evidence${index} = "${"recorded content ".repeat(20)}";`),
    "```",
  ].join("\n\n");

  const debuggerCommand = (command, params) =>
    Cypress.automation("remote:debugger:protocol", { command, params });

  const pressEnter = () => cy.then(async () => {
    await debuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await debuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  });

  const boot = (outcome = "inconclusive", theme = "light", font = 13) => {
    cy.visit(fixture);
    cy.window().its("__bootExecution").should("be.a", "function");
    cy.then(() => debuggerCommand("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" },
        { name: "forced-colors", value: theme === "high-contrast" ? "active" : "none" },
      ],
    }));
    cy.window().then((win) => {
      for (const [key, value] of Object.entries(themeColors[theme === "light" ? "light" : "dark"])) {
        win.document.documentElement.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
      }
      win.document.documentElement.style.setProperty("--vscode-font-size", `${font}px`);
      const panel = win.__executionPanelState;
      const manager = win.__executionManagerState;
      const status = outcome === "failed" ? "error" : outcome === "interrupted" ? "interrupted" : "completed";
      panel.workflowStatus = status;
      panel.running = false;
      delete panel.resumableWorkflow;
      panel.selectedPipelineDefinition.steps = ["plan", "implement", "review"].map((id, index) => ({
        id,
        name: stepNames[index],
        enabled: true,
        humanGate: "none",
        type: "agent",
        participants: ["lead"],
        promptTemplate: "{{userPrompt}}",
        parallel: false,
        consensus: false,
        attachments: "selected",
      }));
      panel.transcript = [
        { id: "plan-answer", kind: "answer", stepId: "plan", step: stepNames[1], text: longOutput },
        { id: "worker-answer", kind: "answer", step: stepNames[1], text: "The implementation has an explicit recorded step name." },
        { id: "worker-interruption", kind: "interrupted", stepId: "implement", text: "The participant stopped at the user's request." },
        { id: "worker-error", kind: "error", stepId: "implement", text: "The provider refused the follow-up request." },
        { id: "unrelated-output", kind: "answer", text: "UNRELATED_OUTPUT_MUST_STAY_IN_CHAT" },
        { id: "unknown-step-output", kind: "answer", stepId: "removed-step", step: stepNames[0], text: "UNKNOWN_STEP_MUST_STAY_IN_CHAT" },
        { id: "internal-prompt", kind: "prompt", stepId: "plan", eventType: "agent.prompt", text: "INTERNAL_PROMPT_MUST_STAY_OUT" },
        { id: "bookkeeping", kind: "event", stepId: "plan", eventType: "output.validated", text: "BOOKKEEPING_MUST_STAY_OUT" },
      ].map((entry) => ({ ...entry, agentId: "lead", createdAt: recordedAt }));
      panel.transcriptTotal = panel.transcript.length;
      panel.transcriptHasMore = false;
      manager.conversations[0].workflowStatus = status;
      manager.conversations[0].running = false;
      manager.eventsByConversation["run-1"] = [
        { id: 1, type: "run.started", createdAt: recordedAt },
        { id: 2, type: "step.started", stepId: "plan", createdAt: recordedAt },
        { id: 3, type: "step.started", stepId: "implement", createdAt: recordedAt },
        { id: 4, type: outcome === "failed" ? "run.failed" : outcome === "interrupted" ? "run.interrupted" : "run.completed", createdAt: recordedAt },
      ];
      const needsConfirmation = outcome === "inconclusive" || outcome === "evidence-gap";
      manager.resultsByConversation["run-1"] = {
        status,
        changedFiles: ["src/webview-ui/executionRender.ts", "src/webview-ui/style.css"],
        checks: [{ command: "npm run check-types", status: "passed" }],
        findings: ["accepted", "accepted", outcome === "inconclusive" ? "unresolved" : "rejected"].map((disposition, index) => ({
          id: `finding-${index}`,
          subject: `Finding ${index + 1}: preserve a readable document hierarchy`,
          message: "The result must retain useful assessment, evidence, and readable action labels.",
          disposition,
          location: { file: "src/webview-ui/executionRender.ts", startLine: 100 + index },
          evidence: ["The recorded participant output describes the observed behavior."],
          challenges: ["Confirm the remaining uncertainty before editing."],
          provenance: { source: "stepOutput", stepId: "plan", participantIds: ["lead"] },
        })),
        finalAssessment: {
          outcome: outcome === "failed" ? "failedBeforeRuling" : needsConfirmation ? "inconclusive" : "completed",
          method: "singleProvider",
          summary: "The assessment keeps the implementation and verification states distinct.",
          producedBy: [],
          ...(outcome === "failed" ? { failure: { error: "The provider refused the follow-up request.", participant: "Lead", step: stepNames[1] } } : {}),
        },
        ...(outcome === "failed" ? {} : { finalDecision: {
          stepId: "plan",
          status: needsConfirmation ? "resolved" : "accepted",
          candidate: { summary: "Confirm unresolved evidence before implementation." },
          participants: [
            { agentId: "lead", valid: true, accepted: true, candidate: { summary: "The first participant conclusion." }, objections: [], unresolvedRisks: [] },
            { agentId: "builder", valid: true, accepted: false, candidate: { summary: "The second participant conclusion." }, objections: [], unresolvedRisks: [] },
          ],
          objections: [],
          unresolvedRisks: [],
        } }),
        unresolvedRisks: outcome === "inconclusive" ? ["The remaining finding still needs confirmation."] : [],
        evidenceGaps: needsConfirmation ? ["Native VS Code visual acceptance is outstanding."] : [],
        evidence: [{ kind: "verification", label: "Verification", state: needsConfirmation ? "missing" : "recorded", detail: "The verification state is explicit." }],
        recoveredErrors: [],
        readableMarkdown: copyMarkdown,
        continuation: needsConfirmation ? { available: false, reason: "No write-capable pipeline is available. Configure a pipeline with writable paths before starting implementation." } : { available: true, resultVersion: "displayed-result" },
      };
      win.__bootExecution();
    });
    cy.get('[data-action="room-view"][data-view="execution"]').click();
  };

  const expectContained = (element, container) => {
    const bounds = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    expect(rect.left).to.be.at.least(bounds.left - 1);
    expect(rect.right).to.be.at.most(bounds.right + 1);
  };

  const expectNoRail = (element) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    expect(parseFloat(style.borderInlineStartWidth)).to.equal(0);
    expect(parseFloat(style.borderInlineEndWidth)).to.equal(0);
  };

  const openStep = (id) => cy.get(`[data-disclosure-key="run-1:pipeline-step:${id}"]`).then(($details) => {
    if (!$details[0].open) cy.wrap($details).find("summary").click();
  });

  describe("Execution result document hierarchy", { browser: "chrome" }, () => {
    for (const theme of ["light", "dark", "high-contrast"]) {
      for (const width of [320, 400, 480, 700, 1280]) {
        it(`keeps the complete expanded hierarchy readable in ${theme} at ${width}px`, () => {
          cy.viewport(width, 900);
          boot("inconclusive", theme, width === 480 ? 18 : 13);
          openStep("plan");
          openStep("implement");
          cy.get('[data-disclosure-key="run-1:result-evidence:run-1"] > summary').click();
          cy.get(".execution-content").should(($execution) => {
            const execution = $execution[0];
            expect(execution.scrollWidth).to.be.at.most(execution.clientWidth + 1);
            for (const element of execution.querySelectorAll(".result-center, .pipeline-summary, .ruling-result, .result-finding-list > li, .compare-column, .pipeline-step-message")) {
              expectNoRail(element);
              expectContained(element, execution);
            }
            const result = execution.querySelector(".result-center").getBoundingClientRect();
            const pipeline = execution.querySelector(".pipeline-summary").getBoundingClientRect();
            expect(Math.abs(result.left - pipeline.left)).to.be.lessThan(1);
            expect(Math.abs(result.right - pipeline.right)).to.be.lessThan(1);
            for (const group of execution.querySelectorAll(".result-findings-unresolved, .final-ruling-unresolved, .result-evidence-missing")) {
              expect(parseFloat(group.ownerDocument.defaultView.getComputedStyle(group).borderInlineStartWidth)).to.equal(3);
            }
            const actions = execution.querySelector(".result-primary-actions");
            for (const button of actions.querySelectorAll("button")) {
              if (button.getBoundingClientRect().height === 0) continue;
              expectContained(button, actions);
              expect(button.scrollWidth).to.be.at.most(button.clientWidth + 1);
            }
            const rows = [...execution.querySelectorAll(".finding-accepted")];
            expect(rows).to.have.length(2);
            expect(Math.abs(rows[0].getBoundingClientRect().left - rows[1].getBoundingClientRect().left)).to.be.lessThan(1);
            for (const row of rows) expect(row.textContent).to.contain("Evidence").and.contain("Challenges");
            const step = execution.querySelector('[data-disclosure-key="run-1:pipeline-step:implement"]');
            if (width <= 480) {
              const name = step.querySelector(".pipeline-step-name").getBoundingClientRect();
              const status = step.querySelector(".pipeline-step-state").getBoundingClientRect();
              expect(status.top).to.be.at.least(name.bottom);
            }
          });
          cy.get('[data-action="result-continue"]').should("have.attr", "aria-disabled", "true").and("have.attr", "aria-describedby");
          cy.get(".result-continuation-tooltip").should("contain.text", "No write-capable pipeline is available");
          cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1));
        });
      }
    }

    it("uses authoritative steps and sends every response kind to the exact Chat message", () => {
      cy.viewport(400, 900);
      boot("completed");
      openStep("plan");
      openStep("implement");
      cy.get('[data-disclosure-key="run-1:pipeline-step:plan"] .pipeline-step-message').should("have.length", 1);
      cy.get('[data-disclosure-key="run-1:pipeline-step:implement"] .pipeline-step-message').should("have.length", 3);
      cy.get(".pipeline-summary").should("not.contain.text", "UNRELATED_OUTPUT_MUST_STAY_IN_CHAT").and("not.contain.text", "UNKNOWN_STEP_MUST_STAY_IN_CHAT").and("not.contain.text", "INTERNAL_PROMPT_MUST_STAY_OUT").and("not.contain.text", "BOOKKEEPING_MUST_STAY_OUT");
      for (const [id, label] of [["plan-answer", "Response"], ["worker-answer", "Response"], ["worker-interruption", "Interrupted"], ["worker-error", "Error"]]) {
        cy.get(`[data-message-id="${id}"]`).closest(".pipeline-step-message").find('[data-output-scroll]').should("have.attr", "aria-label", `Lead: ${label}`).and("have.attr", "tabindex", "0");
        cy.get(`[data-message-id="${id}"]`).focus();
        pressEnter();
        cy.get(`[data-entry="${id}"]`).should("be.focused");
        cy.get('[data-action="room-view"][data-view="execution"]').click();
      }
    });

    it("copies the complete readable result while preserving ordinary lead and review prose", () => {
      cy.viewport(320, 900);
      boot("completed");
      cy.window().then((win) => {
        Object.defineProperty(win.navigator, "clipboard", {
          configurable: true,
          value: { writeText: cy.stub().resolves().as("resultClipboard") },
        });
        win.__posted.length = 0;
      });
      cy.get('[data-action="result-copy"]').focus();
      pressEnter();
      cy.get("@resultClipboard").should("have.been.calledOnceWithExactly", copyMarkdown);
      cy.get("#bachata-live-status").should("contain.text", "copied to the clipboard");
      cy.window().then((win) => expect(win.__posted).to.deep.equal([]));
    });

    it("reports clipboard refusal without claiming a copy or starting continuation", () => {
      cy.viewport(320, 900);
      boot("completed");
      cy.window().then((win) => {
        Object.defineProperty(win.navigator, "clipboard", {
          configurable: true,
          value: { writeText: cy.stub().rejects(new Error("Clipboard permission denied")).as("refusedResultClipboard") },
        });
        win.__posted.length = 0;
      });
      cy.get('[data-action="result-copy"]').click();
      cy.get("@refusedResultClipboard").should("have.been.calledOnceWithExactly", copyMarkdown);
      cy.get("#bachata-live-status").should("contain.text", "Copying the run result failed.").and("not.contain.text", "copied to the clipboard");
      cy.get('[data-action="result-copy"]').should("have.text", "Copy result");
      cy.window().then((win) => expect(win.__posted).to.deep.equal([]));
    });

    it("dispatches continuation for the displayed result without submitting or starting execution", () => {
      cy.viewport(400, 900);
      boot("completed");
      cy.window().then((win) => { win.__posted.length = 0; });
      cy.get('[data-action="result-continue"]').should("not.have.attr", "aria-disabled").and("not.be.disabled").focus();
      pressEnter();
      cy.window().should((win) => {
        expect(win.__posted).to.deep.equal([{
          type: "conversation.continueFromResult",
          conversationId: "run-1",
          resultVersion: "displayed-result",
        }]);
        expect(win.__posted.some((message) => ["user.message", "message.send", "pipeline.run", "workflow.start", "workflow.restart", "workflow.resume", "orchestration.start"].includes(message.message?.type ?? message.type))).to.equal(false);
      });
    });

    it("retains disclosure, keyboard focus, and both inner code scroll axes across snapshots", () => {
      cy.viewport(400, 900);
      boot("completed");
      cy.get('[data-disclosure-key="run-1:pipeline-step:plan"] > summary').focus();
      pressEnter();
      cy.get('[data-disclosure-key="run-1:pipeline-step:plan"]').should("have.prop", "open", true);
      cy.get('[data-disclosure-key="run-1:pipeline-step:plan"] > summary').should(($summary) => {
        const style = $summary[0].ownerDocument.defaultView.getComputedStyle($summary[0]);
        expect(parseFloat(style.outlineWidth)).to.equal(2);
        expect(style.outlineStyle).to.equal("solid");
      });
      const surface = '[data-code-scroll-surface="pipeline:plan:plan-answer"]';
      let positions;
      cy.get(surface).then(($surface) => {
        const body = $surface[0].querySelector('[data-output-scroll]');
        const blocks = [...body.querySelectorAll("pre[data-code-region]")];
        expect(blocks).to.have.length(2);
        for (const block of blocks) {
          expect(block.scrollHeight).to.be.greaterThan(block.clientHeight);
          expect(block.scrollWidth).to.be.greaterThan(block.clientWidth);
          block.scrollTop = 220;
          block.scrollLeft = 120;
        }
        body.scrollTop = 100;
        blocks[0].focus({ preventScroll: true });
        positions = { body: [body.scrollTop, body.scrollLeft], blocks: blocks.map((block) => [block.scrollTop, block.scrollLeft]) };
      });
      cy.window().then((win) => {
        win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) });
        win.__send({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: structuredClone(win.__executionPanelState) } });
      });
      cy.get('[data-disclosure-key="run-1:pipeline-step:plan"]').should("have.prop", "open", true);
      cy.get('[data-disclosure-key="run-1:pipeline-step:implement"]').should("have.prop", "open", false);
      cy.get(surface).should(($surface) => {
        const body = $surface[0].querySelector('[data-output-scroll]');
        const blocks = [...body.querySelectorAll("pre[data-code-region]")];
        expect([body.scrollTop, body.scrollLeft]).to.deep.equal(positions.body);
        expect(blocks.map((block) => [block.scrollTop, block.scrollLeft])).to.deep.equal(positions.blocks);
        expect(body.ownerDocument.activeElement).to.equal(blocks[0]);
      });
    });

    for (const outcome of ["failed", "interrupted"]) {
      it(`keeps the ${outcome} step boundary and status without nested response rails`, () => {
        cy.viewport(320, 900);
        boot(outcome, "dark");
        cy.get(`.pipeline-step-${outcome}`).should(($step) => {
          expect(parseFloat($step[0].ownerDocument.defaultView.getComputedStyle($step[0]).borderInlineStartWidth)).to.equal(3);
          expect($step[0].querySelector(".pipeline-step-state").textContent).to.contain(outcome === "failed" ? "Failed" : "Interrupted");
          for (const message of $step[0].querySelectorAll(".pipeline-step-message")) expectNoRail(message);
        });
        cy.get(".pipeline-step-message-error").should("contain.text", "Error");
        cy.get(".pipeline-step-message-interrupted").should("contain.text", "Interrupted");
        if (outcome === "failed") cy.get(".result-failure").should("contain.text", "The provider refused the follow-up request.");
      });
    }
  });


    it("keeps duplicate step names and previous attempts out of the current step's activity", () => {
      cy.viewport(400, 900);
      boot("completed");
      cy.window().then((win) => {
        const panel = win.__executionPanelState;
        const manager = win.__executionManagerState;
        const duplicateName = "Independent review";
        const currentAt = "2026-09-14T11:00:00.000Z";
        const identities = [{ id: "plan", name: duplicateName }, { id: "implement", name: duplicateName }, { id: "review", name: "Final verification" }];
        panel.selectedPipelineDefinition.steps = panel.selectedPipelineDefinition.steps.map((step) => ({ ...step, name: "Catalog name changed after execution" }));
        panel.transcript = [
          { id: "old-plan-answer", kind: "answer", stepId: "plan", text: "STALE_ATTEMPT_OUTPUT", createdAt: recordedAt },
          { id: "current-plan-answer", kind: "answer", stepId: "plan", step: "Final verification", text: "Current planning response", createdAt: currentAt },
          { id: "current-worker-answer", kind: "answer", stepId: "implement", step: duplicateName, text: "Current implementation response", createdAt: currentAt },
          { id: "ambiguous-name-answer", kind: "answer", step: duplicateName, text: "AMBIGUOUS_NAME_OUTPUT", createdAt: currentAt },
          { id: "name-fallback-answer", kind: "answer", step: "Final verification", text: "Unique recorded-name fallback", createdAt: currentAt },
          { id: "removed-step-answer", kind: "answer", stepId: "removed", step: "Final verification", text: "REMOVED_STEP_OUTPUT", createdAt: currentAt },
        ].map((entry) => ({ ...entry, agentId: "lead" }));
        panel.transcriptTotal = panel.transcript.length;
        manager.eventsByConversation["run-1"] = [
          { id: 1, type: "run.started", createdAt: recordedAt },
          { id: 2, type: "step.started", stepId: "plan", createdAt: recordedAt },
          { id: 3, type: "run.interrupted", createdAt: recordedAt },
          { id: 4, type: "run.restarted", createdAt: currentAt, attempt: { steps: identities } },
          { id: 5, type: "step.started", stepId: "plan", createdAt: currentAt },
          { id: 6, type: "step.started", stepId: "implement", createdAt: currentAt },
          { id: 7, type: "step.started", stepId: "review", createdAt: currentAt },
          { id: 8, type: "run.completed", createdAt: currentAt },
        ];
        win.__bootExecution();
      });
      for (const id of ["plan", "implement", "review"]) openStep(id);
      for (const [stepId, messageId, text] of [["plan", "current-plan-answer", "Current planning response"], ["implement", "current-worker-answer", "Current implementation response"], ["review", "name-fallback-answer", "Unique recorded-name fallback"]]) {
        cy.get(`[data-disclosure-key="run-1:pipeline-step:${stepId}"] .pipeline-step-message`).should("have.length", 1).and("contain.text", text).find(`[data-message-id="${messageId}"]`).should("exist");
      }
      cy.get(".pipeline-summary").should("not.contain.text", "STALE_ATTEMPT_OUTPUT").and("not.contain.text", "AMBIGUOUS_NAME_OUTPUT").and("not.contain.text", "REMOVED_STEP_OUTPUT").and("not.contain.text", "Catalog name changed after execution");
      cy.get('[data-message-id="current-worker-answer"]').focus();
      pressEnter();
      cy.get('[data-entry="current-worker-answer"]').should("be.focused").and("contain.text", "Current implementation response");
    });

    it("opens the manager-created continuation as an editable draft without submitting it", () => {
      cy.viewport(400, 900);
      boot("completed");
      const preparedDraft = "Implement the recorded review findings. Confirm unresolved findings before editing.\n\n## Final assessment\nThe lead can review the evidence before changing src/example.ts.\nKeep the normalized evidence readable.\uFFFD😀";
      cy.window().then((win) => { win.__posted.length = 0; });
      cy.get('[data-action="result-continue"]').focus();
      pressEnter();
      cy.window().then((win) => {
        expect(win.__posted).to.deep.equal([{ type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result" }]);
        const manager = structuredClone(win.__executionManagerState);
        manager.activeConversationId = "implementation-draft";
        manager.conversations.push({ ...manager.conversations[0], id: "implementation-draft", runRef: "implementation-draft", title: "Implement review findings", selectedPipelineId: "custom-b", workflowStatus: "idle", running: false, preparedDraft });
        const panel = { ...structuredClone(win.__executionPanelState), taskId: "implementation-draft", workflowStatus: "idle", running: false, operationActive: false, transcript: [], transcriptTotal: 0 };
        win.__send({ type: "manager.snapshot", state: manager });
        win.__send({ type: "conversation.message", conversationId: "implementation-draft", message: { type: "state.snapshot", state: panel } });
        win.__preparedDraftManager = manager;
      });
      cy.get("#composer-prompt").should("be.visible").and("not.be.disabled").and("not.have.attr", "readonly").and("have.value", preparedDraft).type("\nConfirm the remaining evidence first.");
      cy.get("#composer-prompt").should("have.value", `${preparedDraft}\nConfirm the remaining evidence first.`);
      cy.window().then((win) => {
        expect(win.__preparedDraftManager.conversations.find((conversation) => conversation.id === "implementation-draft").running).to.equal(false);
        expect(win.__posted.some((message) => ["user.message", "workflow.start", "workflow.restart", "workflow.resume", "orchestration.start"].includes(message.message?.type ?? message.type))).to.equal(false);
        win.__send({ type: "manager.snapshot", state: structuredClone(win.__preparedDraftManager) });
      });
      cy.get("#composer-prompt").should("have.value", `${preparedDraft}\nConfirm the remaining evidence first.`);
    });

    for (const theme of ["light", "dark", "high-contrast"]) {
      for (const width of [320, 400, 700, 1280]) {
        for (const outcome of ["completed", "failed", "interrupted", "evidence-gap"]) {
          it(`preserves ${outcome} status, gutters, readable type, and focus in ${theme} at ${width}px`, () => {
            cy.viewport(width, 900);
            boot(outcome, theme);
            cy.window().then((win) => {
              Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: cy.stub().resolves() } });
            });
            openStep("implement");
            cy.get('[data-disclosure-key="run-1:result-evidence:run-1"] > summary').click();
            cy.get(".execution-content").should(($execution) => {
              const execution = $execution[0];
              expect(execution.scrollWidth).to.be.at.most(execution.clientWidth + 1);
              const result = execution.querySelector(".result-center");
              const pipeline = execution.querySelector(".pipeline-summary");
              expect(result).not.to.equal(null);
              expect(pipeline).not.to.equal(null);
              expect(Math.abs(result.getBoundingClientRect().left - pipeline.getBoundingClientRect().left)).to.be.lessThan(1);
              expect(Math.abs(result.getBoundingClientRect().right - pipeline.getBoundingClientRect().right)).to.be.lessThan(1);
              for (const element of execution.querySelectorAll(".result-center, .ruling-result, .compare-column, .result-finding-list > li, .pipeline-summary, .pipeline-step-message")) {
                expectNoRail(element);
                expectContained(element, execution);
              }
              for (const element of execution.querySelectorAll("p, small, button, summary, .pipeline-step-name, .pipeline-step-state")) {
                if (!element.getClientRects().length) continue;
                const style = element.ownerDocument.defaultView.getComputedStyle(element);
                const size = parseFloat(style.fontSize);
                expect(size).to.be.at.least(element.matches("small, summary, .pipeline-step-state") ? 12 : 13);
                if (style.lineHeight !== "normal") expect(parseFloat(style.lineHeight)).to.be.at.least(size * 1.2);
              }
              expect(execution.querySelector(".result-assessment-status").textContent.trim()).not.to.equal("");
            });
            if (outcome === "failed") cy.get(".result-failure").should("be.visible").and("contain.text", "The provider refused the follow-up request.");
            if (outcome === "interrupted") cy.get(".pipeline-step-interrupted .pipeline-step-state").should("be.visible").and("contain.text", "Interrupted");
            if (outcome === "evidence-gap") {
              cy.get(".result-evidence-missing").should("be.visible").and("contain.text", "Verification");
              cy.get(".finding-unresolved").should("not.exist");
            }
            cy.get('[data-action="result-copy"]').focus();
            pressEnter();
            cy.get('[data-action="result-copy"]').should(($button) => {
              expect($button[0].ownerDocument.activeElement).to.equal($button[0]);
              const style = $button[0].ownerDocument.defaultView.getComputedStyle($button[0]);
              expect(parseFloat(style.outlineWidth)).to.be.at.least(2);
              expect(style.outlineStyle).not.to.equal("none");
            });
          });
        }
      }
    }
});

const {
  interactionThemes, interactionWidths, applyInteractionTheme, emulateInteractionTheme,
  interactionKey, pointerAt, pointerClick, tabToControl, controlVisual,
  expectControlFill, expectKeyboardRing, expectPointerFocus, expectSquareIcon, expectStationary, resolvedControlColor,
  expectPrimaryColors, expectPrimaryResponse, expectSemanticColors, expectSemanticResponse, expectFieldResponse, releasePointerAway,
} = require("./helpers/interactionStates.cjs");

const interactionFixture = (theme, execution = false) => {
  cy.visit("tests/fixtures/webview-layout/index.html");
  cy.window().its(execution ? "__bootExecution" : "__boot").should("be.a", "function");
  emulateInteractionTheme(theme);
  cy.window().then((win) => {
    applyInteractionTheme(win, theme);
    if (execution) win.__bootExecution();
    else win.__boot();
  });
};

const expectDisabledResponse = (selector) => {
  let before;
  cy.get(selector).then(($control) => {
    expect($control[0].matches(':disabled, [aria-disabled="true"]')).to.equal(true);
    $control[0].scrollIntoView({ block: "nearest", inline: "nearest" });
    before = controlVisual($control[0]);
    expect(before.color).to.equal(resolvedControlColor($control[0].ownerDocument, "--bachata-control-disabled", "color"));
    expect($control.css("cursor")).to.equal($control.attr("aria-busy") === "true" ? "progress" : "default");
  });
  pointerAt(selector);
  cy.get(selector).should(($control) => {
    const after = controlVisual($control[0]);
    expect(after.background).to.equal(before.background);
    expect(after.color).to.equal(before.color);
    expectStationary(before, after);
  });
  pointerAt(selector, "mousePressed");
  cy.get(selector).should(($control) => {
    const after = controlVisual($control[0]);
    expect(after.background).to.equal(before.background);
    expect(after.color).to.equal(before.color);
    expectStationary(before, after);
  });
  pointerAt(selector, "mouseReleased");
};

describe("shared interaction contract", { browser: "chrome" }, () => {
  afterEach(() => emulateInteractionTheme("light"));

  it("does not represent the pristine composer as a run tab", () => {
    cy.viewport(900, 900);
    cy.visit("tests/fixtures/webview-layout/index.html");
    cy.window().its("__bootPristine").should("be.a", "function");
    cy.window().then((win) => win.__bootPristine());
    cy.get(".run-tab").should("not.exist");
    cy.get("#composer-prompt").should("be.visible");
    cy.get('.run-tabs [data-action="create-conversation"]').should("be.visible");
    cy.get('[data-action="run-drawer-toggle"]').click();
    cy.get(".run-drawer-item").should("not.exist");
    cy.get(".run-drawer-list .empty-list").should("be.visible");
  });

  it("does not show a one-sided run view switcher before execution exists", () => {
    cy.viewport(900, 900);
    interactionFixture("light");
    cy.get(".run-tab.selected").should("exist");
    cy.get('.run-tab-tools [data-view="chat"], .run-tab-tools [data-view="execution"]').should("not.exist");
  });

  for (const theme of interactionThemes) {
    for (const width of interactionWidths) {
      it(`keeps navigation selection, hover, press, and keyboard focus independent in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme, true);
        const chat = '.run-tab-tools [data-view="chat"]';
        const execution = '.run-tab-tools [data-view="execution"]';
        cy.get(".run-tabs-brand, .run-tab-new, .run-tab-tool, #notification-button, #room-actions-button").each(($control) => expectSquareIcon($control[0]));
        let brandBefore;
        cy.get(".run-tabs-brand").should(($brand) => {
          expect($brand[0].tagName).to.equal("SPAN");
          expect($brand.attr("data-action")).to.equal(undefined);
          brandBefore = controlVisual($brand[0]);
        });
        pointerAt(".run-tabs-brand");
        cy.get(".run-tabs-brand").should(($brand) => expectStationary(brandBefore, controlVisual($brand[0])));
        pointerAt(execution);
        expectControlFill(execution, "hover");
        let before;
        cy.get(execution).then(($control) => { before = controlVisual($control[0]); });
        pointerAt(execution, "mousePressed");
        expectControlFill(execution, "pressed");
        cy.get(execution).should(($control) => expectStationary(before, controlVisual($control[0])));
        pointerAt(execution, "mouseReleased");
        cy.get(execution).should("have.attr", "aria-pressed", "true").and("not.have.class", "selected");
        cy.get(chat).should("have.attr", "aria-pressed", "false");
        expectControlFill(execution, "selected");
        expectPointerFocus(execution);
        cy.window().then((win) => win.__bootExecution());
        expectControlFill(execution, "selected");
        expectPointerFocus(execution);
        pointerClick(chat);
        expectControlFill(chat, "selected");
        expectPointerFocus(chat);
        cy.get(chat).should(($control) => {
          expect(controlVisual($control[0]).background).not.to.equal(controlVisual($control[0].closest(".run-tab")).background);
        });
        tabToControl(chat);
        expectKeyboardRing(chat);
        expectControlFill(chat, "selected");
        cy.screenshot(`interaction/navigation-${theme}-${width}`);
        pointerClick('[data-action="run-drawer-toggle"]');
        cy.get(".run-drawer").should("be.visible");
        cy.get('.run-drawer-select[aria-current="true"]').then(($row) => {
          expect(controlVisual($row[0]).shadow).not.to.contain("inset");
          expect(controlVisual($row[0].parentElement).borderWidths[3]).to.equal(controlVisual($row[0].parentElement).borderWidths[1]);
        });
        interactionKey("Escape", "Escape", 27);
        cy.get(".run-drawer").should("not.exist");
        cy.focused().should("have.class", "run-tab-all");
      });

      it(`shares menu and notification states and preserves dismissal in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme, true);
        for (const trigger of ["#room-actions-button", "#notification-button"]) {
          pointerClick(trigger);
          cy.get(trigger).parent().should("have.attr", "open");
          expectControlFill(trigger, "selected");
          expectPointerFocus(trigger);
          cy.window().then((win) => win.__bootExecution());
          cy.get(trigger).parent().should("have.attr", "open");
          expectControlFill(trigger, "selected");
          interactionKey("Escape", "Escape", 27);
          cy.get(trigger).parent().should("not.have.attr", "open");
          cy.focused().should("have.id", trigger.slice(1));
          pointerClick(trigger);
          pointerClick(".run-tabs-brand");
          cy.get(trigger).parent().should("not.have.attr", "open");
          pointerClick(trigger);
          pointerClick(trigger);
          cy.get(trigger).parent().should("not.have.attr", "open");
        }
        pointerClick("#room-actions-button");
        pointerClick("#notification-button");
        cy.get("#room-actions-button").parent().should("not.have.attr", "open");
        cy.get("#notification-button").parent().should("have.attr", "open");
        cy.get(".notification-unread").should("have.attr", "aria-hidden", "true");
        pointerAt('[data-action="notification-read-all"]');
        expectControlFill('[data-action="notification-read-all"]', "hover");
        tabToControl('[data-action="notification-read-all"]');
        expectKeyboardRing('[data-action="notification-read-all"]');
        cy.screenshot(`interaction/notifications-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
        pointerClick('.run-tab-tools [data-view="execution"]');
        pointerClick('.result-center > header .header-action-menu > summary');
        expectControlFill('.result-center > header .header-action-menu > summary', "selected");
        pointerAt('.result-center [data-action="workflow-restart"]');
        expectControlFill('.result-center [data-action="workflow-restart"]', "hover");
        expectSemanticResponse('.result-center [data-action="workflow-discard"]', "danger");
        cy.screenshot(`interaction/recovery-menu-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
      });

      it(`unifies composer, pickers, fields, and refusal states in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        cy.get('[data-action="attachment-pick"], .composer-settings-button, .icon-send').each(($control) => expectSquareIcon($control[0]));
        if (width <= 850) cy.get("#agents-picker-button").then(($control) => expectSquareIcon($control[0]));
        expectFieldResponse("#composer-prompt", ".composer-surface");
        pointerClick("#composer-prompt");
        expectPointerFocus("#composer-prompt");
        interactionKey("Tab", "Tab", 9);
        interactionKey("Tab", "Tab", 9, true);
        cy.get("#composer-prompt").should(($prompt) => expect(controlVisual($prompt[0]).outline).to.equal("none"));
        cy.get(".composer-surface").should(($surface) => {
          const visual = controlVisual($surface[0]);
          expect(visual.outline).to.equal("solid");
          expect(visual.outlineWidth).to.equal("2px");
          expect(visual.outlineColor).to.equal(resolvedControlColor($surface[0].ownerDocument, "--bachata-focus-ring", "color"));
          expect(visual.shadow).not.to.contain("inset");
        });
        pointerClick("#pipeline-picker-button");
        expectControlFill("#pipeline-picker-button", "selected");
        expectPointerFocus("#pipeline-picker-search");
        interactionKey("ArrowDown", "ArrowDown", 40);
        cy.get('[data-pipeline-id="custom-a"]').should("have.attr", "aria-selected", "true").and("have.attr", "data-active", "false");
        cy.get('[data-pipeline-id="custom-b"]').should("have.attr", "aria-selected", "false").and("have.attr", "data-active", "true");
        cy.get("#pipeline-picker-button").should(($button) => {
          const active = $button[0].ownerDocument.getElementById($button[0].getAttribute("aria-activedescendant"));
          expect(active.dataset.pipelineId).to.equal("custom-b");
          expect(controlVisual(active).outline).to.equal("none");
        });
        expectKeyboardRing("#pipeline-picker-search");
        expectControlFill('[data-pipeline-id="custom-b"]', "selected");
        cy.screenshot(`interaction/pipeline-picker-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
        pointerClick("#agents-picker-button");
        expectControlFill("#agents-picker-button", "selected");
        expectPointerFocus("#agents-picker-button");
        cy.get("#pipeline-picker-list").should("not.exist");
        cy.get('.agents-session-option[aria-selected="true"]').should("exist").and("not.have.class", "selected");
        expectControlFill('.agents-session-option[aria-selected="true"]', "selected");
        cy.get("#agents-effort-lead").should("be.visible").select("high");
        cy.window().its("__posted").then((messages) => {
          expect(messages.at(-1).message).to.deep.equal({
            type: "agents.effort.select",
            agentId: "lead",
            reasoningEffort: "high",
          });
        });
        cy.get(".agents-popover").should(($panel) => {
          const style = $panel[0].ownerDocument.defaultView.getComputedStyle($panel[0]);
          expect(style.overflowY).to.match(/auto|scroll/u);
          expect(parseFloat(style.maxHeight)).to.be.greaterThan(0);
        });
        tabToControl("#agents-provider-lead");
        expectKeyboardRing("#agents-provider-lead");
        cy.screenshot(`interaction/agents-picker-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
        cy.focused().should("have.id", "agents-picker-button");
        pointerClick('.composer-settings-button');
        expectControlFill('.composer-settings-button', "selected");
        expectFieldResponse("#pipeline-iterations");
        expectFieldResponse("#pipeline-iteration-mode");
        cy.get("#composer-settings").should(($panel) => {
          const style = $panel[0].ownerDocument.defaultView.getComputedStyle($panel[0]);
          expect(style.overflowY).to.match(/auto|scroll/u);
          expect(parseFloat(style.maxHeight)).to.be.greaterThan(0);
        });
        pointerClick('.composer-settings-button');
        cy.get("#composer-settings").should("not.exist");
        cy.get("#composer-prompt").type("Check primary Send colors");
        cy.get('.composer-send [data-action="submit-message"]').should("not.be.disabled").and("not.have.attr", "aria-disabled");
        expectPrimaryResponse('.composer-send [data-action="submit-message"]');
        cy.screenshot(`interaction/composer-primary-${theme}-${width}`);
        cy.window().then((win) => {
          win.__panelState.pipelineMutable = false;
          win.__panelState.workspaceRoots = ["/workspace", "/other"];
          delete win.__panelState.workingDirectory;
          win.__boot();
        });
        let refusedMessageCount;
        cy.window().then((win) => { refusedMessageCount = win.__posted.length; });
        cy.get("#pipeline-picker-button").should("be.disabled");
        expectDisabledResponse("#pipeline-picker-button");
        cy.get("#pipeline-picker-list").should("not.exist");
        const send = '.composer-send [data-action="submit-message"]';
        cy.get(send).should("have.attr", "aria-disabled", "true").and("not.be.disabled");
        expectDisabledResponse(send);
        cy.get(".app-dialog").should("be.visible");
        cy.window().its("__posted").then((messages) => expect(messages).to.have.length(refusedMessageCount));
        cy.screenshot(`interaction/refusal-dialog-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
        tabToControl(send);
        expectKeyboardRing(send);
        cy.screenshot(`interaction/composer-disabled-${theme}-${width}`);
        cy.window().then((win) => {
          win.__managerState.interactions = [{
            interactionRef: "permission-1",
            conversationId: "run-1",
            runRef: "run-1",
            kind: "permission",
            title: "Permission requested by Builder",
            prompt: 'Tool: Edit Input: {"file_path":"src/webview-ui/style.css","old_string":"long internal payload","replace_all":false}',
            options: [{ id: "allow", label: "Allow" }, { id: "reject", label: "Deny" }],
            allowFreeText: false,
            secret: false,
            selected: [],
            freeText: "",
            status: "pending",
            createdAt: "2026-09-15T00:00:00.000Z",
          }];
          win.__boot();
        });
        cy.get(".interaction-permission").should("be.visible").and("contain.text", "Edit Input");
        cy.get(".interaction-details").should("not.have.attr", "open").find("pre").should("not.be.visible");
        cy.get(".interaction-permission .interaction-option").should("have.length", 2);
        pointerClick(".interaction-details > summary");
        cy.get(".interaction-details").should("have.attr", "open").find("pre").should("be.visible").and("contain.text", "src/webview-ui/style.css");
        cy.screenshot(`interaction/permission-card-${theme}-${width}`);
      });

      it(`shares editor mode, disclosure, reorder, native selection, and footer states in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        pointerClick('.composer-settings-button');
        pointerClick('[data-action="pipeline-edit"]');
        cy.get(".pipeline-editor").should("be.visible");
        cy.get('.pipeline-editor > header [data-action="pipeline-editor-close"]').then(($control) => expectSquareIcon($control[0]));
        expectPrimaryResponse('[data-action="pipeline-save"]');
        const json = '[data-action="editor-mode"][data-mode="json"]';
        const form = '[data-action="editor-mode"][data-mode="form"]';
        pointerClick(json);
        expectControlFill(json, "selected");
        expectPointerFocus(json);
        pointerClick(form);
        expectControlFill(form, "selected");
        tabToControl(form);
        expectKeyboardRing(form);
        cy.get('.editor-section[data-editor-section="agents"]').then(($section) => { if (!$section[0].open) cy.wrap($section).children("summary").click(); });
        cy.get('.editor-card[data-drag-kind="agent"]').first().as("editorCard");
        cy.get("@editorCard").then(($card) => { if (!$card[0].open) cy.wrap($card).children("summary").click(); });
        cy.get("@editorCard").should("have.attr", "open");
        cy.get("@editorCard").children("summary").should(($summary) => expect(controlVisual($summary[0]).shadow).not.to.contain("inset"));
        cy.get('[data-action="editor-agent-up"]').first().should("be.disabled").then(($control) => expectSquareIcon($control[0]));
        cy.get('[data-editor-agent="0"][data-field="name"]').should("be.visible");
        expectFieldResponse('[data-editor-agent="0"][data-field="name"]');
        tabToControl('[data-editor-agent="0"][data-field="name"]');
        expectKeyboardRing('[data-editor-agent="0"][data-field="name"]');
        cy.get('.editor-card[data-drag-kind="step"]').first().then(($card) => { if (!$card[0].open) cy.wrap($card).children("summary").click(); });
        cy.get('.pipeline-editor input[type="checkbox"][data-field="participants"]').first().should("be.checked").focus().should("be.focused");
        interactionKey("Tab", "Tab", 9);
        cy.focused().should(($control) => expect($control[0].closest(".pipeline-editor")).not.to.equal(null));
        cy.screenshot(`interaction/editor-${theme}-${width}`);
        pointerClick('.pipeline-editor > footer .header-action-menu > summary');
        expectControlFill('.pipeline-editor > footer .header-action-menu > summary', "selected");
        pointerAt('[data-action="pipeline-export"]');
        expectControlFill('[data-action="pipeline-export"]', "hover");
        cy.screenshot(`interaction/editor-tools-${theme}-${width}`);
        interactionKey("Escape", "Escape", 27);
        cy.get('.pipeline-editor > footer .header-action-menu').should("not.have.attr", "open");
        cy.get('.pipeline-editor > header [data-action="pipeline-editor-close"]').click();
        cy.get(".pipeline-editor").should("not.exist");
      });
    }
  }
});


describe("content and native control interaction states", { browser: "chrome" }, () => {
  afterEach(() => emulateInteractionTheme("light"));

  for (const theme of interactionThemes) {
    for (const width of interactionWidths) {
      it(`keeps minimap, Latest, inspector, and Direction states consistent in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        cy.window().then((win) => {
          win.__panelState.transcript = Array.from({ length: 16 }, (_, index) => ({
            id: `interaction-turn-${index}`, kind: index % 2 === 0 ? "prompt" : "answer",
            ...(index % 2 === 0 ? { eventType: "user.message" } : { agentId: "lead" }),
            text: `Turn ${index + 1}. `.repeat(80), createdAt: "2026-09-14T00:00:00.000Z",
          }));
          win.__panelState.transcriptTotal = 16;
          win.__boot();
        });
        cy.get('.chat-minimap [aria-current="true"]').should("have.length", 1);
        expectControlFill('.chat-minimap [aria-current="true"]', "selected");
        pointerClick('.chat-minimap [data-message-id="interaction-turn-0"]');
        cy.get('.chat-minimap [data-message-id="interaction-turn-0"]').should("have.attr", "aria-current", "true");
        expectControlFill('.chat-minimap [data-message-id="interaction-turn-0"]', "selected");
        cy.get('[data-action="jump-latest"]').should("be.visible");
        pointerAt('[data-action="jump-latest"]');
        expectControlFill('[data-action="jump-latest"]', "hover");
        pointerClick('[data-action="jump-latest"]');
        cy.focused().should("have.id", "conversation-scroll");
        expectPointerFocus("#conversation-scroll");
        pointerClick("#room-actions-button");
        pointerClick('.header-action-menu [data-action="inspector-toggle"]');
        cy.get(".inspector").should("be.visible");
        cy.get('.inspector-header [data-action="inspector-toggle"]').then(($control) => expectSquareIcon($control[0]));
        cy.get('.header-action-menu [data-action="inspector-toggle"]').should("have.attr", "aria-expanded", "true");
        cy.screenshot(`interaction/content-inspector-${theme}-${width}`);
        pointerClick('.inspector-header [data-action="inspector-toggle"]');
        cy.get(".inspector").should("not.exist");
        pointerClick('.run-tab-all');
        pointerClick('.run-drawer-direction');
        cy.get(".run-tab-all").should("have.attr", "aria-current", "page");
        expectControlFill(".run-tab-all", "selected");
        expectPointerFocus(".run-tab-all");
        cy.get('.direction-secondary-toggle').first().then(($control) => {
          const selector = `[data-action="direction-section-toggle"][data-section="${$control[0].dataset.section}"]`;
          const wasOpen = $control[0].getAttribute("aria-expanded") === "true";
          pointerClick(selector);
          cy.get(selector).should("have.attr", "aria-expanded", String(!wasOpen));
          if (!wasOpen) expectControlFill(selector, "selected");
          expectPointerFocus(selector);
          tabToControl(selector);
          expectKeyboardRing(selector);
        });
        cy.screenshot(`interaction/direction-${theme}-${width}`);
      });

      it(`uses the same states for native and ARIA selection primitives in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        cy.document().then((doc) => {
          const fixture = doc.createElement("main");
          fixture.style.padding = "16px";
          fixture.innerHTML = `
            <h1>Native control contract fixture</h1>
            <label class="field"><span>Multiple selection</span><select id="contract-multiple" multiple size="3"><option value="one" selected>One</option><option value="two">Two</option><option value="disabled" disabled>Unavailable</option></select></label>
            <label class="check-field"><input id="contract-checkbox" type="checkbox">Checkbox</label>
            <label class="check-field"><input id="contract-radio-one" name="contract-radio" type="radio" checked>Radio one</label>
            <label class="check-field"><input id="contract-radio-two" name="contract-radio" type="radio">Radio two</label>
            <div role="listbox" aria-label="Options"><button id="contract-option" role="option" aria-selected="true">Selected option</button></div>
            <div role="radiogroup" aria-label="Provider choices"><button id="contract-radio-role" class="agents-choice" role="radio" aria-checked="true">Selected provider</button></div>
            <button id="contract-disabled" disabled>Unavailable action</button>
            <button id="contract-busy" disabled aria-busy="true">Pending action</button>
            <details id="contract-disclosure"><summary>Disclosure</summary><p>Disclosure content</p></details>`;
          doc.getElementById("root").replaceChildren(fixture);
        });
        cy.get("#contract-multiple").select(["one", "two"]);
        cy.get("#contract-multiple option:checked").should("have.length", 2);
        expectControlFill("#contract-multiple option:checked", "selected");
        tabToControl("#contract-multiple");
        expectKeyboardRing("#contract-multiple");
        pointerClick("#contract-checkbox");
        cy.get("#contract-checkbox").should("be.checked");
        expectPointerFocus("#contract-checkbox");
        tabToControl("#contract-radio-one");
        interactionKey("ArrowRight", "ArrowRight", 39);
        cy.get("#contract-radio-two").should("be.checked").and("be.focused");
        expectKeyboardRing("#contract-radio-two");
        expectControlFill("#contract-option", "selected");
        expectControlFill("#contract-radio-role", "selected");
        expectDisabledResponse("#contract-disabled");
        expectDisabledResponse("#contract-busy");
        cy.get("#contract-busy").should("have.css", "cursor", "progress");
        pointerClick("#contract-disclosure > summary");
        expectControlFill("#contract-disclosure > summary", "selected");
        expectPointerFocus("#contract-disclosure > summary");
        cy.screenshot(`interaction/native-primitives-${theme}-${width}`);
      });

      it(`preserves neutral, primary, semantic, and editable control families in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        cy.get(".composer-surface").should("be.visible");
        cy.document().then((doc) => {
          const fixture = doc.createElement("main");
          Object.assign(fixture.style, { padding: "16px", display: "grid", gap: "8px", maxHeight: "100%", overflow: "auto" });
          fixture.innerHTML = `
            <h1>Control family fixture</h1>
            <button id="family-neutral" data-contract-toggle aria-pressed="false">Neutral toggle</button>
            <button id="family-primary" class="primary" data-contract-toggle aria-pressed="false">Primary action</button>
            <button id="family-send" class="icon-button send-button" data-contract-toggle aria-pressed="false" aria-label="Send" title="Send">↑</button>
            <button id="family-danger" class="danger" data-contract-toggle aria-pressed="false">Destructive action</button>
            <button id="family-caution" class="caution" data-contract-toggle aria-pressed="false">Caution action</button>
            <label>Text<input id="family-input" value="Field text"></label>
            <label>Number<input id="family-number" type="number" value="2"></label>
            <label>Multiline<textarea id="family-textarea">Field text</textarea></label>
            <label>Choice<select id="family-select"><option selected>One</option><option>Two</option></select></label>
            <button id="family-primary-disabled" class="primary" disabled>Unavailable primary action</button>
            <button id="family-send-disabled" class="icon-button send-button" disabled aria-label="Unavailable Send" title="Unavailable Send">↑</button>
            <button id="family-danger-disabled" class="danger" disabled>Unavailable destructive action</button>
            <button id="family-caution-disabled" class="caution" disabled>Unavailable caution action</button>
            <label>Unavailable text<input id="family-field-disabled" disabled value="Unchanged"></label>
            <label>Unavailable choice<select id="family-select-disabled" disabled><option>Unchanged</option></select></label>`;
          fixture.addEventListener("click", (event) => {
            const control = event.target.closest("[data-contract-toggle]");
            if (control) control.setAttribute("aria-pressed", String(control.getAttribute("aria-pressed") !== "true"));
          });
          doc.getElementById("root").replaceChildren(fixture);
        });
        pointerAt("#family-neutral");
        expectControlFill("#family-neutral", "hover");
        pointerAt("#family-neutral", "mousePressed");
        expectControlFill("#family-neutral", "pressed");
        pointerAt("#family-neutral", "mouseReleased");
        expectControlFill("#family-neutral", "selected");
        expectPointerFocus("#family-neutral");
        tabToControl("#family-neutral");
        expectKeyboardRing("#family-neutral");
        for (const selector of ["#family-primary", "#family-send"]) {
          expectPrimaryResponse(selector);
          pointerClick(selector);
          cy.get(selector).should("have.attr", "aria-pressed", "true");
          expectPrimaryColors(selector, "selected");
          expectPointerFocus(selector);
          tabToControl(selector);
          expectKeyboardRing(selector);
          expectPrimaryColors(selector, "selected");
          cy.screenshot(`interaction/${selector.slice(1)}-${theme}-${width}`);
        }
        for (const family of ["danger", "caution"]) {
          const selector = `#family-${family}`;
          expectSemanticResponse(selector, family);
          pointerClick(selector);
          expectSemanticColors(selector, family, "selected");
          expectPointerFocus(selector);
          tabToControl(selector);
          expectKeyboardRing(selector);
          expectSemanticColors(selector, family, "selected");
          cy.screenshot(`interaction/family-${family}-${theme}-${width}`);
        }
        for (const selector of ["#family-input", "#family-number", "#family-textarea", "#family-select"]) expectFieldResponse(selector);
        for (const selector of ["#family-primary-disabled", "#family-send-disabled", "#family-danger-disabled", "#family-caution-disabled", "#family-field-disabled", "#family-select-disabled"]) expectDisabledResponse(selector);
        cy.get("#family-field-disabled").should("have.value", "Unchanged");
        cy.get("#family-select-disabled").should("have.value", "Unchanged");
        cy.get("#family-send, #family-send-disabled").each(($control) => expectSquareIcon($control[0]));
        cy.screenshot(`interaction/family-fields-disabled-${theme}-${width}`);
      });

      it(`makes primary and neutral Stop controls inert while interruption is busy in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        interactionFixture(theme);
        cy.window().then((win) => {
          Object.assign(win.__panelState, { running: true, operationActive: true, workflowStatus: "running" });
          Object.assign(win.__managerState.conversations[0], { running: true, workflowStatus: "running" });
          win.__boot();
        });
        const primaryStop = '.composer-send [data-action="interrupt-run"]';
        const neutralStop = '.run-tab-tools [data-action="interrupt-run"]';
        cy.get(primaryStop).should("not.be.disabled").and("not.have.attr", "aria-busy");
        expectPrimaryResponse(primaryStop);
        pointerAt(neutralStop);
        expectControlFill(neutralStop, "hover");
        pointerAt(neutralStop, "mousePressed");
        expectControlFill(neutralStop, "pressed");
        releasePointerAway(neutralStop);
        cy.window().then((win) => { win.__posted.length = 0; });
        pointerClick(primaryStop);
        cy.window().its("__posted").should((messages) => {
          expect(messages.filter((message) => message.message?.type === "run.interrupt")).to.have.length(1);
        });
        for (const selector of [primaryStop, neutralStop]) {
          cy.get(selector).should("be.disabled").and("have.attr", "aria-busy", "true");
          expectDisabledResponse(selector);
          expectPointerFocus(selector);
          cy.get(selector).then(($control) => expectSquareIcon($control[0]));
        }
        cy.window().then((win) => win.__boot());
        cy.get(primaryStop).should("be.disabled").and("have.attr", "aria-busy", "true");
        cy.get(neutralStop).should("be.disabled").and("have.attr", "aria-busy", "true");
        interactionKey("Enter", "Enter", 13);
        interactionKey(" ", "Space", 32);
        interactionKey("Tab", "Tab", 9);
        cy.focused().should(($control) => expect($control[0].matches('[data-action="interrupt-run"]')).to.equal(false));
        cy.window().its("__posted").should((messages) => {
          expect(messages.filter((message) => message.message?.type === "run.interrupt")).to.have.length(1);
        });
        cy.screenshot(`interaction/busy-stop-${theme}-${width}`);
      });
    }
  }
});
