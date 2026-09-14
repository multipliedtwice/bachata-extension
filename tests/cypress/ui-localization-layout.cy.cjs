const themeColors = require("../fixtures/webview-layout/theme-colors.json");
const fixture = "tests/fixtures/webview-layout/index.html";
const translations = {
  Chat: "Unterhaltung",
  Execution: "Ausführungsübersicht",
  Failed: "Ausführung fehlgeschlagen",
  "Retry failed step": "Fehlgeschlagenen Schritt erneut ausführen",
  "Run actions": "Aktionen für diese Ausführung",
};

const expectInside = (element, container) => {
  const rect = element.getBoundingClientRect();
  const bounds = container.getBoundingClientRect();
  expect(rect.left).to.be.at.least(bounds.left - 1);
  expect(rect.right).to.be.at.most(bounds.right + 1);
  expect(rect.top).to.be.at.least(bounds.top - 1);
  expect(rect.bottom).to.be.at.most(bounds.bottom + 1);
};

describe("Translated header layout", () => {
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 400, 792, 1280]) {
      for (const font of [13, 18]) {
        it(`keeps translated actions reachable in ${theme} at ${width}px with ${font}px text`, () => {
          cy.viewport(width, 900);
          cy.visit(fixture, {
            onBeforeLoad(win) {
              const settings = win.document.createElement("script");
              settings.id = "bachata-localization";
              settings.type = "application/json";
              settings.textContent = JSON.stringify({ locale: "de-DE", messages: translations });
              win.document.head.append(settings);
            },
          });
          cy.window().its("__bootExecution").should("be.a", "function");
          cy.window().then((win) => {
            for (const [key, value] of Object.entries(themeColors[theme])) {
              win.document.documentElement.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
            }
            win.document.documentElement.style.setProperty("--vscode-font-size", `${font}px`);
            win.__bootExecution();
          });
          cy.get('.view-switch [data-view="chat"]').should("have.text", translations.Chat);
          cy.get('.view-switch [data-view="execution"]').should("have.text", translations.Execution);
          cy.get(".room-header").should(($header) => {
            const header = $header[0];
            expect(header.scrollWidth).to.be.at.most(header.clientWidth + 1);
            for (const element of header.querySelectorAll(".room-status, .view-switch button, #room-actions-button")) {
              expectInside(element, header);
              expect(element.scrollWidth).to.be.at.most(element.clientWidth + 1);
            }
          });
          cy.get('.view-switch [data-view="execution"]').focus().should("be.focused").click();
          cy.get(".execution-content").should("be.visible");
          cy.get('.view-switch [data-view="chat"]').click();
          cy.get(".run-outcome-actions .primary").should("be.visible").and("contain.text", translations["Retry failed step"]);
          cy.get("#room-actions-button").focus().should("be.focused").click();
          cy.get('.header-action-menu [data-action="inspector-toggle"]').should("be.visible");
          cy.document().then((doc) => {
            expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1);
          });
        });
      }
    }
  }
});
