/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskGroupCreate / TaskGroupUpdate — Manage dependency-gated task groups
 *   TaskCreate   — Create a structured task
 *   TaskList     — List visible tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";
import { reclaimGlobalSessionTasksDir, sessionTaskFile } from "./task-paths.js";
import { orderTaskGroups, TaskStore } from "./task-store.js";
import { loadGlobalTasksConfig, loadTasksConfig } from "./tasks-config.js";
import type { Task } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set([
  "TaskGroupCreate",
  "TaskGroupUpdate",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "TaskExecute",
]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** Shorter interval used while any task is in_progress, so stale work is caught faster. */
const ACTIVE_REMINDER_INTERVAL = 2;

/** Cap on how many tasks the reminder echoes, to bound its size on large lists. */
const REMINDER_MAX_TASKS = 10;

/** Effective reminder interval for a given task list (pure — no disk I/O). */
function intervalFor(tasks: Task[]): number {
  return tasks.some(t => t.status === "in_progress") ? ACTIVE_REMINDER_INTERVAL : REMINDER_INTERVAL;
}

/** How many turns completed tasks linger before being hidden. */
const AUTO_CLEAR_DELAY = 4;

/** Neutralize a task field for the echo: collapse newlines and strip reminder tags. */
function sanitizeField(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/<\/?system-reminder>/gi, "").trim();
}

/**
 * Build the system reminder, shaped after Claude Code's todo reminders: an
 * empty-list nudge, or a state echo that dumps the current list as JSON. The
 * wording mirrors Claude Code (adapted to this extension's task tool names).
 */
function buildSystemReminder(tasks: Task[]): string {
  if (tasks.length === 0) {
    return [
      "<system-reminder>",
      "This is a reminder that your task list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a task list please use the TaskCreate tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
      "</system-reminder>",
    ].join("\n");
  }

  // Bound the echo on large lists. When over the cap, drop completed tasks
  // first (the reminder exists to surface unfinished work); ties keep task
  // order since Array.sort is stable.
  let shown = tasks;
  if (tasks.length > REMINDER_MAX_TASKS) {
    const rank = (t: Task) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);
    shown = [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, REMINDER_MAX_TASKS);
  }
  const hidden = tasks.length - shown.length;
  const overflow = hidden > 0
    ? ` (${hidden} more task${hidden === 1 ? "" : "s"} not shown — use TaskList for the full list.)`
    : "";

  const items = shown.map(t => {
    const item: Record<string, string> = {
      id: t.id,
      content: sanitizeField(t.subject),
      status: t.status,
    };
    if (t.activeForm) item.activeForm = sanitizeField(t.activeForm);
    if (t.groupId) item.groupId = t.groupId;
    return item;
  });

  // When truncated, don't claim these are the full contents.
  const prefix = "The task tools haven't been used recently. DO NOT mention this explicitly to the user.";
  const header = hidden > 0
    ? `${prefix} Here are your most relevant tasks (list truncated):`
    : `${prefix} Here are the latest contents of your task list:`;

  return [
    "<system-reminder>",
    header,
    "",
    `${JSON.stringify(items)}.${overflow} Continue on with the tasks at hand if applicable.`,
    "</system-reminder>",
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  // Project overrides require ExtensionContext.cwd, which is unavailable while
  // the extension factory runs. Start with global defaults, then merge the
  // active workspace's overrides on the first context-bearing event.
  const cfg = loadGlobalTasksConfig();
  const piTasks = process.env.PI_TASKS;
  let taskScope = cfg.taskScope ?? "session";

  /** Both session scopes persist one file per session; they differ only in where it
   *  lives, so every lifecycle rule about session files applies to each of them. */
  const isSessionScope = () => taskScope === "session" || taskScope === "session-global";

  /** Resolve both the backing path and a stable identity for the active store. */
  function resolveStoreTarget(cwd?: string, sessionId?: string): { key: string; path?: string } {
    if (piTasks === "off") return { key: "memory:env" };
    if (piTasks?.startsWith("/")) return { key: `path:${piTasks}`, path: piTasks };
    if (piTasks?.startsWith(".")) {
      const path = cwd ? resolve(cwd, piTasks) : undefined;
      return path ? { key: `path:${path}`, path } : { key: "pending:relative" };
    }
    if (piTasks) return { key: `named:${piTasks}`, path: piTasks };
    if (taskScope === "memory") return { key: "memory:config" };
    if (!cwd) return { key: "pending:workspace" };
    if (isSessionScope() && sessionId) {
      const path = sessionTaskFile(cwd, sessionId, taskScope);
      return { key: `path:${path}`, path };
    }
    if (isSessionScope()) return { key: "pending:session" };
    const path = join(cwd, ".pi", "tasks", "tasks.json");
    return { key: `path:${path}`, path };
  }

  // Project and relative paths need ExtensionContext.cwd, which is unavailable
  // while the extension factory runs. Absolute and named PI_TASKS overrides can
  // still be opened immediately; all other stores start in memory.
  let storeTarget = resolveStoreTarget();
  let store = new TaskStore(storeTarget.path);
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  /** Tell subagents its result has been handed to the model, which suppresses the
   *  completion notification it would otherwise deliver for the same result — the
   *  same consumption `get_subagent_result` performs when it returns one.
   *
   *  Fire-and-forget rather than an `rpcCall`: the reply carries nothing to act on,
   *  and the channel is deliberately outside the version handshake so a pi-subagents
   *  without the handler keeps notifying instead of failing the read. */
  function consumeSubagentResult(agentId: string): void {
    pi.events.emit("subagents:rpc:consume", { requestId: randomUUID(), agentId });
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion === undefined) {
        pendingWarning =
          "@tintinweb/pi-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
          `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(() => store, () => cfg.autoClearCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY);

  /** Agent-backed pending tasks that are ready at this instant. Capturing this
   *  before a completion lets cascade launch only work that completion released. */
  function readyAgentTaskIds(): Set<string> {
    return new Set(store.list()
      .filter(task => task.status === "pending" && task.metadata?.agentType && store.getReadiness(task.id).ready)
      .map(task => task.id));
  }

  async function launchClaimedTask(task: Task, options: {
    additionalContext?: string;
    model?: string;
    maxTurns?: number;
  }): Promise<string> {
    const prompt = buildTaskPrompt(task, options.additionalContext);
    try {
      const agentId = await spawnSubagent(task.metadata.agentType, prompt, {
        description: task.subject,
        isBackground: true,
        maxTurns: options.maxTurns,
        ...(options.model ? { model: options.model } : {}),
      });
      agentTaskMap.set(agentId, task.id);
      store.update(task.id, { owner: agentId, metadata: { ...task.metadata, agentId, lastError: null } });
      widget.setActiveTask(task.id);
      return agentId;
    } catch (error: any) {
      store.update(task.id, {
        status: "pending",
        metadata: { ...task.metadata, result: null, lastError: error.message },
      });
      throw error;
    }
  }

  async function cascadeNewlyReady(previouslyReady: Set<string>): Promise<void> {
    if (!(cfg.autoCascade ?? false) || !cascadeConfig || !latestCtx) return;
    const released = store.list().filter(task =>
      task.status === "pending"
      && task.metadata?.agentType
      && !previouslyReady.has(task.id)
      && store.getReadiness(task.id).ready
    );
    for (const task of released) {
      const claimed = store.claim(task.id);
      if (!claimed.task || claimed.blockers.length > 0) continue;
      try {
        await launchClaimedTask(claimed.task, cascadeConfig);
      } catch { /* launchClaimedTask records the error and rolls back to pending */ }
    }
  }

  // ── Subagent completion listener ──

  pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    const previouslyReady = readyAgentTaskIds();
    store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);
    await cascadeNewlyReady(previouslyReady);
    autoClear.trackCompletion(task.id, cadence.currentTurn);
    widget.update();
  });

  // Failure → store error, revert to pending, don't cascade (branch stops)
  // Intentional stop (status === "stopped") → mark completed, preserve partial result
  pi.events.on("subagents:failed", async (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      const previouslyReady = readyAgentTaskIds();
      // Intentional stop — mark completed, preserve partial result
      store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: result || task.metadata?.result } });
      await cascadeNewlyReady(previouslyReady);
      autoClear.trackCompletion(task.id, cadence.currentTurn);
    } else {
      // Actual error — revert to pending. `result: null` drops it (the store deletes
      // a key set to null): a task back to pending has no current result, and an
      // earlier run's would otherwise outrank this error everywhere it is read.
      store.update(task.id, { status: "pending", metadata: { ...task.metadata, result: null, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    widget.update();
  });

  // ── Context-scoped store initialization ──
  // Project paths cannot be resolved until an ExtensionContext is available.
  // Initialize on the first context-bearing event and reinitialize when a host
  // switches this extension instance to a session in another workspace.
  let configuredCwd: string | undefined;
  let persistedTasksShown = false;
  let agentsReattached = false;
  function initializeStoreForContext(ctx: ExtensionContext, reloadConfig = false) {
    // Keep the config object identity stable because the widget and auto-clear
    // manager retain references to it, but replace every value so overrides
    // from a previous workspace cannot leak into the next one.
    if (reloadConfig || configuredCwd !== ctx.cwd) {
      for (const key of Object.keys(cfg) as (keyof typeof cfg)[]) delete cfg[key];
      Object.assign(cfg, loadTasksConfig(ctx.cwd));
      taskScope = cfg.taskScope ?? "session";
    }

    // `pi --no-session` mints a session ID but never a session file. Keying off the
    // ID alone would write tasks-<id>.json for a session that can never be resumed
    // and is orphaned the moment pi exits: if pi is not persisting the conversation,
    // don't persist the task list either.
    const sessionId = isSessionScope() && !piTasks && ctx.sessionManager.getSessionFile()
      ? ctx.sessionManager.getSessionId()
      : undefined;
    const nextTarget = resolveStoreTarget(ctx.cwd, sessionId);
    if (nextTarget.key !== storeTarget.key) {
      store = new TaskStore(nextTarget.path);
      widget.setStore(store);
      storeTarget = nextTarget;
      // The new store owns a different task list, so the agent map has to be
      // rebuilt from it rather than kept from the previous one.
      agentsReattached = false;
    }
    configuredCwd = ctx.cwd;
  }

  /** Delete an emptied session file, and — under `session-global` only — the
   *  directory that held it once its last session is gone. Nothing else is ours
   *  to reclaim: a PI_TASKS path can point anywhere, and `<workspace>/.pi/tasks/`
   *  is left standing exactly as it always has been. */
  function deleteSessionFileIfEmpty() {
    if (!store.deleteFileIfEmpty()) return;
    if (taskScope === "session-global" && !piTasks && configuredCwd) {
      reclaimGlobalSessionTasksDir(configuredCwd);
    }
  }

  /** Re-link persisted in-progress tasks to the subagents still running for them.
   *  `agentTaskMap` lives only in this extension instance, so a reload starts empty
   *  while the agents keep going — their completion events would then be dropped and
   *  the tasks would stay in_progress forever. Everything needed is already on disk:
   *  TaskExecute records the agent ID in task metadata.
   *
   *  Only in_progress tasks are relinked. A task reverted to pending keeps its
   *  `metadata.agentId`, and relinking that would let a late event resurrect work the
   *  user has already reset. Only runs once — the first caller wins. */
  function reattachAgents() {
    if (agentsReattached) return;
    agentsReattached = true;
    for (const task of store.list()) {
      const agentId = task.metadata?.agentId;
      if (task.status === "in_progress" && typeof agentId === "string" && agentId) {
        agentTaskMap.set(agentId, task.id);
      }
    }
  }

  /** Restore the widget after startup/session changes. Automatic cleanup hides
   *  completed history instead of deleting it and respects `never`. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (!isResume && (cfg.autoClearCompleted ?? "on_list_complete") !== "never"
      && tasks.length > 0 && tasks.every(task => task.status === "completed")) {
      store.hideCompleted();
    }
    widget.update();
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    if (autoClear.onTurnStart(cadence.currentTurn)) {
      if (isSessionScope()) deleteSessionFileIfEmpty();
      widget.update();
    }
  });

  // The end of a run is the only signal that separates a new batch of tasks from the
  // same batch still being built — the store looks identical either way. Nothing is
  // hidden here; this only marks the boundary for the next TaskCreate.
  pi.on("agent_settled", async () => {
    autoClear.onRunEnded();
  });

  // ── Token usage tracking + stale-task detection ──
  // Feed per-turn token counts from assistant messages into the widget.
  // Also detect when the agent has stopped referencing tasks but left
  // them in_progress — schedule a reminder for the next LLM call.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }

    // Stale-task detection: catch the case where the agent finishes work in a
    // text-only turn (no tool calls, so tool_result never fires) but left tasks
    // in_progress. Cheap-first: only read the store once the turn gap could
    // matter — the in_progress interval is the smallest a reminder can need.
    if (!cadence.reminderInjectedThisCycle && !cadence.reminderDue) {
      const gap = cadence.currentTurn - cadence.lastTaskToolUseTurn;
      if (gap >= ACTIVE_REMINDER_INTERVAL && store.list().some(t => t.status === "in_progress")) {
        cadence.reminderDue = true;
      }
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Task tool usage resets cadence (interval is irrelevant on this path — the
    // helper resets and returns before reading it).
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      evaluateToolResult(cadence, event.toolName, false, cadenceConfig);
      return {};
    }

    if (cadence.reminderInjectedThisCycle) return {};
    // Cheap-first: avoid store.list() disk I/O until the turn gap could matter.
    // ACTIVE_REMINDER_INTERVAL is the smallest interval any reminder can need.
    if (cadence.currentTurn - cadence.lastTaskToolUseTurn < ACTIVE_REMINDER_INTERVAL) return {};

    const tasks = store.listVisible();
    // Shorter interval while in_progress; passed per-call so the shared config
    // is never mutated.
    evaluateToolResult(cadence, event.toolName, tasks.length > 0, {
      ...cadenceConfig,
      reminderInterval: intervalFor(tasks),
    });
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    if (!drainReminderForContext(cadence)) return {};
    const tasks = store.listVisible();

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildSystemReminder(tasks) }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  // session_start replaces the never-emitted session_switch event. Rehydrating
  // here matters because before_agent_start only fires once the user prompts.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const reason = event.reason;
    // new/resume/fork reuse the running extension instance (getExtensions() is
    // cached), so session-scoped state must be reset. startup/reload re-run the
    // factory and start clean.
    const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
    // A fork branches the conversation, so its tasks carry over as an independent
    // copy. Snapshot before the store re-points to the new (empty) session file.
    const forkSeed = reason === "fork" ? store.snapshot() : undefined;
    if (isSwitch) {
      persistedTasksShown = false;
      agentsReattached = false;
      // Task IDs restart at 1 in every session, so a mapping held over from the
      // previous one points at an unrelated task here — the agent's completion would
      // close a task it never ran. reattachAgents() rebuilds what this session owns.
      agentTaskMap.clear();
      resetCadenceState(cadence);
      autoClear.reset();
      // Memory mode has no file to switch — clear tasks explicitly on /new.
      if (reason === "new" && taskScope === "memory") {
        store.clearAll();
      }
    }

    initializeStoreForContext(ctx, true);
    if (forkSeed && (forkSeed.tasks.length > 0 || forkSeed.groups.length > 0)) store.seed(forkSeed);
    reattachAgents(); // subagents outlive a reload; relink them before events arrive
    // Resume/reload/fork preserve visibility; startup/new may hide an all-completed list.
    const keepsTasks = reason === "reload" || reason === "resume" || reason === "fork";
    showPersistedTasks(keepsTasks);
    // Those tasks are shown for review, but the run that produced them ended with the
    // session before this one — so the next batch must not be added to them either.
    if (keepsTasks) autoClear.onRunEnded();

    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Fallback for hosts that init UI lazily. Guarded by persistedTasksShown, so
  // it never double-renders after session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    reattachAgents();
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    initializeStoreForContext(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Task group tools
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGroupCreate",
    label: "TaskGroupCreate",
    description: `Create a non-executable task group. Groups organize tasks and may depend on other groups. If group B is blocked by group A, no task in B can start until every task in A is completed. Empty prerequisite groups remain blocking.`,
    promptGuidelines: [
      "Use TaskGroupCreate when a plan needs ordered phases; use task dependencies for partial hand-offs between individual tasks.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "Group title" }),
      description: Type.Optional(Type.String({ description: "Planning context for the group" })),
      blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite task-group IDs" })),
    }),
    execute(_toolCallId, params) {
      const group = store.createGroup(params.subject, params.description, params.blockedBy);
      widget.update();
      return Promise.resolve(textResult(`Task group ${group.id} created successfully: ${group.subject}`));
    },
  });

  pi.registerTool({
    name: "TaskGroupUpdate",
    label: "TaskGroupUpdate",
    description: `Update or delete a task group. Group dependency changes are validated for cycles. Deleting a group ungroups its tasks and is rejected while another group depends on it; it never deletes tasks.`,
    parameters: Type.Object({
      groupId: Type.String({ description: "Task-group ID" }),
      action: Type.Unsafe<"update" | "delete">({ type: "string", enum: ["update", "delete"] }),
      subject: Type.Optional(Type.String({ description: "New group title (update only)" })),
      description: Type.Optional(Type.Union([
        Type.String(),
        Type.Null(),
      ], { description: "New description; null clears it (update only)" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite group IDs to add" })),
      removeBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite group IDs to remove" })),
    }),
    execute(_toolCallId, params) {
      if (params.action === "delete") {
        if (params.subject !== undefined || params.description !== undefined
          || params.addBlockedBy !== undefined || params.removeBlockedBy !== undefined) {
          throw new Error("Delete cannot be combined with group update fields");
        }
        if (!store.deleteGroup(params.groupId)) return Promise.resolve(textResult(`Task group ${params.groupId} not found`));
        widget.update();
        return Promise.resolve(textResult(`Deleted task group ${params.groupId}; its tasks are now ungrouped`));
      }
      const group = store.updateGroup(params.groupId, {
        subject: params.subject,
        description: params.description,
        addBlockedBy: params.addBlockedBy,
        removeBlockedBy: params.removeBlockedBy,
      });
      if (!group) return Promise.resolve(textResult(`Task group ${params.groupId} not found`));
      widget.update();
      return Promise.resolve(textResult(`Updated task group ${group.id}: ${group.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use TaskCreate to turn work you are about to do into executable units: one useful outcome each, bounded in scope, carrying enough context to be picked up by a fresh agent, and finished against stated acceptance criteria.

## When to Use This Tool

- Work that spans several distinct steps, or that you want to hand off to subagents via TaskExecute
- Work the user handed you as a list — create them all, one TaskCreate call per task
- Work that must be coordinated: some parts can run concurrently, others must wait for a prerequisite
- Requirements you want captured before you start, so progress survives a compaction or a new session

## When NOT to Use This Tool

- Work you can finish inline in a couple of steps — just do it
- Purely conversational or informational requests
- Splitting a cohesive change into bookkeeping fragments (one task per file, per test, per tool call) — that adds tracking cost without adding a hand-off

## What Makes a Good Task

- **One outcome.** The task is done when one identifiable thing is true, not when a list of loosely related chores is finished.
- **Bounded scope.** Name the files, area, or interface it may touch. Two tasks that will run at the same time must not write the same place — readiness says a task may start, not that it is safe to run beside another one. Nothing in this extension detects write conflicts or isolates workspaces.
- **Self-contained.** The description is the entire briefing: goal, relevant paths, constraints, what must not be touched. Whoever executes it has not seen this conversation.
- **Observable acceptance criteria.** State the evidence that ends the task — the command that must pass, the output that must appear, the behavior that must hold.
- **Stated hand-off.** If a downstream task needs something from this one, say what to report back and where durable artifacts are written. Completion alone carries nothing.

Granularity follows independent completion and hand-off value, not file or step counts. A coherent multi-file change is one task; a change whose second half depends on what the first half discovers is two.

## Dependencies

- \`blockedBy\` takes IDs of tasks that **already exist**. Create the prerequisites first, read the IDs off their results, then create the dependent task with those IDs. Never guess an ID, and never reference an ID returned by another call in the same batch — those results do not exist yet.
- Several TaskCreate calls in one response are fine, and may share prerequisite IDs that were already returned by an earlier response.
- Use TaskUpdate (addBlockedBy/addBlocks) for dependencies discovered after creation.
- \`groupId\` is separate: a group gates all of its tasks behind every task of its prerequisite groups. Reserve groups for real all-to-all barriers; prefer per-task \`blockedBy\` for hand-offs between individual tasks.
- Only add an edge for a real hand-off. Edges you add for tidiness serialize work that could have run concurrently.

## Planning Depth

Outline the work you understand and create tasks for it. Do not invent downstream tasks whose contract depends on findings you do not have yet — create them once the discovery task reports back, wiring them to the returned IDs.

## Task Fields

- **subject**: Brief, imperative title (e.g., "Fix authentication bug in login flow")
- **description**: The full briefing — context, scope, acceptance criteria, expected hand-off
- **activeForm** (optional): Present continuous form shown in the spinner while in_progress (e.g., "Fixing authentication bug")
- **groupId** (optional): Place the task in a task group; the group's prerequisites then gate it
- **blockedBy** (optional): Existing task IDs that must complete first
- **agentType** (optional): Marks the task for subagent execution via TaskExecute (e.g., "general-purpose", "Explore")

All tasks are created with status \`pending\`.

## Example

Fork/join, using observed IDs — the two extractions are independent and run side by side, only the consumer waits:

\`\`\`
TaskCreate {"subject": "Extract parser module", ...}   → Task #1 created
TaskCreate {"subject": "Extract formatter module", ...} → Task #2 created
(next response)
TaskCreate {"subject": "Rewire CLI onto both modules", "blockedBy": ["1", "2"], ...}
\`\`\``,
    promptGuidelines: [
      "For multi-step work, use TaskCreate to define bounded units with their own acceptance criteria, and TaskUpdate to keep status current.",
      "Give each task everything its executor needs: goal, scope, files in and out of bounds, and the evidence that ends it.",
      "Pass TaskCreate.blockedBy only IDs returned by earlier TaskCreate calls; add later-discovered edges with TaskUpdate.",
      "Run ready tasks concurrently only when their write scopes are disjoint — TaskExecute provides no isolation.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')" })),
      groupId: Type.Optional(Type.String({ description: "Task-group ID. Group prerequisites gate task starts." })),
      blockedBy: Type.Optional(Type.Array(Type.String(), { description: "IDs of existing tasks that must complete before this one can start. Task IDs only — group prerequisites belong on the group, not here. Rejected as a whole if any ID is unknown or the edge would create a cycle." })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // A finished list must not collect the batch that follows it. The turn countdowns
      // cannot be relied on for that: they only tick at `turn_start`, so a run that ends
      // right after its last completion freezes one mid-count.
      autoClear.startNewBatch();
      const meta = params.metadata ?? {};
      if (params.agentType) meta.agentType = params.agentType;
      const task = store.create(
        params.subject,
        params.description,
        params.activeForm,
        Object.keys(meta).length > 0 ? meta : undefined,
        params.groupId,
        params.blockedBy,
      );
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list visible tasks and task groups. Pass includeHidden=true to inspect retained completed history.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After a task completes, to see what it released
- When your picture of the list may be stale — after a hand-off, a cascade, or work by another session. Do not re-list state you just read.

## Choosing What to Run Next

- Pick a set of ready tasks whose write scopes do not overlap; prefer the ones that unblock the most downstream work. Ready means prerequisites are satisfied, not that two tasks are safe to run side by side.
- Batch the delegable ones (those with \`agentType\`) into a single TaskExecute call. Tasks you keep for yourself are fine to run directly — not every ready task has to be delegated.
- ID order is not a priority signal.

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: Effective open task and task-group prerequisites (blocked tasks cannot be claimed)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({
      groupId: Type.Optional(Type.Union([
        Type.String(),
        Type.Null(),
      ], { description: "Filter by group ID; null selects ungrouped tasks" })),
      includeHidden: Type.Optional(Type.Boolean({ description: "Include completed task history hidden by cleanup" })),
    }),

    execute(_toolCallId, params) {
      const allTasks = store.list();
      const groups = orderTaskGroups(store.listGroups());
      if (params.groupId !== undefined && params.groupId !== null && !store.getGroup(params.groupId)) {
        return Promise.resolve(textResult(`Task group ${params.groupId} not found`));
      }
      const scopedTasks = params.groupId === undefined
        ? allTasks
        : allTasks.filter(task => task.groupId === (params.groupId ?? undefined));
      const hiddenCount = scopedTasks.filter(task => task.hidden).length;
      const tasks = params.includeHidden ? scopedTasks : scopedTasks.filter(task => !task.hidden);

      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = (items: Task[]) => [...items].sort((a, b) => {
        const status = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        return status !== 0 ? status : Number(a.id) - Number(b.id);
      });
      const taskLine = (task: Task) => {
        let line = `#${task.id} [${task.status}] ${task.subject}`;
        if (task.hidden) line += " [hidden]";
        if (task.owner) line += ` (${task.owner})`;
        const readiness = store.getReadiness(task.id);
        if (task.status === "pending" && !readiness.ready) line += ` [blocked by ${readiness.blockers.join("; ")}]`;
        return line;
      };

      const lines: string[] = [];
      if (params.groupId !== undefined) {
        if (params.groupId !== null) {
          const group = store.getGroup(params.groupId);
          const summary = store.getGroupSummary(params.groupId);
          if (group && summary) {
            lines.push(`${group.id}: ${group.subject} (${summary.completed}/${summary.total} completed, ${summary.hidden} hidden)`);
            if (group.description) lines.push(`  ${group.description}`);
            if (group.blockedBy.length) lines.push(`  Blocked by groups: ${group.blockedBy.join(", ")}`);
            const blocks = store.getGroupBlocks(group.id);
            if (blocks.length) lines.push(`  Blocks groups: ${blocks.join(", ")}`);
          }
        } else {
          lines.push("Ungrouped");
        }
        lines.push(...sorted(tasks).map(task => `  ${taskLine(task)}`));
      } else if (groups.length > 0) {
        for (const group of groups) {
          const children = sorted(tasks.filter(task => task.groupId === group.id));
          const summary = store.getGroupSummary(group.id);
          if (children.length === 0 && summary && summary.total > 0 && !params.includeHidden) continue;
          const blockerText = summary?.blockers.length ? ` [blocked: ${summary.blockers.join("; ")}]` : "";
          lines.push(`${group.id}: ${group.subject} (${summary?.completed ?? 0}/${summary?.total ?? 0} completed, ${summary?.hidden ?? 0} hidden)${blockerText}`);
          lines.push(...children.map(task => `  ${taskLine(task)}`));
        }
        const ungrouped = sorted(tasks.filter(task => !task.groupId || !store.getGroup(task.groupId)));
        if (ungrouped.length > 0) {
          lines.push("Ungrouped");
          lines.push(...ungrouped.map(task => `  ${taskLine(task)}`));
        }
      } else {
        lines.push(...sorted(tasks).map(taskLine));
      }

      if (lines.length === 0) lines.push("No tasks found");
      if (!params.includeHidden && hiddenCount > 0) {
        lines.push(`${hiddenCount} hidden completed task${hiddenCount === 1 ? "" : "s"} — use includeHidden: true to view history`);
      }
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its effective task and group blockers are empty before beginning work.
- Completed prerequisites keep their recorded result in metadata; TaskGet is how you read a hand-off that was too large to be injected in full.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.hidden) lines.push("Visibility: hidden history");
      if (task.owner) lines.push(`Owner: ${task.owner}`);
      if (task.groupId) {
        const group = store.getGroup(task.groupId);
        lines.push(`Group: ${task.groupId}${group ? ` — ${group.subject}` : " (missing)"}`);
      }
      lines.push(`Description: ${desc}`);

      const readiness = store.getReadiness(task.id);
      if (task.status === "pending" && !readiness.ready) {
        lines.push(`Blocked by: ${readiness.blockers.join("; ")}`);
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task yourself:**
- Mark it in_progress BEFORE beginning. This is only needed for tasks you execute yourself — TaskExecute claims pending tasks on its own; do not pre-claim tasks you are about to delegate.

**Mark tasks as completed:**
- Only once the task's acceptance criteria are actually met and you have the evidence — the command passed, the behavior holds. A completion event is a status change, not a verification.
- Record what downstream tasks need (result summary, artifact paths) in \`metadata.result\` as part of completing it.
- If you cannot finish, keep it in_progress and create a task for what is in the way
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies
- After completing a task, check TaskList for work it released

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **groupId**: Move to a task group; null ungroups. Running/completed tasks must be reset to pending when moved
- **hidden**: Hide or restore completed history; non-completed tasks cannot be hidden
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks** / **removeBlocks**: Add or remove tasks waiting on this one
- **addBlockedBy** / **removeBlockedBy**: Add or remove prerequisites

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Read a task's latest state with \`TaskGet\` before updating it when your view may be out of date — after a delegated run, a cascade, or concurrent work by another session. Skip the round trip when you just read or wrote the task yourself.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown in spinner when in_progress" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      groupId: Type.Optional(Type.Union([
        Type.String(),
        Type.Null(),
      ], { description: "Task-group ID, or null to ungroup" })),
      hidden: Type.Optional(Type.Boolean({ description: "Hide or restore a completed task" })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
      removeBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this task should no longer block" })),
      removeBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Prerequisite task IDs to remove" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const before = store.get(taskId);
      const previouslyReady = fields.status === "completed" ? readyAgentTaskIds() : new Set<string>();
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") {
          await cascadeNewlyReady(previouslyReady);
          autoClear.trackCompletion(taskId, cadence.currentTurn);
        }
      }
      if (fields.hidden === false && before?.hidden) autoClear.clearTaskCountdown(taskId);

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;
      // Reject an empty id up front: every agent ID starts with "", so the prefix
      // match below would resolve it to whichever agent the map yields first.
      if (!task_id) throw new Error("task_id is required");

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          // Check if this is an agent ID mapped to a task
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-read before committing to the wait. Nothing awaits since the outer
              // check, so this only differs on a shared file-backed list, where
              // store.get() reloads and another session may have finished the task.
              const current = store.get(resolvedId);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          // Re-read by resolved ID — `task` predates the wait, and a file-backed
          // store deserializes a fresh object on every load, so it is stale here.
          const updated = store.get(resolvedId) ?? task;
          const agentId: string = task.metadata.agentId;
          // Consume only what is actually handed over: the agent has reported back
          // (it leaves the map when it does) and the task carries its outcome. Short
          // of both — still running, or an update that never landed — the model is
          // getting a status, and the notification pi-subagents is holding is the
          // only thing that will announce the result.
          if (!agentTaskMap.has(agentId) && updated.status !== "in_progress") consumeSubagentResult(agentId);
          const output = updated.metadata?.result
            ?? (updated.metadata?.lastError ? `Error: ${updated.metadata.lastError}` : undefined);
          return textResult(
            `Task #${resolvedId} [${updated.status}] — subagent ${agentId}${output ? `\n\n${output}` : ""}`,
          );
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          const previouslyReady = readyAgentTaskIds();
          store.update(resolvedId, { status: "completed" });
          await cascadeNewlyReady(previouslyReady);
          autoClear.trackCompletion(resolvedId, cadence.currentTurn);
          await stopSubagent(task.metadata.agentId);
          widget.setActiveTask(resolvedId, false);
          widget.update();
          return textResult(`Task #${resolvedId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      const previouslyReady = readyAgentTaskIds();
      store.update(taskId, { status: "completed" });
      await cascadeNewlyReady(previouslyReady);
      autoClear.trackCompletion(taskId, cadence.currentTurn);
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\`, with all task prerequisites and transitive prerequisite groups completed
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent

## Behavior

- Pass every task you want started in one call. TaskExecute claims each pending task itself and launches them in the background; it returns immediately with a per-task line. Tasks that are blocked, non-pending or missing an agentType are reported as skipped — the batch is not rejected.
- Agents run concurrently with no isolation between them. Only batch tasks whose write scopes are disjoint.
- Do not poll for results. Continue with independent work; completion updates the task. Use TaskOutput when you actually need a specific agent's output, and TaskStop to end one early.
- A completed prerequisite's recorded result is injected into a dependent task's prompt, truncated at 4,000 characters, and only for direct task prerequisites — not for group prerequisites. Anything larger belongs in a durable artifact whose path the result names.
- Cascade (launching released tasks automatically on completion) is off unless the user enabled it, only covers tasks with an agentType, and only fires for tasks a completion just released. Launch the rest explicitly.`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
      "Launch a batch of non-conflicting ready tasks in one TaskExecute call, then keep working instead of polling.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable (@tintinweb/pi-subagents not loaded " +
          "or version mismatch). You can run these as plain Agent-tool spawns, but pi-tasks " +
          "won't track them — status stays pending, cascade won't fire, TaskOutput stays empty."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        const claimed = store.claim(taskId);
        if (!claimed.task || claimed.blockers.length > 0) {
          results.push(`#${taskId}: blocked by ${claimed.blockers.join("; ")}`);
          continue;
        }

        try {
          const agentId = await launchClaimedTask(claimed.task, {
            additionalContext: params.additional_context,
            model: params.model,
            maxTurns: params.max_turns,
          });
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      // Save cascade config for the completion listener
      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks, groups, dependencies, and retained history",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      latestCtx = ctx;
      widget.setUICtx(ctx.ui as UICtx);
      initializeStoreForContext(ctx);
      const ui = ctx.ui;
      let viewingHistory = false;

      const statusGlyph = (status: string) => {
        const glyphs = resolveTaskGlyphs(cfg.glyphs);
        if (status === "completed") return glyphs.completed;
        if (status === "in_progress") return glyphs.inProgress;
        return glyphs.pending;
      };

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const visible = tasks.filter(task => !task.hidden);
        const hiddenCount = tasks.length - visible.length;
        const completedVisible = visible.filter(task => task.status === "completed").length;
        const groups = store.listGroups();
        const choices = [
          `View all tasks (${visible.length})`,
          "Create task",
          "Create task group",
        ];
        if (groups.length > 0) choices.push(`Manage task groups (${groups.length})`);
        if (hiddenCount > 0) choices.push(`Show history (${hiddenCount})`);
        if (completedVisible > 0) choices.push(`Hide completed (${completedVisible})`);
        if (tasks.length > 0 || groups.length > 0) choices.push(`Delete all (${tasks.length} tasks, ${groups.length} groups)`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;
        if (choice.startsWith("View")) return viewTasks(false);
        if (choice === "Create task") return createTask();
        if (choice === "Create task group") return createGroup();
        if (choice.startsWith("Manage task groups")) return manageGroups();
        if (choice.startsWith("Show history")) return viewTasks(true);
        if (choice === "Settings") return settingsMenu();
        if (choice.startsWith("Hide completed")) {
          store.hideCompleted();
          widget.update();
          return mainMenu();
        }
        if (choice.startsWith("Delete all")) {
          if (await ui.confirm("Delete all task data?", "This permanently deletes every task, result, dependency, and group.")) {
            store.clearAll();
            if (isSessionScope()) deleteSessionFileIfEmpty();
            widget.update();
          }
          return mainMenu();
        }
      };

      const viewTasks = async (includeHidden = viewingHistory): Promise<void> => {
        viewingHistory = includeHidden;
        const tasks = store.list().filter(task => includeHidden || !task.hidden);
        if (tasks.length === 0) {
          await ui.select(includeHidden ? "No task history" : "No tasks", ["← Back"]);
          return mainMenu();
        }
        const choices = tasks.map(task => {
          const group = task.groupId ? ` ${task.groupId}` : "";
          const hidden = task.hidden ? " [hidden]" : "";
          return `${statusGlyph(task.status)} #${task.id}${group} [${task.status}] ${task.subject}${hidden}`;
        });
        choices.push("← Back");
        const selected = await ui.select(includeHidden ? "Task history" : "Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();
        const picked = tasks[choices.indexOf(selected)];
        return picked ? viewTaskDetail(picked.id) : viewTasks(includeHidden);
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();
        const actions: string[] = [];
        if (task.status === "pending") actions.push("▸ Start (in_progress)");
        if (task.status === "in_progress") actions.push("✓ Complete");
        if (task.status === "completed") actions.push(task.hidden ? "Restore" : "Hide");
        if (task.status === "pending" && store.listGroups().length > 0) actions.push("Move to group");
        if (task.status === "pending" && task.groupId) actions.push("Ungroup");
        actions.push("✗ Delete permanently", "← Back");
        const group = task.groupId ? `\nGroup: ${task.groupId}` : "";
        const readiness = store.getReadiness(task.id);
        const blocked = task.status === "pending" && !readiness.ready ? `\nBlocked: ${readiness.blockers.join("; ")}` : "";
        const action = await ui.select(`#${task.id} [${task.status}] ${task.subject}${group}${blocked}\n${task.description}`, actions);

        try {
          if (action === "▸ Start (in_progress)") {
            store.update(taskId, { status: "in_progress" });
            widget.setActiveTask(taskId);
          } else if (action === "✓ Complete") {
            const previouslyReady = readyAgentTaskIds();
            store.update(taskId, { status: "completed" });
            await cascadeNewlyReady(previouslyReady);
            autoClear.trackCompletion(taskId, cadence.currentTurn);
            widget.setActiveTask(taskId, false);
          } else if (action === "Hide") {
            store.hide(taskId);
          } else if (action === "Restore") {
            store.update(taskId, { hidden: false });
            autoClear.clearTaskCountdown(taskId);
          } else if (action === "Move to group") {
            const groups = store.listGroups();
            const selected = await ui.select("Move to task group", [...groups.map(group => `${group.id}: ${group.subject}`), "← Back"]);
            const picked = groups.find(group => `${group.id}: ${group.subject}` === selected);
            if (picked) store.update(taskId, { groupId: picked.id });
          } else if (action === "Ungroup") {
            store.update(taskId, { groupId: null });
          } else if (action === "✗ Delete permanently") {
            if (await ui.confirm("Delete task permanently?", `Delete #${task.id} and its retained result?`)) {
              store.delete(taskId);
              widget.setActiveTask(taskId, false);
            }
          } else {
            return viewTasks();
          }
        } catch (error) {
          ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        widget.update();
        return viewTasks();
      };

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();
        const groups = store.listGroups();
        let groupId: string | undefined;
        if (groups.length > 0) {
          const choices = ["Ungrouped", ...groups.map(group => `${group.id}: ${group.subject}`)];
          const selected = await ui.select("Task group", choices);
          if (!selected) return mainMenu();
          groupId = groups.find(group => `${group.id}: ${group.subject}` === selected)?.id;
        }
        autoClear.startNewBatch();
        store.create(subject, description, undefined, undefined, groupId);
        widget.update();
        return mainMenu();
      };

      const createGroup = async (): Promise<void> => {
        const subject = await ui.input("Task group subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task group description (optional)");
        store.createGroup(subject, description || undefined);
        widget.update();
        return mainMenu();
      };

      const manageGroups = async (): Promise<void> => {
        const groups = orderTaskGroups(store.listGroups());
        if (groups.length === 0) return mainMenu();
        const choices = [...groups.map(group => `${group.id}: ${group.subject}`), "← Back"];
        const selected = await ui.select("Task groups", choices);
        if (!selected || selected === "← Back") return mainMenu();
        const group = groups.find(item => `${item.id}: ${item.subject}` === selected);
        if (!group) return manageGroups();
        const action = await ui.select(`${group.id}: ${group.subject}`, [
          "Rename",
          "Edit description",
          "Add prerequisite",
          "Remove prerequisite",
          "Delete group",
          "← Back",
        ]);
        try {
          if (action === "Rename") {
            const subject = await ui.input("Task group subject", group.subject);
            if (subject) store.updateGroup(group.id, { subject });
          } else if (action === "Edit description") {
            const description = await ui.input("Task group description", group.description ?? "");
            if (description !== undefined) store.updateGroup(group.id, { description: description || null });
          } else if (action === "Add prerequisite") {
            const candidates = groups.filter(item => item.id !== group.id && !group.blockedBy.includes(item.id));
            if (candidates.length === 0) ui.notify("No task groups are available as new prerequisites", "info");
            else {
              const prerequisite = await ui.select("Prerequisite group", candidates.map(item => `${item.id}: ${item.subject}`));
              const picked = candidates.find(item => `${item.id}: ${item.subject}` === prerequisite);
              if (picked) store.updateGroup(group.id, { addBlockedBy: [picked.id] });
            }
          } else if (action === "Remove prerequisite") {
            const candidates = groups.filter(item => group.blockedBy.includes(item.id));
            if (candidates.length === 0) ui.notify("This task group has no prerequisites", "info");
            else {
              const prerequisite = await ui.select("Remove prerequisite", candidates.map(item => `${item.id}: ${item.subject}`));
              const picked = candidates.find(item => `${item.id}: ${item.subject}` === prerequisite);
              if (picked) store.updateGroup(group.id, { removeBlockedBy: [picked.id] });
            }
          } else if (action === "Delete group") {
            if (await ui.confirm("Delete task group?", "Tasks remain and become ungrouped.")) store.deleteGroup(group.id);
          } else {
            return manageGroups();
          }
        } catch (error) {
          ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        widget.update();
        return manageGroups();
      };

      const settingsMenu = (): Promise<void> => openSettingsMenu(ui, cfg, mainMenu, AUTO_CLEAR_DELAY, ctx.cwd);
      await mainMenu();
    },
  });
}
