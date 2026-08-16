import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    // warn = startup + real problems only (safe for tiny GCE disks).
    .default("warn"),
  JWT_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MEDIA_ROOT: z.string().min(1),
  /** Public R2 (or CDN) base, e.g. https://pub-….r2.dev — empty = serve via /v1/media */
  MEDIA_PUBLIC_BASE_URL: z.string().optional().default(""),
  R2_ACCOUNT_ID: z.string().optional().default(""),
  R2_ACCESS_KEY_ID: z.string().optional().default(""),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(""),
  R2_BUCKET: z.string().optional().default("shareflex-media"),
  R2_ENDPOINT: z.string().optional().default(""),
  /**
   * When false (GCE), reject multipart video encode uploads.
   * Encode only on Mac with ALLOW_LOCAL_ENCODE=true.
   */
  ALLOW_LOCAL_ENCODE: z
    .enum(["true", "false", "1", "0", ""])
    .optional()
    .default("true")
    .transform((v) => v === "" || v === "true" || v === "1"),
  /**
   * Mac publisher: after R2 upload, POST metadata here (GCE API base URL).
   * Empty on GCE itself.
   */
  PUBLISH_TARGET_URL: z.string().optional().default(""),
  PUBLISH_TARGET_EMAIL: z.string().optional().default(""),
  PUBLISH_TARGET_PASSWORD: z.string().optional().default(""),
  SEED_USER_1_EMAIL: z.string().email(),
  SEED_USER_1_PASSWORD: z.string().min(8),
  SEED_USER_1_NAME: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
