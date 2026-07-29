import type { PrismaClient } from "../../generated/prisma/client.js";
import type { Env } from "./env.js";
import { r2ObjectExists } from "./r2.js";

export type PublishKind = "movies" | "episodes";

export async function markCdnUploaded(
  prisma: PrismaClient,
  kind: PublishKind,
  id: string,
): Promise<void> {
  if (kind === "movies") {
    await prisma.movie.update({
      where: { id },
      data: { cdnUploaded: true },
    });
    return;
  }
  await prisma.episode.update({
    where: { id },
    data: { cdnUploaded: true },
  });
}

export async function markCloudRegistered(
  prisma: PrismaClient,
  kind: PublishKind,
  id: string,
): Promise<void> {
  if (kind === "movies") {
    await prisma.movie.update({
      where: { id },
      data: { cloudRegistered: true },
    });
    return;
  }
  await prisma.episode.update({
    where: { id },
    data: { cloudRegistered: true },
  });
}

export async function applyPublishFlags(
  prisma: PrismaClient,
  kind: PublishKind,
  id: string,
  flags: { r2Uploaded?: boolean; cloudRegistered?: boolean },
): Promise<void> {
  const data: { cdnUploaded?: boolean; cloudRegistered?: boolean } = {};
  if (flags.r2Uploaded) data.cdnUploaded = true;
  if (flags.cloudRegistered) data.cloudRegistered = true;
  if (Object.keys(data).length === 0) return;

  if (kind === "movies") {
    await prisma.movie.update({ where: { id }, data });
    return;
  }
  await prisma.episode.update({ where: { id }, data });
}

async function loginToCloud(config: Env): Promise<string | null> {
  const base = config.PUBLISH_TARGET_URL?.trim().replace(/\/$/, "");
  if (!base) return null;
  const email = config.PUBLISH_TARGET_EMAIL || config.SEED_USER_1_EMAIL;
  const password = config.PUBLISH_TARGET_PASSWORD || config.SEED_USER_1_PASSWORD;
  try {
    const res = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
    };
    if (!res.ok || !body.accessToken) return null;
    return body.accessToken;
  } catch {
    return null;
  }
}

async function cloudResourceExists(
  config: Env,
  path: string,
  token: string,
): Promise<boolean> {
  const base = config.PUBLISH_TARGET_URL!.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe R2 (+ optional GCE) for items still flagged false, then persist true when found.
 * Returns updated flag values for the caller to include in the response.
 */
export async function backfillMoviePublishStatus(
  prisma: PrismaClient,
  config: Env,
  movie: {
    id: string;
    ready: boolean;
    cdnUploaded: boolean;
    cloudRegistered: boolean;
  },
): Promise<{ cdnUploaded: boolean; cloudRegistered: boolean }> {
  let { cdnUploaded, cloudRegistered } = movie;
  const patch: { cdnUploaded?: boolean; cloudRegistered?: boolean } = {};

  if (movie.ready && !cdnUploaded) {
    const onR2 = await r2ObjectExists({
      config,
      key: `movies/${movie.id}/master.m3u8`,
    });
    if (onR2) {
      cdnUploaded = true;
      patch.cdnUploaded = true;
    }
  }

  if (movie.ready && !cloudRegistered) {
    const token = await loginToCloud(config);
    if (token) {
      const onCloud = await cloudResourceExists(
        config,
        `/v1/movies/${encodeURIComponent(movie.id)}`,
        token,
      );
      if (onCloud) {
        cloudRegistered = true;
        patch.cloudRegistered = true;
      }
    }
  }

  if (Object.keys(patch).length > 0) {
    await prisma.movie.update({ where: { id: movie.id }, data: patch });
  }

  return { cdnUploaded, cloudRegistered };
}

export async function backfillEpisodePublishStatus(
  prisma: PrismaClient,
  config: Env,
  episodes: Array<{
    id: string;
    ready: boolean;
    cdnUploaded: boolean;
    cloudRegistered: boolean;
  }>,
): Promise<
  Map<string, { cdnUploaded: boolean; cloudRegistered: boolean }>
> {
  const out = new Map<
    string,
    { cdnUploaded: boolean; cloudRegistered: boolean }
  >();

  const needCdn = episodes.filter((ep) => ep.ready && !ep.cdnUploaded);
  const needCloud = episodes.filter((ep) => ep.ready && !ep.cloudRegistered);

  const cdnHits = new Set<string>();
  await Promise.all(
    needCdn.map(async (ep) => {
      const onR2 = await r2ObjectExists({
        config,
        key: `episodes/${ep.id}/master.m3u8`,
      });
      if (onR2) cdnHits.add(ep.id);
    }),
  );

  const cloudHits = new Set<string>();
  if (needCloud.length > 0) {
    const token = await loginToCloud(config);
    if (token) {
      await Promise.all(
        needCloud.map(async (ep) => {
          const onCloud = await cloudResourceExists(
            config,
            `/v1/episodes/${encodeURIComponent(ep.id)}`,
            token,
          );
          if (onCloud) cloudHits.add(ep.id);
        }),
      );
    }
  }

  await Promise.all(
    episodes.map(async (ep) => {
      let cdnUploaded = ep.cdnUploaded || cdnHits.has(ep.id);
      let cloudRegistered = ep.cloudRegistered || cloudHits.has(ep.id);
      const patch: { cdnUploaded?: boolean; cloudRegistered?: boolean } = {};
      if (!ep.cdnUploaded && cdnHits.has(ep.id)) patch.cdnUploaded = true;
      if (!ep.cloudRegistered && cloudHits.has(ep.id)) patch.cloudRegistered = true;
      if (Object.keys(patch).length > 0) {
        await prisma.episode.update({ where: { id: ep.id }, data: patch });
      }
      out.set(ep.id, { cdnUploaded, cloudRegistered });
    }),
  );

  return out;
}
