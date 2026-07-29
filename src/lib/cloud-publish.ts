import path from "node:path";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Env } from "./env.js";
import type { JobContext } from "./jobs.js";
import { publishLocalPackageToR2 } from "./publish-r2.js";
import { applyPublishFlags } from "./publish-status.js";
import type {
  RegisterEpisodeInput,
  RegisterMovieInput,
} from "./register-library.js";
import { uploadDirectoryToR2 } from "./r2.js";

export type PublishPipelineResult = {
  r2Uploaded: boolean;
  cloudRegistered: boolean;
  uploaded?: number;
  keyPrefix?: string;
  failedStage?: string;
  movieId?: string | undefined;
  episodeId?: string | undefined;
  showId?: string | undefined;
};

function publishTargetConfigured(config: Env): boolean {
  return Boolean(config.PUBLISH_TARGET_URL?.trim());
}

async function loginToCloud(config: Env): Promise<string> {
  const base = config.PUBLISH_TARGET_URL.replace(/\/$/, "");
  const email = config.PUBLISH_TARGET_EMAIL || config.SEED_USER_1_EMAIL;
  const password = config.PUBLISH_TARGET_PASSWORD || config.SEED_USER_1_PASSWORD;
  const res = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    accessToken?: string;
    message?: string;
    error?: string;
  };
  if (!res.ok || !body.accessToken) {
    throw new Error(
      body.message ||
        body.error ||
        `Cloud login failed (${res.status}). Check PUBLISH_TARGET_* credentials.`,
    );
  }
  return body.accessToken;
}

export async function registerMovieOnCloud(
  config: Env,
  payload: RegisterMovieInput,
): Promise<void> {
  if (!publishTargetConfigured(config)) {
    throw new Error("PUBLISH_TARGET_URL is not set.");
  }
  const token = await loginToCloud(config);
  const base = config.PUBLISH_TARGET_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/admin/library/register/movie`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(
      body.message || body.error || `Cloud movie register failed (${res.status}).`,
    );
  }
}

export async function registerEpisodeOnCloud(
  config: Env,
  payload: RegisterEpisodeInput,
): Promise<void> {
  if (!publishTargetConfigured(config)) {
    throw new Error("PUBLISH_TARGET_URL is not set.");
  }
  const token = await loginToCloud(config);
  const base = config.PUBLISH_TARGET_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/admin/library/register/episode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as {
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(
      body.message ||
        body.error ||
        `Cloud episode register failed (${res.status}).`,
    );
  }
}

/**
 * Mirror a Mac library delete onto the GCE API DB (same ids).
 * Skips when PUBLISH_TARGET_URL is unset. 404 on cloud is treated as already gone.
 * Sends X-ShareFlex-Cascade-Delete so the cloud host does not call back to Mac.
 */
export async function deleteOnCloudApi(
  config: Env,
  path: `/v1/admin/shows/${string}` | `/v1/admin/seasons/${string}` | `/v1/admin/movies/${string}` | `/v1/admin/episodes/${string}/media` | `/v1/admin/movies/${string}/media`,
): Promise<{ attempted: boolean; ok: boolean; message?: string }> {
  if (!publishTargetConfigured(config)) {
    return { attempted: false, ok: true };
  }
  try {
    const token = await loginToCloud(config);
    const base = config.PUBLISH_TARGET_URL.replace(/\/$/, "");
    const res = await fetch(`${base}${path}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`,
        "x-shareflex-cascade-delete": "1",
      },
    });
    if (res.ok || res.status === 404) {
      return { attempted: true, ok: true };
    }
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      error?: string;
    };
    const message =
      body.message || body.error || `Cloud delete failed (${res.status}).`;
    console.warn(`Cloud delete ${path}:`, message);
    return { attempted: true, ok: false, message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Cloud delete ${path}:`, message);
    return { attempted: true, ok: false, message };
  }
}

/** List shows/movies on the phone catalog (GCE) for orphan cleanup. */
export async function listCloudLibrary(config: Env): Promise<{
  shows: Array<{ id: string; title: string; ready: boolean; episodeCount: number }>;
  movies: Array<{ id: string; title: string; ready: boolean }>;
}> {
  if (!publishTargetConfigured(config)) {
    return { shows: [], movies: [] };
  }
  const token = await loginToCloud(config);
  const base = config.PUBLISH_TARGET_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/v1/admin/library`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    shows?: Array<{
      id: string;
      title: string;
      ready?: boolean;
      episodeCount?: number;
    }>;
    movies?: Array<{ id: string; title: string; ready?: boolean }>;
    message?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(
      body.message || body.error || `Cloud library list failed (${res.status}).`,
    );
  }
  return {
    shows: (body.shows ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      ready: Boolean(s.ready),
      episodeCount: s.episodeCount ?? 0,
    })),
    movies: (body.movies ?? []).map((m) => ({
      id: m.id,
      title: m.title,
      ready: Boolean(m.ready),
    })),
  };
}

/**
 * After local encode: upload HLS to R2, then register metadata on GCE.
 * Throws on failure; partial progress is written via ctx.setProgress for UI retry.
 */
export async function finishCloudPublish(options: {
  config: Env;
  mediaRoot: string;
  kind: "movies" | "episodes";
  id: string;
  prisma?: PrismaClient;
  ctx?: JobContext | undefined;
  moviePayload?: RegisterMovieInput | undefined;
  episodePayload?: RegisterEpisodeInput | undefined;
  /** Extra local dirs to push (e.g. show/season posters). */
  extraUploads?: Array<{ localDir: string; keyPrefix: string }> | undefined;
}): Promise<PublishPipelineResult> {
  const { config, mediaRoot, kind, id, ctx, prisma } = options;
  const result: PublishPipelineResult = {
    r2Uploaded: false,
    cloudRegistered: false,
  };
  if (kind === "movies") {
    result.movieId = id;
  } else {
    result.episodeId = id;
  }
  if (options.episodePayload?.show.id) {
    result.showId = options.episodePayload.show.id;
  }

  const r2Ready = Boolean(
    config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY,
  );
  if (!r2Ready) {
    result.failedStage = "uploading_cdn";
    ctx?.setProgress({
      stage: "uploading_cdn",
      detail: "R2 not configured",
      result: { ...result, failedStage: "uploading_cdn" },
    });
    throw new Error(
      "R2 is not configured. Set R2_* in .env before publishing to the cloud.",
    );
  }

  ctx?.setProgress({
    stage: "uploading_cdn",
    detail: `Uploading ${kind}/${id} to R2…`,
    progress: 0,
    result: { ...result },
  });

  try {
    const uploaded = await publishLocalPackageToR2({
      config,
      mediaRoot,
      kind,
      id,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      onProgress: (info) => {
        ctx?.setProgress({
          stage: "uploading_cdn",
          detail: `CDN ${info.uploaded}/${info.total} files`,
          progress: info.percent,
        });
      },
    });
    result.uploaded = uploaded.uploaded;
    result.keyPrefix = uploaded.keyPrefix;

    for (const extra of options.extraUploads ?? []) {
      if (ctx?.signal.aborted) {
        throw new Error("Cancelled.");
      }
      await uploadDirectoryToR2({
        config,
        localDir: extra.localDir,
        keyPrefix: extra.keyPrefix,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
      });
    }

    result.r2Uploaded = true;
    if (prisma) {
      await applyPublishFlags(prisma, kind, id, { r2Uploaded: true });
    }
    ctx?.setProgress({
      detail: `CDN upload done (${uploaded.uploaded} files)`,
      progress: 100,
      result: { ...result },
    });
  } catch (error) {
    result.failedStage = "uploading_cdn";
    ctx?.setProgress({
      stage: "uploading_cdn",
      result: { ...result, failedStage: "uploading_cdn" },
    });
    throw error;
  }

  if (!publishTargetConfigured(config)) {
    // Mac encode-only / CDN-only mode — caller still succeeds.
    return result;
  }

  ctx?.setProgress({
    stage: "registering_cloud",
    detail: `Registering metadata on ${config.PUBLISH_TARGET_URL}…`,
    result: { ...result },
  });

  try {
    if (kind === "movies") {
      if (!options.moviePayload) {
        throw new Error("Missing movie register payload.");
      }
      await registerMovieOnCloud(config, options.moviePayload);
    } else {
      if (!options.episodePayload) {
        throw new Error("Missing episode register payload.");
      }
      await registerEpisodeOnCloud(config, options.episodePayload);
    }
    result.cloudRegistered = true;
    if (prisma) {
      await applyPublishFlags(prisma, kind, id, { cloudRegistered: true });
    }
    ctx?.setProgress({
      detail: "Registered on cloud API",
      result: { ...result },
    });
  } catch (error) {
    result.failedStage = "registering_cloud";
    ctx?.setProgress({
      stage: "registering_cloud",
      result: { ...result, failedStage: "registering_cloud" },
    });
    throw error;
  }

  return result;
}

export function movieRegisterPayloadFromDb(movie: {
  id: string;
  title: string;
  description: string;
  year: number | null;
  runtimeSeconds: number | null;
  posterPath: string | null;
  contentVersion: string;
  ready: boolean;
  assets: Array<{
    kind: string;
    qualityLabel: string | null;
    relativePath: string;
    mimeType: string | null;
  }>;
  subtitles: Array<{ language: string; label: string; relativePath: string }>;
}): RegisterMovieInput {
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description,
    year: movie.year,
    runtimeSeconds: movie.runtimeSeconds,
    posterPath: movie.posterPath,
    contentVersion: movie.contentVersion,
    ready: movie.ready,
    assets: movie.assets.map((a) => ({
      kind: a.kind,
      qualityLabel: a.qualityLabel,
      relativePath: a.relativePath.replaceAll(path.sep, "/"),
      mimeType: a.mimeType,
    })),
    subtitles: movie.subtitles.map((s) => ({
      language: s.language,
      label: s.label,
      relativePath: s.relativePath.replaceAll(path.sep, "/"),
    })),
  };
}

export function episodeRegisterPayloadFromDb(row: {
  id: string;
  title: string;
  description: string;
  episodeNumber: number;
  runtimeSeconds: number | null;
  posterPath: string | null;
  contentVersion: string;
  ready: boolean;
  assets: Array<{
    kind: string;
    qualityLabel: string | null;
    relativePath: string;
    mimeType: string | null;
  }>;
  subtitles: Array<{ language: string; label: string; relativePath: string }>;
  season: {
    id: string;
    seasonNumber: number;
    title: string;
    description: string;
    posterPath: string | null;
    show: {
      id: string;
      title: string;
      description: string;
      year: number | null;
      posterPath: string | null;
      contentVersion: string;
      ready: boolean;
    };
  };
}): RegisterEpisodeInput {
  const { season } = row;
  const { show } = season;
  return {
    show: {
      id: show.id,
      title: show.title,
      description: show.description,
      year: show.year,
      posterPath: show.posterPath,
      contentVersion: show.contentVersion,
      ready: show.ready,
    },
    season: {
      id: season.id,
      seasonNumber: season.seasonNumber,
      title: season.title,
      description: season.description,
      posterPath: season.posterPath,
    },
    episode: {
      id: row.id,
      episodeNumber: row.episodeNumber,
      title: row.title,
      description: row.description,
      runtimeSeconds: row.runtimeSeconds,
      posterPath: row.posterPath,
      contentVersion: row.contentVersion,
      ready: row.ready,
    },
    assets: row.assets.map((a) => ({
      kind: a.kind,
      qualityLabel: a.qualityLabel,
      relativePath: a.relativePath.replaceAll(path.sep, "/"),
      mimeType: a.mimeType,
    })),
    subtitles: row.subtitles.map((s) => ({
      language: s.language,
      label: s.label,
      relativePath: s.relativePath.replaceAll(path.sep, "/"),
    })),
  };
}
