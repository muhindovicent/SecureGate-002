import * as OTPAuth from "otpauth";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  transition,
  incidentTransition,
  authenticator,
  totpStep,
  sealMfaSecret,
  openMfaSecret,
  studentEmailMatches,
  sealQrCredential,
  openQrCredential,
  resolveWebOrigin,
} from "../apps/api/backend";
test("hosted authentication requires an explicit HTTPS origin and never falls back to localhost", () => {
  assert.equal(resolveWebOrigin({ NODE_ENV: "development" }), "http://localhost:5173");
  assert.equal(resolveWebOrigin({ NODE_ENV: "production", APP_ORIGIN: "https://secure-gate-002.vercel.app/" }), "https://secure-gate-002.vercel.app");
  for (const APP_ORIGIN of [undefined, "http://secure-gate-002.vercel.app", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://secure-gate-002.vercel.app/login", "https://user:password@example.com"])
    assert.throws(() => resolveWebOrigin({ NODE_ENV: "production", APP_ORIGIN }));
  assert.throws(() => resolveWebOrigin({ NODE_ENV: "development", RENDER: "true" }));
});
test("individual password hashes are salted and reject wrong passwords", () => {
  const a = hashPassword("a strong individual passphrase");
  const b = hashPassword("a strong individual passphrase");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("a strong individual passphrase", a), true);
  assert.equal(verifyPassword("wrong", a), false);
});
test("university email mapping preserves each complete student number and rejects lookalike domains", () => {
  assert.equal(studentEmailMatches("272200", "mv272200@student.cavendish.ac.ug"), true);
  assert.equal(studentEmailMatches("000272200", "ab000272200@student.cavendish.ac.ug"), true);
  assert.equal(studentEmailMatches("272200", "mv1272200@student.cavendish.ac.ug"), false);
  assert.equal(studentEmailMatches("272200", "mv272200@student.cavendish.ac.ug.evil"), false);
  assert.equal(studentEmailMatches("272200", "mv272201@student.cavendish.ac.ug"), false);
});
test("QR encryption is randomized and bound to the credential and student", () => {
  const raw = "sg1." + "x".repeat(43);
  const encrypted = sealQrCredential(raw, "credential-a", "student-a");
  assert.notEqual(encrypted, sealQrCredential(raw, "credential-a", "student-a"));
  assert.equal(openQrCredential(encrypted, "credential-a", "student-a"), raw);
  assert.throws(() => openQrCredential(encrypted, "credential-a", "student-b"));
  assert.throws(() => openQrCredential(encrypted, "credential-b", "student-a"));
});
test("entry does not toggle presence and missing exits require review", () => {
  assert.equal(transition(false, "ENTRY"), "APPROVED");
  assert.equal(transition(true, "ENTRY"), "ALREADY_INSIDE");
  assert.equal(transition(true, "EXIT"), "APPROVED");
  assert.equal(transition(false, "EXIT"), "REVIEW_REQUIRED");
});
test("incident lifecycle enforces review and allows attributable reopening", () => {
  assert.equal(incidentTransition("OPEN", "CLOSED"), false);
  assert.equal(incidentTransition("OPEN", "UNDER_REVIEW"), true);
  assert.equal(incidentTransition("UNDER_REVIEW", "RESOLVED"), true);
  assert.equal(incidentTransition("CLOSED", "UNDER_REVIEW"), true);
});

test("TOTP matches the RFC 6238 SHA-1 vector and checks time windows", () => {
  const secret = OTPAuth.Secret.fromUTF8("12345678901234567890").base32;
  assert.equal(
    authenticator(secret, "RFC vector", 8).generate({ timestamp: 59000 }),
    "94287082",
  );
  assert.equal(totpStep(secret, "287082", 59000), 1n);
  assert.equal(totpStep(secret, "287082", 59000 + 120000), null);
  assert.equal(totpStep(secret, "abcdef", 59000), null);
});
test("MFA encryption uses fresh nonces and rejects modified ciphertext", () => {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const a = sealMfaSecret(secret),
    b = sealMfaSecret(secret);
  assert.notEqual(a, b);
  assert.equal(openMfaSecret(a), secret);
  assert.equal(a.includes(secret), false);
  const parts = a.split(".");
  const body = Buffer.from(parts[2], "base64url");
  body[0] ^= 1;
  parts[2] = body.toString("base64url");
  assert.throws(() => openMfaSecret(parts.join(".")));
});
