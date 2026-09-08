import * as vscode from "vscode";

import {
  advanceOnboarding,
  milestoneSatisfied,
  onboardingContextKeys,
  onboardingMilestones,
  readOnboardingProgress,
} from "./firstRun";
import type { OnboardingEvent, OnboardingProgress } from "./firstRun";

const storageKey = "bachata.onboarding.v1";

export type OnboardingTracker = {
  record: (event: OnboardingEvent) => Promise<void>;
  progress: () => OnboardingProgress;
  publish: () => Promise<void>;
};

export const createOnboardingTracker = (
  context: vscode.ExtensionContext,
): OnboardingTracker => {
  let progress = readOnboardingProgress(context.globalState.get(storageKey));
  const publish = async (): Promise<void> => {
    for (const milestone of onboardingMilestones) {
      await vscode.commands.executeCommand(
        "setContext",
        onboardingContextKeys[milestone],
        milestoneSatisfied(progress[milestone]),
      );
    }
  };
  return {
    progress: () => ({ ...progress }),
    publish,
    record: async (event) => {
      const next = advanceOnboarding(progress, event);
      // A journey change with identical milestone values is still a change: starting a new
      // journey resets progress, and that reset must survive a restart.
      const changed =
        onboardingMilestones.some((milestone) => next[milestone] !== progress[milestone]) ||
        next.journey?.repositoryRoot !== progress.journey?.repositoryRoot ||
        next.journey?.initiativeId !== progress.journey?.initiativeId ||
        next.journey?.runRef !== progress.journey?.runRef ||
        next.pendingReadinessRoot !== progress.pendingReadinessRoot;
      progress = next;
      if (!changed) return;
      await context.globalState.update(storageKey, progress);
      await publish();
    },
  };
};
