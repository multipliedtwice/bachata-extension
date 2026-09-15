const fixture = "tests/fixtures/webview-layout/index.html";
const pairingToken = "fixture-saved-pairing-token";
const rawError = "Shared resource is quarantined: browser-bridge:profile; ownerId=fixture-owner; database=bridge-state.sqlite";
const internalText = /quarantin|browser-bridge:profile|fixture-owner|bridge-state\.sqlite|verify and reconnect|verify recovery|clear quarantine/i;
const bridgeStatus = ".inspector [data-bridge-state]";
const bridgeReason = ".inspector [data-bridge-reason]";
const labels = {
  connecting: "Connecting…",
  retrying: "Browser unavailable — retrying",
  connected: "Connected",
  blocked: "Browser unavailable",
  disconnected: "Disconnected",
};

const publishBridge = (connectionState, overrides = {}) => cy.window().then((win) => {
  win.__panelState.browserBridge = {
    enabled: true,
    connected: connectionState === "connected",
    connectionState,
    sessions: [],
    pairingToken,
    error: rawError,
    ...overrides,
  };
  win.__send({
    type: "conversation.message",
    conversationId: "run-1",
    message: { type: "state.snapshot", state: win.__panelState },
  });
});

const openInspector = () => {
  cy.get("#room-actions-button").click();
  cy.get('.header-action-menu [data-action="inspector-toggle"]').click();
  cy.get(".inspector").should("be.visible");
};

const clearMessages = () => cy.window().then((win) => {
  win.__posted = [];
});

const expectNoInternals = () => {
  cy.get("#root").invoke("html").should("not.match", internalText);
  cy.get('button, summary, [role="button"]').each(($control) => {
    expect($control.text()).not.to.match(/verify.*recover|clear.*quarantin|reconnect.*recover/i);
  });
};

const expectTransient = (connectionState) => {
  cy.get(bridgeStatus)
    .should("have.attr", "data-bridge-state", connectionState)
    .and("have.text", labels[connectionState]);
  cy.get(bridgeReason).should("not.exist");
  cy.get(".global-error, .error-banner, .inspector .error, .inspector [role=alert]").should("not.exist");
  expectNoInternals();
};

const expectOnlyRuntimeMessage = (type) => cy.window().its("__posted").should("deep.equal", [{
  type: "conversation.runtime",
  conversationId: "run-1",
  message: { type },
}]);

describe("Browser Bridge host status and discovery controls", () => {
  beforeEach(() => {
    cy.viewport(792, 900);
    cy.visit(fixture);
    cy.window().its("__boot").should("be.a", "function");
    cy.window().then((win) => {
      win.__managerState.notifications = { mode: "off", unread: 0, events: [] };
      win.__boot();
    });
    publishBridge("connecting");
  });

  for (const width of [320, 792]) {
    for (const connectionState of ["connecting", "retrying", "connected", "disconnected"]) {
      it(`renders ${connectionState} without infrastructure errors at ${width}px`, () => {
        cy.viewport(width, 900);
        publishBridge(connectionState);
        openInspector();
        expectTransient(connectionState);
        cy.document().then((doc) => {
          expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth + 1);
        });
      });
    }

    it(`renders a concrete external blocker in user language at ${width}px`, () => {
      cy.viewport(width, 900);
      publishBridge("blocked", { blockedReason: "portUnavailable" });
      openInspector();
      cy.get(bridgeStatus).should("have.attr", "data-bridge-state", "blocked")
        .and("have.text", labels.blocked);
      cy.get(bridgeReason).should("be.visible")
        .and("have.attr", "data-bridge-reason", "portUnavailable")
        .and("have.text", "Another application is using the browser connection. Close that application to reconnect.");
      cy.get(".global-error").should("not.exist");
      expectNoInternals();
    });
  }

  it("renders Connecting to Connected from host snapshots without a recovery click", () => {
    openInspector();
    expectTransient("connecting");
    clearMessages();
    publishBridge("connected");
    expectTransient("connected");
    cy.window().its("__posted").should("deep.equal", []);
  });

  it("keeps repeated retries non-blocking and renders automatic reconnection without a control request", () => {
    openInspector();
    clearMessages();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      publishBridge("retrying");
      expectTransient("retrying");
      publishBridge("connecting");
      expectTransient("connecting");
    }
    publishBridge("connected");
    expectTransient("connected");
    cy.window().its("__posted").should("deep.equal", []);
  });

  it("clears a previously displayed external reason when the host reconnects", () => {
    publishBridge("blocked", { blockedReason: "portUnavailable" });
    openInspector();
    cy.get(bridgeReason).should("be.visible");
    clearMessages();
    publishBridge("retrying");
    expectTransient("retrying");
    publishBridge("connected");
    expectTransient("connected");
    cy.window().its("__posted").should("deep.equal", []);
  });

  it("treats an unrecognized blocker as retrying without rendering its raw error", () => {
    publishBridge("blocked", { blockedReason: "browser-bridge:profile" });
    openInspector();
    expectTransient("retrying");
  });

  it("renders host reconnection after reload without submitting an infrastructure action", () => {
    publishBridge("retrying");
    cy.reload();
    cy.window().its("__boot").should("be.a", "function");
    publishBridge("connecting");
    clearMessages();
    publishBridge("connected");
    openInspector();
    expectTransient("connected");
    cy.window().its("__posted").should("deep.equal", []);
  });

  it("updates Bridge status while preserving a stopped run", () => {
    cy.window().then((win) => {
      win.__panelState.workflowStatus = "interrupted";
      win.__panelState.running = false;
      win.__managerState.conversations[0].workflowStatus = "interrupted";
      win.__managerState.conversations[0].running = false;
      win.__boot();
    });
    openInspector();
    clearMessages();
    publishBridge("retrying");
    expectTransient("retrying");
    publishBridge("connected");
    expectTransient("connected");
    cy.get(".run-tab.selected .room-status").should("contain.text", "Stopped by you");
    cy.window().its("__posted").should("deep.equal", []);
  });

  it("Find browser sends discovery only", () => {
    publishBridge("retrying");
    openInspector();
    clearMessages();
    cy.get('.inspector [data-action="bridge-discover"]')
      .should("have.text", "Find browser").and("be.enabled").click();
    expectOnlyRuntimeMessage("bridge.discover");
    cy.get(".app-dialog").should("not.exist");
    expectNoInternals();
  });

  it("Reset pairing requires confirmation and sends the credential reset message only", () => {
    publishBridge("connected");
    openInspector();
    clearMessages();
    cy.get('.inspector [data-action="bridge-reset"]').should("have.text", "Reset pairing").click();
    cy.get(".app-dialog").should("be.visible").and("contain.text", "Reset pairing");
    cy.window().its("__posted").should("deep.equal", []);
    expectNoInternals();
    cy.get('.app-dialog [data-dialog-default="cancel"]').click();
    cy.window().its("__posted").should("deep.equal", []);
    cy.get('.inspector [data-action="bridge-reset"]').click();
    cy.get('.app-dialog [data-action="dialog-confirm"]').should("have.text", "Reset pairing").click();
    expectOnlyRuntimeMessage("bridge.reset");
  });

  it("keeps raw Bridge errors out of the agent assignment surface", () => {
    publishBridge("retrying");
    cy.get("#agents-picker-button").click();
    cy.get(".agents-bridge-setup").should("be.visible");
    cy.get(".agents-bridge-setup [data-bridge-state]")
      .should("have.attr", "data-bridge-state", "retrying")
      .and("have.text", labels.retrying);
    cy.get(".agents-bridge-setup .agents-slot-error, .global-error").should("not.exist");
    expectNoInternals();
    publishBridge("blocked", { blockedReason: "portUnavailable" });
    cy.get(".agents-bridge-setup [data-bridge-reason]")
      .should("have.attr", "data-bridge-reason", "portUnavailable").and("be.visible");
    expectNoInternals();
  });
});
