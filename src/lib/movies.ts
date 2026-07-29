import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Movie, SubtitleTrack } from "../../generated/prisma/client.js";
import { publicObjectUrl, usesPublicMediaCdn } from "./media-public.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function resolveMediaRoot(mediaRootEnv: string): string {
  return path.isAbsolute(mediaRootEnv)
    ? mediaRootEnv
    : path.resolve(serverRoot, mediaRootEnv);
}

export function toPublicMediaUrl(kind: "poster" | "hls" | "subtitle", movieId: string, assetId?: string): string {
  if (usesPublicMediaCdn()) {
    if (kind === "poster") {
      return publicObjectUrl("movies", movieId, "poster.jpg");
    }
    if (kind === "hls") {
      return publicObjectUrl("movies", movieId, "master.m3u8");
    }
    // Subtitle files on disk are like subtitles/{lang}-{index}.vtt; API still keys by asset id for /v1 path.
    // For CDN, callers that have relativePath should prefer that; fallback keeps id in path for DB-backed tracks.
    return publicObjectUrl("movies", movieId, "subtitles", assetId ?? "track.vtt");
  }
  if (kind === "poster") {
    return `/v1/media/movies/${movieId}/poster`;
  }
  if (kind === "hls") {
    return `/v1/media/movies/${movieId}/hls/master.m3u8`;
  }
  return `/v1/media/movies/${movieId}/subtitles/${assetId ?? ""}`;
}

export type MovieLike = Pick<
  Movie,
  | "id"
  | "title"
  | "description"
  | "year"
  | "runtimeSeconds"
  | "posterPath"
  | "contentVersion"
  | "ready"
>;

export function serializeMovie(movie: MovieLike) {
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description,
    year: movie.year,
    runtimeSeconds: movie.runtimeSeconds,
    posterUrl: movie.posterPath ? toPublicMediaUrl("poster", movie.id) : null,
    contentVersion: movie.contentVersion,
    ready: movie.ready,
  };
}

export function serializeSubtitles(tracks: SubtitleTrack[]) {
  return tracks.map((track) => ({
    id: track.id,
    language: track.language,
    label: track.label,
  }));
}

/**
 * Prevent path traversal when resolving media under MEDIA_ROOT.
 */
export function safeResolveUnderRoot(root: string, ...segments: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}
