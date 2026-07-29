/**
 * ShareFlex media pipeline — Apple HLS VOD packaging helpers (cloud copy).
 * ABR ladder: 1080p / 720p / 480p (source-capped).
 */

export type QualityLabel = "1080p" | "720p" | "480p";

export type LadderRung = {
  label: QualityLabel;
  height: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
};

/** Full ABR ladder — encode every rung whose height fits the source. */
export const LADDER: readonly LadderRung[] = [
  {
    label: "1080p",
    height: 1080,
    videoBitrateKbps: 5000,
    maxrateKbps: 5350,
    bufsizeKbps: 7500,
    audioBitrateKbps: 160,
  },
  {
    label: "720p",
    height: 720,
    videoBitrateKbps: 2800,
    maxrateKbps: 3000,
    bufsizeKbps: 4200,
    audioBitrateKbps: 128,
  },
  {
    label: "480p",
    height: 480,
    videoBitrateKbps: 1400,
    maxrateKbps: 1500,
    bufsizeKbps: 2100,
    audioBitrateKbps: 128,
  },
] as const;

export const SEGMENT_SECONDS = 6;
export const GOP_SECONDS = 2;

export type ProbeStream = {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  bit_rate?: string;
  avg_frame_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

export type ProbeFormat = {
  filename?: string;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
};

export type ProbeResult = {
  streams: ProbeStream[];
  format: ProbeFormat;
};

export type ValidatedSource = {
  sourcePath: string;
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  frameRate: number;
  subtitleStreams: Array<{
    index: number;
    codec: string;
    language: string;
    title: string;
  }>;
};

export function parseFrameRate(rate: string | undefined): number {
  if (!rate || rate === "0/0") {
    return 24;
  }
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) {
    const asNumber = Number(rate);
    return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : 24;
  }
  return num / den;
}

/**
 * Return rungs whose target height is <= source height (never upscale).
 * Always at least the smallest rung that fits (scaled down to source if tiny).
 */
export function selectLadder(sourceHeight: number): LadderRung[] {
  const height = Math.max(144, sourceHeight);
  const fitting = LADDER.filter((rung) => rung.height <= height);
  if (fitting.length > 0) {
    return fitting.map((rung) => ({ ...rung }));
  }
  // Source shorter than 480p — single rung at source height, labeled 480p.
  const tiny = LADDER[LADDER.length - 1]!;
  return [
    {
      ...tiny,
      height: Math.min(tiny.height, height),
    },
  ];
}

export function validateProbe(sourcePath: string, probe: ProbeResult): ValidatedSource {
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) {
    throw new Error("Source has no usable video stream.");
  }

  const durationFromFormat = Number(probe.format.duration ?? Number.NaN);
  const durationFromStream = Number(video.duration ?? Number.NaN);
  const durationSeconds = Number.isFinite(durationFromFormat)
    ? durationFromFormat
    : durationFromStream;

  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
    throw new Error("Source duration is missing or too short.");
  }

  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const subtitleStreams = probe.streams
    .filter((stream) => stream.codec_type === "subtitle")
    .map((stream) => ({
      index: stream.index,
      codec: stream.codec_name ?? "unknown",
      language: stream.tags?.language ?? "und",
      title: stream.tags?.title ?? stream.tags?.language ?? `Subtitle ${stream.index}`,
    }));

  return {
    sourcePath,
    durationSeconds,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name ?? "unknown",
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    frameRate: parseFrameRate(video.avg_frame_rate),
    subtitleStreams,
  };
}

export function slugifyTitle(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "movie"
  );
}
