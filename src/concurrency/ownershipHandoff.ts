export type OwnershipActionId = "retry" | "reload" | "release" | "dismiss";

export type OwnershipAction = {
  id: OwnershipActionId;
  label: string;
  detail: string;
};

export type OwnershipState = {
  owned: boolean;
  blockedReason?: string;
  holderHeld: boolean;
  holderHeartbeatAgeMs?: number;
  staleOwnerMs: number;
  activeWork: string[];
};

export type OwnershipReport = {
  title: string;
  detail: string;
  actions: OwnershipAction[];
};

const seconds = (value: number): string => `${String(Math.max(0, Math.round(value / 1000)))}s`;

export const ownershipReport = (state: OwnershipState): OwnershipReport => {
  if (state.owned) {
    const releasable = state.activeWork.length === 0;
    return {
      title: "This window owns the workspace state",
      detail: [
        "One Bachata Extension Host writes this workspace state store at a time. This window is the writer.",
        releasable
          ? "Releasing ownership reloads this window and lets another window take over."
          : `Ownership cannot be released while work is active: ${state.activeWork.join("; ")}.`,
      ].join("\n\n"),
      actions: releasable
        ? [{
            id: "release",
            label: "Release and reload",
            detail: "This window stops writing, then reloads so another window can acquire ownership.",
          }]
        : [],
    };
  }
  const stale = state.holderHeld &&
    state.holderHeartbeatAgeMs !== undefined &&
    state.holderHeartbeatAgeMs > state.staleOwnerMs;
  const holderLine = !state.holderHeld
    ? "No other window is holding the lease right now, so a retry should succeed."
    : state.holderHeartbeatAgeMs === undefined
      ? "Another window holds the lease. Its last heartbeat is unknown."
      : stale
        ? `The other window last reported ${seconds(state.holderHeartbeatAgeMs)} ago, past the ${seconds(state.staleOwnerMs)} stale threshold. Its lease is reclaimable, so a retry should succeed.`
        : `The other window reported ${seconds(state.holderHeartbeatAgeMs)} ago and is still alive. Release ownership there, or close that window.`;
  return {
    title: "Another window owns this workspace state",
    detail: [
      state.blockedReason ?? "This window is not the workspace state writer.",
      holderLine,
      "Bachata never takes a live lease away from another window. A lease is reclaimed only after its owner stops reporting.",
    ].join("\n\n"),
    actions: [
      {
        id: "retry",
        label: "Request ownership now",
        detail: "Try to acquire the writer lease again.",
      },
      {
        id: "reload",
        label: "Reload window",
        detail: "Reload so activation runs again from a clean state.",
      },
    ],
  };
};
