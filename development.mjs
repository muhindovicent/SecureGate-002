/** Primary file 5: portable, noninteractive local development orchestration. */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, options = {}) {
  const p = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`${command} failed (${p.status})`);
}
function load() {
  if (!existsSync(".env")) throw new Error("Run npm run setup first.");
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const localData = resolve(".local/postgres");
function postgresBinary(name) {
  return join(
    process.env.LOCAL_POSTGRES_BIN,
    name + (process.platform === "win32" ? ".exe" : ""),
  );
}
function startLocalDatabase(initialize = false) {
  const url = new URL(process.env.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Local PostgreSQL requires a loopback DATABASE_URL.");
  if (!existsSync(join(localData, "PG_VERSION"))) {
    if (!initialize) throw new Error("Run npm run setup -- --local-db first.");
    mkdirSync(".local", { recursive: true });
    const passwordFile = resolve(".local/.postgres-password");
    writeFileSync(passwordFile, decodeURIComponent(url.password) + "\n", {
      mode: 0o600,
    });
    try {
      run(postgresBinary("initdb"), [
        "-D",
        localData,
        "-U",
        decodeURIComponent(url.username),
        "--encoding=UTF8",
        "--locale=C",
        "--auth=scram-sha-256",
        `--pwfile=${passwordFile}`,
      ]);
    } finally {
      unlinkSync(passwordFile);
    }
  }
  const status = spawnSync(
    postgresBinary("pg_ctl"),
    ["-D", localData, "status"],
    { stdio: "ignore" },
  );
  if (status.error) throw status.error;
  if (status.status !== 0)
    run(postgresBinary("pg_ctl"), [
      "-D",
      localData,
      "-l",
      resolve(".local/postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${url.port || "5433"}`,
      "-w",
      "start",
    ]);
  if (initialize) {
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database))
      throw new Error("Invalid local database name.");
    const args = [
      "-h",
      "127.0.0.1",
      "-p",
      url.port || "5433",
      "-U",
      decodeURIComponent(url.username),
      "-d",
      "postgres",
      "-w",
      "-v",
      "ON_ERROR_STOP=1",
    ];
    const env = {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
    };
    const check = spawnSync(
      postgresBinary("psql"),
      [
        ...args,
        "-tAc",
        `SELECT 1 FROM pg_database WHERE datname='${database}'`,
      ],
      { env, encoding: "utf8" },
    );
    if (check.error) throw check.error;
    if (check.status !== 0) throw new Error(check.stderr);
    if (check.stdout.trim() !== "1")
      run(
        postgresBinary("psql"),
        [...args, "-c", `CREATE DATABASE "${database}"`],
        { env },
      );
  }
}
const task = process.argv[2];
if (task === "setup") {
  const local = process.argv.includes("--local-db");
  if (!existsSync(".env")) {
    const bin =
      local &&
      (process.env.PG_BIN ||
        (process.platform === "win32"
          ? ["18", "17", "16"]
              .map((version) =>
                join(
                  process.env.ProgramFiles || "C:\\Program Files",
                  "PostgreSQL",
                  version,
                  "bin",
                ),
              )
              .find((path) => existsSync(join(path, "pg_ctl.exe")))
          : undefined));
    if (local && !bin)
      throw new Error(
        "Set PG_BIN to your PostgreSQL bin directory, then retry setup --local-db.",
      );
    const password = randomBytes(24).toString("hex");
    writeFileSync(
      ".env",
      `DATABASE_URL=postgresql://securegate:${password}@127.0.0.1:${local ? "5433" : "5432"}/securegate?schema=public\nPOSTGRES_PASSWORD=${password}\nCREDENTIAL_KEY=${randomBytes(32).toString("hex")}\nAPP_ORIGIN=http://localhost:5173\nINSTITUTION_NAME=Demo University\nPORT=3000\nNODE_ENV=development\n${local ? `LOCAL_POSTGRES_BIN=${bin}\n` : ""}`,
      { mode: 0o600 },
    );
  }
  load();
  if (local && !process.env.LOCAL_POSTGRES_BIN)
    throw new Error(
      "Existing .env uses another database. Configure DATABASE_URL and LOCAL_POSTGRES_BIN for local PostgreSQL first.",
    );
  if (process.env.LOCAL_POSTGRES_BIN) startLocalDatabase(true);
  else
    run("docker", [
      "compose",
      "-f",
      "infrastructure.yml",
      "up",
      "-d",
      "--wait",
    ]);
  run(npm, ["run", "db:generate"]);
  run(npm, ["run", "db:migrate"]);
  run(npm, ["run", "db:seed"]);
  console.log(
    "Setup complete. Individual synthetic account credentials are in .local/accounts.json. Do not share or commit this file.",
  );
} else if (task === "dev") {
  load();
  if (process.env.LOCAL_POSTGRES_BIN) startLocalDatabase();
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
} else if (task === "db:stop") {
  load();
  if (process.env.LOCAL_POSTGRES_BIN)
    run(postgresBinary("pg_ctl"), [
      "-D",
      localData,
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
  else run("docker", ["compose", "-f", "infrastructure.yml", "stop"]);
} else if (task === "accounts") {
  load();
  const accounts = JSON.parse(readFileSync(".local/accounts.json", "utf8"));
  console.table(accounts);
} else {
  console.log(
    "Usage: node development.mjs setup [--local-db]|dev|accounts|db:stop",
  );
}
