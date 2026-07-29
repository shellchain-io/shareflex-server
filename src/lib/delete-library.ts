import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  deleteOnCloudApi,
  listCloudLibrary,
} from "./cloud-publish.js";
import type { Env } from "./env.js";
import { deletePrefixFromR2 } from "./r2.js";

export class LibraryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryNotFoundError";
  }
}

export type CloudSyncResult = {
  attempted: boolean;
  ok: boolean;
  message?: string;
};

export type DeleteOptions = {
  /** When true, do not call PUBLISH_TARGET (request already came from Mac cascade). */
  skipCloudCascade?: boolean;
};

function bumpContentVersion(current: string): string {
  const asNumber = Number(current);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return String(Math.trunc(asNumber) + 1);
  }
  return String(Date.now());
}

async function rmQuiet(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/** Remove HLS / subtitle files but keep poster.jpg when present. */
async function purgePlayableFiles(contentDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(contentDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.name !== "poster.jpg")
      .map((entry) => rmQuiet(path.join(contentDir, entry.name))),
  );
}

async function refreshShowReady(
  prisma: PrismaClient,
  showId: string,
): Promise<void> {
  const readyEpisode = await prisma.episode.findFirst({
    where: {
      ready: true,
      season: { showId },
    },
    select: { id: true },
  });
  await prisma.show.update({
    where: { id: showId },
    data: { ready: Boolean(readyEpisode) },
  });
}

async function quietDeleteR2(
  config: Env | undefined,
  keyPrefix: string,
  keepPoster = false,
): Promise<void> {
  if (!config) return;
  try {
    const { deleted } = await deletePrefixFromR2({ config, keyPrefix, keepPoster });
    if (deleted > 0) {
      console.log(`R2 deleted ${deleted} object(s) under ${keyPrefix}/`);
    }
  } catch (error) {
    console.warn(
      `R2 delete failed for ${keyPrefix} (local/DB delete still applied):`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function cascadeCloud(
  config: Env | undefined,
  path: Parameters<typeof deleteOnCloudApi>[1],
  options?: DeleteOptions,
): Promise<CloudSyncResult> {
  if (!config || options?.skipCloudCascade) {
    return { attempted: false, ok: true };
  }
  return deleteOnCloudApi(config, path);
}

/** Keep movie metadata + poster; wipe playable media (local + R2). */
export async function purgeMovieMedia(
  prisma: PrismaClient,
  mediaRoot: string,
  movieId: string,
  config?: Env,
  options?: DeleteOptions,
) {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie) {
    throw new LibraryNotFoundError("Movie not found.");
  }

  await prisma.$transaction([
    prisma.movieAsset.deleteMany({
      where: { movieId, kind: { not: "poster" } },
    }),
    prisma.subtitleTrack.deleteMany({ where: { movieId } }),
    prisma.playbackProgress.deleteMany({ where: { movieId } }),
    prisma.watchHistory.deleteMany({ where: { movieId } }),
    prisma.movie.update({
      where: { id: movieId },
      data: {
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        runtimeSeconds: null,
        contentVersion: bumpContentVersion(movie.contentVersion),
      },
    }),
  ]);

  await purgePlayableFiles(path.join(mediaRoot, "movies", movieId));
  await quietDeleteR2(config, `movies/${movieId}`, true);
  const cloud = await cascadeCloud(
    config,
    `/v1/admin/movies/${movieId}/media`,
    options,
  );

  const updated = await prisma.movie.findUniqueOrThrow({ where: { id: movieId } });
  return { movie: updated, cloud };
}

/** Delete movie row + entire movies/{id} directory (+ R2). */
export async function deleteMovie(
  prisma: PrismaClient,
  mediaRoot: string,
  movieId: string,
  config?: Env,
  options?: DeleteOptions,
) {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie) {
    throw new LibraryNotFoundError("Movie not found.");
  }

  await prisma.movie.delete({ where: { id: movieId } });
  await rmQuiet(path.join(mediaRoot, "movies", movieId));
  await quietDeleteR2(config, `movies/${movieId}`, false);
  const cloud = await cascadeCloud(
    config,
    `/v1/admin/movies/${movieId}`,
    options,
  );
  return { ok: true as const, id: movieId, cloud };
}

/** Keep episode slot (SxxExx + titles); wipe playable media (local + R2). */
export async function purgeEpisodeMedia(
  prisma: PrismaClient,
  mediaRoot: string,
  episodeId: string,
  config?: Env,
  options?: DeleteOptions,
) {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { season: { select: { showId: true } } },
  });
  if (!episode) {
    throw new LibraryNotFoundError("Episode not found.");
  }

  await prisma.$transaction([
    prisma.episodeAsset.deleteMany({
      where: { episodeId, kind: { not: "poster" } },
    }),
    prisma.episodeSubtitleTrack.deleteMany({ where: { episodeId } }),
    prisma.episodePlaybackProgress.deleteMany({ where: { episodeId } }),
    prisma.episodeWatchHistory.deleteMany({ where: { episodeId } }),
    prisma.episode.update({
      where: { id: episodeId },
      data: {
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        runtimeSeconds: null,
        contentVersion: bumpContentVersion(episode.contentVersion),
      },
    }),
  ]);

  await purgePlayableFiles(path.join(mediaRoot, "episodes", episodeId));
  await quietDeleteR2(config, `episodes/${episodeId}`, true);
  const cloud = await cascadeCloud(
    config,
    `/v1/admin/episodes/${episodeId}/media`,
    options,
  );
  await refreshShowReady(prisma, episode.season.showId);

  const updated = await prisma.episode.findUniqueOrThrow({
    where: { id: episodeId },
  });
  return { episode: updated, cloud };
}

/** Delete season + all episodes (DB cascade) and their media dirs (+ R2). */
export async function deleteSeason(
  prisma: PrismaClient,
  mediaRoot: string,
  seasonId: string,
  config?: Env,
  options?: DeleteOptions,
) {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      episodes: { select: { id: true } },
    },
  });
  if (!season) {
    throw new LibraryNotFoundError("Season not found.");
  }

  const episodeIds = season.episodes.map((ep) => ep.id);
  const showId = season.showId;

  await prisma.season.delete({ where: { id: seasonId } });

  await Promise.all([
    ...episodeIds.map((id) => rmQuiet(path.join(mediaRoot, "episodes", id))),
    rmQuiet(path.join(mediaRoot, "seasons", seasonId)),
  ]);

  await Promise.all([
    ...episodeIds.map((id) => quietDeleteR2(config, `episodes/${id}`, false)),
    quietDeleteR2(config, `seasons/${seasonId}`, false),
  ]);

  const cloud = await cascadeCloud(
    config,
    `/v1/admin/seasons/${seasonId}`,
    options,
  );

  await refreshShowReady(prisma, showId);

  return { ok: true as const, id: seasonId, showId, cloud };
}

/** Delete entire series + seasons/episodes media (+ R2). */
export async function deleteShow(
  prisma: PrismaClient,
  mediaRoot: string,
  showId: string,
  config?: Env,
  options?: DeleteOptions,
) {
  const show = await prisma.show.findUnique({
    where: { id: showId },
    include: {
      seasons: {
        include: {
          episodes: { select: { id: true } },
        },
      },
    },
  });
  if (!show) {
    throw new LibraryNotFoundError("Show not found.");
  }

  const seasonIds = show.seasons.map((season) => season.id);
  const episodeIds = show.seasons.flatMap((season) =>
    season.episodes.map((ep) => ep.id),
  );

  await prisma.show.delete({ where: { id: showId } });

  await Promise.all([
    ...episodeIds.map((id) => rmQuiet(path.join(mediaRoot, "episodes", id))),
    ...seasonIds.map((id) => rmQuiet(path.join(mediaRoot, "seasons", id))),
    rmQuiet(path.join(mediaRoot, "shows", showId)),
  ]);

  await Promise.all([
    ...episodeIds.map((id) => quietDeleteR2(config, `episodes/${id}`, false)),
    ...seasonIds.map((id) => quietDeleteR2(config, `seasons/${id}`, false)),
    quietDeleteR2(config, `shows/${showId}`, false),
  ]);

  const cloud = await cascadeCloud(
    config,
    `/v1/admin/shows/${showId}`,
    options,
  );

  return { ok: true as const, id: showId, cloud };
}

/**
 * Delete GCE catalog rows that are not on this Mac (phone still shows them).
 * Does not touch Mac library. R2 cleanup is best-effort via GCE delete handlers.
 */
export async function purgeCloudOrphans(
  prisma: PrismaClient,
  config: Env,
): Promise<{
  deletedShows: Array<{ id: string; title: string }>;
  deletedMovies: Array<{ id: string; title: string }>;
  skippedShows: number;
  skippedMovies: number;
  errors: string[];
}> {
  const remote = await listCloudLibrary(config);
  const localShowIds = new Set(
    (await prisma.show.findMany({ select: { id: true } })).map((s) => s.id),
  );
  const localMovieIds = new Set(
    (await prisma.movie.findMany({ select: { id: true } })).map((m) => m.id),
  );

  const deletedShows: Array<{ id: string; title: string }> = [];
  const deletedMovies: Array<{ id: string; title: string }> = [];
  const errors: string[] = [];
  let skippedShows = 0;
  let skippedMovies = 0;

  for (const show of remote.shows) {
    if (localShowIds.has(show.id)) {
      skippedShows += 1;
      continue;
    }
    const result = await deleteOnCloudApi(config, `/v1/admin/shows/${show.id}`);
    if (result.ok) {
      deletedShows.push({ id: show.id, title: show.title });
    } else {
      errors.push(`Show “${show.title}”: ${result.message || "delete failed"}`);
    }
  }

  for (const movie of remote.movies) {
    if (localMovieIds.has(movie.id)) {
      skippedMovies += 1;
      continue;
    }
    const result = await deleteOnCloudApi(
      config,
      `/v1/admin/movies/${movie.id}`,
    );
    if (result.ok) {
      deletedMovies.push({ id: movie.id, title: movie.title });
    } else {
      errors.push(`Movie “${movie.title}”: ${result.message || "delete failed"}`);
    }
  }

  return {
    deletedShows,
    deletedMovies,
    skippedShows,
    skippedMovies,
    errors,
  };
}

/**
 * Pull phone catalog (GCE) and align this Mac library:
 * - Titles that were registered on cloud but no longer exist there → delete locally (+ R2)
 * - Titles still on cloud → mark cloudRegistered
 * - Local-only encodes (never registered) → left alone
 */
export async function syncLibraryFromCloud(
  prisma: PrismaClient,
  mediaRoot: string,
  config: Env,
): Promise<{
  removedShows: Array<{ id: string; title: string }>;
  removedMovies: Array<{ id: string; title: string }>;
  markedCloudShows: number;
  markedCloudMovies: number;
  clearedCloudFlags: number;
  errors: string[];
}> {
  const remote = await listCloudLibrary(config);
  const remoteShowIds = new Set(remote.shows.map((s) => s.id));
  const remoteMovieIds = new Set(remote.movies.map((m) => m.id));

  const removedShows: Array<{ id: string; title: string }> = [];
  const removedMovies: Array<{ id: string; title: string }> = [];
  const errors: string[] = [];
  let markedCloudShows = 0;
  let markedCloudMovies = 0;
  let clearedCloudFlags = 0;

  const movies = await prisma.movie.findMany({
    select: {
      id: true,
      title: true,
      cloudRegistered: true,
      cdnUploaded: true,
    },
  });

  for (const movie of movies) {
    const onCloud = remoteMovieIds.has(movie.id);
    if (onCloud) {
      if (!movie.cloudRegistered || !movie.cdnUploaded) {
        await prisma.movie.update({
          where: { id: movie.id },
          data: { cloudRegistered: true, cdnUploaded: true },
        });
        markedCloudMovies += 1;
      }
      continue;
    }

    // Gone from phone catalog — remove local copy only if it had been published.
    if (movie.cloudRegistered || movie.cdnUploaded) {
      try {
        await deleteMovie(prisma, mediaRoot, movie.id, config, {
          skipCloudCascade: true,
        });
        removedMovies.push({ id: movie.id, title: movie.title });
      } catch (error) {
        errors.push(
          `Movie “${movie.title}”: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const shows = await prisma.show.findMany({
    select: {
      id: true,
      title: true,
      seasons: {
        select: {
          episodes: {
            select: {
              id: true,
              cloudRegistered: true,
              cdnUploaded: true,
            },
          },
        },
      },
    },
  });

  for (const show of shows) {
    const episodes = show.seasons.flatMap((s) => s.episodes);
    const hadPublished = episodes.some((ep) => ep.cloudRegistered || ep.cdnUploaded);
    const onCloud = remoteShowIds.has(show.id);

    if (onCloud) {
      const toMark = episodes.filter((ep) => ep.cdnUploaded || ep.cloudRegistered);
      if (toMark.length > 0) {
        const result = await prisma.episode.updateMany({
          where: {
            id: { in: toMark.map((ep) => ep.id) },
            OR: [{ cloudRegistered: false }, { cdnUploaded: false }],
          },
          data: { cloudRegistered: true, cdnUploaded: true },
        });
        if (result.count > 0) markedCloudShows += 1;
      }
      continue;
    }

    if (hadPublished) {
      try {
        await deleteShow(prisma, mediaRoot, show.id, config, {
          skipCloudCascade: true,
        });
        removedShows.push({ id: show.id, title: show.title });
      } catch (error) {
        errors.push(
          `Show “${show.title}”: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      continue;
    }

    // Local-only encode: ensure cloud flags stay false if somehow set.
    const flagged = episodes.filter((ep) => ep.cloudRegistered || ep.cdnUploaded);
    if (flagged.length > 0) {
      await prisma.episode.updateMany({
        where: { id: { in: flagged.map((ep) => ep.id) } },
        data: { cloudRegistered: false, cdnUploaded: false },
      });
      clearedCloudFlags += flagged.length;
    }
  }

  return {
    removedShows,
    removedMovies,
    markedCloudShows,
    markedCloudMovies,
    clearedCloudFlags,
    errors,
  };
}
