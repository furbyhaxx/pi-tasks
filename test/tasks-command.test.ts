/**
 * The /tasks command: menu routing, the task detail actions, and the clear/create
 * flows. Driven by a scripted UI that answers each prompt in order and returns
 * undefined once the script runs out, which unwinds the handler's recursion.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { TaskStore } from "../src/task-store.js";
import { flush, installBackgroundJobsMock, mockPi } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

/** A script entry is either the literal answer or an index into the offered choices. */
type Answer = string | number | undefined;

function scriptedUI(script: Answer[]) {
  const selects: Array<{ title: string; choices: string[] }> = [];
  const inputs: string[] = [];
  const customCalls: any[] = [];

  const ui = {
    async select(title: string, choices: string[]) {
      selects.push({ title, choices });
      const answer = script.shift();
      return typeof answer === "number" ? choices[answer] : answer;
    },
    async input(prompt: string) {
      inputs.push(prompt);
      const answer = script.shift();
      return typeof answer === "number" ? undefined : answer;
    },
    async confirm() { return true; },
    async custom(factory: any) {
      // The factory is not invoked: it builds a real SettingsList, which needs pi's
      // global theme initialized. What /tasks owns is the routing, asserted below.
      customCalls.push(factory);
      return undefined;
    },
    setWidget: vi.fn(),
    setStatus: vi.fn(),
    notify: vi.fn(),
  };

  return { ui, selects, inputs, customCalls };
}

let dir: string;
let taskFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-cmd-"));
  taskFile = join(dir, "tasks.json");
  process.env.PI_TASKS = taskFile;
  config.current = {};
});

afterEach(() => {
  delete process.env.PI_TASKS;
  rmSync(dir, { recursive: true, force: true });
});

/** Boot the extension, seed tasks, and run /tasks against a scripted UI. */
async function runTasks(script: Answer[], seed: (mock: ReturnType<typeof mockPi>) => Promise<void>) {
  const mock = mockPi();
  initExtension(mock.pi as any);
  await seed(mock);
  const scripted = scriptedUI(script);
  await mock.runCommand("tasks", "", { ui: scripted.ui });
  return { mock, ...scripted };
}

const create = (subject: string) => async (mock: ReturnType<typeof mockPi>) => {
  await mock.executeTool("TaskCreate", { subject, description: "d" });
};

describe("/tasks main menu", () => {
  it("offers only view and create when the list is empty", async () => {
    const { selects } = await runTasks([undefined], async () => {});
    expect(selects[0].choices).toEqual(["View all tasks (0)", "Create task", "Create task group", "Settings"]);
  });

  it("offers the clear actions with their counts once tasks exist", async () => {
    const { selects } = await runTasks([undefined], async mock => {
      await create("Done")(mock);
      await create("Open")(mock);
      await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    expect(selects[0].choices).toEqual([
      "View all tasks (2)",
      "Create task",
      "Create task group",
      "Hide completed (1)",
      "Delete all (2 tasks, 0 groups)",
      "Settings",
    ]);
  });

  it("opens the settings panel and returns to the main menu afterwards", async () => {
    const { customCalls, selects } = await runTasks(["Settings", undefined], async () => {});
    expect(customCalls).toHaveLength(1);
    expect(selects).toHaveLength(2);
    expect(selects[1].title).toBe("Tasks");
  });

  it("opens Jobs without recursively reopening a selector over its overlay", async () => {
    let requests: ReturnType<typeof installBackgroundJobsMock>["requests"] | undefined;
    const { selects } = await runTasks(["Jobs (1)"], async mock => {
      const jobs = installBackgroundJobsMock(mock.pi, {
        jobs: [
          { id: "job-00000001", status: "running", isBackground: true },
          { id: "job-00000002", status: "running", isBackground: false },
        ],
      });
      requests = jobs.requests;
      jobs.ready();
      await flush();
    });

    expect(selects[0]?.choices).toContain("Jobs (1)");
    expect(selects).toHaveLength(1);
    expect(requests?.open).toHaveLength(1);
  });

  it("keeps the jobs entry hidden when the companion is absent", async () => {
    const { selects } = await runTasks([undefined], async () => {});
    expect(selects[0]?.choices.some(choice => choice.startsWith("Jobs ("))).toBe(false);
  });

  it("points to /jobs and returns when the companion cannot accept an overlay", async () => {
    const { ui, selects } = await runTasks(["Jobs (0)"], async mock => {
      const jobs = installBackgroundJobsMock(mock.pi, { open: false });
      jobs.ready();
      await flush();
    });

    expect(ui.notify).toHaveBeenCalledWith(
      "The jobs overlay could not open here. Run /jobs directly.",
      "warning",
    );
    expect(selects).toHaveLength(1);
  });
});

describe("/tasks task detail", () => {
  it("starts a pending task", async () => {
    const { mock } = await runTasks([0, 0, "▸ Start (in_progress)"], create("Work"));
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text)
      .toContain("Status: in_progress");
  });

  it("completes an in-progress task", async () => {
    const { mock } = await runTasks([0, 0, "▸ Start (in_progress)", 0, "✓ Complete"], create("Work"));
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text)
      .toContain("Status: completed");
  });

  it("deletes a task", async () => {
    const { mock } = await runTasks([0, 0, "✗ Delete permanently"], create("Work"));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("offers Complete only for in-progress tasks", async () => {
    const { selects } = await runTasks([0, 0, undefined], create("Work"));
    expect(selects[2].choices).toEqual(["▸ Start (in_progress)", "✗ Delete permanently", "← Back"]);
  });

  it("acts on the task whose row was picked, not on an ID inside its subject", async () => {
    // The row reads "◻ #1 [pending] Fix #42 in the parser" — the ID must come from
    // the row's own marker, not from the first number that happens to follow a '#'.
    const { mock } = await runTasks([0, 0, "✗ Delete permanently"], create("Fix #42 in the parser"));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("acts on the picked row even when the status glyph contains an ID", async () => {
    // Nothing stops a hand-written glyph from looking like a task marker.
    config.current = { glyphs: { pending: "#12" } };

    const { mock } = await runTasks([0, 0, "✗ Delete permanently"], create("Work"));

    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("lists tasks with the default status glyphs", async () => {
    const { selects } = await runTasks([0, undefined], create("Work"));
    expect(selects[1].choices).toEqual(["◻ #1 [pending] Work", "← Back"]);
  });

  it("lists tasks with the configured status glyphs", async () => {
    config.current = { glyphs: { pending: "[ ]" } };

    const { selects } = await runTasks([0, undefined], create("Work"));

    expect(selects[1].choices).toEqual(["[ ] #1 [pending] Work", "← Back"]);
  });

  it("shows groups and indents their tasks", async () => {
    const { selects } = await runTasks([0, undefined], async m => {
      await m.executeTool("TaskGroupCreate", { subject: "Planning" });
      await m.executeTool("TaskCreate", { subject: "Design", description: "d", groupId: "g1" });
      await m.executeTool("TaskCreate", { subject: "Loose", description: "d" });
    });

    expect(selects[1].choices).toEqual([
      "◻ g1: Planning (0/1 completed)",
      "  ◻ #1 [pending] Design",
      "◻ Ungrouped",
      "  ◻ #2 [pending] Loose",
      "← Back",
    ]);
  });

  it("opens the indented task row that was picked", async () => {
    const { mock } = await runTasks([0, "  ◻ #1 [pending] Design", "✗ Delete permanently"], async m => {
      await m.executeTool("TaskGroupCreate", { subject: "Planning" });
      await m.executeTool("TaskCreate", { subject: "Design", description: "d", groupId: "g1" });
    });

    expect((await mock.executeTool("TaskList", {})).content[0].text).not.toContain("Design");
  });

  it("shows empty groups in the task list", async () => {
    const { selects } = await runTasks([0, undefined], async m => {
      await m.executeTool("TaskGroupCreate", { subject: "Planning" });
    });

    expect(selects[1].choices).toEqual(["◻ g1: Planning (0/0 completed)", "← Back"]);
  });

  it("shows a placeholder screen when there is nothing to view", async () => {
    const { selects } = await runTasks([0, undefined], async () => {});
    expect(selects[1]).toEqual({ title: "No tasks", choices: ["← Back"] });
  });
});

describe("/tasks clearing", () => {
  it("clears only completed tasks", async () => {
    const { mock } = await runTasks(["Hide completed (1)", undefined], async m => {
      await create("Done")(m);
      await create("Open")(m);
      await m.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    const list = (await mock.executeTool("TaskList", {})).content[0].text;
    expect(list).toContain("Open");
    expect(list).not.toContain("Done");
  });

  it("clears every task and removes the now-empty session file", async () => {
    const { mock } = await runTasks(["Delete all (2 tasks, 0 groups)", undefined], async m => {
      await create("One")(m);
      await create("Two")(m);
    });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
    expect(existsSync(taskFile)).toBe(false);
  });

  it("keeps the file when clearing completed leaves work behind", async () => {
    await runTasks(["Hide completed (1)", undefined], async m => {
      await create("Done")(m);
      await create("Open")(m);
      await m.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    expect(existsSync(taskFile)).toBe(true);
    const retained = new TaskStore(taskFile);
    expect(retained.listVisible().map(t => t.subject)).toEqual(["Open"]);
    expect(retained.get("1")).toMatchObject({ subject: "Done", hidden: true });
  });
});

describe("/tasks task groups and history", () => {
  it("creates a task group from the menu", async () => {
    const { mock } = await runTasks(
      ["Create task group", "Planning", "Shared context", undefined],
      async () => {},
    );
    const list = (await mock.executeTool("TaskList", {})).content[0].text;
    expect(list).toContain("g1: Planning");
    expect(list).toContain("0/0 completed");
  });

  it("restores a hidden task from history", async () => {
    const { mock } = await runTasks(["Show history (1)", 0, "Restore", undefined], async m => {
      await create("Done")(m);
      await m.executeTool("TaskUpdate", { taskId: "1", status: "completed", hidden: true });
    });
    const task = (await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text;
    expect(task).not.toContain("Visibility: hidden history");
  });
});

describe("/tasks create", () => {
  it("creates a task from the subject and description prompts", async () => {
    const { mock, inputs } = await runTasks(
      ["Create task", "Ship it", "Get the release out", undefined],
      async () => {},
    );
    expect(inputs).toEqual(["Task subject", "Task description"]);
    const task = (await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text;
    expect(task).toContain("Ship it");
    expect(task).toContain("Get the release out");
  });

  it("creates nothing when the subject prompt is cancelled", async () => {
    const { mock, inputs } = await runTasks(["Create task", undefined], async () => {});
    expect(inputs).toEqual(["Task subject"]);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("creates nothing when the description prompt is cancelled", async () => {
    const { mock } = await runTasks(["Create task", "Ship it", undefined], async () => {});
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });
});
