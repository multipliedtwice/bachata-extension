type BachataWebviewBehaviorApi = {
  dialogInitialFocus: (hasInput: boolean, danger: boolean) => "input" | "cancel" | "confirm";
  focusReturnSelector: (element: HTMLElement | null) => string | undefined;
  wrappedFocusIndex: (activeIndex: number, controlCount: number, shiftKey: boolean) => number | undefined;
  shouldSubmitComposer: (targetId: string, key: string, ctrlKey: boolean, metaKey: boolean) => boolean;
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
      ["data-mode", element.dataset.mode],
      ["data-view", element.dataset.view],
      ["data-index", element.dataset.index],
      ["data-step-index", element.dataset.stepIndex],
      ["data-assignment-index", element.dataset.assignmentIndex],
      ["data-gate-action", element.dataset.gateAction],
      ["data-request", element.dataset.request],
      ["data-choice", element.dataset.choice],
      ["data-record", element.dataset.record],
      ["data-resolution", element.dataset.resolution],
      ["data-path", element.dataset.path],
      ["data-run-id", element.dataset.runId],
      ["data-format", element.dataset.format],
      ["data-message-id", element.dataset.messageId],
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
};

(globalThis as typeof globalThis & { bachataWebviewBehavior?: BachataWebviewBehaviorApi }).bachataWebviewBehavior = bachataWebviewBehavior;
