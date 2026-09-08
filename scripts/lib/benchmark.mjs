export const ARMS = ["single", "paired"];

const SHA256 = /^[0-9a-f]{64}$/u;

const idsOf = (items) => new Set(items.map((item) => item.id));

const sameLocation = (finding, expected) =>
  finding.file === expected.file &&
  (finding.line === undefined || expected.line === undefined ||
    Math.abs(Number(finding.line) - Number(expected.line)) <= 2);

export const armVerification = (task, arm) =>
  task.arms?.[arm]?.requiredVerification ?? [];

export const armPipelineIds = (task, arm) => task.arms?.[arm]?.pipelineIds ?? [];

const providerKey = (provider) =>
  `${String(provider?.name)}|${String(provider?.adapter)}|${String(provider?.model)}`;

const sortedKeys = (providers) => providers.map(providerKey).sort();

const checkKey = (check) => `${String(check?.command)}|${String(check?.status)}`;

const bundleSection = (bundle) =>
  bundle && typeof bundle === "object" && bundle.run && typeof bundle.run === "object"
    ? bundle.run
    : undefined;

export const crossCheckBundle = (run, bundle, where) => {
  const section = bundleSection(bundle);
  if (!section) return [`${where} run bundle is not a Bachata run bundle`];
  const errors = [];
  const summary = section.run;
  const result = section.result;
  if (!summary || typeof summary !== "object") {
    errors.push(`${where} run bundle records no run summary`);
  } else if (summary.selectedPipelineId !== run.pipelineId) {
    errors.push(`${where} run bundle ran pipeline ${String(summary.selectedPipelineId)}, not ${String(run.pipelineId)}`);
  }
  const bundleProviders = Array.isArray(summary?.participants) ? summary.participants : [];
  const recordProviders = run.provenance?.providers ?? [];
  if (bundleProviders.length === 0) {
    errors.push(`${where} run bundle records no participants`);
  } else if (
    sortedKeys(bundleProviders).join(",") !== sortedKeys(recordProviders).join(",")
  ) {
    errors.push(`${where} providers do not match the run bundle participants`);
  }
  if (!result || typeof result !== "object") {
    errors.push(`${where} run bundle records no run result`);
    return errors;
  }
  const bundleChecks = Array.isArray(result.checks) ? result.checks : [];
  const recordChecks = run.verification ?? [];
  if (bundleChecks.map(checkKey).sort().join(",") !== recordChecks.map(checkKey).sort().join(",")) {
    errors.push(`${where} verification does not match the run bundle`);
  }
  const bundleFiles = Array.isArray(result.changedFiles) ? [...result.changedFiles].sort() : [];
  const recordFiles = [...(run.changedFiles ?? [])].sort();
  if (bundleFiles.join(",") !== recordFiles.join(",")) {
    errors.push(`${where} changed files do not match the run bundle`);
  }
  if (result.status !== run.completion) {
    errors.push(`${where} completion ${String(run.completion)} does not match the run bundle status ${String(result.status)}`);
  }
  return errors;
};

export const taskExternalAccess = (task) =>
  Array.isArray(task?.externalAccess) ? task.externalAccess.filter((item) => typeof item === "string") : [];

export const validateTaskDesign = (task) => {
  const errors = [];
  const where = `benchmarks/tasks/${String(task.id)}.json`;
  // A boundary task is one the committed fixture cannot settle. It is only a fair comparison
  // if both arms are handed the same outside access, and only an honest one if the task says
  // what that access is.
  const access = taskExternalAccess(task);
  if (access.length > 0 && typeof task.boundary !== "string") {
    errors.push(
      `${where} declares external access but does not state why the committed fixture cannot settle it`,
    );
  }
  ARMS.forEach((arm) => {
    const armAccess = task.arms?.[arm]?.externalAccess;
    if (armAccess !== undefined) {
      errors.push(
        `${where} gives the ${arm} arm its own external access; both arms must receive exactly the access the task declares`,
      );
    }
  });
  const declared = ARMS.map((arm) => armVerification(task, arm).slice().sort().join(","));
  if (new Set(declared).size > 1) {
    errors.push(
      `${where} declares different required verification per arm (${declared.join(" vs ")}); arms that are not held to the same proof cannot be compared`,
    );
  }
  if (task.kind === "fix") {
    if (armVerification(task, "single").length === 0) {
      errors.push(`${where} is a fix task that requires no controller verification in any arm`);
    }
    if (typeof task.answerKey?.referenceFile !== "string") {
      errors.push(`${where} is a fix task with no answerKey.referenceFile, so correctness cannot be checked against a reference`);
    }
  }
  ARMS.forEach((arm) => {
    if (armPipelineIds(task, arm).length === 0) {
      errors.push(`${where} names no ${arm} pipeline`);
    }
  });
  return errors;
};

export const validateRunRecord = (task, arm, run, context) => {
  const errors = [];
  const where = `benchmarks/runs/${task.id}/${arm}.json`;
  if (!run || typeof run !== "object") return [`${where} is not a JSON object`];
  if (run.taskId !== task.id) errors.push(`${where} names task ${String(run.taskId)}`);
  if (run.arm !== arm) errors.push(`${where} names arm ${String(run.arm)}`);
  if (!armPipelineIds(task, arm).includes(run.pipelineId)) {
    errors.push(`${where} names pipeline ${String(run.pipelineId)}, which is not an ${arm} pipeline for this task`);
  }
  const provenance = run.provenance;
  if (!provenance || typeof provenance !== "object") {
    return [...errors, `${where} records no provenance block`];
  }
  if (provenance.extensionVersion !== context.extensionVersion) {
    errors.push(`${where} was produced by extension ${String(provenance.extensionVersion)}, not ${context.extensionVersion}`);
  }
  if (!SHA256.test(String(provenance.artifactSha256 ?? ""))) {
    errors.push(`${where} records no sha256 of the extension artifact under test`);
  }
  const artifact = context.artifact;
  if (typeof provenance.artifactPath !== "string" || provenance.artifactPath.length === 0) {
    errors.push(`${where} does not name the extension artifact it was produced against`);
  } else if (!artifact?.inside) {
    errors.push(`${where} names an artifact outside this checkout: ${String(provenance.artifactPath)}`);
  } else if (!artifact.exists) {
    errors.push(`${where} names artifact ${String(provenance.artifactPath)}, which is not present`);
  } else if (artifact.sha256 !== provenance.artifactSha256) {
    errors.push(`${where} artifact sha256 does not match ${String(provenance.artifactPath)} on disk`);
  }
  if (!SHA256.test(String(provenance.fixtureSha256 ?? ""))) {
    errors.push(`${where} records no sha256 of the fixture`);
  } else if (provenance.fixtureSha256 !== context.fixtureSha256) {
    errors.push(`${where} was produced against a different fixture than the committed one`);
  }
  const providers = Array.isArray(provenance.providers) ? provenance.providers : [];
  if (providers.length === 0) {
    errors.push(`${where} records no provider identity`);
  }
  providers.forEach((provider, index) => {
    if (typeof provider?.name !== "string" || typeof provider?.adapter !== "string" ||
      typeof provider?.model !== "string") {
      errors.push(`${where} provider ${String(index)} does not record name, adapter, and model`);
    }
  });
  const declaredAccess = taskExternalAccess(task);
  if (declaredAccess.length > 0) {
    const used = Array.isArray(run.externalAccessUsed) ? run.externalAccessUsed : undefined;
    if (used === undefined) {
      errors.push(
        `${where} does not record which declared external access this arm was given, so the arms cannot be shown to be comparable`,
      );
    } else if (
      used.slice().sort().join("\u0000") !== declaredAccess.slice().sort().join("\u0000")
    ) {
      errors.push(
        `${where} records external access ${used.join(", ") || "none"}, which is not the access the task declares for both arms`,
      );
    }
  }
  if (task.kind === "fix") {
    const expectedFiles = task.answerKey?.expectedChangedFiles ?? [];
    const produced = run.producedFiles;
    if (!produced || typeof produced !== "object") {
      errors.push(`${where} records no producedFiles map, so its fix cannot be checked against the reference`);
    } else {
      expectedFiles.forEach((relative) => {
        const committed = produced[relative];
        const facts = context.produced?.[relative];
        if (typeof committed !== "string" || committed.length === 0) {
          errors.push(`${where} does not name a committed copy of ${relative}`);
          return;
        }
        if (!facts?.inside) {
          errors.push(`${where} names a produced file outside benchmarks/: ${committed}`);
          return;
        }
        if (!facts.exists) {
          errors.push(`${where} names produced file ${committed}, which is not committed`);
          return;
        }
        if (facts.tracked === false) {
          errors.push(`${where} names produced file ${committed}, which Git does not track`);
        } else if (facts.tracked === undefined) {
          errors.push(`${where} produced-file tracking could not be confirmed; Git is unavailable`);
        }
      });
    }
  }
  const bundle = context.bundle;
  if (typeof provenance.runBundle !== "string" || provenance.runBundle.length === 0) {
    errors.push(`${where} does not name a preserved run bundle`);
  } else if (!bundle?.inside) {
    errors.push(`${where} names a run bundle outside benchmarks/: ${provenance.runBundle}`);
  } else if (!bundle.exists) {
    errors.push(`${where} names run bundle ${provenance.runBundle}, which is not committed`);
  } else if (bundle.tracked === false) {
    errors.push(`${where} names run bundle ${provenance.runBundle}, which Git does not track`);
  } else if (bundle.tracked === undefined) {
    errors.push(`${where} run bundle tracking could not be confirmed; Git is unavailable`);
  } else if (bundle.value === undefined) {
    errors.push(`${where} run bundle ${provenance.runBundle} is not readable JSON`);
  } else {
    errors.push(...crossCheckBundle(run, bundle.value, where));
  }
  return errors;
};

export const scoreRun = (task, run, context = {}) => {
  const arm = run?.arm;
  const required = task.answerKey.requiredFindings ?? [];
  const forbidden = task.answerKey.forbiddenFindings ?? [];
  const requiredIds = idsOf(required);
  const forbiddenIds = idsOf(forbidden);
  const findings = run?.findings ?? [];

  const supported = required.filter((expected) =>
    findings.some((finding) => finding.id === expected.id && sameLocation(finding, expected)));
  const misplaced = findings.filter((finding) =>
    requiredIds.has(finding.id) &&
    !required.some((expected) => expected.id === finding.id && sameLocation(finding, expected)));
  const falsePositives = findings.filter((finding) =>
    forbiddenIds.has(finding.id) || !requiredIds.has(finding.id));

  const expectedChecks = armVerification(task, arm);
  const recordedChecks = run?.verification ?? [];
  const missingChecks = expectedChecks.filter((command) =>
    !recordedChecks.some((check) => check.command === command));
  const failedChecks = recordedChecks.filter((check) =>
    check.status === "failed" || check.status === "timedOut");
  const cancelledChecks = recordedChecks.filter((check) => check.status === "cancelled");
  const verificationOutcome = missingChecks.length > 0
    ? "missing"
    : failedChecks.length > 0
      ? "failed"
      : cancelledChecks.length > 0
        ? "cancelled"
        : expectedChecks.length === 0
          ? "notApplicable"
          : "passed";

  const expectedFiles = task.answerKey.expectedChangedFiles ?? [];
  const changedFiles = run?.changedFiles ?? [];
  const outOfScopeFiles = changedFiles.filter((file) => !expectedFiles.includes(file));
  const changedScopeHeld = expectedFiles.length === 0
    ? changedFiles.length === 0
    : outOfScopeFiles.length === 0 &&
      expectedFiles.every((file) => changedFiles.includes(file));

  const completion = run?.completion ?? "notRecorded";
  const referenceRequired = task.kind === "fix" &&
    typeof task.answerKey?.referenceFile === "string";
  const referenceMatch = referenceRequired ? context.referenceMatch === true : undefined;
  const eligible = completion === "completed" &&
    changedScopeHeld &&
    verificationOutcome !== "missing" &&
    verificationOutcome !== "failed" &&
    verificationOutcome !== "cancelled";
  const correct = eligible &&
    supported.length === required.length &&
    falsePositives.length === 0 &&
    (!referenceRequired || referenceMatch === true);

  return {
    taskId: task.id,
    arm,
    pipelineId: run?.pipelineId,
    requiredFindings: required.length,
    supportedFindings: supported.length,
    misplacedFindings: misplaced.length,
    falsePositives: falsePositives.length,
    expectedVerification: expectedChecks,
    verificationOutcome,
    outOfScopeFiles,
    changedScopeHeld,
    completion,
    ...(referenceMatch === undefined ? {} : { referenceMatch }),
    eligible,
    correct,
  };
};

export const compareArms = (single, paired) => {
  if (single?.eligible !== true || paired?.eligible !== true) return "incomplete";
  const pairedWins =
    (paired.supportedFindings > single.supportedFindings &&
      paired.falsePositives <= single.falsePositives) ||
    (paired.supportedFindings === single.supportedFindings &&
      paired.falsePositives < single.falsePositives);
  const singleWins =
    (single.supportedFindings > paired.supportedFindings &&
      single.falsePositives <= paired.falsePositives) ||
    (single.supportedFindings === paired.supportedFindings &&
      single.falsePositives < paired.falsePositives);
  if (singleWins) return "singleBetter";
  if (pairedWins) return paired.correct === true ? "pairedBetter" : "tie";
  return "tie";
};

export const benchmarkVerdict = (comparisons, provenanceErrors = []) => {
  if (provenanceErrors.length > 0) {
    return `${String(provenanceErrors.length)} recorded run${provenanceErrors.length === 1 ? "" : "s"} failed provenance validation. This benchmark supports no claim about pairing.`;
  }
  if (comparisons.length === 0) {
    return "No task is preregistered. This benchmark supports no claim about pairing.";
  }
  const incomplete = comparisons.filter((value) => value === "incomplete").length;
  if (incomplete > 0) {
    return `${String(incomplete)} of ${String(comparisons.length)} tasks have no eligible result in both arms. This benchmark supports no claim about pairing.`;
  }
  if (comparisons.some((value) => value === "singleBetter")) {
    return "Recorded results do not support a claim that pairing improves results.";
  }
  if (comparisons.every((value) => value === "pairedBetter")) {
    return `Recorded results support a claim that pairing improved results on all ${String(comparisons.length)} preregistered tasks.`;
  }
  return "Recorded results are mixed or tied. They support no claim that pairing improves results.";
};
