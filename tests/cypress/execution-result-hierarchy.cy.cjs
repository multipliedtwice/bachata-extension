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

const pressTab = () => cy.then(async () => {
  await debuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await debuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
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
    const needsConfirmation = outcome === "inconclusive";
    manager.resultsByConversation["run-1"] = {
      status,
      changedFiles: ["src/webview-ui/executionRender.ts", "src/webview-ui/style.css"],
      checks: [{ command: "npm run check-types", status: "passed" }],
      findings: ["accepted", "accepted", needsConfirmation ? "unresolved" : "rejected"].map((disposition, index) => ({
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
      unresolvedRisks: needsConfirmation ? ["The remaining finding still needs confirmation."] : [],
      evidenceGaps: needsConfirmation ? ["Native VS Code visual acceptance is outstanding."] : [],
      evidence: [{ kind: "verification", label: "Verification", state: needsConfirmation ? "missing" : "recorded", detail: "The verification state is explicit." }],
      recoveredErrors: [],
      readableMarkdown: copyMarkdown,
      continuation: needsConfirmation ? { available: false, reason: "No write-capable pipeline is available. Configure a pipeline with writable paths before starting implementation.", resultVersion: "displayed-result", pipelines: [] } : { available: true, resultVersion: "displayed-result", pipelineId: "fix-source", pipelines: [{ id: "fix-source", name: "Fix source" }, { id: "implement-ui", name: "Implement UI" }] },
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

const expectFooterLayout = (column) => {
  const footer = column.querySelector(":scope > .execution-result-footer");
  const viewport = column.querySelector(":scope > .conversation-viewport");
  const scroll = column.querySelector("#conversation-scroll");
  const footerBounds = footer.getBoundingClientRect();
  const columnBounds = column.getBoundingClientRect();
  const viewportBounds = viewport.getBoundingClientRect();
  expect(column.querySelectorAll('[data-action="result-continue"]')).to.have.length(1);
  expect(footer.querySelectorAll('[data-action="result-continue"]')).to.have.length(1);
  expect(scroll.querySelectorAll('[data-action="result-continue"]')).to.have.length(0);
  expect(footer.closest("#conversation-scroll")).to.equal(null);
  expect(Math.abs(footerBounds.bottom - columnBounds.bottom)).to.be.lessThan(1);
  expect(viewportBounds.bottom).to.be.at.most(footerBounds.top + 1);
  expect(viewportBounds.height).to.be.greaterThan(0);
  expect(footer.scrollWidth).to.be.at.most(footer.clientWidth + 1);
  expectContained(footer, column);
  const actions = footer.querySelector(".result-continuation-action");
  const result = column.querySelector(".result-center");
  expect(Math.abs(actions.getBoundingClientRect().left - result.getBoundingClientRect().left)).to.be.lessThan(1);
  expect(Math.abs(actions.getBoundingClientRect().right - result.getBoundingClientRect().right)).to.be.lessThan(1);
  for (const control of footer.querySelectorAll("button, select")) {
    expectContained(control, actions);
    expect(control.scrollWidth).to.be.at.most(control.clientWidth + 1);
    expect(control.getBoundingClientRect().height).to.be.at.least(40);
  }
  expectNoRail(footer);
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
        cy.get(".ruling-compare").should("have.prop", "open", false).find("summary").click();
        cy.get(".ruling-compare").should("have.prop", "open", true);
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
        cy.get(".execution-result-footer .result-selection-count").should("have.text", "3 of 3 issues selected");
        cy.get(".execution-result-footer .result-selection-detail").should("not.exist");
        let footerPosition;
        cy.get(".conversation-column").should(($column) => {
          expectFooterLayout($column[0]);
          const bounds = $column[0].querySelector(".execution-result-footer").getBoundingClientRect();
          footerPosition = [bounds.top, bounds.bottom];
        });
        cy.get("#conversation-scroll").scrollTo("bottom");
        cy.get(".conversation-column").should(($column) => {
          expectFooterLayout($column[0]);
          const footer = $column[0].querySelector(".execution-result-footer").getBoundingClientRect();
          expect([footer.top, footer.bottom]).to.deep.equal(footerPosition);
          const lastSection = $column[0].querySelector(".pipeline-summary").getBoundingClientRect();
          expect(lastSection.bottom).to.be.at.most(footer.top + 1);
          const scroll = $column[0].querySelector("#conversation-scroll");
          expect(scroll.scrollTop).to.be.greaterThan(0);
        });
        cy.document().then((doc) => expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1));
      });
    }
  }

  it("expands the report between the selection summary and next-pipeline controls", () => {
    cy.viewport(400, 900);
    boot("inconclusive");
    cy.get(".result-center").should("not.exist");
    cy.get('[data-action="result-details-toggle"]')
      .should("have.text", "Review details")
      .and("have.attr", "aria-expanded", "false")
      .click();
    cy.get(".conversation-viewport").should("have.attr", "inert").and("have.attr", "aria-hidden", "true");
    cy.get(".execution-result-footer").should("have.class", "result-details-open").then(($footer) => {
      const column = $footer[0].closest(".conversation-column").getBoundingClientRect();
      const footer = $footer[0].getBoundingClientRect();
      const action = $footer[0].querySelector(".result-continuation-action");
      const overview = action.querySelector(".result-continuation-overview").getBoundingClientRect();
      const details = action.querySelector(".result-details-panel").getBoundingClientRect();
      const controls = action.querySelector(".result-continuation-controls").getBoundingClientRect();
      expect(Math.abs(footer.top - column.top)).to.be.at.most(1);
      expect(Math.abs(footer.bottom - column.bottom)).to.be.at.most(1);
      expect(details.top).to.be.at.least(overview.bottom);
      expect(details.bottom).to.be.at.most(controls.top);
    });
    cy.get(".result-details-panel").should("be.visible").and("contain.text", "The first participant conclusion.").and("contain.text", "The remaining finding still needs confirmation.");
    cy.get('.result-details-panel [data-action="result-copy"]').should("exist");
    cy.get('[data-action="result-details-toggle"]').should("be.focused").and("have.text", "Hide details");
    cy.get(".result-details-scroll").scrollTo("bottom").then(($scroll) => {
      expect($scroll[0].scrollTop).to.be.greaterThan(0);
      cy.window().then((win) => win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) }));
      cy.get(".result-details-scroll").should(($next) => expect($next[0].scrollTop).to.equal($scroll[0].scrollTop));
    });
    cy.get('[data-action="result-details-toggle"]').click();
    cy.get(".result-details-panel").should("not.exist");
    cy.get(".conversation-viewport").should("not.have.attr", "inert").and("not.have.attr", "aria-hidden");
    cy.get('[data-action="result-details-toggle"]').should("be.focused").and("have.text", "Review details").click();
    cy.get('[data-action="result-details-toggle"]').should("be.focused").type("{esc}");
    cy.get(".result-details-panel").should("not.exist");
    cy.get(".conversation-viewport").should("exist");
    cy.get('[data-action="result-details-toggle"]').should("be.focused");
  });

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
        findingIds: ["finding-0", "finding-1"],
        pipelineId: "fix-source",
      }]);
      expect(win.__posted.some((message) => ["user.message", "workflow.start", "workflow.restart", "workflow.resume", "orchestration.start"].includes(message.message?.type ?? message.type))).to.equal(false);
    });
  });

  it("keeps finding exclusions and the selected pipeline through snapshots before creating a draft", () => {
    cy.viewport(400, 900);
    boot("completed");
    cy.get(".ruling-compare").should("have.prop", "open", false);
    cy.get('[data-action="result-finding-select"]').should("have.length", 2);
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "2 of 2 issues selected");
    cy.get('[data-finding-id="finding-1"]').uncheck();
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "1 of 2 issues selected");
    cy.get(".execution-result-footer .result-selection-detail").should("not.exist");
    cy.get('[data-action="result-pipeline-select"]').select("implement-ui");
    cy.get('[data-finding-id="finding-0"]').focus();
    cy.window().then((win) => {
      win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) });
      win.__posted.length = 0;
    });
    cy.get('[data-finding-id="finding-0"]').should("be.checked").and("be.focused");
    cy.get('[data-finding-id="finding-1"]').should("not.be.checked");
    cy.get('[data-action="result-pipeline-select"]').should("have.value", "implement-ui");
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "1 of 2 issues selected");
    cy.get('.execution-result-footer [data-action="result-continue"]').should("have.text", "Start new pipeline").click();
    cy.window().should((win) => expect(win.__posted).to.deep.equal([{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result",
      findingIds: ["finding-0"], pipelineId: "implement-ui",
    }]));
  });

  it("allows current inconclusive finding choices while the destination pipeline is unavailable", () => {
    cy.viewport(320, 900);
    boot("inconclusive");
    cy.get('[data-action="result-finding-select"]').should("have.length", 3).each(($input) => cy.wrap($input).should("not.be.disabled"));
    cy.get('[data-finding-id="finding-1"]').uncheck();
    cy.get('[data-action="result-continue"]').should("have.attr", "aria-disabled", "true").click();
    cy.get(".result-continuation-tooltip").should("contain.text", "No write-capable pipeline is available");
    cy.get("#bachata-live-status").should("contain.text", "No write-capable pipeline is available");
    cy.window().then((win) => {
      expect(win.__posted.some((message) => message.type === "conversation.continueFromResult")).to.equal(false);
      const manager = win.__executionManagerState;
      manager.resultsByConversation["run-1"].continuation = {
        available: true, resultVersion: "displayed-result", pipelineId: "fix-source",
        pipelines: [{ id: "fix-source", name: "Fix source" }],
      };
      win.__send({ type: "manager.snapshot", state: structuredClone(manager) });
      win.__posted.length = 0;
    });
    cy.get('[data-finding-id="finding-1"]').should("not.be.checked");
    cy.get('[data-action="result-pipeline-select"]').select("fix-source");
    cy.get('[data-action="result-continue"]').should("not.have.attr", "aria-disabled").click();
    cy.window().should((win) => expect(win.__posted).to.deep.equal([{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result",
      findingIds: ["finding-0", "finding-2"], pipelineId: "fix-source",
    }]));
  });

  it("keeps a current completed report usable when its restored runtime is idle", () => {
    cy.viewport(400, 900);
    boot("completed");
    cy.window().then((win) => {
      const manager = win.__executionManagerState;
      manager.conversations[0].workflowStatus = "idle";
      manager.conversations[0].running = false;
      win.__send({ type: "manager.snapshot", state: structuredClone(manager) });
      const panel = win.__executionPanelState;
      panel.workflowStatus = "idle";
      panel.running = false;
      win.__send({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: structuredClone(panel) } });
      win.__posted.length = 0;
    });
    cy.get('[data-action="result-finding-select"]').should("have.length", 2).each(($input) => cy.wrap($input).should("not.be.disabled"));
    cy.get('[data-finding-id="finding-1"]').uncheck();
    cy.get('[data-action="result-continue"]').should("not.have.attr", "aria-disabled").focus();
    pressEnter();
    cy.window().should((win) => expect(win.__posted).to.deep.equal([{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result",
      findingIds: ["finding-0"], pipelineId: "fix-source",
    }]));
  });

  it("keeps the selected issue count and pipeline controls reachable at the bottom while reading a long report", () => {
    cy.viewport(320, 900);
    boot("completed", "dark");
    openStep("plan");
    cy.get('[data-finding-id="finding-1"]').uncheck();
    cy.get("#conversation-scroll").scrollTo("bottom");
    cy.get(".execution-result-footer").should("be.visible").within(() => {
      cy.get(".result-selection-count").should("have.text", "1 of 2 issues selected");
      cy.get(".result-continuation-tooltip").should("have.text", "Opens an editable draft. Execution starts only after you submit it.");
      cy.get('[data-action="result-pipeline-select"]').select("implement-ui").focus();
    });
    pressTab();
    cy.get('.execution-result-footer [data-action="result-continue"]').should("be.focused").should(($button) => {
      const style = $button[0].ownerDocument.defaultView.getComputedStyle($button[0]);
      expect(parseFloat(style.outlineWidth)).to.equal(2);
      expect(style.outlineStyle).to.equal("solid");
    });
    let scrollTop;
    cy.get("#conversation-scroll").then(($scroll) => { scrollTop = $scroll[0].scrollTop; });
    cy.window().then((win) => {
      win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) });
      win.__posted.length = 0;
    });
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "1 of 2 issues selected");
    cy.get('.execution-result-footer [data-action="result-pipeline-select"]').should("have.value", "implement-ui");
    cy.get('.execution-result-footer [data-action="result-continue"]').should("be.focused");
    cy.get("#conversation-scroll").should(($scroll) => expect($scroll[0].scrollTop).to.equal(scrollTop));
    pressEnter();
    cy.window().should((win) => expect(win.__posted).to.deep.equal([{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result",
      findingIds: ["finding-0"], pipelineId: "implement-ui",
    }]));
  });

  it("keeps an empty issue selection explicit and permits an assessment-only report without claiming issues were selected", () => {
    cy.viewport(400, 900);
    boot("completed");
    cy.get('[data-finding-id="finding-0"]').uncheck();
    cy.get('[data-finding-id="finding-1"]').uncheck();
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "0 of 2 issues selected");
    cy.get('.execution-result-footer [data-action="result-continue"]').should("have.attr", "aria-disabled", "true");
    cy.get(".execution-result-footer .result-continuation-tooltip").should("contain.text", "Select at least one finding to include in the new pipeline.");
    cy.window().then((win) => { win.__posted.length = 0; });
    cy.get('.execution-result-footer [data-action="result-continue"]').click();
    cy.window().then((win) => {
      expect(win.__posted).to.deep.equal([]);
      win.__executionManagerState.resultsByConversation["run-1"].findings = [];
      win.__executionManagerState.resultsByConversation["run-1"].finalDecision.candidate = { summary: "Assessment recorded without findings." };
      win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) });
    });
    cy.get(".execution-result-footer .result-selection-count").should("have.text", "0 issues selected");
    cy.get(".execution-result-footer .result-selection-detail").should("not.exist");
    cy.get('.execution-result-footer [data-action="result-continue"]').should("not.have.attr", "aria-disabled").click();
    cy.window().should((win) => expect(win.__posted).to.deep.equal([{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "displayed-result",
      pipelineId: "fix-source",
    }]));
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
