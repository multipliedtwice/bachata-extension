const {
  interactionThemes, applyInteractionTheme, emulateInteractionTheme, pointerClick, tabToControl,
  expectSquareIcon, expectControlFill, expectKeyboardRing, expectPointerFocus,
  expectPrimaryResponse,
} = require("./helpers/interactionStates.cjs");
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
  afterEach(() => emulateInteractionTheme("light"));
  for (const theme of interactionThemes) {
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
          emulateInteractionTheme(theme);
          cy.window().then((win) => {
            applyInteractionTheme(win, theme);
            win.document.documentElement.style.setProperty("--vscode-font-size", `${font}px`);
            win.__bootExecution();
          });
          cy.get('.run-tab.selected .run-tab-tools [data-view="chat"]').should("have.attr", "aria-label", translations.Chat);
          cy.get('.run-tab.selected .run-tab-tools [data-view="execution"]').should("have.attr", "aria-label", translations.Execution);
          cy.get(".room-header").should("not.exist");
          cy.get(".run-tab.selected").should(($tab) => {
            const tab = $tab[0];
            expect(tab.scrollWidth).to.be.at.most(tab.clientWidth + 1);
            for (const element of tab.querySelectorAll(".run-tab-tool, #notification-button, #room-actions-button")) {
              expectInside(element, tab);
              expectSquareIcon(element);
              expect(element.scrollWidth).to.be.at.most(element.clientWidth + 1);
            }
          });
          const execution = '.run-tab.selected .run-tab-tools [data-view="execution"]';
          const chat = '.run-tab.selected .run-tab-tools [data-view="chat"]';
          tabToControl(execution);
          cy.get(execution).should("be.focused");
          expectKeyboardRing(execution);
          pointerClick(execution);
          expectControlFill(execution, "selected");
          expectPointerFocus(execution);
          cy.get(".execution-content").should("be.visible");
          pointerClick(chat);
          expectControlFill(chat, "selected");
          expectPointerFocus(chat);
          cy.get(".run-outcome-actions .primary").should("be.visible").and("contain.text", translations["Retry failed step"]);
          expectPrimaryResponse(".run-outcome-actions .primary");
          cy.screenshot(`interaction/localized-primary-${theme}-${width}-${font}`);
          cy.get("#room-actions-button").focus().should("be.focused").click();
          cy.get('.header-action-menu [data-action="inspector-toggle"]').should("be.visible");
          cy.screenshot(`interaction/localized-${theme}-${width}-${font}`);
          cy.document().then((doc) => {
            expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1);
          });
        });
      }
    }
  }
});
