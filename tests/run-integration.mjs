import "dotenv/config";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
const browser = process.argv[2] === "browser";
const root = new URL(process.env.DATABASE_URL);
const dbName = "sg_test_" + randomBytes(6).toString("hex");
const admin = new pg.Client({ connectionString: root.toString() });
await admin.connect();
const testUrl = new URL(root);
testUrl.pathname = "/" + dbName;
const accountDirectory = resolve(".local", dbName);
const testEnv = {
  ...process.env,
  DATABASE_URL: testUrl.toString(),
  PORT: browser ? "3002" : "3001",
  ...(browser
    ? {
        APP_ORIGIN: "http://localhost:5174",
        WEB_PORT: "5174",
        LOCAL_ACCOUNTS_PATH: resolve(accountDirectory, "accounts.json"),
      }
    : {}),
};
function run(command, args) {
  const r = spawnSync(command, args, {
    stdio: "inherit",
    env: testEnv,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw new Error("Test command failed");
}
let created = false;
try {
  await admin.query(`CREATE DATABASE "${dbName}"`);
  created = true;
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  run(npx, ["prisma", "migrate", "deploy"]);
  if (browser) {
    run(npx, [
      "tsx",
      "--tsconfig",
      "apps/api/tsconfig.json",
      "apps/api/backend.ts",
      "seed",
    ]);
    run(npx, ["playwright", "test"]);
  } else
    run(npx, [
      "tsx",
      "--tsconfig",
      "apps/api/tsconfig.json",
      "--test",
      "tests/integration.ts",
    ]);
} finally {
  // Only remove the random test database successfully created by this runner.
  if (created) await admin.query(`DROP DATABASE "${dbName}" WITH (FORCE)`);
  await admin.end();
  if (browser) rmSync(accountDirectory, { recursive: true, force: true });
}
