#!/usr/bin/env npx tsx
import path from "node:path";
import "dotenv/config";
import { addEpisode, parseSeasonEpisode } from "../src/lib/import-episode.js";

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const sourcePath = args.find((arg) => !arg.startsWith("--"));
  if (!sourcePath) {
    console.error(
      'Usage: npm run add-episode -- /path/to/S01E01.mkv --show "Show Name" [--season 1] [--episode 1] [--title Pilot] [--year 2020]',
    );
    process.exit(1);
  }

  const showTitle = readFlag(args, "--show");
  if (!showTitle) {
    console.error("Missing required --show \"Show Name\"");
    process.exit(1);
  }

  const parsed = parseSeasonEpisode(path.basename(sourcePath));
  const seasonRaw = readFlag(args, "--season");
  const episodeRaw = readFlag(args, "--episode");
  const seasonNumber = seasonRaw
    ? Number(seasonRaw)
    : (parsed?.seasonNumber ?? undefined);
  const episodeNumber = episodeRaw
    ? Number(episodeRaw)
    : (parsed?.episodeNumber ?? undefined);

  if (seasonNumber === undefined || episodeNumber === undefined) {
    console.error(
      "Could not determine season/episode. Pass --season and --episode, or use an SxxExx filename.",
    );
    process.exit(1);
  }

  const title = readFlag(args, "--title");
  const description = readFlag(args, "--description");
  const yearRaw = readFlag(args, "--year");
  const showId = readFlag(args, "--show-id");
  const year = yearRaw ? Number(yearRaw) : undefined;
  if (yearRaw && (!Number.isInteger(year) || year! < 1800)) {
    throw new Error("--year must be an integer year");
  }

  const result = await addEpisode({
    sourcePath: path.resolve(sourcePath),
    showTitle,
    seasonNumber,
    episodeNumber,
    ...(title ? { episodeTitle: title } : {}),
    ...(description ? { description } : {}),
    ...(year !== undefined ? { showYear: year } : {}),
    ...(showId ? { showId } : {}),
  });

  console.log(
    JSON.stringify(
      {
        showId: result.show.id,
        showTitle: result.show.title,
        seasonNumber: result.season.seasonNumber,
        episodeId: result.episode.id,
        episodeNumber: result.episode.episodeNumber,
        episodeTitle: result.episode.title,
        ready: result.episode.ready,
        master: result.masterRelativePath,
        ladder: result.ladder,
        subtitleCount: result.subtitleCount,
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
