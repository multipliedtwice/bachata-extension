type RunPhase = "idle" | "running" | "waiting" | "stopped" | "failed" | "completed";
type RunRecovery = { step: "resume" | "retry" | "none"; label?: string };
type RunStatusPresentation = { label: string; icon: string; spinning: boolean };
type PromptTurn = { turn: number; of: number };

type BachataWebviewBehaviorApi = {
  dialogInitialFocus: (hasInput: boolean, danger: boolean) => "input" | "cancel" | "confirm";
  focusReturnSelector: (element: HTMLElement | null) => string | undefined;
  wrappedFocusIndex: (activeIndex: number, controlCount: number, shiftKey: boolean) => number | undefined;
  shouldSubmitComposer: (targetId: string, key: string, ctrlKey: boolean, metaKey: boolean) => boolean;
  runPhase: (running: boolean, workflowStatus: string) => RunPhase;
  runRecovery: (
    phase: RunPhase,
    checkpoint: { outcome: string; failureScope?: string | undefined } | undefined,
  ) => RunRecovery | undefined;
  runStatusPresentation: (phase: RunPhase, outcome?: string | undefined) => RunStatusPresentation;
  hasDetail: (value: unknown) => boolean;
  promptTurns: (
    entries: ReadonlyArray<{ id: string; agentId?: string | undefined; step?: string | undefined; eventType?: string | undefined }>,
  ) => Record<string, PromptTurn>;
};

const runPhases: Record<string, RunPhase> = {
  paused: "waiting",
  interrupted: "stopped",
  error: "failed",
  completed: "completed",
};

const phasePresentations: Record<Exclude<RunPhase, "stopped">, RunStatusPresentation> = {
  running: { label: "Working", icon: "loading", spinning: true },
  waiting: { label: "Waiting for you", icon: "clock", spinning: false },
  failed: { label: "Failed", icon: "error", spinning: false },
  completed: { label: "Completed", icon: "pass", spinning: false },
  idle: { label: "Ready", icon: "circle-outline", spinning: false },
};

const bachataWebviewBehavior: BachataWebviewBehaviorApi = {
  dialogInitialFocus: (hasInput, danger) => hasInput ? "input" : danger ? "cancel" : "confirm",
  focusReturnSelector: (element) => {
    if (!element) {
      return undefined;
    }
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }
    const attributes = [
      ["data-conversation", element.dataset.conversation],
      ["data-agent", element.dataset.agent],
      ["data-section", element.dataset.section],
      ["data-mode", element.dataset.mode],
      ["data-view", element.dataset.view],
      ["data-index", element.dataset.index],
      ["data-step-index", element.dataset.stepIndex],
      ["data-assignment-index", element.dataset.assignmentIndex],
      ["data-gate-action", element.dataset.gateAction],
      ["data-participant", element.dataset.participant],
      ["data-request", element.dataset.request],
      ["data-choice", element.dataset.choice],
      ["data-record", element.dataset.record],
      ["data-resolution", element.dataset.resolution],
      ["data-path", element.dataset.path],
      ["data-run-id", element.dataset.runId],
      ["data-format", element.dataset.format],
      ["data-message-id", element.dataset.messageId],
      ["data-finding-id", element.dataset.findingId],
      ["data-result-version", element.dataset.resultVersion],
      ["data-entry", element.dataset.entry],
      ["data-attachment-id", element.dataset.attachmentId],
      ["data-code-id", element.dataset.codeId],
      ["data-remediation", element.dataset.remediation],
      ["data-interaction-ref", element.dataset.interactionRef],
      // The pipeline editor identifies its fields by step and field rather than by action, so
      // without these a dialog opened over the editor had no control to return focus to.
      ["data-editor-step", element.dataset.editorStep],
      ["data-editor-agent", element.dataset.editorAgent],
      ["data-editor-role", element.dataset.editorRole],
      ["data-editor-assignment", element.dataset.editorAssignment],
      ["data-editor-policy", element.dataset.editorPolicy],
      ["data-editor-meta", element.dataset.editorMeta],
      ["data-editor-section", element.dataset.editorSection],
      ["data-editor-card", element.dataset.editorCard],
      ["data-field", element.dataset.field],
    ] as const;
    const qualifiers = attributes
      .flatMap(([name, value]) =>
        value === undefined ? [] : [`[${name}="${CSS.escape(value)}"]`],
      )
      .join("");
    const action = element.dataset.action;
    if (action) {
      return `[data-action="${CSS.escape(action)}"]${qualifiers}`;
    }
    return qualifiers === "" ? undefined : `${element.localName}${qualifiers}`;
  },
  wrappedFocusIndex: (activeIndex, controlCount, shiftKey) => {
    if (controlCount <= 0) {
      return undefined;
    }
    if (shiftKey && activeIndex === 0) {
      return controlCount - 1;
    }
    if (!shiftKey && activeIndex === controlCount - 1) {
      return 0;
    }
    return undefined;
  },
  shouldSubmitComposer: (targetId, key, ctrlKey, metaKey) =>
    targetId === "composer-prompt" && key === "Enter" && (ctrlKey || metaKey),
  runPhase: (running, workflowStatus) => {
    const settled = runPhases[workflowStatus];
    if (settled !== undefined) {
      return settled;
    }
    return running || workflowStatus === "running" ? "running" : "idle";
  },
  runRecovery: (phase, checkpoint) => {
    if (checkpoint === undefined) {
      return undefined;
    }
    if (phase === "stopped" && (checkpoint.outcome === "stoppedByUser" || checkpoint.outcome === "interrupted")) {
      return { step: "resume", label: "Resume stopped step" };
    }
    if (phase === "failed" && checkpoint.outcome === "failed") {
      return checkpoint.failureScope === "step"
        ? { step: "retry", label: "Retry failed step" }
        : { step: "none" };
    }
    return undefined;
  },
  runStatusPresentation: (phase, outcome) => {
    if (phase !== "stopped") {
      return phasePresentations[phase];
    }
    return outcome === "stoppedByUser"
      ? { label: "Stopped by you", icon: "debug-stop", spinning: false }
      : { label: "Interrupted", icon: "debug-pause", spinning: false };
  },
  hasDetail: (value) => {
    if (value === null || value === undefined) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }
    return true;
  },
  promptTurns: (entries) => {
    const groups = new Map<string, string[]>();
    entries
      .filter((entry) => entry.eventType === "agent.prompt")
      .forEach((entry) => {
        const key = JSON.stringify([entry.agentId ?? "", entry.step ?? ""]);
        groups.set(key, [...(groups.get(key) ?? []), entry.id]);
      });
    return Object.fromEntries(
      [...groups.values()].flatMap((ids) => ids.map((id, index) => [id, { turn: index + 1, of: ids.length }])),
    );
  },
};

(globalThis as typeof globalThis & { bachataWebviewBehavior?: BachataWebviewBehaviorApi }).bachataWebviewBehavior = bachataWebviewBehavior;
