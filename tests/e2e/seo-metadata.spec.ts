/**
 * RED e2e tests for SEO metadata across all public page types (Phase 5 / SEO-03).
 *
 * These tests define the canonical/OG/noindex/JSON-LD contract that Plans 02–04
 * must satisfy. They will FAIL until those plans ship the metadata layer.
 *
 * Base URL: http://localhost:3000 (configured in playwright.config.ts)
 * NEXT_PUBLIC_SITE_URL for absolute URL assertions is read from the env or
 * falls back to the playwright baseURL pattern.
 *
 * Page types covered:
 *   - Profile (/scholars/{slug})
 *   - Topic (/topics/{id})
 *   - Department (/departments/{slug})
 *   - Division (/departments/{slug}/divisions/{div}) — canonical points to PARENT dept
 *   - Search (/search?q=test) — noindex, no canonical
 *   - Browse (/browse) — canonical /browse
 *   - About (/about) — canonical /about
 *   - Methodology (/about/methodology) — canonical /about/methodology
 *   - Home (/) — canonical /
 */
import { test, expect, type Page } from "@playwright/test";

// --- Helpers ---

async function getMeta(page: Page, selector: string): Promise<string | null> {
  return page.locator(selector).first().getAttribute("content");
}

async function getCanonical(page: Page): Promise<string | null> {
  return page.locator('link[rel="canonical"]').first().getAttribute("href");
}

async function getJsonLd(page: Page): Promise<Record<string, unknown> | null> {
  const el = page.locator('script[type="application/ld+json"]').first();
  const txt = await el.textContent({ timeout: 3000 }).catch(() => null);
  return txt ? (JSON.parse(txt) as Record<string, unknown>) : null;
}

// --- Dynamic slug discovery helpers ---

/** Returns the first scholar slug from the /browse page */
async function discoverScholarSlug(page: Page): Promise<string | null> {
  await page.goto("/browse");
  const link = page.locator('a[href^="/scholars/"]').first();
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return null;
  return href.replace("/scholars/", "");
}

/** Returns the first topic slug from the /browse page #research-areas section */
async function discoverTopicSlug(page: Page): Promise<string | null> {
  await page.goto("/browse");
  const link = page.locator('a[href^="/topics/"]').first();
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return null;
  return href.replace("/topics/", "");
}

/** Returns the first department slug from the /browse page */
async function discoverDepartmentSlug(page: Page): Promise<string | null> {
  await page.goto("/browse");
  const link = page.locator('a[href^="/departments/"]').first();
  const href = await link.getAttribute("href").catch(() => null);
  if (!href) return null;
  return href.replace("/departments/", "");
}

// --- Tests ---

test.describe("SEO metadata", () => {
  test("profile page has canonical, OG type=profile, OG image, twitter:card, JSON-LD Person", async ({ page }) => {
    const slug = await discoverScholarSlug(page);
    expect(slug).toBeTruthy();

    await page.goto(`/scholars/${slug}`);

    const canonical = await getCanonical(page);
    expect(canonical).toMatch(/^https?:\/\/[^/]+\/scholars\/[a-z0-9-]+$/);

    expect(await getMeta(page, 'meta[property="og:type"]')).toBe("profile");
    expect(await getMeta(page, 'meta[name="twitter:card"]')).toBe("summary_large_image");

    // OG image must point to the /og/scholars/{slug} route
    const ogImage = await getMeta(page, 'meta[property="og:image"]');
    expect(ogImage).toBeTruthy();
    expect(ogImage).toMatch(/\/og\/scholars\//);

    // JSON-LD Person block — D-26 shape assertions
    const jsonLd = await getJsonLd(page);
    // '@type' must be 'Person' (Schema.org Person type)
    expect(jsonLd?.['@type']).toBe('Person');
    expect((jsonLd?.affiliation as Record<string, unknown>)?.name).toBe(
      "Weill Cornell Medicine",
    );
  });

  test("profile page does NOT have noindex meta tag", async ({ page }) => {
    const slug = await discoverScholarSlug(page);
    expect(slug).toBeTruthy();

    await page.goto(`/scholars/${slug}`);

    const robotsMeta = await getMeta(page, 'meta[name="robots"]');
    // Profile pages must be indexable — no noindex
    if (robotsMeta) {
      expect(robotsMeta).not.toMatch(/noindex/i);
    }
  });

  test("topic page has canonical, title matching Research pattern", async ({ page }) => {
    const slug = await discoverTopicSlug(page);
    // Skip if no topics are linked from /browse
    if (!slug) {
      test.skip();
      return;
    }

    await page.goto(`/topics/${slug}`);

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    expect(canonical).toMatch(new RegExp(`/topics/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

    const title = await page.title();
    // Title format: "{Label} Research — Scholars @ Weill Cornell Medicine"
    expect(title).toMatch(/Research/i);
    expect(title).toMatch(/Weill Cornell Medicine/i);
  });

  test("department page has canonical and description mentioning scholars", async ({ page }) => {
    const slug = await discoverDepartmentSlug(page);
    // Skip if no departments are linked from /browse
    if (!slug) {
      test.skip();
      return;
    }

    await page.goto(`/departments/${slug}`);

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    expect(canonical).toMatch(new RegExp(`/departments/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));

    const description = await getMeta(page, 'meta[name="description"]');
    expect(description).toBeTruthy();
    expect(description?.toLowerCase()).toContain("scholars");
  });

  test("division URL has canonical pointing to PARENT department (not division URL)", async ({ page }) => {
    // Division URLs render the parent dept page with division pre-selected.
    // The canonical must point to /departments/{slug}, NOT /departments/{slug}/divisions/{div}.
    const deptSlug = await discoverDepartmentSlug(page);
    if (!deptSlug) {
      test.skip();
      return;
    }

    await page.goto(`/departments/${deptSlug}`);

    // Find a division link from the department page
    const divLink = page.locator('a[href^="/departments/"][href*="/divisions/"]').first();
    const divHref = await divLink.getAttribute("href").catch(() => null);

    if (!divHref) {
      // Department has no divisions — skip rather than fail
      // (This is expected for departments without subdivisions in the dev DB)
      test.skip();
      return;
    }

    await page.goto(divHref);

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    // canonical must reference the PARENT department path, NOT the division path
    expect(canonical).not.toMatch(/\/divisions\//);
    expect(canonical).toMatch(/\/departments\//);
  });

  test("search page has noindex,follow meta tag and NO canonical link", async ({ page }) => {
    await page.goto("/search?q=test");

    const robotsMeta = await getMeta(page, 'meta[name="robots"]');
    expect(robotsMeta).toBeTruthy();
    // Must include noindex (with or without space after comma)
    expect(robotsMeta).toMatch(/noindex/i);
    // Must include follow (preserves link equity through search result links)
    expect(robotsMeta).toMatch(/follow/i);

    // Critical D-13: search page must NOT have a canonical tag
    const canonicalCount = await page.locator('link[rel="canonical"]').count();
    expect(canonicalCount).toBe(0);
  });

  test("browse page has canonical pointing to /browse", async ({ page }) => {
    await page.goto("/browse");

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    expect(canonical).toMatch(/\/browse$/);
  });

  test("about page has canonical pointing to /about", async ({ page }) => {
    await page.goto("/about");

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    expect(canonical).toMatch(/\/about$/);
  });

  test("methodology page has canonical pointing to /about/methodology", async ({ page }) => {
    await page.goto("/about/methodology");

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    expect(canonical).toMatch(/\/about\/methodology$/);
  });

  test("home page has canonical pointing to the home URL", async ({ page }) => {
    await page.goto("/");

    const canonical = await getCanonical(page);
    expect(canonical).toBeTruthy();
    // Canonical may be the absolute home URL or a path ending in /
    // The important thing is that it exists and does not point to a different page
    expect(canonical).toMatch(/\/$|scholars\.weill\.cornell\.edu\/?$/);
  });
});
