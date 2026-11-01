-- Existing identities remain unverified until the registrar checks their source records.
ALTER TABLE "Student" ADD COLUMN "identityVerifiedAt" TIMESTAMPTZ(3),
  ADD COLUMN "identityVerifiedBy" UUID;
ALTER TABLE "Student" ADD CONSTRAINT "Student_identityVerifiedBy_fkey"
  FOREIGN KEY ("identityVerifiedBy") REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Student" ADD CONSTRAINT "Student_identity_verification_pair"
  CHECK (("identityVerifiedAt" IS NULL) = ("identityVerifiedBy" IS NULL));
ALTER TABLE "Student" ADD CONSTRAINT "Student_verified_number_format"
  CHECK ("identityVerifiedAt" IS NULL OR registration ~ '^[0-9]{4,20}$');
CREATE UNIQUE INDEX "User_email_case_insensitive_key" ON "User" (lower(email));

-- Validate the verified relationship independently of HTTP input validation.
CREATE FUNCTION securegate_validate_student_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_email TEXT; account_role "Role"; verifier_role "Role";
BEGIN
  IF NEW."identityVerifiedAt" IS NOT NULL THEN
    SELECT email, role INTO account_email, account_role FROM "User" WHERE id = NEW."userId" FOR KEY SHARE;
    SELECT role INTO verifier_role FROM "User" WHERE id = NEW."identityVerifiedBy";
    IF account_role <> 'STUDENT' OR verifier_role IS DISTINCT FROM 'REGISTRAR'
      OR account_email !~ ('^[a-z][a-z._-]*' || NEW.registration || '@student[.]cavendish[.]ac[.]ug$') THEN
      RAISE EXCEPTION 'Verified student identity requires a registrar and a matching university email';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Student_verified_identity" BEFORE INSERT OR UPDATE ON "Student"
  FOR EACH ROW EXECUTE FUNCTION securegate_validate_student_identity();

CREATE FUNCTION securegate_validate_student_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE student_number TEXT;
BEGIN
  SELECT registration INTO student_number FROM "Student"
    WHERE "userId" = NEW.id AND "identityVerifiedAt" IS NOT NULL;
  IF FOUND AND (NEW.role <> 'STUDENT'
    OR NEW.email !~ ('^[a-z][a-z._-]*' || student_number || '@student[.]cavendish[.]ac[.]ug$')) THEN
    RAISE EXCEPTION 'University email must match the verified student number';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "User_verified_student_account" BEFORE UPDATE OF email, role ON "User"
  FOR EACH ROW EXECUTE FUNCTION securegate_validate_student_account();

-- Legacy digests cannot be reversed. Registrar reissuance enables owner QR display.
ALTER TABLE "Credential" ADD COLUMN "encryptedValue" TEXT;
