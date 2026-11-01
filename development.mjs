/** Primary file 5: portable, noninteractive local development orchestration. */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args) {
  const p = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (p.status !== 0) process.exit(p.status || 1);
}
function load() {
  if (!existsSync(".env")) throw new Error("Run npm run setup first.");
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const task = process.argv[2];
if (task === "setup") {
  if (!existsSync(".env")) {
    const password = randomBytes(24).toString("hex");
    writeFileSync(
      ".env",
      `DATABASE_URL=postgresql://securegate:${password}@localhost:5432/securegate?schema=public\nPOSTGRES_PASSWORD=${password}\nCREDENTIAL_KEY=${randomBytes(32).toString("hex")}\nAPP_ORIGIN=http://localhost:5173\nINSTITUTION_NAME=Demo University\nPORT=3000\nNODE_ENV=development\n`,
      { mode: 0o600 },
    );
  }
  load();
  run("docker", ["compose", "-f", "infrastructure.yml", "up", "-d", "--wait"]);
  run(npm, ["run", "db:generate"]);
  run(npm, ["run", "db:migrate"]);
  run(npm, ["run", "db:seed"]);
  console.log(
    "Setup complete. Individual synthetic account credentials are in .local/accounts.json. Do not share or commit this file.",
  );
} else if (task === "dev") {
  load();
  const children = ["@securegate/api", "@securegate/web"].map((w) =>
    spawn(npm, ["run", "dev", "--workspace", w], {
      stdio: "inherit",
      shell: process.platform === "win32",
    }),
  );
  const stop = () => {
    for (const p of children) p.kill();
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  for (const p of children)
    p.on("exit", (code) => {
      stop();
      process.exit(code || 0);
    });
} else if (task === "accounts") {
  load();
  const accounts = JSON.parse(readFileSync(".local/accounts.json", "utf8"));
  console.table(accounts);
} else {
  console.log("Usage: node development.mjs setup|dev|accounts");
}
