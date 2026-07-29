import "dotenv/config";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "./env.js";
import { createId } from "./ids.js";
import type { JobContext } from "./jobs.js";
import { resolveMediaRoot } from "./movies.js";
import {
  installPosterFile,
  seasonPosterRelativePath,
} from "./posters.js";
import { createPrismaClient } from "./prisma.js";
import { showPosterRelativePath } from "./shows.js";
import { transcodeMovie } from "./transcode.js";

export type AddEpisodeOptions = {
  sourcePath: string;
  showTitle: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeTitle?: string;
  description?: string;
  seasonDescription?: string;
  /** Original client upload filename for Library / Jobs display. */
  sourceFile?: string;
  /** Custom season artwork; required for brand-new seasons via admin. */
  seasonPosterSourcePath?: string;
  showYear?: number;
  showId?: string;
  episodeId?: string;
  signal?: AbortSignal;
  ctx?: JobContext;
};

export function parseSeasonEpisode(
  fileName: string,
): { seasonNumber: number; episodeNumber: number } | null {
  const match = fileName.match(/[Ss](\d{1,2})[Ee](\d{1,3})/);
  if (!match) {
    return null;
  }
  return {
    seasonNumber: Number(match[1]),
    episodeNumber: Number(match[2]),
  };
}

export async function addEpisode(options: AddEpisodeOptions) {
  const config = loadEnv();
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);
  const prisma = createPrismaClient(config.DATABASE_URL);
  const ctx = options.ctx;

  try {
    if (
      !Number.isInteger(options.seasonNumber) ||
      options.seasonNumber < 0 ||
      !Number.isInteger(options.episodeNumber) ||
      options.episodeNumber < 1
    ) {
      throw new Error("Season must be >= 0 and episode must be >= 1.");
    }

    ctx?.setProgress({
      stage: "encoding",
      detail: "Encoding HLS (1080 / 720 / 480)…",
      progress: 0,
    });

    const absoluteSource = path.resolve(options.sourcePath);
    const sourceFile =
      options.sourceFile?.trim() || path.basename(absoluteSource) || null;
    const episodeId = options.episodeId ?? createId("e");

    let show =
      options.showId !== undefined
        ? await prisma.show.findUnique({ where: { id: options.showId } })
        : await prisma.show.findFirst({
            where: { title: options.showTitle },
          });

    if (!show) {
      show = await prisma.show.create({
        data: {
          id: options.showId ?? createId("s"),
          title: options.showTitle,
          description: "",
          year: options.showYear ?? null,
          ready: false,
        },
      });
    } else if (options.showYear !== undefined && show.year == null) {
      show = await prisma.show.update({
        where: { id: show.id },
        data: { year: options.showYear },
      });
    }

    let season = await prisma.season.findUnique({
      where: {
        showId_seasonNumber: {
          showId: show.id,
          seasonNumber: options.seasonNumber,
        },
      },
    });

    if (!season) {
      season = await prisma.season.create({
        data: {
          id: createId("sn"),
          showId: show.id,
          seasonNumber: options.seasonNumber,
          title:
            options.seasonNumber === 0
              ? "Specials"
              : `Season ${options.seasonNumber}`,
          description: options.seasonDescription ?? "",
        },
      });
    } else {
      const seasonPatch: { description?: string } = {};
      if (
        options.seasonDescription !== undefined &&
        options.seasonDescription.trim() !== ""
      ) {
        seasonPatch.description = options.seasonDescription.trim();
      }
      if (Object.keys(seasonPatch).length > 0) {
        season = await prisma.season.update({
          where: { id: season.id },
          data: seasonPatch,
        });
      }
    }

    if (options.seasonPosterSourcePath) {
      const relative = await installPosterFile({
        mediaRoot,
        sourcePath: options.seasonPosterSourcePath,
        relativePath: seasonPosterRelativePath(season.id),
      });
      season = await prisma.season.update({
        where: { id: season.id },
        data: { posterPath: relative },
      });

      // Promote to show art when the series has none yet.
      if (!show.posterPath) {
        const destRelative = showPosterRelativePath(show.id);
        const destAbsolute = path.join(mediaRoot, destRelative);
        await mkdir(path.dirname(destAbsolute), { recursive: true });
        await copyFile(path.join(mediaRoot, relative), destAbsolute);
        show = await prisma.show.update({
          where: { id: show.id },
          data: { posterPath: destRelative },
        });
      }
    }

    const existingEpisode = await prisma.episode.findUnique({
      where: {
        seasonId_episodeNumber: {
          seasonId: season.id,
          episodeNumber: options.episodeNumber,
        },
      },
    });

    const result = await transcodeMovie({
      sourcePath: absoluteSource,
      mediaRoot,
      kind: "episodes",
      id: existingEpisode?.id ?? episodeId,
      title:
        options.episodeTitle ??
        `Episode ${options.episodeNumber}`,
      ...(options.signal
        ? { signal: options.signal }
        : ctx?.signal
          ? { signal: ctx.signal }
          : {}),
      onProgress: (info) => {
        ctx?.setProgress({
          stage: "encoding",
          detail: info.detail,
          progress: info.percent,
        });
      },
    });

    const episode = await prisma.episode.upsert({
      where: {
        seasonId_episodeNumber: {
          seasonId: season.id,
          episodeNumber: options.episodeNumber,
        },
      },
      create: {
        id: result.id,
        seasonId: season.id,
        episodeNumber: options.episodeNumber,
        title: options.episodeTitle ?? result.title,
        description: options.description ?? "",
        runtimeSeconds: result.durationSeconds,
        posterPath: result.posterRelativePath,
        contentVersion: "1",
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        sourceFile,
      },
      update: {
        title: options.episodeTitle ?? result.title,
        description: options.description ?? "",
        runtimeSeconds: result.durationSeconds,
        posterPath: result.posterRelativePath,
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        sourceFile,
      },
    });

    await prisma.episodeAsset.deleteMany({ where: { episodeId: episode.id } });
    await prisma.episodeSubtitleTrack.deleteMany({
      where: { episodeId: episode.id },
    });

    await prisma.episodeAsset.create({
      data: {
        episodeId: episode.id,
        kind: "master",
        qualityLabel: null,
        relativePath: result.masterRelativePath,
        mimeType: "application/vnd.apple.mpegurl",
      },
    });

    for (const rung of result.ladder) {
      await prisma.episodeAsset.create({
        data: {
          episodeId: episode.id,
          kind: "video",
          qualityLabel: rung.label,
          relativePath: path.join("episodes", episode.id, rung.label, "index.m3u8"),
          mimeType: "application/vnd.apple.mpegurl",
        },
      });
    }

    if (result.posterRelativePath) {
      await prisma.episodeAsset.create({
        data: {
          episodeId: episode.id,
          kind: "poster",
          qualityLabel: null,
          relativePath: result.posterRelativePath,
          mimeType: "image/jpeg",
        },
      });
    }

    for (const track of result.subtitles) {
      await prisma.episodeSubtitleTrack.create({
        data: {
          episodeId: episode.id,
          language: track.language,
          label: track.label,
          relativePath: track.relativePath,
        },
      });
    }

    const readyEpisode = await prisma.episode.update({
      where: { id: episode.id },
      data: { ready: true },
    });

    // Promote first available poster to show art.
    if (result.posterRelativePath && !show.posterPath) {
      const destRelative = showPosterRelativePath(show.id);
      const destAbsolute = path.join(mediaRoot, destRelative);
      await mkdir(path.dirname(destAbsolute), { recursive: true });
      await copyFile(path.join(mediaRoot, result.posterRelativePath), destAbsolute);
      show = await prisma.show.update({
        where: { id: show.id },
        data: { posterPath: destRelative },
      });
    }

    const readyShow = await prisma.show.update({
      where: { id: show.id },
      data: { ready: true },
    });

    // Refresh season for poster path after possible updates.
    season = await prisma.season.findUniqueOrThrow({ where: { id: season.id } });

    return {
      show: readyShow,
      season,
      episode: readyEpisode,
      masterRelativePath: result.masterRelativePath,
      ladder: result.ladder.map((rung) => rung.label),
      subtitleCount: result.subtitles.length,
      needsUpload: true,
      episodeId: readyEpisode.id,
      showId: readyShow.id,
      seasonId: season.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}
