import { createWriteStream } from "node:fs";
import { copyFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  deleteMovie,
  deleteSeason,
  deleteShow,
  LibraryNotFoundError,
  purgeEpisodeMedia,
  purgeMovieMedia,
} from "../lib/delete-library.js";
import { addEpisode, parseSeasonEpisode } from "../lib/import-episode.js";
import { addMovie } from "../lib/import-movie.js";
import { createId } from "../lib/ids.js";
import { enqueueAdminJob, getJob, listJobs, cancelAdminJob } from "../lib/jobs.js";
import { serializeMovie } from "../lib/movies.js";
import { publishLocalPackageToR2 } from "../lib/publish-r2.js";
import {
  installPosterFile,
  isImageFilename,
  seasonPosterRelativePath,
} from "../lib/posters.js";
import { serializeShow, showPosterRelativePath } from "../lib/shows.js";

const ALLOWED_EXT = new Set([
  ".mp4",
  ".mkv",
  ".mov",
  ".m4v",
  ".avi",
  ".webm",
  ".ts",
  ".mpg",
  ".mpeg",
]);

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "upload.bin";
}

async function discardUpload(stream: NodeJS.ReadableStream): Promise<void> {
  stream.resume();
  try {
    await finished(stream);
  } catch {
    // Client may already have aborted; ignore.
  }
}

async function saveUpload(
  mediaRoot: string,
  filename: string,
  stream: NodeJS.ReadableStream,
): Promise<string> {
  const uploadsDir = path.join(mediaRoot, "temp", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const dest = path.join(uploadsDir, `${Date.now()}-${safe}`);
  await pipeline(stream, createWriteStream(dest));
  return dest;
}

type SavedPart = { path: string; filename: string };

async function readVideoAndThumbnail(request: FastifyRequest, mediaRoot: string) {
  const fields: Record<string, string> = {};
  let video: SavedPart | null = null;
  let thumbnail: SavedPart | null = null;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname === "thumbnail") {
        if (thumbnail) {
          await discardUpload(part.file);
          continue;
        }
        thumbnail = {
          path: await saveUpload(mediaRoot, part.filename, part.file),
          filename: part.filename,
        };
      } else if (part.fieldname === "file" || !video) {
        if (video) {
          await discardUpload(part.file);
          continue;
        }
        video = {
          path: await saveUpload(mediaRoot, part.filename, part.file),
          filename: part.filename,
        };
      } else {
        await discardUpload(part.file);
      }
    } else {
      fields[part.fieldname] = String(part.value ?? "").trim();
    }
  }

  return { fields, video, thumbnail };
}

const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/admin/library",
    {
      onRequest: [app.requireOwner],
    },
    async () => {
      const [movies, shows] = await Promise.all([
        app.prisma.movie.findMany({ orderBy: { updatedAt: "desc" } }),
        app.prisma.show.findMany({
          include: {
            seasons: {
              include: {
                _count: {
                  select: { episodes: true },
                },
              },
            },
          },
          orderBy: { updatedAt: "desc" },
        }),
      ]);

      return {
        movies: movies.map(serializeMovie),
        shows: shows.map((show) =>
          serializeShow(show, {
            seasonCount: show.seasons.length,
            episodeCount: show.seasons.reduce(
              (sum, season) => sum + season._count.episodes,
              0,
            ),
          }),
        ),
        jobs: listJobs(20),
      };
    },
  );

  app.get(
    "/v1/admin/library/movies/:id",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const movie = await app.prisma.movie.findUnique({ where: { id } });
      if (!movie) {
        return reply.code(404).send({
          error: "not_found",
          message: "Movie not found.",
        });
      }
      const relatedJobs = listJobs(40).filter(
        (job) =>
          job.kind === "movie" &&
          (job.title === movie.title ||
            String(job.result?.movieId ?? "") === movie.id),
      );
      return {
        movie: {
          ...serializeMovie(movie),
          hasPoster: Boolean(movie.posterPath),
          hasDescription: Boolean(movie.description?.trim()),
          createdAt: movie.createdAt.toISOString(),
          updatedAt: movie.updatedAt.toISOString(),
        },
        jobs: relatedJobs,
      };
    },
  );

  app.get(
    "/v1/admin/library/shows/:id",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const show = await app.prisma.show.findUnique({
        where: { id },
        include: {
          seasons: {
            orderBy: { seasonNumber: "asc" },
            include: {
              episodes: {
                orderBy: { episodeNumber: "asc" },
                select: {
                  id: true,
                  episodeNumber: true,
                  title: true,
                  ready: true,
                  runtimeSeconds: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });
      if (!show) {
        return reply.code(404).send({
          error: "not_found",
          message: "Show not found.",
        });
      }

      const episodeIds = new Set(
        show.seasons.flatMap((season) => season.episodes.map((ep) => ep.id)),
      );
      const relatedJobs = listJobs(50).filter(
        (job) =>
          job.kind === "episode" &&
          (job.title.includes(show.title) ||
            episodeIds.has(String(job.result?.episodeId ?? ""))),
      );

      return {
        show: {
          ...serializeShow(show, {
            seasonCount: show.seasons.length,
            episodeCount: show.seasons.reduce(
              (sum, season) => sum + season.episodes.length,
              0,
            ),
          }),
          hasPoster: Boolean(show.posterPath),
          createdAt: show.createdAt.toISOString(),
          updatedAt: show.updatedAt.toISOString(),
          seasons: show.seasons.map((season) => ({
            id: season.id,
            seasonNumber: season.seasonNumber,
            title: season.title,
            description: season.description ?? "",
            hasPoster: Boolean(season.posterPath),
            episodeCount: season.episodes.length,
            readyCount: season.episodes.filter((ep) => ep.ready).length,
            episodes: season.episodes.map((ep) => ({
              id: ep.id,
              episodeNumber: ep.episodeNumber,
              title: ep.title,
              ready: ep.ready,
              runtimeSeconds: ep.runtimeSeconds,
              updatedAt: ep.updatedAt.toISOString(),
            })),
          })),
        },
        jobs: relatedJobs,
      };
    },
  );

  app.delete(
    "/v1/admin/movies/:id/media",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const movie = await purgeMovieMedia(app.prisma, app.mediaRoot, id, app.config);
        return {
          ok: true,
          movie: {
            ...serializeMovie(movie),
            hasPoster: Boolean(movie.posterPath),
            hasDescription: Boolean(movie.description?.trim()),
          },
        };
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/movies/:id",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await deleteMovie(app.prisma, app.mediaRoot, id, app.config);
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/episodes/:id/media",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const episode = await purgeEpisodeMedia(app.prisma, app.mediaRoot, id, app.config);
        return {
          ok: true,
          episode: {
            id: episode.id,
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            ready: episode.ready,
            runtimeSeconds: episode.runtimeSeconds,
            contentVersion: episode.contentVersion,
          },
        };
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/seasons/:id",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await deleteSeason(app.prisma, app.mediaRoot, id, app.config);
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/admin/shows/:id",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await deleteShow(app.prisma, app.mediaRoot, id, app.config);
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return reply.code(404).send({ error: "not_found", message: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/admin/jobs",
    { onRequest: [app.requireOwner] },
    async () => ({ jobs: listJobs(50) }),
  );

  app.get(
    "/v1/admin/jobs/:jobId",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const job = getJob(jobId);
      if (!job) {
        return reply.code(404).send({
          error: "not_found",
          message: "Job not found.",
        });
      }
      return { job };
    },
  );

  app.post(
    "/v1/admin/jobs/:jobId/cancel",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const result = cancelAdminJob(jobId);
      if (!result) {
        return reply.code(404).send({
          error: "not_found",
          message: "Job not found.",
        });
      }
      if (!result.ok) {
        return reply.code(409).send({
          error: "not_cancellable",
          message: "Only queued or running encode jobs can be cancelled.",
          job: result.job,
        });
      }
      return { job: result.job };
    },
  );

  app.get(
    "/v1/admin/shows",
    { onRequest: [app.requireOwner] },
    async () => {
      const shows = await app.prisma.show.findMany({
        include: {
          seasons: {
            include: {
              _count: { select: { episodes: true } },
              episodes: {
                select: {
                  id: true,
                  episodeNumber: true,
                  title: true,
                },
                orderBy: { episodeNumber: "asc" },
              },
            },
            orderBy: { seasonNumber: "asc" },
          },
        },
        orderBy: { title: "asc" },
      });

      return {
        shows: shows.map((show) => ({
          ...serializeShow(show, {
            seasonCount: show.seasons.length,
            episodeCount: show.seasons.reduce(
              (sum, season) => sum + season._count.episodes,
              0,
            ),
          }),
          seasons: show.seasons.map((season) => ({
            id: season.id,
            seasonNumber: season.seasonNumber,
            title: season.title,
            description: season.description ?? "",
            hasPoster: Boolean(season.posterPath),
            hasDescription: Boolean(season.description?.trim()),
            episodeCount: season._count.episodes,
            maxEpisodeNumber: season.episodes.reduce(
              (max, episode) => Math.max(max, episode.episodeNumber),
              0,
            ),
            episodes: season.episodes,
          })),
        })),
      };
    },
  );

  app.post(
    "/v1/admin/shows",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        title?: string;
        year?: number;
        seasonNumber?: number;
        seasonDescription?: string;
      };
      const title = body.title?.trim();
      if (!title) {
        return reply.code(400).send({
          error: "missing_title",
          message: "Show title is required.",
        });
      }
      const year =
        body.year !== undefined && body.year !== null ? Number(body.year) : undefined;
      if (
        year !== undefined &&
        (!Number.isInteger(year) || year < 1800 || year > 2100)
      ) {
        return reply.code(400).send({
          error: "invalid_year",
          message: "Year must be a valid integer.",
        });
      }
      const seasonNumber =
        body.seasonNumber !== undefined ? Number(body.seasonNumber) : 1;
      if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
        return reply.code(400).send({
          error: "invalid_season",
          message: "Season must be an integer >= 0.",
        });
      }
      const seasonDescription = body.seasonDescription?.trim() ?? "";

      let show = await app.prisma.show.findFirst({ where: { title } });
      if (!show) {
        show = await app.prisma.show.create({
          data: {
            id: createId("s"),
            title,
            description: "",
            year: year ?? null,
            ready: false,
          },
        });
      } else if (year !== undefined && show.year == null) {
        show = await app.prisma.show.update({
          where: { id: show.id },
          data: { year },
        });
      }

      let season = await app.prisma.season.findUnique({
        where: {
          showId_seasonNumber: {
            showId: show.id,
            seasonNumber,
          },
        },
      });
      if (!season) {
        season = await app.prisma.season.create({
          data: {
            id: createId("sn"),
            showId: show.id,
            seasonNumber,
            title: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
            description: seasonDescription,
          },
        });
      } else if (seasonDescription && !season.description) {
        season = await app.prisma.season.update({
          where: { id: season.id },
          data: { description: seasonDescription },
        });
      }

      return {
        show: serializeShow(show, { seasonCount: 1, episodeCount: 0 }),
        season: {
          id: season.id,
          seasonNumber: season.seasonNumber,
          title: season.title,
          description: season.description,
        },
      };
    },
  );

  app.post(
    "/v1/admin/movies",
    {
      onRequest: [app.requireOwner],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { fields, video, thumbnail } = await readVideoAndThumbnail(
        request,
        app.mediaRoot,
      );

      const cleanup = async () => {
        if (video) await unlink(video.path).catch(() => undefined);
        if (thumbnail) await unlink(thumbnail.path).catch(() => undefined);
      };

      if (!video) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_file",
          message: "Choose a video file to upload.",
        });
      }

      const ext = path.extname(video.filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        await cleanup();
        return reply.code(400).send({
          error: "unsupported_type",
          message: `Unsupported file type ${ext || "(none)"}. Use mp4, mkv, mov, etc.`,
        });
      }

      if (!thumbnail) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_thumbnail",
          message: "A thumbnail image is required for each movie.",
        });
      }
      if (!isImageFilename(thumbnail.filename)) {
        await cleanup();
        return reply.code(400).send({
          error: "invalid_thumbnail",
          message: "Thumbnail must be a JPG, PNG, or WebP image.",
        });
      }

      const title = fields.title || path.parse(video.filename).name;
      const yearRaw = fields.year;
      const description = fields.description ?? "";
      const year = yearRaw ? Number(yearRaw) : undefined;
      if (yearRaw && (!Number.isInteger(year) || year! < 1800 || year! > 2100)) {
        await cleanup();
        return reply.code(400).send({
          error: "invalid_year",
          message: "Year must be a valid integer.",
        });
      }

      const savedPath = video.path;
      const thumbPath = thumbnail.path;

      const job = enqueueAdminJob({
        kind: "movie",
        title,
        detail: path.basename(savedPath),
        run: async (signal) => {
          try {
            const result = await addMovie({
              sourcePath: savedPath,
              title,
              description,
              posterSourcePath: thumbPath,
              signal,
              ...(year !== undefined ? { year } : {}),
            });
            return {
              movieId: result.movie.id,
              title: result.movie.title,
              ready: result.movie.ready,
              ladder: result.ladder,
            };
          } finally {
            await unlink(savedPath).catch(() => undefined);
            await unlink(thumbPath).catch(() => undefined);
          }
        },
      });

      return reply.code(202).send({ job });
    },
  );

  app.post(
    "/v1/admin/episodes",
    {
      onRequest: [app.requireOwner],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const { fields, video, thumbnail } = await readVideoAndThumbnail(
        request,
        app.mediaRoot,
      );

      const cleanup = async () => {
        if (video) await unlink(video.path).catch(() => undefined);
        if (thumbnail) await unlink(thumbnail.path).catch(() => undefined);
      };

      if (!video) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_file",
          message: "Choose a video file to upload.",
        });
      }

      const ext = path.extname(video.filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        await cleanup();
        return reply.code(400).send({
          error: "unsupported_type",
          message: `Unsupported file type ${ext || "(none)"}. Use mp4, mkv, mov, etc.`,
        });
      }

      if (thumbnail && !isImageFilename(thumbnail.filename)) {
        await cleanup();
        return reply.code(400).send({
          error: "invalid_thumbnail",
          message: "Season thumbnail must be a JPG, PNG, or WebP image.",
        });
      }

      const showIdField = fields.showId;
      let showTitle = fields.showTitle;
      const yearRaw = fields.showYear;
      const showYear = yearRaw ? Number(yearRaw) : undefined;
      if (yearRaw && (!Number.isInteger(showYear) || showYear! < 1800)) {
        await cleanup();
        return reply.code(400).send({
          error: "invalid_year",
          message: "Show year must be a valid integer.",
        });
      }

      let resolvedShowId: string;
      if (showIdField) {
        const existing = await app.prisma.show.findUnique({
          where: { id: showIdField },
        });
        if (!existing) {
          await cleanup();
          return reply.code(404).send({
            error: "show_not_found",
            message: "That series was not found.",
          });
        }
        showTitle = existing.title;
        resolvedShowId = existing.id;
      } else if (!showTitle) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_show",
          message: "Pick an existing series or enter a new show title.",
        });
      } else {
        let show = await app.prisma.show.findFirst({
          where: { title: showTitle },
        });
        if (!show) {
          show = await app.prisma.show.create({
            data: {
              id: createId("s"),
              title: showTitle,
              description: "",
              year: showYear ?? null,
              ready: false,
            },
          });
        } else if (showYear !== undefined && show.year == null) {
          show = await app.prisma.show.update({
            where: { id: show.id },
            data: { year: showYear },
          });
        }
        resolvedShowId = show.id;
        showTitle = show.title;
      }

      const parsed = parseSeasonEpisode(video.filename);
      const seasonRaw = fields.seasonNumber;
      const episodeRaw = fields.episodeNumber;
      const seasonNumber = seasonRaw
        ? Number(seasonRaw)
        : (parsed?.seasonNumber ?? undefined);
      const episodeNumber = episodeRaw
        ? Number(episodeRaw)
        : (parsed?.episodeNumber ?? undefined);

      if (
        seasonNumber === undefined ||
        episodeNumber === undefined ||
        !Number.isInteger(seasonNumber) ||
        !Number.isInteger(episodeNumber) ||
        seasonNumber < 0 ||
        episodeNumber < 1
      ) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_numbers",
          message:
            "Provide season and episode numbers, or use an S01E01-style filename.",
        });
      }

      const seasonDescription = fields.seasonDescription?.trim() ?? "";
      let season = await app.prisma.season.findUnique({
        where: {
          showId_seasonNumber: {
            showId: resolvedShowId,
            seasonNumber,
          },
        },
      });

      const isNewSeason = !season;
      if (isNewSeason && !thumbnail) {
        await cleanup();
        return reply.code(400).send({
          error: "missing_thumbnail",
          message: "A season thumbnail is required when creating a new season.",
        });
      }

      if (!season) {
        season = await app.prisma.season.create({
          data: {
            id: createId("sn"),
            showId: resolvedShowId,
            seasonNumber,
            title: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
            description: seasonDescription,
          },
        });
      } else if (seasonDescription) {
        season = await app.prisma.season.update({
          where: { id: season.id },
          data: { description: seasonDescription },
        });
      }

      if (thumbnail) {
        const relative = await installPosterFile({
          mediaRoot: app.mediaRoot,
          sourcePath: thumbnail.path,
          relativePath: seasonPosterRelativePath(season.id),
        });
        season = await app.prisma.season.update({
          where: { id: season.id },
          data: { posterPath: relative },
        });

        const show = await app.prisma.show.findUnique({
          where: { id: resolvedShowId },
        });
        if (show && !show.posterPath) {
          const destRelative = showPosterRelativePath(show.id);
          const destAbsolute = path.join(app.mediaRoot, destRelative);
          await mkdir(path.dirname(destAbsolute), { recursive: true });
          await copyFile(path.join(app.mediaRoot, relative), destAbsolute);
          await app.prisma.show.update({
            where: { id: show.id },
            data: { posterPath: destRelative },
          });
        }
      }

      const episodeTitle = fields.episodeTitle;
      const description = fields.description ?? "";
      const savedPath = video.path;
      const thumbPath = thumbnail?.path;

      const job = enqueueAdminJob({
        kind: "episode",
        title: `${showTitle} · S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`,
        detail: path.basename(savedPath),
        run: async (signal) => {
          try {
            const result = await addEpisode({
              sourcePath: savedPath,
              showTitle: showTitle!,
              showId: resolvedShowId,
              seasonNumber,
              episodeNumber,
              description,
              signal,
              ...(seasonDescription ? { seasonDescription } : {}),
              ...(thumbPath ? { seasonPosterSourcePath: thumbPath } : {}),
              ...(episodeTitle ? { episodeTitle } : {}),
              ...(showYear !== undefined ? { showYear } : {}),
            });
            return {
              showId: result.show.id,
              showTitle: result.show.title,
              episodeId: result.episode.id,
              episodeTitle: result.episode.title,
              seasonNumber: result.season.seasonNumber,
              episodeNumber: result.episode.episodeNumber,
              ready: result.episode.ready,
              ladder: result.ladder,
            };
          } finally {
            await unlink(savedPath).catch(() => undefined);
            if (thumbPath) await unlink(thumbPath).catch(() => undefined);
          }
        },
      });

      return reply.code(202).send({
        job,
        showId: resolvedShowId,
        showTitle,
        seasonNumber,
      });
    },
  );

  app.post(
    "/v1/admin/library/movies/:id/publish-r2",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const movie = await app.prisma.movie.findUnique({ where: { id } });
      if (!movie) {
        return reply.code(404).send({ error: "not_found", message: "Movie not found." });
      }
      if (!movie.ready) {
        return reply.code(400).send({
          error: "not_ready",
          message: "Encode this movie first, then reupload to CDN.",
        });
      }

      const job = enqueueAdminJob({
        kind: "publish",
        title: movie.title,
        detail: `CDN reupload · movie`,
        run: async (signal) => {
          const result = await publishLocalPackageToR2({
            config: app.config,
            mediaRoot: app.mediaRoot,
            kind: "movies",
            id: movie.id,
            signal,
          });
          return { movieId: movie.id, ...result };
        },
      });

      return reply.code(202).send({ job });
    },
  );

  app.post(
    "/v1/admin/library/episodes/:id/publish-r2",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const episode = await app.prisma.episode.findUnique({ where: { id } });
      if (!episode) {
        return reply.code(404).send({ error: "not_found", message: "Episode not found." });
      }
      if (!episode.ready) {
        return reply.code(400).send({
          error: "not_ready",
          message: "Encode this episode first, then reupload to CDN.",
        });
      }

      const job = enqueueAdminJob({
        kind: "publish",
        title: episode.title,
        detail: `CDN reupload · episode`,
        run: async (signal) => {
          const result = await publishLocalPackageToR2({
            config: app.config,
            mediaRoot: app.mediaRoot,
            kind: "episodes",
            id: episode.id,
            signal,
          });
          return { episodeId: episode.id, ...result };
        },
      });

      return reply.code(202).send({ job });
    },
  );

  app.post(
    "/v1/admin/library/seasons/:id/publish-r2",
    { onRequest: [app.requireOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const season = await app.prisma.season.findUnique({
        where: { id },
        include: {
          show: { select: { title: true } },
          episodes: { where: { ready: true }, select: { id: true, title: true, episodeNumber: true } },
        },
      });
      if (!season) {
        return reply.code(404).send({ error: "not_found", message: "Season not found." });
      }
      if (season.episodes.length === 0) {
        return reply.code(400).send({
          error: "empty",
          message: "No ready episodes in this season to upload.",
        });
      }

      const jobs = season.episodes.map((ep) =>
        enqueueAdminJob({
          kind: "publish",
          title: ep.title,
          detail: `CDN reupload · S${String(season.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
          run: async (signal) => {
            const result = await publishLocalPackageToR2({
              config: app.config,
              mediaRoot: app.mediaRoot,
              kind: "episodes",
              id: ep.id,
              signal,
            });
            return { episodeId: ep.id, ...result };
          },
        }),
      );

      if (season.posterPath) {
        jobs.push(
          enqueueAdminJob({
            kind: "publish",
            title: season.show.title,
            detail: `CDN reupload · season poster`,
            run: async (signal) => {
              const result = await publishLocalPackageToR2({
                config: app.config,
                mediaRoot: app.mediaRoot,
                kind: "seasons",
                id: season.id,
                signal,
              });
              return { seasonId: season.id, ...result };
            },
          }),
        );
      }

      return reply.code(202).send({
        jobs,
        queued: jobs.length,
        showTitle: season.show.title,
        seasonNumber: season.seasonNumber,
      });
    },
  );
};

export default adminRoutes;