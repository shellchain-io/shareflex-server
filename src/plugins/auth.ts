import fp from "fastify-plugin";
import fjwt from "@fastify/jwt";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../lib/env.js";

export type AccessTokenPayload = {
  sub: string;
  email: string;
  role: string;
  sid: string;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync<{ config: Env }> = async (app, opts) => {
  await app.register(fjwt, {
    secret: opts.config.JWT_SECRET,
    sign: {
      expiresIn: opts.config.ACCESS_TOKEN_TTL,
    },
  });

  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Allow AVPlayer / image clients to pass JWT as query when headers are awkward.
      const query = request.query as { access_token?: unknown };
      if (
        typeof query.access_token === "string" &&
        query.access_token.length > 0 &&
        !request.headers.authorization
      ) {
        request.headers.authorization = `Bearer ${query.access_token}`;
      }
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Valid access token required.",
      });
    }
  });

  app.decorate("requireOwner", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (reply.sent) {
      return;
    }
    if (request.user.role !== "owner") {
      return reply.code(403).send({
        error: "forbidden",
        message: "Owner access required.",
      });
    }
  });
};

export default fp(authPlugin, { name: "auth-plugin" });
