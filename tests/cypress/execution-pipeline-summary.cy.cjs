const themeColors = require("../fixtures/webview-layout/theme-colors.json");
const fixture = "tests/fixtures/webview-layout/index.html";
const recordedAt = "2026-09-14T10:00:00.000Z";
const names = ["Inspect the interface independently", "Reconcile UI/UX findings", "Keep unexecuted steps readable"];

const boot = (theme, font) => {
  cy.visit(fixture);
  cy.window().its("__bootExecution").should("be.a", "function");
  cy.then(() => Cypress.automation("remote:debugger:protocol", {
    command: "Emulation.setEmulatedMedia",
    params: { features: [
      { name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" },
      { name: "forced-colors", value: theme === "high-contrast" ? "active" : "none" },
    ] },
  }));
  cy.window().then((win) => {
    for (const [key, value] of Object.entries(themeColors[theme === "light" ? "light" : "dark"])) {
      win.document.documentElement.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
    }
    win.document.documentElement.style.setProperty("--vscode-font-size", `${font}px`);
    const panel = win.__executionPanelState;
    const manager = win.__executionManagerState;
    panel.workflowStatus = "completed";
    panel.running = false;
    delete panel.resumableWorkflow;
    panel.selectedPipelineDefinition.steps = names.map((name, index) => ({
      id: `step-${index}`,
      name,
      enabled: true,
      humanGate: "none",
      type: "agent",
      participants: ["lead"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      attachments: "selected",
    }));
    panel.transcript = [0, 1].map((index) => ({
      id: `answer-${index}`,
      kind: "answer",
      agentId: "lead",
      stepId: `step-${index}`,
      step: names[index],
      createdAt: recordedAt,
      text: `Participant response for ${names[index]}.`,
    }));
    panel.transcriptTotal = panel.transcript.length;
    panel.transcriptHasMore = false;
    manager.conversations[0].workflowStatus = "completed";
    manager.conversations[0].running = false;
    manager.eventsByConversation["run-1"] = [
      { id: 1, type: "run.started", createdAt: recordedAt },
      { id: 2, type: "step.started", stepId: "step-0", createdAt: recordedAt },
      { id: 3, type: "step.started", stepId: "step-1", createdAt: recordedAt },
      { id: 4, type: "run.completed", createdAt: recordedAt },
    ];
    win.__bootExecution();
  });
  cy.get('[data-action="room-view"][data-view="execution"]').click();
};

describe("Execution pipeline summary geometry", { browser: "chrome" }, () => {
  for (const theme of ["light", "dark", "high-contrast"]) {
    for (const width of [320, 400, 480, 700, 1280]) {
      it(`keeps markers, numbers and complete titles in separate columns in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        boot(theme, width === 480 ? 18 : 13);
        cy.get(".pipeline-step-summary").should("have.length", 3).each(($summary, index) => {
          const summary = $summary[0];
          const win = summary.ownerDocument.defaultView;
          const position = summary.querySelector(".pipeline-step-position");
          const title = summary.querySelector(".pipeline-step-name");
          const state = summary.querySelector(".pipeline-step-state");
          const bounds = summary.getBoundingClientRect();
          const numberRect = position.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          const stateRect = state.getBoundingClientRect();
          expect(title.textContent).to.equal(names[index]);
          expect(numberRect.width).to.equal(20);
          expect(titleRect.left).to.be.at.least(numberRect.right + 7);
          expect(titleRect.width).to.be.greaterThan(100);
          expect(titleRect.height).to.be.at.most(parseFloat(win.getComputedStyle(title).lineHeight) * 4 + 1);
          expect(title.scrollWidth).to.be.at.most(title.clientWidth + 1);
          expect(summary.scrollWidth).to.be.at.most(summary.clientWidth + 1);
          expect(stateRect.right).to.be.at.most(bounds.right + 1);
          if (summary.tagName === "SUMMARY") {
            const marker = win.getComputedStyle(summary, "::before");
            expect(marker.content).to.equal('""');
            expect(marker.gridColumnStart).to.equal("1");
            expect(marker.gridRowStart).to.equal("1");
            const count = summary.querySelector(".pipeline-step-count");
            const countRect = count.getBoundingClientRect();
            expect(count.textContent).to.equal("1 participant result");
            expect(countRect.top).to.be.at.least(titleRect.bottom);
            expect(Math.abs(countRect.left - titleRect.left)).to.be.lessThan(1);
            if (width <= 480) expect(stateRect.top).to.be.at.least(countRect.bottom);
          }
          if (width <= 480) {
            expect(Math.abs(stateRect.left - titleRect.left)).to.be.lessThan(1);
            expect(stateRect.top).to.be.at.least(titleRect.bottom);
          } else {
            expect(stateRect.left).to.be.at.least(titleRect.right + 7);
          }
        });
        cy.get(".pipeline-step-name").should(($titles) => {
          const left = $titles[0].getBoundingClientRect().left;
          for (const title of $titles) expect(Math.abs(title.getBoundingClientRect().left - left)).to.be.lessThan(1);
        });
        cy.get('[data-disclosure-key="run-1:pipeline-step:step-0"] > summary').click();
        cy.get('[data-disclosure-key="run-1:pipeline-step:step-0"] .pipeline-step-message').should("have.length", 1).and("contain.text", `Participant response for ${names[0]}.`);
        cy.window().then((win) => {
          win.__send({ type: "manager.snapshot", state: structuredClone(win.__executionManagerState) });
          win.__send({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: structuredClone(win.__executionPanelState) } });
        });
        cy.get('[data-disclosure-key="run-1:pipeline-step:step-0"]').should("have.prop", "open", true);
        cy.get('[data-disclosure-key="run-1:pipeline-step:step-1"]').should("have.prop", "open", false);
      });
    }
  }
});
