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
} from "../apps/api/backend";
test("individual password hashes are salted and reject wrong passwords", () => {
  const a = hashPassword("a strong individual passphrase");
  const b = hashPassword("a strong individual passphrase");
  assert.notEqual(a, b);
  assert.equal(verifyPassword("a strong individual passphrase", a), true);
  assert.equal(verifyPassword("wrong", a), false);
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
