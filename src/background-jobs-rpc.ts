/**
 * background-jobs-rpc.ts — typed client for the optional `pi-background-jobs` extension.
 *
 * Companion coupling is an events RPC on pi's shared bus: no imports, no shared
 * state. Every request carries a `requestId` and is answered on
 * `<channel>:reply:<requestId>` with the pi-mono reply envelope
 * (`{ success: true, data }` / `{ success: false, error }`).
 *
 * Channels (protocol version 1):
 *
 *   ping   {}                                              -> { version: 1 }
 *   list   { cwd, status? }                                -> JobSummary[]
 *   output { cwd, jobId, block?, timeoutMs?, tailLines? }  -> JobOutput
 *   stop   { cwd, jobId }                                  -> { id, intent, status }
 *   open   { cwd }                                         -> { opened: boolean }
 *
 * `cwd` is the caller's worktree, not the process's: the extension resolves its
 * store from it, so a session running elsewhere manages that worktree's jobs.
 * `output.timeoutMs` is milliseconds and is passed through untouched — the job
 * tools that speak seconds convert at their own boundary, not here.
 *
 * Availability is a live probe, never a permanent verdict. The extension answers
 * only once its first bound `session_start` has registered its handlers and
 * announced `background-jobs:ready`; a ping during factory load may therefore
 * legitimately miss. This client re-checks on that event and re-probes once when
 * a call finds itself unavailable, so a missed, reordered, or restarted
 * handshake heals instead of latching "not loaded" for the life of the process.
 */

import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";

/** Routing key for background-job ids (`job-` + 8 lowercase hex). */
export const JOB_ID = /^job-[0-9a-f]{8}$/;

/** RPC protocol version this client speaks. */
export const PROTOCOL_VERSION = 1;

/** Minimal event bus interface needed by the RPC client — `pi.events`. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** Lifecycle of a background job. `starting` counts as active; there is no
 *  execution-timeout status — a timeout is a foreground wait budget, not a job outcome. */
export type JobStatus = "starting" | "running" | "exited" | "stopped" | "output-cap" | "failed" | "lost";

export interface JobCreator {
  pid: number;
  sessionId: string;
  agentId?: string;
  parentSessionId?: string;
}

export interface JobSummary {
  id: string;
  intent: string;
  command: string;
  cwd: string;
  worktree: string;
  status: JobStatus;
  createdAt: number;
  endedAt?: number;
  exitCode?: number | null;
  creator: JobCreator;
  outputPath: string;
  promoted: boolean;
  /** Effective background mode from the owning runtime (explicit or promoted). */
  isBackground: boolean;
}

export interface JobOutput extends JobSummary {
  output: string;
  truncated: boolean;
  /** How the returned text was retrieved: `running` when `block` was false,
   *  `timeout` when a blocking wait expired before the job reached a terminal state. */
  retrieval: "complete" | "running" | "timeout";
}

export interface JobStopResult {
  id: string;
  intent: string;
  status: JobStatus;
}

/** A job is active while it can still make progress; `starting` counts. */
export function isJobActive(status: JobStatus): boolean {
  return status === "starting" || status === "running";
}

export interface JobOutputRequest {
  cwd: string;
  jobId: string;
  block?: boolean;
  /** Milliseconds — preserved at this boundary; job tools that take seconds convert themselves. */
  timeoutMs?: number;
  tailLines?: number;
}

export interface BackgroundJobsRpcOptions {
  /** Budget for a ping, which a missing handler never answers (default 2000). */
  pingTimeoutMs?: number;
  /** Budget for a non-blocking call (default 5000). */
  callTimeoutMs?: number;
  /** Headroom a blocking call waits beyond its own `timeoutMs` (default 5000). */
  callSlackMs?: number;
  /** Budget for `stop`, which waits for actual process termination (default 15000). */
  stopTimeoutMs?: number;
}

/**
 * The helpers the `/tasks` menu uses once a frontend adds the jobs entry, and the
 * ones the TaskOutput/TaskStop branches delegate through. All of them fail with
 * `Background jobs extension is not loaded` while the extension is unavailable.
 */
export interface BackgroundJobsRpc {
  /** Last probe result; re-checked on `background-jobs:ready` and on any call made
   *  while false. Read it to decide whether a menu entry should appear. */
  readonly available: boolean;
  /** Probe the extension now. Rejects promptly when `signal` aborts; otherwise true
   *  when it answered with protocol version 1. */
  checkBackgroundJobs(signal?: AbortSignal): Promise<boolean>;
  /** List jobs for `cwd`; `status` defaults to the extension's own default. */
  jobList(cwd: string, status?: "running" | "all", signal?: AbortSignal): Promise<JobSummary[]>;
  /** Read a job's output. A blocking wait is bounded by `request.timeoutMs`. */
  jobOutput(request: JobOutputRequest, signal?: AbortSignal): Promise<JobOutput>;
  /** Stop a job and return the terminal status. Errors from the extension propagate. */
  jobStop(cwd: string, jobId: string, signal?: AbortSignal): Promise<JobStopResult>;
  /** Open the extension's `/jobs` overlay for `cwd`; false when it cannot open one. */
  openJobs(cwd: string, signal?: AbortSignal): Promise<boolean>;
  /** Drop the ready subscription. In-flight calls stay bounded by their own timers. */
  dispose(): void;
}

const DEFAULT_PING_TIMEOUT_MS = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_SLACK_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
/** A wait that expired because `timeoutMs` was omitted entirely, matching TaskOutput's schema default. */
const DEFAULT_OUTPUT_WAIT_MS = 30_000;
/** Snapshot budget after an abort — the answer is already known to the caller only if it arrives fast. */
const ABORT_SNAPSHOT_TIMEOUT_MS = 2_000;

/** Error shown when a job-shaped id is used without the extension that owns it. */
const UNAVAILABLE = "Background jobs extension is not loaded";

const JOB_STATUSES = new Set<JobStatus>([
  "starting",
  "running",
  "exited",
  "stopped",
  "output-cap",
  "failed",
  "lost",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUSES.has(value as JobStatus);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJobCreator(value: unknown): value is JobCreator {
  if (!isRecord(value) || !isFiniteNumber(value.pid) || typeof value.sessionId !== "string") return false;
  return (value.agentId === undefined || typeof value.agentId === "string")
    && (value.parentSessionId === undefined || typeof value.parentSessionId === "string");
}

function isJobSummary(value: unknown): value is JobSummary {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.intent !== "string"
    || typeof value.command !== "string"
    || typeof value.cwd !== "string"
    || typeof value.worktree !== "string"
    || !isJobStatus(value.status)
    || !isFiniteNumber(value.createdAt)
    || !isJobCreator(value.creator)
    || typeof value.outputPath !== "string"
    || typeof value.promoted !== "boolean"
    || typeof value.isBackground !== "boolean") return false;

  return (value.endedAt === undefined || isFiniteNumber(value.endedAt))
    && (value.exitCode === undefined || value.exitCode === null || isFiniteNumber(value.exitCode));
}

function isJobOutput(value: unknown): value is JobOutput {
  if (!isJobSummary(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record.output === "string"
    && typeof record.truncated === "boolean"
    && (record.retrieval === "complete" || record.retrieval === "running" || record.retrieval === "timeout");
}

function isJobStopResult(value: unknown): value is JobStopResult {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.intent === "string"
    && isJobStatus(value.status);
}

function isOpenResult(value: unknown): value is { opened: boolean } {
  return isRecord(value) && typeof value.opened === "boolean";
}

/** Model-facing text for a delegated `TaskOutput` call: status/intent, the full
 *  output path, and the output bounded from the tail (2000 lines / 50 KiB) so a
 *  runaway log cannot be pulled into the transcript. */
export function formatJobOutput(output: JobOutput): string {
  const status = `${output.id} [${output.status}${output.exitCode !== undefined && output.exitCode !== null ? `, exit ${output.exitCode}` : ""}]`;
  const truncation = truncateTail(output.output ?? "");
  const notice = output.truncated || truncation.truncated
    ? `\n\n[Output truncated. Full output: ${output.outputPath}]`
    : "";
  return `Job ${status} ${output.intent}\nOutput file: ${output.outputPath}\n\n${truncation.content}${notice}`;
}

/** Model-facing text for a delegated `TaskStop` call. Only an actual termination
 *  is reported as stopped: a terminal job that the call did not end says so, and a
 *  reply that still shows the job live is an error, not a success line. */
export function formatJobStop(result: JobStopResult): string {
  if (result.status === "stopped") return `Stopped ${result.id} (${result.intent})`;
  if (result.status === "lost" || isJobActive(result.status)) {
    throw new Error(`Job ${result.id} did not stop (status: ${result.status})`);
  }
  return `Job ${result.id} is not running (${result.status})`;
}

export function createBackgroundJobsRpc(events: EventBus, options: BackgroundJobsRpcOptions = {}): BackgroundJobsRpc {
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const callSlackMs = options.callSlackMs ?? DEFAULT_CALL_SLACK_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  let available = false;

  /** Emit a request, wait for its scoped reply, and clean up every listener and
   *  timer on reply, timeout, or abort — whichever settles the promise first. */
  function rpcCall<T>(
    channel: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    validate?: (data: unknown) => data is T,
  ): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(`${channel} aborted`));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsub = () => {};
      const onAbort = () => finish(() => reject(new Error(`${channel} aborted`)));
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsub();
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        settle();
      };
      unsub = events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        const reply = raw as RpcReply<T> | undefined;
        if (!reply || typeof reply !== "object" || !("success" in reply)) {
          finish(() => reject(new Error(`${channel} malformed reply`)));
          return;
        }
        if (reply.success) {
          if (validate && !validate(reply.data)) {
            finish(() => reject(new Error(`${channel} malformed data`)));
            return;
          }
          finish(() => resolve(reply.data as T));
        } else finish(() => reject(new Error(reply.error || `${channel} failed`)));
      });
      timer = setTimeout(() => finish(() => reject(new Error(`${channel} timeout`))), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      events.emit(channel, { requestId, ...params });
    });
  }

  /** Probe now and remember the answer. A reply counts only when it carries the
   *  version this client speaks, so an unrelated handler cannot pass as available. */
  async function checkBackgroundJobs(signal?: AbortSignal): Promise<boolean> {
    try {
      const data = await rpcCall<{ version?: number }>("background-jobs:rpc:ping", {}, pingTimeoutMs, signal);
      available = data?.version === PROTOCOL_VERSION;
    } catch (error) {
      if (signal?.aborted) throw error;
      available = false;
    }
    return available;
  }

  async function ensureAvailable(signal?: AbortSignal): Promise<void> {
    if (available) return;
    if (await checkBackgroundJobs(signal)) return;
    throw new Error(UNAVAILABLE);
  }

  // Re-probe when the extension (re)binds its handlers — its first bound
  // `session_start`, and again after a restart. Without this a ping that missed
  // the handshake window would leave this client unavailable forever.
  const unsubReady = events.on("background-jobs:ready", () => {
    void checkBackgroundJobs();
  });

  async function jobOutput(request: JobOutputRequest, signal?: AbortSignal): Promise<JobOutput> {
    await ensureAvailable(signal);
    // A signal that was already aborted before the output request is prepared
    // must not be converted into a snapshot read; snapshots are only the
    // intentional fallback for a wait that was interrupted in flight.
    if (signal?.aborted) throw new Error("background-jobs:rpc:output aborted");
    const blocking = request.block !== false;
    const waitMs = blocking ? (request.timeoutMs ?? DEFAULT_OUTPUT_WAIT_MS) + callSlackMs : callTimeoutMs;
    try {
      return await rpcCall<JobOutput>(
        "background-jobs:rpc:output",
        { ...request },
        waitMs,
        signal,
        isJobOutput,
      );
    } catch (error) {
      // An aborted wait still has an answer worth reporting: ask for the current
      // snapshot without the signal, the way the subagent branch of TaskOutput
      // returns status instead of failing when its wait is aborted. If that
      // bounded snapshot cannot be read, preserve the original abort/timeout.
      if (signal?.aborted) {
        try {
          return await rpcCall<JobOutput>(
            "background-jobs:rpc:output",
            { ...request, block: false },
            ABORT_SNAPSHOT_TIMEOUT_MS,
            undefined,
            isJobOutput,
          );
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  return {
    get available() {
      return available;
    },
    checkBackgroundJobs,
    async jobList(cwd, status, signal) {
      await ensureAvailable(signal);
      return rpcCall<JobSummary[]>(
        "background-jobs:rpc:list",
        { cwd, ...(status !== undefined ? { status } : {}) },
        callTimeoutMs,
        signal,
        (data): data is JobSummary[] => Array.isArray(data) && data.every(isJobSummary),
      );
    },
    jobOutput,
    async jobStop(cwd, jobId, signal) {
      await ensureAvailable(signal);
      return rpcCall<JobStopResult>(
        "background-jobs:rpc:stop",
        { cwd, jobId },
        stopTimeoutMs,
        signal,
        isJobStopResult,
      );
    },
    async openJobs(cwd, signal) {
      await ensureAvailable(signal);
      const data = await rpcCall<{ opened: boolean }>(
        "background-jobs:rpc:open",
        { cwd },
        callTimeoutMs,
        signal,
        isOpenResult,
      );
      return data.opened;
    },
    dispose() {
      unsubReady();
    },
  };
}
