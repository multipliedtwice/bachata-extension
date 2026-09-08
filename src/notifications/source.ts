import type { RunResultCenter } from "../results/projectResult";
import type {
  ConversationSummary,
  LongitudinalDirectionState,
  RetainedTodoRunSummary,
} from "../webview/protocol";
import type { NotificationSource } from "./derive";

/**
 * EX-3. What the notification centre is derived from, as a projection rather than a closure.
 *
 * `deriveNotifications` decides what is worth saying; this decides what it is told. The two were
 * separated already, but the projection sat inside the conversation manager reading its live
 * state, so the mapping — which identity carries which subject, which conversation carries which
 * title, which of a result's optional fields travel — could only be exercised by building a
 * manager. It reads its inputs and returns a value; nothing here is the manager's.
 *
 * An identity or a conversation the projection cannot name is carried under its own id rather
 * than dropped: a notification about something the reader cannot see named is still a
 * notification they need, and silently omitting it would be the projection deciding what matters.
 */
const firstByKey = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> => {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return byKey;
};

const identified = (
  items: readonly { identity: string; subject: string }[],
): { identity: string; subject: string }[] =>
  items.map((item) => ({ identity: item.identity, subject: item.subject }));

export const notificationSourceFrom = (input: {
  direction: LongitudinalDirectionState;
  conversations: readonly ConversationSummary[];
  results: Readonly<Record<string, RunResultCenter>>;
  retainedRuns: readonly RetainedTodoRunSummary[];
  recordedAt: string;
}): NotificationSource => {
  const view = input.direction.direction;
  const titleById = firstByKey(input.conversations, (item) => item.id);
  const subjectByIdentity = firstByKey(input.direction.findings, (entry) => entry.identity);
  const titleFor = (conversationId: string): string =>
    titleById.get(conversationId)?.title ?? conversationId;
  return {
    recordedAt: input.recordedAt,
    direction: {
      ...(view.currentCycle === undefined ? {} : { cycleId: view.currentCycle.id }),
      decisionsNeedingHuman: view.decisionsNeedingHuman.map((item) => ({
        id: item.id,
        subject: item.subject,
      })),
      findingsNeedingRuling: identified(view.findingsNeedingRuling ?? []),
      reconciliationQuestions: view.reconciliationQuestions.map((item) => ({
        freshIdentity: item.freshIdentity,
        subject: item.subject,
      })),
      ...(view.latestChange === undefined
        ? {}
        : {
            latestChange: {
              cycleId: view.latestChange.cycleId,
              newMaterial: identified(view.latestChange.newMaterial),
              regressed: identified(view.latestChange.regressed),
              resolved: identified(view.latestChange.resolved),
            },
          }),
      baselineDrift: view.baselineDrift,
      fixRuns: input.direction.fixRuns.map((run) => ({
        identity: run.identity,
        subject: subjectByIdentity.get(run.identity)?.subject ?? run.identity,
        runRef: run.runRef,
        state: run.state,
      })),
    },
    results: Object.entries(input.results).map(([conversationId, result]) => ({
      conversationId,
      title: titleFor(conversationId),
      status: result.status,
      checks: result.checks,
      ...(result.retainedWorktree === undefined
        ? {}
        : { retainedWorktree: result.retainedWorktree }),
      ...(result.retainedRunId === undefined ? {} : { retainedRunId: result.retainedRunId }),
      ...(result.applyBlockedReason === undefined
        ? {}
        : { applyBlockedReason: result.applyBlockedReason }),
    })),
    retainedRuns: input.retainedRuns.map((run) => ({
      runId: run.runId,
      title: run.title,
      integrationWorktree: run.integrationWorktree,
    })),
  };
};
