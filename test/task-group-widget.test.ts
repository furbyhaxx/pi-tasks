import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { TaskWidget, type Theme, type UICtx } from "../src/ui/task-widget.js";

function fixture() {
  const widgets = new Map<string, unknown>();
  const ui: UICtx = {
    setStatus() {},
    setWidget(key, content) { widgets.set(key, content); },
  };
  const theme: Theme = {
    fg: (_color, text) => text,
    bold: text => text,
    strikethrough: text => text,
  };
  return { widgets, ui, theme };
}

function render(widgets: Map<string, unknown>, theme: Theme): string[] {
  const content = widgets.get("tasks") as undefined | ((tui: unknown, theme: Theme) => { render(): string[] });
  if (!content) return [];
  return content({ terminal: { columns: 240 } }, theme).render();
}

describe("grouped task widget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let view: ReturnType<typeof fixture>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    view = fixture();
    widget.setUICtx(view.ui);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("renders grouped hierarchy with compact ID-only blockers", () => {
    const design = store.createGroup("Design");
    const build = store.createGroup("Build", undefined, [design.id]);
    const verify = store.createGroup("Verify", undefined, [build.id]);
    store.create("Specify", "d", undefined, undefined, design.id);
    store.create("Implement", "d", undefined, undefined, build.id);
    store.update("2", { addBlockedBy: ["1"] });
    store.create("Check", "d", undefined, undefined, verify.id);
    widget.update();

    expect(render(view.widgets, view.theme).slice(1)).toEqual([
      "  ◻ G1 Design (0/1 completed)",
      "    ◻ #1 Specify",
      "  ◻ G2 Build (0/1 completed) › blocked by G1",
      "    ◻ #2 Implement › blocked by G1, #1",
      "  ◻ G3 Verify (0/1 completed) › blocked by G1, G2",
      "    ◻ #3 Check › blocked by G1, G2",
    ]);
  });

  it("shows empty planning groups in topological order", () => {
    const upstream = store.createGroup("Upstream");
    store.create("Work", "d", undefined, undefined, upstream.id);
    store.createGroup("Empty downstream", undefined, [upstream.id]);
    widget.update();

    const lines = render(view.widgets, view.theme);
    expect(lines.findIndex(line => line.includes("G1 Upstream")))
      .toBeLessThan(lines.findIndex(line => line.includes("G2 Empty downstream")));
    expect(lines.join("\n")).toContain("◻ G2 Empty downstream (empty) › blocked by G1");
  });

  it("styles group IDs bold and dim while styling active names like active tasks", () => {
    const group = store.createGroup("Build");
    store.create("Implement", "d", "Implementing", undefined, group.id);
    store.update("1", { status: "in_progress" });
    const styledTheme: Theme = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: text => `<bold>${text}</bold>`,
      strikethrough: text => `<strike>${text}</strike>`,
    };

    widget.setActiveTask("1");
    const lines = render(view.widgets, styledTheme);
    expect(lines[1]).toContain("<accent>✳</accent> <dim><bold>G1</bold></dim> <accent>Build</accent>");
  });

  it("uses retained hidden tasks in progress but removes a fully hidden group from the normal widget", () => {
    const group = store.createGroup("Done phase");
    store.create("Done", "d", undefined, undefined, group.id);
    store.update("1", { status: "completed" });
    widget.update();
    expect(render(view.widgets, view.theme).join("\n")).toContain("1/1 completed");

    store.hide("1");
    widget.update();
    expect(render(view.widgets, view.theme)).toEqual([]);
    expect(store.getGroupSummary(group.id)).toMatchObject({ completed: 1, hidden: 1 });
  });
});
