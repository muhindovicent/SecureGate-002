/** Single-process built servers avoid nested npm/watch startup on Windows. */
import "dotenv/config";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { preview } from "vite";

if (
  !process.env.DATABASE_URL ||
  !/^\/sg_test_/.test(new URL(process.env.DATABASE_URL).pathname) ||
  !process.env.LOCAL_ACCOUNTS_PATH ||
  process.env.APP_ORIGIN !== "http://localhost:5174"
)
  throw new Error("Run npm run test:browser with its isolated test database.");

const { db, start } = createRequire(import.meta.url)(
  "../apps/api/dist/backend.js",
);
let api, web;
async function stop() {
  if (web) {
    await new Promise((done) => {
      web.httpServer.close(done);
      web.httpServer.closeAllConnections();
    });
  }
  await api?.close();
  await db.$disconnect();
}
try {
  api = await start();
  web = await preview({
    root: resolve("apps/web"),
    preview: { port: 5174, host: "127.0.0.1", strictPort: true },
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stop().then(() => process.exit(0));
    });
} catch (error) {
  await stop();
  throw error;
}
