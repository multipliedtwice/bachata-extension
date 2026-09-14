const fixture = "tests/fixtures/webview-layout/index.html";
const recordedAt = "2026-09-14T10:00:00.000Z";
const code = JSON.stringify(Array.from({ length: 120 }, (_, index) => ({
  index,
  detail: "Preserve readable evidence and exact conversation navigation. ".repeat(20),
})), null, 2);
const report = [
  "# Participant report",
  "The beginning of the selected participant response must be visible.",
  "```json",
  code,
  "```",
  ...Array.from({ length: 35 }, (_, index) => `Paragraph ${index + 1}: ${"The recorded review explains the observed behavior. ".repeat(4)}`),
].join("\n\n");

const boot = () => {
  cy.visit(fixture);
  cy.window().its("__boot").should("be.a", "function");
  cy.window().then((win) => {
    const panel = win.__panelState;
    panel.running = false;
    panel.workflowStatus = "completed";
    delete panel.pendingGate;
    delete panel.resumableWorkflow;
    panel.transcript = [
      { id: "first-request", kind: "prompt", eventType: "user.message", text: "Review the interface." },
      { id: "long-answer", kind: "answer", agentId: "lead", text: report },
      { id: "second-request", kind: "prompt", eventType: "user.message", text: "Review the interface." },
      { id: "later-answer", kind: "answer", agentId: "lead", text: report },
    ].map((entry) => ({ ...entry, createdAt: recordedAt }));
    panel.transcriptTotal = panel.transcript.length;
    panel.transcriptHasMore = false;
    win.__managerState.conversations[0].workflowStatus = "completed";
    win.__managerState.conversations[0].running = false;
    win.__boot();
  });
  cy.get(".chat-minimap button").should("have.length", 4);
};

const expectMessageStart = (messageId) => {
  cy.get(".conversation-scroll").should(($content) => {
    const content = $content[0];
    const message = content.querySelector(`[data-entry="${messageId}"]`);
    expect(message).not.to.equal(null);
    const delta = message.getBoundingClientRect().top - content.getBoundingClientRect().top - content.clientTop;
    expect(Math.abs(delta)).to.be.lessThan(2);
    expect(content.scrollTop).to.be.at.least(0);
    expect(content.scrollTop).to.be.at.most(content.scrollHeight - content.clientHeight);
  });
  cy.get(".chat-minimap [aria-current='true']").should("have.length", 1)
    .and("have.attr", "data-message-id", messageId);
};

describe("Conversation minimap positions", () => {
  for (const width of [320, 400, 700, 1280]) {
    it(`opens the exact message beginning with variable heights at ${width}px`, () => {
      cy.viewport(width, 800);
      boot();
      cy.get('[data-action="jump-message"][data-message-id="long-answer"]').click();
      expectMessageStart("long-answer");
      cy.focused().should("have.attr", "data-entry", "long-answer");
      cy.get('[data-action="jump-message"][data-message-id="second-request"]').click();
      expectMessageStart("second-request");
      cy.focused().should("have.attr", "data-entry", "second-request");
      cy.get('[data-action="jump-message"][data-message-id="later-answer"]').click();
      expectMessageStart("later-answer");
      cy.focused().should("have.attr", "data-entry", "later-answer");
      cy.window().then((win) => {
        expect(win.scrollY).to.equal(0);
        expect(win.document.documentElement.scrollTop).to.equal(0);
      });
    });
  }

  it("keeps both nested code scroll axes and focus across navigation and snapshots", () => {
    cy.viewport(400, 800);
    boot();
    cy.get('[data-action="jump-message"][data-message-id="long-answer"]').click();
    expectMessageStart("long-answer");
    const selectedCode = '[data-entry="long-answer"] pre';
    let top;
    let left;
    let conversationTop;
    cy.get(selectedCode).first().then(($block) => {
      const block = $block[0];
      block.scrollTop = 210;
      block.scrollLeft = 170;
      top = block.scrollTop;
      left = block.scrollLeft;
      expect(top).to.be.greaterThan(0);
      expect(left).to.be.greaterThan(0);
    });
    cy.get('[data-action="jump-message"][data-message-id="second-request"]').click();
    cy.get('[data-action="jump-message"][data-message-id="long-answer"]').click();
    expectMessageStart("long-answer");
    cy.get(selectedCode).first().then(($block) => {
      expect($block[0].scrollTop).to.equal(top);
      expect($block[0].scrollLeft).to.equal(left);
      $block[0].focus({ preventScroll: true });
    });
    cy.get(".conversation-scroll").then(($content) => { conversationTop = $content[0].scrollTop; });
    cy.window().then((win) => {
      win.__send({ type: "manager.snapshot", state: structuredClone(win.__managerState) });
      win.__send({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: structuredClone(win.__panelState) } });
    });
    cy.get(selectedCode).first().should(($block) => {
      expect($block[0].scrollTop).to.equal(top);
      expect($block[0].scrollLeft).to.equal(left);
      expect($block[0].ownerDocument.activeElement).to.equal($block[0]);
    });
    cy.get(".conversation-scroll").should(($content) => {
      expect($content[0].scrollTop).to.equal(conversationTop);
    });
    expectMessageStart("long-answer");
  });
});
