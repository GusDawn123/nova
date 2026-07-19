import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

/**
 * Server entrypoint: parse env (exits on invalid), build the app, then bind.
 */
const env = loadEnv();
const app = buildApp();

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
