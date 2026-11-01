import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  start,
  hashPassword,
  authenticator,
  openMfaSecret,
} from "../apps/api/backend";

test("isolated PostgreSQL access-control and campus workflow", async (t) => {
  assert.match(
    new URL(process.env.DATABASE_URL!).pathname,
    /^\/sg_test_/,
    "Refuse to run against application database",
  );
  const app = await start();
  const url = "http://127.0.0.1:3001/api/v1/";
  const origin = process.env.APP_ORIGIN!;
  const accounts: any = {};
  async function req(
    who: string | undefined,
    path: string,
    method = "GET",
    body?: any,
    expected = 200,
  ) {
    const a = accounts[who || ""];
    const r = await fetch(url + path, {
      method,
      headers: {
        origin,
        "Content-Type": "application/json",
        ...(a?.cookie ? { cookie: a.cookie, "x-csrf-token": a.csrf } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await r.json();
    assert.equal(
      r.status,
      expected,
      `${method} ${path}: ${r.status} ${json.message || ""}`,
    );
    return json;
  }
  try {
    for (const role of [
      "STUDENT",
      "OFFICER",
      "VERIFIER",
      "SUPERVISOR",
      "REGISTRAR",
      "ADMIN",
      "MANAGEMENT",
      "AUDITOR",
      "OTHER",
    ]) {
      const password = randomBytes(18).toString("hex");
      const u = await db.user.create({
        data: {
          name: "Test " + role,
          email: role.toLowerCase() + "@test.invalid",
          passwordHash: hashPassword(password),
          role: role === "OTHER" ? "STUDENT" : (role as any),
        },
      });
      if (["STUDENT", "OTHER"].includes(role))
        await db.student.create({
          data: {
            userId: u.id,
            registration: "TEST-" + role,
            program: "Test program",
          },
        });
      const r = await fetch(url + "auth/login", {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: u.email, password }),
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      accounts[role] = {
        ...data,
        cookie: r.headers.get("set-cookie")!.split(";")[0],
      };
      if (data.stage === "MFA_SETUP_REQUIRED") {
        const setup = await req(role, "auth/mfa/setup", "POST", {}, 201);
        const confirm = await fetch(url + "auth/mfa/confirm", {
          method: "POST",
          headers: {
            origin,
            "Content-Type": "application/json",
            cookie: accounts[role].cookie,
            "x-csrf-token": accounts[role].csrf,
          },
          body: JSON.stringify({
            code: authenticator(setup.secret).generate(),
          }),
        });
        assert.equal(confirm.status, 201);
        const verified = await confirm.json();
        accounts[role] = {
          ...verified,
          cookie: confirm.headers.get("set-cookie")!.split(";")[0],
        };
      }
    }
    const student = await db.student.findUniqueOrThrow({
      where: { userId: accounts.STUDENT.user.id },
    });
    let credential = "",
      gadget: any,
      terminals: any[] = [];
    const mfaPassword = randomBytes(18).toString("hex");
    const mfaUser = await db.user.create({
      data: {
        email: "mfa-safety@test.invalid",
        name: "MFA safety test",
        role: "AUDITOR",
        passwordHash: hashPassword(mfaPassword),
      },
    });
    let mfaSecret = "",
      mfaCodes: string[] = [];
    async function signInMfa(password = mfaPassword) {
      const r = await fetch(url + "auth/login", {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: mfaUser.email, password }),
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      accounts.MFA_TEST = {
        ...data,
        cookie: r.headers.get("set-cookie")!.split(";")[0],
      };
      return data;
    }
    async function finishMfa(path: string, body: object) {
      const old = accounts.MFA_TEST;
      const r = await fetch(url + path, {
        method: "POST",
        headers: {
          origin,
          "Content-Type": "application/json",
          cookie: old.cookie,
          "x-csrf-token": old.csrf,
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 201);
      const data = await r.json();
      accounts.MFA_TEST = {
        ...data,
        cookie: r.headers.get("set-cookie")!.split(";")[0],
      };
      assert.notEqual(old.cookie, accounts.MFA_TEST.cookie);
      return data;
    }
    await t.test(
      "password-only staff sessions cannot access operations or skip MFA enrollment",
      async () => {
        assert.equal((await signInMfa()).stage, "MFA_SETUP_REQUIRED");
        await req("MFA_TEST", "audit-events", "GET", undefined, 403);
        await req(
          "MFA_TEST",
          "auth/mfa/verify",
          "POST",
          { code: "123456" },
          409,
        );
        const setup = await req("MFA_TEST", "auth/mfa/setup", "POST", {}, 201);
        mfaSecret = setup.secret;
        assert.ok(setup.uri.startsWith("otpauth://totp/"));
        const raw = await db.session.findUniqueOrThrow({
          where: {
            id: await import("node:crypto").then((c) =>
              c
                .createHash("sha256")
                .update(accounts.MFA_TEST.cookie.split("=")[1])
                .digest("hex"),
            ),
          },
        });
        assert.ok(raw.mfaPendingSecret);
        assert.notEqual(raw.mfaPendingSecret, mfaSecret);
        await req(
          "MFA_TEST",
          "auth/mfa/confirm",
          "POST",
          { code: "abcdef" },
          400,
        );
        const confirmed = await finishMfa("auth/mfa/confirm", {
          code: authenticator(mfaSecret).generate(),
        });
        mfaCodes = confirmed.recoveryCodes;
        assert.equal(mfaCodes.length, 12);
        assert.equal(confirmed.stage, "FULL");
        const stored = await db.user.findUniqueOrThrow({
          where: { id: mfaUser.id },
        });
        assert.notEqual(stored.mfaSecretEncrypted, mfaSecret);
        assert.equal(openMfaSecret(stored.mfaSecretEncrypted!), mfaSecret);
        await req("MFA_TEST", "audit-events");
      },
    );
    await t.test(
      "authenticator replay and re-enrollment are rejected; recovery codes work once",
      async () => {
        assert.equal((await signInMfa()).stage, "MFA_REQUIRED");
        await req("MFA_TEST", "audit-events", "GET", undefined, 403);
        await req("MFA_TEST", "auth/mfa/setup", "POST", {}, 409);
        const used = await db.user.findUniqueOrThrow({
          where: { id: mfaUser.id },
        });
        const consumed = authenticator(mfaSecret).generate({
          timestamp: Number(used.mfaLastStep) * 30000,
        });
        await req(
          "MFA_TEST",
          "auth/mfa/verify",
          "POST",
          { code: consumed },
          401,
        );
        await finishMfa("auth/mfa/verify", { code: mfaCodes[0] });
        await signInMfa();
        await req(
          "MFA_TEST",
          "auth/mfa/verify",
          "POST",
          { code: mfaCodes[0] },
          401,
        );
        await finishMfa("auth/mfa/verify", { code: mfaCodes[1] });
        assert.equal(
          await db.mfaRecoveryCode.count({
            where: { userId: mfaUser.id, usedAt: { not: null } },
          }),
          2,
        );
      },
    );
    await t.test(
      "concurrent use of a recovery code grants exactly one session",
      async () => {
        await signInMfa();
        const one = { ...accounts.MFA_TEST };
        await signInMfa();
        const two = { ...accounts.MFA_TEST };
        const send = (ctx: any) =>
          fetch(url + "auth/mfa/verify", {
            method: "POST",
            headers: {
              origin,
              "Content-Type": "application/json",
              cookie: ctx.cookie,
              "x-csrf-token": ctx.csrf,
            },
            body: JSON.stringify({ code: mfaCodes[2] }),
          });
        const results = await Promise.all([send(one), send(two)]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 401]);
        const winner = results.find((r) => r.status === 201)!;
        const data = await winner.json();
        accounts.MFA_TEST = {
          ...data,
          cookie: winner.headers.get("set-cookie")!.split(";")[0],
        };
      },
    );
    await t.test(
      "password changes require reauthentication, rotate cookies and invalidate other sessions",
      async () => {
        const oldFull = { ...accounts.MFA_TEST };
        await signInMfa();
        await finishMfa("auth/mfa/verify", { code: mfaCodes[3] });
        await req(
          "MFA_TEST",
          "auth/password",
          "POST",
          {
            currentPassword: "wrong",
            newPassword: randomBytes(18).toString("hex"),
            code: mfaCodes[4],
          },
          401,
        );
        const replacement = randomBytes(18).toString("hex");
        await finishMfa("auth/password", {
          currentPassword: mfaPassword,
          newPassword: replacement,
          code: mfaCodes[4],
        });
        accounts.OLD_MFA = oldFull;
        await req("OLD_MFA", "me", "GET", undefined, 401);
        const oldPassword = await fetch(url + "auth/login", {
          method: "POST",
          headers: { origin, "Content-Type": "application/json" },
          body: JSON.stringify({ email: mfaUser.email, password: mfaPassword }),
        });
        assert.equal(oldPassword.status, 401);
        await signInMfa(replacement);
        await finishMfa("auth/mfa/verify", { code: mfaCodes[5] });
        const me = await req("MFA_TEST", "me");
        assert.equal(me.mfaEnabled, true);
        assert.equal("mfaSecretEncrypted" in me.user, false);
      },
    );
    await t.test(
      "rotated recovery codes invalidate previous codes without exposing stored secrets",
      async () => {
        const passwordRow = await db.user.findUniqueOrThrow({
          where: { id: mfaUser.id },
        });
        // Use a dedicated password so the test can verify audited recovery regeneration.
        const password = randomBytes(18).toString("hex");
        await db.user.update({
          where: { id: mfaUser.id },
          data: { passwordHash: hashPassword(password) },
        });
        const rotated = await req(
          "MFA_TEST",
          "auth/mfa/recovery-codes",
          "POST",
          { currentPassword: password, code: mfaCodes[6] },
          201,
        );
        assert.equal(rotated.recoveryCodes.length, 12);
        await signInMfa(password);
        await req(
          "MFA_TEST",
          "auth/mfa/verify",
          "POST",
          { code: mfaCodes[7] },
          401,
        );
        await finishMfa("auth/mfa/verify", { code: rotated.recoveryCodes[0] });
        const records = await req("MFA_TEST", "audit-events");
        const serialized = JSON.stringify(records);
        assert.equal(serialized.includes(mfaSecret), false);
        assert.equal(serialized.includes(rotated.recoveryCodes[0]), false);
        assert.ok(
          records.some((r: any) => r.action === "MFA_RECOVERY_CODES_ROTATED"),
        );
      },
    );
    await t.test(
      "optional student enrollment expires and never grants staff permissions",
      async () => {
        const setup = await req(
          "OTHER",
          "auth/mfa/setup",
          "POST",
          { currentPassword: "wrong" },
          401,
        );
        assert.equal(setup.statusCode, 401);
        // A deliberately expired enrollment session remains unable to enable a secret.
        const session = await db.session.findFirstOrThrow({
          where: { userId: accounts.OTHER.user.id },
        });
        await db.session.update({
          where: { id: session.id },
          data: {
            mfaPendingSecret: await import("../apps/api/backend").then((m) =>
              m.sealMfaSecret(mfaSecret),
            ),
            mfaPendingExpiresAt: new Date(Date.now() - 1000),
          },
        });
        await req(
          "OTHER",
          "auth/mfa/confirm",
          "POST",
          { code: authenticator(mfaSecret).generate() },
          409,
        );
        await req("OTHER", "users", "GET", undefined, 403);
      },
    );

    await t.test(
      "health checks real PostgreSQL and protected routes reject anonymous requests",
      async () => {
        assert.equal((await req(undefined, "health")).database, "connected");
        await req(undefined, "me", "GET", undefined, 401);
      },
    );
    await t.test(
      "registrar enrolls a verified student and credentials never leak in list output",
      async () => {
        const s = await req(
          "REGISTRAR",
          "students",
          "POST",
          {
            email: "new@test.invalid",
            name: "New Student",
            registration: "NEW-001",
            program: "Computing",
            password: randomBytes(18).toString("hex"),
          },
          201,
        );
        assert.ok(s.id);
        const c = await req(
          "REGISTRAR",
          "credentials",
          "POST",
          { studentId: student.id },
          201,
        );
        credential = c.credential;
        assert.match(credential, /^sg1\.[A-Za-z0-9_-]{43}$/);
        const list = await req("STUDENT", "credentials");
        assert.equal(JSON.stringify(list).includes("digest"), false);
        assert.equal(JSON.stringify(list).includes(credential), false);
      },
    );
    await t.test(
      "cross-user and role escalation requests are rejected",
      async () => {
        await req("STUDENT", "students", "GET", undefined, 403);
        await req("ADMIN", "movements", "GET", undefined, 403);
        await req("REGISTRAR", "incidents", "GET", undefined, 403);
        await req("MANAGEMENT", "audit-events", "GET", undefined, 403);
        const other = await req("OTHER", "credentials?studentId=" + student.id);
        assert.deepEqual(other, []);
        await req(
          "STUDENT",
          "gadgets",
          "POST",
          {
            category: "Laptop",
            manufacturer: "Lenovo",
            model: "T14",
            serial: "TEST01",
            status: "APPROVED",
          },
          400,
        );
      },
    );
    await t.test("CSRF and request origins are enforced", async () => {
      const r = await fetch(url + "credentials/lost", {
        method: "POST",
        headers: {
          origin: "https://evil.invalid",
          cookie: accounts.STUDENT.cookie,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(r.status, 403);
    });
    await t.test(
      "student submits gadget and independent verifier physically approves",
      async () => {
        gadget = await req(
          "STUDENT",
          "gadgets",
          "POST",
          {
            category: "Laptop",
            manufacturer: "Lenovo",
            model: "ThinkPad T14",
            serial: "TEST-LAPTOP-001",
          },
          201,
        );
        assert.equal(gadget.status, "PENDING");
        await req(
          "STUDENT",
          `gadgets/${gadget.id}/verify`,
          "POST",
          {
            approved: true,
            physicalCheck: true,
            reason: "Inspected serial and ownership evidence",
          },
          403,
        );
        await req(
          "VERIFIER",
          `gadgets/${gadget.id}/verify`,
          "POST",
          { approved: true, physicalCheck: false, reason: "Not inspected" },
          400,
        );
        const g = await req(
          "VERIFIER",
          `gadgets/${gadget.id}/verify`,
          "POST",
          {
            approved: true,
            physicalCheck: true,
            reason: "Inspected serial and ownership evidence",
          },
          201,
        );
        assert.equal(g.status, "APPROVED");
        assert.ok(
          (await req("STUDENT", "notifications")).some((n: any) =>
            n.message.includes("Gadget"),
          ),
        );
      },
    );
    await t.test(
      "administrator provisions and assigns checkpoints; unassigned terminals reject lookup",
      async () => {
        for (const direction of ["ENTRY", "EXIT"]) {
          const terminal = await req(
            "ADMIN",
            "terminals",
            "POST",
            {
              name: direction + " test",
              gate: "Test gate",
              direction,
              lane: "GADGET",
              mode: "ASSISTED",
            },
            201,
          );
          terminals.push(terminal);
          await req(
            "OFFICER",
            "scans/lookup",
            "POST",
            { credential, terminalId: terminal.id },
            403,
          );
          await req(
            "ADMIN",
            `terminals/${terminal.id}/assign`,
            "POST",
            { userId: accounts.OFFICER.user.id },
            201,
          );
        }
        const r = await req(
          "OFFICER",
          "scans/lookup",
          "POST",
          { credential, terminalId: terminals[0].id },
          201,
        );
        assert.equal(r.student.id, student.id);
        assert.equal(r.gadgets[0].id, gadget.id);
      },
    );
    const payload = () => ({
      requestId: randomUUID(),
      credential,
      terminalId: terminals[0].id,
      gadgetIds: [gadget.id],
      identityChecked: true,
      physicalCheck: true,
    });
    let first: any;
    await t.test(
      "scan retries are idempotent and payload reuse conflicts",
      async () => {
        const d = payload();
        first = await req("OFFICER", "scans", "POST", d, 201);
        assert.equal(first.outcome, "APPROVED");
        assert.equal(first.confirmed, true);
        const r = await req("OFFICER", "scans", "POST", d, 201);
        assert.equal(r.movementId, first.movementId);
        assert.equal(r.duplicate, true);
        await req("OFFICER", "scans", "POST", { ...d, gadgetIds: [] }, 409);
        assert.equal(
          await db.visit.count({
            where: { studentId: student.id, exitedAt: null },
          }),
          1,
        );
      },
    );
    await t.test(
      "concurrent duplicate entries never create a second active visit",
      async () => {
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            req("OFFICER", "scans", "POST", payload(), 201),
          ),
        );
        assert.ok(results.every((r) => r.outcome === "ALREADY_INSIDE"));
        assert.equal(
          await db.visit.count({
            where: { studentId: student.id, exitedAt: null },
          }),
          1,
        );
      },
    );
    await t.test(
      "simultaneous first entries create exactly one active visit",
      async () => {
        const other = await db.student.findUniqueOrThrow({
          where: { userId: accounts.OTHER.user.id },
        });
        const c = await req(
          "REGISTRAR",
          "credentials",
          "POST",
          { studentId: other.id },
          201,
        );
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            req(
              "OFFICER",
              "scans",
              "POST",
              { ...payload(), credential: c.credential, gadgetIds: [] },
              201,
            ),
          ),
        );
        assert.equal(results.filter((r) => r.outcome === "APPROVED").length, 1);
        assert.equal(
          results.filter((r) => r.outcome === "ALREADY_INSIDE").length,
          7,
        );
        assert.equal(
          await db.visit.count({
            where: { studentId: other.id, exitedAt: null },
          }),
          1,
        );
        await req(
          "OFFICER",
          "scans",
          "POST",
          {
            ...payload(),
            credential: c.credential,
            gadgetIds: [],
            terminalId: terminals[1].id,
          },
          201,
        );
      },
    );
    await t.test(
      "database independently rejects a duplicate active visit",
      async () => {
        await assert.rejects(
          db.visit.create({ data: { studentId: student.id } }),
        );
        assert.equal(
          await db.visit.count({
            where: { studentId: student.id, exitedAt: null },
          }),
          1,
        );
      },
    );
    await t.test(
      "exit gadget discrepancy preserves open visit and creates a review case",
      async () => {
        const r = await req(
          "OFFICER",
          "scans",
          "POST",
          { ...payload(), terminalId: terminals[1].id, gadgetIds: [] },
          201,
        );
        assert.equal(r.outcome, "REVIEW_REQUIRED");
        assert.equal(r.confirmed, false);
        assert.equal(
          await db.visit.count({
            where: { studentId: student.id, exitedAt: null },
          }),
          1,
        );
      },
    );
    await t.test("reconciled exit closes visit and gadget record", async () => {
      const r = await req(
        "OFFICER",
        "scans",
        "POST",
        { ...payload(), terminalId: terminals[1].id },
        201,
      );
      assert.equal(r.confirmed, true);
      assert.equal(
        await db.visit.count({
          where: { studentId: student.id, exitedAt: null },
        }),
        0,
      );
      const g = await db.visitGadget.findUniqueOrThrow({
        where: {
          visitId_gadgetId: { visitId: first.visitId, gadgetId: gadget.id },
        },
      });
      assert.ok(g.exitedAt);
    });
    await t.test(
      "management sees measured aggregates without personal student histories",
      async () => {
        const r = await req("MANAGEMENT", "reports");
        assert.equal(r.entries, 2);
        assert.equal(r.exits, 2);
        assert.equal(r.estimatedOccupancy, 0);
        assert.equal(JSON.stringify(r).includes(student.registration), false);
      },
    );
    await t.test(
      "incident progression and independent override approval are audited",
      async () => {
        const i = await req(
          "SUPERVISOR",
          "incidents",
          "POST",
          { category: "OTHER", description: "Test incident" },
          201,
        );
        await req(
          "SUPERVISOR",
          `incidents/${i.id}/status`,
          "POST",
          { status: "CLOSED", note: "Skip review" },
          409,
        );
        await req(
          "SUPERVISOR",
          `incidents/${i.id}/status`,
          "POST",
          { status: "UNDER_REVIEW", note: "Investigating" },
          201,
        );
        const own = await req(
          "SUPERVISOR",
          "overrides",
          "POST",
          { incidentId: i.id, reason: "Needs independent supervisor" },
          201,
        );
        await req(
          "SUPERVISOR",
          `overrides/${own.id}/decide`,
          "POST",
          { approved: true, reason: "Self approval attempt" },
          403,
        );
        const i2 = await req(
          "OFFICER",
          "incidents",
          "POST",
          { category: "OTHER", description: "Independent review case" },
          201,
        );
        const o = await req(
          "OFFICER",
          "overrides",
          "POST",
          { incidentId: i2.id, reason: "Supervisor review needed" },
          201,
        );
        const decision = await req(
          "SUPERVISOR",
          `overrides/${o.id}/decide`,
          "POST",
          { approved: true, reason: "Evidence reviewed" },
          201,
        );
        assert.equal(decision.status, "APPROVED");
      },
    );
    await t.test("lost-ID revocation takes effect immediately", async () => {
      await req("STUDENT", "credentials/lost", "POST", {}, 201);
      await req(
        "OFFICER",
        "scans/lookup",
        "POST",
        { credential, terminalId: terminals[0].id },
        403,
      );
      await req("OFFICER", "scans", "POST", payload(), 403);
    });
    await t.test(
      "malformed scan input is rejected and no QR secrets enter audit records",
      async () => {
        await req(
          "OFFICER",
          "scans",
          "POST",
          { ...payload(), credential: "' OR 1=1; --" },
          400,
        );
        const audits = await req("AUDITOR", "audit-events");
        assert.ok(audits.some((a: any) => a.action === "CREDENTIAL_ISSUED"));
        assert.ok(audits.some((a: any) => a.action === "MOVEMENT_APPROVED"));
        assert.equal(JSON.stringify(audits).includes(credential), false);
      },
    );
    await t.test(
      "movement and audit history reject database updates and deletes",
      async () => {
        await assert.rejects(
          db.movement.update({
            where: { id: first.movementId },
            data: { outcome: "FORGED" },
          }),
        );
        const a = await db.audit.findFirstOrThrow();
        await assert.rejects(db.audit.delete({ where: { id: a.id } }));
      },
    );
    await t.test(
      "transaction failure rolls back all intermediate records",
      async () => {
        const before = await db.incident.count();
        await assert.rejects(
          db.$transaction(async (tx) => {
            await tx.incident.create({
              data: {
                category: "TEST",
                description: "rollback",
                reporterId: accounts.OFFICER.user.id,
              },
            });
            throw new Error("intentional rollback");
          }),
        );
        assert.equal(await db.incident.count(), before);
      },
    );
    await t.test("login throttles repeated failures", async () => {
      for (let i = 0; i < 5; i++)
        await req(
          undefined,
          "auth/login",
          "POST",
          { email: "missing@test.invalid", password: "wrong" },
          401,
        );
      await req(
        undefined,
        "auth/login",
        "POST",
        { email: "missing@test.invalid", password: "wrong" },
        429,
      );
    });
    await t.test("logout invalidates the server-side session", async () => {
      await req("OTHER", "auth/logout", "POST", {}, 201);
      await req("OTHER", "me", "GET", undefined, 401);
    });
  } finally {
    await app.close();
    await db.$disconnect();
  }
});
