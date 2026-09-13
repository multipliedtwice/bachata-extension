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

const bootReadOnly = () => cy.window().then((win) => {
  win.__managerState.readOnly = {
    owned: false,
    reason: "Another Bachata Extension Host owns this workspace.",
    holderLastSeenSecondsAgo: 13,
    retryCommand: "Bachata: Workspace Ownership",
  };
  win.__panelState.pipelineMutable = false;
  win.__panelState.pipelineMutationReason = "Another Bachata window owns this repository's state.";
  win.__posted = [];
  win.__boot();
});

describe("read-only secondary window", { browser: "chrome" }, () => {
  for (const theme of themes) {
    for (const width of widths) {
      it(`${theme} at ${String(width)}px stays readable and offers ownership`, () => {
        cy.viewport(width, 900);
        cy.visit("tests/fixtures/webview-layout/index.html");
        cy.window().its("__boot").should("be.a", "function");
        cy.wrap(null).then(() => emulateTheme(theme));
        bootReadOnly();

        cy.get(".read-only-banner").should("be.visible");
        cy.get("#pipeline-picker-button").should("contain.text", "Review only");
        cy.get("body").should("not.contain.text", "Loading pipelines");
        cy.get('[data-action="workspace-ownership"]').should("be.visible").then(($button) => {
          const rect = $button[0].getBoundingClientRect();
          expect(rect.height, "ownership control height").to.be.at.least(24);
          expect(rect.left, "ownership control left edge").to.be.at.least(7.5);
          expect(rect.right, "ownership control right edge").to.be.at.most(width - 7.5);
        }).focus().type("{enter}");

        cy.window().its("__posted").should("deep.equal", [{ type: "workspace.ownership" }]);
        cy.document().then((document) => {
          expect(document.documentElement.scrollWidth, "page scroll width")
            .to.be.at.most(document.documentElement.clientWidth + 1);
        });
        cy.screenshot(`read-only-window/${theme}-${String(width)}`);
      });
    }
  }
});
