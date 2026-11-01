import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

test("browser builds accept the first-party API path and reject localhost or cross-site API targets", async () => {
  const { resolveConfig } = await import("vite");
  const previous = process.env.VITE_API_URL;
  const config = { root: resolve("apps/web"), logLevel: "silent" as const };
  try {
    process.env.VITE_API_URL = "/api/v1";
    const valid = await resolveConfig(config, "build");
    assert.equal(valid.define?.["import.meta.env.VITE_API_URL"], '"/api/v1"');
    for (const target of [
      "http://localhost:3000/api/v1",
      "https://securegate-002.onrender.com/api/v1",
    ]) {
      process.env.VITE_API_URL = target;
      await assert.rejects(resolveConfig(config, "build"), /VITE_API_URL must be/);
    }
  } finally {
    if (previous === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = previous;
  }
});
