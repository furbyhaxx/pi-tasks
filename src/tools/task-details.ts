export const TASK_TOOL_NAMES = [
  "TaskGroupCreate",
  "TaskGroupUpdate",
  "TaskCreate",
  "TaskList",
  "TaskGet",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
  "TaskExecute",
] as const;

export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

/** Versioned, bounded transcript snapshot used only by the TUI renderer. */
export interface TaskToolDetails {
  version: 1;
  tool: TaskToolName;
  capturedAt: number;
  text: string;
  truncated: boolean;
  /** TaskOutput keeps identity/status separate from its tail-preview body. */
  headerText?: string;
  bodyText?: string;
}
