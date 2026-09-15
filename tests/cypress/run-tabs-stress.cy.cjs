const {
  interactionThemes, applyInteractionTheme, emulateInteractionTheme, pointerClick, interactionKey,
} = require("./helpers/interactionStates.cjs");

const assertStrip = (win, count) => {
  const state = win.__measureTabStress();
  expect(state.count).to.equal(count);
  expect(state.renderFailure).to.equal(false);
  expect(state.horizontalPageOverflow).to.equal(false);
  expect(state.minimumInactiveWidth).to.be.at.least(39.99);
  for (const key of ["allLabelsVisible", "labelsContained", "truncated", "fullTitles", "oneTabStop", "selectedContained", "selectedControlsReachable", "newRunReachable", "runsReachable"]) {
    expect(state[key], key).to.equal(true);
  }
  expect(state.inactiveDetails).to.equal(false);
  expect(state.selectedControlCount).to.equal(5);
  expect(state.selectedTitleWidth).to.be.at.least(32);
  expect(state.order).to.deep.equal(Array.from({ length: count }, (_, index) => `stress-${index + 1}`));
};

describe("Run tabs under sustained navigation and update load", () => {
  afterEach(() => emulateInteractionTheme("light"));
  for (const theme of interactionThemes) {
    for (const width of [320, 400, 792, 1280]) {
      it(`keeps 1000 long run titles navigable in ${theme} at ${width}px`, () => {
        cy.viewport(width, 900);
        cy.visit("tests/fixtures/webview-layout/index.html");
        cy.window().its("__seedTabStress").should("be.a", "function");
        emulateInteractionTheme(theme);
        cy.window().then((win) => {
          applyInteractionTheme(win, theme);
          win.document.documentElement.style.setProperty("--vscode-font-size", "18px");
          return win.__seedTabStress(1000, 999, { running: true });
        });
        pointerClick('.run-tab-tools [data-view="execution"]');
        cy.window().should((win) => assertStrip(win, 1000));
        for (const [selector, trigger, action] of [
          [".run-tab.selected .run-action-menu", "#room-actions-button", '[data-action="run-rename"]'],
          [".run-tab.selected .notification-center", "#notification-button", '[data-action="notification-settings"]'],
        ]) {
          pointerClick(trigger);
          cy.window().should((win) => expect(win.__measureTabStressMenu(selector)).to.deep.equal({
            open: true, contained: true, controlsReachable: true,
          }));
          pointerClick(`${selector} ${action}`);
          cy.get(".app-dialog").should("be.visible");
          pointerClick('.app-dialog [data-action="dialog-cancel"]');
          interactionKey("Escape", "Escape", 27);
        }
        cy.get(".run-tab.selected .run-tab-select").focus();
        interactionKey("Home", "Home", 36);
        cy.window().should((win) => {
          const state = win.__measureTabStress();
          expect(state.focusedId).to.equal("stress-1");
          expect(state.focusedReachable).to.equal(true);
          expect(state.selectedId).to.equal("stress-1000");
        });
        interactionKey("Enter", "Enter", 13);
        cy.get(".run-tab.selected .run-tab-select").should("have.attr", "data-conversation", "stress-1");
        cy.window().then((win) => {
          expect(win.__posted.filter((message) => message.type === "conversation.select")).to.deep.equal([
            { type: "conversation.select", conversationId: "stress-1" },
          ]);
          win.__tabStressState.activeConversationId = "stress-1";
          return win.__publishTabStress();
        });
        cy.get(".run-tab.selected .run-tab-select").focus();
        interactionKey("End", "End", 35);
        let left;
        cy.window().then((win) => {
          const state = win.__measureTabStress();
          expect(state.focusedId).to.equal("stress-1000");
          expect(state.focusedReachable).to.equal(true);
          left = state.scrollLeft;
        });
        for (let update = 0; update < 20; update++) {
          let unread;
          cy.window().then((win) => {
            unread = ++win.__tabStressState.conversations[999].unread;
            return win.__publishTabStress();
          });
          cy.window().should((win) => {
            expect(win.document.querySelector('.run-tab-select[data-conversation="stress-1000"]').textContent).to.contain(`${unread} unread messages`);
            expect(win.__measureTabStress().scrollLeft).to.be.closeTo(left, 1);
          });
        }
        let anchor;
        cy.window().then((win) => {
          win.document.querySelector(".run-tabs-scroll").scrollLeft /= 2;
          anchor = win.__measureTabStress().anchor;
          expect(anchor).not.to.equal(null);
        });
        for (const archived of [true, false]) {
          cy.window().then((win) => {
            Object.assign(win.__tabStressState.conversations[9], { running: false, workflowStatus: "completed", archived });
            return win.__publishTabStress();
          });
          cy.get(".run-tab").should("have.length", archived ? 999 : 1000);
          cy.window().should((win) => {
            const next = win.__measureTabStress().anchor;
            expect(next?.id).to.equal(anchor.id);
            expect(next.offset).to.be.closeTo(anchor.offset, 1);
          });
        }
        cy.window().then((win) => {
          win.__tabStressState.activeConversationId = "stress-500";
          return win.__publishTabStress();
        });
        cy.get(".run-tab.selected .run-tab-select").should("have.attr", "data-conversation", "stress-500");
        cy.window().should((win) => {
          const state = win.__measureTabStress();
          expect(state.focusedId).to.equal("stress-500");
          expect(state.focusedReachable).to.equal(true);
          expect(state.selectedContained).to.equal(true);
        });
        pointerClick('.run-tab-select[data-conversation="stress-1000"]');
        cy.get(".run-tab.selected .run-tab-select").should("have.attr", "data-conversation", "stress-1000");
        pointerClick(".run-tab.selected .run-action-menu > summary");
        cy.get(".run-tabs-scroll").scrollTo("left");
        cy.get(".run-tab.selected .run-action-menu").should("not.have.attr", "open");
        pointerClick(".run-tab-all");
        cy.get("#run-search").type("Run 997 ");
        cy.get(".run-drawer-select").should("have.length", 1).and("have.attr", "data-conversation", "stress-997");
        pointerClick('.run-drawer-select[data-conversation="stress-997"]');
        cy.get(".run-tab.selected .run-tab-select").should("have.attr", "data-conversation", "stress-997");
        cy.window().then((win) => {
          win.__tabStressState.activeConversationId = "stress-997";
          return win.__publishTabStress();
        });
        pointerClick('.run-tab-tools [data-view="execution"]');
        pointerClick("#room-actions-button");
        cy.viewport(width === 320 ? 1280 : 320, 900);
        cy.get(".run-tab.selected .run-action-menu").should("not.have.attr", "open");
        cy.window().should((win) => assertStrip(win, 1000));
        pointerClick('.run-tab-tools [data-action="interrupt-run"]');
        cy.window().then((win) => expect(win.__posted.filter((message) => message.message?.type === "run.interrupt")).to.deep.equal([
          { type: "conversation.runtime", conversationId: "stress-997", message: { type: "run.interrupt" } },
        ]));
        cy.window().then((win) => {
          win.__tabStressState.activeConversationId = "stress-997";
          win.__tabStressState.conversations[996].running = false;
          win.__tabStressState.conversations[996].workflowStatus = "completed";
          win.__tabStressState.conversations[996].archived = true;
          return win.__publishTabStress();
        });
        cy.get(".run-tab.selected").should("have.class", "archived");
        cy.window().then((win) => {
          win.__tabStressState.activeConversationId = "stress-1";
          return win.__publishTabStress();
        });
        cy.get(".run-tab").should("have.length", 999);
        cy.get('.run-tab-select[data-conversation="stress-997"]').should("not.exist");
        pointerClick(".run-tab-new");
        cy.window().then((win) => expect(win.__posted.filter((message) => message.type === "conversation.create")).to.have.length(1));
        cy.screenshot(`run-tabs-${theme}-${width}`);
      });
    }
  }
});
