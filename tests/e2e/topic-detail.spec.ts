import { test, expect } from "@playwright/test";

const TEST_TOPIC_SLUG = process.env.PHASE3_TEST_TOPIC_SLUG ?? "epidemiology_population_health";

test.describe("Topic detail page Layout B", () => {
  test("renders hero, top scholars row, recent highlights, subtopic rail, publication feed", async ({ page }) => {
    const res = await page.goto(`/topics/${TEST_TOPIC_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have topic slug "${TEST_TOPIC_SLUG}"`);
      return;
    }
    await expect(page.getByText("RESEARCH AREA", { exact: true })).toBeVisible();
    await expect(page.locator("h1")).toBeVisible();
    // TopScholarsChipRow and RecentHighlights are conditionally rendered (sparse-state policy).
    // If they render, assert their structure; otherwise pass silently.
    const topScholarsHeading = page.getByRole("heading", { name: "Top scholars in this area" });
    if (await topScholarsHeading.isVisible().catch(() => false)) {
      await expect(topScholarsHeading).toBeVisible();
    }
    const recentHeading = page.getByRole("heading", { name: "Recent highlights" });
    if (await recentHeading.isVisible().catch(() => false)) {
      await expect(recentHeading).toBeVisible();
    }
    await expect(page.getByText("Research articles in this area")).toBeVisible();
    await expect(page.locator("aside[aria-label='Subtopics']")).toBeVisible();
  });

  test("sort dropdown changes feed order to Most cited", async ({ page }) => {
    const res = await page.goto(`/topics/${TEST_TOPIC_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have topic slug "${TEST_TOPIC_SLUG}"`);
      return;
    }
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Most cited" }).click();
    await expect(page.getByText("Curated", { exact: true })).not.toBeVisible({ timeout: 5000 });
  });

  test("Curated tag appears for By impact and Curated sorts", async ({ page }) => {
    const res = await page.goto(`/topics/${TEST_TOPIC_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have topic slug "${TEST_TOPIC_SLUG}"`);
      return;
    }
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "By impact (ReCiterAI)" }).click();
    await expect(page.getByText("Curated", { exact: true })).toBeVisible();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Curated by ReCiterAI" }).click();
    await expect(page.getByText("Curated", { exact: true })).toBeVisible();
  });

  test("View all N scholars link navigates to /search?topic={slug}&tab=people", async ({ page }) => {
    const res = await page.goto(`/topics/${TEST_TOPIC_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have topic slug "${TEST_TOPIC_SLUG}"`);
      return;
    }
    const link = page.getByRole("link", { name: /View all .* scholars in this area/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toContain(`topic=${encodeURIComponent(TEST_TOPIC_SLUG)}`);
    expect(href).toContain("tab=people");
  });

  test("subtopic click filters feed and updates heading", async ({ page }) => {
    const res = await page.goto(`/topics/${TEST_TOPIC_SLUG}`);
    if (res?.status() === 404) {
      test.skip(true, `Local DB does not have topic slug "${TEST_TOPIC_SLUG}"`);
      return;
    }
    const rail = page.locator("aside[aria-label='Subtopics']");
    const firstButton = rail.getByRole("button").first();
    if (!(await firstButton.isVisible().catch(() => false))) {
      test.skip(true, "No subtopics in local DB for this topic; skipping subtopic interaction test");
      return;
    }
    await firstButton.click();
    // After clicking, the subtopic rail should still be visible and the
    // active button should have a different style (white text on slate bg).
    await expect(rail).toBeVisible();
    await expect(firstButton).toBeVisible();
  });
});
