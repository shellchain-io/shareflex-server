import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client.js";

/** Works for both `tsx src/…` and `node dist/src/…`. */
export function resolveServerRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export const serverRoot = resolveServerRoot();

/**
 * Resolve SQLite file: URLs against the server package root so Prisma migrate
 * (prisma.config.ts) and the runtime adapter always share one database file.
 */
export function resolveSqliteFileUrl(databaseUrl: string): string {
  const filePrefix = "file:";
  if (!databaseUrl.startsWith(filePrefix)) {
    throw new Error(`DATABASE_URL must use file: protocol, got: ${databaseUrl}`);
  }

  const rawPath = databaseUrl.slice(filePrefix.length);
  const absolutePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(serverRoot, rawPath);

  mkdirSync(path.dirname(absolutePath), { recursive: true });

  return `file:${absolutePath}`;
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: resolveSqliteFileUrl(databaseUrl),
  });
  return new PrismaClient({ adapter });
}

export type { PrismaClient };
