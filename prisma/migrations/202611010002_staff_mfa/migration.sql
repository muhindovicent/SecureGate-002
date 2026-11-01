CREATE TYPE "AuthStage" AS ENUM ('FULL','MFA_REQUIRED','MFA_SETUP_REQUIRED');
ALTER TABLE "User" ADD COLUMN "mfaSecretEncrypted" TEXT, ADD COLUMN "mfaLastStep" BIGINT;
ALTER TABLE "Session" ADD COLUMN stage "AuthStage" NOT NULL DEFAULT 'FULL',
 ADD COLUMN "mfaPendingSecret" TEXT, ADD COLUMN "mfaVerifiedAt" TIMESTAMPTZ(3),
 ADD COLUMN "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE TABLE "MfaRecoveryCode" (
 id UUID NOT NULL PRIMARY KEY, "userId" UUID NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 digest TEXT NOT NULL UNIQUE, "usedAt" TIMESTAMPTZ(3),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MfaRecoveryCode_userId_usedAt_idx" ON "MfaRecoveryCode"("userId","usedAt");
CREATE TABLE "AuthThrottle" (id TEXT NOT NULL PRIMARY KEY,count INTEGER NOT NULL,"windowEnds" TIMESTAMPTZ(3) NOT NULL);
CREATE INDEX "AuthThrottle_windowEnds_idx" ON "AuthThrottle"("windowEnds");
-- Existing staff sessions predate mandatory MFA. Require fresh password authentication.
DELETE FROM "Session" USING "User" WHERE "Session"."userId"="User".id AND "User".role<>'STUDENT';
