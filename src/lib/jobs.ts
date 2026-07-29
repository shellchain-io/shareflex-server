import { randomBytes } from "node:crypto";

export type AdminJobKind = "movie" | "episode" | "publish" | "register" | "cleanup";

export type AdminJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Pipeline stage so failures stay visible and retryable. */
export type AdminJobStage =
  | "queued"
  | "encoding"
  | "uploading_cdn"
  | "registering_cloud"
  | "cleaning"
  | "done";

export type AdminJob = {
  id: string;
  kind: AdminJobKind;
  status: AdminJobStatus;
  stage: AdminJobStage;
  title: string;
  detail: string;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type JobContext = {
  signal: AbortSignal;
  jobId: string;
  setProgress: (patch: {
    stage?: AdminJobStage;
    detail?: string;
    result?: Record<string, unknown> | null;
  }) => void;
};

type JobRunner = (ctx: JobContext) => Promise<Record<string, unknown>>;

const jobs = new Map<string, AdminJob>();
let queue: Array<{ id: string; run: JobRunner }> = [];
let active = false;
let activeJobId: string | null = null;
let activeAbort: AbortController | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

export function createJobId(): string {
  return `job_${randomBytes(8).toString("hex")}`;
}

export function getJob(id: string): AdminJob | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 50): AdminJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function updateJob(
  id: string,
  patch: {
    stage?: AdminJobStage;
    detail?: string;
    result?: Record<string, unknown> | null;
    error?: string | null;
  },
): AdminJob | undefined {
  const job = jobs.get(id);
  if (!job) {
    return undefined;
  }
  if (patch.stage !== undefined) {
    job.stage = patch.stage;
  }
  if (patch.detail !== undefined) {
    job.detail = patch.detail;
  }
  if (patch.result !== undefined) {
    job.result = patch.result
      ? { ...(job.result ?? {}), ...patch.result }
      : null;
  }
  if (patch.error !== undefined) {
    job.error = patch.error;
  }
  job.updatedAt = nowIso();
  return job;
}

export function enqueueAdminJob(input: {
  kind: AdminJobKind;
  title: string;
  detail: string;
  run: JobRunner;
}): AdminJob {
  const id = createJobId();
  const stamp = nowIso();
  const job: AdminJob = {
    id,
    kind: input.kind,
    status: "queued",
    stage: "queued",
    title: input.title,
    detail: input.detail,
    error: null,
    result: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  jobs.set(id, job);
  queue.push({ id, run: input.run });
  void pumpQueue();
  return job;
}

/** Cancel a queued or running encode job. Returns null if missing; throws-ish via result. */
export function cancelAdminJob(
  id: string,
): { job: AdminJob; ok: true } | { job: AdminJob; ok: false } | null {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }

  if (job.status === "queued") {
    queue = queue.filter((item) => item.id !== id);
    job.status = "cancelled";
    job.error = "Cancelled before encoding started.";
    job.updatedAt = nowIso();
    return { job, ok: true };
  }

  if (job.status === "running" && activeJobId === id && activeAbort) {
    activeAbort.abort();
    return { job, ok: true };
  }

  return { job, ok: false };
}

async function pumpQueue(): Promise<void> {
  if (active) {
    return;
  }
  const next = queue.shift();
  if (!next) {
    return;
  }

  const job = jobs.get(next.id);
  if (!job || job.status === "cancelled") {
    void pumpQueue();
    return;
  }

  active = true;
  activeJobId = next.id;
  activeAbort = new AbortController();
  job.status = "running";
  job.updatedAt = nowIso();

  const ctx: JobContext = {
    signal: activeAbort.signal,
    jobId: next.id,
    setProgress: (patch) => {
      updateJob(next.id, patch);
    },
  };

  try {
    const result = await next.run(ctx);
    if (activeAbort.signal.aborted) {
      job.status = "cancelled";
      job.error = job.error ?? "Cancelled during encoding.";
      job.result = job.result ?? null;
    } else {
      job.status = "succeeded";
      job.stage = "done";
      job.result = { ...(job.result ?? {}), ...result };
      job.error = null;
    }
  } catch (error) {
    if (activeAbort.signal.aborted) {
      job.status = "cancelled";
      job.error = "Cancelled during encoding.";
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      if (!job.result) {
        job.result = { failedStage: job.stage };
      } else if (job.result.failedStage == null) {
        job.result = { ...job.result, failedStage: job.stage };
      }
    }
  } finally {
    job.updatedAt = nowIso();
    active = false;
    activeJobId = null;
    activeAbort = null;
    void pumpQueue();
  }
}
