/** Real HTTPS + PostgreSQL authentication through the same-origin deployment proxy. */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { chromium, webkit, devices } from "playwright";
import * as OTPAuth from "otpauth";
import pg from "pg";

const host = "app.securegate.test";
const origin = `https://${host}`;
const databaseName = "sg_test_" + randomBytes(6).toString("hex");
const directory = resolve(".local", databaseName);
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/" + databaseName;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  APP_ORIGIN: origin,
  LOCAL_ACCOUNTS_PATH: resolve(directory, "accounts.json"),
  DEPLOYMENT_MODE: "web-preview",
  NODE_ENV: "production",
  PORT: "0",
};
const run = (command, args, childEnv = env) => new Promise((done, fail) => {
  const child = spawn(command, args, { stdio: "inherit", env: childEnv });
  child.on("error", fail);
  child.on("exit", (code) => code === 0 ? done() : fail(new Error(`${command} exited ${code}`)));
});
const listen = (server) => new Promise((done, fail) => {
  server.once("error", fail);
  server.listen(0, "127.0.0.1", done);
});
const sockets = new Set();
const track = (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
};
let created = false, api, db, frontend, tunnel, browser;
await admin.connect();
try {
  mkdirSync(directory, { recursive: true });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  await run(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"]);
  await run(process.execPath, ["apps/api/dist/backend.js", "seed"], { ...env, NODE_ENV: "development" });

  const openssl = process.env.OPENSSL_EXECUTABLE ||
    (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
  const keyFile = resolve(directory, "test.key");
  const certFile = resolve(directory, "test.crt");
  const confFile = resolve(directory, "openssl.cnf");
  writeFileSync(confFile, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=${host}\n[v3]\nsubjectAltName=DNS:${host}\n`);
  await run(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-noenc", "-days", "1", "-config", confFile, "-keyout", keyFile, "-out", certFile]);

  Object.assign(process.env, env);
  const backend = createRequire(import.meta.url)("../apps/api/dist/backend.js");
  db = backend.db;
  api = await backend.start();
  const apiPort = api.getHttpServer().address().port;
  const rootConfig = JSON.parse(readFileSync("vercel.json", "utf8"));
  const nestedConfig = JSON.parse(readFileSync("apps/web/vercel.json", "utf8"));
  assert.deepEqual(rootConfig.rewrites, nestedConfig.rewrites);
  assert.equal(rootConfig.rewrites[0].source, "/api/:path*");
  assert.equal(rootConfig.rewrites[0].destination, "https://securegate-002.onrender.com/api/:path*");
  assert.equal(rootConfig.rewrites[1].destination, "/index.html");

  const dist = resolve("apps/web/dist");
  let backendUnavailable = false;
  frontend = httpsServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    if (req.url.startsWith("/api/")) {
      if (backendUnavailable) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        return res.end("Backend unavailable");
      }
      // Model Vercel's first rewrite without changing Origin, Cookie or Set-Cookie.
      const upstream = request(`http://127.0.0.1:${apiPort}${req.url}`, {
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
      }, (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
      return;
    }
    const path = decodeURIComponent(new URL(req.url, origin).pathname);
    let file = resolve(dist, "." + path);
    if (!file.startsWith(dist + sep) || !existsSync(file) || path === "/")
      file = resolve(dist, "index.html");
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[extname(file)];
    res.writeHead(200, { "Content-Type": type || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  });
  frontend.on("connection", track);
  await listen(frontend);

  // A CONNECT proxy gives both real browser engines the same public-looking DNS name.
  // The application never sees a localhost URL; only this isolated test transport does.
  tunnel = httpServer((_, res) => { res.writeHead(403); res.end(); });
  tunnel.on("connection", track);
  tunnel.on("connect", (req, socket, head) => {
    if (req.url !== `${host}:443`) return socket.destroy();
    const upstream = connect(frontend.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
  });
  await listen(tunnel);

  const preflight = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/login`, {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-csrf-token" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");

  const registrar = await db.user.findFirstOrThrow({ where: { role: "REGISTRAR" } });
  async function makeStudent() {
    const number = String(randomInt(100000, 1000000000));
    const password = randomBytes(24).toString("base64url");
    const user = await db.user.create({ data: { email: `mt${number}@student.cavendish.ac.ug`, name: "Mobile student (synthetic)", role: "STUDENT", passwordHash: backend.hashPassword(password) } });
    const student = await db.student.create({ data: { userId: user.id, registration: number, program: "Test", identityVerifiedAt: new Date(), identityVerifiedBy: registrar.id } });
    return { user, student, password };
  }
  const other = await makeStudent();
  const privateGadget = await db.gadget.create({ data: { studentId: other.student.id, category: "Laptop", manufacturer: "Private", model: "Other student", serial: randomBytes(8).toString("hex") } });
  const cases = [
    { name: "Desktop Chromium", engine: chromium, device: devices["Desktop Chrome"] },
    { name: "Android Chrome", engine: chromium, device: devices["Pixel 7"] },
    { name: "iPhone Safari (WebKit)", engine: webkit, device: devices["iPhone 13"] },
  ];
  async function logout(page) {
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    const menu = page.getByRole("button", { name: "Open navigation" });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
  }
  for (const item of cases) {
    const account = await makeStudent();
    browser = await item.engine.launch({
      headless: true,
      proxy: { server: `http://127.0.0.1:${tunnel.address().port}` },
      ...(item.engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ ...item.device, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(origin + "/login");
    const identifier = page.getByLabel("Student ID or university email");
    assert.equal(await identifier.getAttribute("autocomplete"), "username");
    assert.equal(await identifier.getAttribute("autocapitalize"), "none");
    await identifier.fill(account.student.registration);
    await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await page.getByText("Invalid credentials or student identity awaiting registrar verification").waitFor();
    const loginResponse = page.waitForResponse((r) => r.url().endsWith("/auth/login") && r.status() === 201);
    await page.getByLabel("Student ID or university email").fill(account.user.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    const cookieHeader = await (await loginResponse).headerValue("set-cookie");
    assert.match(cookieHeader, /;\s*HttpOnly/i);
    assert.match(cookieHeader, /;\s*Secure/i);
    assert.match(cookieHeader, /;\s*SameSite=Strict/i);
    assert.doesNotMatch(cookieHeader, /;\s*Domain=/i);
    const cookie = (await context.cookies(origin + "/api/v1/me")).find((c) => c.name === "sg_session");
    assert.ok(cookie?.httpOnly && cookie.secure);
    // Windows WebKit's cookie inspection API reports None even for explicit Strict.
    // Verify the actual response attribute above on every engine, and native metadata where supported.
    if (item.engine !== webkit || process.platform !== "win32") assert.equal(cookie.sameSite, "Strict");
    assert.equal(cookie.domain, host);
    assert.equal(cookie.path, "/api");
    await page.goto(origin + "/student/profile");
    await page.getByRole("heading", { name: "My profile", exact: true }).waitFor();
    assert.ok((await page.locator(".profile-fields").textContent()).includes(account.student.registration));
    await page.reload();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    const me = await page.evaluate(() => fetch("/api/v1/me").then((r) => r.json()));
    assert.equal(me.user.id, account.user.id);
    const gadgets = await page.evaluate((id) => fetch("/api/v1/gadgets?studentId=" + id).then((r) => r.json()), other.student.id);
    assert.equal(gadgets.some((g) => g.id === privateGadget.id), false);
    const forged = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/logout`, {
      method: "POST", headers: { origin: "https://evil.invalid", cookie: `sg_session=${cookie.value}`, "x-csrf-token": me.csrf },
    });
    assert.equal(forged.status, 403);
    const missingCsrf = await fetch(`http://127.0.0.1:${apiPort}/api/v1/auth/logout`, {
      method: "POST", headers: { origin, cookie: `sg_session=${cookie.value}` },
    });
    assert.equal(missingCsrf.status, 403);
    await page.goto(origin + "/admin/users");
    await page.getByRole("heading", { name: "Access restricted" }).waitFor();
    await page.goto(origin + "/student/dashboard");
    await logout(page);
    await page.getByRole("heading", { name: "Welcome back" }).waitFor();
    assert.equal((await context.cookies(origin + "/api/v1/me")).some((c) => c.name === "sg_session"), false);

    // Exercise the real second factor and recovery-session rotation on every engine.
    const password = randomBytes(24).toString("base64url");
    const email = `audit-${randomBytes(8).toString("hex")}@test.invalid`;
    await db.user.create({ data: { email, name: "Mobile auditor (synthetic)", role: "AUDITOR", passwordHash: backend.hashPassword(password) } });
    await page.getByLabel("Student ID or university email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await page.getByRole("heading", { name: "Set up account protection" }).waitFor();
    assert.equal(await page.evaluate(() => fetch("/api/v1/audit-events").then((r) => r.status)), 403);
    await page.getByRole("button", { name: "Set up authenticator", exact: true }).click();
    const setup = await page.getByLabel("Authenticator setup key").textContent();
    await page.getByLabel("Six-digit authenticator code").fill(new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup) }).generate());
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await page.getByRole("heading", { name: "Save your recovery codes" }).waitFor();
    const recovery = await page.locator(".recovery-grid code").first().textContent();
    await page.getByRole("button", { name: "I’ve saved my recovery codes" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    assert.equal(await page.evaluate(() => fetch("/api/v1/students").then((r) => r.status)), 403);
    await logout(page);
    await page.getByLabel("Student ID or university email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await page.getByRole("heading", { name: "Verify it’s you" }).waitFor();
    const partial = (await context.cookies(origin + "/api/v1/me")).find((c) => c.name === "sg_session");
    await page.getByLabel("Authenticator or recovery code").fill(recovery);
    await page.getByRole("button", { name: "Verify & continue" }).click();
    await page.getByRole("button", { name: "Sign out" }).waitFor();
    const full = (await context.cookies(origin + "/api/v1/me")).find((c) => c.name === "sg_session");
    assert.notEqual(full.value, partial.value);
    await logout(page);

    backendUnavailable = true;
    await page.getByLabel("Student ID or university email").fill(account.user.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in securely" }).click();
    await page.getByText(/SecureGate API is unavailable \(HTTP 502\)/).waitFor();
    backendUnavailable = false;
    assert.deepEqual(errors, []);
    assert.ok(requests.every((r) => new URL(r).origin === origin), "Browser requests must remain on the HTTPS frontend origin");
    await browser.close();
    browser = undefined;
    console.log(`PASS ${item.name}: first-party Secure/HttpOnly/Strict cookies, reload, logout, MFA/recovery, CSRF, RBAC, student isolation, and outage feedback`);
  }
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  if (frontend) await new Promise((done) => frontend.close(done));
  if (tunnel) await new Promise((done) => tunnel.close(done));
  await api?.close();
  await db?.$disconnect();
  if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
}
