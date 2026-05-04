import { test, expect } from "@playwright/test";

/**
 * Phase 4 Browse hub e2e — RED until Plan 03 ships /browse page.
 * Mirrors tests/e2e/department-detail.spec.ts patterns.
 */
test.describe("/browse", () => {
  test("renders Departments section heading", async ({ page }) => {
    const res = await page.goto("/browse");
    expect(res?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Departments", level: 2 }),
    ).toBeVisible();
  });

  test("renders Centers & Institutes section heading", async ({ page }) => {
    await page.goto("/browse");
    await expect(
      page.getByRole("heading", { name: "Centers & Institutes", level: 2 }),
    ).toBeVisible();
  });

  test("renders A–Z Directory section heading", async ({ page }) => {
    await page.goto("/browse");
    // U+2013 EN DASH between A and Z per UI-SPEC §6.5
    await expect(
      page.getByRole("heading", { name: "A–Z Directory", level: 2 }),
    ).toBeVisible();
  });

  test("renders A-Z letter strip with active letter buttons", async ({ page }) => {
    await page.goto("/browse");
    // At least one active letter button must exist. Use aria-label pattern
    // added in WR-04 rather than bare "A" (which may not have scholars).
    await expect(
      page.getByRole("button", { name: /^Show scholars with last name starting with/ }).first(),
    ).toBeVisible();
  });

  test("A-Z collapsible expands on letter click and shows letter as h3", async ({ page }) => {
    await page.goto("/browse");
    // Find the first active letter button dynamically rather than assuming "A"
    // has scholars in the test database. IN-03: hardcoding "A" caused a confusing
    // selector failure when seed data had no scholars with A surnames.
    const activeButtons = page.getByRole("button").filter({
      hasText: /^[A-Z]$/,
    });
    const firstButton = activeButtons.first();
    const letterText = await firstButton.textContent();
    await firstButton.click();
    await expect(
      page.getByRole("heading", { name: letterText ?? "", level: 3 }),
    ).toBeVisible();
  });

  test("anchor strip cross-link to research areas exists", async ({ page }) => {
    await page.goto("/browse");
    const link = page.getByRole("link", { name: /Research areas/i });
    await expect(link).toBeVisible();
    // Target locked to /#research-areas (no /topics listing exists per RESEARCH.md Pitfall 3)
    await expect(link).toHaveAttribute("href", "/#research-areas");
  });

  test("breadcrumb shows Home › Browse", async ({ page }) => {
    await page.goto("/browse");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    // Browse is the current page — rendered as BreadcrumbPage (not a link)
    await expect(page.getByText("Browse", { exact: true }).first()).toBeVisible();
  });
});

test.describe("/about (Phase 4 replacement)", () => {
  test("renders H1 'About Scholars at WCM' and methodology link", async ({ page }) => {
    await page.goto("/about");
    await expect(
      page.getByRole("heading", { level: 1, name: "About Scholars at WCM" }),
    ).toBeVisible();
    const link = page.getByRole("link", {
      name: /How algorithmic surfaces work/i,
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/about/methodology");
  });
});
