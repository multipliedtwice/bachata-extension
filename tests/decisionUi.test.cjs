const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const timestamp = "2026-09-13T10:00:00.000Z";
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const gate = { stepId: "review", stepName: "Review", reason: "maxConsensusRounds", round: 5, decisionRound: 4, allowedActions: ["acceptUnresolved", "retry", "cancel"], rollbackTargets: [] };
const interaction = (overrides = {}) => ({
  interactionRef: "answer-1", conversationId: "run-1", kind: "humanGate", status: "pending", humanGate: gate, ...overrides,
});
const decision = (id, status = "pending", overrides = {}) => ({
  id, type: "decision.published", createdAt: timestamp,
  payload: { stepId: "review", round: 4, status, participants: [], ...overrides },
});
const opening = (id) => ({ id, type: "run.started", createdAt: timestamp });

const load = ({ events = [], interactions = [], panel = {}, roomView = "chat" } = {}) => {
  const currentPanel = { agents: {}, approvals: [], workspaceRoots: ["/workspace"], selectedPipelineDefinition: { steps: [] }, workflowStatus: "paused", ...panel };
  const state = {
    roomView, panels: new Map([["run-1", currentPanel]]), gateDrafts: new Map(), pendingRuns: new Map(),
    manager: { conversations: [{ id: "run-1", title: "New run", archived: false }], interactions, eventsByConversation: { "run-1": events } },
  };
  const context = vm.createContext({
    state, escapeHtml: escape, escapeAttribute: escape, renderMarkdown: escape,
    jsonRecord: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined,
    jsonString: (value) => typeof value === "string" ? value : undefined,
    formatDateTime: (value) => value, disclosureAttributes: () => "",
    activeId: () => "run-1", runPhaseOf: () => "idle", rootConversationFor: (value) => value,
    draftFor: () => ({ prompt: "", delivery: "immediate", pendingAttachments: new Map() }),
    conversationById: (id) => state.manager.conversations.find((conversation) => conversation.id === id),
    pendingInterrupts: new Set(), hasOrchestrationState: () => false, orchestrationStartButtonHtml: () => "",
    agentsAssignable: () => true,
    liveRegionAttributes: () => "", notificationBellHtml: () => "", runTabLabel: (value) => value.title,
    bachataWebviewBehavior: { runRecovery: () => undefined, runPhase: () => "idle", runStatusPresentation: () => ({ label: "Ready", spinning: false }) },
  });
  const source = ["executionRender.ts", "roomRender.ts"].map((file) => fs.readFileSync(path.join(__dirname, "../src/webview-ui", file), "utf8")).join("\n");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const api = vm.runInContext(`${code}\n;({ disagreementEventFor, finalRulingHtml, readableResultHtml, blockingDecisionCount, roomHeaderHtml, gateDraftKey, rememberGateDraft, workflowHtml });`, context);
  return { api, state, panel: currentPanel };
};

test("disagreement follows the exact current gate, completed round and attempt", () => {
  const { api, state } = load({ events: [opening(1), decision(2)], panel: { pendingGate: gate } });
  assert.equal(api.disagreementEventFor(interaction()).id, 2);
  assert.equal(api.disagreementEventFor(interaction({ humanGate: { ...gate, reason: "afterStep" } })), undefined);
  assert.equal(api.disagreementEventFor(interaction({ humanGate: { ...gate, stepId: "approve" } })), undefined);
  assert.equal(api.disagreementEventFor(interaction({ humanGate: { ...gate, decisionRound: 3 } })), undefined);
  assert.equal(api.disagreementEventFor(interaction({ status: "resolved" })), undefined);
  state.manager.eventsByConversation["run-1"].push(decision(3, "accepted"));
  assert.equal(api.disagreementEventFor(interaction()), undefined);
  state.manager.eventsByConversation["run-1"].push(opening(4));
  assert.equal(api.disagreementEventFor(interaction()), undefined);
});

test("structured review conclusions are readable and expanded without internal identities", () => {
  const { api, panel } = load({ panel: { agents: { reviewer: { name: "Reviewer" } } } });
  const html = api.finalRulingHtml(decision(2, "pending", {
    candidateId: "candidate-hidden",
    participants: [{ agentId: "reviewer", valid: true, accepted: false, candidateHash: "hash-hidden", candidate: {
      findings: [{ id: "finding-hidden", subject: "Keyboard navigation", message: "Focus escapes the dialog", severity: "warning", disposition: "unresolved", evidence: ["Press Tab at the final field"], challenges: [] }],
    }, objections: [], unresolvedRisks: [], validationErrors: [] }],
  }), panel);
  assert.match(html, /Keyboard navigation/);
  assert.match(html, /Focus escapes the dialog/);
  assert.match(html, /Press Tab at the final field/);
  assert.doesNotMatch(html, /<details|candidate-hidden|hash-hidden|finding-hidden|No selected result|Raised no objection|No objections/);
  assert.match(api.readableResultHtml({ summary: "<img onerror=alert(1)>" }), /&lt;img/);
});

test("human resolution displays its saved rationale and accurate outcome", () => {
  const { api, panel } = load({ panel: { agents: { reviewer: { name: "Accessibility reviewer" } } } });
  const unresolved = api.finalRulingHtml(decision(2, "resolved", {
    humanResolution: { action: "acceptUnresolved", rationale: "Keep both findings for triage", resolvedAt: timestamp },
  }), panel);
  assert.match(unresolved, /Your decision/);
  assert.match(unresolved, /Finished with unresolved findings/);
  assert.match(unresolved, /Keep both findings for triage/);
  assert.doesNotMatch(unresolved, /Consensus decision/);
  const selected = api.finalRulingHtml(decision(3, "ruled", {
    candidate: { summary: "Use a focus trap" }, humanResolution: { action: "acceptParticipant", rationale: "The reproduction is sufficient", selectedParticipant: "reviewer", resolvedAt: timestamp },
  }), panel);
  assert.match(selected, /Accepted Accessibility reviewer’s conclusion/);
  assert.match(selected, /Use a focus trap/);
});

test("participant consent is distinct from the conclusion selected by a person", () => {
  const { api, panel } = load({ panel: { agents: { first: { name: "First reviewer" }, second: { name: "Second reviewer" } } } });
  const html = api.finalRulingHtml(decision(4, "ruled", {
    humanResolution: { action: "acceptParticipant", selectedParticipant: "first", rationale: "Prefer the demonstrated issue", resolvedAt: timestamp },
    participants: [
      { agentId: "first", valid: true, accepted: false, candidate: "First conclusion" },
      { agentId: "second", valid: true, accepted: true, candidate: "Second conclusion" },
    ],
  }), panel);
  assert.match(html, /data-agent="first"><span>First reviewer<\/span><small>Selected conclusion/);
  assert.match(html, /data-agent="second"><span>Second reviewer<\/span><small>Supports own conclusion/);
  assert.doesNotMatch(html, /<small>Agreed/);
  assert.match(html, /compare-column accepted">\s*<header><strong>First reviewer/);
  assert.doesNotMatch(html, /compare-column accepted">\s*<header><strong>Second reviewer/);
});

test("resuming a deferred gate reuses the recorded conclusions from its existing attempt", () => {
  const { api } = load({ events: [opening(1), decision(2), { id: 3, type: "run.interrupted", createdAt: timestamp }, { id: 4, type: "run.resumed", createdAt: timestamp }], panel: { pendingGate: gate } });
  assert.equal(api.disagreementEventFor(interaction()).id, 2);
});

test("blocking count deduplicates the matching gate while keeping unrelated approvals", () => {
  const { api, state, panel } = load({ interactions: [interaction(), interaction({ interactionRef: "done", status: "resolved" })], panel: { pendingGate: gate, approvals: [{ requestId: "permission-1" }] } });
  assert.equal(api.blockingDecisionCount(panel, "run-1"), 2);
  state.manager.interactions = [interaction({ humanGate: { ...gate, stepId: "other" } })];
  assert.equal(api.blockingDecisionCount(panel, "run-1"), 3);
  state.manager.interactions = [];
  assert.equal(api.blockingDecisionCount(panel, "run-1"), 2);
});

test("Direction always offers a route back to Chat and notification settings stay reachable", () => {
  const { api, panel } = load({ roomView: "direction" });
  const html = api.roomHeaderHtml(panel, { id: "run-1", title: "New run", archived: false }, { direction: false, execution: false });
  assert.match(html, /data-view="chat"/);
  assert.doesNotMatch(html, /data-view="execution"/);
  assert.match(html, /data-action="notification-settings"/);
});

test("decision drafts remain attached to their round and attempt", () => {
  const { api, state, panel } = load({ events: [opening(1)], panel: { pendingGate: { ...gate } } });
  const first = api.gateDraftKey("run-1", panel);
  api.rememberGateDraft("run-1", panel, "Use existing evidence");
  assert.equal(state.gateDrafts.get(first), "Use existing evidence");
  panel.pendingGate.round = 6;
  const second = api.gateDraftKey("run-1", panel);
  assert.notEqual(second, first);
  api.rememberGateDraft("run-1", panel, "Check keyboard only");
  assert.equal(state.gateDrafts.has(first), false);
  state.manager.eventsByConversation["run-1"].push(opening(2));
  assert.notEqual(api.gateDraftKey("run-1", panel), second);
});

test("Execution retains the latest outcome without repeated obsolete round summaries", () => {
  const { api } = load({ events: [opening(1), decision(2, "pending", { candidate: "Obsolete draft" }), decision(3, "accepted", { candidate: "Final conclusion" })] });
  const html = api.workflowHtml("run-1");
  assert.match(html, /Final conclusion/);
  assert.doesNotMatch(html, /Obsolete draft|Participant conclusions/);
});
