import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "../../generated/prisma/client.js";

async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function removeDir(dir: string): Promise<{ removed: boolean; bytes: number }> {
  const bytes = await dirSizeBytes(dir);
  try {
    await rm(dir, { recursive: true, force: true });
    return { removed: true, bytes };
  } catch {
    return { removed: false, bytes: 0 };
  }
}

/**
 * Free disk on the API host after mistaken GB uploads / failed encodes.
 * Does not delete the SQLite database.
 */
export async function cleanupLocalMedia(options: {
  prisma: PrismaClient;
  mediaRoot: string;
  /** Wipe media/temp/uploads (browser multipart leftovers). Default true. */
  purgeTemp?: boolean;
  /** Delete local packages for titles that are not ready. Default true. */
  purgeNotReady?: boolean;
  /**
   * Delete ALL local movies/episodes/shows/seasons folders.
   * Safe on GCE when bytes live on R2 — frees encode leftovers.
   * Does not touch DB rows.
   */
  purgeAllLocalPackages?: boolean;
}): Promise<{
  freedBytes: number;
  removedPaths: string[];
  notes: string[];
}> {
  const {
    prisma,
    mediaRoot,
    purgeTemp = true,
    purgeNotReady = true,
    purgeAllLocalPackages = false,
  } = options;

  const removedPaths: string[] = [];
  const notes: string[] = [];
  let freedBytes = 0;

  if (purgeTemp) {
    const uploads = path.join(mediaRoot, "temp", "uploads");
    const result = await removeDir(uploads);
    if (result.removed && result.bytes > 0) {
      freedBytes += result.bytes;
      removedPaths.push(uploads);
    }
    // Recreate empty uploads dir so next upload works.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(uploads, { recursive: true });
    notes.push("Cleared temp/uploads.");
  }

  if (purgeAllLocalPackages) {
    for (const kind of ["movies", "episodes", "shows", "seasons"] as const) {
      const dir = path.join(mediaRoot, kind);
      const result = await removeDir(dir);
      if (result.removed) {
        freedBytes += result.bytes;
        if (result.bytes > 0) {
          removedPaths.push(dir);
        }
        const { mkdir } = await import("node:fs/promises");
        await mkdir(dir, { recursive: true });
      }
    }
    notes.push(
      "Removed all local media packages (DB + R2 unchanged). Use this on GCE after accidental encodes.",
    );
    return { freedBytes, removedPaths, notes };
  }

  if (purgeNotReady) {
    const movies = await prisma.movie.findMany({
      where: { ready: false },
      select: { id: true, title: true },
    });
    for (const movie of movies) {
      const dir = path.join(mediaRoot, "movies", movie.id);
      const result = await removeDir(dir);
      if (result.removed && result.bytes > 0) {
        freedBytes += result.bytes;
        removedPaths.push(dir);
      }
    }

    const episodes = await prisma.episode.findMany({
      where: { ready: false },
      select: { id: true, title: true },
    });
    for (const episode of episodes) {
      const dir = path.join(mediaRoot, "episodes", episode.id);
      const result = await removeDir(dir);
      if (result.removed && result.bytes > 0) {
        freedBytes += result.bytes;
        removedPaths.push(dir);
      }
    }
    notes.push(
      `Removed local packages for ${movies.length} not-ready movie(s) and ${episodes.length} not-ready episode(s).`,
    );
  }

  return { freedBytes, removedPaths, notes };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
