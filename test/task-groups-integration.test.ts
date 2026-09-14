import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

describe("task-group tools and execution gates", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    process.env.PI_TASKS = "off";
    config.current = { autoCascade: true, taskScope: "memory" };
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(() => {
    rpc.unsub();
    delete process.env.PI_TASKS;
  });

  async function createGroup(subject: string, blockedBy?: string[]) {
    return mock.executeTool("TaskGroupCreate", { subject, blockedBy });
  }

  async function createTask(subject: string, groupId: string) {
    return mock.executeTool("TaskCreate", {
      subject,
      description: `Do ${subject}`,
      groupId,
      agentType: "general-purpose",
    });
  }

  it("registers group tools and renders grouped TaskList output", async () => {
    expect(mock.tools.has("TaskGroupCreate")).toBe(true);
    expect(mock.tools.has("TaskGroupUpdate")).toBe(true);
    await createGroup("Design");
    await createTask("Specify", "g1");

    const list = await mock.executeTool("TaskList", {});
    expect(list.content[0].text).toContain("g1: Design (0/1 completed");
    expect(list.content[0].text).toContain("#1 [pending] Specify");
  });

  it("prevents TaskExecute and direct completion from bypassing a group prerequisite", async () => {
    await createGroup("Design");
    await createGroup("Build", ["g1"]);
    await createTask("Specify", "g1");
    await createTask("Implement", "g2");

    const execute = await mock.executeTool("TaskExecute", { task_ids: ["2"] });
    expect(execute.content[0].text).toContain("blocked by group g1");
    await expect(mock.executeTool("TaskUpdate", { taskId: "2", status: "completed" }))
      .rejects.toThrow("blocked");
  });

  it("auto-cascades across a group barrier when the upstream group completes", async () => {
    await createGroup("Design");
    await createGroup("Build", ["g1"]);
    await createTask("Specify", "g1");
    await createTask("Implement", "g2");

    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    rpc.complete("agent-1", "design complete");
    await flush();

    expect(rpc.spawned).toHaveLength(2);
    expect(rpc.spawned[1].prompt).toContain("Implement");
    expect((await mock.executeTool("TaskGet", { taskId: "2" })).content[0].text)
      .toContain("Status: in_progress");
  });

  it("hides cleanup history while keeping it retrievable", async () => {
    await createGroup("Phase");
    await createTask("Done", "g1");
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed", metadata: { result: "retained" } });
    await mock.executeTool("TaskUpdate", { taskId: "1", hidden: true });

    const normal = await mock.executeTool("TaskList", {});
    expect(normal.content[0].text).not.toContain("#1 [completed]");
    expect(normal.content[0].text).toContain("1 hidden completed task");

    const history = await mock.executeTool("TaskList", { includeHidden: true });
    expect(history.content[0].text).toContain("#1 [completed] Done [hidden]");
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain("retained");
  });

  it("scopes hidden-history counts to a TaskList group filter", async () => {
    await createGroup("One");
    await createGroup("Two");
    await createTask("Hidden", "g1");
    await createTask("Visible", "g2");
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed", hidden: true });

    const list = await mock.executeTool("TaskList", { groupId: "g2" });
    expect(list.content[0].text).toContain("#2 [pending] Visible");
    expect(list.content[0].text).not.toContain("hidden completed task");
  });

  it("gates a task created with blockedBy until its prerequisites complete", async () => {
    // IDs come back from the create calls; nothing predicts them.
    const first = await mock.executeTool("TaskCreate", {
      subject: "Schema", description: "Do schema", agentType: "general-purpose",
    });
    const prerequisiteId = /#(\d+)/.exec(first.content[0].text)?.[1] as string;
    const second = await mock.executeTool("TaskCreate", {
      subject: "Wire it up",
      description: "Depends on the schema",
      agentType: "general-purpose",
      blockedBy: [prerequisiteId],
    });
    const dependentId = /#(\d+)/.exec(second.content[0].text)?.[1] as string;

    expect((await mock.executeTool("TaskGet", { taskId: prerequisiteId })).content[0].text)
      .toContain(`Blocks: #${dependentId}`);
    const blocked = await mock.executeTool("TaskExecute", { task_ids: [dependentId] });
    expect(blocked.content[0].text).toContain(`#${dependentId}: blocked by #${prerequisiteId}`);

    await mock.executeTool("TaskUpdate", { taskId: prerequisiteId, status: "completed" });
    // Cascade is enabled in this suite and a TaskExecute already ran, so completing
    // the prerequisite launches the released task without a second explicit call.
    await flush();
    expect(rpc.spawned.map(spawn => spawn.prompt.includes("Wire it up"))).toContain(true);
  });

  it("rejects a TaskCreate whose prerequisite does not exist", async () => {
    await expect(mock.executeTool("TaskCreate", {
      subject: "Dependent", description: "d", blockedBy: ["9999"],
    })).rejects.toThrow("does not exist");
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("No tasks found");
  });

  it("updates and deletes groups without deleting their tasks", async () => {
    await createGroup("Old");
    await createTask("Work", "g1");
    await mock.executeTool("TaskGroupUpdate", { groupId: "g1", action: "update", subject: "New" });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("g1: New");

    await mock.executeTool("TaskGroupUpdate", { groupId: "g1", action: "delete" });
    const list = await mock.executeTool("TaskList", {});
    expect(list.content[0].text).toContain("#1 [pending] Work");
    expect(list.content[0].text).not.toContain("g1:");
  });
});
