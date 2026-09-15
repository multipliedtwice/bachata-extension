// The run state matrix in the built webview: running, stopped by the user, failed in a step, refused
// before any participant started, and completed — each at every supported pane width, in light,
// dark and forced-colours themes. Chrome only: themes and keyboard input go through the DevTools
// protocol so the page receives real media features and real key events.

const widths = [320, 360, 400, 480, 700, 792, 900, 1280];
const themes = ["light", "dark", "high-contrast"];
const step = "Inspect the interface independently";
const prompt = "Review the supplied interface for usability, accessibility and focus.\n\nreview extension/";
const failure = "The provider refused this request.";
const refusal = "Choose a Git project folder. /Users/reviewer/workspace is not inside a Git worktree, and Builder in “Implement” may change files, so Bachata needs Git to validate those changes. No participant was started.";
const recoveryActions = '[data-action="workflow-restart"], [data-action="workflow-resume"], [data-action="workflow-discard"]';

const debuggerCommand = (command, params) =>
  Cypress.automation("remote:debugger:protocol", { command, params });

const emulateTheme = (theme) =>
  debuggerCommand("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" },
      { name: "forced-colors", value: theme === "high-contrast" ? "active" : "none" },
    ],
  });

const pressEnter = () =>
  cy.wrap(null).then(async () => {
    await debuggerCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await debuggerCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }).wait(120);

const checkpoint = (panel, overrides) => ({ ...panel.resumableWorkflow, stepName: step, nextStepIndex: 0, ...overrides });

const states = {
  running: (panel, manager, conversation) => {
    panel.running = true;
    panel.workflowStatus = "running";
    panel.resumableWorkflow = checkpoint(panel, { outcome: "failed", failureScope: "step" });
    conversation.running = true;
    conversation.workflowStatus = "running";
  },
  stopped: (panel, manager, conversation) => {
    panel.workflowStatus = "interrupted";
    panel.resumableWorkflow = checkpoint(panel, { outcome: "stoppedByUser", failureScope: undefined });
    panel.transcript = panel.transcript.filter((entry) => entry.kind !== "error");
    conversation.workflowStatus = "interrupted";
    delete manager.resultsByConversation["run-1"];
  },
  failedStep: (panel, manager, conversation) => {
    panel.workflowStatus = "error";
    panel.resumableWorkflow = checkpoint(panel, { outcome: "failed", failureScope: "step" });
    panel.transcript = [
      { id: "user-review", kind: "prompt", eventType: "user.message", text: "review extension/", createdAt: "2026-09-12T20:31:47.000Z" },
      { id: "prompt-codex", kind: "prompt", agentId: "codex", step, eventType: "agent.prompt", text: prompt, createdAt: "2026-09-12T20:31:47.100Z" },
      { id: "prompt-claude", kind: "prompt", agentId: "claude", step, eventType: "agent.prompt", text: prompt, createdAt: "2026-09-12T20:31:47.200Z" },
      { id: "error-codex", kind: "error", agentId: "codex", step, text: failure, createdAt: "2026-09-12T20:37:17.000Z" },
    ];
    panel.transcriptTotal = panel.transcript.length;
    conversation.workflowStatus = "error";
    manager.resultsByConversation["run-1"] = {
      ...manager.resultsByConversation["run-1"],
      unresolvedRisks: [failure],
      finalAssessment: {
        outcome: "failedBeforeRuling",
        method: "none",
        summary: `Failed before final ruling: ${failure}`,
        producedBy: [],
        failure: { error: failure, agentId: "codex", participant: "Usability reviewer", step },
      },
    };
  },
  refused: (panel, manager, conversation) => {
    panel.workflowStatus = "error";
    panel.resumableWorkflow = checkpoint(panel, { outcome: "failed", failureScope: "run" });
    panel.transcript = [
      { id: "user-fix", kind: "prompt", eventType: "user.message", text: "Fix the retry guard", createdAt: "2026-09-12T20:31:47.000Z" },
      {
        id: "preflight",
        kind: "error",
        eventType: "workflow.preflightFailed",
        text: refusal,
        createdAt: "2026-09-12T20:31:47.500Z",
        data: { reason: "notGitWorktree", folder: "/Users/reviewer/workspace", detail: "fatal: not a git repository", participants: [{ participant: "Builder", step: "Implement" }] },
      },
    ];
    panel.transcriptTotal = panel.transcript.length;
    conversation.workflowStatus = "error";
    delete manager.resultsByConversation["run-1"];
  },
  completed: (panel, manager, conversation) => {
    panel.workflowStatus = "completed";
    delete panel.resumableWorkflow;
    panel.transcript = panel.transcript.filter((entry) => entry.kind !== "error");
    conversation.workflowStatus = "completed";
    manager.resultsByConversation["run-1"] = {
      ...manager.resultsByConversation["run-1"],
      status: "completed",
      unresolvedRisks: [],
      finalAssessment: { outcome: "completed", method: "singleProvider", summary: "Nothing to fix.", producedBy: [] },
    };
  },
};

const boot = (name) =>
  cy.window().then((win) => {
    const panel = win.__executionPanelState;
    const manager = win.__executionManagerState;
    panel.agents = {
      codex: { id: "codex", name: "Usability reviewer", adapterType: "codex-app-server", status: "idle", output: "" },
      claude: { id: "claude", name: "Accessibility reviewer", adapterType: "claude-code", status: "idle", output: "" },
    };
    states[name](panel, manager, manager.conversations[0]);
    win.__bootExecution();
  });

const expectNoHorizontalScroll = () =>
  cy.document().then((doc) => {
    const scroll = doc.querySelector(".conversation-scroll");
    expect(doc.documentElement.scrollWidth, "page scroll width").to.be.at.most(doc.documentElement.clientWidth + 1);
    expect(scroll.scrollWidth, "chat scroll width").to.be.at.most(scroll.clientWidth + 1);
  });

const expectRecoveryRow = (width, actions) =>
  cy.get(".run-outcome").then(($card) => {
    const card = $card[0];
    const box = card.getBoundingClientRect();
    const controls = [...card.querySelectorAll("button")].filter(control => control.getBoundingClientRect().height > 0);
    expect(controls.map((control) => control.dataset.action)).to.deep.equal(actions);
    const rects = controls.map((control) => control.getBoundingClientRect());
    rects.forEach((rect, index) => {
      expect(rect.height, `${actions[index]} height`).to.be.at.least(24);
      expect(rect.left, `${actions[index]} left`).to.be.at.least(box.left - 0.5);
      expect(rect.right, `${actions[index]} right`).to.be.at.most(box.right + 0.5);
      rects.slice(index + 1).forEach((other) => {
        const overlaps = Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 0.5
          && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 0.5;
        expect(overlaps, `${actions[index]} overlaps a sibling`).to.equal(false);
      });
    });
    [...card.querySelectorAll("strong, p, button")].forEach((element) => {
      expect(parseFloat(card.ownerDocument.defaultView.getComputedStyle(element).fontSize), "outcome text size").to.be.at.least(13);
    });
    if (width <= 850) {
      expect(box.left, "left gutter").to.be.at.least(15.5);
      expect(box.right, "right gutter").to.be.at.most(width - 15.5);
    }
  });

describe("run state matrix", { browser: "chrome" }, () => {
  for (const theme of themes) {
    for (const width of widths) {
      describe(`${theme} at ${String(width)}px`, () => {
        beforeEach(() => {
          cy.viewport(width, 900);
          cy.visit("tests/fixtures/webview-layout/index.html");
          cy.window().its("__bootExecution").should("be.a", "function");
          cy.wrap(null).then(() => emulateTheme(theme));
        });

        it("a working run says Working beside a progress indicator, offers Stop, and draws no result or recovery", () => {
          boot("running");
          cy.get(".run-tab.selected .room-status").should("have.text", "Working")
            .find(".codicon-loading.codicon-modifier-spin").should("have.attr", "aria-hidden", "true");
          cy.get(".run-outcome").should("not.exist");
          cy.get(recoveryActions).should("not.exist");
          cy.get(".codicon-sync").should("not.exist");
          cy.get(".conversation-scroll").should("not.contain.text", "Open the result").and("not.contain.text", "ended as");
          cy.get('.composer-send [data-action="interrupt-run"]').should("be.visible");
          cy.get("#composer-prompt").type("Queue a follow-up");
          cy.get('.composer-send [data-action="submit-message"]').should("exist");
          cy.get('.composer-send [data-action="interrupt-run"]').should("not.exist");
          expectNoHorizontalScroll();
        });

        it("a stop by the user offers Resume with secondary recovery actions", () => {
          boot("stopped");
          cy.get(".run-tab.selected .room-status").should("have.text", "Stopped by you");
          cy.get(".run-outcome strong").should("contain.text", "Stopped by you");
          cy.get('.run-outcome [data-action="workflow-resume"]').should("have.text", "Resume stopped step");
          cy.get(".run-outcome").should("not.contain.text", "Retry failed step").and("not.contain.text", "Failed");
          expectRecoveryRow(width, ["workflow-resume"]);
          expectNoHorizontalScroll();
        });

        it("a failure offers Retry with secondary recovery actions", () => {
          boot("failedStep");
          cy.get(".run-tab.selected .room-status").should("have.text", "Failed");
          cy.get('.run-outcome [data-action="workflow-resume"]').should("have.text", "Retry failed step");
          expectRecoveryRow(width, ["workflow-resume", "room-view"]);
          cy.get(".run-outcome .recovery-menu > summary").click();
          cy.get('.run-outcome [data-action="workflow-discard"]').click();
          cy.focused().should("have.attr", "data-dialog-default", "cancel");
          cy.get('[data-dialog-default="cancel"]').click();
          cy.focused().should("have.attr", "data-action", "workflow-discard");
          expectNoHorizontalScroll();
        });

        it("keeps bookkeeping out of chat and opens the selected turn prompt from the keyboard", () => {
          boot("failedStep");
          cy.get(".run-information, .info-entry").should("not.exist");
          cy.get(".conversation-scroll").should("not.contain.text", prompt);
          cy.get('[data-action="message-details"][data-message-id="error-codex"]')
            .should("be.visible")
            .then(($button) => {
              expect($button[0].getBoundingClientRect().height, "participant detail control height").to.be.at.least(24);
              expect(parseFloat($button[0].ownerDocument.defaultView.getComputedStyle($button[0]).fontSize), "participant name size").to.be.at.least(13);
            })
            .focus();
          pressEnter();
          cy.get('.app-dialog[role="dialog"]').should("be.visible");
          cy.get("#app-dialog-title").should("have.text", "Usability reviewer · prompt");
          cy.get(".turn-details .markdown > p").should("have.length", 2).then(($paragraphs) => {
            expect([...$paragraphs].map((paragraph) => paragraph.textContent)).to.deep.equal([
              "Review the supplied interface for usability, accessibility and focus.",
              "review extension/",
            ]);
          });
          cy.focused().should("have.attr", "data-dialog-default", "cancel");
          cy.get('[data-dialog-default="cancel"]').click();
          cy.focused().should("have.attr", "data-message-id", "error-codex");
          cy.get(".conversation-scroll").should("not.contain.text", prompt);
          expectNoHorizontalScroll();
        });

        it("a refusal before any participant started is stated once, offers the folder, and offers no retry", () => {
          boot("refused");
          cy.get(".run-preflight-failure").should("be.visible");
          cy.get(".conversation-scroll").invoke("text").then((text) => {
            expect(text.split("is not inside a Git worktree").length - 1).to.equal(1);
          });
          cy.get(".agent-row").should("not.exist");
          cy.get('.run-preflight-failure [data-action="working-directory"]').should("be.visible");
          cy.get(".run-preflight-failure .preflight-details").should("not.have.attr", "open");
          cy.get('[data-action="workflow-resume"]').should("not.exist");
          cy.get(".run-outcome p").should("have.text", `Could not start step 1 of 4 · ${step}`);
          expectRecoveryRow(width, ["workflow-restart"]);
          cy.get(".conversation-scroll").should("not.contain.text", "null");
          expectNoHorizontalScroll();
        });

        it("a completed run shows its result and no recovery", () => {
          boot("completed");
          cy.get(".run-tab.selected .room-status").should("have.text", "Completed");
          cy.get(".run-outcome strong").should("contain.text", "Completed");
          cy.get(recoveryActions).should("not.exist");
          cy.get('.run-outcome [data-action="room-view"]').should("have.text", "Open the result");
          expectNoHorizontalScroll();
        });
      });
    }
  }
});
