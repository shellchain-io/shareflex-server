import "dotenv/config";
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "../src/lib/env.js";
import { resolveMediaRoot } from "../src/lib/movies.js";
import { createPrismaClient } from "../src/lib/prisma.js";

async function main() {
  const config = loadEnv();
  const prisma = createPrismaClient(config.DATABASE_URL);
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);

  try {
    const movies = await prisma.movie.deleteMany();
    const shows = await prisma.show.deleteMany();

    await Promise.all([
      rm(path.join(mediaRoot, "movies"), { recursive: true, force: true }),
      rm(path.join(mediaRoot, "episodes"), { recursive: true, force: true }),
      rm(path.join(mediaRoot, "shows"), { recursive: true, force: true }),
      rm(path.join(mediaRoot, "seasons"), { recursive: true, force: true }),
      rm(path.join(mediaRoot, "temp"), { recursive: true, force: true }),
    ]);

    console.log(
      `Cleared library: ${movies.count} movies, ${shows.count} shows. Media wiped under ${mediaRoot}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
