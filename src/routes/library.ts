import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  errorSchema,
  favoriteSchema,
  historyItemSchema,
  showFavoriteSchema,
} from "../schemas/api.js";
import { serializeMovie } from "../lib/movies.js";
import { serializeShow, countSeasonsWithEpisodes } from "../lib/shows.js";

const movieIdParams = z.object({
  movieId: z.string().min(1),
});

const showIdParams = z.object({
  showId: z.string().min(1),
});

const libraryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/favorites",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ items: z.array(favoriteSchema) }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const items = await app.prisma.favorite.findMany({
        where: { userId: request.user.sub },
        include: { movie: true },
        orderBy: { createdAt: "desc" },
      });
      return {
        items: items
          .filter((item) => item.movie.ready)
          .map((item) => ({
            movieId: item.movieId,
            createdAt: item.createdAt.toISOString(),
            movie: serializeMovie(item.movie),
          })),
      };
    },
  );

  app.post(
    "/v1/favorites/:movieId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        response: {
          200: favoriteSchema,
          401: errorSchema,
          404: errorSchema,
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

      const favorite = await app.prisma.favorite.upsert({
        where: {
          userId_movieId: {
            userId: request.user.sub,
            movieId: movie.id,
          },
        },
        create: {
          userId: request.user.sub,
          movieId: movie.id,
        },
        update: {},
        include: { movie: true },
      });

      return {
        movieId: favorite.movieId,
        createdAt: favorite.createdAt.toISOString(),
        movie: serializeMovie(favorite.movie),
      };
    },
  );

  app.delete(
    "/v1/favorites/:movieId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: movieIdParams,
        response: {
          204: z.undefined(),
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      await app.prisma.favorite.deleteMany({
        where: {
          userId: request.user.sub,
          movieId: request.params.movieId,
        },
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/show-favorites",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ items: z.array(showFavoriteSchema) }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const items = await app.prisma.showFavorite.findMany({
        where: { userId: request.user.sub },
        include: {
          show: {
            include: {
              seasons: {
                include: {
                  _count: {
                    select: { episodes: { where: { ready: true } } },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return {
        items: items
          .filter((item) => item.show.ready)
          .map((item) => ({
            showId: item.showId,
            createdAt: item.createdAt.toISOString(),
            show: serializeShow(
              item.show,
              countSeasonsWithEpisodes(item.show.seasons),
            ),
          })),
      };
    },
  );

  app.post(
    "/v1/show-favorites/:showId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: showIdParams,
        response: {
          200: showFavoriteSchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const show = await app.prisma.show.findUnique({
        where: { id: request.params.showId },
        include: {
          seasons: {
            include: {
              _count: {
                select: { episodes: { where: { ready: true } } },
              },
            },
          },
        },
      });
      if (!show || !show.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Show not found.",
        });
      }

      const favorite = await app.prisma.showFavorite.upsert({
        where: {
          userId_showId: {
            userId: request.user.sub,
            showId: show.id,
          },
        },
        create: {
          userId: request.user.sub,
          showId: show.id,
        },
        update: {},
      });

      return {
        showId: favorite.showId,
        createdAt: favorite.createdAt.toISOString(),
        show: serializeShow(show, countSeasonsWithEpisodes(show.seasons)),
      };
    },
  );

  app.delete(
    "/v1/show-favorites/:showId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: showIdParams,
        response: {
          204: z.undefined(),
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      await app.prisma.showFavorite.deleteMany({
        where: {
          userId: request.user.sub,
          showId: request.params.showId,
        },
      });
      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/history",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({ items: z.array(historyItemSchema) }),
          401: errorSchema,
        },
      },
    },
    async (request) => {
      const items = await app.prisma.watchHistory.findMany({
        where: { userId: request.user.sub },
        include: { movie: true },
        orderBy: { watchedAt: "desc" },
        take: 50,
      });
      return {
        items: items
          .filter((item) => item.movie.ready)
          .map((item) => ({
            id: item.id,
            movieId: item.movieId,
            watchedAt: item.watchedAt.toISOString(),
            movie: serializeMovie(item.movie),
          })),
      };
    },
  );
};

export default libraryRoutes;
