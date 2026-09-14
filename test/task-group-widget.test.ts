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

  it("shows group progress and indented children in dependency order", () => {
    const design = store.createGroup("Design");
    const build = store.createGroup("Build", undefined, [design.id]);
    store.create("Specify", "d", undefined, undefined, design.id);
    store.create("Implement", "d", undefined, undefined, build.id);
    widget.update();

    const lines = render(view.widgets, view.theme);
    expect(lines.findIndex(line => line.includes("g1 Design")))
      .toBeLessThan(lines.findIndex(line => line.includes("g2 Build")));
    expect(lines.join("\n")).toContain("0/1 completed");
    expect(lines.join("\n")).toContain("blocked: group g1");
    expect(lines.join("\n")).toContain("#2 Implement");
  });

  it("shows empty planning groups in topological order", () => {
    const upstream = store.createGroup("Upstream");
    store.create("Work", "d", undefined, undefined, upstream.id);
    store.createGroup("Empty downstream", undefined, [upstream.id]);
    widget.update();

    const lines = render(view.widgets, view.theme);
    expect(lines.findIndex(line => line.includes("g1 Upstream")))
      .toBeLessThan(lines.findIndex(line => line.includes("g2 Empty downstream")));
    expect(lines.join("\n")).toContain("g2 Empty downstream (empty)");
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
