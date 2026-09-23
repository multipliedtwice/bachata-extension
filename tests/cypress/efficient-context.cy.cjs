const themeColors = require("../fixtures/webview-layout/theme-colors.json");
const fixture = "tests/fixtures/webview-layout/index.html";
const contextRequests = (win) => win.__posted.filter((entry) => entry.type === "conversation.runtime" && entry.message.type === "executionContext.set");
const space = () => cy.then(async () => {
  await Cypress.automation("remote:debugger:protocol", { command: "Input.dispatchKeyEvent", params: { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 } });
  await Cypress.automation("remote:debugger:protocol", { command: "Input.dispatchKeyEvent", params: { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 } });
});

describe("Efficient context in Runs", { browser: "chrome" }, () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 480, 900]) {
      it(`shows the control, keyboard focus, save and unavailable states at ${width}px in ${theme}`, () => {
        cy.viewport(width, 900);
        cy.visit(fixture);
        cy.window().then((win) => {
          for (const [key, value] of Object.entries(themeColors[theme])) {
            win.document.documentElement.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
          }
          win.__panelState.executionContext = { defaultMode: "legacy", mode: "legacy", pinned: false, locked: false };
          win.__boot();
        });
        cy.get('[data-action="agents-picker-toggle"]').first().click();
        cy.get(".agents-popover").should("be.visible");
        cy.get(".composer-context").should("not.exist");
        cy.window().then((win) => {
          win.__panelState.executionContext = { defaultMode: "localTodoStateV1", mode: "localTodoStateV1", pinned: false, locked: false };
          win.__boot();
        });
        cy.get(".agents-popover .composer-context").scrollIntoView().should("be.visible").within(() => {
          cy.contains("Efficient context").should("be.visible");
          cy.contains("Experimental").should("be.visible");
          cy.contains("An offline pilot found no saving.").should("be.visible");
        });
        cy.get("#execution-context-mode").should("be.checked").focus();
        cy.focused().should("have.id", "execution-context-mode");
        space();
        cy.get("#execution-context-mode").should("not.be.checked").and("have.attr", "aria-disabled", "true");
        cy.window().then((win) => {
          expect(contextRequests(win)).to.have.length(1);
          expect(contextRequests(win)[0].message.mode).to.equal("legacy");
          win.__boot();
        });
        space();
        cy.window().then((win) => {
          expect(contextRequests(win)).to.have.length(1);
          const request = contextRequests(win)[0];
          win.__panelState.executionContext = { defaultMode: "legacy", mode: "legacy", pinned: false, locked: false };
          win.__boot();
          win.__send({ type: "conversation.message", conversationId: "run-1", message: { type: "operation.result", operation: "executionContext.set", requestId: request.message.requestId, status: "completed" } });
        });
        cy.get("#execution-context-mode").should("not.exist");
        cy.window().then((win) => {
          win.__panelState.executionContext = { defaultMode: "localTodoStateV1", mode: "legacy", pinned: false, locked: false, unavailable: "providers" };
          win.__boot();
        });
        cy.get("#execution-context-mode").should("not.be.checked").focus();
        cy.get("#execution-context-reason").should("contain.text", "Choose local Claude/Codex for every role.");
        space();
        cy.get("#execution-context-mode").should("not.be.checked");
        cy.window().then((win) => {
          expect(contextRequests(win)).to.have.length(1);
          const context = win.document.querySelector(".composer-context");
          expect(context.scrollWidth).to.be.at.most(context.clientWidth + 1);
          win.__panelState.executionContext = { defaultMode: "legacy", mode: "localTodoStateV1", pinned: true, locked: true };
          win.__boot();
        });
        cy.get("#execution-context-mode").should("be.checked").and("have.attr", "aria-disabled", "true");
        cy.get("#execution-context-reason").should("contain.text", "recorded mode");
        cy.screenshot(`efficient-context-${theme}-${width}`, { capture: "viewport" });
      });
    }
  }
});
