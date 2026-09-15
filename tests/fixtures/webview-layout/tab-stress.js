window.__seedTabStress = (count, activeIndex = count - 1, { running = false, archivedCount = 0 } = {}) => {
  const base = window.__managerState.conversations[0];
  window.__tabStressState = {
    ...structuredClone(window.__managerState),
    activeConversationId: `stress-${activeIndex + 1}`,
    conversations: Array.from({ length: count }, (_, index) => ({
      ...base,
      id: `stress-${index + 1}`,
      runRef: `stress-${index + 1}`,
      title: `Run ${index + 1} ${"Long title ภาษาไทย <review> & planning ".repeat(20)}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      iterationCount: 10,
      activeIteration: 9,
      unread: 123456,
      running,
      workflowStatus: running ? "running" : "idle",
    })),
    eventsByConversation: running ? Object.fromEntries(Array.from({ length: count }, (_, index) => [
      `stress-${index + 1}`,
      [{ id: 1, type: "run.started", status: "running", title: "Stress run", createdAt: base.createdAt }],
    ])) : {},
  };
  window.__tabStressState.conversations.push(...Array.from({ length: archivedCount }, (_, index) => ({
    ...base,
    id: `archived-${index + 1}`,
    runRef: `archived-${index + 1}`,
    title: `Archived run ${index + 1}`,
    archived: true,
  })));
  return window.__publishTabStress();
};

window.__publishTabStress = () => {
  const conversationId = window.__tabStressState.activeConversationId;
  const conversation = window.__tabStressState.conversations.find((run) => run.id === conversationId);
  window.__tabStressRunning = conversation.running;
  window.__send({ type: "manager.snapshot", state: structuredClone(window.__tabStressState) });
  window.__send({
    type: "conversation.message",
    conversationId,
    message: {
      type: "state.snapshot",
      state: {
        ...structuredClone(window.__panelState),
        taskId: conversationId,
        running: conversation.running,
        workflowStatus: conversation.workflowStatus,
      },
    },
  });
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
};

window.__measureTabStress = () => {
  const scroll = document.querySelector(".run-tabs-scroll");
  const tabs = Array.from(document.querySelectorAll(".run-tab"));
  const selected = document.querySelector(".run-tab.selected");
  const focused = document.activeElement;
  const inside = (element, container) => {
    if (!element || !container) return false;
    const box = element.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1 &&
      box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
  };
  const hit = (element) => {
    if (!element) return false;
    const box = element.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return target === element || element.contains(target);
  };
  const labels = tabs.map((tab) => tab.querySelector(".run-tab-select > span:nth-child(2)"));
  const inactive = tabs.filter((tab) => tab !== selected);
  const scrollBounds = scroll?.getBoundingClientRect();
  const firstVisible = scrollBounds && tabs.find((tab) => {
    const box = tab.getBoundingClientRect();
    return box.width > 0 && box.right > scrollBounds.left && box.left < scrollBounds.right;
  });
  const requiredControls = ["#notification-button", "#room-actions-button"];
  if (window.__tabStressRunning) {
    requiredControls.push('.run-tab-tool[data-view="chat"]', '.run-tab-tool[data-view="execution"]');
    if (selected?.querySelector('[data-view="execution"][aria-pressed="true"]')) requiredControls.push('[data-action="interrupt-run"]');
  }
  return {
    count: tabs.length,
    selectedId: selected?.querySelector(".run-tab-select")?.dataset.conversation,
    order: tabs.map((tab) => tab.querySelector(".run-tab-select").dataset.conversation),
    horizontalPageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    renderFailure: document.querySelector(".render-failure") !== null,
    minimumInactiveWidth: inactive.length ? Math.min(...inactive.map((tab) => tab.getBoundingClientRect().width)) : null,
    allLabelsVisible: labels.every((label) => label.getBoundingClientRect().width > 0 && label.getBoundingClientRect().height > 0),
    truncated: labels.every((label) => getComputedStyle(label).textOverflow === "ellipsis" && getComputedStyle(label).whiteSpace === "nowrap" && label.scrollWidth > label.clientWidth),
    labelsContained: labels.every((label, index) => inside(label, tabs[index])),
    fullTitles: tabs.every((tab) => {
      const button = tab.querySelector(".run-tab-select");
      const label = tab.querySelector(".run-tab-select > span:nth-child(2)");
      return button.title.startsWith(label.textContent) && label.textContent.includes("ภาษาไทย <review> & planning");
    }),
    inactiveDetails: inactive.some((tab) => tab.querySelector(".run-tab-tools, .run-action-menu, small, .unread")),
    oneTabStop: tabs.filter((tab) => tab.querySelector(".run-tab-select").tabIndex === 0).length === 1,
    selectedContained: inside(selected, scroll),
    selectedTitleWidth: selected?.querySelector(".run-tab-select > span:nth-child(2)")?.getBoundingClientRect().width ?? 0,
    selectedControlsReachable: requiredControls.every((selector) => {
      const controls = selected?.querySelectorAll(selector);
      return controls?.length === 1 && inside(controls[0], selected) && hit(controls[0]);
    }),
    selectedControlCount: selected?.querySelectorAll(".run-tab-tool, #notification-button, #room-actions-button").length ?? 0,
    newRunReachable: hit(document.querySelector(".run-tab-new")),
    runsReachable: hit(document.querySelector(".run-tab-all")),
    focusedId: focused?.matches(".run-tab-select") ? focused.dataset.conversation : null,
    focusedReachable: focused?.matches(".run-tab-select") ? hit(focused) : false,
    scrollLeft: scroll?.scrollLeft ?? 0,
    scrolls: scroll ? scroll.scrollWidth > scroll.clientWidth + 1 : false,
    anchor: firstVisible && scrollBounds ? {
      id: firstVisible.querySelector(".run-tab-select").dataset.conversation,
      offset: firstVisible.getBoundingClientRect().left - scrollBounds.left,
    } : null,
  };
};

window.__measureTabStressMenu = (selector) => {
  const menu = document.querySelector(selector);
  const panel = menu?.querySelector(":scope > div");
  const bounds = panel?.getBoundingClientRect();
  const controls = Array.from(panel?.querySelectorAll("button:not([disabled])") ?? []);
  return {
    open: menu?.open === true,
    contained: !!bounds && bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 &&
      bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight,
    controlsReachable: controls.length > 0 && controls.every((control) => {
      const box = control.getBoundingClientRect();
      const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.width > 0 && box.height > 0 && (target === control || control.contains(target));
    }),
  };
};
