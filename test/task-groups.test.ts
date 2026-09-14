import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore task groups", () => {
  it("creates stable group IDs and persists membership and dependencies", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-groups-"));
    const file = join(dir, "tasks.json");
    try {
      const store = new TaskStore(file);
      const design = store.createGroup("Design");
      const build = store.createGroup("Build", undefined, [design.id]);
      store.create("Specify", "d", undefined, undefined, design.id);
      store.create("Implement", "d", undefined, undefined, build.id);

      const reopened = new TaskStore(file);
      expect(reopened.listGroups().map(group => group.id)).toEqual(["g1", "g2"]);
      expect(reopened.getGroup("g2")?.blockedBy).toEqual(["g1"]);
      expect(reopened.get("2")?.groupId).toBe("g2");
      expect(JSON.parse(readFileSync(file, "utf-8")).nextGroupId).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshots and seeds group-only plans", () => {
    const parent = new TaskStore();
    parent.createGroup("Planned phase");
    const child = new TaskStore();

    child.seed(parent.snapshot());

    expect(child.list()).toEqual([]);
    expect(child.listGroups().map(group => group.subject)).toEqual(["Planned phase"]);
    expect(child.createGroup("Next phase").id).toBe("g2");
  });

  it("blocks a downstream group until every upstream task is completed", () => {
    const store = new TaskStore();
    const upstream = store.createGroup("Upstream");
    const downstream = store.createGroup("Downstream", undefined, [upstream.id]);
    store.create("A1", "d", undefined, undefined, upstream.id);
    store.create("A2", "d", undefined, undefined, upstream.id);
    store.create("B", "d", undefined, undefined, downstream.id);

    expect(store.getReadiness("3").blockers.join(" ")).toContain("g1");
    store.update("1", { status: "completed" });
    expect(store.getReadiness("3").ready).toBe(false);
    store.update("2", { status: "completed" });
    expect(store.getReadiness("3")).toEqual({ ready: true, blockers: [] });
  });

  it("keeps empty prerequisite groups blocking", () => {
    const store = new TaskStore();
    const empty = store.createGroup("Empty");
    const downstream = store.createGroup("Downstream", undefined, [empty.id]);
    store.create("B", "d", undefined, undefined, downstream.id);

    expect(store.getReadiness("1").ready).toBe(false);
    expect(store.getReadiness("1").blockers.join(" ")).toContain("0/0 completed");
  });

  it("rejects group cycles and effective cycles crossing task edges", () => {
    const store = new TaskStore();
    const a = store.createGroup("A");
    const b = store.createGroup("B", undefined, [a.id]);
    store.create("Task A", "d", undefined, undefined, a.id);
    store.create("Task B", "d", undefined, undefined, b.id);

    expect(() => store.updateGroup(a.id, { addBlockedBy: [b.id] })).toThrow("Dependency cycle");
    expect(() => store.update("1", { addBlockedBy: ["2"] })).toThrow("Dependency cycle");
    expect(store.get("1")?.blockedBy).toEqual([]);
  });

  it("retains hidden completed tasks, results, edges, and group progress", () => {
    const store = new TaskStore();
    const group = store.createGroup("Phase");
    store.create("Done", "d", undefined, { result: "kept" }, group.id);
    store.create("Next", "d", undefined, undefined, group.id);
    store.update("2", { addBlockedBy: ["1"] });
    store.update("1", { status: "completed" });

    expect(store.hideCompleted()).toBe(1);
    expect(store.listVisible().map(task => task.id)).toEqual(["2"]);
    expect(store.get("1")?.metadata.result).toBe("kept");
    expect(store.get("2")?.blockedBy).toEqual(["1"]);
    expect(store.getGroupSummary(group.id)).toMatchObject({ total: 2, completed: 1, hidden: 1 });
    expect(store.getReadiness("2").ready).toBe(true);
  });

  it("reopening restores a hidden task and blocks downstream starts again", () => {
    const store = new TaskStore();
    const a = store.createGroup("A");
    const b = store.createGroup("B", undefined, [a.id]);
    store.create("A", "d", undefined, undefined, a.id);
    store.create("B", "d", undefined, undefined, b.id);
    store.update("1", { status: "completed", hidden: true });

    store.update("1", { status: "pending" });
    expect(store.get("1")?.hidden).toBeUndefined();
    expect(store.getReadiness("2").ready).toBe(false);
  });

  it("rejects deleting referenced groups and otherwise detaches their tasks", () => {
    const store = new TaskStore();
    const a = store.createGroup("A");
    const b = store.createGroup("B", undefined, [a.id]);
    store.create("A task", "d", undefined, undefined, a.id);

    expect(() => store.deleteGroup(a.id)).toThrow(`required by ${b.id}`);
    store.updateGroup(b.id, { removeBlockedBy: [a.id] });
    expect(store.deleteGroup(a.id)).toBe(true);
    expect(store.get("1")?.groupId).toBeUndefined();
  });

  it("blocks claims when a legacy persisted task graph contains a cycle", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-cycle-invalid-"));
    const file = join(dir, "tasks.json");
    try {
      writeFileSync(file, JSON.stringify({
        nextId: 3,
        tasks: [
          { id: "1", subject: "Pending", description: "d", status: "pending", blockedBy: ["2"], blocks: ["2"] },
          { id: "2", subject: "Completed", description: "d", status: "completed", blockedBy: ["1"], blocks: ["1"] },
        ],
      }));
      const store = new TaskStore(file);
      expect(store.getReadiness("1").blockers).toContain("invalid dependency graph: cycle detected");
      expect(store.claim("1").task?.status).toBe("pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows legacy cycles to be repaired incrementally without blocking unrelated work", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-cycles-repair-"));
    const file = join(dir, "tasks.json");
    try {
      const task = (id: string, blockedBy: string[], blocks: string[]) => ({
        id, subject: `Task ${id}`, description: "d", status: "pending", blockedBy, blocks,
      });
      writeFileSync(file, JSON.stringify({
        nextId: 6,
        tasks: [
          task("1", ["2"], ["2"]),
          task("2", ["1"], ["1"]),
          task("3", ["4"], ["4"]),
          task("4", ["3"], ["3"]),
          task("5", [], []),
        ],
      }));
      const store = new TaskStore(file);
      expect(store.getReadiness("5").ready).toBe(true);
      expect(() => store.update("1", { removeBlockedBy: ["2"] })).not.toThrow();
      expect(store.get("1")?.blockedBy).toEqual([]);
      expect(store.getReadiness("3").blockers).toContain("invalid dependency graph: cycle detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces malformed persisted group references as blockers without recursing forever", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-task-groups-invalid-"));
    const file = join(dir, "tasks.json");
    try {
      writeFileSync(file, JSON.stringify({
        nextId: 2,
        nextGroupId: 3,
        groups: [
          { id: "g1", subject: "A", blockedBy: ["g2"] },
          { id: "g2", subject: "B", blockedBy: ["g1"] },
        ],
        tasks: [{ id: "1", subject: "Task", description: "d", status: "pending", groupId: "g1" }],
      }));
      const readiness = new TaskStore(file).getReadiness("1");
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.join(" ")).toContain("cycle involving group");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires running and completed tasks to be reset before moving", () => {
    const store = new TaskStore();
    const a = store.createGroup("A");
    const b = store.createGroup("B");
    store.create("Task", "d", undefined, undefined, a.id);
    store.update("1", { status: "in_progress" });

    expect(() => store.update("1", { groupId: b.id })).toThrow("reset to pending");
    store.update("1", { groupId: b.id, status: "pending" });
    expect(store.get("1")).toMatchObject({ groupId: b.id, status: "pending" });
  });
});
