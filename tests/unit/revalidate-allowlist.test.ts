import { describe, expect, it } from "vitest";

import { isAllowedRevalidatePath } from "@/lib/revalidate-allowlist";

describe("isAllowedRevalidatePath", () => {
  it("allows the exact paths", () => {
    for (const p of ["/", "/about", "/browse", "/sitemap.xml"]) {
      expect(isAllowedRevalidatePath(p)).toBe(true);
    }
  });

  it("allows scholar / topic / department / division dynamic paths", () => {
    expect(isAllowedRevalidatePath("/scholars/jane-smith")).toBe(true);
    expect(isAllowedRevalidatePath("/topics/cardiology")).toBe(true);
    expect(isAllowedRevalidatePath("/departments/medicine")).toBe(true);
    expect(isAllowedRevalidatePath("/departments/medicine/divisions/cardiology")).toBe(true);
  });

  it("allows underscore-delimited topic ids (Topic.id slug shape)", () => {
    // Topic ids are underscore slugs (e.g. "cancer_genomics"); the ETL
    // revalidates `/topics/{id}` per topic. These were 400-rejected before.
    expect(isAllowedRevalidatePath("/topics/cancer_genomics")).toBe(true);
    expect(isAllowedRevalidatePath("/topics/hematology_medical_oncology")).toBe(true);
    expect(isAllowedRevalidatePath("/topics/gi_cancer")).toBe(true);
  });

  it("keeps underscores topic-only — other segments stay hyphen-strict", () => {
    // The underscore allowance must not leak into the other patterns.
    expect(isAllowedRevalidatePath("/scholars/jane_smith")).toBe(false);
    expect(isAllowedRevalidatePath("/departments/foo_bar")).toBe(false);
    expect(isAllowedRevalidatePath("/topics/_leading")).toBe(false);
    expect(isAllowedRevalidatePath("/topics/trailing_")).toBe(false);
  });

  it("allows center + center-program-page paths (#540 / #1117)", () => {
    expect(isAllowedRevalidatePath("/centers/meyer-cancer-center")).toBe(true);
    expect(isAllowedRevalidatePath("/centers/meyer-cancer-center/programs/CB")).toBe(true);
    // not a bare /programs and not a deeper path
    expect(isAllowedRevalidatePath("/centers/meyer-cancer-center/programs")).toBe(false);
    expect(isAllowedRevalidatePath("/centers/meyer-cancer-center/programs/CB/extra")).toBe(false);
  });

  it("rejects an unknown exact path", () => {
    expect(isAllowedRevalidatePath("/edit")).toBe(false);
    expect(isAllowedRevalidatePath("/api/edit/field")).toBe(false);
  });

  it("rejects prefix-match and traversal attempts", () => {
    expect(isAllowedRevalidatePath("/scholars/jane/extra")).toBe(false);
    expect(isAllowedRevalidatePath("/scholars/")).toBe(false);
    expect(isAllowedRevalidatePath("scholars/jane")).toBe(false);
    expect(isAllowedRevalidatePath("/scholars/../../etc")).toBe(false);
  });

  it("rejects a slug containing a dot, slash, or space", () => {
    expect(isAllowedRevalidatePath("/scholars/jane.smith")).toBe(false);
    expect(isAllowedRevalidatePath("/scholars/jane smith")).toBe(false);
  });
});
