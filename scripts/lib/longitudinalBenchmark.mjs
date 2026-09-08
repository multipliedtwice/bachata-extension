export const LONGITUDINAL_ARMS = ["single", "paired"];

export const LONGITUDINAL_METRICS = [
  "newSupportedFindings",
  "falsePositives",
  "dispositions",
  "resolvedStayResolved",
  "regressions",
  "humanVisibleCoreDecisions",
  "routineCollapsed",
];

const DISPOSITIONS = ["accepted", "rejected", "unresolved"];

const idsOf = (items) => new Set(items.map((item) => item.id));

const normalizedLine = (line) => (line === undefined || line === null ? "" : String(Number(line)));

const canonicalKey = (id, file, line) => JSON.stringify([String(id), String(file), normalizedLine(line)]);

const canonicalFindingKey = (finding) => canonicalKey(finding.id, finding.file, finding.line);

const canonicalExpectedKey = (expected) => canonicalKey(expected.id, expected.file, expected.line);

const sameLocation = (finding, expected) =>
  finding.file === expected.file &&
  (expected.line === undefined || Number(finding.line) === Number(expected.line));

export const validateLongitudinalTask = (task) => {
  const errors = [];
  if (typeof task?.id !== "string" || task.id.length === 0) {
    errors.push("task.id is required");
  }
  if (!Array.isArray(task?.rounds) || task.rounds.length < 3) {
    errors.push(`${String(task?.id)} declares fewer than three rounds, so it measures no accumulation`);
  }
  LONGITUDINAL_ARMS.forEach((arm) => {
    if (!Array.isArray(task?.arms?.[arm]?.pipelineIds) || task.arms[arm].pipelineIds.length === 0) {
      errors.push(`${String(task?.id)} arm ${arm} declares no pipeline`);
    }
  });
  const key = task?.answerKey ?? {};
  if (!Array.isArray(key.requiredFindings) || key.requiredFindings.length === 0) {
    errors.push(`${String(task?.id)} declares no required finding`);
  }
  if (!Array.isArray(key.forbiddenFindings) || key.forbiddenFindings.length === 0) {
    errors.push(`${String(task?.id)} names no false positive`);
  }
  if (!Array.isArray(key.routineInformation) || key.routineInformation.length === 0) {
    errors.push(`${String(task?.id)} names no routine information that must collapse`);
  }
  if (!Array.isArray(key.coreDecisions) || key.coreDecisions.length === 0) {
    errors.push(`${String(task?.id)} names no core decision a human must see`);
  }
  const declared = new Set(task?.metrics ?? []);
  LONGITUDINAL_METRICS.forEach((metric) => {
    if (!declared.has(metric)) {
      errors.push(`${String(task?.id)} does not declare the ${metric} metric`);
    }
  });
  (task?.rounds ?? []).forEach((round, index) => {
    if (round.index !== index + 1) {
      errors.push(`${String(task?.id)} round ${String(index + 1)} is misnumbered`);
    }
    if (round.kind !== "freshReview" && round.kind !== "correction" && round.kind !== "validation") {
      errors.push(`${String(task?.id)} round ${String(index + 1)} declares an unknown kind`);
    }
  });
  return errors;
};

export const validateLongitudinalRunRecord = (task, arm, record) => {
  const errors = [];
  if (record?.taskId !== task.id) errors.push("record taskId does not match the task");
  if (record?.arm !== arm) errors.push("record arm does not match the file it is recorded in");
  if (!Array.isArray(record?.rounds)) {
    errors.push("record declares no rounds");
    return errors;
  }
  if (record.rounds.length !== task.rounds.length) {
    errors.push(
      `record declares ${String(record.rounds.length)} rounds; the task declares ${String(task.rounds.length)}`,
    );
  }
  const identityCanonical = new Map();
  const canonicalIdentity = new Map();
  record.rounds.forEach((round, index) => {
    if (round.index !== index + 1) errors.push(`recorded round ${String(index + 1)} is misnumbered`);
    if (!Array.isArray(round.findings)) errors.push(`recorded round ${String(index + 1)} has no findings list`);
    if (!Array.isArray(round.decisionsShownToHuman)) {
      errors.push(`recorded round ${String(index + 1)} does not state which decisions a human saw`);
    }
    (round.findings ?? []).forEach((finding) => {
      if (typeof finding?.identity !== "string" || finding.identity.length === 0) {
        errors.push(`recorded round ${String(index + 1)} has a finding with no stable identity`);
      }
      if (finding?.disposition !== undefined && !DISPOSITIONS.includes(finding.disposition)) {
        errors.push(`recorded round ${String(index + 1)} has an unknown disposition`);
      }
      if (typeof finding?.identity === "string" && finding.identity.length > 0) {
        const canonical = canonicalFindingKey(finding);
        const priorIdentity = canonicalIdentity.get(canonical);
        if (priorIdentity !== undefined && priorIdentity !== finding.identity) {
          errors.push(
            `recorded round ${String(index + 1)} gives one finding location two identities: ${priorIdentity} and ${finding.identity}`,
          );
        } else {
          canonicalIdentity.set(canonical, finding.identity);
        }
        const priorCanonical = identityCanonical.get(finding.identity);
        if (priorCanonical !== undefined && priorCanonical !== canonical) {
          errors.push(
            `recorded round ${String(index + 1)} reuses identity ${finding.identity} for a different finding location`,
          );
        } else {
          identityCanonical.set(finding.identity, canonical);
        }
      }
    });
  });
  return errors;
};

const emptyTotals = () => ({
  newSupportedFindings: 0,
  falsePositives: 0,
  dispositions: { accepted: 0, rejected: 0, unresolved: 0 },
  regressions: 0,
  humanVisibleCoreDecisions: 0,
  routineOccurrences: 0,
  routineTrackedIdentities: 0,
  resolvedReopenedWithoutEvidence: 0,
});

export const scoreLongitudinalRun = (task, record) => {
  const required = task.answerKey.requiredFindings;
  const forbidden = idsOf(task.answerKey.forbiddenFindings);
  const routine = idsOf(task.answerKey.routineInformation);
  const coreDecisions = idsOf(task.answerKey.coreDecisions);
  const totals = emptyTotals();
  const supportedSeen = new Set();
  const routineIdentities = new Set();
  const resolved = new Set();
  const rounds = [];

  record.rounds.forEach((round) => {
    const roundScore = {
      index: round.index,
      newSupportedFindings: 0,
      repeatedSupportedFindings: 0,
      falsePositives: 0,
      regressions: 0,
      dispositions: { accepted: 0, rejected: 0, unresolved: 0 },
      humanVisibleCoreDecisions: 0,
      routineOccurrences: 0,
    };
    const seenThisRound = new Set();

    (round.findings ?? []).forEach((finding) => {
      const expected = required.find(
        (item) => item.id === finding.id && sameLocation(finding, item),
      );
      if (forbidden.has(finding.id)) {
        roundScore.falsePositives += 1;
        totals.falsePositives += 1;
      }
      if (routine.has(finding.id)) {
        roundScore.routineOccurrences += 1;
        totals.routineOccurrences += 1;
        routineIdentities.add(canonicalFindingKey(finding));
      }
      if (expected === undefined) return;
      const canonical = canonicalExpectedKey(expected);
      if (seenThisRound.has(canonical)) return;
      seenThisRound.add(canonical);
      if (supportedSeen.has(canonical)) {
        roundScore.repeatedSupportedFindings += 1;
      } else {
        supportedSeen.add(canonical);
        roundScore.newSupportedFindings += 1;
        totals.newSupportedFindings += 1;
      }
      if (resolved.has(canonical)) {
        resolved.delete(canonical);
        roundScore.regressions += 1;
        totals.regressions += 1;
        if (!Array.isArray(finding.materialDelta) || finding.materialDelta.length === 0) {
          totals.resolvedReopenedWithoutEvidence += 1;
        }
      }
      if (finding.disposition !== undefined) {
        roundScore.dispositions[finding.disposition] += 1;
        totals.dispositions[finding.disposition] += 1;
      }
    });

    if (round.kind === "freshReview") {
      supportedSeen.forEach((canonical) => {
        if (!seenThisRound.has(canonical)) resolved.add(canonical);
      });
    }

    const shown = (round.decisionsShownToHuman ?? []).filter((id) => coreDecisions.has(id));
    roundScore.humanVisibleCoreDecisions = shown.length;
    totals.humanVisibleCoreDecisions += shown.length;
    rounds.push(roundScore);
  });

  totals.routineTrackedIdentities = routineIdentities.size;
  return {
    taskId: task.id,
    arm: record.arm,
    rounds,
    totals,
    resolvedFindings: [...resolved],
    resolvedStayResolved: totals.resolvedReopenedWithoutEvidence === 0,
    routineCollapsed:
      totals.routineOccurrences === 0 ||
      totals.routineTrackedIdentities <= task.answerKey.routineInformation.length,
    unsupportedNoise: totals.falsePositives,
  };
};

export const compareLongitudinalArms = (single, paired) => {
  if (!single || !paired) {
    return {
      eligible: false,
      reason: "one arm has no recorded rounds, so this task supports no comparison",
    };
  }
  return {
    eligible: true,
    newSupportedFindings: {
      single: single.totals.newSupportedFindings,
      paired: paired.totals.newSupportedFindings,
    },
    falsePositives: {
      single: single.totals.falsePositives,
      paired: paired.totals.falsePositives,
    },
    regressions: { single: single.totals.regressions, paired: paired.totals.regressions },
    humanVisibleCoreDecisions: {
      single: single.totals.humanVisibleCoreDecisions,
      paired: paired.totals.humanVisibleCoreDecisions,
    },
    resolvedStayResolved: {
      single: single.resolvedStayResolved,
      paired: paired.resolvedStayResolved,
    },
    routineCollapsed: { single: single.routineCollapsed, paired: paired.routineCollapsed },
  };
};

export const LONGITUDINAL_NO_CLAIM =
  "No longitudinal arm has an eligible result in both arms. This benchmark supports no claim about accumulated refinement across cycles.";

export const longitudinalVerdict = (comparisons, designErrors = []) => {
  if (designErrors.length > 0) {
    return `The longitudinal benchmark design is invalid, so it supports no claim: ${designErrors.join("; ")}`;
  }
  const eligible = comparisons.filter((comparison) => comparison?.eligible === true);
  if (eligible.length === 0) return LONGITUDINAL_NO_CLAIM;
  const pairedNeverWorse = eligible.every(
    (comparison) =>
      comparison.falsePositives.paired <= comparison.falsePositives.single &&
      comparison.newSupportedFindings.paired >= comparison.newSupportedFindings.single,
  );
  return pairedNeverWorse
    ? `Across ${String(eligible.length)} longitudinal task(s), the paired arm found at least as many supported findings with no more false positives. This is a measurement over committed fixtures, not a correctness proof.`
    : `Across ${String(eligible.length)} longitudinal task(s), the paired arm did not dominate the single arm. This benchmark supports no pairing claim.`;
};
