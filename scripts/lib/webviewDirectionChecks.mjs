import assert from "node:assert/strict";

const frame = (session) => session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

export const runDirectionChecks = async (session, press) => {
  const baseline = await session.evaluate("structuredClone(window.__managerState)");
  for (const width of [320, 792]) {
    for (const withRun of [true, false]) {
      await session.send("Page.reload");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await session.evaluate("document.readyState === 'complete' && typeof window.__boot === 'function'")) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await session.send("Emulation.setDeviceMetricsOverride", { width, height: 640, deviceScaleFactor: 1, mobile: false });
      await session.evaluate(`{
        window.__managerState = ${JSON.stringify(baseline)};
        ${withRun ? "" : "window.__managerState.conversations = []; window.__managerState.activeConversationId = '';"}
        document.documentElement.style.setProperty('--vscode-font-size', '18px');
        window.__boot();
      }`);
      await frame(session);
      await press(session, '[data-action="run-drawer-toggle"]');
      await press(session, '.run-drawer-direction');
      await frame(session);
      const label = `${width}px ${withRun ? "empty run" : "no run"}`;
      assert.equal(await session.evaluate("document.querySelector('#conversation-scroll').classList.contains('is-empty')"), false, `${label}: Direction has its own scroll state`);
      await press(session, '[data-section="direction-initiative"]');
      assert.equal(await session.evaluate("document.querySelector('[data-section=\"direction-initiative\"]').getAttribute('aria-expanded')"), "false", `${label}: first click collapses Initiative`);
      await press(session, '[data-section="direction-initiative"]');
      const fields = {
        "initiative-title": "Browser app delivery",
        "initiative-goal": "Build the requested app",
        "initiative-outcome": "A working browser extension",
        "initiative-scope": "src\nmedia",
        "initiative-constraints": "Preserve existing work",
        "initiative-criteria": "Handle ZIP and Markdown",
      };
      await session.evaluate(`{
        for (const [id, value] of Object.entries(${JSON.stringify(fields)})) {
          const field = document.getElementById(id);
          field.value = value;
          field.dispatchEvent(new Event('input', {bubbles:true}));
        }
        document.activeElement?.blur();
      }`);
      const metrics = await session.evaluate(`(() => {
        const el = document.querySelector('#conversation-scroll');
        const rect = el.getBoundingClientRect();
        return {height:el.clientHeight,content:el.scrollHeight,bottom:rect.bottom,x:rect.left+rect.width/2,y:Math.min(rect.bottom-20,rect.top+100)};
      })()`);
      assert.ok(metrics.height > 0 && metrics.bottom <= 641 && metrics.content > metrics.height, `${label}: form has a bounded scroll surface`);
      await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: metrics.x, y: metrics.y, deltaX: 0, deltaY: 450 });
      await new Promise(resolve => setTimeout(resolve, 350));
      const top = await session.evaluate("document.querySelector('#conversation-scroll').scrollTop");
      assert.ok(top > 0, `${label}: wheel scroll moves the form`);
      await session.evaluate("window.__boot()");
      await frame(session);
      assert.ok(Math.abs(await session.evaluate("document.querySelector('#conversation-scroll').scrollTop") - top) <= 1, `${label}: snapshot preserves scroll`);
      assert.deepEqual(await session.evaluate(`Object.fromEntries(Object.keys(${JSON.stringify(fields)}).map(id=>[id,document.getElementById(id).value]))`), fields, `${label}: snapshot preserves all fields`);
      await session.evaluate("document.querySelector('[data-action=\"initiative-save\"]').scrollIntoView({block:'center',behavior:'instant'}); window.__posted=[]");
      await press(session, '[data-action="initiative-save"]');
      assert.deepEqual(await session.evaluate("window.__posted.filter(message=>message.type==='initiative.define')"), [{
        type: "initiative.define",
        title: fields["initiative-title"],
        goal: fields["initiative-goal"],
        desiredOutcome: fields["initiative-outcome"],
        scope: ["src", "media"],
        constraints: [fields["initiative-constraints"]],
        acceptanceCriteria: [fields["initiative-criteria"]],
      }], `${label}: save sends the complete form once`);
      console.log(`Direction ${label}: wheel scroll, snapshot stability, fields, first-click collapse and Save passed.`);
    }
  }
};
