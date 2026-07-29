import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { publicObjectUrl, usesPublicMediaCdn } from "./media-public.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function isImageFilename(filename: string): boolean {
  return IMAGE_EXT.has(path.extname(filename).toLowerCase());
}

/** Install a custom poster image at the given relative path under mediaRoot. */
export async function installPosterFile(options: {
  mediaRoot: string;
  sourcePath: string;
  relativePath: string;
}): Promise<string> {
  const destAbsolute = path.join(options.mediaRoot, options.relativePath);
  await mkdir(path.dirname(destAbsolute), { recursive: true });
  await copyFile(options.sourcePath, destAbsolute);
  return options.relativePath;
}

export function moviePosterRelativePath(movieId: string): string {
  return path.join("movies", movieId, "poster.jpg");
}

export function seasonPosterRelativePath(seasonId: string): string {
  return path.join("seasons", seasonId, "poster.jpg");
}

export function toPublicSeasonPosterUrl(seasonId: string): string {
  if (usesPublicMediaCdn()) {
    return publicObjectUrl("seasons", seasonId, "poster.jpg");
  }
  return `/v1/media/seasons/${seasonId}/poster`;
}
