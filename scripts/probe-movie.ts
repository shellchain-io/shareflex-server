#!/usr/bin/env npx tsx
import path from "node:path";
import { probeSource } from "../src/lib/transcode.js";
import { selectLadder } from "../src/lib/media-pipeline.js";

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error("Usage: npm run probe -- /absolute/path/to/movie.mkv");
    process.exit(1);
  }

  const absolute = path.resolve(sourcePath);
  const source = await probeSource(absolute);
  const ladder = selectLadder(source.height);

  console.log(
    JSON.stringify(
      {
        source: absolute,
        durationSeconds: source.durationSeconds,
        resolution: `${source.width}x${source.height}`,
        videoCodec: source.videoCodec,
        audioCodec: source.audioCodec,
        frameRate: source.frameRate,
        subtitles: source.subtitleStreams,
        plannedLadder: ladder.map((rung) => rung.label),
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
