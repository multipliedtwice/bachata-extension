const assert = require("node:assert/strict");
const test = require("node:test");
const { readableResultMarkdown, scrubOpaqueResultTokens } = require("../dist/results/readableResult.js");

const finding = (overrides = {}) => ({
  id: "internal-finding-identifier",
  subject: "Preserve the lease",
  message: "An older worker can publish after losing its lease.",
  disposition: "unresolved",
  severity: "error",
  location: { file: "src/worker.ts", startLine: 12, endLine: 18 },
  evidence: ["Publication does not compare the recorded token."],
  challenges: ["Confirm whether the database procedure already checks ownership."],
  provenance: { source: "pipelineDecision", stepId: "internal-step-identifier", participantIds: ["internal-agent-identifier"] },
  ...overrides,
});

const result = (overrides = {}) => ({
  status: "completed",
  changedFiles: [],
  checks: [],
  findings: [],
  providers: [],
  unresolvedRisks: [],
  recoveredErrors: [],
  evidence: [],
  evidenceGaps: [],
  expectations: { changedFiles: false, verification: true, finalRuling: true },
  finalAssessment: { outcome: "inconclusive", method: "consensus", summary: "One concern requires confirmation.", producedBy: [] },
  ...overrides,
});

test("readable result includes assessment, ruling, disposition, location, evidence and challenges", () => {
  const text = readableResultMarkdown(result({
    finalRuling: "Confirm the publication guard before changing the worker.",
    findings: [finding()],
    changedFiles: ["src/worker.ts"],
    checks: [{ command: "node verify-worker.cjs", status: "passed" }],
    unresolvedRisks: ["Concurrent attempts need reproduction."],
    evidenceGaps: ["No concurrency proof was recorded."],
  }));
  for (const expected of [
    "# Run result: Completed", "## Final assessment", "Outcome: Inconclusive",
    "One concern requires confirmation.", "## Final ruling", "Confirm the publication guard",
    "Recorded disposition: unresolved", "Severity: error", "Location: src/worker.ts:12–18",
    "Publication does not compare", "Confirm whether the database procedure",
    "## Changed files", "## Verification", "node verify-worker.cjs — Passed",
    "Concurrent attempts need reproduction.", "No concurrency proof was recorded.",
  ]) assert.ok(text.includes(expected), `Missing readable material: ${expected}`);
  assert.doesNotMatch(text, /internal-finding-identifier|internal-step-identifier|internal-agent-identifier|pipelineDecision/u);
});

test("structured assessment and ruling use allowlisted fields and omit hidden metadata recursively", () => {
  const raw = JSON.stringify({
    id: "private-ruling-identifier",
    summary: "The worker must verify publication authority.",
    sessionId: "private-session-identifier",
    providerSession: { text: "private-provider-session-content" },
    metadata: { summary: "private-metadata-summary" },
    arbitraryImplementationField: "private-implementation-value",
    provenance: { summary: "private-provenance-summary" },
    candidateHash: "a".repeat(64),
    details: { rationale: "The old attempt can finish later.", outputReference: "private-output-reference" },
    findings: [finding()],
  });
  const text = readableResultMarkdown(result({
    finalAssessment: { outcome: "completed", method: "consensus", summary: raw, producedBy: [{ name: "Private Provider", adapter: "private-adapter", agentId: "private-agent-identifier" }] },
    finalRuling: raw,
    findings: [finding()],
    retainedRunId: "private-retained-run",
    executionRef: "private-execution-reference",
    retainedWorktree: "/private/internal/worktree",
  }));
  assert.match(text, /The worker must verify publication authority/u);
  assert.match(text, /The old attempt can finish later/u);
  assert.match(text, /Recorded disposition: unresolved/u);
  assert.doesNotMatch(text, /private-|internal-|Private Provider|candidateHash|sessionId|outputReference|provenance|\{"/u);
  assert.ok(!text.includes("a".repeat(64)));
});

test("fenced and nested stringified JSON is projected instead of copied verbatim", () => {
  const nested = JSON.stringify({ summary: "Keep this nested conclusion.", sessionId: "withheld-nested-session" });
  const text = readableResultMarkdown(result({ finalRuling: `\`\`\`json\n${JSON.stringify({ summary: nested, metadata: { text: "withheld metadata" } })}\n\`\`\`` }));
  assert.match(text, /Keep this nested conclusion/u);
  assert.doesNotMatch(text, /withheld|sessionId|```json|\{"/u);
});

test("structured JSON embedded in prose loses internal fields", () => {
  const text = readableResultMarkdown(result({ finalRuling: 'Conclusion follows:\n\n```json\n{"summary":"Keep this conclusion","sessionId":"private-provider-session"}\n```' }));
  assert.match(text, /Conclusion follows/u);
  assert.match(text, /Keep this conclusion/u);
  assert.doesNotMatch(text, /sessionId|private-provider-session|```json/u);
});

test("the canonical finding disposition overrides a provider claim in a structured ruling", () => {
  const canonical = finding({ disposition: "proposed" });
  const text = readableResultMarkdown(result({
    findings: [canonical],
    finalRuling: JSON.stringify({ findings: [{ ...canonical, disposition: "accepted" }] }),
  }));
  assert.match(text, /Recorded disposition: proposed/u);
  assert.doesNotMatch(text, /Recorded disposition: accepted|Provider-reported disposition:.*accepted/u);
});

test("uncorroborated provider dispositions stay labeled as provider claims", () => {
  const text = readableResultMarkdown(result({ finalRuling: JSON.stringify({ findings: [finding({ disposition: "accepted" })] }) }));
  assert.match(text, /Provider-reported disposition:\*\* accepted/u);
  assert.doesNotMatch(text, /Recorded disposition: accepted/u);
});

test("a human unresolved decision does not promote a participant candidate to a final answer", () => {
  const text = readableResultMarkdown(result({
    finalRuling: "A misleading old candidate.",
    findings: [finding()],
    finalDecision: {
      stepId: "private-step-identity",
      status: "resolved",
      candidate: { summary: "A misleading selected candidate." },
      participants: [{ agentId: "private-agent-identity", candidate: { summary: "The provider still disputes the risk." } }],
      objections: [],
      unresolvedRisks: [],
      humanResolution: { action: "acceptUnresolved", rationale: "Proceed with the disagreement recorded.", resolvedAt: "private-resolution-time" },
    },
  }));
  assert.match(text, /no participant conclusion was accepted/u);
  assert.match(text, /Participant conclusion 1 \(unresolved\)/u);
  assert.match(text, /The provider still disputes the risk/u);
  assert.match(text, /Proceed with the disagreement recorded/u);
  assert.doesNotMatch(text, /A misleading|private-/u);
});

test("the saved final decision supplies the visible ruling before legacy ruling text", () => {
  const text = readableResultMarkdown(result({
    finalRuling: "Superseded candidate.",
    finalDecision: { stepId: "hidden-step", status: "accepted", candidate: { summary: "The recorded decision." }, participants: [], objections: [], unresolvedRisks: [] },
  }));
  assert.match(text, /The recorded decision/u);
  assert.doesNotMatch(text, /Superseded candidate|hidden-step/u);
});

test("verification records state failed, timed out, cancelled and stale checks without internal references", () => {
  const text = readableResultMarkdown(result({ checks: [
    { command: "check-failed", status: "failed", candidateTree: "private-tree", outputReference: "private-check-output" },
    { command: "check-timeout", status: "timedOut" },
    { command: "check-cancelled", status: "cancelled" },
    { command: "check-old", status: "passed", stale: true, workingDirectory: "/private/check-directory" },
  ] }));
  assert.match(text, /check-failed — Failed/u);
  assert.match(text, /check-timeout — Timed out/u);
  assert.match(text, /check-cancelled — Cancelled/u);
  assert.match(text, /check-old — Passed \(stale; does not verify the current work\)/u);
  assert.doesNotMatch(text, /private-|candidateTree|outputReference|workingDirectory/u);
});

test("failed and interrupted results preserve their useful assessment without claiming completion", () => {
  for (const [status, label] of [["error", "Failed"], ["interrupted", "Interrupted"]]) {
    const text = readableResultMarkdown(result({
      status,
      finalAssessment: { outcome: "failedBeforeRuling", method: "none", summary: "The provider stopped before deciding.", producedBy: [], failure: { error: "The connection closed.", agentId: "private-agent-id" } },
    }));
    assert.ok(text.startsWith(`# Run result: ${label}`));
    assert.match(text, /Failed before a final ruling/u);
    assert.match(text, /Failure: The connection closed/u);
    assert.doesNotMatch(text, /private-agent-id/u);
  }
});

test("missing verification is distinguished from verification outside the pipeline contract", () => {
  assert.match(readableResultMarkdown(result()), /No verification evidence was recorded/u);
  assert.match(readableResultMarkdown(result({ expectations: { verification: false, finalRuling: true, changedFiles: false } })), /declares no controller-owned verification/u);
});

test("absent and internal-only results have no copyable Markdown", () => {
  assert.equal(readableResultMarkdown(undefined), "");
  assert.equal(readableResultMarkdown(result({
    finalAssessment: { outcome: "completed", method: "none", summary: '{"sessionId":"private-session"}', producedBy: [] },
    finalRuling: '{"metadata":{"summary":"private metadata"}}',
  })), "");
});

test("malformed structured rulings do not fall back to raw metadata", () => {
  const text = readableResultMarkdown(result({ finalRuling: '{"sessionId":"private-session", "summary":' }));
  assert.doesNotMatch(text, /private-session|sessionId|\{"/u);
});

test("plain Markdown links remain readable", () => {
  const text = readableResultMarkdown(result({ finalRuling: "[Review the guard](src/worker.ts) before editing." }));
  assert.match(text, /\[Review the guard\]\(src\/worker\.ts\)/u);
});

test("known opaque identifiers and hashes mentioned in prose are withheld", () => {
  const text = readableResultMarkdown(result({
    executionRef: "execution-5906d22b-167d-4b87-bf9b-3790c847c8e2",
    finalRuling: `Review execution-5906d22b-167d-4b87-bf9b-3790c847c8e2 and ${"b".repeat(64)}.`,
  }));
  assert.doesNotMatch(text, /execution-5906d22b-167d-4b87-bf9b-3790c847c8e2/u);
  assert.ok(!text.includes("b".repeat(64)));
});

test("projection leaves the original result and metadata unchanged", () => {
  const source = result({ findings: [finding()], finalRuling: JSON.stringify({ summary: "Keep the record.", id: "private-id" }) });
  const before = structuredClone(source);
  readableResultMarkdown(source);
  assert.deepEqual(source, before);
});

test("short identity values do not corrupt ordinary failure prose and remain omitted from their owning fields", () => {
  const text = readableResultMarkdown(result({
    status: "error",
    executionRef: "E1",
    finalAssessment: {
      outcome: "failedBeforeRuling",
      method: "none",
      summary: '{"summary":"The lead will review why E1 failed to connect.","agentId":"lead","stepId":"review","executionRef":"E1"}',
      producedBy: [],
      failure: { agentId: "lead", error: "E1 failed to connect." },
    },
  }));
  assert.match(text, /The lead will review why E1 failed to connect\./u);
  assert.match(text, /Failure: E1 failed to connect\./u);
  assert.doesNotMatch(text, /agentId|stepId|executionRef|internal value omitted/u);
});

test("inline structured ruling fragments never expose bookkeeping", () => {
  const text = readableResultMarkdown(result({
    finalRuling: 'Result: {"summary":"Check the lease.","sessionId":"x","metadata":{"text":"private"}} Then confirm the race.',
  }));
  assert.match(text, /Result:.*Check the lease/u);
  assert.match(text, /Then confirm the race/u);
  assert.doesNotMatch(text, /sessionId|metadata|private|\{"/u);
});

test("numeric Markdown citations and code indexes remain intact", () => {
  const text = readableResultMarkdown(result({
    finalRuling: "[1](src/worker.ts) proves that `rows[0]` can refer to an older attempt.",
  }));
  assert.match(text, /\[1\]\(src\/worker\.ts\)/u);
  assert.match(text, /`rows\[0\]`/u);
  assert.match(readableResultMarkdown(result({ finalRuling: "[2026 update] Confirm the lease." })), /\[2026 update\] Confirm the lease/u);
});

test("public dispositions survive identical enum values in hidden provenance", () => {
  const accepted = finding({
    disposition: "accepted",
    provenance: { source: "pipelineDecision", stepId: "review", participantIds: ["lead", "worker"], decisionStatus: "accepted" },
  });
  const text = readableResultMarkdown(result({ findings: [accepted] }));
  assert.match(text, /Recorded disposition: accepted/u);
  assert.match(text, /Location: src\/worker\.ts:12–18/u);
  assert.doesNotMatch(text, /pipelineDecision|participantIds|decisionStatus/u);
});

test("ruling objections and risks accompany the visible final decision", () => {
  const text = readableResultMarkdown(result({
    finalDecision: {
      stepId: "decision-step",
      status: "accepted",
      candidate: { summary: "Inspect the final transaction." },
      participants: [],
      objections: [{ agentId: "critic", text: "The input can change between attempts.", accepted: false }],
      unresolvedRisks: ["The archive path remains unverified."],
    },
  }));
  assert.match(text, /Ruling objections:/u);
  assert.match(text, /The input can change between attempts\. — Overruled/u);
  assert.match(text, /The archive path remains unverified/u);
  assert.doesNotMatch(text, /agentId|critic|decision-step/u);
});

test("ordinary words matching hidden identity values stay intact in every result section", () => {
  const prose = "The lead will review the session reference and verify the failure evidence.";
  const source = result({
    status: "error",
    executionRef: "reference",
    resultVersion: "verify",
    session: "session",
    candidateDigest: "evidence",
    finalAssessment: {
      outcome: "failedBeforeRuling",
      method: "none",
      summary: `${prose} Assessment.`,
      producedBy: [{ agentId: "lead" }],
      failure: { stepId: "review", agentId: "lead", error: `${prose} Failure.` },
    },
    finalDecision: {
      stepId: "review",
      status: "accepted",
      candidate: { summary: `${prose} Ruling.`, agentId: "lead" },
      participants: [],
      objections: [{ agentId: "lead", text: `${prose} Objection.`, accepted: false }],
      unresolvedRisks: [],
      humanResolution: { action: "accept", rationale: `${prose} Rationale.` },
    },
    findings: [finding({
      id: "failure",
      subject: `${prose} Subject.`,
      message: `${prose} Finding.`,
      evidence: [`${prose} Evidence.`],
      challenges: [`${prose} Challenge.`],
      provenance: { stepId: "review", participantIds: ["lead"], reference: "reference" },
    })],
    unresolvedRisks: [`${prose} Risk.`],
    evidenceGaps: [`${prose} Gap.`],
    checks: [{ command: "review --lead session --reference evidence", status: "failed" }],
  });
  const before = structuredClone(source);
  const text = readableResultMarkdown(source);
  for (const section of ["Assessment", "Failure", "Ruling", "Objection", "Rationale", "Subject", "Finding", "Evidence", "Challenge", "Risk", "Gap"]) {
    assert.ok(text.includes(`${prose} ${section}.`), `Ordinary words were removed from ${section}`);
  }
  assert.match(text, /review --lead session --reference evidence — Failed/u);
  assert.doesNotMatch(text, /agentId|stepId|participantIds|executionRef|candidateDigest|resultVersion|provenance|internal value omitted|internal identifier omitted/u);
  assert.deepEqual(source, before);
});

test("human-readable identity values are omitted structurally without censoring matching prose", () => {
  const summary = "A private-execution-identifier can be a human-readable label; review the lead report.";
  const text = readableResultMarkdown(result({
    executionRef: "private-execution-identifier",
    finalRuling: JSON.stringify({
      summary,
      agentId: "lead",
      stepId: "review",
      session: "human-readable-session",
      reference: "human-readable-reference",
      digest: "human-readable-digest",
      provenance: { summary: "hidden provenance details" },
    }),
  }));
  assert.ok(text.includes(summary));
  assert.doesNotMatch(text, /agentId|stepId|human-readable-session|human-readable-reference|human-readable-digest|provenance|hidden provenance|internal value omitted/u);
});

test("known high-entropy identifiers in nested hidden records cannot reappear in visible prose", () => {
  const identities = {
    agentId: "agent_5f88Aa07xZr92cY6Mp4Ks10Dq",
    stepId: "step_2c77Nb64pFq31tX8Ls9Vh50Ea",
    session: "session_6d93Xg10sHw27jM5Qa8Lu42Bc",
    reference: "reference_9t62Av47nKe15zR8Ys3Pd06Gj",
    candidateDigest: "8c613b4eda961eab923670420cf325a1",
    provenance: { value: "provenance_7e29Gc81rWv63sB4Nm0Lk52Jx" },
    metadata: { text: "metadata_1z84Tm53yKh92cV6Df7Pw08Qa" },
  };
  const values = [...Object.values(identities).filter((value) => typeof value === "string"), identities.provenance.value, identities.metadata.text];
  const text = readableResultMarkdown(result({
    finalRuling: JSON.stringify({ ...identities, summary: `Keep the review readable: ${values.join(", ")}.` }),
  }));
  assert.match(text, /Keep the review readable/u);
  for (const value of values) assert.ok(!text.includes(value), `Opaque value leaked: ${value}`);
  assert.doesNotMatch(text, /agentId|stepId|candidateDigest|provenance|metadata/u);
});

test("opaque values recorded in inline structured fragments cannot escape through surrounding prose", () => {
  const identifier = "q3Fg8Kp1Vt6Ds9Ha2Yw7Lr0Mx";
  const text = readableResultMarkdown(result({
    finalRuling: `Review ${identifier}: ${JSON.stringify({ summary: "The lead review remains useful.", sessionId: identifier })} Confirm ${identifier} before editing.`,
  }));
  assert.match(text, /The lead review remains useful/u);
  assert.match(text, /before editing/u);
  assert.ok(!text.includes(identifier));
  assert.doesNotMatch(text, /sessionId|\{"/u);
});

test("opaque UUIDs and full hashes are removed even without recorded metadata", () => {
  const identifiers = [
    "5906d22b-167d-4b87-bf9b-3790c847c8e2", "a".repeat(32), "b".repeat(40), "c".repeat(64), "d".repeat(128),
    "session_6d93Xg10sHw27jM5Qa8Lu42Bc", "file_9t62Av47nKe15zR8Ys3Pd06Gj", "candidate_" + "e".repeat(40), "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ];
  const text = scrubOpaqueResultTokens(`Review the lead result ${identifiers.join(" ")}.`);
  assert.match(text, /Review the lead result/u);
  for (const value of identifiers) assert.ok(!text.includes(value));
  assert.equal(scrubOpaqueResultTokens("lead review E1 feedback 2026", { agentId: "lead", stepId: "review", executionRef: "E1", session: "feedback" }), "lead review E1 feedback 2026");
  assert.equal(scrubOpaqueResultTokens("session_review_before_editing file_review_publication_guard"), "session_review_before_editing file_review_publication_guard");
});

for (const command of [
  "commit abc1234", "revision: def5678", "commit `abcdefa`", "object id: abcdefa", "digest: deadbeef", "fingerprint: cafebabe",
  "git show abc1234", "git show deadbeef", "git diff abc1234..def5678", "git diff abc1234...def5678", "git diff --stat abc1234 def5678",
  "diff index abc1234..def5678", "index deadbeef..cafebabe 100644",
]) {
  test(`context identifies abbreviated Git references in ${command}`, () => {
    const text = readableResultMarkdown(result({
      finalRuling: `The lead should review ${command} before editing.`,
      checks: [{ command, status: "passed" }],
    }));
    assert.match(text, /The lead should review/u);
    assert.match(text, /before editing/u);
    assert.match(text, /\[hash omitted\]/u);
    assert.doesNotMatch(text, /abc1234|def5678|abcdefa|deadbeef|cafebabe/u);
  });
}

test("short hexadecimal words in ordinary prose are not treated as Git references", () => {
  const prose = "Review feedback before you commit feedback. A defaced facade needs review; deadbeef is an example label here.";
  assert.equal(scrubOpaqueResultTokens(prose, { agentId: "feedback", stepId: "defaced", reference: "deadbeef" }), prose);
  assert.equal(scrubOpaqueResultTokens("Review the candidate abc1234.", { candidateHash: "abc1234" }), "Review the candidate [internal identifier omitted].");
});

for (const encode of [
  (value) => value,
  (value) => JSON.stringify(value),
  (value) => JSON.stringify(JSON.stringify(value)),
  (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
  (value) => `Evidence follows: ${JSON.stringify(value)} Review remains necessary.`,
]) {
  test(`allowed prose survives structured representation ${String(encode({ summary: "review" })).slice(0, 48)}`, () => {
    const value = {
      summary: "The lead will review the evidence.",
      agentId: "lead",
      stepId: "review",
      session: "hidden-session-label",
      reference: "hidden-reference-label",
      digest: "hidden-digest-label",
      provenance: { summary: "hidden-provenance-content" },
      details: JSON.stringify({ evidence: "Review the lead evidence.", sessionId: "hidden-nested-session" }),
    };
    const source = result({ finalRuling: encode(value) });
    const before = structuredClone(source);
    const text = readableResultMarkdown(source);
    assert.match(text, /The lead will review the evidence/u);
    assert.match(text, /Review the lead evidence/u);
    assert.doesNotMatch(text, /agentId|stepId|sessionId|provenance|hidden-|internal value omitted|\{"/u);
    assert.deepEqual(source, before);
  });
}

test("locations, changed files and commands project embedded structured data before copying", () => {
  const text = readableResultMarkdown(result({
    findings: [finding({ location: { file: 'Location: {"file":"src/review.ts","session":"hidden-location-session"}', startLine: 12 } })],
    changedFiles: ['{"file":"src/lead.ts","agentId":"hidden-file-agent"}'],
    checks: [{ command: '{"command":"review --lead evidence","stepId":"hidden-command-step"}', status: "passed" }],
  }));
  assert.match(text, /src\/review\.ts/u);
  assert.match(text, /src\/lead\.ts/u);
  assert.match(text, /review --lead evidence/u);
  assert.doesNotMatch(text, /hidden-|agentId|stepId|\{"/u);
});

test("a bounded large result still scrubs a recorded abbreviated hash without changing common words", () => {
  const source = result({
    candidateHash: "abc1234",
    findings: Array.from({ length: 2_000 }, (_, index) => finding({ id: `finding-${index}` })),
    finalRuling: "The lead will review candidate abc1234, the session reference, file evidence and feedback.",
  });
  const before = structuredClone(source);
  const text = readableResultMarkdown(source);
  assert.match(text, /The lead will review candidate \[internal identifier omitted\], the session reference, file evidence and feedback\./u);
  assert.doesNotMatch(text, /abc1234|candidateHash/u);
  assert.deepEqual(source, before);
});

test("bounded multiline risk and evidence-gap entries preserve complete list indentation", () => {
  const text = readableResultMarkdown(result({
    unresolvedRisks: ["Review the lead evidence.\nConfirm the follow-up."],
    evidenceGaps: ["No independent verification.\nThe session reference remains useful."],
  }));
  assert.match(text, /- Review the lead evidence\.\n  Confirm the follow-up\./u);
  assert.match(text, /- No independent verification\.\n  The session reference remains useful\./u);
});

for (const placement of ["failure", "ruledBy", "selectedParticipant"]) {
  test(`bounded original ${placement} identity context survives projection without leaking abbreviated hashes`, () => {
    const source = result({
      findings: Array.from({ length: 2_000 }, (_, index) => finding({ id: `finding-${index}` })),
      finalRuling: "Review candidate abc1234 before editing; the lead and session reference remain readable.",
    });
    if (placement === "failure") source.failure = { error: source.finalRuling, agentId: "abc1234" };
    else source.finalDecision = {
      status: "accepted", stepId: "review", candidate: { summary: source.finalRuling }, participants: [], objections: [], unresolvedRisks: [],
      ...(placement === "ruledBy" ? { ruledBy: "abc1234" } : {
        humanResolution: { action: "acceptParticipant", selectedParticipant: "abc1234", rationale: "Confirm the lead review.", resolvedAt: "2026-09-14T00:00:00Z" },
      }),
    };
    const before = structuredClone(source);
    const text = readableResultMarkdown(source);
    assert.match(text, /Review candidate \[internal identifier omitted\] before editing/u);
    assert.match(text, /the lead and session reference remain readable/u);
    assert.doesNotMatch(text, /abc1234/u);
    assert.deepEqual(source, before);
  });
}
