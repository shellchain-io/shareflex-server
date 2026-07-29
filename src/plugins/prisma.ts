import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { createPrismaClient, type PrismaClient } from "../lib/prisma.js";
import type { Env } from "../lib/env.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
    config: Env;
    mediaRoot: string;
  }
}

const prismaPlugin: FastifyPluginAsync<{
  config: Env;
  mediaRoot: string;
}> = async (app, opts) => {
  const prisma = createPrismaClient(opts.config.DATABASE_URL);
  app.decorate("prisma", prisma);
  app.decorate("config", opts.config);
  app.decorate("mediaRoot", opts.mediaRoot);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
};

export default fp(prismaPlugin, { name: "prisma-plugin" });
