import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Env } from "./env.js";
import { deletePrefixFromR2 } from "./r2.js";

export class LibraryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryNotFoundError";
  }
}

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

/** Keep movie metadata + poster; wipe playable media (local + R2). */
export async function purgeMovieMedia(
  prisma: PrismaClient,
  mediaRoot: string,
  movieId: string,
  config?: Env,
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
        runtimeSeconds: null,
        contentVersion: bumpContentVersion(movie.contentVersion),
      },
    }),
  ]);

  await purgePlayableFiles(path.join(mediaRoot, "movies", movieId));
  await quietDeleteR2(config, `movies/${movieId}`, true);

  return prisma.movie.findUniqueOrThrow({ where: { id: movieId } });
}

/** Delete movie row + entire movies/{id} directory (+ R2). */
export async function deleteMovie(
  prisma: PrismaClient,
  mediaRoot: string,
  movieId: string,
  config?: Env,
) {
  const movie = await prisma.movie.findUnique({ where: { id: movieId } });
  if (!movie) {
    throw new LibraryNotFoundError("Movie not found.");
  }

  await prisma.movie.delete({ where: { id: movieId } });
  await rmQuiet(path.join(mediaRoot, "movies", movieId));
  await quietDeleteR2(config, `movies/${movieId}`, false);
  return { ok: true as const, id: movieId };
}

/** Keep episode slot (SxxExx + titles); wipe playable media (local + R2). */
export async function purgeEpisodeMedia(
  prisma: PrismaClient,
  mediaRoot: string,
  episodeId: string,
  config?: Env,
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
        runtimeSeconds: null,
        contentVersion: bumpContentVersion(episode.contentVersion),
      },
    }),
  ]);

  await purgePlayableFiles(path.join(mediaRoot, "episodes", episodeId));
  await quietDeleteR2(config, `episodes/${episodeId}`, true);
  await refreshShowReady(prisma, episode.season.showId);

  return prisma.episode.findUniqueOrThrow({ where: { id: episodeId } });
}

/** Delete season + all episodes (DB cascade) and their media dirs (+ R2). */
export async function deleteSeason(
  prisma: PrismaClient,
  mediaRoot: string,
  seasonId: string,
  config?: Env,
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

  await refreshShowReady(prisma, showId);

  return { ok: true as const, id: seasonId, showId };
}

/** Delete entire series + seasons/episodes media (+ R2). */
export async function deleteShow(
  prisma: PrismaClient,
  mediaRoot: string,
  showId: string,
  config?: Env,
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

  return { ok: true as const, id: showId };
}
