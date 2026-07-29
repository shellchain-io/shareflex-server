import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  continueWatchingItemSchema,
  episodeProgressSchema,
  errorSchema,
  progressSchema,
  putProgressBodySchema,
} from "../schemas/api.js";
import { serializeMovie } from "../lib/movies.js";
import {
  toPublicEpisodeMediaUrl,
  toPublicShowPosterUrl,
} from "../lib/shows.js";
import { toPublicSeasonPosterUrl } from "../lib/posters.js";
import { COMPLETION_THRESHOLD, MIN_PROGRESS_SECONDS } from "../lib/security.js";

const movieIdParams = z.object({
  movieId: z.string().min(1),
});

const episodeIdParams = z.object({
  episodeId: z.string().min(1),
});

function computePercent(positionSeconds: number, durationSeconds: number): number {
  if (durationSeconds <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (positionSeconds / durationSeconds) * 100));
}

function progressBodyError(body: {
  positionSeconds: number;
  durationSeconds: number;
  completed?: boolean | undefined;
}): { error: string; message: string } | null {
  const { positionSeconds, durationSeconds, completed } = body;

  if (
    !Number.isFinite(positionSeconds) ||
    !Number.isFinite(durationSeconds) ||
    positionSeconds < 0 ||
    durationSeconds <= 0 ||
    positionSeconds > durationSeconds + 1
  ) {
    return {
      error: "invalid_progress",
      message: "Progress values are invalid.",
    };
  }

  if (positionSeconds < MIN_PROGRESS_SECONDS && completed !== true) {
    return {
      error: "ignored_short_playback",
      message: `Progress under ${MIN_PROGRESS_SECONDS}s is ignored.`,
    };
  }

  return null;
}

const progressRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/progress",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ items: z.array(progressSchema) }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const items = await app.prisma.playbackProgress.findMany({
        where: { userId: request.user.sub },
        orderBy: { lastWatchedAt: "desc" },
      });
      return {
        items: items.map((item) => ({
          movieId: item.movieId,
          positionSeconds: item.positionSeconds,
          durationSeconds: item.durationSeconds,
          percentComplete: item.percentComplete,
          completed: item.completed,
          lastWatchedAt: item.lastWatchedAt.toISOString(),
          revision: item.revision,
        })),
      };
    },
  );

  app.get(
    "/v1/progress/:movieId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        response: {
          200: progressSchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const item = await app.prisma.playbackProgress.findUnique({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: request.params.movieId,
          },
        },
      });
      if (!item) {
        return reply.code(404).send({
          error: "not_found",
          message: "No progress for this movie.",
        });
      }
      return {
        movieId: item.movieId,
        positionSeconds: item.positionSeconds,
        durationSeconds: item.durationSeconds,
        percentComplete: item.percentComplete,
        completed: item.completed,
        lastWatchedAt: item.lastWatchedAt.toISOString(),
        revision: item.revision,
      };
    },
  );

  app.put(
    "/v1/progress/:movieId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        body: putProgressBodySchema,
        response: {
          200: progressSchema,
          400: errorSchema,
          401: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const movie = await app.prisma.movie.findUnique({
        where: { id: request.params.movieId },
      });
      if (!movie || !movie.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Movie not found.",
        });
      }

      const bodyError = progressBodyError(request.body);
      if (bodyError) {
        return reply.code(400).send(bodyError);
      }

      const { positionSeconds, durationSeconds, revision, completed } = request.body;

      const existing = await app.prisma.playbackProgress.findUnique({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: movie.id,
          },
        },
      });

      if (existing && revision !== undefined && revision < existing.revision) {
        return reply.code(409).send({
          error: "stale_revision",
          message: "Older progress update rejected.",
        });
      }

      const percentComplete = computePercent(positionSeconds, durationSeconds);
      const isCompleted =
        completed ?? percentComplete / 100 >= COMPLETION_THRESHOLD;

      const nextRevision = existing ? existing.revision + 1 : 1;
      const saved = await app.prisma.playbackProgress.upsert({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: movie.id,
          },
        },
        create: {
          userId: request.user.sub,
          movieId: movie.id,
          positionSeconds: isCompleted ? durationSeconds : positionSeconds,
          durationSeconds,
          percentComplete: isCompleted ? 100 : percentComplete,
          completed: isCompleted,
          revision: nextRevision,
          lastWatchedAt: new Date(),
        },
        update: {
          positionSeconds: isCompleted ? durationSeconds : positionSeconds,
          durationSeconds,
          percentComplete: isCompleted ? 100 : percentComplete,
          completed: isCompleted,
          revision: nextRevision,
          lastWatchedAt: new Date(),
        },
      });

      await app.prisma.watchHistory.create({
        data: {
          userId: request.user.sub,
          movieId: movie.id,
        },
      });

      return {
        movieId: saved.movieId,
        positionSeconds: saved.positionSeconds,
        durationSeconds: saved.durationSeconds,
        percentComplete: saved.percentComplete,
        completed: saved.completed,
        lastWatchedAt: saved.lastWatchedAt.toISOString(),
        revision: saved.revision,
      };
    },
  );

  app.put(
    "/v1/episodes/:episodeId/progress",
    {
      onRequest: [app.authenticate],
      schema: {
        params: episodeIdParams,
        body: putProgressBodySchema,
        response: {
          200: episodeProgressSchema,
          400: errorSchema,
          401: errorSchema,
          404: errorSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const episode = await app.prisma.episode.findUnique({
        where: { id: request.params.episodeId },
      });
      if (!episode || !episode.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Episode not found.",
        });
      }

      const bodyError = progressBodyError(request.body);
      if (bodyError) {
        return reply.code(400).send(bodyError);
      }

      const { positionSeconds, durationSeconds, revision, completed } = request.body;

      const existing = await app.prisma.episodePlaybackProgress.findUnique({
        where: {
          userId_episodeId: {
            userId: request.user.sub,
            episodeId: episode.id,
          },
        },
      });

      if (existing && revision !== undefined && revision < existing.revision) {
        return reply.code(409).send({
          error: "stale_revision",
          message: "Older progress update rejected.",
        });
      }

      const percentComplete = computePercent(positionSeconds, durationSeconds);
      const isCompleted =
        completed ?? percentComplete / 100 >= COMPLETION_THRESHOLD;

      const nextRevision = existing ? existing.revision + 1 : 1;
      const saved = await app.prisma.episodePlaybackProgress.upsert({
        where: {
          userId_episodeId: {
            userId: request.user.sub,
            episodeId: episode.id,
          },
        },
        create: {
          userId: request.user.sub,
          episodeId: episode.id,
          positionSeconds: isCompleted ? durationSeconds : positionSeconds,
          durationSeconds,
          percentComplete: isCompleted ? 100 : percentComplete,
          completed: isCompleted,
          revision: nextRevision,
          lastWatchedAt: new Date(),
        },
        update: {
          positionSeconds: isCompleted ? durationSeconds : positionSeconds,
          durationSeconds,
          percentComplete: isCompleted ? 100 : percentComplete,
          completed: isCompleted,
          revision: nextRevision,
          lastWatchedAt: new Date(),
        },
      });

      await app.prisma.episodeWatchHistory.create({
        data: {
          userId: request.user.sub,
          episodeId: episode.id,
        },
      });

      return {
        episodeId: saved.episodeId,
        positionSeconds: saved.positionSeconds,
        durationSeconds: saved.durationSeconds,
        percentComplete: saved.percentComplete,
        completed: saved.completed,
        lastWatchedAt: saved.lastWatchedAt.toISOString(),
        revision: saved.revision,
      };
    },
  );

  app.get(
    "/v1/continue-watching",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ items: z.array(continueWatchingItemSchema) }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const [movieItems, episodeItems] = await Promise.all([
        app.prisma.playbackProgress.findMany({
          where: {
            userId: request.user.sub,
            completed: false,
            percentComplete: { gt: 0 },
          },
          include: { movie: true },
          orderBy: { lastWatchedAt: "desc" },
          take: 20,
        }),
        app.prisma.episodePlaybackProgress.findMany({
          where: {
            userId: request.user.sub,
            completed: false,
            percentComplete: { gt: 0 },
          },
          include: {
            episode: {
              include: {
                season: { include: { show: true } },
              },
            },
          },
          orderBy: { lastWatchedAt: "desc" },
          take: 20,
        }),
      ]);

      const movies = movieItems
        .filter((item) => item.movie.ready)
        .map((item) => ({
          kind: "movie" as const,
          movieId: item.movieId,
          positionSeconds: item.positionSeconds,
          durationSeconds: item.durationSeconds,
          percentComplete: item.percentComplete,
          completed: item.completed,
          lastWatchedAt: item.lastWatchedAt.toISOString(),
          revision: item.revision,
          movie: serializeMovie(item.movie),
          sortAt: item.lastWatchedAt.getTime(),
        }));

      const episodes = episodeItems
        .filter((item) => item.episode.ready && item.episode.season.show.ready)
        .map((item) => {
          const show = item.episode.season.show;
          const season = item.episode.season;
          const posterUrl = season.posterPath
            ? toPublicSeasonPosterUrl(season.id)
            : show.posterPath
              ? toPublicShowPosterUrl(show.id)
              : item.episode.posterPath
                ? toPublicEpisodeMediaUrl("poster", item.episode.id)
                : null;
          return {
            kind: "episode" as const,
            episodeId: item.episodeId,
            showId: show.id,
            showTitle: show.title,
            seasonNumber: item.episode.season.seasonNumber,
            episodeNumber: item.episode.episodeNumber,
            title: item.episode.title,
            positionSeconds: item.positionSeconds,
            durationSeconds: item.durationSeconds,
            percentComplete: item.percentComplete,
            completed: item.completed,
            lastWatchedAt: item.lastWatchedAt.toISOString(),
            revision: item.revision,
            posterUrl,
            sortAt: item.lastWatchedAt.getTime(),
          };
        });

      // One continue card per series (most recently watched incomplete episode).
      const seenShows = new Set<string>();
      const episodesDeduped = episodes.filter((item) => {
        if (seenShows.has(item.showId)) {
          return false;
        }
        seenShows.add(item.showId);
        return true;
      });

      const merged = [...movies, ...episodesDeduped]
        .sort((a, b) => b.sortAt - a.sortAt)
        .slice(0, 20)
        .map(({ sortAt: _sortAt, ...item }) => item);

      return { items: merged };
    },
  );
};

export default progressRoutes;
