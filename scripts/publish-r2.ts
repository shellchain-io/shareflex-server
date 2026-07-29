/**
 * Upload an already-encoded movies/ or episodes/ package folder to R2.
 *
 * Usage:
 *   npm run publish-r2 -- movies/<id>
 *   npm run publish-r2 -- episodes/<id>
 *
 * Encodes stay on the Mac (npm run add-movie / add-episode / admin upload).
 * This only pushes the finished HLS tree to Cloudflare R2.
 */
import "dotenv/config";
import path from "node:path";
import { loadEnv } from "../src/lib/env.js";
import { resolveMediaRoot } from "../src/lib/movies.js";
import { uploadDirectoryToR2 } from "../src/lib/r2.js";

async function main() {
  const rel = process.argv[2];
  if (!rel) {
    console.error("Usage: npm run publish-r2 -- movies/<id> | episodes/<id> | shows/<id> | seasons/<id>");
    process.exit(1);
  }

  const config = loadEnv();
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);
  const localDir = path.resolve(mediaRoot, rel);
  const keyPrefix = rel.split(path.sep).join("/");

  console.log(`Uploading ${localDir} → r2://${config.R2_BUCKET}/${keyPrefix}/`);
  const { uploaded } = await uploadDirectoryToR2({
    config,
    localDir,
    keyPrefix,
  });
  console.log(`Done. Uploaded ${uploaded} file(s).`);
  if (config.MEDIA_PUBLIC_BASE_URL) {
    console.log(`Public base: ${config.MEDIA_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${keyPrefix}/`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
