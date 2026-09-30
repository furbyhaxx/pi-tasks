/**
 * Session teardown: the widget's 150 ms timer is the only thing in this extension
 * that re-reads the task file and forces a host re-render on its own, so it must
 * stop when the session that created it goes away. On reload the factory re-runs
 * and orphans the whole extension instance — a timer left running there keeps
 * ticking for the life of the process against a store nothing else uses.
 *
 * The widget is re-armed by the session_start that follows a switch, so teardown
 * must not leave the next session without one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => `~~${text}~~`,
};

/** Render the widget once through the callback the host was handed, the way a real
 *  frame does, and hand back its requestRender so ticks can be counted. */
function renderOnce(setWidget: ReturnType<typeof vi.fn>, tui: any) {
  const content = setWidget.mock.calls.at(-1)?.[1];
  expect(content).toBeTypeOf("function");
  content(tui, theme).render();
}

describe("Session shutdown", () => {
  let mock: ReturnType<typeof mockPi>;
  let setWidget: ReturnType<typeof vi.fn>;
  let requestRender: ReturnType<typeof vi.fn>;
  let ctx: ReturnType<typeof mockSessionCtx>;

  beforeEach(async () => {
    vi.useFakeTimers();
    delete process.env.PI_TASKS;
    config.current = { taskScope: "memory" };
    mock = mockPi();
    ctx = mockSessionCtx("session-1");
    setWidget = ctx.ui.setWidget as ReturnType<typeof vi.fn>;
    requestRender = vi.fn();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    await mock.executeTool("TaskCreate", { subject: "Long job", description: "work" }, ctx);
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" }, ctx);
    renderOnce(setWidget, { terminal: { columns: 200 }, requestRender });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps ticking while the session is running", () => {
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender.mock.calls.length).toBeGreaterThan(0);
  });

  it("stops ticking once the session is gone", async () => {
    await mock.fireLifecycle("session_shutdown", { reason: "quit" });

    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(setWidget.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it("stops ticking across a session switch", async () => {
    await mock.fireLifecycle("session_shutdown", { reason: "resume" });

    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("re-arms the widget for the session that follows a switch", async () => {
    await mock.fireLifecycle("session_shutdown", { reason: "resume" });
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    renderOnce(setWidget, { terminal: { columns: 200 }, requestRender });
    requestRender.mockClear();
    vi.advanceTimersByTime(1_000);
    expect(requestRender.mock.calls.length).toBeGreaterThan(0);
  });
});
