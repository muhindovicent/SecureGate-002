/** Primary file 2: NestJS modular-monolith API. Split services here as the pilot grows. */
import "reflect-metadata";
import "dotenv/config";
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Res,
  Module,
  HttpException,
  Catch,
  ArgumentsHost,
  ExceptionFilter,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule, ApiTags } from "@nestjs/swagger";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  Prisma,
  Role,
  User,
  Session,
  AuthStage,
  Student,
} from "@prisma/client";
import {
  randomBytes,
  randomInt,
  randomUUID,
  createHash,
  createHmac,
  scryptSync,
  scrypt,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import * as OTPAuth from "otpauth";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { Request, Response } from "express";
import { z, ZodError } from "zod";

export const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const key = process.env.CREDENTIAL_KEY;
const production = process.env.NODE_ENV === "production";
export function resolveWebOrigin(env: NodeJS.ProcessEnv = process.env) {
  const hosted = env.NODE_ENV === "production" || env.RENDER === "true";
  const configured = env.APP_ORIGIN?.trim();
  if (!configured) {
    if (hosted) throw new Error("APP_ORIGIN must be the public HTTPS frontend origin");
    return "http://localhost:5173";
  }
  const url = new URL(configured);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) throw new Error("APP_ORIGIN must contain only a scheme and hostname, without a path");
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host.endsWith(".localhost") ||
    host === "[::1]" || host === "0.0.0.0" || /^127\./.test(host);
  if (hosted && (url.protocol !== "https:" || loopback))
    throw new Error("Hosted APP_ORIGIN must use HTTPS and cannot point to localhost");
  return url.origin;
}
const origin = resolveWebOrigin();
const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: production || origin.startsWith("https://"),
  path: "/api",
};
const uuid = z.string().uuid();
const text = z.string().trim().min(2).max(500);
const studentNumber = z.string().trim().regex(/^\d{4,20}$/, "Use a 4–20 digit student ID number");
const universityEmail = z.string().trim().toLowerCase().pipe(z.email().max(254));
export function studentEmailMatches(number: string, email: string) {
  const match = /^([a-z][a-z._-]*)(\d{4,20})@student\.cavendish\.ac\.ug$/.exec(email);
  return !!match && match[2] === number;
}
function verifiedStudent(student: Student | null | undefined, email: string) {
  return !!student?.identityVerifiedAt && !!student.identityVerifiedBy &&
    studentEmailMatches(student.registration, email) && student.enrollment === "ACTIVE";
}
function independentStudentPassword(password: string, number: string) {
  if (password.includes(number))
    fail(400, "The password must not contain the student ID number");
}
const studentIdentity = z.object({
  registration: studentNumber,
  email: universityEmail,
  verified: z.literal(true),
}).refine((d) => studentEmailMatches(d.registration, d.email), {
  path: ["email"],
  message: "Use the student's official prefix followed by their exact ID at student.cavendish.ac.ug",
});
const roles = z.enum([
  "STUDENT",
  "OFFICER",
  "VERIFIER",
  "SUPERVISOR",
  "REGISTRAR",
  "ADMIN",
  "MANAGEMENT",
  "AUDITOR",
]);
const staffScan: Role[] = ["OFFICER", "SUPERVISOR"];
const safeUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});
const fail = (status: number, message: string): never => {
  throw new HttpException({ message }, status);
};
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash) return false;
  const b = Buffer.from(hash, "hex");
  const a = scryptSync(password, salt, 64);
  return b.length === a.length && timingSafeEqual(a, b);
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function credentialDigest(s: string) {
  if (!key || key.length < 64)
    throw new Error("CREDENTIAL_KEY must contain at least 64 characters");
  return createHmac("sha256", key).update(s).digest("hex");
}
export function transition(active: boolean, direction: "ENTRY" | "EXIT") {
  return direction === "ENTRY"
    ? active
      ? "ALREADY_INSIDE"
      : "APPROVED"
    : active
      ? "APPROVED"
      : "REVIEW_REQUIRED";
}
export function incidentTransition(from: string, to: string) {
  return (
    (
      {
        OPEN: ["UNDER_REVIEW"],
        UNDER_REVIEW: ["RESOLVED"],
        RESOLVED: ["CLOSED", "UNDER_REVIEW"],
        CLOSED: ["UNDER_REVIEW"],
      } as Record<string, string[]>
    )[from]?.includes(to) || false
  );
}
async function audit(
  tx: any,
  actorId: string | null,
  action: string,
  resourceId?: string,
  details: object = {},
) {
  await tx.audit.create({ data: { actorId, action, resourceId, details } });
}
interface Context {
  user: User;
  session: Session;
}
async function actor(
  req: Request,
  allowed?: Role[],
  allowPartial = false,
): Promise<Context> {
  const token = req.cookies?.sg_session;
  if (typeof token !== "string") fail(401, "Please sign in");
  const session = await db.session.findUnique({
    where: { id: digest(token) },
    include: { user: { include: { student: true } } },
  });
  if (!session || session.expiresAt < new Date() || !session.user.active)
    fail(401, "Session expired");
  if (session!.user.role === "STUDENT" && !verifiedStudent(session!.user.student, session!.user.email))
    fail(403, "Your student identity must be verified by the registrar before signing in");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (
      req.headers.origin !== origin ||
      req.headers["x-csrf-token"] !== session!.csrf
    )
      fail(403, "Invalid request origin or CSRF token");
  }
  if (!allowPartial && authStage(session!, session!.user) !== "FULL")
    fail(
      403,
      "Complete multi-factor authentication before accessing this resource",
    );
  if (allowed && !allowed.includes(session!.user.role))
    fail(403, "This role cannot perform that operation");
  (req as Request & { securityActorId?: string }).securityActorId =
    session!.user.id;
  return { user: session!.user, session: session! };
}
async function ownStudent(user: User) {
  const s = await db.student.findUnique({ where: { userId: user.id } });
  if (!s) fail(403, "Student profile required");
  return s!;
}
async function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 10; attempt++)
    try {
      return await db.$transaction(fn, {
        isolationLevel: "Serializable",
        timeout: 15000,
      });
    } catch (e: any) {
      if (
        (e.code === "P2034" ||
          (e.code === "P2002" && e.meta?.modelName === "Scan")) &&
        attempt < 9
      ) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(500, 8 * 2 ** attempt) + Math.random() * 30,
          ),
        );
        continue;
      }
      if (e.code === "P2034")
        fail(409, "Concurrent activity: retry the same request identifier");
      throw e;
    }
  throw new Error("Transaction retry exhausted");
}
const fakeHash = hashPassword(randomBytes(32).toString("hex"));
/** Encrypted-at-rest authenticator secrets; the key is purpose-separated from QR HMAC. */
function mfaEncryptionKey() {
  if (!key || key.length < 64)
    throw new Error("CREDENTIAL_KEY must contain at least 64 characters");
  return createHmac("sha256", key)
    .update("SecureGate/MFA/encryption/v1")
    .digest();
}
export function sealMfaSecret(secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaEncryptionKey(), nonce);
  cipher.setAAD(Buffer.from("SecureGate/MFA/v1"));
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function openMfaSecret(encrypted: string) {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted authenticator");
  const [nonce, tag, value] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", mfaEncryptionKey(), nonce);
  decipher.setAAD(Buffer.from("SecureGate/MFA/v1"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value), decipher.final()]).toString(
    "utf8",
  );
}
function qrEncryptionKey() {
  if (!key || key.length < 64) throw new Error("CREDENTIAL_KEY is required");
  return createHmac("sha256", key).update("SecureGate/QR/encryption/v1").digest();
}
export function sealQrCredential(raw: string, id: string, owner: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", qrEncryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`SecureGate/QR/v1/${id}/${owner}`));
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((b) => b.toString("base64url")).join(".");
}
export function openQrCredential(encrypted: string, id: string, owner: string) {
  const parts = encrypted.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted QR credential");
  const [nonce, tag, value] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", qrEncryptionKey(), nonce);
  decipher.setAAD(Buffer.from(`SecureGate/QR/v1/${id}/${owner}`));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value), decipher.final()]).toString("utf8");
}
export function authenticator(
  secret: string,
  label = "SecureGate",
  digits = 6,
) {
  return new OTPAuth.TOTP({
    issuer: "SecureGate",
    label,
    algorithm: "SHA1",
    digits,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
export function totpStep(secret: string, code: string, timestamp = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = authenticator(secret).validate({
    token: code,
    timestamp,
    window: 1,
  });
  return delta === null ? null : BigInt(Math.floor(timestamp / 30000) + delta);
}
const derivePassword = promisify(scrypt);
async function passwordMatches(password: string, encoded: string) {
  const [salt, hash] = encoded.split(":");
  if (!salt || !hash) return false;
  const b = Buffer.from(hash, "hex"),
    a = (await derivePassword(password, salt, 64)) as Buffer;
  return a.length === b.length && timingSafeEqual(a, b);
}
async function newPasswordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${((await derivePassword(password, salt, 64)) as Buffer).toString("hex")}`;
}
function authStage(session: Session, user: User): AuthStage {
  if (user.role !== "STUDENT" && !user.mfaSecretEncrypted)
    return "MFA_SETUP_REQUIRED";
  if (user.mfaSecretEncrypted && !session.mfaVerifiedAt) return "MFA_REQUIRED";
  return session.stage;
}
async function newSession(
  tx: Prisma.TransactionClient,
  userId: string,
  stage: AuthStage,
  mfaVerified = false,
) {
  const token = randomBytes(32).toString("hex"),
    csrf = randomBytes(32).toString("hex");
  const lifetime = stage === "FULL" ? 8 * 3600000 : 5 * 60000;
  await tx.session.create({
    data: {
      id: digest(token),
      csrf,
      userId,
      stage,
      expiresAt: new Date(Date.now() + lifetime),
      mfaVerifiedAt: mfaVerified ? new Date() : null,
    },
  });
  return { token, csrf, lifetime };
}
function sessionCookie(
  res: Response,
  session: { token: string; lifetime: number },
) {
  res.cookie("sg_session", session.token, {
    ...sessionCookieOptions,
    maxAge: session.lifetime,
  });
}
/** Atomic quotas persist across restarts and API instances. Keys contain no raw email/IP. */
async function authQuota(name: string, limit = 5, windowMs = 15 * 60000) {
  const id = digest(name);
  const rows = await db.$queryRaw<
    Array<{ count: number }>
  >`INSERT INTO "AuthThrottle" (id,count,"windowEnds") VALUES (${id},1,CURRENT_TIMESTAMP+${windowMs}*interval '1 millisecond') ON CONFLICT(id) DO UPDATE SET count=CASE WHEN "AuthThrottle"."windowEnds"<=CURRENT_TIMESTAMP THEN 1 ELSE "AuthThrottle".count+1 END,"windowEnds"=CASE WHEN "AuthThrottle"."windowEnds"<=CURRENT_TIMESTAMP THEN CURRENT_TIMESTAMP+${windowMs}*interval '1 millisecond' ELSE "AuthThrottle"."windowEnds" END RETURNING count`;
  if (rows[0].count > limit)
    fail(429, "Too many attempts. Retry after the security cooldown.");
  if (Math.random() < 0.01)
    await db.authThrottle.deleteMany({
      where: { windowEnds: { lt: new Date(Date.now() - 86400000) } },
    });
  return id;
}
async function resetQuota(id: string) {
  await db.authThrottle.deleteMany({ where: { id } });
}
async function recoveryCodes(tx: Prisma.TransactionClient, userId: string) {
  const codes = Array.from({ length: 12 }, () =>
    randomBytes(10).toString("hex"),
  );
  await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
  await tx.mfaRecoveryCode.createMany({
    data: codes.map((code) => ({
      userId,
      digest: digest("SecureGate/recovery/v1/" + code),
    })),
  });
  return codes.map((c) => c.match(/.{1,5}/g)!.join("-"));
}
async function consumeMfa(
  tx: Prisma.TransactionClient,
  user: User,
  code: string,
) {
  if (!user.mfaSecretEncrypted) fail(409, "Authenticator is not enrolled");
  const normalized = code.trim().replaceAll("-", "").toLowerCase();
  if (/^[a-f0-9]{20}$/.test(normalized)) {
    const used = await tx.mfaRecoveryCode.updateMany({
      where: {
        userId: user.id,
        digest: digest("SecureGate/recovery/v1/" + normalized),
        usedAt: null,
      },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) fail(401, "Invalid or already used recovery code");
    await tx.notification.create({
      data: {
        userId: user.id,
        message:
          "A one-use recovery code was used to authenticate your account. Review account security if this was not you.",
      },
    });
    await audit(tx, user.id, "MFA_RECOVERY_USED");
    return;
  }
  const step = totpStep(openMfaSecret(user.mfaSecretEncrypted!), code);
  if (step === null || (user.mfaLastStep !== null && step <= user.mfaLastStep))
    fail(
      401,
      "Invalid or already used authenticator code. Wait for the next code.",
    );
  await tx.user.update({ where: { id: user.id }, data: { mfaLastStep: step } });
}

@Catch()
class Errors implements ExceptionFilter {
  async catch(error: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status =
      error?.type === "entity.parse.failed"
        ? 400
        : error?.type === "entity.too.large"
          ? 413
          : error instanceof ZodError
            ? 400
            : error instanceof HttpException
              ? error.getStatus()
              : error.code === "P2002"
                ? 409
                : error.code === "P2025"
                  ? 404
                  : 500;
    if (status === 500)
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          code: error.code || error.name,
        }),
      );
    const request = host
      .switchToHttp()
      .getRequest<Request & { securityActorId?: string }>();
    if (
      status < 500 &&
      (request.path.startsWith("/api/v1/auth/mfa") ||
        request.path === "/api/v1/auth/password")
    ) {
      try {
        await audit(
          db,
          request.securityActorId || null,
          "AUTH_REQUEST_REJECTED",
          undefined,
          { status },
        );
      } catch {
        console.error(
          JSON.stringify({
            level: "error",
            event: "rejected_auth_audit_unavailable",
          }),
        );
      }
    }
    res.status(status).json({
      statusCode: status,
      message:
        error instanceof ZodError
          ? "Invalid input: " +
            error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : error instanceof HttpException
            ? error.message
            : status === 409
              ? "Record already exists"
              : status === 404
                ? "Record not found"
                : "Service unavailable. Contact support.",
    });
  }
}
@ApiTags("SecureGate")
@Controller("api/v1")
class Api {
  @Get("health") async health() {
    await db.$queryRaw`SELECT 1`;
    return {
      status: "ok",
      database: "connected",
      institution: process.env.INSTITUTION_NAME || "Demo University",
      mode: production ? "web-preview" : "synthetic-development",
    };
  }
  @Post("auth/login") async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    if (req.headers.origin !== origin) fail(403, "Invalid request origin");
    const password = z.string().min(1).max(200);
    const data = z.union([
      z.object({ identifier: z.string().trim().min(1).max(254).toLowerCase(), password }).strict(),
      z.object({ email: universityEmail, password }).strict(),
    ]).parse(body);
    const identifier = "identifier" in data ? data.identifier : data.email;
    await authQuota("source/" + String(req.ip), 300);
    const user = /^\d{4,20}$/.test(identifier)
      ? (await db.student.findUnique({ where: { registration: identifier }, include: { user: { include: { student: true } } } }))?.user
      : await db.user.findFirst({ where: { email: { equals: identifier, mode: "insensitive" } }, include: { student: true } });
    const bucketKey = await authQuota("password/" + (user?.id || identifier));
    const valid = await passwordMatches(
      data.password,
      user?.passwordHash || fakeHash,
    );
    if (!user || !user.active || !valid ||
      (user.role === "STUDENT" && (!verifiedStudent(user.student, user.email) || data.password.includes(user.student!.registration)))) {
      await audit(db, null, "LOGIN_FAILED");
      fail(401, "Invalid credentials or student identity awaiting registrar verification");
    }
    await resetQuota(bucketKey);
    const stage: AuthStage = user!.mfaSecretEncrypted
      ? "MFA_REQUIRED"
      : user!.role === "STUDENT"
        ? "FULL"
        : "MFA_SETUP_REQUIRED";
    const session = await transaction(async (tx) => {
      const session = await newSession(tx, user!.id, stage);
      await audit(
        tx,
        user!.id,
        stage === "FULL" ? "LOGIN_SUCCEEDED" : "PASSWORD_VERIFIED",
      );
      return session;
    });
    sessionCookie(res, session);
    return {
      user: safeUser(user!),
      csrf: session.csrf,
      stage,
      mfaEnabled: !!user!.mfaSecretEncrypted,
    };
  }
  @Post("auth/logout") async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const c = await actor(req, undefined, true);
    await db.session.delete({ where: { id: c.session.id } });
    res.clearCookie("sg_session", sessionCookieOptions);
    return { ok: true };
  }
  @Post("auth/mfa/setup") async mfaSetup(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const c = await actor(req, undefined, true);
    const d = z
      .object({ currentPassword: z.string().min(1).max(200).optional() })
      .strict()
      .parse(body);
    if (c.user.mfaSecretEncrypted)
      fail(
        409,
        "An authenticator is already enrolled. Use a recovery code if you cannot access it.",
      );
    await authQuota("setup/" + c.user.id, 5, 5 * 60000);
    if (c.session.stage === "FULL") {
      if (
        !d.currentPassword ||
        !(await passwordMatches(d.currentPassword, c.user.passwordHash))
      )
        fail(401, "Current password required");
    } else if (Date.now() - c.session.createdAt.getTime() > 5 * 60000)
      fail(401, "Sign in again before authenticator enrollment");
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await transaction(async (tx) => {
      const session = await tx.session.findUniqueOrThrow({
        where: { id: c.session.id },
        include: { user: true },
      });
      if (session.user.mfaSecretEncrypted)
        fail(409, "Authenticator already enrolled");
      await tx.session.update({
        where: { id: session.id },
        data: {
          mfaPendingSecret: sealMfaSecret(secret),
          mfaPendingExpiresAt: new Date(Date.now() + 5 * 60000),
        },
      });
      await audit(tx, c.user.id, "MFA_ENROLLMENT_STARTED");
    });
    return {
      secret,
      uri: authenticator(secret, c.user.email).toString(),
      notice:
        "Enrollment-only secret. Save in your authenticator; it is never returned by profile or account-list APIs.",
    };
  }
  @Post("auth/mfa/confirm") async mfaConfirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const c = await actor(req, undefined, true);
    const d = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(body);
    const quota = await authQuota("mfa/" + c.user.id);
    const result = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${c.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: c.user.id },
      });
      const pending = await tx.session.findUniqueOrThrow({
        where: { id: c.session.id },
      });
      if (user.mfaSecretEncrypted) fail(409, "Authenticator already enrolled");
      if (
        !pending.mfaPendingSecret ||
        !pending.mfaPendingExpiresAt ||
        pending.mfaPendingExpiresAt < new Date() ||
        pending.expiresAt < new Date()
      )
        fail(409, "Start a fresh authenticator enrollment");
      const step = totpStep(openMfaSecret(pending.mfaPendingSecret!), d.code);
      if (step === null) fail(401, "Invalid authenticator code");
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecretEncrypted: pending.mfaPendingSecret,
          mfaLastStep: step,
        },
      });
      const codes = await recoveryCodes(tx, user.id);
      await tx.session.deleteMany({ where: { userId: user.id } });
      const session = await newSession(tx, user.id, "FULL", true);
      await audit(tx, user.id, "MFA_ENROLLED");
      await audit(tx, user.id, "LOGIN_SUCCEEDED");
      return { session, codes, user };
    });
    await resetQuota(quota);
    sessionCookie(res, result.session);
    return {
      user: safeUser(result.user),
      csrf: result.session.csrf,
      stage: "FULL",
      mfaEnabled: true,
      recoveryCodes: result.codes,
    };
  }
  @Post("auth/mfa/verify") async mfaVerify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const c = await actor(req, undefined, true);
    if (authStage(c.session, c.user) !== "MFA_REQUIRED")
      fail(409, "No authenticator challenge is pending");
    const d = z
      .object({ code: z.string().trim().min(6).max(32) })
      .strict()
      .parse(body);
    const quota = await authQuota("mfa/" + c.user.id);
    const session = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${c.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: c.user.id },
      });
      await consumeMfa(tx, user, d.code);
      await tx.session.delete({ where: { id: c.session.id } });
      const session = await newSession(tx, user.id, "FULL", true);
      await audit(tx, user.id, "MFA_VERIFIED");
      await audit(tx, user.id, "LOGIN_SUCCEEDED");
      return session;
    });
    await resetQuota(quota);
    sessionCookie(res, session);
    return {
      user: safeUser(c.user),
      csrf: session.csrf,
      stage: "FULL",
      mfaEnabled: true,
    };
  }
  @Post("auth/password") async changePassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    const c = await actor(req);
    const d = z
      .object({
        currentPassword: z.string().min(1).max(200),
        newPassword: z.string().min(14).max(128),
        code: z.string().trim().max(32).optional(),
      })
      .strict()
      .parse(body);
    if (d.newPassword === d.currentPassword)
      fail(400, "Choose a different password");
    if (c.user.role === "STUDENT")
      independentStudentPassword(d.newPassword, (await ownStudent(c.user)).registration);
    const quota = await authQuota("reauth/" + c.user.id);
    const passwordHash = await newPasswordHash(d.newPassword);
    const result = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${c.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: c.user.id },
      });
      if (!(await passwordMatches(d.currentPassword, user.passwordHash)))
        fail(401, "Current password is incorrect");
      if (user.mfaSecretEncrypted) await consumeMfa(tx, user, d.code || "");
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: user.id } });
      const session = await newSession(
        tx,
        user.id,
        "FULL",
        !!user.mfaSecretEncrypted,
      );
      await tx.notification.create({
        data: {
          userId: user.id,
          message:
            "Your password changed. Other sessions have been signed out.",
        },
      });
      await audit(tx, user.id, "PASSWORD_CHANGED");
      return { session, user };
    });
    await resetQuota(quota);
    sessionCookie(res, result.session);
    return {
      user: safeUser(result.user),
      csrf: result.session.csrf,
      stage: "FULL",
      mfaEnabled: !!result.user.mfaSecretEncrypted,
    };
  }
  @Post("auth/mfa/recovery-codes") async rotateRecoveryCodes(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const c = await actor(req);
    const d = z
      .object({
        currentPassword: z.string().min(1).max(200),
        code: z.string().trim().min(6).max(32),
      })
      .strict()
      .parse(body);
    const quota = await authQuota("reauth/" + c.user.id);
    const codes = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${c.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: c.user.id },
      });
      if (!(await passwordMatches(d.currentPassword, user.passwordHash)))
        fail(401, "Current password is incorrect");
      await consumeMfa(tx, user, d.code);
      const codes = await recoveryCodes(tx, user.id);
      await audit(tx, user.id, "MFA_RECOVERY_CODES_ROTATED");
      return codes;
    });
    await resetQuota(quota);
    return { recoveryCodes: codes };
  }

  @Get("me") async me(@Req() req: Request) {
    const c = await actor(req, undefined, true);
    const stage = authStage(c.session, c.user);
    return {
      user: safeUser(c.user),
      csrf: c.session.csrf,
      stage,
      mfaEnabled: !!c.user.mfaSecretEncrypted,
      institution: String(
        (await db.setting.findUnique({ where: { key: "institutionName" } }))
          ?.value ||
          process.env.INSTITUTION_NAME ||
          "Demo University",
      ),
      student:
        stage === "FULL"
          ? await db.student.findUnique({ where: { userId: c.user.id } })
          : null,
    };
  }
  @Get("students") async students(@Req() req: Request, @Query("q") q = "") {
    const { user } = await actor(req, ["REGISTRAR"]);
    await audit(db, user.id, "STUDENT_REGISTRY_READ");
    return db.student.findMany({
      where: {
        OR: [
          { registration: { contains: q.slice(0, 100), mode: "insensitive" } },
          {
            user: { name: { contains: q.slice(0, 100), mode: "insensitive" } },
          },
          { user: { email: { contains: q.slice(0, 100), mode: "insensitive" } } },
        ],
      },
      include: { user: { select: { name: true, email: true } } },
      take: 100,
      orderBy: { registration: "asc" },
    });
  }
  @Post("students") async createStudent(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["REGISTRAR"]);
    const d = studentIdentity.safeExtend({
        name: text,
        program: text,
        password: z.string().min(14).max(128),
      })
      .strict()
      .parse(body);
    independentStudentPassword(d.password, d.registration);
    const passwordHash = await newPasswordHash(d.password);
    return transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: d.email.toLowerCase(),
          name: d.name,
          passwordHash,
          role: "STUDENT",
        },
      });
      const s = await tx.student.create({
        data: {
          userId: u.id,
          registration: d.registration,
          program: d.program,
          identityVerifiedAt: new Date(),
          identityVerifiedBy: user.id,
        },
      });
      await audit(tx, user.id, "STUDENT_CREATED", s.id);
      return s;
    });
  }
  @Patch("students/:id/identity") async verifyStudentIdentity(
    @Req() req: Request, @Param("id") id: string, @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["REGISTRAR"]);
    const d = studentIdentity.safeExtend({ reason: text }).strict().parse(body);
    return transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id=${uuid.parse(id)}::uuid FOR UPDATE`;
      const student = await tx.student.findUniqueOrThrow({ where: { id } });
      // Clear the old attestation in this transaction before changing its linked email.
      await tx.student.update({ where: { id }, data: { identityVerifiedAt: null, identityVerifiedBy: null } });
      await tx.user.update({ where: { id: student.userId }, data: { email: d.email } });
      const updated = await tx.student.update({ where: { id }, data: {
        registration: d.registration, identityVerifiedAt: new Date(), identityVerifiedBy: user.id,
      } });
      await tx.session.deleteMany({ where: { userId: student.userId } });
      await tx.credential.updateMany({ where: { studentId: id, status: "ACTIVE" }, data: { status: "REVOKED", revokedAt: new Date() } });
      await audit(tx, user.id, "STUDENT_IDENTITY_VERIFIED", id, { reason: d.reason });
      return updated;
    });
  }
  @Get("credentials") async credentials(
    @Req() req: Request,
    @Query("studentId") studentId?: string,
  ) {
    const { user } = await actor(req, ["STUDENT", "REGISTRAR"]);
    const id =
      user.role === "STUDENT"
        ? (await ownStudent(user)).id
        : uuid.parse(studentId);
    return db.credential.findMany({
      where: { studentId: id },
      select: {
        id: true,
        status: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      orderBy: { issuedAt: "desc" },
    });
  }
  @Post("credentials") async issue(@Req() req: Request, @Body() body: unknown) {
    const { user } = await actor(req, ["REGISTRAR"]);
    const d = z.object({ studentId: uuid }).strict().parse(body);
    const raw = "sg1." + randomBytes(32).toString("base64url");
    const credential = await transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id=${d.studentId}::uuid FOR UPDATE`;
      const s = await tx.student.findUnique({ where: { id: d.studentId }, include: { user: true } });
      if (!s || !verifiedStudent(s, s.user.email))
        fail(409, "Active verified enrollment required");
      await tx.credential.updateMany({
        where: { studentId: d.studentId, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      const c = await tx.credential.create({
        data: {
          id: randomUUID(),
          studentId: d.studentId,
          digest: credentialDigest(raw),
          expiresAt: new Date(Date.now() + 365 * 86400000),
        },
      });
      await tx.credential.update({ where: { id: c.id }, data: {
        encryptedValue: sealQrCredential(raw, c.id, s!.id),
      } });
      await audit(tx, user.id, "CREDENTIAL_ISSUED", c.id);
      return c;
    });
    return {
      id: credential.id,
      credential: raw,
      notice:
        "One-time issuance output. Deliver only through the authorized ID-printing workflow; do not retain in logs.",
    };
  }
  @Get("credentials/qr") async personalQr(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT"]);
    const student = await ownStudent(user);
    const current = await db.credential.findFirst({ where: {
      studentId: student.id, status: "ACTIVE", expiresAt: { gt: new Date() },
    } });
    if (!current) fail(404, "No active credential. Ask the registrar to issue your student ID.");
    if (!current!.encryptedValue) fail(409, "Ask the registrar to reissue this legacy ID before displaying its QR.");
    const raw = openQrCredential(current!.encryptedValue!, current!.id, student.id);
    if (credentialDigest(raw) !== current!.digest) throw new Error("Credential integrity check failed");
    await audit(db, user.id, "PERSONAL_QR_VIEWED", current!.id);
    return { id: current!.id, credential: raw, expiresAt: current!.expiresAt };
  }
  @Post("credentials/lost") async lost(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT"]);
    const s = await ownStudent(user);
    return transaction(async (tx) => {
      await tx.credential.updateMany({
        where: { studentId: s.id, status: { in: ["ACTIVE", "SUSPENDED"] } },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      const i = await tx.incident.create({
        data: {
          category: "LOST_ID",
          description:
            "Student reported their ID lost. Credentials revoked; registrar identity verification required before replacement.",
          studentId: s.id,
          reporterId: user.id,
        },
      });
      await audit(tx, user.id, "LOST_ID_REVOKED", s.id);
      return i;
    });
  }
  @Post("credentials/:id/revoke") async revoke(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const { user } = await actor(req, ["REGISTRAR"]);
    return transaction(async (tx) => {
      const c = await tx.credential.update({
        where: { id: uuid.parse(id) },
        data: { status: "REVOKED", revokedAt: new Date() },
      });
      await audit(tx, user.id, "CREDENTIAL_REVOKED", c.id);
      return { ok: true };
    });
  }
  @Get("gadgets") async gadgets(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT", "VERIFIER"]);
    return db.gadget.findMany({
      where:
        user.role === "STUDENT"
          ? { studentId: (await ownStudent(user)).id }
          : {},
      include: {
        student: {
          select: { registration: true, user: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Post("gadgets") async addGadget(@Req() req: Request, @Body() body: unknown) {
    const { user } = await actor(req, ["STUDENT"]);
    const s = await ownStudent(user);
    const d = z
      .object({
        category: z.enum(["Laptop", "Tablet", "Camera", "Other"]),
        manufacturer: text,
        model: text,
        serial: z
          .string()
          .trim()
          .min(3)
          .max(100)
          .transform((s) => s.toUpperCase()),
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const duplicate = await tx.gadget.count({ where: { serial: d.serial } });
      const g = await tx.gadget.create({ data: { ...d, studentId: s.id } });
      if (duplicate)
        await tx.incident.create({
          data: {
            category: "DUPLICATE_SERIAL_REVIEW",
            description:
              "Matching serial submitted; physical ownership review required. This is not a finding of fraud.",
            studentId: s.id,
            reporterId: user.id,
          },
        });
      await audit(tx, user.id, "GADGET_SUBMITTED", g.id);
      return g;
    });
  }
  @Post("gadgets/:id/verify") async verifyGadget(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["VERIFIER"]);
    const d = z
      .object({
        approved: z.boolean(),
        physicalCheck: z.literal(true),
        reason: text,
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const g = await tx.gadget.findUniqueOrThrow({
        where: { id: uuid.parse(id) },
        include: { student: true },
      });
      if (g.student.userId === user.id)
        fail(403, "Cannot verify your own gadget");
      if (g.status !== "PENDING") fail(409, "Gadget already reviewed");
      const updated = await tx.gadget.update({
        where: { id: g.id },
        data: {
          status: d.approved ? "APPROVED" : "REJECTED",
          verifiedBy: user.id,
          verifiedAt: new Date(),
          decisionReason: d.reason,
        },
      });
      await tx.notification.create({
        data: {
          userId: g.student.userId,
          message: `Gadget ${g.manufacturer} ${g.model}: ${updated.status.toLowerCase()}`,
        },
      });
      await audit(tx, user.id, "GADGET_VERIFIED", g.id, {
        approved: d.approved,
        reason: d.reason,
      });
      return updated;
    });
  }
  @Post("gadgets/:id/lost") async lostGadget(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const { user } = await actor(req, ["STUDENT"]);
    const s = await ownStudent(user);
    return transaction(async (tx) => {
      const g = await tx.gadget.findFirst({
        where: { id: uuid.parse(id), studentId: s.id },
      });
      if (!g) fail(404, "Gadget not found");
      await tx.gadget.update({ where: { id }, data: { status: "LOST" } });
      const i = await tx.incident.create({
        data: {
          category: "LOST_GADGET",
          description: "Owner reported gadget lost or stolen. Review required.",
          studentId: s.id,
          reporterId: user.id,
        },
      });
      await audit(tx, user.id, "GADGET_LOST", id);
      return i;
    });
  }
  @Get("terminals") async terminals(@Req() req: Request) {
    const { user } = await actor(req, ["OFFICER", "SUPERVISOR", "ADMIN"]);
    return db.terminal.findMany({
      where:
        user.role === "ADMIN"
          ? {}
          : { assignments: { some: { userId: user.id } } },
      orderBy: { name: "asc" },
    });
  }
  @Post("terminals") async terminal(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["ADMIN"]);
    const d = z
      .object({
        name: text,
        gate: text,
        direction: z.enum(["ENTRY", "EXIT"]),
        lane: z.enum(["EXPRESS", "GADGET"]),
        mode: z.enum(["ASSISTED", "REGISTRATION_ONLY"]),
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const t = await tx.terminal.create({ data: d });
      await audit(tx, user.id, "TERMINAL_CREATED", t.id);
      return t;
    });
  }
  @Post("terminals/:id/assign") async assign(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["SUPERVISOR", "ADMIN"]);
    const d = z.object({ userId: uuid }).strict().parse(body);
    const officer = await db.user.findUniqueOrThrow({
      where: { id: d.userId },
    });
    if (!staffScan.includes(officer.role))
      fail(400, "Only scanning staff can be assigned");
    return transaction(async (tx) => {
      const a = await tx.assignment.upsert({
        where: {
          userId_terminalId: { userId: d.userId, terminalId: uuid.parse(id) },
        },
        create: { userId: d.userId, terminalId: id },
        update: {},
      });
      await audit(tx, user.id, "OPERATOR_ASSIGNED", id, { userId: d.userId });
      return a;
    });
  }
  @Patch("terminals/:id") async terminalActive(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["ADMIN"]);
    const d = z.object({ active: z.boolean() }).strict().parse(body);
    return transaction(async (tx) => {
      const t = await tx.terminal.update({
        where: { id: uuid.parse(id) },
        data: d,
      });
      await audit(tx, user.id, "TERMINAL_STATUS_CHANGED", id, d);
      return t;
    });
  }
  async checkpoint(tx: any, user: User, id: string) {
    const terminal = await tx.terminal.findFirst({
      where: { id, active: true, assignments: { some: { userId: user.id } } },
    });
    if (!terminal) fail(403, "Active assigned checkpoint required");
    return terminal;
  }
  async identity(tx: any, raw: string) {
    const c = await tx.credential.findUnique({
      where: { digest: credentialDigest(raw) },
      include: {
        student: { include: { user: { select: { name: true, email: true, active: true } } } },
      },
    });
    if (
      !c ||
      c.status !== "ACTIVE" ||
      c.expiresAt < new Date() ||
      !c.student.user.active ||
      !verifiedStudent(c.student, c.student.user.email)
    )
      fail(403, "Invalid, expired or revoked credential");
    return c;
  }
  @Post("scans/lookup") async lookup(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, staffScan);
    const d = z
      .object({
        credential: z.string().regex(/^sg1\.[A-Za-z0-9_-]{43}$/),
        terminalId: uuid,
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      await this.checkpoint(tx, user, d.terminalId);
      const c = await this.identity(tx, d.credential);
      await audit(tx, user.id, "SCAN_IDENTITY_VIEWED", c.studentId);
      const visit = await tx.visit.findFirst({
        where: { studentId: c.studentId, exitedAt: null },
        include: { gadgets: { include: { gadget: true } } },
      });
      return {
        student: {
          id: c.student.id,
          name: c.student.user.name,
          registration: c.student.registration,
          program: c.student.program,
          photoUrl: c.student.photoUrl,
        },
        gadgets: await tx.gadget.findMany({
          where: {
            status: "APPROVED",
            OR: [
              { studentId: c.studentId },
              {
                custody: {
                  some: {
                    custodianId: c.studentId,
                    revoked: false,
                    startsAt: { lte: new Date() },
                    endsAt: { gte: new Date() },
                  },
                },
              },
            ],
          },
        }),
        visit,
      };
    });
  }
  @Post("scans") async scan(@Req() req: Request, @Body() body: unknown) {
    const { user } = await actor(req, staffScan);
    const started = Date.now();
    const d = z
      .object({
        requestId: uuid,
        credential: z.string().regex(/^sg1\.[A-Za-z0-9_-]{43}$/),
        terminalId: uuid,
        gadgetIds: z
          .array(uuid)
          .max(20)
          .refine((a) => new Set(a).size === a.length, "Duplicate gadgets"),
        identityChecked: z.literal(true),
        physicalCheck: z.boolean(),
      })
      .strict()
      .parse(body);
    const fingerprint = digest(
      JSON.stringify({ ...d, gadgetIds: [...d.gadgetIds].sort() }),
    );
    return transaction(async (tx) => {
      const prior = await tx.scan.findUnique({ where: { id: d.requestId } });
      if (prior) {
        if (prior.actorId !== user.id || prior.fingerprint !== fingerprint)
          fail(409, "Request identifier already used for another operation");
        return { ...(prior.response as object), duplicate: true };
      }
      const t = await this.checkpoint(tx, user, d.terminalId);
      const c = await this.identity(tx, d.credential);
      await tx.$queryRaw`SELECT id FROM "Student" WHERE id=${c.studentId}::uuid FOR UPDATE`;
      const active = await tx.visit.findFirst({
        where: { studentId: c.studentId, exitedAt: null },
        include: { gadgets: true },
      });
      let outcome = transition(!!active, t.direction),
        visitId = active?.id || null;
      if (t.lane === "EXPRESS" && d.gadgetIds.length)
        fail(409, "Use the gadget verification lane");
      if (t.mode === "ASSISTED" && !d.physicalCheck)
        fail(400, "Officer must confirm physical passage");
      const selected = await tx.gadget.findMany({
        where: {
          id: { in: d.gadgetIds },
          status: "APPROVED",
          OR: [
            { studentId: c.studentId },
            {
              custody: {
                some: {
                  custodianId: c.studentId,
                  revoked: false,
                  startsAt: { lte: new Date() },
                  endsAt: { gte: new Date() },
                },
              },
            },
          ],
        },
      });
      if (selected.length !== d.gadgetIds.length)
        fail(409, "Gadget ownership, approval or custody requires review");
      if (t.direction === "ENTRY" && d.gadgetIds.length) {
        const elsewhere = await tx.visitGadget.count({
          where: {
            gadgetId: { in: d.gadgetIds },
            exitedAt: null,
            visit: { exitedAt: null, studentId: { not: c.studentId } },
          },
        });
        if (elsewhere)
          fail(
            409,
            "A presented gadget is already recorded on another active visit; refer for custody review",
          );
      }
      const missing =
        active?.gadgets.filter(
          (g: any) => !g.exitedAt && !d.gadgetIds.includes(g.gadgetId),
        ) || [];
      const unexpected =
        active &&
        d.gadgetIds.some(
          (id) =>
            !active.gadgets.some((g: any) => g.gadgetId === id && !g.exitedAt),
        );
      if (t.direction === "EXIT" && (missing.length || unexpected))
        outcome = "REVIEW_REQUIRED";
      const recent = await tx.movement.findFirst({
        where: { studentId: c.studentId, confirmed: true },
        orderBy: { createdAt: "desc" },
      });
      if (
        outcome === "APPROVED" &&
        t.direction === "ENTRY" &&
        recent &&
        Date.now() - recent.createdAt.getTime() < 3000
      )
        outcome = "REVIEW_REQUIRED";
      const confirmed =
        t.mode === "ASSISTED" && d.physicalCheck && outcome === "APPROVED";
      if (t.mode === "REGISTRATION_ONLY" && outcome === "APPROVED")
        outcome = "UNCONFIRMED";
      if (confirmed && t.direction === "ENTRY") {
        const v = await tx.visit.create({
          data: {
            studentId: c.studentId,
            gadgets: { create: d.gadgetIds.map((gadgetId) => ({ gadgetId })) },
          },
        });
        visitId = v.id;
      }
      if (confirmed && t.direction === "EXIT" && active) {
        await tx.visit.update({
          where: { id: active.id },
          data: { exitedAt: new Date() },
        });
        await tx.visitGadget.updateMany({
          where: { visitId: active.id, gadgetId: { in: d.gadgetIds } },
          data: { exitedAt: new Date() },
        });
      }
      if (outcome === "REVIEW_REQUIRED")
        await tx.incident.create({
          data: {
            category: "MOVEMENT_REVIEW",
            studentId: c.studentId,
            reporterId: user.id,
            description: `${t.direction} requires review: inconsistent visit or gadget reconciliation. Emergency egress remains governed by life-safety procedures.`,
          },
        });
      const movement = await tx.movement.create({
        data: {
          studentId: c.studentId,
          credentialId: c.id,
          terminalId: t.id,
          operatorId: user.id,
          direction: t.direction,
          confirmed,
          outcome,
          visitId,
          gadgetIds: d.gadgetIds,
          durationMs: Date.now() - started,
        },
      });
      await tx.terminal.update({
        where: { id: t.id },
        data: { lastSeen: new Date() },
      });
      const response = {
        movementId: movement.id,
        outcome,
        confirmed,
        visitId,
        timestamp: movement.createdAt.toISOString(),
        message: confirmed
          ? "Officer-confirmed passage recorded"
          : outcome === "ALREADY_INSIDE"
            ? "Already inside: no additional visit opened"
            : outcome === "UNCONFIRMED"
              ? "Intended movement recorded; physical passage unconfirmed"
              : "Refer to security. Do not obstruct emergency egress.",
      };
      await tx.scan.create({
        data: { id: d.requestId, actorId: user.id, fingerprint, response },
      });
      await audit(tx, user.id, "MOVEMENT_" + outcome, movement.id);
      return response;
    });
  }
  @Get("movements") async movements(
    @Req() req: Request,
    @Query("before") before?: string,
  ) {
    const { user } = await actor(req, ["STUDENT", "OFFICER", "SUPERVISOR"]);
    const filter =
      user.role === "STUDENT"
        ? { studentId: (await ownStudent(user)).id }
        : { terminal: { assignments: { some: { userId: user.id } } } };
    await audit(db, user.id, "MOVEMENTS_READ");
    return db.movement.findMany({
      where: {
        ...filter,
        ...(before ? { createdAt: { lt: z.coerce.date().parse(before) } } : {}),
      },
      include: {
        terminal: { select: { name: true, gate: true } },
        student: {
          select: { registration: true, user: { select: { name: true } } },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  }
  @Get("visits") async visits(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT"]);
    return db.visit.findMany({
      where: { studentId: (await ownStudent(user)).id },
      include: { gadgets: { include: { gadget: true } } },
      orderBy: { enteredAt: "desc" },
      take: 100,
    });
  }
  @Get("incidents") async incidents(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT", "OFFICER", "SUPERVISOR"]);
    await audit(db, user.id, "INCIDENTS_READ");
    return db.incident.findMany({
      where:
        user.role === "STUDENT"
          ? { studentId: (await ownStudent(user)).id }
          : user.role === "OFFICER"
            ? { reporterId: user.id }
            : {},
      include: { actions: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Post("incidents") async incident(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["STUDENT", "OFFICER", "SUPERVISOR"]);
    const d = z
      .object({
        category: z.enum([
          "MOVEMENT_CORRECTION",
          "LOST_GADGET",
          "UNREGISTERED_GADGET",
          "IDENTITY_MISMATCH",
          "TERMINAL_FAILURE",
          "OTHER",
        ]),
        description: text,
        studentId: uuid.optional(),
        severity: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
      })
      .strict()
      .parse(body);
    const studentId =
      user.role === "STUDENT" ? (await ownStudent(user)).id : d.studentId;
    return transaction(async (tx) => {
      const i = await tx.incident.create({
        data: { ...d, studentId, reporterId: user.id },
      });
      await audit(tx, user.id, "INCIDENT_CREATED", i.id);
      return i;
    });
  }
  @Post("incidents/:id/status") async incidentStatus(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["SUPERVISOR"]);
    const d = z
      .object({
        status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED", "CLOSED"]),
        note: text,
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const i = await tx.incident.findUniqueOrThrow({
        where: { id: uuid.parse(id) },
      });
      if (!incidentTransition(i.status, d.status))
        fail(409, "Invalid incident transition");
      await tx.incidentAction.create({
        data: { incidentId: id, actorId: user.id, ...d },
      });
      const updated = await tx.incident.update({
        where: { id },
        data: { status: d.status },
      });
      await audit(tx, user.id, "INCIDENT_STATUS_CHANGED", id, d);
      return updated;
    });
  }
  @Get("overrides") async overrides(@Req() req: Request) {
    const { user } = await actor(req, staffScan);
    return db.override.findMany({
      where: user.role === "OFFICER" ? { requestedBy: user.id } : {},
      include: { incident: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Post("overrides") async override(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, staffScan);
    const d = z.object({ incidentId: uuid, reason: text }).strict().parse(body);
    return transaction(async (tx) => {
      const i = await tx.incident.findUniqueOrThrow({
        where: { id: d.incidentId },
      });
      if (user.role === "OFFICER" && i.reporterId !== user.id)
        fail(403, "Incident not assigned to this operator");
      const o = await tx.override.create({
        data: { ...d, requestedBy: user.id },
      });
      await audit(tx, user.id, "OVERRIDE_REQUESTED", o.id);
      return o;
    });
  }
  @Post("overrides/:id/decide") async decide(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["SUPERVISOR"]);
    const d = z
      .object({ approved: z.boolean(), reason: text })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const o = await tx.override.findUniqueOrThrow({
        where: { id: uuid.parse(id) },
      });
      if (o.requestedBy === user.id) fail(403, "Independent approval required");
      if (o.status !== "PENDING") fail(409, "Already decided");
      const updated = await tx.override.update({
        where: { id },
        data: {
          status: d.approved ? "APPROVED" : "REJECTED",
          decidedBy: user.id,
          decisionReason: d.reason,
        },
      });
      await audit(tx, user.id, "OVERRIDE_DECIDED", id, d);
      return updated;
    });
  }
  @Get("reports") async reports(@Req() req: Request) {
    const { user } = await actor(req, ["MANAGEMENT", "SUPERVISOR"]);
    await audit(db, user.id, "AGGREGATE_REPORT_READ");
    const [entries, exits, inside, pending, incidents, terminals, rows] =
      await Promise.all([
        db.movement.count({ where: { direction: "ENTRY", confirmed: true } }),
        db.movement.count({ where: { direction: "EXIT", confirmed: true } }),
        db.visit.count({ where: { exitedAt: null } }),
        db.gadget.count({ where: { status: "PENDING" } }),
        db.incident.count({
          where: { status: { in: ["OPEN", "UNDER_REVIEW"] } },
        }),
        db.terminal.count({ where: { active: true } }),
        db.$queryRaw<
          Array<{ hour: string; count: bigint }>
        >`SELECT to_char("createdAt" AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD HH24:00') AS hour, count(*) FROM "Movement" WHERE confirmed=true GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
      ]);
    return {
      entries,
      exits,
      estimatedOccupancy: inside,
      pendingGadgets: pending,
      openIncidents: incidents,
      activeTerminals: terminals,
      hourly: rows
        .reverse()
        .map((r) => ({ hour: r.hour, count: Number(r.count) })),
      notice:
        "Estimated occupancy from officer-confirmed records; not classroom attendance. Counts cover retained records.",
    };
  }
  @Get("audit-events") async audits(
    @Req() req: Request,
    @Query("before") before?: string,
  ) {
    const { user } = await actor(req, ["AUDITOR"]);
    await audit(db, user.id, "AUDIT_READ");
    return db.audit.findMany({
      where: before ? { createdAt: { lt: z.coerce.date().parse(before) } } : {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  }
  @Get("users") async users(@Req() req: Request) {
    await actor(req, ["ADMIN", "SUPERVISOR"]);
    return db.user.findMany({
      select: { id: true, email: true, name: true, role: true, active: true },
      orderBy: { name: "asc" },
      take: 100,
    });
  }
  @Post("users") async provision(@Req() req: Request, @Body() body: unknown) {
    const { user } = await actor(req, ["ADMIN"]);
    const d = z
      .object({
        email: z.email(),
        name: text,
        role: roles.exclude(["STUDENT", "ADMIN"]),
        password: z.string().min(14).max(128),
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: d.email.toLowerCase(),
          name: d.name,
          role: d.role,
          passwordHash: hashPassword(d.password),
        },
      });
      await audit(tx, user.id, "STAFF_PROVISIONED", u.id, { role: u.role });
      return safeUser(u);
    });
  }
  @Patch("users/:id") async suspend(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["ADMIN"]);
    const d = z.object({ active: z.boolean() }).strict().parse(body);
    if (id === user.id) fail(403, "Cannot suspend your own account");
    return transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: uuid.parse(id) },
        data: d,
      });
      await tx.session.deleteMany({ where: { userId: id } });
      await audit(tx, user.id, "ACCOUNT_STATUS_CHANGED", id, d);
      return safeUser(u);
    });
  }
  @Get("settings") async settings(@Req() req: Request) {
    await actor(req, ["ADMIN"]);
    return db.setting.findMany();
  }
  @Post("settings") async setting(@Req() req: Request, @Body() body: unknown) {
    const { user } = await actor(req, ["ADMIN"]);
    const d = z
      .object({
        key: z.enum([
          "institutionName",
          "privacyNotice",
          "approvedRetentionPolicy",
        ]),
        value: z.string().trim().min(2).max(2000),
      })
      .strict()
      .parse(body);
    return transaction(async (tx) => {
      const s = await tx.setting.upsert({
        where: { key: d.key },
        create: d,
        update: { value: d.value },
      });
      await audit(tx, user.id, "SETTING_CHANGED", d.key);
      return s;
    });
  }
  @Get("notifications") async notifications(@Req() req: Request) {
    const { user } = await actor(req);
    return db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  @Get("gadget-custody") async custody(@Req() req: Request) {
    const { user } = await actor(req, ["STUDENT", "SUPERVISOR"]);
    return db.custody.findMany({
      where:
        user.role === "STUDENT"
          ? {
              OR: [
                { custodianId: (await ownStudent(user)).id },
                { gadget: { studentId: (await ownStudent(user)).id } },
              ],
            }
          : {},
      include: { gadget: true },
      take: 100,
    });
  }
  @Post("gadget-custody") async grantCustody(
    @Req() req: Request,
    @Body() body: unknown,
  ) {
    const { user } = await actor(req, ["SUPERVISOR"]);
    const d = z
      .object({
        gadgetId: uuid,
        custodianId: uuid,
        startsAt: z.coerce.date(),
        endsAt: z.coerce.date(),
      })
      .strict()
      .parse(body);
    if (d.endsAt <= d.startsAt) fail(400, "End must follow start");
    return transaction(async (tx) => {
      const g = await tx.gadget.findUniqueOrThrow({
        where: { id: d.gadgetId },
        include: { student: true },
      });
      const s = await tx.student.findUniqueOrThrow({
        where: { id: d.custodianId },
      });
      if (
        g.status !== "APPROVED" ||
        g.student.userId === user.id ||
        s.userId === user.id
      )
        fail(403, "Approved gadget and independent authorizer required");
      const c = await tx.custody.create({
        data: { ...d, approvedBy: user.id },
      });
      await audit(tx, user.id, "CUSTODY_AUTHORIZED", c.id);
      return c;
    });
  }
}
@Module({ controllers: [Api] })
class AppModule {}
export async function start() {
  if (!key || key.length < 64)
    throw new Error("Run npm run setup: CREDENTIAL_KEY is required");
  if (production && process.env.DEPLOYMENT_MODE !== "web-preview")
    throw new Error(
      "Production transport requires DEPLOYMENT_MODE=web-preview. Physical gate deployment remains unavailable. See README.",
    );
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  if (process.env.RENDER === "true")
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  app.enableCors({
    origin,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    maxAge: 600,
  });
  const express = await import("express");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: () => void) => {
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.useGlobalFilters(new Errors());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("SecureGate API")
      .setVersion("1")
      .addCookieAuth("sg_session")
      .build(),
  );
  SwaggerModule.setup("api/docs", app, document);
  await app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
  return app;
}
async function seed() {
  if (production) throw new Error("Synthetic seed is development-only");
  const file = resolve(
    process.env.LOCAL_ACCOUNTS_PATH || ".local/accounts.json",
  );
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{
      email: string;
    }>;
    const matching = await db.user.count({
      where: { email: { in: saved.map((a) => a.email) } },
    });
    if (matching !== saved.length || !matching)
      throw new Error(
        "Local account file does not match this database. Restore the matching development database; existing files are preserved.",
      );
    console.log("Existing local accounts and database verified; preserved.");
    return;
  }
  if (await db.user.count())
    throw new Error(
      "Database contains users; refusing to seed over existing data.",
    );
  const accounts: Array<{ role: string; email: string; password: string; studentNumber?: string }> = [];
  const demoNumber = String(randomInt(100000, 1000000000));
  await transaction(async (tx) => {
    for (const role of roles.options) {
      const email = role === "STUDENT" ? `sg${demoNumber}@student.cavendish.ac.ug` : role.toLowerCase() + "@demo.securegate.test",
        password = randomBytes(18).toString("base64url");
      const u = await tx.user.create({
        data: {
          name:
            role === "STUDENT"
              ? "Amina Nakato (synthetic)"
              : role.charAt(0) + role.slice(1).toLowerCase() + " (synthetic)",
          email,
          passwordHash: hashPassword(password),
          role,
        },
      });
      accounts.push({ role, email, password, ...(role === "STUDENT" ? { studentNumber: demoNumber } : {}) });
    }
    const registrar = await tx.user.findUniqueOrThrow({ where: { email: "registrar@demo.securegate.test" } });
    const studentUser = await tx.user.findUniqueOrThrow({ where: { email: `sg${demoNumber}@student.cavendish.ac.ug` } });
    await tx.student.create({ data: {
      userId: studentUser.id, registration: demoNumber, program: "BSc Computer Science",
      identityVerifiedAt: new Date(), identityVerifiedBy: registrar.id,
    } });
    const officer = await tx.user.findUniqueOrThrow({
      where: { email: "officer@demo.securegate.test" },
    });
    const supervisor = await tx.user.findUniqueOrThrow({
      where: { email: "supervisor@demo.securegate.test" },
    });
    for (const direction of ["ENTRY", "EXIT"] as const)
      for (const lane of ["EXPRESS", "GADGET"] as const) {
        const t = await tx.terminal.create({
          data: {
            name: `${lane === "EXPRESS" ? "Express" : "Gadget"} ${direction.toLowerCase()}`,
            gate: "Main gate · synthetic",
            direction,
            lane,
          },
        });
        for (const u of [officer, supervisor])
          await tx.assignment.create({
            data: { userId: u.id, terminalId: t.id },
          });
      }
    await tx.setting.create({
      data: {
        key: "institutionName",
        value: process.env.INSTITUTION_NAME || "Demo University",
      },
    });
    await audit(tx, null, "SYNTHETIC_DATABASE_SEEDED");
  });
  mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  console.log(
    "Synthetic accounts seeded. Credentials stored only in .local/accounts.json.",
  );
}
if (require.main === module) {
  (process.argv[2] === "seed"
    ? seed().finally(() => db.$disconnect())
    : start()
  ).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
