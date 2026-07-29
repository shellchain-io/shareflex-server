import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { safeResolveUnderRoot } from "../lib/movies.js";

function contentTypeForExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".m3u8") {
    return "application/vnd.apple.mpegurl";
  }
  if (ext === ".ts") {
    return "video/mp2t";
  }
  if (ext === ".m4s") {
    return "video/iso.segment";
  }
  if (ext === ".mp4") {
    return "video/mp4";
  }
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

const mediaRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/v1/media/movies/:movieId/poster",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { movieId } = request.params as { movieId: string };
      const movie = await app.prisma.movie.findUnique({ where: { id: movieId } });
      if (!movie?.posterPath) {
        return reply.code(404).send({ error: "not_found", message: "Poster missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, movie.posterPath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Poster file missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/movies/:movieId/hls/*",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const params = request.params as { movieId: string; "*": string };
      const movie = await app.prisma.movie.findUnique({
        where: { id: params.movieId },
        include: { assets: true },
      });
      if (!movie?.ready) {
        return reply.code(404).send({ error: "not_found", message: "Movie not found." });
      }

      const master = movie.assets.find((asset) => asset.kind === "master");
      if (!master) {
        return reply.code(404).send({ error: "not_found", message: "HLS master missing." });
      }

      const masterDir = path.dirname(master.relativePath);
      const relativeRequest = params["*"] || "master.m3u8";
      const filePath = safeResolveUnderRoot(app.mediaRoot, masterDir, relativeRequest);
      if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
        return reply.code(404).send({ error: "not_found", message: "Media segment missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/movies/:movieId/subtitles/:subtitleId",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { movieId, subtitleId } = request.params as {
        movieId: string;
        subtitleId: string;
      };
      const track = await app.prisma.subtitleTrack.findFirst({
        where: { id: subtitleId, movieId },
      });
      if (!track) {
        return reply.code(404).send({ error: "not_found", message: "Subtitle missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, track.relativePath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Subtitle file missing." });
      }

      return reply.type("text/vtt").send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/shows/:showId/poster",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { showId } = request.params as { showId: string };
      const show = await app.prisma.show.findUnique({ where: { id: showId } });
      if (!show?.posterPath) {
        return reply.code(404).send({ error: "not_found", message: "Poster missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, show.posterPath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Poster file missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/seasons/:seasonId/poster",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { seasonId } = request.params as { seasonId: string };
      const season = await app.prisma.season.findUnique({ where: { id: seasonId } });
      if (!season?.posterPath) {
        return reply.code(404).send({ error: "not_found", message: "Poster missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, season.posterPath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Poster file missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/episodes/:episodeId/poster",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { episodeId } = request.params as { episodeId: string };
      const episode = await app.prisma.episode.findUnique({ where: { id: episodeId } });
      if (!episode?.posterPath) {
        return reply.code(404).send({ error: "not_found", message: "Poster missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, episode.posterPath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Poster file missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/episodes/:episodeId/hls/*",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const params = request.params as { episodeId: string; "*": string };
      const episode = await app.prisma.episode.findUnique({
        where: { id: params.episodeId },
        include: { assets: true },
      });
      if (!episode?.ready) {
        return reply.code(404).send({ error: "not_found", message: "Episode not found." });
      }

      const master = episode.assets.find((asset) => asset.kind === "master");
      if (!master) {
        return reply.code(404).send({ error: "not_found", message: "HLS master missing." });
      }

      const masterDir = path.dirname(master.relativePath);
      const relativeRequest = params["*"] || "master.m3u8";
      const filePath = safeResolveUnderRoot(app.mediaRoot, masterDir, relativeRequest);
      if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
        return reply.code(404).send({ error: "not_found", message: "Media segment missing." });
      }

      return reply.type(contentTypeForExt(filePath)).send(createReadStream(filePath));
    },
  );

  app.get(
    "/v1/media/episodes/:episodeId/subtitles/:subtitleId",
    { onRequest: [app.authenticate] },
    async (request, reply) => {
      const { episodeId, subtitleId } = request.params as {
        episodeId: string;
        subtitleId: string;
      };
      const track = await app.prisma.episodeSubtitleTrack.findFirst({
        where: { id: subtitleId, episodeId },
      });
      if (!track) {
        return reply.code(404).send({ error: "not_found", message: "Subtitle missing." });
      }

      const filePath = safeResolveUnderRoot(app.mediaRoot, track.relativePath);
      if (!filePath || !existsSync(filePath)) {
        return reply.code(404).send({ error: "not_found", message: "Subtitle file missing." });
      }

      return reply.type("text/vtt").send(createReadStream(filePath));
    },
  );
};

export default mediaRoutes;
