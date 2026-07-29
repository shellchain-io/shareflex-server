import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  deviceName: z.string().min(1).max(120).optional(),
  platform: z.enum(["ios", "macos", "unknown"]).default("unknown"),
});

export const registerBodySchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(80),
  deviceName: z.string().min(1).max(120).optional(),
  platform: z.enum(["ios", "macos", "unknown"]).default("unknown"),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(20).max(500),
});

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(20).max(500).optional(),
});

export const userPublicSchema = z.object({
  id: z.string(),
  email: z.email(),
  displayName: z.string(),
  role: z.string(),
});

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.string(),
  user: userPublicSchema,
});

export const movieSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  year: z.number().int().nullable(),
  runtimeSeconds: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  contentVersion: z.string(),
  ready: z.boolean(),
});

export const showSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  year: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  contentVersion: z.string(),
  ready: z.boolean(),
  seasonCount: z.number().int().nonnegative(),
  episodeCount: z.number().int().nonnegative(),
});

export const episodeSummarySchema = z.object({
  id: z.string(),
  showId: z.string(),
  showTitle: z.string(),
  seasonId: z.string(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string(),
  description: z.string(),
  runtimeSeconds: z.number().int().nullable(),
  posterUrl: z.string().nullable(),
  contentVersion: z.string(),
  ready: z.boolean(),
  percentComplete: z.number().min(0).max(100).optional(),
  completed: z.boolean().optional(),
  positionSeconds: z.number().nonnegative().optional(),
  lastWatchedAt: z.string().optional(),
});

export const seasonSchema = z.object({
  id: z.string(),
  seasonNumber: z.number().int(),
  title: z.string(),
  description: z.string(),
  posterUrl: z.string().nullable(),
  episodes: z.array(episodeSummarySchema),
});

export const showDetailSchema = showSummarySchema.extend({
  seasons: z.array(seasonSchema),
});

export const subtitleSchema = z.object({
  id: z.string(),
  language: z.string(),
  label: z.string(),
});

export const movieDetailSchema = movieSummarySchema.extend({
  subtitles: z.array(subtitleSchema),
  percentComplete: z.number().min(0).max(100).optional(),
  completed: z.boolean().optional(),
  positionSeconds: z.number().nonnegative().optional(),
});

export const playbackSchema = z.object({
  kind: z.enum(["movie", "episode"]).default("movie"),
  movieId: z.string().nullable(),
  episodeId: z.string().nullable(),
  title: z.string(),
  contentVersion: z.string(),
  hlsUrl: z.string(),
  posterUrl: z.string().nullable(),
  subtitles: z.array(
    subtitleSchema.extend({
      url: z.string(),
    }),
  ),
  resumePositionSeconds: z.number().nullable(),
  showId: z.string().nullable().optional(),
  showTitle: z.string().nullable().optional(),
  seasonNumber: z.number().int().nullable().optional(),
  episodeNumber: z.number().int().nullable().optional(),
  episodeTitle: z.string().nullable().optional(),
  nextEpisodeId: z.string().nullable().optional(),
  /** e.g. "Next S01E03" or "Start Season 2" */
  nextActionLabel: z.string().nullable().optional(),
});

export const progressSchema = z.object({
  movieId: z.string(),
  positionSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  percentComplete: z.number().min(0).max(100),
  completed: z.boolean(),
  lastWatchedAt: z.string(),
  revision: z.number().int().positive(),
});

export const episodeProgressSchema = z.object({
  episodeId: z.string(),
  positionSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  percentComplete: z.number().min(0).max(100),
  completed: z.boolean(),
  lastWatchedAt: z.string(),
  revision: z.number().int().positive(),
});

export const putProgressBodySchema = z.object({
  positionSeconds: z.number().nonnegative(),
  durationSeconds: z.number().positive(),
  revision: z.number().int().positive().optional(),
  completed: z.boolean().optional(),
});

export const continueWatchingItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("movie"),
    movieId: z.string(),
    positionSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive(),
    percentComplete: z.number().min(0).max(100),
    completed: z.boolean(),
    lastWatchedAt: z.string(),
    revision: z.number().int().positive(),
    movie: movieSummarySchema,
  }),
  z.object({
    kind: z.literal("episode"),
    episodeId: z.string(),
    showId: z.string(),
    showTitle: z.string(),
    seasonNumber: z.number().int(),
    episodeNumber: z.number().int(),
    title: z.string(),
    positionSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive(),
    percentComplete: z.number().min(0).max(100),
    completed: z.boolean(),
    lastWatchedAt: z.string(),
    revision: z.number().int().positive(),
    posterUrl: z.string().nullable(),
  }),
]);

export const favoriteSchema = z.object({
  movieId: z.string(),
  createdAt: z.string(),
  movie: movieSummarySchema,
});

export const showFavoriteSchema = z.object({
  showId: z.string(),
  createdAt: z.string(),
  show: showSummarySchema,
});

export const historyItemSchema = z.object({
  id: z.string(),
  movieId: z.string(),
  watchedAt: z.string(),
  movie: movieSummarySchema,
});

export const errorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
