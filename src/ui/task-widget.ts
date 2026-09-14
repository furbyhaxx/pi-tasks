/**
 * task-widget.ts — Persistent widget showing task list with status glyphs and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ actively executing task (star spinner with activeForm text)
 *
 * Every glyph on screen is a default that `glyphs` in tasks-config.json can
 * replace — see task-glyphs.ts.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolveTaskGlyphs } from "../task-glyphs.js";
import { orderTaskGroups, type TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

import type { Task, TaskGroup } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. The spinner advances here and
   *  nowhere else: `update()` also runs on every task mutation and tool execution,
   *  so incrementing there tied the animation speed to how busy the agent was. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => {
        this.widgetFrame++;
        this.update();
      }, 150);
    }
  }

  /** Render callback entry point. Guarded so a render error can never escape to
   *  the TUI timer and crash the whole host process — worst case the widget is
   *  empty for one frame. */
  private renderWidget(tui: any, theme: Theme): string[] {
    try {
      return this.buildWidgetLines(tui, theme);
    } catch {
      return [];
    }
  }

  /** Build widget lines from current live state. */
  private buildWidgetLines(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    // Resolved per render, not cached: the extension swaps this config object's
    // contents when the host moves to a session in another workspace.
    const glyphs = resolveTaskGlyphs(this.config.glyphs);
    const allTasks = this.store.list(sortOrder);
    const groups = orderTaskGroups(this.store.listGroups());
    const visibleTasks = allTasks.filter(task => !task.hidden);
    const tasks = groups.length > 0
      ? [
          ...groups.flatMap(group => visibleTasks.filter(task => task.groupId === group.id)),
          ...visibleTasks.filter(task => !task.groupId || !this.store.getGroup(task.groupId)),
        ]
      : visibleTasks;
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w, glyphs.truncation);

    const emptyGroups = groups.filter(group => (this.store.getGroupSummary(group.id)?.total ?? 0) === 0);
    if (tasks.length === 0 && emptyGroups.length === 0) return [];

    const completed = allTasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (inProgress.length > 0) parts.push(`${inProgress.length} in progress`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    if (allTasks.some(task => task.hidden)) parts.push(`${allTasks.filter(task => task.hidden).length} hidden`);
    const statusText = `${allTasks.length} tasks${groups.length > 0 ? ` in ${groups.length} groups` : ""}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;

    const spinnerFrame = glyphs.spinner[this.widgetFrame % glyphs.spinner.length];
    const lines: string[] = [truncate(theme.fg("accent", glyphs.header) + " " + theme.fg("accent", statusText))];

    // Collapsing only decides what goes in the list; the visible-limit logic below
    // then runs unchanged over whatever remains.
    const collapseCompleted = this.config.collapseCompleted ?? false;
    const listed = collapseCompleted ? tasks.filter(t => t.status !== "completed") : tasks;
    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    // Narrowed rather than defaulted: config is hand-editable JSON, and an
    // unrecognised value would index TRUNCATE_FNS to undefined and blank the widget.
    const hiddenAt = this.config.hiddenAt === "top" ? "top" : "bottom";
    const visible = showAll ? listed : TRUNCATE_FNS[hiddenAt](listed, limit);

    const hiddenCount = listed.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    ${glyphs.overflow} and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") lines.push(overflowLine);
    type DisplayEntry =
      | { kind: "group"; group: TaskGroup; empty: boolean; collapsedCount: number }
      | { kind: "ungrouped"; collapsedCount: number }
      | { kind: "task"; task: Task };
    const entries: DisplayEntry[] = [];
    let omittedSpecialGroups = 0;
    let specialGroupCount = 0;
    if (groups.length > 0) {
      for (const group of groups) {
        const groupTasks = tasks.filter(task => task.groupId === group.id);
        const groupVisible = visible.filter(task => task.groupId === group.id);
        const collapsedCount = collapseCompleted
          ? groupTasks.filter(task => task.status === "completed").length
          : 0;
        const empty = emptyGroups.includes(group);
        const specialOnly = groupVisible.length === 0 && (empty || collapsedCount > 0);
        if (specialOnly && specialGroupCount >= DEFAULT_MAX_VISIBLE_TASKS) {
          omittedSpecialGroups++;
          continue;
        }
        if (groupVisible.length > 0 || specialOnly) {
          if (specialOnly) specialGroupCount++;
          entries.push({ kind: "group", group, empty, collapsedCount });
          entries.push(...groupVisible.map(task => ({ kind: "task" as const, task })));
        }
      }
      const ungroupedVisible = visible.filter(task => !task.groupId || !this.store.getGroup(task.groupId));
      const collapsedCount = collapseCompleted
        ? tasks.filter(task => !task.groupId && task.status === "completed").length
        : 0;
      if (ungroupedVisible.length > 0 || collapsedCount > 0) {
        entries.push({ kind: "ungrouped", collapsedCount });
        entries.push(...ungroupedVisible.map(task => ({ kind: "task" as const, task })));
      }
    } else {
      entries.push(...visible.map(task => ({ kind: "task" as const, task })));
    }

    for (const entry of entries) {
      if (entry.kind === "group") {
        const summary = this.store.getGroupSummary(entry.group.id);
        if (!summary) continue;
        const blocked = summary.blockers.length > 0 ? ` — blocked: ${summary.blockers.join("; ")}` : "";
        const counts = entry.empty
          ? " (empty)"
          : ` (${summary.completed}/${summary.total} completed, ${summary.hidden} hidden)`;
        lines.push(truncate(theme.fg("accent", `  ${entry.group.id} ${entry.group.subject}`)
          + theme.fg("dim", `${counts}${blocked}`)));
        if (entry.collapsedCount > 0) {
          lines.push(truncate(`    ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${entry.collapsedCount} completed`)}`));
        }
        continue;
      }
      if (entry.kind === "ungrouped") {
        lines.push(truncate(theme.fg("accent", "  Ungrouped")));
        if (entry.collapsedCount > 0) {
          lines.push(truncate(`    ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${entry.collapsedCount} completed`)}`));
        }
        continue;
      }
      const task = entry.task;
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";

      let statusGlyph: string;
      if (isActive) {
        statusGlyph = theme.fg("accent", spinnerFrame);
      } else if (task.status === "completed") {
        statusGlyph = theme.fg("success", glyphs.completed);
      } else if (task.status === "in_progress") {
        statusGlyph = theme.fg("accent", glyphs.inProgress);
      } else {
        statusGlyph = glyphs.pending;
      }

      let suffix = "";
      if (task.status === "pending") {
        const readiness = this.store.getReadiness(task.id);
        if (!readiness.ready) {
          suffix = theme.fg("dim", ` ${glyphs.blocked} blocked by ${readiness.blockers.join("; ")}`);
        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`${glyphs.inputTokens} ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`${glyphs.outputTokens} ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} ${glyphs.statsSeparator} ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${
          theme.fg("accent", form + agentLabel + glyphs.trailingEllipsis)
        }${stats}`;
      } else if (task.status === "completed") {
        text = `  ${statusGlyph} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `  ${statusGlyph} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (omittedSpecialGroups > 0) {
      lines.push(truncate(theme.fg("dim", `    ${glyphs.overflow} and ${omittedSpecialGroups} more groups`)));
    }
    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }
    if (groups.length === 0 && collapseCompleted && completed.some(task => !task.hidden)) {
      const visibleCompleted = completed.filter(task => !task.hidden);
      lines.push(truncate(`  ${theme.fg("success", glyphs.completedSummary)} ${theme.fg("dim", `${visibleCompleted.length} completed`)}`));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allTasks = this.store.list();
    const tasks = allTasks.filter(task => !task.hidden);
    const hasEmptyGroup = this.store.listGroups().some(group => (this.store.getGroupSummary(group.id)?.total ?? 0) === 0);

    // Transition: visible → hidden
    if (tasks.length === 0 && !hasEmptyGroup) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = allTasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
