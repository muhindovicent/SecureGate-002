import { dirname, resolve } from "node:path";
import { test, expect, Page } from "@playwright/test";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import * as OTPAuth from "otpauth";
import { randomInt, randomBytes } from "node:crypto";
const accounts = JSON.parse(
  readFileSync(process.env.LOCAL_ACCOUNTS_PATH!, "utf8"),
);
const recoveryFixture = resolve(
  dirname(process.env.LOCAL_ACCOUNTS_PATH!),
  "mfa-recovery.json",
);
const backupCodes: Record<string, string[]> = existsSync(recoveryFixture)
  ? JSON.parse(readFileSync(recoveryFixture, "utf8"))
  : {};
function saveRecoveryFixture() {
  writeFileSync(recoveryFixture, JSON.stringify(backupCodes), { mode: 0o600 });
}
function nextRecoveryCode(role: string) {
  const code = backupCodes[role]?.shift();
  saveRecoveryFixture();
  return code;
}
async function login(page: Page, role: string) {
  const account = accounts.find((a: any) => a.role === role);
  await page.goto("/login");
  await page.getByLabel("Student ID or university email").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await expect
    .poll(
      async () =>
        (await page.locator(".mfa-card").isVisible()) ||
        (await page.getByRole("button", { name: "Sign out" }).isVisible()),
    )
    .toBe(true);
  if (
    await page
      .getByRole("heading", { name: "Set up account protection" })
      .isVisible()
  ) {
    await page
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    const key = page.getByLabel("Authenticator setup key");
    await expect(key).toBeVisible();
    const secret = (await key.textContent())!;
    await page.getByLabel("Six-digit authenticator code").fill(
      new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret),
      }).generate(),
    );
    await page.getByRole("button", { name: "Confirm authenticator" }).click();
    await expect(
      page.getByRole("heading", { name: "Save your recovery codes" }),
    ).toBeVisible();
    backupCodes[role] = await page
      .locator(".recovery-grid code")
      .allTextContents();
    saveRecoveryFixture();
    await page
      .getByRole("button", { name: "I’ve saved my recovery codes" })
      .click();
  } else if (
    await page.getByRole("heading", { name: "Verify it’s you" }).isVisible()
  ) {
    const code = nextRecoveryCode(role);
    if (!code) throw new Error("Test account recovery fixture unavailable");
    await page.getByLabel("Authenticator or recovery code").fill(code);
    await page.getByRole("button", { name: "Verify & continue" }).click();
  }
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function logout(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
}
test("student, registrar, verifier and officer complete a real gadget visit", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await login(page, "REGISTRAR");
  await page.getByRole("button", { name: "Manage ID" }).first().click();
  await page.getByLabel("I verified this student").check();
  await page
    .getByRole("button", { name: "Issue replacement credential" })
    .click();
  const qr = page.getByLabel("Issued opaque QR credential");
  await expect(qr).toBeVisible();
  const credential = await qr.inputValue();
  expect(credential).toMatch(/^sg1\./);
  await logout(page);
  await login(page, "STUDENT");
  await page.getByRole("link", { name: "Student ID", exact: true }).click();
  const personalQrResponse = page.waitForResponse((r) => r.url().endsWith("/credentials/qr"));
  await page.getByRole("button", { name: "Show my QR credential" }).click();
  expect((await (await personalQrResponse).json()).credential).toBe(credential);
  await expect(page.getByRole("img", { name: "Your personal campus QR credential" })).toBeVisible();
  await page.getByRole("button", { name: "Hide my QR" }).click();
  await expect(page.getByRole("img", { name: "Your personal campus QR credential" })).toHaveCount(0);
  await page.getByRole("link", { name: "My gadgets", exact: true }).click();
  const serial = "BROWSER-" + Date.now();
  await page.getByLabel("Category", { exact: true }).selectOption("Laptop");
  await page.getByLabel("Manufacturer", { exact: true }).fill("Framework");
  await page.getByLabel("Model", { exact: true }).fill("Laptop 13");
  await page.getByLabel("Physical serial number").fill(serial);
  await page.getByRole("button", { name: "Submit for verification" }).click();
  await expect(
    page.locator(".gadget-row").filter({ hasText: serial }),
  ).toContainText("Pending");
  await page.goto("/admin/users");
  await expect(
    page.getByRole("heading", { name: "Access restricted" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to your workspace" }).click();
  await logout(page);
  await login(page, "VERIFIER");
  await page
    .locator(".gadget-row")
    .filter({ hasText: serial })
    .getByRole("button", { name: "Inspect" })
    .click();
  await page.getByLabel("Decision", { exact: true }).selectOption("APPROVED");
  await page
    .getByLabel("Inspection findings")
    .fill("Physically checked synthetic laptop serial and ownership evidence.");
  await page.getByLabel("I physically inspected the device").check();
  await page
    .getByRole("button", { name: "Save verification decision" })
    .click();
  await expect(
    page.locator(".gadget-row").filter({ hasText: serial }),
  ).toContainText("Approved");
  await logout(page);
  await login(page, "OFFICER");
  await page
    .getByRole("link", { name: "Scan checkpoint", exact: true })
    .click();
  for (const direction of ["entry", "exit"]) {
    await expect(page.getByLabel("Assigned checkpoint")).toBeVisible();
    const options = await page
      .getByLabel("Assigned checkpoint")
      .locator("option")
      .allTextContents();
    const label = options.find((s) => s.startsWith("Gadget " + direction));
    expect(label).toBeTruthy();
    await page.getByLabel("Assigned checkpoint").selectOption({ label });
    await page.getByLabel("Opaque credential").fill(credential);
    await page.getByRole("button", { name: "Look up credential" }).click();
    await expect(
      page.getByRole("heading", { name: "Amina Nakato (synthetic)" }),
    ).toBeVisible();
    await page
      .locator(".gadget-select")
      .filter({ hasText: serial })
      .getByRole("checkbox")
      .check();
    await page.getByLabel("I compared the student").check();
    await page.getByLabel("I inspected presented gadgets").check();
    await page
      .getByRole("button", { name: "Confirm " + direction, exact: true })
      .click();
    await expect(page.locator(".scan-result")).toContainText(
      "Officer-confirmed passage recorded",
    );
    await page.getByRole("button", { name: "Next student" }).click();
  }
  await logout(page);
  await login(page, "STUDENT");
  await page
    .getByRole("link", { name: "Movement history", exact: true })
    .click();
  await expect(page.getByRole("table")).toContainText("Entry");
  await expect(page.getByRole("table")).toContainText("Exit");
  await page.getByRole("link", { name: "Student ID", exact: true }).click();
  await page.getByLabel("I confirm my student ID is lost").check();
  await page.getByRole("button", { name: "Report lost ID & revoke" }).click();
  await expect(page.locator(".list-row")).toContainText(["Revoked"]);
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  mkdirSync(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: ".local/screenshots/student-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".local/screenshots/student-mobile.png",
    fullPage: true,
  });
  expect(problems).toEqual([]);
});

test("all role navigation resolves authorized functional screens", async ({
  page,
}) => {
  const paths: Record<string, string[]> = {
    STUDENT: ["/student/profile", "/student/reports"],
    OFFICER: ["/security/dashboard", "/security/incidents"],
    REGISTRAR: ["/registration/students", "/registration/credentials"],
    VERIFIER: ["/registration/gadgets"],
    SUPERVISOR: [
      "/supervisor/dashboard",
      "/supervisor/incidents",
      "/supervisor/overrides",
      "/supervisor/terminals",
    ],
    ADMIN: [
      "/admin/dashboard",
      "/admin/users",
      "/admin/roles",
      "/admin/gates",
      "/admin/terminals",
      "/admin/settings",
    ],
    MANAGEMENT: ["/management/dashboard", "/management/reports"],
    AUDITOR: ["/auditor/dashboard", "/auditor/events"],
  };
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  for (const [role, routes] of Object.entries(paths)) {
    await login(page, role);
    for (const route of [...routes, `/${routes[0].split("/")[1]}/account`]) {
      await page.goto(route);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("h1")).not.toHaveText("Access restricted");
      await expect(page.getByText("Loading records…")).toHaveCount(0);
      await expect(page.locator(".notice.error")).toHaveCount(0);
    }
    await logout(page);
  }
  expect(problems).toEqual([]);
});

test("student enrolls MFA, saves recovery codes and changes their password", async ({
  page,
}) => {
  await login(page, "STUDENT");
  await page
    .getByRole("link", { name: "Account security", exact: true })
    .click();
  const mfaPanel = page.locator(".panel").filter({
    has: page.getByRole("heading", {
      name: "Multi-factor authentication",
      exact: true,
    }),
  });
  const account = accounts.find((a: any) => a.role === "STUDENT");
  await mfaPanel
    .getByLabel("Current password", { exact: true })
    .fill(account.password);
  await mfaPanel
    .getByRole("button", { name: "Set up authenticator", exact: true })
    .click();
  const key = mfaPanel.getByLabel("Authenticator setup key");
  await expect(key).toBeVisible();
  const secret = (await key.textContent())!;
  await mfaPanel.getByLabel("Six-digit authenticator code").fill(
    new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
    }).generate(),
  );
  await mfaPanel.getByRole("button", { name: "Confirm authenticator" }).click();
  await expect(
    mfaPanel.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible();
  backupCodes.STUDENT = await mfaPanel
    .locator(".recovery-grid code")
    .allTextContents();
  saveRecoveryFixture();
  await mfaPanel
    .getByRole("button", { name: "I’ve saved my recovery codes" })
    .click();
  await expect(mfaPanel.getByText("Active", { exact: true })).toBeVisible();
  const passwordPanel = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Change password", exact: true }),
  });
  const replacement = "Changed-" + crypto.randomUUID();
  await passwordPanel
    .getByLabel("Current password", { exact: true })
    .fill(account.password);
  await passwordPanel
    .getByLabel("New password", { exact: true })
    .fill(replacement);
  await passwordPanel
    .getByLabel("Authenticator or recovery code")
    .fill(nextRecoveryCode("STUDENT")!);
  await passwordPanel
    .getByRole("button", { name: "Change password & secure sessions" })
    .click();
  await expect(passwordPanel.getByRole("status")).toContainText(
    "Saved successfully.",
  );
  account.password = replacement;
  await logout(page);
  await login(page, "STUDENT");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
});

test("registrar enrolls a new unique identity and the student signs in by ID to their own workspace", async ({ page }) => {
  const number = String(randomInt(100000, 1000000000));
  const email = `bs${number}@student.cavendish.ac.ug`;
  const password = randomBytes(24).toString("base64url");
  await login(page, "REGISTRAR");
  await page.getByLabel("Verified full name").fill("New browser student");
  await page.getByLabel("University email", { exact: true }).fill(email);
  await page.getByLabel("Student ID number", { exact: true }).fill(number);
  await page.getByLabel("Academic program").fill("Computing");
  await page.getByLabel("Initial individual password (14+ characters)").fill(password);
  await page.getByLabel("I verified the student ID and official email against university records.").check();
  await page.getByRole("button", { name: "Create student record" }).click();
  const row = page.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText(number);
  await row.getByRole("button", { name: "Manage ID" }).click();
  await page.getByLabel("I verified this student’s identity through the approved process.").check();
  await page.getByRole("button", { name: "Issue replacement credential" }).click();
  await expect(page.getByLabel("Issued opaque QR credential")).toBeVisible();
  await logout(page);
  await page.getByLabel("Student ID or university email").fill(number);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("link", { name: "My profile", exact: true }).click();
  await expect(page.locator(".profile-fields")).toContainText(email);
  await expect(page.locator(".profile-fields")).toContainText(number);
  await page.getByRole("link", { name: "My gadgets", exact: true }).click();
  await expect(page.locator(".gadget-row")).toHaveCount(0);
  await page.getByRole("link", { name: "Movement history", exact: true }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.getByRole("link", { name: "Student ID", exact: true }).click();
  await page.getByRole("button", { name: "Show my QR credential" }).click();
  await expect(page.getByRole("img", { name: "Your personal campus QR credential" })).toBeVisible();
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Access restricted" })).toBeVisible();
});
