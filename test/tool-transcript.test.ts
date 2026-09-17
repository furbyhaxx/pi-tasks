import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import taskExtension from "../src/index.js";
import { TASK_TOOL_NAMES, type TaskToolDetails } from "../src/tools/task-details.js";
import {
  renderTaskToolCall,
  renderTaskToolResult,
} from "../src/ui/tool-transcript.js";
import { installBackgroundJobsMock, mockPi } from "./helpers/mock-pi.js";

const theme = {
  fg: (color: string, text: string) => {
    const code = color === "success"
      ? 32
      : color === "error"
        ? 31
        : color === "accent"
          ? 36
          : color === "warning"
            ? 33
            : color === "dim"
              ? 90
              : 37;
    return `\u001b[${code}m${text}\u001b[0m`;
  },
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

function plain(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    isError: false,
    ...overrides,
  } as never;
}

function details(tool: (typeof TASK_TOOL_NAMES)[number], text: string, truncated = false): TaskToolDetails {
  if (tool === "TaskOutput") {
    return {
      version: 1,
      tool,
      capturedAt: 1_000,
      text: `Task #1 [running]\n\n${text}`,
      truncated,
      headerText: "Task #1 [running]",
      bodyText: text,
    };
  }
  return { version: 1, tool, capturedAt: 1_000, text, truncated };
}

function result(tool: (typeof TASK_TOOL_NAMES)[number], text: string, truncated = false) {
  return {
    content: [{ type: "text" as const, text: "model-facing result" }],
    details: details(tool, text, truncated),
  };
}

afterEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.LC_ALL;
  delete process.env.LC_CTYPE;
  process.env.LANG = "C.UTF-8";
});

describe("task tool transcript calls", () => {
  it("renders every tool with the shared self-shell grammar and pending state", () => {
    const args = {
      TaskGroupCreate: { subject: "Foundation" },
      TaskGroupUpdate: { groupId: "g1", action: "update" },
      TaskCreate: { subject: "Run tests", groupId: "g1", blockedBy: ["1"] },
      TaskList: {},
      TaskGet: { taskId: "1" },
      TaskUpdate: { taskId: "1", status: "in_progress" },
      TaskOutput: { task_id: "1", block: true, timeout: 30_000 },
      TaskStop: { task_id: "1" },
      TaskExecute: { task_ids: ["1", "2"] },
    } as const;

    for (const tool of TASK_TOOL_NAMES) {
      const lines = renderTaskToolCall(
        tool,
        args[tool] as unknown as Record<string, unknown>,
        theme as never,
        context({ isPartial: true }),
      ).render(80);
      const rendered = lines.map(plain).join("\n");
      expect(rendered).toContain(`$ ${tool}(`);
      expect(rendered).toContain("└─ ");
      expect(rendered).toContain("…");
      expect(lines.every(line => visibleWidth(line) <= 80)).toBe(true);
    }

    const update = renderTaskToolCall(
      "TaskUpdate",
      { taskId: "1", status: "completed", owner: "agent-1", addBlockedBy: ["2"] },
      theme as never,
      context(),
    ).render(120).map(plain).join("\n");
    expect(update).toContain("status=completed");
    expect(update).toContain("owner=agent-1");
    expect(update).toContain('addBlockedBy=["2"]');
  });

  it("renders preparing, ASCII, and NO_COLOR states", () => {
    process.env.NO_COLOR = "";
    process.env.LC_ALL = "C";
    process.env.LANG = "en_US.UTF-8";
    const lines = renderTaskToolCall(
      "TaskGet",
      {},
      theme as never,
      context({ executionStarted: false, argsComplete: false, isPartial: true }),
    ).render(40);

    expect(lines).toEqual([
      " $ TaskGet(#…)",
      "   \\- Read complete task details",
      "      Preparing tool call…",
    ]);
    expect(lines.join("\n")).not.toContain("\u001b[");
  });
});

describe("task tool transcript results", () => {
  it("uses bounded structured details and supports expansion", () => {
    const text = Array.from({ length: 12 }, (_, index) => `#${index + 1} [${index === 0 ? "in_progress" : "pending"}] task ${index + 1}`).join("\n");
    const collapsed = renderTaskToolResult(
      "TaskList",
      result("TaskList", text),
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80);
    const collapsedPlain = collapsed.map(plain).join("\n");
    expect(collapsedPlain).toContain("#1 [in_progress] task 1");
    expect(collapsedPlain).not.toContain("#12 [pending] task 12");
    expect(collapsedPlain).toContain("↳ 12 display lines, snapshot");
    expect(collapsedPlain).toContain("2 more display lines;");
    expect(collapsed.some(line => line.includes("\u001b[36m"))).toBe(true);

    const expanded = renderTaskToolResult(
      "TaskList",
      result("TaskList", text),
      { expanded: true, isPartial: false },
      theme as never,
      context(),
    ).render(40).map(plain);
    expect(expanded.join("\n")).toContain("#12 [pending] task 12");
    expect(expanded.join("\n")).toContain("to collapse");
    expect(expanded.every(line => visibleWidth(line) <= 40)).toBe(true);
  });

  it("tails TaskOutput while other tools preview from the start", () => {
    const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const output = renderTaskToolResult(
      "TaskOutput",
      result("TaskOutput", text),
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(output).toContain("Task #1 [running]");
    expect(output).not.toContain("      line 2\n");
    expect(output).toContain("      line 3\n");
    expect(output).toContain("      line 12\n");

    const task = renderTaskToolResult(
      "TaskGet",
      result("TaskGet", text),
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(task).toContain("      line 1\n");
    expect(task).not.toContain("      line 12\n");
  });

  it("bounds collapsed previews by wrapped display lines", () => {
    const rendered = renderTaskToolResult(
      "TaskOutput",
      result("TaskOutput", "x".repeat(5_000)),
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(40).map(plain);
    expect(rendered.filter(line => line.trim().startsWith("x"))).toHaveLength(10);
    expect(rendered.join("\n")).toContain("Task #1 [running]");
    expect(rendered.join("\n")).toContain("more display lines;");
    expect(rendered.every(line => visibleWidth(line) <= 40)).toBe(true);
  });

  it("renders thrown errors constructively and legacy results without inferred state", () => {
    const failed = renderTaskToolResult(
      "TaskGet",
      { content: [{ type: "text", text: "Task not found" }], details: undefined },
      { expanded: false, isPartial: false },
      theme as never,
      context({ isError: true }),
    ).render(60).map(plain).join("\n");
    expect(failed).toContain("Error: Task not found");
    expect(failed).toContain("Run TaskList");

    const overridden = renderTaskToolResult(
      "TaskStop",
      {
        content: [{ type: "text", text: "extension rejected result" }],
        details: details("TaskStop", "Task #1 stopped successfully", true),
      },
      { expanded: false, isPartial: false },
      theme as never,
      context({ isError: true }),
    ).render(80).map(plain).join("\n");
    expect(overridden).toContain("Error: extension rejected result");
    expect(overridden).not.toContain("stopped successfully");
    expect(overridden).not.toContain("truncated");

    const legacy = renderTaskToolResult(
      "TaskStop",
      { content: [{ type: "text", text: "Task #1 stopped successfully" }], details: undefined },
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(legacy).toContain("Task #1 stopped successfully");
    expect(legacy).not.toContain("[completed]");

    const malformed = renderTaskToolResult(
      "TaskList",
      { content: [{ type: "text", text: "retained raw result" }], details: { version: 1 } as never },
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(malformed).toContain("retained raw result");

    const oversized = renderTaskToolResult(
      "TaskOutput",
      {
        content: [{ type: "text", text: "legacy bounded result" }],
        details: {
          ...details("TaskOutput", "body"),
          headerText: "x".repeat(4 * 1024 + 1),
        },
      },
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(oversized).toContain("legacy bounded result");
    expect(oversized).not.toContain("Task #1 [running]");
  });

  it("preserves safe output styles and strips terminal side effects", () => {
    const styled = result("TaskOutput", "\u001b[31mred\u001b[0m\u001b[2J visible");
    const rendered = renderTaskToolResult(
      "TaskOutput",
      styled,
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80);
    const outputLine = rendered.find(line => plain(line).includes("red")) ?? "";
    expect(outputLine).toContain("\u001b[31mred");
    expect(outputLine).not.toContain("\u001b[2J");

    process.env.NO_COLOR = "";
    const uncolored = renderTaskToolResult(
      "TaskOutput",
      styled,
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80);
    expect(uncolored.join("\n")).not.toContain("\u001b[");
  });

  it("keeps delegated job identity and path visible with multiline intents", async () => {    const harness = mockPi();
    installBackgroundJobsMock(harness.pi, {
      output: {
        intent: "Run suite\n\nverify output",
        output: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
      },
    });
    taskExtension(harness.pi as never);

    const output = await harness.executeTool(
      "TaskOutput",
      { task_id: "job-1a2b3c4d", block: false, timeout: 30_000 },
      { cwd: process.cwd() },
    );
    const tool = harness.tools.get("TaskOutput");
    const rendered = tool.renderResult(
      output,
      { expanded: false, isPartial: false },
      theme,
      context(),
    ).render(80).map(plain).join("\n");

    expect(rendered).toContain("Run suite");
    expect(rendered).toContain("verify output");
    expect(rendered).toContain("Output file: /jobs/job-1a2b3c4d/output.log");
    expect(rendered).toContain("line 12");
    expect(rendered).not.toContain("line 1\n");
  });

  it("marks truncated render snapshots without changing model text", () => {    const rendered = renderTaskToolResult(
      "TaskOutput",
      result("TaskOutput", "tail", true),
      { expanded: false, isPartial: false },
      theme as never,
      context(),
    ).render(80).map(plain).join("\n");
    expect(rendered).toContain("snapshot, truncated");
    expect(rendered).toContain("model-facing result is unchanged");
  });
});

describe("task tool renderer wiring", () => {
  it("registers every task tool with a self shell and both render slots", () => {
    const harness = mockPi();
    taskExtension(harness.pi as never);

    for (const name of TASK_TOOL_NAMES) {
      const tool = harness.tools.get(name);
      expect(tool?.renderShell).toBe("self");
      expect(tool?.renderCall).toBeTypeOf("function");
      expect(tool?.renderResult).toBeTypeOf("function");
    }
  });
});
