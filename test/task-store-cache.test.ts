/**
 * The cached parse in TaskStore: reads are validated against the file's identity
 * instead of re-reading and re-parsing on every call, because the widget's render
 * path goes through here many times a second.
 *
 * The contract these pin, in both directions: an unchanged file is read once, and
 * anything that changes the file — including a write that lands in the same
 * filesystem tick and keeps the file size — is still picked up. Writes by other
 * sessions are what makes a task list shared, so a stale read is not a cache hit,
 * it is a lost task.
 */

import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";

// readFileSync is the thing the cache exists to avoid, so the tests count it
// instead of inferring it from timing.
const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      reads.paths.push(String(args[0]));
      return actual.readFileSync(...args);
    },
  };
});

let dir: string;
let file: string;

/** Reads of the task file since the last reset. */
function readsOfTaskFile(): number {
  return reads.paths.filter(path => path === file).length;
}

/** Restore a file's timestamps to `stat`'s, so only the stated field can give a
 *  write away. */
function restoreTimes(path: string, stat: ReturnType<typeof statSync>) {
  utimesSync(path, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-cache-"));
  file = join(dir, "tasks.json");
  reads.paths = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("TaskStore — cached parse", () => {
  it("reads the file once for a run of reads", () => {
    const writer = new TaskStore(file);
    writer.create("Task", "d");

    const reader = new TaskStore(file);
    expect(readsOfTaskFile()).toBe(1);
    reads.paths = [];
    for (let i = 0; i < 50; i += 1) {
      reader.list();
      reader.listGroups();
      reader.get("1");
      reader.getGroupSummary("g1");
    }

    expect(readsOfTaskFile()).toBe(0);
    expect(reader.list().map(task => task.subject)).toEqual(["Task"]);
  });

  it("does not re-read the file after its own write", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");
    reads.paths = [];

    store.update("1", { status: "in_progress" });
    store.list();

    expect(readsOfTaskFile()).toBe(0);
    expect(store.get("1")?.status).toBe("in_progress");
  });

  it("sees a write that changes only the file size", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");
    const before = statSync(file);
    expect(store.list()).toHaveLength(1);

    writeFileSync(file, readFileSync(file, "utf-8").replace('"d"', '"a much longer description"'));
    restoreTimes(file, before);
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).not.toBe(before.size);

    expect(store.list().map(task => task.description)).toEqual(["a much longer description"]);
  });

  it("sees an atomic replace that changes neither the size nor the mtime", () => {
    const store = new TaskStore(file);
    store.create("Original", "d");
    const before = statSync(file);
    expect(store.list().map(task => task.id)).toEqual(["1"]);

    // How another session writes: a temp file renamed over the target. Identical
    // byte length (only a digit differs) and the mtime put back, so the inode is
    // the only thing that gives the write away.
    const tmpPath = `${file}.other`;
    writeFileSync(tmpPath, readFileSync(file, "utf-8").replace('"id": "1"', '"id": "2"'));
    renameSync(tmpPath, file);
    restoreTimes(file, before);
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).not.toBe(before.ino);

    expect(store.list().map(task => task.id)).toEqual(["2"]);
  });

  it("keeps the last good state when the file turns malformed", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");

    writeFileSync(file, "{ not json");

    expect(store.list().map(task => task.subject)).toEqual(["Task"]);
    expect(readsOfTaskFile()).toBe(1);
  });

  it("forgets tasks when the file is removed underneath it", () => {
    const store = new TaskStore(file);
    store.create("Task", "d");
    expect(store.list()).toHaveLength(1);

    rmSync(file);

    expect(store.list()).toEqual([]);
    expect(store.create("Later", "d").id).toBe("1");
  });

  it("does not resurrect tasks after the store file is deleted and rewritten", () => {
    const a = new TaskStore(file);
    const b = new TaskStore(file);
    a.create("Doomed", "d");

    a.clearAll();
    expect(a.deleteFileIfEmpty()).toBe(true);
    b.create("Fresh", "d");

    expect(new TaskStore(file).list().map(task => task.subject)).toEqual(["Fresh"]);
  });
});
