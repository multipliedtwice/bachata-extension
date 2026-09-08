export type NotificationKind =
  | "humanDecisionRequired"
  | "findingsConverged"
  | "materialNewFinding"
  | "fixReady"
  | "verificationFailed"
  | "providerBlocked"
  | "retainedWorkAvailable";

export type NotificationLevel = "decision" | "material" | "routine";

export type NotificationMode = "off" | "decisions" | "material" | "all";

export type NotificationAction = "inspect" | "discard" | "restore";

export type NotificationTarget =
  | { type: "direction"; section: "initiative" | "decisions" | "findings" }
  | { type: "conversation"; conversationId: string }
  | { type: "orchestration"; runId: string };

export type NotificationEvent = {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  text: string;
  action: NotificationAction;
  target?: NotificationTarget;
  recordedAt: string;
};

export type NotificationEntry = NotificationEvent & { read: boolean };

export type NotificationCenterState = {
  mode: NotificationMode;
  unread: number;
  events: NotificationEntry[];
};

export const NOTIFICATION_MODES: readonly NotificationMode[] = [
  "off",
  "decisions",
  "material",
  "all",
];

export const notificationLevelFor: Record<NotificationKind, NotificationLevel> = {
  humanDecisionRequired: "decision",
  providerBlocked: "decision",
  findingsConverged: "material",
  materialNewFinding: "material",
  verificationFailed: "material",
  fixReady: "material",
  retainedWorkAvailable: "routine",
};

export const notificationMode = (value: unknown): NotificationMode =>
  NOTIFICATION_MODES.includes(value as NotificationMode)
    ? (value as NotificationMode)
    : "material";

export const notificationVisible = (
  mode: NotificationMode,
  level: NotificationLevel,
): boolean => {
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "material") return level !== "routine";
  return level === "decision";
};
