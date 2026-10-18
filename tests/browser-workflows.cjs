const { chromium } = require("playwright");
const assert = require("node:assert/strict");
module.exports = async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 180));
  });
  await page.goto("http://127.0.0.1:5174");
  await page.getByRole("button", { name: /^Sign in/ }).waitFor();
  await page.screenshot({ path: "test-artifacts/login.png", fullPage: true });
  await page.getByLabel(/^Email/).fill("owner@demo.clinic");
  await page.getByLabel(/^Password/).fill("ClinicDemo123!");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page.locator("h1").filter({ hasText: "Welcome back" }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({
    path: "test-artifacts/dashboard.png",
    fullPage: true,
  });
  for (const module of [
    "patients",
    "appointments",
    "queue",
    "doctors",
    "billing",
    "expenses",
    "reports",
    "settings",
    "users",
    "audit",
  ]) {
    await page.goto("http://127.0.0.1:5174/" + module);
    await page.locator(".page-head h1").waitFor();
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator(".error-panel").count(),
      0,
      "Route error: " + module,
    );
  }
  await page.goto("http://127.0.0.1:5174/patients");
  await page
    .getByRole("button", { name: "Register patient", exact: true })
    .click();
  await page.getByLabel(/^Name/).fill("UI Test Patient");
  await page.getByLabel("Mobile", { exact: true }).fill("03001119999");
  await page.getByLabel("Age", { exact: true }).fill("32");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByPlaceholder("Search patients", { exact: true })
    .fill("UI Test Patient");
  await page.waitForTimeout(500);
  assert.equal(
    await page.getByText("UI Test Patient", { exact: true }).count(),
    1,
  );
  await page.goto("http://127.0.0.1:5174/billing");
  await page
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: /^View/ })
    .click();
  await page.getByRole("button", { name: "Print", exact: true }).click();
  await page.locator(".print-sheet").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-artifacts/invoice.png", fullPage: true });
  await page.pdf({
    path: "test-artifacts/invoice.pdf",
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });
  assert.equal(await page.locator(".print-warning").count(), 0);
  await page.goto("http://127.0.0.1:5174/dashboard");
  await page.getByRole("combobox", { name: "Language" }).selectOption("ur");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  await page.screenshot({
    path: "test-artifacts/dashboard-ur.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.waitForTimeout(400);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile dashboard overflow",
  );
  await page.screenshot({
    path: "test-artifacts/mobile-ur.png",
    fullPage: true,
  });
  await page.getByRole("combobox", { name: "Language" }).selectOption("en");
  for (const module of [
    "patients",
    "appointments",
    "queue",
    "doctors",
    "billing",
    "expenses",
    "reports",
    "settings",
    "users",
    "audit",
  ]) {
    await page.goto("http://127.0.0.1:5174/" + module);
    await page.locator(".page-head h1").waitFor();
    await page.waitForTimeout(100);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Mobile overflow: " + module,
    );
  }

  await page.setViewportSize({ width: 1440, height: 1050 });
  const to = new Date().toISOString().slice(0, 10),
    start = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  await page.goto(
    `http://127.0.0.1:5174/print/report/cash-ledger?from=${start}&to=${to}`,
  );
  await page.locator(".report-print-page").first().waitFor();
  assert.ok((await page.locator(".report-print-page").count()) > 1);
  await page.pdf({
    path: "test-artifacts/cash-ledger.pdf",
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto("http://127.0.0.1:5174/dashboard");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel(/^Email/).fill("doctor@demo.clinic");
  await page.getByLabel(/^Password/).fill("ClinicDemo123!");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page.locator(".page-head h1").waitFor();
  await page.goto("http://127.0.0.1:5174/queue");
  await page
    .getByRole("button", { name: "Start consultation", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Chief complaint", { exact: true })
    .fill("Synthetic UI test complaint");
  await page
    .getByLabel("Final diagnosis", { exact: true })
    .fill("Synthetic UI test diagnosis");
  await page
    .getByRole("button", { name: "Sign consultation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Prescription", exact: true }).click();
  await page
    .getByLabel("Medicine name", { exact: true })
    .fill("Synthetic test medicine");
  await page
    .getByLabel("Dose", { exact: true })
    .fill("Test dose, manually entered");
  await page.getByLabel("Frequency", { exact: true }).fill("Test frequency");
  await page.getByLabel("Duration", { exact: true }).fill("Test duration");
  await page
    .getByRole("button", { name: "Sign prescription", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .locator(".encounter-editor")
    .getByRole("button", { name: "Print", exact: true })
    .click();
  await page.locator(".signature").waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".print-warning").count(), 0);
  await page.screenshot({
    path: "test-artifacts/prescription.png",
    fullPage: true,
  });
  await page.pdf({
    path: "test-artifacts/prescription.pdf",
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
  });
  await page.goto("http://127.0.0.1:5174/dashboard");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel(/^Email/).fill("admin@ahmed.demo");
  await page.getByLabel(/^Password/).fill("AdminDemo123!");
  await page.getByRole("button", { name: /^Sign in/ }).click();
  await page
    .getByRole("heading", { name: "Clinics, connected.", exact: true })
    .waitFor();
  for (const tab of ["Plans", "Administrative activity", "Clinics"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".error-panel").count(), 0);
  }
  await page.screenshot({ path: "test-artifacts/admin.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "BROWSER CHECKS PASSED: 10 clinic routes, patient registration, invoice PDF, English/Urdu RTL, all 360px routes, signed consultation/prescription with PDF, separate SaaS admin, no runtime errors.",
  );
  await browser.close();
};
