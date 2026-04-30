import { test, expect } from "@playwright/test";
import { METHODOLOGY_ANCHORS } from "@/lib/methodology-anchors";

test.describe("/about/methodology", () => {
  test("renders H1 'How algorithmic surfaces work'", async ({ page }) => {
    await page.goto("/about/methodology");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "How algorithmic surfaces work",
    );
  });

  // Generate one test per anchor — fails per anchor for granular feedback.
  for (const [key, id] of Object.entries(METHODOLOGY_ANCHORS)) {
    test(`anchor ${key} (#${id}) resolves and section is visible`, async ({
      page,
    }) => {
      await page.goto(`/about/methodology#${id}`);
      await expect(page.locator(`#${id}`)).toBeVisible();
    });
  }
});

test.describe("/about (stub)", () => {
  test("links to /about/methodology", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "About Scholars at WCM",
    );
    const methodologyLink = page.getByRole("link", { name: /methodology/i });
    await expect(methodologyLink).toBeVisible();
    await expect(methodologyLink).toHaveAttribute("href", "/about/methodology");
  });
});
