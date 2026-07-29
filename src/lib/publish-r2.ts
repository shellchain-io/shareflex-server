import { access } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./env.js";
import { uploadDirectoryToR2 } from "./r2.js";

export type PublishKind = "movies" | "episodes" | "shows" | "seasons";

export async function assertR2Configured(config: Env): Promise<void> {
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
    throw new Error(
      "R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in .env",
    );
  }
}

/** Upload a local media package folder to R2 (same layout as encode output). */
export async function publishLocalPackageToR2(options: {
  config: Env;
  mediaRoot: string;
  kind: PublishKind;
  id: string;
  signal?: AbortSignal;
  onProgress?: (info: {
    uploaded: number;
    total: number;
    percent: number;
    currentKey: string;
  }) => void;
}): Promise<{ uploaded: number; keyPrefix: string }> {
  await assertR2Configured(options.config);
  if (options.signal?.aborted) {
    throw new Error("Cancelled.");
  }

  const keyPrefix = `${options.kind}/${options.id}`;
  const localDir = path.join(options.mediaRoot, options.kind, options.id);
  try {
    await access(localDir);
  } catch {
    throw new Error(
      `Local package missing: ${keyPrefix}. Encode on this machine first, then reupload.`,
    );
  }

  const master = path.join(localDir, "master.m3u8");
  if (options.kind === "movies" || options.kind === "episodes") {
    try {
      await access(master);
    } catch {
      throw new Error(`No master.m3u8 in ${keyPrefix}. Encode may have failed.`);
    }
  }

  const { uploaded } = await uploadDirectoryToR2({
    config: options.config,
    localDir,
    keyPrefix,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  if (options.signal?.aborted) {
    throw new Error("Cancelled.");
  }

  return { uploaded, keyPrefix };
}
