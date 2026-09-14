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
        cy.get('.view-switch [data-action="room-view"][data-view="execution"]').click();
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
    cy.get(".notification-center").should("not.exist");
    cy.get(".header-action-menu > summary").click();
    cy.get('.header-action-menu [data-action="notification-settings"]').click();
    cy.get("#notification-mode").select("decisions");
    cy.window().its("__posted").then((messages) => {
      expect(messages.at(-1)).to.deep.equal({ type: "notifications.setMode", mode: "decisions" });
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
      });
      win.__boot();
    });
    cy.get("#pipeline-picker-button").focus();
    pressKey("ArrowDown", "ArrowDown", 40);
    pressKey("Tab", "Tab", 9);
    cy.focused().should("have.id", "pipeline-picker-more");
    pressKey("Enter", "Enter", 13);
    cy.get('[data-pipeline-id="specialized-z"]').should("exist");
    pressKey("Tab", "Tab", 9, 8);
    cy.focused().should("have.id", "pipeline-picker-button");
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
          cy.get(".result-continuation-reason").should("be.visible").and("contain.text", "No write-capable pipeline is available");
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
