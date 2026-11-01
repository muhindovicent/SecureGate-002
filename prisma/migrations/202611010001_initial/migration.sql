-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'OFFICER', 'VERIFIER', 'SUPERVISOR', 'REGISTRAR', 'ADMIN', 'MANAGEMENT', 'AUDITOR');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GadgetStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'RETIRED', 'LOST');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('ENTRY', 'EXIT');

-- CreateEnum
CREATE TYPE "Lane" AS ENUM ('EXPRESS', 'GADGET');

-- CreateEnum
CREATE TYPE "PassageMode" AS ENUM ('ASSISTED', 'REGISTRATION_ONLY');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "csrf" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "registration" TEXT NOT NULL,
    "program" TEXT NOT NULL,
    "enrollment" TEXT NOT NULL DEFAULT 'ACTIVE',
    "photoUrl" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "digest" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gadget" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "GadgetStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedBy" UUID,
    "verifiedAt" TIMESTAMPTZ(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gadget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Custody" (
    "id" UUID NOT NULL,
    "gadgetId" UUID NOT NULL,
    "custodianId" UUID NOT NULL,
    "approvedBy" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "revoked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Custody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Terminal" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "lane" "Lane" NOT NULL,
    "mode" "PassageMode" NOT NULL DEFAULT 'ASSISTED',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeen" TIMESTAMPTZ(3),

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "userId" UUID NOT NULL,
    "terminalId" UUID NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("userId","terminalId")
);

-- CreateTable
CREATE TABLE "Visit" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "enteredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitGadget" (
    "visitId" UUID NOT NULL,
    "gadgetId" UUID NOT NULL,
    "exitedAt" TIMESTAMPTZ(3),

    CONSTRAINT "VisitGadget_pkey" PRIMARY KEY ("visitId","gadgetId")
);

-- CreateTable
CREATE TABLE "Movement" (
    "id" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "terminalId" UUID NOT NULL,
    "operatorId" UUID NOT NULL,
    "direction" "Direction" NOT NULL,
    "confirmed" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "visitId" UUID,
    "gadgetIds" UUID[],
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "description" TEXT NOT NULL,
    "studentId" UUID,
    "reporterId" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentAction" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Override" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "requestedBy" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" UUID,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_registration_key" ON "Student"("registration");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_digest_key" ON "Credential"("digest");

-- CreateIndex
CREATE INDEX "Credential_studentId_status_idx" ON "Credential"("studentId", "status");

-- CreateIndex
CREATE INDEX "Gadget_serial_idx" ON "Gadget"("serial");

-- CreateIndex
CREATE INDEX "Gadget_studentId_status_idx" ON "Gadget"("studentId", "status");

-- CreateIndex
CREATE INDEX "Visit_studentId_enteredAt_idx" ON "Visit"("studentId", "enteredAt");

-- CreateIndex
CREATE INDEX "Movement_studentId_createdAt_idx" ON "Movement"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "Movement_terminalId_createdAt_idx" ON "Movement"("terminalId", "createdAt");

-- CreateIndex
CREATE INDEX "Incident_studentId_createdAt_idx" ON "Incident"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "Audit_createdAt_idx" ON "Audit"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gadget" ADD CONSTRAINT "Gadget_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_gadgetId_fkey" FOREIGN KEY ("gadgetId") REFERENCES "Gadget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitGadget" ADD CONSTRAINT "VisitGadget_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitGadget" ADD CONSTRAINT "VisitGadget_gadgetId_fkey" FOREIGN KEY ("gadgetId") REFERENCES "Gadget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentAction" ADD CONSTRAINT "IncidentAction_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Override" ADD CONSTRAINT "Override_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma cannot express a partial unique index: only one confirmed active visit.
CREATE UNIQUE INDEX "Visit_one_active_per_student" ON "Visit" ("studentId") WHERE "exitedAt" IS NULL;
CREATE UNIQUE INDEX "Credential_one_active_per_student" ON "Credential" ("studentId") WHERE status = 'ACTIVE';
ALTER TABLE "Custody" ADD CONSTRAINT "Custody_period_valid" CHECK ("endsAt" > "startsAt");
ALTER TABLE "Visit" ADD CONSTRAINT "Visit_time_order" CHECK ("exitedAt" IS NULL OR "exitedAt" >= "enteredAt");
ALTER TABLE "Student" ADD CONSTRAINT "Student_enrollment_valid" CHECK (enrollment IN ('ACTIVE','SUSPENDED','GRADUATED','WITHDRAWN'));
ALTER TABLE "Movement" ADD CONSTRAINT "Movement_duration_valid" CHECK ("durationMs" >= 0);
-- Historical events are append-only through normal SQL DML, even for the application owner.
-- A DB owner can still drop triggers; production needs separate migration/runtime roles and external audit export.
CREATE FUNCTION securegate_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SecureGate history is append-only'; END;
$$;
CREATE TRIGGER "Movement_immutable" BEFORE UPDATE OR DELETE ON "Movement" FOR EACH ROW EXECUTE FUNCTION securegate_reject_history_mutation();
CREATE TRIGGER "Audit_immutable" BEFORE UPDATE OR DELETE ON "Audit" FOR EACH ROW EXECUTE FUNCTION securegate_reject_history_mutation();
CREATE TRIGGER "IncidentAction_immutable" BEFORE UPDATE OR DELETE ON "IncidentAction" FOR EACH ROW EXECUTE FUNCTION securegate_reject_history_mutation();
-- Matching serials remain review cases, but two approved registrations cannot coexist.
CREATE UNIQUE INDEX "Gadget_approved_serial" ON "Gadget" (serial) WHERE status = 'APPROVED';
