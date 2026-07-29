#!/usr/bin/env npx tsx
import path from "node:path";
import "dotenv/config";
import { loadEnv } from "../src/lib/env.js";
import { resolveMediaRoot } from "../src/lib/movies.js";
import { transcodeMovie } from "../src/lib/transcode.js";

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("Usage: npm run transcode -- /absolute/path/to/movie.mkv");
    process.exit(1);
  }

  const config = loadEnv();
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);
  const result = await transcodeMovie({
    sourcePath: path.resolve(sourcePath),
    mediaRoot,
  });

  console.log(
    JSON.stringify(
      {
        movieId: result.movieId,
        title: result.title,
        durationSeconds: result.durationSeconds,
        outputDir: result.outputDir,
        master: result.masterRelativePath,
        poster: result.posterRelativePath,
        ladder: result.ladder.map((rung) => rung.label),
        subtitles: result.subtitles.length,
        note: "HLS written to disk only. Use add-movie to register in SQLite.",
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
