import type { FastifyInstance, FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "@fastify/type-provider-zod";
import { z } from "zod";
import {
  authTokensSchema,
  errorSchema,
  loginBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  registerBodySchema,
  userPublicSchema,
} from "../schemas/api.js";
import {
  createRefreshToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "../lib/security.js";

const zVoid = z.undefined();

type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

async function issueSession(
  app: FastifyInstance,
  reply: FastifyReply,
  user: AuthUser,
  deviceName: string | undefined,
  platform: "ios" | "macos" | "unknown",
) {
  let deviceId: string | undefined;
  if (deviceName) {
    const device = await app.prisma.device.create({
      data: {
        userId: user.id,
        name: deviceName,
        platform,
      },
    });
    deviceId = device.id;
  }

  const refreshToken = createRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + app.config.REFRESH_TOKEN_TTL_DAYS);

  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      deviceId: deviceId ?? null,
      refreshTokenHash: hashToken(refreshToken),
      expiresAt,
    },
  });

  const accessToken = await reply.jwtSign({
    sub: user.id,
    email: user.email,
    role: user.role,
    sid: session.id,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: app.config.ACCESS_TOKEN_TTL,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/v1/auth/login",
    {
      schema: {
        body: loginBodySchema,
        response: {
          200: authTokensSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password, deviceName, platform } = request.body;
      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({
          error: "invalid_credentials",
          message: "Email or password is incorrect.",
        });
      }

      return issueSession(app, reply, user, deviceName, platform);
    },
  );

  app.post(
    "/v1/auth/register",
    {
      schema: {
        body: registerBodySchema,
        response: {
          201: authTokensSchema,
          409: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const { email, password, displayName, deviceName, platform } = request.body;
      const existing = await app.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({
          error: "email_taken",
          message: "An account with this email already exists.",
        });
      }

      const user = await app.prisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(password),
          displayName,
          role: "viewer",
        },
      });

      const tokens = await issueSession(app, reply, user, deviceName, platform);
      return reply.code(201).send(tokens);
    },
  );

  app.post(
    "/v1/auth/refresh",
    {
      schema: {
        body: refreshBodySchema,
        response: {
          200: authTokensSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const tokenHash = hashToken(request.body.refreshToken);
      const session = await app.prisma.session.findFirst({
        where: {
          refreshTokenHash: tokenHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        include: { user: true },
      });

      if (!session) {
        return reply.code(401).send({
          error: "invalid_refresh_token",
          message: "Refresh token is invalid or expired.",
        });
      }

      const nextRefreshToken = createRefreshToken();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + app.config.REFRESH_TOKEN_TTL_DAYS);

      await app.prisma.session.update({
        where: { id: session.id },
        data: {
          refreshTokenHash: hashToken(nextRefreshToken),
          expiresAt,
        },
      });

      const accessToken = await reply.jwtSign({
        sub: session.user.id,
        email: session.user.email,
        role: session.user.role,
        sid: session.id,
      });

      return {
        accessToken,
        refreshToken: nextRefreshToken,
        expiresIn: app.config.ACCESS_TOKEN_TTL,
        user: {
          id: session.user.id,
          email: session.user.email,
          displayName: session.user.displayName,
          role: session.user.role,
        },
      };
    },
  );

  app.post(
    "/v1/auth/logout",
    {
      schema: {
        body: logoutBodySchema,
        response: {
          204: zVoid,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (request.body.refreshToken) {
        await app.prisma.session.updateMany({
          where: {
            refreshTokenHash: hashToken(request.body.refreshToken),
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      } else {
        try {
          await request.jwtVerify();
          await app.prisma.session.updateMany({
            where: {
              id: request.user.sid,
              revokedAt: null,
            },
            data: { revokedAt: new Date() },
          });
        } catch {
          return reply.code(401).send({
            error: "unauthorized",
            message: "Refresh token or access token required to logout.",
          });
        }
      }

      return reply.code(204).send();
    },
  );

  app.get(
    "/v1/me",
    {
      onRequest: [app.authenticate],
      schema: {
        response: {
          200: userPublicSchema,
          401: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const user = await app.prisma.user.findUnique({
        where: { id: request.user.sub },
      });
      if (!user) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "User no longer exists.",
        });
      }
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      };
    },
  );
};

export default authRoutes;
