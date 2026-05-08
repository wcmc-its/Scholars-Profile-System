/**
 * E2E coverage for /topics/[slug] placeholder route.
 *
 * Verifies:
 *   - Unknown slug → 404 (notFound() in the route handler).
 *   - Known slug → 200, hero H1 visible.
 *   - When the Top scholars section renders, it has the 'How this works'
 *     link wired to /about/methodology#top-scholars.
 *   - When the Spotlight section renders, it has the 'how this works'
 *     link wired to /about/methodology#spotlight AND no citation counts
 *     surface in the section.
 *
 * Strategy: e2e tries a list of plausible parent-topic slugs from the
 * taxonomy and visits the first one that returns 200. If none of the
 * candidates exist (test DB without topic seed), the visual assertions
 * skip gracefully — Plan 09 will tighten this once the smoke-test
 * fixture set is established.
 */
import { test, expect } from "@playwright/test";

const CANDIDATE_SLUGS = [
  "cardiovascular_disease",
  "cancer_genomics",
  "neuroscience",
  "infectious_disease",
  "immunology",
  "oncology",
];

test.describe("/topics/{slug} placeholder route (Phase 2 D-10)", () => {
  test("returns 404 for an unknown topic slug", async ({ page }) => {
    const response = await page.goto(
      "/topics/this-topic-definitely-does-not-exist-xyz123",
    );
    expect(response?.status()).toBe(404);
  });

  test("renders hero H1 for a real topic slug", async ({ page }) => {
    let visited: string | null = null;
    for (const slug of CANDIDATE_SLUGS) {
      const resp = await page.goto(`/topics/${slug}`);
      if (resp && resp.ok()) {
        visited = slug;
        break;
      }
    }
    if (!visited) {
      test.skip(
        true,
        "No real topic slug available in test DB; populate Topic table first",
      );
      return;
    }
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("Top scholars section, when present, links to /about/methodology#top-scholars", async ({
    page,
  }) => {
    for (const slug of CANDIDATE_SLUGS) {
      const resp = await page.goto(`/topics/${slug}`);
      if (!resp || !resp.ok()) continue;
      const heading = page.getByRole("heading", {
        name: "Top scholars in this area",
      });
      if (await heading.isVisible().catch(() => false)) {
        const section = page.locator("section").filter({ has: heading });
        const link = section.getByRole("link", { name: /How this works/i });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute(
          "href",
          "/about/methodology#top-scholars",
        );
        return;
      }
    }
    test.skip(true, "Top scholars section not visible on any candidate topic");
  });

  test("Spotlight section, when present, links to /about/methodology#spotlight and shows no citation counts", async ({
    page,
  }) => {
    for (const slug of CANDIDATE_SLUGS) {
      const resp = await page.goto(`/topics/${slug}`);
      if (!resp || !resp.ok()) continue;
      const heading = page.getByRole("heading", { name: "Spotlight", exact: true });
      if (await heading.isVisible().catch(() => false)) {
        const section = page.locator("section").filter({ has: heading });
        const link = section.getByRole("link", { name: /how this works/i });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute(
          "href",
          "/about/methodology#spotlight",
        );
        // No citation count visible (locked by design spec v1.7.1).
        await expect(section).not.toContainText(/\d+\s*citations?/i);
        return;
      }
    }
    test.skip(
      true,
      "Spotlight section not visible on any candidate topic",
    );
  });
});
