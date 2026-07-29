/**
 * When MEDIA_PUBLIC_BASE_URL is set (Cloudflare R2 public URL), playback/poster
 * URLs become absolute CDN paths matching on-disk layout under MEDIA_ROOT.
 * When unset, keep legacy auth-gated /v1/media/* paths.
 */

let mediaPublicBaseUrl: string | null = null;

export function setMediaPublicBaseUrl(url: string | null | undefined): void {
  if (!url || !url.trim()) {
    mediaPublicBaseUrl = null;
    return;
  }
  mediaPublicBaseUrl = url.trim().replace(/\/+$/, "");
}

export function getMediaPublicBaseUrl(): string | null {
  return mediaPublicBaseUrl;
}

export function usesPublicMediaCdn(): boolean {
  return Boolean(mediaPublicBaseUrl);
}

export function publicObjectUrl(...segments: string[]): string {
  const base = mediaPublicBaseUrl;
  if (!base) {
    throw new Error("MEDIA_PUBLIC_BASE_URL is not configured");
  }
  const path = segments
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `${base}/${path}`;
}
