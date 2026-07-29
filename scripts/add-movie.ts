#!/usr/bin/env npx tsx
import path from "node:path";
import "dotenv/config";
import { addMovie } from "../src/lib/import-movie.js";

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
      "Usage: npm run add-movie -- /absolute/path/to/movie.mkv [--title Name] [--year 2024] [--description Text]",
    );
    process.exit(1);
  }

  const title = readFlag(args, "--title");
  const yearRaw = readFlag(args, "--year");
  const description = readFlag(args, "--description");
  const year = yearRaw ? Number(yearRaw) : undefined;
  if (yearRaw && (!Number.isInteger(year) || year! < 1800)) {
    throw new Error("--year must be an integer year");
  }

  const result = await addMovie({
    sourcePath: path.resolve(sourcePath),
    ...(title ? { title } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(description ? { description } : {}),
  });

  console.log(
    JSON.stringify(
      {
        movieId: result.movie.id,
        title: result.movie.title,
        ready: result.movie.ready,
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
