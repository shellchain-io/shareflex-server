import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  errorSchema,
  movieDetailSchema,
  movieSummarySchema,
  playbackSchema,
} from "../schemas/api.js";
import { serializeMovie, serializeSubtitles, toPublicMediaUrl } from "../lib/movies.js";

const movieIdParams = z.object({
  movieId: z.string().min(1),
});

const movieRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/movies",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({
            movies: z.array(movieSummarySchema),
          }),
          401: errorSchema,
        },
      },
    },
    async () => {
      const movies = await app.prisma.movie.findMany({
        where: { ready: true },
        orderBy: { title: "asc" },
      });
      return { movies: movies.map(serializeMovie) };
    },
  );

  app.get(
    "/v1/movies/:movieId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        response: {
          200: movieDetailSchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const movie = await app.prisma.movie.findUnique({
        where: { id: request.params.movieId },
        include: { subtitles: true },
      });
      if (!movie || !movie.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Movie not found.",
        });
      }

      const progress = await app.prisma.playbackProgress.findUnique({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: movie.id,
          },
        },
      });

      return {
        ...serializeMovie(movie),
        subtitles: serializeSubtitles(movie.subtitles),
        percentComplete: progress?.percentComplete ?? 0,
        completed: progress?.completed ?? false,
        positionSeconds: progress?.positionSeconds ?? 0,
      };
    },
  );

  app.get(
    "/v1/movies/:movieId/playback",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        response: {
          200: playbackSchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const movie = await app.prisma.movie.findUnique({
        where: { id: request.params.movieId },
        include: {
          assets: true,
          subtitles: true,
        },
      });

      if (!movie || !movie.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Movie not available for playback.",
        });
      }

      const master = movie.assets.find((asset) => asset.kind === "master");
      if (!master) {
        return reply.code(404).send({
          error: "not_ready",
          message: "Movie HLS master playlist is missing.",
        });
      }

      const progress = await app.prisma.playbackProgress.findUnique({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: movie.id,
          },
        },
      });

      return {
        kind: "movie" as const,
        movieId: movie.id,
        episodeId: null,
        title: movie.title,
        contentVersion: movie.contentVersion,
        hlsUrl: toPublicMediaUrl("hls", movie.id),
        posterUrl: movie.posterPath ? toPublicMediaUrl("poster", movie.id) : null,
        subtitles: movie.subtitles.map((track) => ({
          id: track.id,
          language: track.language,
          label: track.label,
          url: toPublicMediaUrl("subtitle", movie.id, track.id),
        })),
        resumePositionSeconds:
          progress && !progress.completed ? progress.positionSeconds : null,
        showTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        showId: null,
        episodeTitle: null,
        nextEpisodeId: null,
        nextActionLabel: null,
      };
    },
  );
};

export default movieRoutes;
