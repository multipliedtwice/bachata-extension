import { notificationLevelFor, type NotificationEvent, type NotificationTarget } from "./types";

export type NotificationCheck = {
  command: string;
  status: "passed" | "failed" | "timedOut" | "cancelled";
  stale?: boolean;
};

export type NotificationRunResult = {
  conversationId: string;
  title: string;
  status: string;
  checks: readonly NotificationCheck[];
  retainedWorktree?: string;
  retainedRunId?: string;
  applyBlockedReason?: string;
};

export type NotificationRetainedRun = {
  runId: string;
  title: string;
  integrationWorktree: string;
};

export type NotificationDirection = {
  cycleId?: string;
  decisionsNeedingHuman: readonly { id: string; subject: string }[];
  findingsNeedingRuling: readonly { identity: string; subject: string }[];
  reconciliationQuestions: readonly { freshIdentity: string; subject: string }[];
  latestChange?: {
    cycleId: string;
    newMaterial: readonly { identity: string; subject: string }[];
    regressed: readonly { identity: string; subject: string }[];
    resolved: readonly { identity: string; subject: string }[];
  };
  baselineDrift: readonly string[];
  fixRuns: readonly { identity: string; subject: string; runRef: string; state: string }[];
};

export type NotificationSource = {
  recordedAt: string;
  direction: NotificationDirection;
  results: readonly NotificationRunResult[];
  retainedRuns: readonly NotificationRetainedRun[];
};

const MAX_SUBJECTS = 2;

const subjectList = (subjects: readonly string[]): string => {
  const shown = subjects.slice(0, MAX_SUBJECTS);
  const rest = subjects.length - shown.length;
  return rest > 0 ? `${shown.join("; ")} and ${String(rest)} more` : shown.join("; ");
};

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

const event = (input: {
  id: string;
  kind: NotificationEvent["kind"];
  text: string;
  recordedAt: string;
  action?: NotificationEvent["action"];
  target?: NotificationTarget;
}): NotificationEvent => ({
  id: input.id,
  kind: input.kind,
  level: notificationLevelFor[input.kind],
  text: input.text,
  action: input.action ?? "inspect",
  ...(input.target === undefined ? {} : { target: input.target }),
  recordedAt: input.recordedAt,
});

export const deriveNotifications = (source: NotificationSource): NotificationEvent[] => {
  const events: NotificationEvent[] = [];
  const at = source.recordedAt;
  const direction = source.direction;

  if (direction.decisionsNeedingHuman.length > 0) {
    const ids = direction.decisionsNeedingHuman.map((item) => item.id).sort();
    events.push(event({
      id: `decision-required:${ids.join(",")}`,
      kind: "humanDecisionRequired",
      recordedAt: at,
      text: `${plural(ids.length, "decision needs", "decisions need")} you: ${subjectList(direction.decisionsNeedingHuman.map((item) => item.subject))}.`,
      target: { type: "direction", section: "decisions" },
    }));
  }
  if (direction.findingsNeedingRuling.length > 0) {
    const ids = direction.findingsNeedingRuling.map((item) => item.identity).sort();
    events.push(event({
      id: `ruling-required:${ids.join(",")}`,
      kind: "humanDecisionRequired",
      recordedAt: at,
      text: `${plural(ids.length, "unresolved finding needs", "unresolved findings need")} your judgment: ${subjectList(direction.findingsNeedingRuling.map((item) => item.subject))}.`,
      target: { type: "direction", section: "findings" },
    }));
  }
  if (direction.reconciliationQuestions.length > 0) {
    const ids = direction.reconciliationQuestions.map((item) => item.freshIdentity).sort();
    events.push(event({
      id: `reconcile-required:${ids.join(",")}`,
      kind: "humanDecisionRequired",
      recordedAt: at,
      text: `${plural(ids.length, "finding", "findings")} could not be matched to earlier ones automatically: ${subjectList(direction.reconciliationQuestions.map((item) => item.subject))}.`,
      target: { type: "direction", section: "findings" },
    }));
  }

  const change = direction.latestChange;
  if (change !== undefined) {
    const needsYou =
      direction.findingsNeedingRuling.length +
      direction.decisionsNeedingHuman.length +
      direction.reconciliationQuestions.length;
    const counts = `${String(change.resolved.length)}-${String(change.newMaterial.length)}-${String(change.regressed.length)}-${String(needsYou)}`;
    events.push(event({
      id: `converged:${change.cycleId}:${counts}`,
      kind: "findingsConverged",
      recordedAt: at,
      text: `Review converged: ${String(change.resolved.length)} resolved, ${String(change.newMaterial.length)} new, ${String(change.regressed.length)} regressed, ${plural(needsYou, "needs", "need")} you.`,
      target: { type: "direction", section: "findings" },
    }));
    const material = [...change.newMaterial, ...change.regressed];
    if (material.length > 0) {
      const ids = material.map((item) => item.identity).sort();
      events.push(event({
        id: `material-findings:${change.cycleId}:${ids.join(",")}`,
        kind: "materialNewFinding",
        recordedAt: at,
        text: `${plural(material.length, "material finding", "material findings")} in the latest round: ${subjectList(material.map((item) => item.subject))}.`,
        target: { type: "direction", section: "findings" },
      }));
    }
  }

  direction.fixRuns
    .filter((run) => run.state === "fixApplied" || run.state === "verified")
    .forEach((run) => {
      events.push(event({
        id: `fix-${run.state}:${run.identity}:${run.runRef}`,
        kind: "fixReady",
        recordedAt: at,
        text: run.state === "verified"
          ? `Not observed in a fresh review: ${run.subject}. A later fresh review no longer reported it, which is model non-observation, not a deterministic check.`
          : `Fix applied for ${run.subject}. A fresh review has not confirmed it yet.`,
        target: { type: "direction", section: "findings" },
      }));
    });

  if (direction.baselineDrift.length > 0 && direction.cycleId !== undefined) {
    events.push(event({
      id: `checks-stale:${direction.cycleId}:${direction.baselineDrift.join("|")}`,
      kind: "verificationFailed",
      recordedAt: at,
      text: `Recorded checks are stale: ${direction.baselineDrift.join("; ")}.`,
      target: { type: "direction", section: "findings" },
    }));
  }

  source.results.forEach((result) => {
    const failed = result.checks.filter((check) => check.status !== "passed");
    if (failed.length > 0) {
      events.push(event({
        id: `checks-failed:${result.conversationId}:${failed.map((check) => check.command).join("|")}`,
        kind: "verificationFailed",
        recordedAt: at,
        text: `${plural(failed.length, "check", "checks")} did not pass in ${result.title}: ${failed.map((check) => check.command).slice(0, MAX_SUBJECTS).join("; ")}. Open the run to inspect the failing commands.`,
        target: { type: "conversation", conversationId: result.conversationId },
      }));
    }
    const stale = result.checks.filter((check) => check.stale === true);
    if (stale.length > 0) {
      events.push(event({
        id: `checks-stale-run:${result.conversationId}:${stale.map((check) => check.command).join("|")}`,
        kind: "verificationFailed",
        recordedAt: at,
        text: `${plural(stale.length, "check is", "checks are")} stale in ${result.title}. Rerun them against the current repository state.`,
        target: { type: "conversation", conversationId: result.conversationId },
      }));
    }
    if (result.status === "error") {
      events.push(event({
        id: `provider-blocked:${result.conversationId}`,
        kind: "providerBlocked",
        recordedAt: at,
        text: `${result.title} stopped with a provider error. Open it to see what blocked the run.`,
        target: { type: "conversation", conversationId: result.conversationId },
      }));
    }
    if (result.applyBlockedReason !== undefined) {
      events.push(event({
        id: `apply-blocked:${result.conversationId}:${result.applyBlockedReason}`,
        kind: "providerBlocked",
        recordedAt: at,
        text: `${result.title} cannot apply its work: ${result.applyBlockedReason}. Rerun the approved checks, then apply again.`,
        target: { type: "conversation", conversationId: result.conversationId },
      }));
    }
    if (result.retainedWorktree !== undefined) {
      events.push(event({
        id: `retained-run:${result.conversationId}:${result.retainedWorktree}`,
        kind: "retainedWorkAvailable",
        recordedAt: at,
        action: "discard",
        text: `${result.title} kept its work in a retained worktree. Inspect, apply, or discard it.`,
        target: { type: "conversation", conversationId: result.conversationId },
      }));
    }
  });

  source.retainedRuns.forEach((run) => {
    events.push(event({
      id: `retained-todo:${run.runId}:${run.integrationWorktree}`,
      kind: "retainedWorkAvailable",
      recordedAt: at,
      action: "discard",
      text: `${run.title} kept a retained integration worktree. Inspect, apply, or discard it.`,
      target: { type: "orchestration", runId: run.runId },
    }));
  });

  return events;
};
