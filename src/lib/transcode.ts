import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "./ids.js";
import { ensureFfmpegTools, runCommand } from "./ffmpeg.js";
import {
  GOP_SECONDS,
  SEGMENT_SECONDS,
  selectLadder,
  validateProbe,
  type LadderRung,
  type ProbeResult,
  type ValidatedSource,
} from "./media-pipeline.js";

export async function probeSource(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<ValidatedSource> {
  await ensureFfmpegTools();
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      sourcePath,
    ],
    signal ? { signal } : {},
  );
  const probe = JSON.parse(stdout) as ProbeResult;
  return validateProbe(sourcePath, probe);
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it.
    return code === "EPERM";
  }
}

async function withTranscodeLock<T>(
  lockPath: string,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  const acquire = async () => open(lockPath, "wx");

  let handle;
  try {
    handle = await acquire();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }

    // Stale lock from a crashed/killed encode — reclaim and retry once.
    let holderAlive = false;
    try {
      const raw = await readFile(lockPath, "utf8");
      const pid = Number.parseInt(raw.split(/\r?\n/, 1)[0] ?? "", 10);
      holderAlive = await isProcessAlive(pid);
    } catch {
      holderAlive = false;
    }

    if (holderAlive) {
      throw new Error(
        `This title is already being encoded (lock: ${lockPath}).`,
      );
    }

    await rm(lockPath, { force: true });
    try {
      handle = await acquire();
    } catch (retryError) {
      const retryCode = (retryError as NodeJS.ErrnoException).code;
      if (retryCode === "EEXIST") {
        throw new Error(
          `This title is already being encoded (lock: ${lockPath}).`,
        );
      }
      throw retryError;
    }
  }

  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await work();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function buildVariantArgs(
  sourcePath: string,
  outDir: string,
  rung: LadderRung,
  hasAudio: boolean,
  frameRate: number,
  videoEncoder: "h264_videotoolbox" | "libx264",
): string[] {
  const gop = Math.max(1, Math.round(frameRate * GOP_SECONDS));
  const playlist = path.join(outDir, "index.m3u8");
  const segmentPattern = path.join(outDir, "seg_%05d.m4s");

  const args = [
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    ...(hasAudio ? ["-map", "0:a:0?"] : []),
    "-c:v",
    videoEncoder,
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `scale=-2:${rung.height}`,
    "-b:v",
    `${rung.videoBitrateKbps}k`,
    "-maxrate",
    `${rung.maxrateKbps}k`,
    "-bufsize",
    `${rung.bufsizeKbps}k`,
    "-g",
    String(gop),
    "-keyint_min",
    String(gop),
    "-force_key_frames",
    `expr:gte(t,n_forced*${GOP_SECONDS})`,
  ];

  if (videoEncoder === "libx264") {
    args.push(
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-preset",
      "veryfast",
      "-sc_threshold",
      "0",
    );
  } else {
    // Mac hardware encode — dramatically faster than libx264 medium.
    args.push("-allow_sw", "1", "-realtime", "0");
  }

  if (hasAudio) {
    args.push(
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-ac",
      "2",
      "-b:a",
      `${rung.audioBitrateKbps}k`,
      "-ar",
      "48000",
    );
  } else {
    args.push("-an");
  }

  args.push(
    "-f",
    "hls",
    "-hls_time",
    String(SEGMENT_SECONDS),
    "-hls_playlist_type",
    "vod",
    "-hls_flags",
    "independent_segments",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    segmentPattern,
    playlist,
  );

  return args;
}

let cachedVideoEncoder: "h264_videotoolbox" | "libx264" | null = null;

async function resolveVideoEncoder(): Promise<"h264_videotoolbox" | "libx264"> {
  if (cachedVideoEncoder) {
    return cachedVideoEncoder;
  }
  try {
    const { stdout } = await runCommand("ffmpeg", ["-hide_banner", "-encoders"]);
    cachedVideoEncoder = stdout.includes("h264_videotoolbox")
      ? "h264_videotoolbox"
      : "libx264";
  } catch {
    cachedVideoEncoder = "libx264";
  }
  return cachedVideoEncoder;
}

async function writeMasterPlaylist(
  masterPath: string,
  variants: Array<{ rung: LadderRung; playlistRelative: string; hasAudio: boolean }>,
): Promise<void> {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7"];
  for (const variant of variants) {
    const audioBitrate = variant.hasAudio ? variant.rung.audioBitrateKbps * 1000 : 0;
    const bandwidth = variant.rung.videoBitrateKbps * 1000 + audioBitrate;
    const averageBandwidth = Math.round(bandwidth * 0.9);
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${averageBandwidth},RESOLUTION=placeholderx${variant.rung.height},FRAME-RATE=24.000,CODECS="avc1.640029${variant.hasAudio ? ",mp4a.40.2" : ""}"`,
    );
    // RESOLUTION width is approximate; rewrite after measuring first variant init if needed.
    lines[lines.length - 1] = lines[lines.length - 1]!.replace(
      "placeholder",
      String(Math.round((variant.rung.height * 16) / 9)),
    );
    lines.push(variant.playlistRelative);
  }
  await writeFile(masterPath, `${lines.join("\n")}\n`, "utf8");
}

async function extractPoster(
  sourcePath: string,
  posterPath: string,
  durationSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  const seek = Math.min(
    Math.max(durationSeconds * 0.45, 2),
    Math.max(durationSeconds - 1, 1),
  );
  await runCommand(
    "ffmpeg",
    [
      "-y",
      "-ss",
      seek.toFixed(3),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      posterPath,
    ],
    signal ? { signal } : {},
  );
}

async function extractSubtitles(
  source: ValidatedSource,
  movieDir: string,
  signal?: AbortSignal,
): Promise<Array<{ language: string; label: string; relativePath: string }>> {
  const out: Array<{ language: string; label: string; relativePath: string }> = [];
  const subDir = path.join(movieDir, "subtitles");
  await mkdir(subDir, { recursive: true });

  for (const track of source.subtitleStreams) {
    if (signal?.aborted) {
      throw new Error("Cancelled.");
    }
    // Prefer text-based codecs that FFmpeg can convert to WebVTT.
    const convertible = new Set(["subrip", "ass", "ssa", "webvtt", "mov_text", "text"]);
    if (!convertible.has(track.codec)) {
      continue;
    }
    const fileName = `${track.language}-${track.index}.vtt`;
    const absolute = path.join(subDir, fileName);
    try {
      await runCommand(
        "ffmpeg",
        ["-y", "-i", source.sourcePath, "-map", `0:${track.index}`, absolute],
        signal ? { signal } : {},
      );
      out.push({
        language: track.language,
        label: track.title,
        relativePath: path.join("subtitles", fileName),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.message === "Cancelled.")) {
        throw error;
      }
      // Skip tracks that fail conversion; movie can still be ready without them.
    }
  }
  return out;
}

export type MediaKind = "movies" | "episodes";

export type TranscodeResult = {
  id: string;
  /** @deprecated Use `id` — kept for movie import callers. */
  movieId: string;
  title: string;
  durationSeconds: number;
  outputDir: string;
  masterRelativePath: string;
  posterRelativePath: string | null;
  subtitles: Array<{ language: string; label: string; relativePath: string }>;
  ladder: LadderRung[];
  kind: MediaKind;
};

export async function transcodeMovie(options: {
  sourcePath: string;
  mediaRoot: string;
  title?: string;
  movieId?: string;
  kind?: MediaKind;
  id?: string;
  signal?: AbortSignal;
  onProgress?: (info: {
    phase: string;
    percent: number;
    detail: string;
  }) => void;
}): Promise<TranscodeResult> {
  const kind = options.kind ?? "movies";
  const signal = options.signal;
  const report = options.onProgress;
  report?.({ phase: "probe", percent: 2, detail: "Probing source…" });
  const source = await probeSource(options.sourcePath, signal);
  const ladder = selectLadder(source.height);
  const videoEncoder = await resolveVideoEncoder();
  const id =
    options.id ??
    options.movieId ??
    createId(kind === "episodes" ? "e" : "m");
  const derivedTitle = path
    .parse(options.sourcePath)
    .name.replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = options.title ?? (derivedTitle || "Untitled");

  // Per-title lock only — parallel encodes are allowed (job queue sets the batch size).
  const lockPath = path.join(options.mediaRoot, "temp", `transcode-${id}.lock`);
  const stagingDir = path.join(options.mediaRoot, "temp", `job-${id}`);
  const finalDir = path.join(options.mediaRoot, kind, id);

  return withTranscodeLock(lockPath, async () => {
    if (signal?.aborted) {
      throw new Error("Cancelled.");
    }
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    const variants: Array<{
      rung: LadderRung;
      playlistRelative: string;
      hasAudio: boolean;
    }> = [];

    console.log(`ShareFlex encode via ${videoEncoder} (${ladder.map((r) => r.label).join(", ")})`);

    try {
      for (let i = 0; i < ladder.length; i++) {
        const rung = ladder[i]!;
        if (signal?.aborted) {
          throw new Error("Cancelled.");
        }
        const rungPercent = Math.round(((i + 0.5) / (ladder.length + 1)) * 90);
        report?.({
          phase: "encode",
          percent: rungPercent,
          detail: `Encoding ${rung.label} (${i + 1}/${ladder.length})…`,
        });
        const variantDir = path.join(stagingDir, rung.label);
        await mkdir(variantDir, { recursive: true });
        let usedEncoder = videoEncoder;
        try {
          const args = buildVariantArgs(
            source.sourcePath,
            variantDir,
            rung,
            source.hasAudio,
            source.frameRate,
            usedEncoder,
          );
          console.log(`Encoding ${rung.label} with ${usedEncoder}...`);
          await runCommand("ffmpeg", args, signal ? { signal } : {});
        } catch (error) {
          if (signal?.aborted || (error instanceof Error && error.message === "Cancelled.")) {
            throw error instanceof Error ? error : new Error("Cancelled.");
          }
          if (usedEncoder !== "libx264") {
            console.warn(
              `Hardware encode failed for ${rung.label}, falling back to libx264:`,
              error instanceof Error ? error.message : error,
            );
            usedEncoder = "libx264";
            cachedVideoEncoder = "libx264";
            const args = buildVariantArgs(
              source.sourcePath,
              variantDir,
              rung,
              source.hasAudio,
              source.frameRate,
              usedEncoder,
            );
            console.log(`Encoding ${rung.label} with ${usedEncoder}...`);
            await runCommand("ffmpeg", args, signal ? { signal } : {});
          } else {
            throw error;
          }
        }
        variants.push({
          rung,
          playlistRelative: `${rung.label}/index.m3u8`,
          hasAudio: source.hasAudio,
        });
        report?.({
          phase: "encode",
          percent: Math.round(((i + 1) / (ladder.length + 1)) * 90),
          detail: `Finished ${rung.label} (${i + 1}/${ladder.length})`,
        });
      }

      const masterPath = path.join(stagingDir, "master.m3u8");
      await writeMasterPlaylist(masterPath, variants);

      let posterRelativePath: string | null = null;
      const posterAbsolute = path.join(stagingDir, "poster.jpg");
      report?.({ phase: "poster", percent: 92, detail: "Extracting poster…" });
      try {
        await extractPoster(source.sourcePath, posterAbsolute, source.durationSeconds, signal);
        posterRelativePath = path.join(kind, id, "poster.jpg");
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.message === "Cancelled.")) {
          throw error instanceof Error ? error : new Error("Cancelled.");
        }
        posterRelativePath = null;
      }

      report?.({ phase: "subtitles", percent: 95, detail: "Extracting subtitles…" });
      const subtitleFiles = await extractSubtitles(source, stagingDir, signal);

      const masterText = await readFile(masterPath, "utf8");
      if (!masterText.includes("#EXTM3U")) {
        throw new Error("Master playlist validation failed.");
      }
      for (const variant of variants) {
        const playlistPath = path.join(stagingDir, variant.playlistRelative);
        const playlist = await readFile(playlistPath, "utf8");
        if (!playlist.includes("#EXTINF")) {
          throw new Error(`Variant playlist invalid: ${variant.playlistRelative}`);
        }
      }

      if (signal?.aborted) {
        throw new Error("Cancelled.");
      }

      await rm(finalDir, { recursive: true, force: true });
      await mkdir(path.dirname(finalDir), { recursive: true });
      await rename(stagingDir, finalDir);

      report?.({ phase: "done", percent: 100, detail: "Encode complete" });

      return {
        id,
        movieId: id,
        title,
        durationSeconds: Math.round(source.durationSeconds),
        outputDir: finalDir,
        masterRelativePath: path.join(kind, id, "master.m3u8"),
        posterRelativePath,
        subtitles: subtitleFiles.map((track) => ({
          ...track,
          relativePath: path.join(kind, id, track.relativePath),
        })),
        ladder,
        kind,
      };
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (signal?.aborted) {
        await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  });
}
