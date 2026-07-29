import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));

function resolveDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const filePrefix = "file:";
  if (!databaseUrl.startsWith(filePrefix)) {
    return databaseUrl;
  }
  const rawPath = databaseUrl.slice(filePrefix.length);
  const absolutePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(serverRoot, rawPath);
  return `file:${absolutePath}`;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolveDatabaseUrl(process.env["DATABASE_URL"]),
  },
});
