import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import type { Env } from "./lib/env.js";
import { resolveMediaRoot } from "./lib/movies.js";
import { setMediaPublicBaseUrl } from "./lib/media-public.js";
import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import movieRoutes from "./routes/movies.js";
import showRoutes from "./routes/shows.js";
import progressRoutes from "./routes/progress.js";
import libraryRoutes from "./routes/library.js";
import mediaRoutes from "./routes/media.js";
import adminRoutes from "./routes/admin.js";

/** Works for both `tsx src/…` and `node dist/src/…`. */
function resolveServerRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, "public", "admin"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const serverRoot = resolveServerRoot();

export async function buildApp(config: Env) {
  setMediaPublicBaseUrl(config.MEDIA_PUBLIC_BASE_URL || null);

  const app = Fastify({
    logger: {
      // GCE: use LOG_LEVEL=warn so routine traffic never fills the disk.
      level: config.LOG_LEVEL,
    },
    // Never auto-log every request (health/progress spam filled journald → SSH died).
    disableRequestLogging: true,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const mediaRoot = resolveMediaRoot(config.MEDIA_ROOT);

  await app.register(cors, {
    origin: false,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024 * 1024,
      files: 4,
      fields: 40,
    },
  });

  await app.register(prismaPlugin, { config, mediaRoot });
  await app.register(authPlugin, { config });

  app.get("/health", async () => ({ ok: true, service: "shareflex-server" }));

  // Safari password manager may navigate here after autofill — send them back to admin.
  app.get("/.well-known/change-password", async (_request, reply) =>
    reply.redirect("/admin/"),
  );

  await app.register(authRoutes);
  await app.register(movieRoutes);
  await app.register(showRoutes);
  await app.register(progressRoutes);
  await app.register(libraryRoutes);
  await app.register(mediaRoutes);
  await app.register(adminRoutes);

  await app.register(fastifyStatic, {
    root: path.join(serverRoot, "public", "admin"),
    prefix: "/admin/",
  });

  app.get("/admin", async (_request, reply) => reply.redirect("/admin/"));

  return app;
}
