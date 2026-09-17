import {
  type AgentToolResult,
  keyText,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  TASK_TOOL_NAMES,
  type TaskToolDetails,
  type TaskToolName,
} from "../tools/task-details.js";

const RESULT_INDENT = "      ";
const PREVIEW_LINES = 10;
const TASK_TOOL_NAME_SET = new Set<string>(TASK_TOOL_NAMES);

interface RenderContext {
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  isError: boolean;
}

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

const PURPOSES: Record<TaskToolName, string> = {
  TaskGroupCreate: "Create a dependency-gated task group",
  TaskGroupUpdate: "Update or delete a task group",
  TaskCreate: "Create a tracked unit of work",
  TaskList: "List task groups and visible tasks",
  TaskGet: "Read complete task details",
  TaskUpdate: "Update task state and relationships",
  TaskOutput: "Read background task output",
  TaskStop: "Stop a running background task",
  TaskExecute: "Launch ready tasks as subagents",
};

const PENDING: Record<TaskToolName, string> = {
  TaskGroupCreate: "Creating task group…",
  TaskGroupUpdate: "Updating task group…",
  TaskCreate: "Creating task…",
  TaskList: "Listing tasks…",
  TaskGet: "Reading task details…",
  TaskUpdate: "Updating task…",
  TaskOutput: "Reading task output…",
  TaskStop: "Stopping background task…",
  TaskExecute: "Launching task agents…",
};

function noColor(): boolean {
  return process.env.NO_COLOR !== undefined;
}

function paint(theme: Theme, color: Parameters<Theme["fg"]>[0], text: string): string {
  return noColor() ? text : theme.fg(color, text);
}

function bold(theme: Theme, color: Parameters<Theme["fg"]>[0], text: string): string {
  return noColor() ? text : theme.bold(theme.fg(color, text));
}

function cleanText(value: unknown, fallback = "…"): string {
  if (typeof value !== "string") return fallback;
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function compact(value: unknown, fallback = "…"): string {
  return cleanText(value, fallback).replace(/\s+/g, " ").trim() || fallback;
}

/** Preserve harmless SGR styling while dropping terminal sequences with side effects. */
function safeResultText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < value.length) {
          const final = value.charCodeAt(end);
          if (final >= 0x40 && final <= 0x7e) break;
          end += 1;
        }
        if (end < value.length && value[end] === "m") output += value.slice(index, end + 1);
        index = Math.min(end, value.length - 1);
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < value.length && value.charCodeAt(index) !== 0x07) {
          if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next === "P" || next === "_" || next === "^" || next === "X") {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += next && "()*+-./".includes(next) ? 2 : 1;
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      output += value[index];
    } else if (code === 0x0d) {
      if (value.charCodeAt(index + 1) !== 0x0a) output = output.slice(0, output.lastIndexOf("\n") + 1);
    } else if ((code >= 0x20 && code !== 0x7f) || code > 0x9f) {
      output += value[index];
    }
  }
  return noColor() ? stripTerminalSequences(output) : output;
}

function clampWidth(text: string, width: number, ellipsis = ""): string {
  const clamped = truncateToWidth(text, width, ellipsis);
  return noColor() ? stripTerminalSequences(clamped) : clamped;
}

function component(render: (width: number) => string[]): Component {
  return { render, invalidate() {} };
}

function supportsUnicodeGlyphs(): boolean {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return /UTF-?8/i.test(locale);
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n");
}

function taskIds(value: unknown): string {
  if (!Array.isArray(value)) return "…";
  const ids = value.filter((item): item is string => typeof item === "string");
  return ids.length > 0 ? ids.map(id => `#${compact(id)}`).join(", ") : "none";
}

function callArgs(tool: TaskToolName, args: Record<string, unknown>): string {
  switch (tool) {
    case "TaskGroupCreate":
      return compact(args.subject);
    case "TaskGroupUpdate":
      return `${compact(args.groupId)}, action=${compact(args.action)}`;
    case "TaskCreate": {
      const fields = [compact(args.subject)];
      if (typeof args.groupId === "string") fields.push(`group=${compact(args.groupId)}`);
      if (Array.isArray(args.blockedBy) && args.blockedBy.length > 0) fields.push(`blocked_by=${taskIds(args.blockedBy)}`);
      return fields.join(", ");
    }
    case "TaskList": {
      const fields: string[] = [];
      if (args.groupId === null) fields.push("group=ungrouped");
      else if (typeof args.groupId === "string") fields.push(`group=${compact(args.groupId)}`);
      if (args.includeHidden === true) fields.push("include_hidden=true");
      return fields.length > 0 ? fields.join(", ") : "visible";
    }
    case "TaskGet":
      return `#${compact(args.taskId)}`;
    case "TaskUpdate": {
      const changed = Object.entries(args)
        .filter(([key]) => key !== "taskId")
        .map(([key, value]) => {
          const serialized = typeof value === "string" ? compact(value) : compact(JSON.stringify(value));
          const bounded = Array.from(serialized);
          return `${key}=${bounded.length > 80 ? `${bounded.slice(0, 79).join("")}…` : serialized}`;
        });
      return `#${compact(args.taskId)}${changed.length > 0 ? `, ${changed.join(", ")}` : ""}`;
    }
    case "TaskOutput": {
      const block = args.block !== false;
      const timeout = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 30_000;
      return `${compact(args.task_id)}, block=${block}, timeout=${timeout}ms`;
    }
    case "TaskStop":
      return compact(args.task_id ?? args.shell_id);
    case "TaskExecute":
      return taskIds(args.task_ids);
  }
}

function callLines(tool: TaskToolName, args: string, theme: Theme, width: number): string[] {
  if (width <= 0) return [];
  const prefixText = ` $ ${tool}(`;
  const prefix = bold(theme, "toolTitle", prefixText);
  const closing = bold(theme, "toolTitle", ")");
  const argsWidth = Math.max(1, width - visibleWidth(prefixText) - 1);
  const wrapped = wrapTextWithAnsi(paint(theme, "dim", args), argsWidth);
  const lines = wrapped.map((line, index) =>
    clampWidth(`${index === 0 ? prefix : "    "}${line}${wrapped.length === 1 ? closing : ""}`, width, "…")
  );
  if (wrapped.length > 1) lines.push(clampWidth(`   ${closing}`, width));
  return lines;
}

function branchLines(text: string, theme: Theme, width: number): string[] {
  if (width <= 0) return [];
  const branch = supportsUnicodeGlyphs() ? "└─ " : "\\- ";
  const prefix = `   ${branch}`;
  const contentWidth = Math.max(1, width - visibleWidth(prefix));
  return wrapTextWithAnsi(bold(theme, "dim", text), contentWidth).map((line, index) =>
    clampWidth(`${index === 0 ? paint(theme, "dim", prefix) : " ".repeat(visibleWidth(prefix))}${line}`, width)
  );
}

function wrapIndented(text: string, width: number): string[] {
  if (width <= 0) return [];
  const indent = width >= visibleWidth(RESULT_INDENT) + 2 ? RESULT_INDENT : "";
  const contentWidth = Math.max(1, width - visibleWidth(indent));
  return wrapTextWithAnsi(text, contentWidth).map(line => clampWidth(`${indent}${line}`, width));
}

function isTaskToolDetails(value: unknown, tool: TaskToolName): value is TaskToolDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Record<string, unknown>;
  return details.version === 1
    && details.tool === tool
    && TASK_TOOL_NAME_SET.has(String(details.tool))
    && typeof details.capturedAt === "number"
    && Number.isFinite(details.capturedAt)
    && typeof details.text === "string"
    && Buffer.byteLength(details.text, "utf8") <= 50 * 1024
    && typeof details.truncated === "boolean"
    && (details.headerText === undefined || (typeof details.headerText === "string"
      && Buffer.byteLength(details.headerText, "utf8") <= 4 * 1024
      && details.headerText.split("\n").length <= 10))
    && (details.bodyText === undefined || (typeof details.bodyText === "string"
      && Buffer.byteLength(details.bodyText, "utf8") <= 47_000
      && details.bodyText.split("\n").length <= 2_000))
    && (tool !== "TaskOutput" || (typeof details.headerText === "string" && typeof details.bodyText === "string"));
}

function styleResultLine(line: string, theme: Theme): string {
  if (line.startsWith("Error:")) {
    return `${bold(theme, "error", "Error:")}${paint(theme, "text", line.slice(6))}`;
  }
  if (line === "Skipped:" || line.startsWith("Skipped:")) return bold(theme, "warning", line);
  return line.replace(/\[(pending|in_progress|completed|running|error|stopped)\]/g, (token, status: string) => {
    const color = status === "completed" || status === "stopped"
      ? "success"
      : status === "in_progress" || status === "running"
        ? "accent"
        : status === "error"
          ? "error"
          : "muted";
    return bold(theme, color, token);
  });
}

function errorCopy(tool: TaskToolName, raw: string): string {
  const message = compact(raw, "Unknown tool error").replace(/^Error:\s*/i, "");
  if (/not found/i.test(message) || /No task found/i.test(message)) {
    return `Error: ${message}\nRun TaskList to check the current IDs, then retry ${tool}.`;
  }
  if (/Subagent execution is currently unavailable/i.test(message)) return message;
  if (/Background jobs extension is not loaded/i.test(message)) {
    return `Error: ${message}\nLoad pi-background-jobs or retry with a task ID owned by pi-tasks.`;
  }
  if (/aborted|canceled|cancelled/i.test(message)) {
    return `Outcome unknown: ${message}\nRun TaskList or TaskGet before retrying.`;
  }
  return `Error: ${message}\nCheck the arguments and current task state, then retry ${tool}.`;
}

/** Render a task tool call with the shared background-jobs transcript grammar. */
export function renderTaskToolCall(
  tool: TaskToolName,
  args: Record<string, unknown>,
  theme: Theme,
  context: RenderContext,
): Component {
  return component(width => {
    const lines = [
      ...callLines(tool, callArgs(tool, args), theme, width),
      ...branchLines(PURPOSES[tool], theme, width),
    ];
    if (context.isPartial) {
      const pending = context.executionStarted && context.argsComplete
        ? PENDING[tool]
        : "Preparing tool call…";
      lines.push(...wrapIndented(paint(theme, "muted", pending), width));
    }
    return lines;
  });
}

/** Render task results, including restored legacy results and thrown tool errors. */
export function renderTaskToolResult(
  tool: TaskToolName,
  result: AgentToolResult<TaskToolDetails | undefined>,
  options: RenderOptions,
  theme: Theme,
  context: Pick<RenderContext, "isError">,
): Component {
  return component(width => {
    const details = isTaskToolDetails(result.details, tool) ? result.details : undefined;
    const raw = context.isError ? resultText(result) : details?.text ?? resultText(result);
    const source = context.isError ? errorCopy(tool, raw) : safeResultText(raw, "No result details were returned.");
    const truncated = !context.isError && details?.truncated === true;
    const lines: string[] = [];

    let wrapped: string[];
    let shown: string[];
    if (!context.isError && tool === "TaskOutput" && details?.headerText !== undefined && details.bodyText !== undefined) {
      const header = safeResultText(details.headerText, "No task output identity was returned.")
        .replace(/\n$/, "")
        .split("\n")
        .flatMap(line => wrapIndented(styleResultLine(line, theme), width));
      const body = safeResultText(details.bodyText).replace(/\n$/, "");
      wrapped = body
        ? body.split("\n").flatMap(line => wrapIndented(styleResultLine(line, theme), width))
        : [];
      shown = options.expanded ? wrapped : wrapped.slice(-PREVIEW_LINES);
      lines.push(...header, ...shown);
    } else {
      wrapped = source.replace(/\n$/, "").split("\n")
        .flatMap(line => wrapIndented(styleResultLine(line, theme), width));
      shown = options.expanded ? wrapped : wrapped.slice(0, PREVIEW_LINES);
      lines.push(...shown);
    }

    const hidden = wrapped.length - shown.length;
    if (wrapped.length > 1 || hidden > 0 || truncated) {
      const qualifiers = `${wrapped.length} display ${wrapped.length === 1 ? "line" : "lines"}, snapshot${truncated ? ", truncated" : ""}`;
      lines.push(...wrapIndented(`${paint(theme, "dim", "↳ ")}${bold(theme, "text", qualifiers)}`, width));
    }
    if (!options.expanded && hidden > 0) {
      lines.push(...wrapIndented(paint(theme, "muted", `(${hidden} more display ${hidden === 1 ? "line" : "lines"}; ${keyText("app.tools.expand")} to expand)`), width));
    } else if (options.expanded && wrapped.length > PREVIEW_LINES) {
      lines.push(...wrapIndented(paint(theme, "muted", `(${keyText("app.tools.expand")} to collapse)`), width));
    }
    if (truncated) {
      lines.push(...wrapIndented(paint(theme, "muted", "(saved render snapshot truncated; model-facing result is unchanged)"), width));
    }
    return lines;
  });
}
