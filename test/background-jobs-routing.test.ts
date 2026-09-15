/**
 * Routing of `job-…` ids through TaskOutput/TaskStop into the optional
 * @furbyhaxx/pi-background-jobs extension, plus the client helpers the `/tasks`
 * menu will use for its jobs entry. Everything here runs on a fake event bus.
 *
 * The job branch is a delegation: it reads and stops jobs through the extension
 * that owns them and never touches the task store, while every non-job id keeps
 * the pre-existing task/agent path byte-for-byte.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobOutput, JobStatus } from "../src/background-jobs-rpc.js";
import { createBackgroundJobsRpc, formatJobOutput, formatJobStop, isJobActive, JOB_ID } from "../src/background-jobs-rpc.js";
import initExtension from "../src/index.js";
import {
  type BackgroundJobsMockOptions,
  flush,
  installBackgroundJobsMock,
  mockCtx,
  mockPi,
  mockSessionCtx,
} from "./helpers/mock-pi.js";

const JOB = "job-0123abcd";
const CWD = "/work/tree";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

describe("TaskOutput — job ids", () => {
  let mock: ReturnType<typeof mockPi>;
  let jobs: ReturnType<typeof installBackgroundJobsMock>;
  let opts: BackgroundJobsMockOptions;

  beforeEach(() => {
    opts = {};
    mock = mockPi();
    jobs = installBackgroundJobsMock(mock.pi, opts);
    initExtension(mock.pi as any);
  });

  afterEach(() => { jobs.unsub(); });

  it("reads the job from the extension with the caller's cwd and milliseconds", async () => {
    const res = await mock.executeTool("TaskOutput", { task_id: JOB, block: true, timeout: 45000 }, mockCtx(CWD));

    expect(jobs.requests.output).toHaveLength(1);
    expect(jobs.requests.output[0]).toMatchObject({ cwd: CWD, jobId: JOB, block: true, timeoutMs: 45000 });
    expect(res.content[0].text).toBe(
      `Job ${JOB} [exited, exit 0] run tests\nOutput file: /jobs/${JOB}/output.log\n\nall tests passed\n`,
    );
  });

  it("passes a non-blocking request through as given", async () => {
    await mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD));

    expect(jobs.requests.output[0]).toMatchObject({ block: false, timeoutMs: 30000 });
  });

  it("waits for the reply before returning", async () => {
    let release!: () => void;
    jobs.holdNextOutput(new Promise<void>(resolve => { release = resolve; }));

    const pending = mock.executeTool("TaskOutput", { task_id: JOB, block: true, timeout: 1000 }, mockCtx(CWD));
    await flush();
    expect(jobs.requests.output).toHaveLength(1);
    release();

    expect((await pending).content[0].text).toContain(`Job ${JOB} [exited, exit 0] run tests`);
  });

  it("falls back to a current snapshot when the blocking wait is aborted", async () => {
    let release!: () => void;
    jobs.holdNextOutput(new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();

    const pending = mock.executeToolWithSignal(
      "TaskOutput",
      { task_id: JOB, block: true, timeout: 30000 },
      controller.signal,
      mockCtx(CWD),
    );
    await flush();
    controller.abort();
    const res = await pending;
    release();

    expect(jobs.requests.output).toHaveLength(2);
    expect(jobs.requests.output[1]).toMatchObject({ jobId: JOB, block: false });
    expect(res.content[0].text).toContain(`Job ${JOB} [exited, exit 0] run tests`);
  });

  it("preserves the original abort when the bounded snapshot fails", async () => {
    let release!: () => void;
    jobs.holdNextOutput(new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController();
    const rpc = createBackgroundJobsRpc(mock.pi.events);

    try {
      const pending = rpc.jobOutput(
        { cwd: CWD, jobId: JOB, block: true, timeoutMs: 30000 },
        controller.signal,
      );
      await flush();
      expect(jobs.requests.output).toHaveLength(1);
      jobs.unsub();
      vi.useFakeTimers();
      controller.abort();
      const rejection = expect(pending).rejects.toThrow("background-jobs:rpc:output aborted");
      await vi.advanceTimersByTimeAsync(2_000);
      await rejection;
    } finally {
      release();
      rpc.dispose();
      vi.useRealTimers();
    }
  });

  it("renders the terminal status the extension reports, including lost", async () => {
    opts.output = { status: "lost", exitCode: undefined };

    const res = await mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD));
    expect(res.content[0].text).toContain(`Job ${JOB} [lost] run tests`);
  });

  it("does not intercept ids that are not job ids", async () => {
    await mock.executeTool("TaskCreate", { subject: "Manual", description: "d" });

    await expect(mock.executeTool("TaskOutput", { task_id: "1", block: false, timeout: 30000 }, mockCtx(CWD)))
      .rejects.toThrow("No background process for task 1");
    // Shape, not prefix: an uppercase suffix is not a job id.
    await expect(mock.executeTool("TaskOutput", { task_id: "job-0123ABCD", block: false, timeout: 30000 }, mockCtx(CWD)))
      .rejects.toThrow("No task found with ID job-0123ABCD");

    expect(jobs.requests.output).toEqual([]);
  });
});

describe("TaskStop — job ids", () => {
  let mock: ReturnType<typeof mockPi>;
  let jobs: ReturnType<typeof installBackgroundJobsMock>;
  let opts: BackgroundJobsMockOptions;

  beforeEach(() => {
    opts = {};
    mock = mockPi();
    jobs = installBackgroundJobsMock(mock.pi, opts);
    initExtension(mock.pi as any);
  });

  afterEach(() => { jobs.unsub(); });

  it("stops the job and leaves the task store untouched", async () => {
    await mock.executeTool("TaskCreate", { subject: "A task", description: "d" });

    const res = await mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD));

    expect(res.content[0].text).toBe(`Stopped ${JOB} (run tests)`);
    expect(jobs.requests.stop[0]).toMatchObject({ cwd: CWD, jobId: JOB });
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: pending");
  });

  it("propagates the extension's error without touching the task store", async () => {
    await mock.executeTool("TaskCreate", { subject: "A task", description: "d" });
    opts.stopError = `Job ${JOB} is not running (exited)`;

    await expect(mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD)))
      .rejects.toThrow(`Job ${JOB} is not running (exited)`);
    const get = await mock.executeTool("TaskGet", { taskId: "1" });
    expect(get.content[0].text).toContain("Status: pending");
  });

  it("does not claim a stop the extension could not confirm", async () => {
    opts.stop = { status: "running" };

    await expect(mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD)))
      .rejects.toThrow(`Job ${JOB} did not stop (status: running)`);
  });

  it("reports a job that had already finished instead of claiming it stopped", async () => {
    opts.stop = { status: "exited" };

    const res = await mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD));
    expect(res.content[0].text).toBe(`Job ${JOB} is not running (exited)`);
  });

  it("does not claim that a lost job stopped", async () => {
    opts.stop = { status: "lost" };

    await expect(mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD)))
      .rejects.toThrow(`Job ${JOB} did not stop (status: lost)`);
  });
});

describe("background-jobs availability", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("does not emit a ping for a pre-aborted call", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi);
    const rpc = createBackgroundJobsRpc(mock.pi.events, { pingTimeoutMs: 10_000 });
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(rpc.jobList(CWD, "running", controller.signal))
        .rejects.toThrow("background-jobs:rpc:ping aborted");
      expect(jobs.requests.ping).toEqual([]);
      expect(jobs.requests.list).toEqual([]);
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("aborts an availability ping instead of waiting for its timeout", async () => {
    const mock = mockPi();
    const rpc = createBackgroundJobsRpc(mock.pi.events, { pingTimeoutMs: 10_000 });
    const controller = new AbortController();

    try {
      const pending = rpc.jobList(CWD, "running", controller.signal);
      await flush();
      controller.abort();
      await expect(pending).rejects.toThrow("background-jobs:rpc:ping aborted");
    } finally {
      rpc.dispose();
    }
  });

  it("defers the optional initial probe until session_start", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi);
    initExtension(mock.pi as any);

    try {
      expect(jobs.requests.ping).toEqual([]);
      await mock.fireLifecycle("session_start", { reason: "startup" }, mockSessionCtx("session-1"));
      await flush();
      expect(jobs.requests.ping.length).toBeGreaterThan(0);
    } finally {
      jobs.unsub();
    }
  });

  it("throws the clear error when no extension answers", async () => {
    vi.useFakeTimers();
    const mock = mockPi();
    initExtension(mock.pi as any);

    const output = mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD));
    const stop = mock.executeTool("TaskStop", { task_id: JOB }, mockCtx(CWD));
    const rejections = Promise.all([
      expect(output).rejects.toThrow("Background jobs extension is not loaded"),
      expect(stop).rejects.toThrow("Background jobs extension is not loaded"),
    ]);
    await vi.advanceTimersByTimeAsync(2_100); // the probe budget
    await rejections;
  });

  it("recovers once the extension announces ready after load", async () => {
    vi.useFakeTimers();
    const mock = mockPi();
    initExtension(mock.pi as any);
    const unavailable = expect(
      mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD)),
    ).rejects.toThrow("Background jobs extension is not loaded");
    await vi.advanceTimersByTimeAsync(2_100);
    await unavailable;
    vi.useRealTimers();

    // The extension binds later; its ready broadcast makes the id usable again.
    const jobs = installBackgroundJobsMock(mock.pi);
    try {
      jobs.ready();
      await flush();
      const res = await mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD));
      expect(res.content[0].text).toContain(`Job ${JOB} [exited, exit 0] run tests`);
    } finally {
      jobs.unsub();
    }
  });

  it("re-probes on a call after a missed handshake", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    // The extension binds only now: no ready event reached the client and the
    // factory ping missed, so the call itself has to probe again.
    const jobs = installBackgroundJobsMock(mock.pi);
    try {
      const res = await mock.executeTool("TaskOutput", { task_id: JOB, block: false, timeout: 30000 }, mockCtx(CWD));
      expect(res.content[0].text).toContain(`Job ${JOB} [exited, exit 0] run tests`);
      expect(jobs.requests.ping.length).toBeGreaterThan(0);
    } finally {
      jobs.unsub();
    }
  });
});

describe("background-jobs-rpc client helpers", () => {
  it("jobList sends cwd and status and returns the summaries", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, { jobs: [{ id: "job-aaaaaaaa", intent: "build" }] });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      const list = await rpc.jobList(CWD, "running");
      expect(jobs.requests.list[0]).toMatchObject({ cwd: CWD, status: "running" });
      expect(list).toEqual([expect.objectContaining({ id: "job-aaaaaaaa", intent: "build" })]);
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("openJobs reports whether the overlay opened", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, { open: false });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      expect(await rpc.openJobs(CWD)).toBe(false);
      expect(jobs.requests.open[0]).toMatchObject({ cwd: CWD });
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("rejects a pre-aborted output call without a snapshot request", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi);
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    const controller = new AbortController();
    try {
      expect(await rpc.checkBackgroundJobs()).toBe(true);
      controller.abort();
      await expect(rpc.jobOutput({ cwd: CWD, jobId: JOB, block: false }, controller.signal))
        .rejects.toThrow("background-jobs:rpc:output aborted");
      expect(jobs.requests.output).toEqual([]);
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("rejects malformed successful output data at its channel boundary", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, { output: { output: undefined } as Partial<JobOutput> });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      await expect(rpc.jobOutput({ cwd: CWD, jobId: JOB, block: false }))
        .rejects.toThrow("background-jobs:rpc:output malformed data");
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("rejects malformed successful stop data at its channel boundary", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, { stop: { status: "unknown" as JobStatus } });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      await expect(rpc.jobStop(CWD, JOB)).rejects.toThrow("background-jobs:rpc:stop malformed data");
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("rejects malformed successful list data at its channel boundary", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, {
      jobs: [{ id: "job-aaaaaaaa", status: "unknown" as JobStatus }],
    });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      await expect(rpc.jobList(CWD)).rejects.toThrow("background-jobs:rpc:list malformed data");
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("rejects malformed successful open data at its channel boundary", async () => {
    const mock = mockPi();
    const jobs = installBackgroundJobsMock(mock.pi, { openData: { opened: "yes" } });
    const rpc = createBackgroundJobsRpc(mock.pi.events);
    try {
      await expect(rpc.openJobs(CWD)).rejects.toThrow("background-jobs:rpc:open malformed data");
    } finally {
      rpc.dispose();
      jobs.unsub();
    }
  });

  it("checkBackgroundJobs survives a version mismatch and a restart", async () => {
    const mock = mockPi();
    // A short probe budget: the no-responder probe below would otherwise wait seconds.
    const rpc = createBackgroundJobsRpc(mock.pi.events, { pingTimeoutMs: 20 });
    try {
      expect(await rpc.checkBackgroundJobs()).toBe(false);
      expect(rpc.available).toBe(false);

      const jobs = installBackgroundJobsMock(mock.pi, { version: 2 });
      expect(await rpc.checkBackgroundJobs()).toBe(false);
      expect(rpc.available).toBe(false);
      jobs.unsub();

      const current = installBackgroundJobsMock(mock.pi);
      try {
        expect(await rpc.checkBackgroundJobs()).toBe(true);
        expect(rpc.available).toBe(true);
      } finally {
        current.unsub();
      }
    } finally {
      rpc.dispose();
    }
  });
});

describe("job id and text contracts", () => {
  it("matches only job- plus eight lowercase hex digits", () => {
    expect(JOB_ID.test(JOB)).toBe(true);
    expect(JOB_ID.test("job-0123ABCD")).toBe(false);
    expect(JOB_ID.test("job-0123abcd0")).toBe(false);
    expect(JOB_ID.test("job-0123abc")).toBe(false);
    expect(JOB_ID.test("task-0123abcd")).toBe(false);
  });

  it("counts starting and running as active", () => {
    expect(isJobActive("starting")).toBe(true);
    expect(isJobActive("running")).toBe(true);
    expect(isJobActive("lost")).toBe(false);
    expect(isJobActive("exited")).toBe(false);
  });

  it("bounds huge output from the tail and still names the output file", () => {
    const text = formatJobOutput({
      id: JOB,
      intent: "stream a build log",
      command: "make",
      cwd: CWD,
      worktree: CWD,
      status: "exited",
      createdAt: 1,
      exitCode: 0,
      creator: { pid: 1, sessionId: "session-1" },
      outputPath: `/jobs/${JOB}/output.log`,
      promoted: false,
      isBackground: false,
      output: Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"),
      truncated: false,
      retrieval: "complete",
    });

    expect(text).toContain(`Output file: /jobs/${JOB}/output.log`);
    expect(text).toContain("line 2499");
    expect(text).not.toContain("line 0\n");
    expect(text).toContain("[Output truncated. Full output: /jobs/job-0123abcd/output.log]");
    expect(text.split("\n").length).toBeLessThan(2050);
  });

  it("reports truncation already performed by the jobs extension", () => {
    const text = formatJobOutput({
      id: JOB,
      intent: "stream a build log",
      command: "make",
      cwd: CWD,
      worktree: CWD,
      status: "running",
      createdAt: 1,
      creator: { pid: 1, sessionId: "session-1" },
      outputPath: `/jobs/${JOB}/output.log`,
      promoted: false,
      isBackground: false,
      output: "latest line\n",
      truncated: true,
      retrieval: "running",
    });

    expect(text).toContain("[Output truncated. Full output: /jobs/job-0123abcd/output.log]");
  });

  it("reports only a confirmed stop", () => {
    expect(formatJobStop({ id: JOB, intent: "run tests", status: "stopped" })).toBe(`Stopped ${JOB} (run tests)`);
    expect(formatJobStop({ id: JOB, intent: "run tests", status: "exited" })).toBe(`Job ${JOB} is not running (exited)`);
    expect(() => formatJobStop({ id: JOB, intent: "run tests", status: "starting" }))
      .toThrow(`Job ${JOB} did not stop (status: starting)`);
    expect(() => formatJobStop({ id: JOB, intent: "run tests", status: "lost" }))
      .toThrow(`Job ${JOB} did not stop (status: lost)`);
  });
});
