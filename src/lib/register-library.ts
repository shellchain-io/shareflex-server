import type { PrismaClient } from "../../generated/prisma/client.js";

export type RegisterAssetInput = {
  kind: string;
  qualityLabel?: string | null;
  relativePath: string;
  mimeType?: string | null;
};

export type RegisterSubtitleInput = {
  language: string;
  label: string;
  relativePath: string;
};

export type RegisterMovieInput = {
  id: string;
  title: string;
  description?: string;
  year?: number | null;
  runtimeSeconds?: number | null;
  posterPath?: string | null;
  contentVersion?: string;
  ready?: boolean;
  assets: RegisterAssetInput[];
  subtitles?: RegisterSubtitleInput[];
};

export type RegisterEpisodeInput = {
  show: {
    id: string;
    title: string;
    description?: string;
    year?: number | null;
    posterPath?: string | null;
    contentVersion?: string;
    ready?: boolean;
  };
  season: {
    id: string;
    seasonNumber: number;
    title?: string;
    description?: string;
    posterPath?: string | null;
  };
  episode: {
    id: string;
    episodeNumber: number;
    title: string;
    description?: string;
    runtimeSeconds?: number | null;
    posterPath?: string | null;
    contentVersion?: string;
    ready?: boolean;
  };
  assets: RegisterAssetInput[];
  subtitles?: RegisterSubtitleInput[];
};

/** Upsert movie metadata + assets on the cloud API (bytes live on R2). */
export async function registerMovieMetadata(
  prisma: PrismaClient,
  input: RegisterMovieInput,
) {
  if (!input.id?.trim() || !input.title?.trim()) {
    throw new Error("Movie id and title are required.");
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new Error("Movie assets are required (at least master playlist).");
  }

  const movie = await prisma.movie.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      title: input.title.trim(),
      description: input.description ?? "",
      year: input.year ?? null,
      runtimeSeconds: input.runtimeSeconds ?? null,
      posterPath: input.posterPath ?? null,
      contentVersion: input.contentVersion ?? "1",
      ready: input.ready ?? true,
    },
    update: {
      title: input.title.trim(),
      description: input.description ?? "",
      year: input.year ?? null,
      runtimeSeconds: input.runtimeSeconds ?? null,
      posterPath: input.posterPath ?? null,
      contentVersion: input.contentVersion ?? "1",
      ready: input.ready ?? true,
    },
  });

  await prisma.movieAsset.deleteMany({ where: { movieId: movie.id } });
  await prisma.subtitleTrack.deleteMany({ where: { movieId: movie.id } });

  for (const asset of input.assets) {
    await prisma.movieAsset.create({
      data: {
        movieId: movie.id,
        kind: asset.kind,
        qualityLabel: asset.qualityLabel ?? null,
        relativePath: asset.relativePath,
        mimeType: asset.mimeType ?? null,
      },
    });
  }

  for (const track of input.subtitles ?? []) {
    await prisma.subtitleTrack.create({
      data: {
        movieId: movie.id,
        language: track.language,
        label: track.label,
        relativePath: track.relativePath,
      },
    });
  }

  return movie;
}

/** Upsert show/season/episode metadata + assets on the cloud API. */
export async function registerEpisodeMetadata(
  prisma: PrismaClient,
  input: RegisterEpisodeInput,
) {
  const { show: showIn, season: seasonIn, episode: epIn } = input;
  if (!showIn?.id || !showIn.title?.trim()) {
    throw new Error("Show id and title are required.");
  }
  if (!seasonIn?.id || !Number.isInteger(seasonIn.seasonNumber)) {
    throw new Error("Season id and seasonNumber are required.");
  }
  if (!epIn?.id || !Number.isInteger(epIn.episodeNumber) || !epIn.title?.trim()) {
    throw new Error("Episode id, episodeNumber, and title are required.");
  }
  if (!Array.isArray(input.assets) || input.assets.length === 0) {
    throw new Error("Episode assets are required (at least master playlist).");
  }

  const show = await prisma.show.upsert({
    where: { id: showIn.id },
    create: {
      id: showIn.id,
      title: showIn.title.trim(),
      description: showIn.description ?? "",
      year: showIn.year ?? null,
      posterPath: showIn.posterPath ?? null,
      contentVersion: showIn.contentVersion ?? "1",
      ready: showIn.ready ?? true,
    },
    update: {
      title: showIn.title.trim(),
      description: showIn.description ?? "",
      ...(showIn.year !== undefined ? { year: showIn.year } : {}),
      ...(showIn.posterPath !== undefined ? { posterPath: showIn.posterPath } : {}),
      ready: showIn.ready ?? true,
    },
  });

  const season = await prisma.season.upsert({
    where: { id: seasonIn.id },
    create: {
      id: seasonIn.id,
      showId: show.id,
      seasonNumber: seasonIn.seasonNumber,
      title:
        seasonIn.title ??
        (seasonIn.seasonNumber === 0
          ? "Specials"
          : `Season ${seasonIn.seasonNumber}`),
      description: seasonIn.description ?? "",
      posterPath: seasonIn.posterPath ?? null,
    },
    update: {
      seasonNumber: seasonIn.seasonNumber,
      ...(seasonIn.title !== undefined ? { title: seasonIn.title } : {}),
      ...(seasonIn.description !== undefined
        ? { description: seasonIn.description }
        : {}),
      ...(seasonIn.posterPath !== undefined
        ? { posterPath: seasonIn.posterPath }
        : {}),
    },
  });

  // Keep unique (showId, seasonNumber) consistent if an older row exists with different id.
  const clash = await prisma.season.findUnique({
    where: {
      showId_seasonNumber: {
        showId: show.id,
        seasonNumber: seasonIn.seasonNumber,
      },
    },
  });
  if (clash && clash.id !== season.id) {
    throw new Error(
      `Season S${seasonIn.seasonNumber} already exists on cloud as ${clash.id}; cannot register as ${season.id}.`,
    );
  }

  const epClash = await prisma.episode.findUnique({
    where: {
      seasonId_episodeNumber: {
        seasonId: season.id,
        episodeNumber: epIn.episodeNumber,
      },
    },
  });
  if (epClash && epClash.id !== epIn.id) {
    throw new Error(
      `Episode E${epIn.episodeNumber} already exists on cloud as ${epClash.id}; cannot register as ${epIn.id}. Delete the cloud episode first or reuse its id.`,
    );
  }

  const episode = await prisma.episode.upsert({
    where: { id: epIn.id },
    create: {
      id: epIn.id,
      seasonId: season.id,
      episodeNumber: epIn.episodeNumber,
      title: epIn.title.trim(),
      description: epIn.description ?? "",
      runtimeSeconds: epIn.runtimeSeconds ?? null,
      posterPath: epIn.posterPath ?? null,
      contentVersion: epIn.contentVersion ?? "1",
      ready: epIn.ready ?? true,
    },
    update: {
      seasonId: season.id,
      episodeNumber: epIn.episodeNumber,
      title: epIn.title.trim(),
      description: epIn.description ?? "",
      runtimeSeconds: epIn.runtimeSeconds ?? null,
      posterPath: epIn.posterPath ?? null,
      ready: epIn.ready ?? true,
    },
  });

  await prisma.episodeAsset.deleteMany({ where: { episodeId: episode.id } });
  await prisma.episodeSubtitleTrack.deleteMany({
    where: { episodeId: episode.id },
  });

  for (const asset of input.assets) {
    await prisma.episodeAsset.create({
      data: {
        episodeId: episode.id,
        kind: asset.kind,
        qualityLabel: asset.qualityLabel ?? null,
        relativePath: asset.relativePath,
        mimeType: asset.mimeType ?? null,
      },
    });
  }

  for (const track of input.subtitles ?? []) {
    await prisma.episodeSubtitleTrack.create({
      data: {
        episodeId: episode.id,
        language: track.language,
        label: track.label,
        relativePath: track.relativePath,
      },
    });
  }

  return { show, season, episode };
}
