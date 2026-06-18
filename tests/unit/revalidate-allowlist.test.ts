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
