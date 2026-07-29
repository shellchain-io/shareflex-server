import "dotenv/config";
import { loadEnv } from "../src/lib/env.js";
import { createPrismaClient } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/security.js";

/** Legacy seeded viewer — removed now that create-account is available. */
const LEGACY_VIEWER_EMAIL = "user1@shareflex.local";

async function seed() {
  const config = loadEnv();
  const prisma = createPrismaClient(config.DATABASE_URL);

  const removed = await prisma.user.deleteMany({
    where: { email: LEGACY_VIEWER_EMAIL },
  });
  if (removed.count > 0) {
    console.log(`Removed legacy viewer ${LEGACY_VIEWER_EMAIL}`);
  }

  const passwordHash = await hashPassword(config.SEED_USER_1_PASSWORD);
  await prisma.user.upsert({
    where: { email: config.SEED_USER_1_EMAIL },
    create: {
      email: config.SEED_USER_1_EMAIL,
      passwordHash,
      displayName: config.SEED_USER_1_NAME,
      role: "owner",
    },
    update: {
      passwordHash,
      displayName: config.SEED_USER_1_NAME,
      role: "owner",
    },
  });
  console.log(`Seeded user ${config.SEED_USER_1_EMAIL} (owner)`);

  // Demo movie metadata only — Phase 3 will attach real HLS assets.
  const demo = await prisma.movie.upsert({
    where: { id: "demo-ready-movie" },
    create: {
      id: "demo-ready-movie",
      title: "ShareFlex Demo Title",
      description: "Placeholder movie row for API smoke tests. Not playable until Phase 3.",
      year: 2026,
      runtimeSeconds: 7200,
      ready: false,
      contentVersion: "1",
    },
    update: {
      title: "ShareFlex Demo Title",
      description: "Placeholder movie row for API smoke tests. Not playable until Phase 3.",
    },
  });
  console.log(`Seeded movie metadata ${demo.id} (ready=${demo.ready})`);

  await prisma.$disconnect();
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
