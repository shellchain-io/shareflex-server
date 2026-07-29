import path from "node:path";
import type {
  Episode,
  EpisodeSubtitleTrack,
  Show,
} from "../../generated/prisma/client.js";
import { publicObjectUrl, usesPublicMediaCdn } from "./media-public.js";

export function toPublicEpisodeMediaUrl(
  kind: "poster" | "hls" | "subtitle",
  episodeId: string,
  assetId?: string,
): string {
  if (usesPublicMediaCdn()) {
    if (kind === "poster") {
      return publicObjectUrl("episodes", episodeId, "poster.jpg");
    }
    if (kind === "hls") {
      return publicObjectUrl("episodes", episodeId, "master.m3u8");
    }
    return publicObjectUrl("episodes", episodeId, "subtitles", assetId ?? "track.vtt");
  }
  if (kind === "poster") {
    return `/v1/media/episodes/${episodeId}/poster`;
  }
  if (kind === "hls") {
    return `/v1/media/episodes/${episodeId}/hls/master.m3u8`;
  }
  return `/v1/media/episodes/${episodeId}/subtitles/${assetId ?? ""}`;
}

export function toPublicShowPosterUrl(showId: string): string {
  if (usesPublicMediaCdn()) {
    return publicObjectUrl("shows", showId, "poster.jpg");
  }
  return `/v1/media/shows/${showId}/poster`;
}

export type ShowLike = Pick<
  Show,
  "id" | "title" | "description" | "year" | "posterPath" | "contentVersion" | "ready"
>;

export function serializeShow(
  show: ShowLike,
  extras?: { seasonCount?: number; episodeCount?: number },
) {
  return {
    id: show.id,
    title: show.title,
    description: show.description,
    year: show.year,
    posterUrl: show.posterPath ? toPublicShowPosterUrl(show.id) : null,
    contentVersion: show.contentVersion,
    ready: show.ready,
    seasonCount: extras?.seasonCount ?? 0,
    episodeCount: extras?.episodeCount ?? 0,
  };
}

/** Only seasons that actually have ready episodes count toward "N seasons". */
export function countSeasonsWithEpisodes(
  seasons: Array<{ _count: { episodes: number } }>,
): { seasonCount: number; episodeCount: number } {
  let seasonCount = 0;
  let episodeCount = 0;
  for (const season of seasons) {
    const n = season._count.episodes;
    if (n > 0) {
      seasonCount += 1;
      episodeCount += n;
    }
  }
  return { seasonCount, episodeCount };
}

export type EpisodeLike = Pick<
  Episode,
  | "id"
  | "title"
  | "description"
  | "episodeNumber"
  | "runtimeSeconds"
  | "posterPath"
  | "contentVersion"
  | "ready"
>;

export function serializeEpisode(
  episode: EpisodeLike,
  meta: {
    showId: string;
    showTitle: string;
    seasonNumber: number;
    seasonId: string;
    percentComplete?: number;
    completed?: boolean;
    positionSeconds?: number;
    lastWatchedAt?: string;
  },
) {
  return {
    id: episode.id,
    showId: meta.showId,
    showTitle: meta.showTitle,
    seasonId: meta.seasonId,
    seasonNumber: meta.seasonNumber,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    description: episode.description,
    runtimeSeconds: episode.runtimeSeconds,
    posterUrl: episode.posterPath
      ? toPublicEpisodeMediaUrl("poster", episode.id)
      : null,
    contentVersion: episode.contentVersion,
    ready: episode.ready,
    ...(meta.percentComplete !== undefined
      ? { percentComplete: meta.percentComplete }
      : {}),
    ...(meta.completed !== undefined ? { completed: meta.completed } : {}),
    ...(meta.positionSeconds !== undefined
      ? { positionSeconds: meta.positionSeconds }
      : {}),
    ...(meta.lastWatchedAt !== undefined
      ? { lastWatchedAt: meta.lastWatchedAt }
      : {}),
  };
}

export function serializeEpisodeSubtitles(tracks: EpisodeSubtitleTrack[]) {
  return tracks.map((track) => ({
    id: track.id,
    language: track.language,
    label: track.label,
  }));
}

export function episodeLabel(seasonNumber: number, episodeNumber: number): string {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

/** Copy show poster under media/shows/:id when first episode provides art. */
export function showPosterRelativePath(showId: string): string {
  return path.join("shows", showId, "poster.jpg");
}

/** Re-export movie URL helper for unified CW poster fallbacks. */
export { toPublicMediaUrl } from "./movies.js";
