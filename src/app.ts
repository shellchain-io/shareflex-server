import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
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

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildApp(config: Env) {
  setMediaPublicBaseUrl(config.MEDIA_PUBLIC_BASE_URL || null);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
    },
    bodyLimit: 2 * 1024 * 1024,
    // Bind expectations: localhost only when behind Tailscale Serve.
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
      fileSize: 20 * 1024 * 1024 * 1024, // 20 GB
      files: 4, // video + thumbnail (and room for future extras)
      fields: 40,
    },
  });

  await app.register(prismaPlugin, { config, mediaRoot });
  await app.register(authPlugin, { config });

  app.get("/health", async () => ({ ok: true, service: "shareflex-server" }));

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
