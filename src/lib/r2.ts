import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Env } from "./env.js";

function contentTypeForKey(key: string): string {
  const ext = path.extname(key).toLowerCase();
  switch (ext) {
    case ".m3u8":
      return "application/vnd.apple.mpegurl";
    case ".m4s":
    case ".mp4":
      return "video/mp4";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".vtt":
      return "text/vtt";
    default:
      return "application/octet-stream";
  }
}

export function createR2Client(config: Env): S3Client {
  const accountId = config.R2_ACCOUNT_ID;
  const accessKeyId = config.R2_ACCESS_KEY_ID;
  const secretAccessKey = config.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required to upload.",
    );
  }
  const endpoint =
    config.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function r2Ready(config: Env): boolean {
  return Boolean(
    config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY,
  );
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Upload a local directory tree to R2 under the given key prefix (posix). Parallel puts. */
export async function uploadDirectoryToR2(options: {
  config: Env;
  localDir: string;
  keyPrefix: string;
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (info: {
    uploaded: number;
    total: number;
    percent: number;
    currentKey: string;
  }) => void;
}): Promise<{ uploaded: number }> {
  const client = createR2Client(options.config);
  const bucket = options.config.R2_BUCKET || "shareflex-media";
  const prefix = options.keyPrefix.replace(/^\/+|\/+$/g, "");
  const files = await listFilesRecursive(options.localDir);
  const total = files.length;
  if (total === 0) {
    return { uploaded: 0 };
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 6, 12));
  let uploaded = 0;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (true) {
      if (options.signal?.aborted) {
        throw new Error("Cancelled.");
      }
      const myIndex = index;
      index += 1;
      if (myIndex >= files.length) {
        return;
      }
      const absolute = files[myIndex]!;
      const relative = path.relative(options.localDir, absolute).split(path.sep).join("/");
      const key = prefix ? `${prefix}/${relative}` : relative;
      const fileStat = await stat(absolute);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(absolute),
          ContentType: contentTypeForKey(key),
          ContentLength: fileStat.size,
        }),
      );
      uploaded += 1;
      options.onProgress?.({
        uploaded,
        total,
        percent: Math.round((uploaded / total) * 100),
        currentKey: key,
      });
      if (uploaded % 25 === 0 || uploaded === total) {
        console.log(`Uploaded ${uploaded}/${total}…`);
      }
    }
  });

  await Promise.all(workers);
  if (options.signal?.aborted) {
    throw new Error("Cancelled.");
  }
  return { uploaded };
}

/**
 * Delete all objects under a prefix (e.g. movies/{id}/).
 * When keepPoster is true, leaves …/poster.jpg in place (matches local purge).
 */
export async function deletePrefixFromR2(options: {
  config: Env;
  keyPrefix: string;
  keepPoster?: boolean;
}): Promise<{ deleted: number }> {
  if (!r2Ready(options.config)) {
    return { deleted: 0 };
  }

  const client = createR2Client(options.config);
  const bucket = options.config.R2_BUCKET || "shareflex-media";
  const prefix = `${options.keyPrefix.replace(/^\/+|\/+$/g, "")}/`;
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    const keys = (listed.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => Boolean(key))
      .filter((key) => {
        if (!options.keepPoster) return true;
        return !key.endsWith("/poster.jpg");
      });

    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
      deleted += chunk.length;
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);

  return { deleted };
}
