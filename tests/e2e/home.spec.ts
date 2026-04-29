import { test, expect } from "@playwright/test";

test("home page renders the hello banner", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Scholars @ Weill Cornell Medicine",
  );
});
