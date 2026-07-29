import "dotenv/config";
import { loadEnv } from "./lib/env.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadEnv();
  const app = await buildApp(config);

  try {
    await app.listen({
      host: config.HOST,
      port: config.PORT,
    });
    app.log.info(
      `ShareFlex API listening on http://${config.HOST}:${config.PORT}`,
    );
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
