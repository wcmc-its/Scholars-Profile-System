/**
 * Home-page e2e suite for the Phase 2 composition.
 *
 * Hero H1 + Browse all research areas (HOME-03) are guaranteed visible
 * (Browse never hides per D-12). Recent contributions (RANKING-01) and
 * Selected research (HOME-02) may be hidden under the sparse-state policy
 * (floor 3 of 6 / floor 4 of 8); their assertions therefore use an
 * `if visible, then assert structure` pattern so the suite is stable
 * regardless of the underlying data state.
 */
import { test, expect } from "@playwright/test";

test.describe("home page", () => {
  test("renders hero H1", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Scholars at Weill Cornell Medicine",
    );
  });

  test("renders Browse all research areas section (HOME-03 — never hidden)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Browse all research areas" }),
    ).toBeVisible();
  });

  test("Browse all research areas section contains topic links", async ({
    page,
  }) => {
    await page.goto("/");
    const browseSection = page
      .locator("section")
      .filter({
        has: page.getByRole("heading", { name: "Browse all research areas" }),
      });
    await expect(browseSection).toBeVisible();
    // First topic link visible (or the error-state Retry link if data is empty).
    const firstLink = browseSection.getByRole("link").first();
    await expect(firstLink).toBeVisible();
  });

  test("if Recent contributions renders, cards have no visible citation count", async ({
    page,
  }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { name: "Recent contributions" });
    if (await heading.isVisible().catch(() => false)) {
      const section = page.locator("section").filter({ has: heading });
      // No "N citations" text inside the section (locked by design spec v1.7.1).
      await expect(section).not.toContainText(/\d+\s*citations?/i);
    }
    // If hidden, sparse-state policy is in effect (D-12) — that's also valid.
  });

  test("if Recent contributions section renders, has 'How this works' link to /about/methodology#recent-contributions", async ({
    page,
  }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { name: "Recent contributions" });
    if (await heading.isVisible().catch(() => false)) {
      const section = page.locator("section").filter({ has: heading });
      const howLink = section.getByRole("link", { name: /How this works/i });
      await expect(howLink).toBeVisible();
      await expect(howLink).toHaveAttribute(
        "href",
        "/about/methodology#recent-contributions",
      );
    }
  });

  test("if Spotlight section renders, has methodology link to /about/methodology#spotlight", async ({
    page,
  }) => {
    await page.goto("/");
    const heading = page.getByRole("heading", { name: "Spotlight" });
    if (await heading.isVisible().catch(() => false)) {
      const section = page.locator("section").filter({ has: heading });
      const methodologyLink = section
        .getByRole("link", { name: /How this works|methodology/i })
        .first();
      await expect(methodologyLink).toBeVisible();
      const href = await methodologyLink.getAttribute("href");
      expect(href).toContain("/about/methodology#spotlight");
    }
  });
});
