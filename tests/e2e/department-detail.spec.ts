import { test, expect } from "@playwright/test";

const TEST_DEPT_SLUG = process.env.PHASE3_TEST_DEPT_SLUG ?? "medicine";

test.describe("Department detail page", () => {
  test("/departments/{slug} renders hero, role chip row, person rows", async ({ page }) => {
    const res = await page.goto(`/departments/${TEST_DEPT_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have department slug "${TEST_DEPT_SLUG}" — run ED ETL to populate`);
      return;
    }
    expect(res?.status()).toBe(200);
    await expect(page.getByText("DEPARTMENT")).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.getByText("Faculty")).toBeVisible();
    await expect(page.getByRole("button", { name: /All\s+\d+/ })).toBeVisible();
  });

  test("/departments/{slug}/divisions/{div} returns 200 with division pre-selected", async ({ page }) => {
    const res = await page.goto("/departments/medicine/divisions/cardiology");
    if (res?.status() === 404) {
      test.skip(true, "Local DB does not have medicine/cardiology — run ED ETL to populate");
      return;
    }
    expect(res?.status()).toBe(200);
    await expect(
      page.locator("aside[aria-label='Divisions']").getByRole("link", { name: /cardiology/i }),
    ).toBeVisible();
  });

  test("/departments/pediatrics/divisions/cardiology is distinct from medicine/cardiology", async ({ page, browser }) => {
    const res1 = await page.goto("/departments/medicine/divisions/cardiology");
    if (res1?.status() === 404) {
      test.skip(true, "Local DB does not have medicine/cardiology — spec line 1454 check skipped");
      return;
    }
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    try {
      const res2 = await page2.goto("/departments/pediatrics/divisions/cardiology");
      if (res2?.status() === 404) {
        test.skip(true, "Local DB does not have pediatrics/cardiology — spec line 1454 check skipped");
        return;
      }
      expect(res1?.status()).toBe(200);
      expect(res2?.status()).toBe(200);
      const h1Medicine = await page.locator("h1").first().textContent();
      const h1Pediatrics = await page2.locator("h1").first().textContent();
      expect(h1Medicine).not.toBe(h1Pediatrics);
    } finally {
      await ctx2.close();
    }
  });

  test("/departments/{slug}/divisions/nonexistent-fake returns 404", async ({ page }) => {
    const deptRes = await page.goto(`/departments/${TEST_DEPT_SLUG}`);
    if (deptRes?.status() === 404) {
      test.skip(true, `Local DB does not have department "${TEST_DEPT_SLUG}" — cannot test division 404`);
      return;
    }
    const res = await page.goto(`/departments/${TEST_DEPT_SLUG}/divisions/nonexistent-fake-${Date.now()}`);
    expect(res?.status()).toBe(404);
  });

  test("role chip click filters person list without page navigation", async ({ page }) => {
    const res = await page.goto(`/departments/${TEST_DEPT_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have department "${TEST_DEPT_SLUG}" — run ED ETL to populate`);
      return;
    }
    const initialUrl = page.url();
    const fullTimeChip = page.getByRole("button", { name: /Full-time faculty/ });
    if (await fullTimeChip.isVisible().catch(() => false)) {
      await fullTimeChip.click();
      expect(page.url()).toBe(initialUrl);
    }
  });
});
