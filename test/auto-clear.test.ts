import { beforeEach, describe, expect, it } from "vitest";
import type { AutoClearMode } from "../src/auto-clear.js";
import { AutoClearManager } from "../src/auto-clear.js";
import { TaskStore } from "../src/task-store.js";

describe("auto-clear: on_task_complete mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "on_task_complete");
  });

  it("does not clear completed task before REMINDER_INTERVAL turns", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turns 2, 3, 4 — not enough
    for (let turn = 2; turn <= 4; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.get("1")).toBeDefined();
    expect(store.get("1")!.status).toBe("completed");
  });

  it("hides completed task after REMINDER_INTERVAL turns", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turn 5 = turn 1 + 4 (REMINDER_INTERVAL)
    manager.onTurnStart(5);
    expect(store.get("1")?.hidden).toBe(true);
    expect(store.listVisible()).toHaveLength(0);
  });

  it("hides each task independently based on its own completion turn", () => {
    store.create("Task A", "Desc");
    store.create("Task B", "Desc");

    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 3);

    // Turn 5: Task A expires (1+4), Task B still lingers (3+4=7)
    manager.onTurnStart(5);
    expect(store.get("1")?.hidden).toBe(true);
    expect(store.get("2")?.hidden).not.toBe(true);

    // Turn 7: Task B expires
    manager.onTurnStart(7);
    expect(store.get("2")?.hidden).toBe(true);
  });

  it("does not hide pending or in_progress tasks", () => {
    store.create("Pending", "Desc");
    store.create("In Progress", "Desc");
    store.create("Completed", "Desc");
    store.update("2", { status: "in_progress" });
    store.update("3", { status: "completed" });
    manager.trackCompletion("3", 1);

    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined(); // pending — untouched
    expect(store.get("2")).toBeDefined(); // in_progress — untouched
    expect(store.get("3")?.hidden).toBe(true); // completed — retained but hidden
  });

  it("retains dependency edges when auto-hiding", () => {
    store.create("Blocker", "Desc");
    store.create("Blocked", "Desc");
    store.update("1", { addBlocks: ["2"] });
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(5);
    expect(store.get("1")?.hidden).toBe(true);
    expect(store.get("2")!.blockedBy).toEqual(["1"]);
  });

  it("does not re-hide a restored task on its old countdown", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);
    store.hide("1");
    store.update("1", { hidden: false });
    manager.clearTaskCountdown("1");

    manager.onTurnStart(5);
    expect(store.get("1")?.hidden).not.toBe(true);
  });

  it("returns true when tasks are hidden", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    expect(manager.onTurnStart(4)).toBe(false);
    expect(manager.onTurnStart(5)).toBe(true);
  });
});

describe("auto-clear: on_list_complete mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "on_list_complete");
  });

  it("does not clear when some tasks are still pending", () => {
    store.create("Done", "Desc");
    store.create("Pending", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    for (let turn = 2; turn <= 10; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.get("1")).toBeDefined();
    expect(store.list()).toHaveLength(2);
  });

  it("does not clear immediately when all tasks complete", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    // Turns 2-4: not enough
    for (let turn = 2; turn <= 4; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.list()).toHaveLength(2);
  });

  it("hides all completed tasks after REMINDER_INTERVAL turns when all are completed", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    manager.onTurnStart(5);
    expect(store.listVisible()).toHaveLength(0);
  });

  it("resets countdown when a new task is created before REMINDER_INTERVAL", () => {
    store.create("A", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Turn 3: new task created — reset countdown
    manager.onTurnStart(3);
    manager.resetBatchCountdown();
    store.create("B", "Desc");

    // Turn 5 would have cleared, but countdown was reset at turn 3
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined(); // still around — list isn't all completed
  });

  it("resets countdown when a task goes back to in_progress", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("2", 1);

    // Turn 3: task 2 goes back to in_progress
    manager.onTurnStart(3);
    store.update("2", { status: "in_progress" });
    manager.resetBatchCountdown();

    // Turn 5: would have cleared, but countdown was reset
    manager.onTurnStart(5);
    expect(store.list()).toHaveLength(2); // both still here
  });

  it("returns true when tasks are hidden", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    expect(manager.onTurnStart(4)).toBe(false);
    expect(manager.onTurnStart(5)).toBe(true);
  });
});

describe("auto-clear: never mode", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(() => store, () => "never");
  });

  it("never hides completed tasks regardless of turns", () => {
    store.create("A", "Desc");
    store.create("B", "Desc");
    store.update("1", { status: "completed" });
    store.update("2", { status: "completed" });
    manager.trackCompletion("1", 1);
    manager.trackCompletion("2", 1);

    for (let turn = 2; turn <= 20; turn++) {
      manager.onTurnStart(turn);
    }
    expect(store.list()).toHaveLength(2);
  });

  it("trackCompletion is a no-op", () => {
    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(100);
    expect(store.get("1")).toBeDefined();
  });
});

describe("auto-clear: dynamic mode switching", () => {
  it("respects mode changes via getMode callback", () => {
    const store = new TaskStore();
    let mode: AutoClearMode = "never";
    const manager = new AutoClearManager(() => store, () => mode);

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });

    // Track in never mode — no-op
    manager.trackCompletion("1", 1);
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();

    // Switch to on_task_complete and re-track
    mode = "on_task_complete";
    manager.trackCompletion("1", 5);
    manager.onTurnStart(9);
    expect(store.get("1")?.hidden).toBe(true);
  });
});

describe("auto-clear: store getter (session switch)", () => {
  it("operates on the current store after swap", () => {
    let store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Old task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate session switch — swap store
    store = new TaskStore();
    store.create("New task", "Desc");
    manager.reset();

    // Old task tracking was reset, new store has no completed tasks
    manager.onTurnStart(5);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")!.subject).toBe("New task");
  });

  it("hides in the new store, not old store", () => {
    let store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    // Swap to new store with a completed task
    store = new TaskStore();
    store.create("Task in new store", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.onTurnStart(5);
    expect(store.get("1")?.hidden).toBe(true); // hidden in the new store
  });
});

describe("auto-clear: reset (new session)", () => {
  it("reset clears per-task tracking so old completions don't fire", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate /new — reset before the delay expires
    manager.reset();

    // Old completion should NOT trigger after reset
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();
  });

  it("reset clears batch countdown so old all-completed state doesn't fire", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    // Simulate /new — reset before the delay expires
    manager.reset();

    // Old batch countdown should NOT trigger after reset
    manager.onTurnStart(5);
    expect(store.get("1")).toBeDefined();
  });

  it("tracking works normally after reset", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_task_complete");

    store.create("Task", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);
    manager.reset();

    // Re-track after reset with new turn baseline
    manager.trackCompletion("1", 10);
    manager.onTurnStart(14);
    expect(store.get("1")?.hidden).toBe(true);
  });
});

describe("auto-clear: starting a new batch", () => {
  /** Complete every task in the store and tell the manager about it. */
  function completeAll(store: TaskStore, manager: AutoClearManager, turn: number): void {
    for (const task of store.list()) {
      store.update(task.id, { status: "completed" });
      manager.trackCompletion(task.id, turn);
    }
  }

  for (const mode of ["on_list_complete", "on_task_complete"] as const) {
    it(`retires a finished list before the new tasks land (${mode})`, () => {
      const store = new TaskStore();
      const manager = new AutoClearManager(() => store, () => mode);
      store.create("A", "Desc");
      store.create("B", "Desc");
      completeAll(store, manager, 1);

      // The run ends here — nowhere near the delay either mode would need, and the
      // countdown stops ticking with it.
      manager.onRunEnded();
      manager.startNewBatch();
      expect(store.listVisible()).toHaveLength(0);

      // IDs are not reused — the new task is #3.
      expect(store.create("C", "Desc").id).toBe("3");
    });
  }

  it("keeps a list the agent is still building in the same run", () => {
    // create → complete → create again is one batch taking shape, not a new one.
    // Nothing but the run boundary tells it apart from the case above.
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");

    manager.startNewBatch();
    store.create("Step one", "Desc");
    completeAll(store, manager, 1);

    manager.startNewBatch();
    store.create("Step two", "Desc");

    expect(store.list().map(t => t.subject)).toEqual(["Step one", "Step two"]);
  });

  it("keeps the list in never mode", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "never");
    store.create("A", "Desc");
    completeAll(store, manager, 1);

    manager.onRunEnded();
    manager.startNewBatch();
    expect(store.list()).toHaveLength(1);
  });

  it("leaves a list with unfinished work alone", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");
    store.create("Done", "Desc");
    store.create("Still going", "Desc");
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);
    store.update("2", { status: "in_progress" });

    manager.onRunEnded();
    manager.startNewBatch();
    expect(store.list()).toHaveLength(2);
  });

  it("does nothing on an empty store", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");

    manager.onRunEnded();
    manager.startNewBatch();
    expect(store.listVisible()).toHaveLength(0);
  });

  it("hides a list a subagent finished after its run ended", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");
    store.create("Cascaded", "Desc");
    store.update("1", { status: "in_progress" });
    manager.onRunEnded();
    // Completion lands late, outside any turn — nothing ticks the countdown after it.
    store.update("1", { status: "completed" });
    manager.trackCompletion("1", 1);

    manager.startNewBatch();
    expect(store.listVisible()).toHaveLength(0);
  });

  it("arms once per run, so the batch it starts is not swept mid-build", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");
    store.create("Old", "Desc");
    completeAll(store, manager, 1);

    manager.onRunEnded();
    manager.startNewBatch();
    store.create("First of the new batch", "Desc");
    completeAll(store, manager, 3);

    // Still the same run: the next task joins that batch rather than replacing it.
    manager.startNewBatch();
    store.create("Second of the new batch", "Desc");
    expect(store.listVisible()).toHaveLength(2);
  });

  it("does not cut the new batch's own countdown short", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");
    store.create("Old", "Desc");
    completeAll(store, manager, 1);

    manager.onRunEnded();
    manager.startNewBatch();
    store.create("New", "Desc");
    completeAll(store, manager, 3);

    expect(manager.onTurnStart(4)).toBe(false); // 3 + 4 not reached
    expect(store.listVisible()).toHaveLength(1);
    expect(manager.onTurnStart(7)).toBe(true);
    expect(store.listVisible()).toHaveLength(0);
  });

  it("reset drops the armed boundary", () => {
    const store = new TaskStore();
    const manager = new AutoClearManager(() => store, () => "on_list_complete");
    store.create("A", "Desc");
    completeAll(store, manager, 1);

    manager.onRunEnded();
    manager.reset(); // /new — nothing may carry over into the next session

    manager.startNewBatch();
    expect(store.list()).toHaveLength(1);
  });
});
