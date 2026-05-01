import { test, expect } from "@playwright/test";

test.describe("Department detail page", () => {
  test.fixme("/departments/medicine renders chair card, top research areas, divisions rail, role chip row, person rows", async ({ page }) => {});
  test.fixme("/departments/medicine/divisions/cardiology returns 200 with cardiology pre-selected", async ({ page }) => {});
  test.fixme("/departments/pediatrics/divisions/cardiology returns 200 with pediatric cardiology distinct from medicine cardiology", async ({ page }) => {});
  test.fixme("/departments/medicine/divisions/nonexistent-slug returns 404", async ({ page }) => {});
  test.fixme("role chip click filters person list without page navigation", async ({ page }) => {});
});
