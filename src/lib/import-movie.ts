import "dotenv/config";
import path from "node:path";
import { loadEnv } from "./env.js";
import type { JobContext } from "./jobs.js";
import { resolveMediaRoot } from "./movies.js";
import { installPosterFile, moviePosterRelativePath } from "./posters.js";
import { createPrismaClient } from "./prisma.js";
import { transcodeMovie } from "./transcode.js";

export type AddMovieOptions = {
  sourcePath: string;
  title?: string;
  year?: number;
  description?: string;
  movieId?: string;
  /** Original client upload filename for Library / Jobs display. */
  sourceFile?: string;
  /** Custom poster image path; replaces auto-extracted frame when provided. */
  posterSourcePath?: string;
  signal?: AbortSignal;
  ctx?: JobContext;
};

export async function addMovie(options: AddMovieOptions) {
  const config = loadEnv();
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);
  const prisma = createPrismaClient(config.DATABASE_URL);
  const ctx = options.ctx;

  try {
    ctx?.setProgress({
      stage: "encoding",
      detail: "Encoding HLS (1080 / 720 / 480)…",
      progress: 0,
    });

    const absoluteSource = path.resolve(options.sourcePath);
    const sourceFile =
      options.sourceFile?.trim() || path.basename(absoluteSource) || null;
    const result = await transcodeMovie({
      sourcePath: absoluteSource,
      mediaRoot,
      ...(options.title ? { title: options.title } : {}),
      ...(options.movieId ? { movieId: options.movieId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(ctx?.signal && !options.signal ? { signal: ctx.signal } : {}),
      onProgress: (info) => {
        ctx?.setProgress({
          stage: "encoding",
          detail: info.detail,
          progress: info.percent,
        });
      },
    });

    let posterRelativePath = result.posterRelativePath;
    if (options.posterSourcePath) {
      posterRelativePath = await installPosterFile({
        mediaRoot,
        sourcePath: options.posterSourcePath,
        relativePath: moviePosterRelativePath(result.movieId),
      });
    }

    const movie = await prisma.movie.upsert({
      where: { id: result.movieId },
      create: {
        id: result.movieId,
        title: options.title ?? result.title,
        description: options.description ?? "",
        ...(options.year !== undefined ? { year: options.year } : { year: null }),
        runtimeSeconds: result.durationSeconds,
        posterPath: posterRelativePath,
        contentVersion: "1",
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        sourceFile,
      },
      update: {
        title: options.title ?? result.title,
        description: options.description ?? "",
        ...(options.year !== undefined ? { year: options.year } : {}),
        runtimeSeconds: result.durationSeconds,
        posterPath: posterRelativePath,
        ready: false,
        cdnUploaded: false,
        cloudRegistered: false,
        sourceFile,
      },
    });

    await prisma.movieAsset.deleteMany({ where: { movieId: movie.id } });
    await prisma.subtitleTrack.deleteMany({ where: { movieId: movie.id } });

    await prisma.movieAsset.create({
      data: {
        movieId: movie.id,
        kind: "master",
        qualityLabel: null,
        relativePath: result.masterRelativePath,
        mimeType: "application/vnd.apple.mpegurl",
      },
    });

    for (const rung of result.ladder) {
      await prisma.movieAsset.create({
        data: {
          movieId: movie.id,
          kind: "video",
          qualityLabel: rung.label,
          relativePath: path.join("movies", movie.id, rung.label, "index.m3u8"),
          mimeType: "application/vnd.apple.mpegurl",
        },
      });
    }

    if (posterRelativePath) {
      await prisma.movieAsset.create({
        data: {
          movieId: movie.id,
          kind: "poster",
          qualityLabel: null,
          relativePath: posterRelativePath,
          mimeType: "image/jpeg",
        },
      });
    }

    for (const track of result.subtitles) {
      await prisma.subtitleTrack.create({
        data: {
          movieId: movie.id,
          language: track.language,
          label: track.label,
          relativePath: track.relativePath,
        },
      });
    }

    const readyMovie = await prisma.movie.update({
      where: { id: movie.id },
      data: { ready: true },
    });

    return {
      movie: readyMovie,
      masterRelativePath: result.masterRelativePath,
      ladder: result.ladder.map((rung) => rung.label),
      subtitleCount: result.subtitles.length,
      needsUpload: true,
      movieId: readyMovie.id,
    };
  } finally {
    await prisma.$disconnect();
  }
}
