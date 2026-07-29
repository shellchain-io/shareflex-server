import { randomBytes } from "node:crypto";

export type AdminJobKind = "movie" | "episode" | "publish" | "register" | "cleanup";

export type AdminJobStatus =
  | "queued"
  | "running"
  | "awaiting_upload"
  | "succeeded"
  | "failed"
  | "cancelled";

export type AdminJobStage =
  | "queued"
  | "encoding"
  | "awaiting_cdn"
  | "uploading_cdn"
  | "registering_cloud"
  | "cleaning"
  | "done";

export type JobLane = "encode" | "publish";

export type AdminJob = {
  id: string;
  kind: AdminJobKind;
  lane: JobLane;
  status: AdminJobStatus;
  stage: AdminJobStage;
  title: string;
  detail: string;
  /** Original upload filename — kept for the life of the job so operators can match disk files. */
  sourceFile: string | null;
  /** 0–100 when known (encode rungs / CDN files). */
  progress: number | null;
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
    progress?: number | null;
    result?: Record<string, unknown> | null;
  }) => void;
};

type JobRunner = (ctx: JobContext) => Promise<Record<string, unknown>>;

type QueueItem = { id: string; run: JobRunner; lane: JobLane };

const jobs = new Map<string, AdminJob>();
let encodeQueue: QueueItem[] = [];
let publishQueue: QueueItem[] = [];

let encodeActive = false;
let encodeJobId: string | null = null;
let encodeAbort: AbortController | null = null;

const publishActive = new Map<string, AbortController>();
const PUBLISH_CONCURRENCY = 4;

function nowIso(): string {
  return new Date().toISOString();
}

function laneForKind(kind: AdminJobKind): JobLane {
  return kind === "movie" || kind === "episode" ? "encode" : "publish";
}

export function createJobId(): string {
  return `job_${randomBytes(8).toString("hex")}`;
}

export function getJob(id: string): AdminJob | undefined {
  return jobs.get(id);
}

export function listJobs(limit = 80): AdminJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function updateJob(
  id: string,
  patch: {
    stage?: AdminJobStage;
    detail?: string;
    progress?: number | null;
    result?: Record<string, unknown> | null;
    error?: string | null;
    status?: AdminJobStatus;
  },
): AdminJob | undefined {
  const job = jobs.get(id);
  if (!job) {
    return undefined;
  }
  if (patch.stage !== undefined) job.stage = patch.stage;
  if (patch.detail !== undefined) job.detail = patch.detail;
  if (patch.progress !== undefined) job.progress = patch.progress;
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.result !== undefined) {
    job.result = patch.result ? { ...(job.result ?? {}), ...patch.result } : null;
  }
  if (patch.error !== undefined) job.error = patch.error;
  job.updatedAt = nowIso();
  return job;
}

export function enqueueAdminJob(input: {
  kind: AdminJobKind;
  title: string;
  detail: string;
  sourceFile?: string | null;
  run: JobRunner;
  lane?: JobLane;
}): AdminJob {
  const id = createJobId();
  const stamp = nowIso();
  const lane = input.lane ?? laneForKind(input.kind);
  const job: AdminJob = {
    id,
    kind: input.kind,
    lane,
    status: "queued",
    stage: "queued",
    title: input.title,
    detail: input.detail,
    sourceFile: input.sourceFile?.trim() || null,
    progress: null,
    error: null,
    result: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  jobs.set(id, job);
  const item = { id, run: input.run, lane };
  if (lane === "encode") {
    encodeQueue.push(item);
    void pumpEncodeQueue();
  } else {
    publishQueue.push(item);
    void pumpPublishQueue();
  }
  return job;
}

/**
 * Cancel behavior:
 * - encode queued/running → abort (caller deletes local encode artifacts)
 * - publish running → abort only; job returns to awaiting_upload if it had media ids
 * - awaiting_upload → dismiss (cancelled) without deleting media
 */
export function cancelAdminJob(
  id: string,
): { job: AdminJob; ok: true; mode: "encode" | "publish" | "dismiss" } | { job: AdminJob; ok: false } | null {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }

  if (job.status === "awaiting_upload") {
    job.status = "cancelled";
    job.error = "Dismissed (local encode kept — use Library to upload later).";
    job.updatedAt = nowIso();
    return { job, ok: true, mode: "dismiss" };
  }

  if (job.status === "queued") {
    if (job.lane === "encode") {
      encodeQueue = encodeQueue.filter((item) => item.id !== id);
      job.status = "cancelled";
      job.error = "Cancelled before encoding started.";
      job.updatedAt = nowIso();
      return { job, ok: true, mode: "encode" };
    }
    publishQueue = publishQueue.filter((item) => item.id !== id);
    job.status = "awaiting_upload";
    job.stage = "awaiting_cdn";
    job.error = "Upload cancelled before start.";
    job.progress = null;
    job.updatedAt = nowIso();
    return { job, ok: true, mode: "publish" };
  }

  if (job.status === "running" && job.lane === "encode" && encodeJobId === id && encodeAbort) {
    encodeAbort.abort();
    return { job, ok: true, mode: "encode" };
  }

  if (job.status === "running" && job.lane === "publish") {
    const abort = publishActive.get(id);
    if (abort) {
      abort.abort();
      return { job, ok: true, mode: "publish" };
    }
  }

  return { job, ok: false };
}

/**
 * Take an awaiting_upload encode job and run CDN+register on the publish lane (parallel).
 */
export function startUploadForJob(
  id: string,
  run: JobRunner,
): { job: AdminJob; ok: true } | { job: AdminJob; ok: false; reason: string } | null {
  const job = jobs.get(id);
  if (!job) {
    return null;
  }
  if (job.status !== "awaiting_upload") {
    const hasMedia =
      typeof job.result?.movieId === "string" ||
      typeof job.result?.episodeId === "string";
    if (!(job.status === "failed" && hasMedia)) {
      return { job, ok: false, reason: "Job is not waiting for CDN upload." };
    }
  }

  job.lane = "publish";
  job.kind = "publish";
  job.status = "queued";
  job.stage = "queued";
  job.detail = "Queued for CDN upload";
  job.error = null;
  job.progress = null;
  job.updatedAt = nowIso();
  publishQueue.push({ id, run, lane: "publish" });
  void pumpPublishQueue();
  return { job, ok: true };
}

async function runJobItem(item: QueueItem, abort: AbortController): Promise<void> {
  const job = jobs.get(item.id);
  if (!job || job.status === "cancelled") {
    return;
  }

  job.status = "running";
  job.progress = 0;
  job.updatedAt = nowIso();

  const ctx: JobContext = {
    signal: abort.signal,
    jobId: item.id,
    setProgress: (patch) => {
      updateJob(item.id, patch);
    },
  };

  try {
    const result = await item.run(ctx);
    if (abort.signal.aborted) {
      applyAbortOutcome(job, item.lane, result);
      return;
    }

    const needsUpload = Boolean(result.needsUpload);
    job.result = { ...(job.result ?? {}), ...result };
    job.error = null;
    job.progress = 100;

    if (needsUpload && item.lane === "encode") {
      job.status = "awaiting_upload";
      job.stage = "awaiting_cdn";
      job.detail = "Encoded — press Upload CDN";
    } else {
      job.status = "succeeded";
      job.stage = "done";
    }
  } catch (error) {
    if (abort.signal.aborted) {
      applyAbortOutcome(job, item.lane, job.result);
      if (item.lane === "encode") {
        job.error = "Cancelled during encoding.";
      } else if (!job.error) {
        job.error = "Upload cancelled — local encode kept.";
      }
      return;
    }

    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    if (!job.result) {
      job.result = { failedStage: job.stage };
    } else if (job.result.failedStage == null) {
      job.result = { ...job.result, failedStage: job.stage };
    }
    // Encode failed mid-way: stay failed. Publish failed: keep media ids for retry.
    if (item.lane === "publish" && (job.result.movieId || job.result.episodeId)) {
      job.status = "awaiting_upload";
      job.stage = "awaiting_cdn";
      job.detail = "Upload failed — retry Upload CDN";
    }
  } finally {
    job.updatedAt = nowIso();
  }
}

function applyAbortOutcome(
  job: AdminJob,
  lane: JobLane,
  result: Record<string, unknown> | null,
): void {
  if (lane === "publish") {
    job.status = "awaiting_upload";
    job.stage = "awaiting_cdn";
    job.error = "Upload cancelled — local encode kept. Press Upload CDN to retry.";
    job.progress = null;
    job.detail = "Encoded — press Upload CDN";
    if (result) {
      job.result = { ...(job.result ?? {}), ...result, needsUpload: true };
    }
    return;
  }
  job.status = "cancelled";
  job.error = job.error ?? "Cancelled during encoding.";
  job.progress = null;
}

async function pumpEncodeQueue(): Promise<void> {
  if (encodeActive) return;
  const next = encodeQueue.shift();
  if (!next) return;

  const job = jobs.get(next.id);
  if (!job || job.status === "cancelled") {
    void pumpEncodeQueue();
    return;
  }

  encodeActive = true;
  encodeJobId = next.id;
  encodeAbort = new AbortController();

  try {
    await runJobItem(next, encodeAbort);
  } finally {
    encodeActive = false;
    encodeJobId = null;
    encodeAbort = null;
    void pumpEncodeQueue();
  }
}

async function pumpPublishQueue(): Promise<void> {
  while (publishActive.size < PUBLISH_CONCURRENCY && publishQueue.length > 0) {
    const next = publishQueue.shift();
    if (!next) break;
    const job = jobs.get(next.id);
    if (!job || job.status !== "queued") {
      continue;
    }

    const abort = new AbortController();
    publishActive.set(next.id, abort);
    void (async () => {
      try {
        await runJobItem(next, abort);
      } finally {
        publishActive.delete(next.id);
        void pumpPublishQueue();
      }
    })();
  }
}
