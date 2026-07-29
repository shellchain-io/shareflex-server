import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  episodeSummarySchema,
  errorSchema,
  playbackSchema,
  showDetailSchema,
  showSummarySchema,
} from "../schemas/api.js";
import { toPublicSeasonPosterUrl } from "../lib/posters.js";
import {
  episodeLabel,
  serializeEpisode,
  serializeEpisodeSubtitles,
  serializeShow,
  countSeasonsWithEpisodes,
  toPublicEpisodeMediaUrl,
  toPublicShowPosterUrl,
} from "../lib/shows.js";

const showIdParams = z.object({
  showId: z.string().min(1),
});

const episodeIdParams = z.object({
  episodeId: z.string().min(1),
});

const showRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/v1/shows",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: z.object({
            shows: z.array(showSummarySchema),
          }),
          401: errorSchema,
        },
      },
    },
    async () => {
      const shows = await app.prisma.show.findMany({
        where: { ready: true },
        include: {
          seasons: {
            orderBy: { seasonNumber: "asc" },
            include: {
              _count: {
                select: { episodes: { where: { ready: true } } },
              },
            },
          },
        },
        orderBy: { title: "asc" },
      });

      return {
        shows: shows.map((show) => {
          const counts = countSeasonsWithEpisodes(show.seasons);
          const firstSeasonPoster = show.seasons.find(
            (season) => season._count.episodes > 0 && season.posterPath,
          );
          const listPosterUrl = firstSeasonPoster
            ? toPublicSeasonPosterUrl(firstSeasonPoster.id)
            : show.posterPath
              ? toPublicShowPosterUrl(show.id)
              : null;
          return {
            ...serializeShow(show, counts),
            posterUrl: listPosterUrl,
          };
        }),
      };
    },
  );

  app.get(
    "/v1/shows/:showId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: showIdParams,
        response: {
          200: showDetailSchema,
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
            orderBy: { seasonNumber: "asc" },
            include: {
              episodes: {
                where: { ready: true },
                orderBy: { episodeNumber: "asc" },
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

      const allEpisodeIds = show.seasons.flatMap((season) =>
        season.episodes.map((episode) => episode.id),
      );
      const progressRows =
        allEpisodeIds.length === 0
          ? []
          : await app.prisma.episodePlaybackProgress.findMany({
              where: {
                userId: request.user.sub,
                episodeId: { in: allEpisodeIds },
              },
            });
      const progressByEpisode = new Map(
        progressRows.map((row) => [row.episodeId, row]),
      );

      const seasons = show.seasons
        .filter((season) => season.episodes.length > 0)
        .map((season) => ({
          id: season.id,
          seasonNumber: season.seasonNumber,
          title: season.title || `Season ${season.seasonNumber}`,
          description: season.description ?? "",
          posterUrl: season.posterPath
            ? toPublicSeasonPosterUrl(season.id)
            : null,
          episodes: season.episodes.map((episode) => {
            const progress = progressByEpisode.get(episode.id);
            return serializeEpisode(episode, {
              showId: show.id,
              showTitle: show.title,
              seasonId: season.id,
              seasonNumber: season.seasonNumber,
              ...(progress
                ? {
                    percentComplete: progress.percentComplete,
                    completed: progress.completed,
                    positionSeconds: progress.positionSeconds,
                    lastWatchedAt: progress.lastWatchedAt.toISOString(),
                  }
                : {
                    percentComplete: 0,
                    completed: false,
                    positionSeconds: 0,
                  }),
            });
          }),
        }));

      const episodeCount = seasons.reduce(
        (sum, season) => sum + season.episodes.length,
        0,
      );

      return {
        ...serializeShow(show, {
          seasonCount: seasons.length,
          episodeCount,
        }),
        seasons,
      };
    },
  );

  app.get(
    "/v1/episodes/:episodeId",
    {
      onRequest: [app.authenticate],
      schema: {
        params: episodeIdParams,
        response: {
          200: episodeSummarySchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const episode = await app.prisma.episode.findUnique({
        where: { id: request.params.episodeId },
        include: {
          season: {
            include: { show: true },
          },
        },
      });

      if (!episode || !episode.ready || !episode.season.show.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Episode not found.",
        });
      }

      return serializeEpisode(episode, {
        showId: episode.season.show.id,
        showTitle: episode.season.show.title,
        seasonId: episode.season.id,
        seasonNumber: episode.season.seasonNumber,
      });
    },
  );

  app.get(
    "/v1/episodes/:episodeId/playback",
    {
      onRequest: [app.authenticate],
      schema: {
        params: episodeIdParams,
        response: {
          200: playbackSchema,
          401: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const episode = await app.prisma.episode.findUnique({
        where: { id: request.params.episodeId },
        include: {
          assets: true,
          subtitles: true,
          season: { include: { show: true } },
        },
      });

      if (!episode || !episode.ready) {
        return reply.code(404).send({
          error: "not_found",
          message: "Episode not available for playback.",
        });
      }

      const master = episode.assets.find((asset) => asset.kind === "master");
      if (!master) {
        return reply.code(404).send({
          error: "not_ready",
          message: "Episode HLS master playlist is missing.",
        });
      }

      const progress = await app.prisma.episodePlaybackProgress.findUnique({
        where: {
          userId_episodeId: {
            userId: request.user.sub,
            episodeId: episode.id,
          },
        },
      });

      const show = episode.season.show;
      const label = episodeLabel(
        episode.season.seasonNumber,
        episode.episodeNumber,
      );

      // Next: same season next ep, else first ep of next season.
      const nextInSeason = await app.prisma.episode.findFirst({
        where: {
          seasonId: episode.seasonId,
          episodeNumber: { gt: episode.episodeNumber },
          ready: true,
        },
        orderBy: { episodeNumber: "asc" },
        include: { season: true },
      });

      let nextEpisodeId: string | null = null;
      let nextActionLabel: string | null = null;

      if (nextInSeason) {
        nextEpisodeId = nextInSeason.id;
        nextActionLabel = `Next ${episodeLabel(
          nextInSeason.season.seasonNumber,
          nextInSeason.episodeNumber,
        )}`;
      } else {
        const nextSeason = await app.prisma.season.findFirst({
          where: {
            showId: show.id,
            seasonNumber: { gt: episode.season.seasonNumber },
          },
          orderBy: { seasonNumber: "asc" },
          include: {
            episodes: {
              where: { ready: true },
              orderBy: { episodeNumber: "asc" },
              take: 1,
            },
          },
        });
        const firstOfNext = nextSeason?.episodes[0];
        if (firstOfNext && nextSeason) {
          nextEpisodeId = firstOfNext.id;
          nextActionLabel = `Start Season ${nextSeason.seasonNumber}`;
        }
      }

      return {
        kind: "episode" as const,
        movieId: null,
        episodeId: episode.id,
        title: `${show.title} · ${label} · ${episode.title}`,
        contentVersion: episode.contentVersion,
        hlsUrl: toPublicEpisodeMediaUrl("hls", episode.id),
        posterUrl: show.posterPath
          ? toPublicShowPosterUrl(show.id)
          : episode.posterPath
            ? toPublicEpisodeMediaUrl("poster", episode.id)
            : null,
        subtitles: episode.subtitles.map((track) => ({
          id: track.id,
          language: track.language,
          label: track.label,
          url: toPublicEpisodeMediaUrl("subtitle", episode.id, track.id),
        })),
        resumePositionSeconds:
          progress && !progress.completed ? progress.positionSeconds : null,
        showId: show.id,
        showTitle: show.title,
        seasonNumber: episode.season.seasonNumber,
        episodeNumber: episode.episodeNumber,
        episodeTitle: episode.title,
        nextEpisodeId,
        nextActionLabel,
      };
    },
  );
};

export default showRoutes;
