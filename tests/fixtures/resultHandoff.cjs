const resultHandoffFixture = () => ({
  status: "completed",
  finalAssessment: { outcome: "inconclusive", method: "consensus", summary: "The lead should review the build before edits.", producedBy: [] },
  finalRuling: "Review the source and confirm the lead recommendation.",
  findings: [{
    id: "review",
    subject: "Confirm the review guard",
    message: "The lead must review current source.",
    disposition: "unresolved",
    location: { file: "src/worker.ts", startLine: 12 },
    evidence: ["Review the current source for the guard."],
    challenges: ["Confirm the lead conclusion before edits."],
    provenance: { source: "pipelineDecision", stepId: "review", participantIds: ["lead"], decisionStatus: "resolved" },
  }],
  changedFiles: ["src/worker.ts"],
  checks: [{ command: "node scripts/verify.cjs", status: "failed" }],
  unresolvedRisks: ["The review still needs confirmation."],
  evidenceGaps: ["No independent review was recorded."],
  providers: [],
  recoveredErrors: [],
  evidence: [],
  expectations: { changedFiles: true, verification: true, finalRuling: true },
});

const resultHandoffPlacements = [
  ["assessment", (result, text) => { result.finalAssessment.summary = text; }],
  ["assessment failure", (result, text) => { result.finalAssessment.failure = { error: text, agentId: "lead" }; }],
  ["failure", (result, text) => { result.failure = { error: text, agentId: "lead" }; }],
  ["ruling", (result, text) => { result.finalRuling = text; }],
  ["finding subject", (result, text) => { result.findings[0].subject = text; }],
  ["finding message", (result, text) => { result.findings[0].message = text; }],
  ["finding location", (result, text) => { result.findings[0].location.file = text; }],
  ["finding evidence", (result, text) => { result.findings[0].evidence = [text]; }],
  ["finding challenge", (result, text) => { result.findings[0].challenges = [text]; }],
  ["changed file", (result, text) => { result.changedFiles.push(text); }],
  ["verification command", (result, text) => { result.checks.push({ command: text, status: "failed" }); }],
  ["risk", (result, text) => { result.unresolvedRisks.push(text); }],
  ["evidence gap", (result, text) => { result.evidenceGaps.push(text); }],
  ...["candidate", "participant", "objection", "decision risk", "resolution rationale"].map((field) => [field, (result, text) => {
    result.finalDecision = {
      stepId: "review", status: field === "participant" ? "pending" : "accepted",
      candidate: { summary: "Confirm the lead review." }, participants: [], objections: [], unresolvedRisks: [],
    };
    if (field === "candidate") result.finalDecision.candidate = { summary: text };
    if (field === "participant") result.finalDecision.participants = [{ agentId: "lead", candidate: { summary: text } }];
    if (field === "objection") result.finalDecision.objections = [{ agentId: "lead", text, accepted: false }];
    if (field === "decision risk") result.finalDecision.unresolvedRisks = [text];
    if (field === "resolution rationale") result.finalDecision.humanResolution = { action: "acceptUnresolved", rationale: text, resolvedAt: "2026-09-14T00:00:00Z" };
  }]),
];

const largeResultHandoffFixture = (count = 2_048) => {
  const result = resultHandoffFixture();
  result.finalAssessment.summary += "\r\nReview the current source.\rKeep the evidence readable.\0";
  const finding = result.findings[0];
  result.findings = Array.from({ length: count }, (_, index) => ({
    ...finding,
    id: `finding-${index}`,
    subject: `Review concern ${index}: งานตรวจสอบ 😀`,
    message: `The lead must review evidence for concern ${index}.`,
    evidence: [`Review src/worker.ts for concern ${index}.`],
  }));
  result.changedFiles = Array.from({ length: count }, (_, index) => `src/worker-${index}.ts`);
  result.checks = Array.from({ length: count }, (_, index) => ({ command: `node scripts/verify-${index}.cjs`, status: "failed" }));
  result.unresolvedRisks = Array.from({ length: count }, (_, index) => `Review risk ${index}: งานตรวจสอบ 😀`);
  result.evidenceGaps = Array.from({ length: count }, (_, index) => `No independent evidence for concern ${index}.`);
  result.finalDecision = {
    stepId: "review",
    status: "pending",
    participants: Array.from({ length: count }, (_, index) => ({ agentId: `participant-${index}`, candidate: { summary: `Participant review ${index} requires confirmation.` } })),
    objections: [],
    unresolvedRisks: [],
  };
  return result;
};

module.exports = { resultHandoffFixture, resultHandoffPlacements, largeResultHandoffFixture };
