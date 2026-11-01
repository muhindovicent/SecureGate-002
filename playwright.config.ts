import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
if (
  !process.env.DATABASE_URL ||
  !/^\/sg_test_/.test(new URL(process.env.DATABASE_URL).pathname) ||
  !process.env.LOCAL_ACCOUNTS_PATH
)
  throw new Error("Run npm run test:browser to use an isolated test database.");
export default defineConfig({
  testDir: "tests",
  testMatch: "browser.spec.ts",
  timeout: 90000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    headless: true,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: process.env.CI ? [] : ["--no-sandbox"],
    },
    screenshot: "off",
    trace: "off",
  },
  webServer: {
    command: "node tests/browser-server.mjs",
    url: "http://localhost:5174/api/v1/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
