const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const { projectRunResult, parseRunResult, mergeRunResults } = require("../dist/results/projectResult.js");
const { finalRulingFor } = require("../dist/conversations/catalogViews.js");
const { catalogEventView } = require("../dist/conversations/catalogViews.js");
const { humanResolutionSummary } = require("../dist/conversations/runResultProjection.js");
const { parseDecisionParticipant, buildDecisionArtifact } = require("../dist/pipeline/output.js");

const filename = path.join(__dirname, "webviewDom.test.cjs");
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(__dirname);
fixture.require = (id) => id === "node:test" ? () => undefined : Module.prototype.require.call(fixture, id);
fixture._compile(`${fs.readFileSync(filename, "utf8")}\nmodule.exports = { bootWebview, managerState, panelState, pipelineDefinition };`, filename);
const { bootWebview, managerState, panelState, pipelineDefinition } = fixture.exports;

const identities = [
  { agentId: "lead", provider: "Usability reviewer", adapter: "codex-app-server" },
  { agentId: "worker", provider: "Accessibility reviewer", adapter: "claude-code" },
];
const candidate = {
  title: "Review conclusion",
  summary: "Keep the decision visible",
  findings: [{ id: "internal-finding-id", subject: "Decision placement", message: "Move the decision above long output", severity: "warning", disposition: "accepted", evidence: ["Reproduced"], challenges: ["Both reviewers confirmed"] }],
};
const resultFor = (overrides = {}) => projectRunResult({
  status: "completed",
  transcript: [],
  changedFiles: [],
  checks: [],
  finalRuling: finalRulingFor({ decisionCandidate: candidate }),
  expectations: { changedFiles: false, verification: false, finalRuling: true },
  providers: identities.map((identity) => ({ ...identity, name: identity.provider })),
  rulingProvenance: { kind: "unanimousConsensus", participants: identities },
  ...overrides,
});
const event = (id, type, extra = {}) => ({ id, type, createdAt: "2026-09-13T00:00:00Z", summary: type, ...extra });
const openResult = (result, events = [], panelOverrides = {}) => {
  const harness = bootWebview(managerState({ resultsByConversation: { "run-1": result }, eventsByConversation: { "run-1": events } }), panelState({ workflowStatus: "completed", ...panelOverrides }));
  harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
  return harness;
};

test("completed structured decisions have one readable canonical result", () => {
  const events = [
    event(1, "run.started"),
    event(2, "decision.published", { stepId: "review", payload: { stepId: "review", status: "accepted", candidate, participants: identities.map((identity) => ({ agentId: identity.agentId, accepted: true, valid: true, candidate })) } }),
    event(3, "run.completed"),
  ];
  const harness = openResult(resultFor(), events);
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
    assert.ok(harness.document.root.querySelector(".result-center .final-ruling-card"));
    assert.match(html, /<strong>Decision placement<\/strong>/u);
    assert.match(html, /<ul class="result-items result-items-text">/u);
    assert.doesNotMatch(html, /&quot;findings&quot;|internal-finding-id/u);
    assert.doesNotMatch(html, /<h3>Changed files<\/h3>|<h3>Verification<\/h3>|<h3>Unresolved risks<\/h3>/u);
  } finally { harness.restore(); }
});

test("persisted structured results remain readable without retained events", () => {
  const harness = openResult(resultFor());
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /<strong>Decision placement<\/strong>/u);
    assert.doesNotMatch(html, /&quot;findings&quot;|internal-finding-id/u);
  } finally { harness.restore(); }
});

test("long bounded event previews do not duplicate or shorten the final conclusion", () => {
  const fullCandidate = { ...candidate, summary: "Detailed conclusion ".repeat(100) + "last retained sentence" };
  const events = [event(1, "run.started"), event(2, "decision.published", { stepId: "review", payload: { stepId: "review", status: "accepted", candidate: { ...fullCandidate, summary: fullCandidate.summary.slice(0, 1024) + "…" }, participants: [] } }), event(3, "run.completed")];
  const result = resultFor({ finalRuling: finalRulingFor({ decisionCandidate: fullCandidate }), finalDecisionEventId: 2 });
  assert.equal(parseRunResult(result).finalDecisionEventId, 2);
  assert.equal(mergeRunResults(result, result).finalDecisionEventId, 2);
  const harness = openResult(result, events);
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
    assert.match(html, /last retained sentence/u);
  } finally { harness.restore(); }
});

test("unmatched structured output findings remain alongside the final conclusion", () => {
  const shared = { ...candidate.findings[0], provenance: { source: "pipelineDecision", stepId: "review", participantIds: ["lead", "worker"], decisionStatus: "accepted" } };
  const extra = { ...shared, id: "additional-finding", subject: "An independent remaining issue", message: "Do not lose this output finding" };
  const events = [event(1, "run.started"), event(2, "decision.published", { stepId: "review", payload: { stepId: "review", status: "accepted", candidate, participants: [] } }), event(3, "run.completed")];
  const harness = openResult(resultFor({ findings: [shared, extra], finalDecisionEventId: 2 }), events);
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /<strong>An independent remaining issue<\/strong>/u);
    assert.equal((html.match(/<strong>Decision placement<\/strong>/gu) ?? []).length, 1);
  } finally { harness.restore(); }
});

test("long plain-text conclusions retain their full text after deduplication", () => {
  const text = "A detailed plain conclusion. ".repeat(100) + "last plain sentence";
  const events = [event(1, "run.started"), event(2, "decision.published", { payload: { status: "accepted", candidate: text.slice(0, 1024) + "…", participants: [] } }), event(3, "run.completed")];
  const harness = openResult(resultFor({ finalRuling: text, finalDecisionEventId: 2 }), events);
  try {
    assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
    assert.match(harness.document.root.innerHTML, /last plain sentence/u);
  } finally { harness.restore(); }
});

test("missing required verification stays visible while inapplicable panels disappear", () => {
  const harness = openResult(resultFor({ expectations: { changedFiles: false, verification: true, finalRuling: true } }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /<h3>Verification<\/h3><p class="muted">No verification evidence was recorded\./u);
    assert.doesNotMatch(html, /<h3>Changed files<\/h3>|<h3>Unresolved risks<\/h3>/u);
  } finally { harness.restore(); }
});

test("missing expected changed-file evidence remains visible", () => {
  const harness = openResult(resultFor({ changedFiles: undefined, expectations: { changedFiles: true, verification: false, finalRuling: true } }));
  try {
    assert.match(harness.document.root.innerHTML, /<h3>Changed files<\/h3><p class="muted">No changed files were recorded\./u);
  } finally { harness.restore(); }
});

test("selecting a conclusion does not claim every other objection was overruled", () => {
  const events = [event(1, "run.started"), event(2, "decision.published", { stepId: "review", payload: {
    stepId: "review", status: "ruled", candidate,
    humanResolution: { action: "acceptParticipant", selectedParticipant: "worker", rationale: "Use the clearer conclusion", resolvedAt: "2026-09-13T00:00:00Z" },
    participants: identities.map((identity) => ({ agentId: identity.agentId, valid: true, accepted: identity.agentId === "worker", candidate })),
    objections: [{ agentId: "lead", text: "Retain this concern", accepted: false }, { agentId: "worker", text: "Selected position", accepted: true }],
  } }), event(3, "run.completed")];
  const harness = openResult(resultFor({ finalRuling: "Finished with the participant conclusion you selected.", rulingProvenance: { kind: "humanResolution", resolvedBy: "You", participants: identities } }), events);
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /Retain this concern[\s\S]*?Not resolved/u);
    assert.match(html, /Selected position[\s\S]*?Aligned/u);
    assert.doesNotMatch(html, />Overruled</u);
  } finally { harness.restore(); }
});

test("human completion marks untouched future steps as not run", () => {
  const pipeline = pipelineDefinition();
  pipeline.steps = [{ ...pipeline.steps[0], id: "review", name: "Review independently" }, { ...pipeline.steps[0], id: "apply", name: "Apply reviewed work" }];
  const events = [event(1, "run.started", { attempt: { steps: pipeline.steps } }), event(2, "step.started", { stepId: "review" }), event(3, "run.completed")];
  const harness = openResult(resultFor(), events, { selectedPipelineDefinition: pipeline });
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /pipeline-step-notRun[\s\S]*?Apply reviewed work[\s\S]*?Not run/u);
    assert.doesNotMatch(html, /pipeline-step-waiting/u);
  } finally { harness.restore(); }
});

test("interrupted recoverable work retains waiting steps", () => {
  const pipeline = pipelineDefinition();
  pipeline.steps = [{ ...pipeline.steps[0], id: "review", name: "Review independently" }, { ...pipeline.steps[0], id: "apply", name: "Apply reviewed work" }];
  const events = [event(1, "run.started", { attempt: { steps: pipeline.steps } }), event(2, "step.started", { stepId: "review" }), event(3, "run.interrupted")];
  const harness = openResult(resultFor({ status: "interrupted" }), events, { workflowStatus: "interrupted", selectedPipelineDefinition: pipeline });
  try {
    assert.match(harness.document.root.innerHTML, /pipeline-step-waiting[\s\S]*?Apply reviewed work[\s\S]*?Waiting/u);
  } finally { harness.restore(); }
});

test("result provenance keeps useful names and removes internal references", () => {
  const finding = { ...candidate.findings[0], provenance: { source: "pipelineDecision", stepId: "internal-step-id", participantIds: ["lead", "worker"], decisionStatus: "accepted" } };
  const harness = openResult(resultFor({ finalRuling: "Accepted", findings: [finding], checks: [{ command: "Verify", status: "passed", exitCode: 0, workingDirectory: "/workspace", candidateTree: "internal-tree-ref", outputReference: "internal-output-ref" }] }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /Usability reviewer/u);
    assert.match(html, /Exit status<\/dt><dd>0<\/dd>/u);
    assert.doesNotMatch(html, /internal-step-id|internal-tree-ref|internal-output-ref|Candidate tree|Output reference/u);
  } finally { harness.restore(); }
});

test("human-selected conclusions survive bounded previews, persistence and absent events", () => {
  for (const selected of [
    "Complete selected conclusion. ".repeat(150) + "FINAL ACCEPTANCE RULE",
    { ...candidate, summary: "Complete selected conclusion. ".repeat(150) + "FINAL ACCEPTANCE RULE" },
  ]) {
    const decision = {
      stepId: "review", status: "ruled", candidate: selected,
      humanResolution: { action: "acceptParticipant", selectedParticipant: "worker", rationale: "Keep the complete analysis", resolvedAt: "2026-09-13T00:00:00Z" },
      participants: identities.map((identity) => ({ agentId: identity.agentId, valid: true, accepted: true, candidate: selected })),
    };
    const projected = resultFor({ finalRuling: humanResolutionSummary(decision), finalDecision: decision, finalDecisionEventId: 2 });
    const persisted = parseRunResult(JSON.parse(JSON.stringify(projected)));
    const restored = mergeRunResults(persisted, resultFor({ finalRuling: undefined }));
    assert.deepEqual(restored.finalDecision.candidate, selected);
    for (const events of [[], [event(1, "run.started"), catalogEventView(event(2, "decision.published", { payload: decision })), event(3, "run.completed")]]) {
      const harness = openResult(restored, events);
      try {
        assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
        assert.match(harness.document.root.innerHTML, /FINAL ACCEPTANCE RULE/u);
        assert.match(harness.document.root.innerHTML, /Keep the complete analysis/u);
      } finally { harness.restore(); }
    }
  }
});

test("finishing unresolved retains every complete participant conclusion without events", () => {
  const participants = identities.map((identity, index) => ({
    agentId: identity.agentId, valid: true, accepted: true,
    candidate: { ...candidate, summary: "Participant analysis. ".repeat(150) + `FINAL CONCLUSION ${index}` },
  }));
  const decision = {
    stepId: "review", status: "resolved", participants,
    humanResolution: { action: "acceptUnresolved", rationale: "Preserve the disagreement", resolvedAt: "2026-09-13T00:00:00Z" },
  };
  const result = parseRunResult(JSON.parse(JSON.stringify(resultFor({ finalRuling: humanResolutionSummary(decision), finalDecision: decision }))));
  const harness = openResult(result);
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /FINAL CONCLUSION 0/u);
    assert.match(html, /FINAL CONCLUSION 1/u);
    assert.match(html, /Warning · Unresolved/u);
    assert.equal(harness.document.root.querySelectorAll(".result-finding-list").length, 0);
    assert.doesNotMatch(html, /<small>Agreed<\/small>|compare-column accepted/u);
  } finally { harness.restore(); }
});

test("primary finding dispositions use normalized evidence while comparisons name provider claims", () => {
  const proposed = { findings: [{ ...candidate.findings[0], evidence: [], challenges: [] }] };
  const participants = identities.map((identity) => parseDecisionParticipant(identity.agentId,
    JSON.stringify({ candidate: proposed, accepted: true }),
    { candidateField: "candidate", acceptedField: "accepted", acceptedValue: true, candidateShape: "ruledModelFindingSet" }));
  const decision = buildDecisionArtifact({ stepId: "review", round: 1, policy: "unanimous", participants });
  assert.equal(decision.status, "accepted");
  const result = resultFor({ finalRuling: finalRulingFor({ decisionCandidate: decision.candidate }), finalDecision: decision, finalDecisionEventId: 2 });
  assert.equal(result.findings[0].disposition, "proposed");
  for (const retained of [result, parseRunResult(JSON.parse(JSON.stringify(result)))]) {
    const harness = openResult(retained);
    try {
      const html = harness.document.root.innerHTML;
      const primary = html.split('<div class="compare-grid">')[0];
      assert.match(primary, /Warning · Proposed/u);
      assert.doesNotMatch(primary, /Warning · Accepted/u);
      assert.match(html, /Provider claim: Accepted/u);
      assert.equal(harness.document.root.querySelectorAll(".result-finding-list").length, 0);
    } finally { harness.restore(); }
  }
});

test("different supported proposals are not labelled as shared agreement", () => {
  const participants = identities.map((identity, index) => parseDecisionParticipant(identity.agentId,
    JSON.stringify({ candidate: `Different conclusion ${index}`, accepted: true }),
    { candidateField: "candidate", acceptedField: "accepted", acceptedValue: true }));
  const decision = buildDecisionArtifact({ stepId: "review", round: 1, policy: "unanimous", participants });
  assert.equal(decision.status, "pending");
  const harness = openResult(resultFor({ finalRuling: undefined }), [event(1, "run.started"), event(2, "decision.published", { payload: decision })]);
  try {
    const html = harness.document.root.innerHTML;
    assert.equal((html.match(/Supports own conclusion/gu) ?? []).length, 2);
    assert.doesNotMatch(html, /<small>Agreed<\/small>|compare-column accepted/u);
  } finally { harness.restore(); }
});

test("shared agreement remains accurate for semantically equal reordered candidates", () => {
  const decision = {
    stepId: "review", status: "accepted", candidate: { title: "Chosen", summary: "Shared conclusion" },
    participants: [{ agentId: "lead", valid: true, accepted: true, candidate: { summary: "Shared conclusion", title: "Chosen" } }],
  };
  const harness = openResult(resultFor({ finalDecision: decision }));
  try {
    assert.match(harness.document.root.innerHTML, /compare-column accepted[\s\S]*?<small>Agreed<\/small>/u);
  } finally { harness.restore(); }
});

test("canonical decisions never carry over into a different result execution", () => {
  const saved = resultFor({ executionRef: "E1", finalDecision: { stepId: "review", status: "accepted", candidate } });
  assert.equal(mergeRunResults(saved, resultFor({ executionRef: "E5", finalRuling: undefined })).finalDecision, undefined);
  assert.equal(mergeRunResults(saved, resultFor({ executionRef: "E1", finalRuling: "A different completion" })).finalDecision, undefined);
  assert.equal(parseRunResult({ ...saved, finalDecision: { stepId: "review", status: "not-a-decision", candidate } }).finalDecision, undefined);
});


test("stopped pending reviews retain participant conclusions independently of event previews", () => {
  const participants = identities.map((identity, index) => ({
    agentId: identity.agentId, valid: true, accepted: true,
    candidate: { summary: `Review ${index}: ` + "Full participant conclusion. ".repeat(100) + `FINAL RULE ${index}` },
    objections: [], unresolvedRisks: [], validationErrors: [],
  }));
  const decision = { stepId: "review", status: "pending", round: 2, participants };
  const result = resultFor({ status: "interrupted", finalRuling: undefined, rulingProvenance: undefined,
    finalDecision: decision, finalDecisionEventId: 2, executionRef: "E1" });
  const restored = parseRunResult(JSON.parse(JSON.stringify(result)));
  assert.equal(restored.finalRuling, undefined);
  assert.equal(restored.finalDecision.status, "pending");
  assert.equal(restored.rulingProvenance, undefined);
  const bounded = catalogEventView({ ...event(2, "decision.published"), runRef: "run-1", payload: decision });
  assert.doesNotMatch(JSON.stringify(bounded.payload), /FINAL RULE/u);
  for (const events of [[], [event(1, "run.started"), bounded, event(3, "run.interrupted")]]) {
    const harness = openResult(restored, events, { workflowStatus: "interrupted" });
    try {
      const html = harness.document.root.innerHTML;
      assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
      assert.match(html, /Unresolved review/u);
      assert.match(html, /FINAL RULE 0/u);
      assert.match(html, /FINAL RULE 1/u);
      assert.doesNotMatch(html, />Agreed<|No output was published|Consensus decision/u);
    } finally { harness.restore(); }
  }
  const previous = resultFor({ status: "interrupted", finalRuling: undefined, rulingProvenance: undefined,
    finalDecision: { ...decision, participants: [{ ...participants[0], candidate: "Earlier round" }] },
    finalDecisionEventId: 1, executionRef: "E1" });
  assert.deepEqual(mergeRunResults(previous, restored).finalDecision, restored.finalDecision);
  assert.equal(mergeRunResults(previous, restored).finalDecisionEventId, 2);
  const resolved = resultFor({ finalRuling: "Resolved conclusion", finalDecision: { ...decision, status: "accepted", candidate: "Resolved conclusion" }, finalDecisionEventId: 4, executionRef: "E1" });
  assert.equal(mergeRunResults(restored, resolved).finalDecision.status, "accepted");
});

test("missing preview content links to the recorded message without claiming no output", () => {
  const pipeline = { ...pipelineDefinition("review"), steps: [{ id: "review", name: "Review interface", kind: "prompt", agent: "lead", prompt: "Review" }] };
  const decision = { stepId: "review", status: "pending", participants: [{ agentId: "lead", valid: true, accepted: true }] };
  const harness = openResult(resultFor({ status: "interrupted", finalRuling: undefined, rulingProvenance: undefined,
    finalDecision: decision }), [], { workflowStatus: "interrupted", selectedPipelineDefinition: pipeline,
    transcript: [{ id: "actual-review-answer", kind: "answer", agentId: "lead", step: "Review interface", text: "The recorded conclusion", createdAt: "2026-09-13T00:00:00Z" },
      { id: "other-step-answer", kind: "answer", agentId: "lead", step: "A later step", text: "A different conclusion", createdAt: "2026-09-13T00:01:00Z" }] });
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /This saved preview does not include the conclusion/u);
    assert.doesNotMatch(html, /No output was published/u);
    const link = harness.document.root.querySelector('[data-action="focus-agent-output"][data-message-id="actual-review-answer"]');
    assert.ok(link);
    assert.match(html, /data-message-id="actual-review-answer">Open participant message<\/button>/u);
    link.click();
    assert.equal(harness.document.activeElement.dataset.entry, "actual-review-answer");
  } finally { harness.restore(); }
});
