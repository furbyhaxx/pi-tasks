/**
 * task-store.ts — File-backed task and task-group store with dependency management
 * and file locking.
 *
 * Session-scoped (default): in-memory state — no disk I/O.
 * Shared stores use an atomic read-modify-write cycle guarded by a file lock.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { sortTasks, type TaskSortOrder } from "./task-sort.js";
import type { Task, TaskGroup, TaskReadiness, TaskStatus, TaskStoreData } from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function acquireLock(lockPath: string): string {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      return token;
    } catch (error: any) {
      if (error.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid > 0 ? !isProcessRunning(pid) : i >= 2) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
  } catch { /* already gone */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function normalizeTask(task: Task): Task {
  const now = Date.now();
  return {
    ...task,
    groupId: typeof task.groupId === "string" ? task.groupId : undefined,
    hidden: task.hidden === true ? true : undefined,
    metadata: task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata) ? task.metadata : {},
    blocks: Array.isArray(task.blocks) ? task.blocks.filter((id): id is string => typeof id === "string") : [],
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter((id): id is string => typeof id === "string") : [],
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
  };
}

function normalizeGroup(group: TaskGroup): TaskGroup {
  const now = Date.now();
  return {
    ...group,
    description: typeof group.description === "string" ? group.description : undefined,
    blockedBy: Array.isArray(group.blockedBy)
      ? [...new Set(group.blockedBy.filter((id): id is string => typeof id === "string"))]
      : [],
    createdAt: typeof group.createdAt === "number" ? group.createdAt : now,
    updatedAt: typeof group.updatedAt === "number" ? group.updatedAt : now,
  };
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    metadata: { ...task.metadata },
    blocks: [...task.blocks],
    blockedBy: [...task.blockedBy],
  };
}

function cloneGroup(group: TaskGroup): TaskGroup {
  return { ...group, blockedBy: [...group.blockedBy] };
}

function numericGroupId(id: string): number {
  const match = /^g(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Stable topological order for group-aware tools and UI. Invalid persisted
 *  cycles are appended by ID; readiness still reports them as blocked. */
export function orderTaskGroups(groups: TaskGroup[]): TaskGroup[] {
  const known = new Set(groups.map(group => group.id));
  const remaining = new Map(groups.map(group => [group.id, group.blockedBy.filter(id => known.has(id)).length]));
  const ordered: TaskGroup[] = [];
  while (ordered.length < groups.length) {
    const ready = groups
      .filter(group => !ordered.some(item => item.id === group.id) && remaining.get(group.id) === 0)
      .sort((a, b) => numericGroupId(a.id) - numericGroupId(b.id));
    if (ready.length === 0) {
      return [...ordered, ...groups
        .filter(group => !ordered.some(item => item.id === group.id))
        .sort((a, b) => numericGroupId(a.id) - numericGroupId(b.id))];
    }
    for (const group of ready) {
      ordered.push(group);
      for (const dependent of groups) {
        if (dependent.blockedBy.includes(group.id)) {
          remaining.set(dependent.id, Math.max(0, (remaining.get(dependent.id) ?? 0) - 1));
        }
      }
    }
  }
  return ordered;
}

export interface TaskUpdateFields {
  status?: TaskStatus | "deleted";
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  groupId?: string | null;
  hidden?: boolean;
  metadata?: Record<string, any>;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
}

export interface TaskGroupUpdateFields {
  subject?: string;
  description?: string | null;
  addBlockedBy?: string[];
  removeBlockedBy?: string[];
}

export interface TaskGroupSummary {
  total: number;
  completed: number;
  inProgress: number;
  hidden: number;
  complete: boolean;
  blockers: string[];
}

/** Identity of a file version. The store writes through a temp file and renames, so
 *  another session's write replaces the inode even when mtime and size land in the
 *  same filesystem tick. */
type FileStamp = { mtimeMs: number; size: number; ino: number };

function statFile(filePath: string): FileStamp | undefined {
  try {
    const stat = statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;
  private nextId = 1;
  private nextGroupId = 1;
  private tasks = new Map<string, Task>();
  private groups = new Map<string, TaskGroup>();
  /** The file version the in-memory state was parsed from; null when the file was
   *  last seen absent. Undefined means nothing has been parsed yet. */
  private diskStamp: FileStamp | null | undefined;

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const filePath = isAbsolute(listIdOrPath) ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    // Every read goes through here, including the render path: the widget is drawn
    // many times a second, so the parse is kept and re-validated by one stat rather
    // than re-read and re-parsed per call.
    const stamp = statFile(this.filePath);
    if (!stamp) {
      this.diskStamp = null;
      this.nextId = 1;
      this.nextGroupId = 1;
      this.tasks.clear();
      this.groups.clear();
      return;
    }
    if (this.diskStamp && sameStamp(this.diskStamp, stamp)) return;
    // Marked fresh before parsing: an unreadable or malformed file retains the
    // current state either way, and re-parsing it on every call would not help.
    this.diskStamp = stamp;
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!data || typeof data !== "object") return;
      const envelope = data as Partial<TaskStoreData>;
      if (!Array.isArray(envelope.tasks)) return;

      const loadedTasks = new Map<string, Task>();
      let maxTaskId = 0;
      for (const task of envelope.tasks) {
        if (!task || typeof task !== "object" || typeof task.id !== "string") continue;
        loadedTasks.set(task.id, normalizeTask(task));
        const numericId = Number(task.id);
        if (Number.isFinite(numericId) && numericId > maxTaskId) maxTaskId = numericId;
      }

      const loadedGroups = new Map<string, TaskGroup>();
      let maxGroupId = 0;
      for (const group of Array.isArray(envelope.groups) ? envelope.groups : []) {
        if (!group || typeof group !== "object" || typeof group.id !== "string") continue;
        loadedGroups.set(group.id, normalizeGroup(group));
        maxGroupId = Math.max(maxGroupId, numericGroupId(group.id));
      }

      this.tasks = loadedTasks;
      this.groups = loadedGroups;
      this.nextId = typeof envelope.nextId === "number" && Number.isInteger(envelope.nextId) && envelope.nextId > maxTaskId
        ? envelope.nextId
        : maxTaskId + 1;
      this.nextGroupId = typeof envelope.nextGroupId === "number"
        && Number.isInteger(envelope.nextGroupId)
        && envelope.nextGroupId > maxGroupId
        ? envelope.nextGroupId
        : maxGroupId + 1;
    } catch { /* unreadable or invalid JSON — retain current state */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      nextGroupId: this.nextGroupId,
      tasks: Array.from(this.tasks.values()),
      groups: Array.from(this.groups.values()),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
    // Our own write is the newest version on disk; stamping it here keeps the next
    // read from re-parsing what we just wrote.
    this.diskStamp = statFile(this.filePath) ?? null;
  }

  private mutate<T>(fn: () => T): T {
    const run = (): T => {
      if (this.filePath) this.load();
      const previousNextId = this.nextId;
      const previousNextGroupId = this.nextGroupId;
      const previousTasks = new Map(Array.from(this.tasks, ([id, task]) => [id, cloneTask(task)]));
      const previousGroups = new Map(Array.from(this.groups, ([id, group]) => [id, cloneGroup(group)]));
      try {
        const result = fn();
        this.save();
        return result;
      } catch (error) {
        this.nextId = previousNextId;
        this.nextGroupId = previousNextGroupId;
        this.tasks = previousTasks;
        this.groups = previousGroups;
        throw error;
      }
    };

    if (!this.lockPath) return run();
    const token = acquireLock(this.lockPath);
    try {
      return run();
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  private requireTask(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task #${id} does not exist`);
    return task;
  }

  private requireGroup(id: string): TaskGroup {
    const group = this.groups.get(id);
    if (!group) throw new Error(`Task group ${id} does not exist`);
    return group;
  }

  private groupTasks(groupId: string): Task[] {
    return Array.from(this.tasks.values()).filter(task => task.groupId === groupId);
  }

  private isGroupComplete(groupId: string): boolean {
    const tasks = this.groupTasks(groupId);
    return tasks.length > 0 && tasks.every(task => task.status === "completed");
  }

  private groupPrerequisiteBlockers(groupId: string, visited = new Set<string>()): string[] {
    if (visited.has(groupId)) return [`cycle involving group ${groupId}`];
    const group = this.groups.get(groupId);
    if (!group) return [`missing group ${groupId}`];

    const nextVisited = new Set(visited).add(groupId);
    const blockers: string[] = [];
    for (const prerequisiteId of group.blockedBy) {
      const prerequisite = this.groups.get(prerequisiteId);
      if (!prerequisite) {
        blockers.push(`missing group ${prerequisiteId}`);
        continue;
      }
      if (!this.isGroupComplete(prerequisiteId)) {
        const tasks = this.groupTasks(prerequisiteId);
        const completed = tasks.filter(task => task.status === "completed").length;
        blockers.push(`group ${prerequisiteId}: ${prerequisite.subject} (${completed}/${tasks.length} completed)`);
      }
      blockers.push(...this.groupPrerequisiteBlockers(prerequisiteId, nextVisited));
    }
    return [...new Set(blockers)];
  }

  private readinessBlockers(task: Task): string[] {
    const blockers: string[] = [];
    const edges = this.dependencyEdges();
    const taskNode = `t:${task.id}`;
    if ([...this.dependencyCycleNodes(edges)].some(node => this.isReachable(edges, node, taskNode))) {
      blockers.push("invalid dependency graph: cycle detected");
    }
    for (const prerequisiteId of task.blockedBy) {
      const prerequisite = this.tasks.get(prerequisiteId);
      if (!prerequisite) blockers.push(`missing #${prerequisiteId}`);
      else if (prerequisite.status !== "completed") blockers.push(`#${prerequisiteId}: ${prerequisite.subject}`);
    }
    if (task.groupId) {
      if (!this.groups.has(task.groupId)) blockers.push(`missing group ${task.groupId}`);
      else blockers.push(...this.groupPrerequisiteBlockers(task.groupId));
    }
    return [...new Set(blockers)];
  }

  private assertKnownTaskIds(ids: string[]): void {
    for (const id of ids) this.requireTask(id);
  }

  private assertKnownGroupIds(ids: string[]): void {
    for (const id of ids) this.requireGroup(id);
  }

  private dependencyEdges(): Map<string, Set<string>> {
    const edges = new Map<string, Set<string>>();
    const addNode = (id: string) => {
      if (!edges.has(id)) edges.set(id, new Set());
    };
    const addEdge = (from: string, to: string) => {
      addNode(from);
      addNode(to);
      edges.get(from)?.add(to);
    };

    for (const group of this.groups.values()) {
      const node = `g:${group.id}`;
      addNode(node);
      for (const prerequisiteId of group.blockedBy) {
        if (this.groups.has(prerequisiteId)) addEdge(`g:${prerequisiteId}`, node);
      }
    }
    for (const task of this.tasks.values()) {
      const node = `t:${task.id}`;
      addNode(node);
      for (const prerequisiteId of task.blockedBy) {
        if (this.tasks.has(prerequisiteId)) addEdge(`t:${prerequisiteId}`, node);
      }
    }
    for (const group of this.groups.values()) {
      for (const prerequisiteGroupId of group.blockedBy) {
        if (!this.groups.has(prerequisiteGroupId)) continue;
        for (const prerequisiteTask of this.groupTasks(prerequisiteGroupId)) {
          for (const dependentTask of this.groupTasks(group.id)) {
            addEdge(`t:${prerequisiteTask.id}`, `t:${dependentTask.id}`);
          }
        }
      }
    }
    return edges;
  }

  private isReachable(edges: Map<string, Set<string>>, from: string, target: string): boolean {
    const pending = [from];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || visited.has(node)) continue;
      if (node === target) return true;
      visited.add(node);
      pending.push(...(edges.get(node) ?? []));
    }
    return false;
  }

  private dependencyCycleNodes(edges = this.dependencyEdges()): Set<string> {
    const cycleNodes = new Set<string>();
    for (const node of edges.keys()) {
      for (const target of edges.get(node) ?? []) {
        if (this.isReachable(edges, target, node)) {
          cycleNodes.add(node);
          break;
        }
      }
    }
    return cycleNodes;
  }

  private assertNoNewCycles(previous: Set<string>): void {
    const current = this.dependencyCycleNodes();
    if ([...current].some(node => !previous.has(node))) throw new Error("Dependency cycle detected");
  }

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, any>,
    groupId?: string,
    blockedBy: string[] = [],
  ): Task {
    return this.mutate(() => {
      const prerequisiteIds = [...new Set(blockedBy)];
      // A task without prerequisites introduces no edge into it, so it cannot close
      // a cycle — skip the graph walk that every create would otherwise pay for.
      const previousCycles = prerequisiteIds.length > 0 ? this.dependencyCycleNodes() : undefined;
      if (groupId) this.requireGroup(groupId);
      // Validate before consuming an ID — a rejected create must leave no trace.
      this.assertKnownTaskIds(prerequisiteIds);
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        groupId,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: prerequisiteIds,
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      for (const prerequisiteId of prerequisiteIds) {
        const prerequisite = this.requireTask(prerequisiteId);
        if (!prerequisite.blocks.includes(task.id)) prerequisite.blocks.push(task.id);
      }
      // A new task can still close a cycle through its group's prerequisites.
      if (previousCycles) this.assertNoNewCycles(previousCycles);
      return cloneTask(task);
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  list(sortOrder: TaskSortOrder = "id"): Task[] {
    if (this.filePath) this.load();
    return sortTasks(Array.from(this.tasks.values(), cloneTask), sortOrder);
  }

  listVisible(sortOrder: TaskSortOrder = "id"): Task[] {
    return this.list(sortOrder).filter(task => !task.hidden);
  }

  getReadiness(id: string): TaskReadiness {
    if (this.filePath) this.load();
    const task = this.tasks.get(id);
    if (!task) return { ready: false, blockers: [`task #${id} does not exist`] };
    const blockers = this.readinessBlockers(task);
    if (task.status !== "pending") blockers.unshift(`task is ${task.status}`);
    return { ready: blockers.length === 0, blockers };
  }

  claim(id: string, owner?: string): { task?: Task; blockers: string[] } {
    return this.mutate(() => {
      const task = this.tasks.get(id);
      if (!task) return { blockers: [`task #${id} does not exist`] };
      const blockers = this.readinessBlockers(task);
      if (task.status !== "pending") blockers.unshift(`task is ${task.status}`);
      if (blockers.length > 0) return { task: cloneTask(task), blockers };
      task.status = "in_progress";
      task.hidden = undefined;
      if (owner !== undefined) task.owner = owner;
      task.updatedAt = Date.now();
      return { task: cloneTask(task), blockers: [] };
    });
  }

  update(id: string, fields: TaskUpdateFields): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.mutate(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };
      const changedFields: string[] = [];
      const warnings: string[] = [];
      const previousCycles = this.dependencyCycleNodes();

      if (fields.status === "deleted") {
        this.deleteTaskInternal(id);
        return { task: undefined, changedFields: ["deleted"], warnings };
      }

      const originalStatus = task.status;
      const nextStatus = fields.status ?? originalStatus;
      const nextGroupId = fields.groupId === null ? undefined : fields.groupId ?? task.groupId;
      if (nextGroupId) this.requireGroup(nextGroupId);
      if (nextGroupId !== task.groupId && originalStatus !== "pending" && fields.status !== "pending") {
        throw new Error("Running or completed tasks must be reset to pending when moved between groups");
      }

      const addedTaskIds = [
        ...(fields.addBlocks ?? []),
        ...(fields.addBlockedBy ?? []),
      ];
      this.assertKnownTaskIds(addedTaskIds);
      if (addedTaskIds.includes(id)) throw new Error(`Task #${id} cannot depend on itself`);

      if (fields.groupId !== undefined && nextGroupId !== task.groupId) {
        task.groupId = nextGroupId;
        changedFields.push("groupId");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) delete task.metadata[key];
          else task.metadata[key] = value;
        }
        changedFields.push("metadata");
      }

      const addEdge = (prerequisiteId: string, dependentId: string) => {
        const prerequisite = this.requireTask(prerequisiteId);
        const dependent = this.requireTask(dependentId);
        if (!prerequisite.blocks.includes(dependentId)) prerequisite.blocks.push(dependentId);
        if (!dependent.blockedBy.includes(prerequisiteId)) dependent.blockedBy.push(prerequisiteId);
      };
      const removeEdge = (prerequisiteId: string, dependentId: string) => {
        const prerequisite = this.tasks.get(prerequisiteId);
        const dependent = this.tasks.get(dependentId);
        if (prerequisite) prerequisite.blocks = prerequisite.blocks.filter(taskId => taskId !== dependentId);
        if (dependent) dependent.blockedBy = dependent.blockedBy.filter(taskId => taskId !== prerequisiteId);
      };

      for (const targetId of fields.addBlocks ?? []) addEdge(id, targetId);
      for (const prerequisiteId of fields.addBlockedBy ?? []) addEdge(prerequisiteId, id);
      for (const targetId of fields.removeBlocks ?? []) removeEdge(id, targetId);
      for (const prerequisiteId of fields.removeBlockedBy ?? []) removeEdge(prerequisiteId, id);
      if (fields.addBlocks?.length || fields.removeBlocks?.length) changedFields.push("blocks");
      if (fields.addBlockedBy?.length || fields.removeBlockedBy?.length) changedFields.push("blockedBy");

      this.assertNoNewCycles(previousCycles);

      const starts = nextStatus === "in_progress" && originalStatus !== "in_progress";
      const bypassesStart = originalStatus === "pending" && nextStatus === "completed";
      if (starts || bypassesStart) {
        const blockers = this.readinessBlockers(task);
        if (blockers.length > 0) throw new Error(`Task #${id} is blocked: ${blockers.join("; ")}`);
      }

      if (fields.status !== undefined && nextStatus !== originalStatus) {
        task.status = nextStatus;
        changedFields.push("status");
      }

      if (fields.hidden === true && nextStatus !== "completed") {
        throw new Error("Only completed tasks can be hidden");
      }
      const nextHidden = nextStatus !== "completed" ? undefined : fields.hidden ?? task.hidden;
      if (fields.hidden !== undefined || (task.hidden && nextStatus !== "completed")) {
        task.hidden = nextHidden === true ? true : undefined;
        changedFields.push("hidden");
      }

      task.updatedAt = Date.now();
      return { task: cloneTask(task), changedFields, warnings };
    });
  }

  private deleteTaskInternal(id: string): boolean {
    if (!this.tasks.delete(id)) return false;
    for (const task of this.tasks.values()) {
      task.blocks = task.blocks.filter(taskId => taskId !== id);
      task.blockedBy = task.blockedBy.filter(taskId => taskId !== id);
    }
    return true;
  }

  delete(id: string): boolean {
    return this.mutate(() => this.deleteTaskInternal(id));
  }

  hideCompleted(): number {
    return this.mutate(() => {
      let count = 0;
      const now = Date.now();
      for (const task of this.tasks.values()) {
        if (task.status === "completed" && !task.hidden) {
          task.hidden = true;
          task.updatedAt = now;
          count++;
        }
      }
      return count;
    });
  }

  hide(id: string): boolean {
    return this.mutate(() => {
      const task = this.tasks.get(id);
      if (!task || task.status !== "completed" || task.hidden) return false;
      task.hidden = true;
      task.updatedAt = Date.now();
      return true;
    });
  }

  /** Kept as the cleanup entry point; cleanup now retains completed records. */
  clearCompleted(): number {
    return this.hideCompleted();
  }

  clearAll(): number {
    return this.mutate(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      this.groups.clear();
      return count;
    });
  }

  createGroup(subject: string, description?: string, blockedBy: string[] = []): TaskGroup {
    return this.mutate(() => {
      this.assertKnownGroupIds(blockedBy);
      const now = Date.now();
      const group: TaskGroup = {
        id: `g${this.nextGroupId++}`,
        subject,
        description,
        blockedBy: [...new Set(blockedBy)],
        createdAt: now,
        updatedAt: now,
      };
      this.groups.set(group.id, group);
      return cloneGroup(group);
    });
  }

  getGroup(id: string): TaskGroup | undefined {
    if (this.filePath) this.load();
    const group = this.groups.get(id);
    return group ? cloneGroup(group) : undefined;
  }

  listGroups(): TaskGroup[] {
    if (this.filePath) this.load();
    return Array.from(this.groups.values(), cloneGroup).sort((a, b) => numericGroupId(a.id) - numericGroupId(b.id));
  }

  updateGroup(id: string, fields: TaskGroupUpdateFields): TaskGroup | undefined {
    return this.mutate(() => {
      const group = this.groups.get(id);
      if (!group) return undefined;
      const previousCycles = this.dependencyCycleNodes();
      this.assertKnownGroupIds(fields.addBlockedBy ?? []);
      if (fields.addBlockedBy?.includes(id)) throw new Error(`Task group ${id} cannot depend on itself`);
      if (fields.subject !== undefined) group.subject = fields.subject;
      if (fields.description !== undefined) group.description = fields.description ?? undefined;
      for (const prerequisiteId of fields.addBlockedBy ?? []) {
        if (!group.blockedBy.includes(prerequisiteId)) group.blockedBy.push(prerequisiteId);
      }
      if (fields.removeBlockedBy?.length) {
        const removed = new Set(fields.removeBlockedBy);
        group.blockedBy = group.blockedBy.filter(prerequisiteId => !removed.has(prerequisiteId));
      }
      group.updatedAt = Date.now();
      this.assertNoNewCycles(previousCycles);
      return cloneGroup(group);
    });
  }

  deleteGroup(id: string): boolean {
    return this.mutate(() => {
      if (!this.groups.has(id)) return false;
      const dependent = Array.from(this.groups.values()).find(group => group.blockedBy.includes(id));
      if (dependent) throw new Error(`Task group ${id} is required by ${dependent.id}`);
      this.groups.delete(id);
      const now = Date.now();
      for (const task of this.tasks.values()) {
        if (task.groupId === id) {
          task.groupId = undefined;
          task.updatedAt = now;
        }
      }
      return true;
    });
  }

  private getGroupSummaryInternal(id: string): TaskGroupSummary {
    const tasks = this.groupTasks(id);
    return {
      total: tasks.length,
      completed: tasks.filter(task => task.status === "completed").length,
      inProgress: tasks.filter(task => task.status === "in_progress").length,
      hidden: tasks.filter(task => task.hidden).length,
      complete: tasks.length > 0 && tasks.every(task => task.status === "completed"),
      blockers: this.groupPrerequisiteBlockers(id),
    };
  }

  getGroupSummary(id: string): TaskGroupSummary | undefined {
    if (this.filePath) this.load();
    if (!this.groups.has(id)) return undefined;
    return this.getGroupSummaryInternal(id);
  }

  getGroupBlocks(id: string): string[] {
    if (this.filePath) this.load();
    return Array.from(this.groups.values())
      .filter(group => group.blockedBy.includes(id))
      .map(group => group.id);
  }

  snapshot(): TaskStoreData {
    if (this.filePath) this.load();
    return {
      nextId: this.nextId,
      nextGroupId: this.nextGroupId,
      tasks: Array.from(this.tasks.values(), cloneTask),
      groups: Array.from(this.groups.values(), cloneGroup),
    };
  }

  seed(data: TaskStoreData): void {
    this.mutate(() => {
      if (this.tasks.size > 0 || this.groups.size > 0) return;
      this.nextId = data.nextId;
      this.nextGroupId = data.nextGroupId ?? 1;
      this.tasks = new Map(data.tasks.map(task => [task.id, normalizeTask(task)]));
      this.groups = new Map((data.groups ?? []).map(group => [group.id, normalizeGroup(group)]));
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath || !this.lockPath) return false;
    const token = acquireLock(this.lockPath);
    try {
      this.load();
      if (this.tasks.size > 0 || this.groups.size > 0) return false;
      try { unlinkSync(this.filePath); } catch { /* already absent */ }
      this.diskStamp = null;
      return true;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }
}
