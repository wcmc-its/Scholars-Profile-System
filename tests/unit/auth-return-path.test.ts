import { describe, expect, it } from "vitest";
import { isSafeReturnPath, safeReturnPath } from "@/lib/auth/return-path";

describe("isSafeReturnPath", () => {
  it("accepts paths on the /edit surface", () => {
    expect(isSafeReturnPath("/edit")).toBe(true);
    expect(isSafeReturnPath("/edit/scholar/abc1234")).toBe(true);
    expect(isSafeReturnPath("/edit/publication/12345678")).toBe(true);
    expect(isSafeReturnPath("/edit?tab=overview")).toBe(true);
    expect(isSafeReturnPath("/edit#section")).toBe(true);
  });

  it("accepts the homepage exactly and the curated public-page prefixes (#356 Phase 5 D5.1)", () => {
    // Homepage exactly.
    expect(isSafeReturnPath("/")).toBe(true);
    // Each curated prefix — exact, followed by /, ?, or #.
    expect(isSafeReturnPath("/scholars/jane-smith")).toBe(true);
    expect(isSafeReturnPath("/scholars/jane-smith?tab=publications")).toBe(true);
    expect(isSafeReturnPath("/scholars/jane-smith#publications")).toBe(true);
    expect(isSafeReturnPath("/browse")).toBe(true);
    expect(isSafeReturnPath("/browse?q=cancer")).toBe(true);
    expect(isSafeReturnPath("/centers/wcm-cardiology")).toBe(true);
    expect(isSafeReturnPath("/departments/medicine/divisions/cardio")).toBe(true);
    expect(isSafeReturnPath("/topics/precision-oncology")).toBe(true);
    expect(isSafeReturnPath("/topics/precision-oncology/scholars")).toBe(true);
    expect(isSafeReturnPath("/about")).toBe(true);
    expect(isSafeReturnPath("/about/feedback")).toBe(true);
    expect(isSafeReturnPath("/search?q=mRNA")).toBe(true);
  });

  it("rejects paths outside the curated allowlist", () => {
    expect(isSafeReturnPath("/admin")).toBe(false);
    expect(isSafeReturnPath("/api/edit/suppress")).toBe(false); // API never a return target
    expect(isSafeReturnPath("/api/auth/logout")).toBe(false);
    expect(isSafeReturnPath("/support")).toBe(false); // no /support page exists; pre-existing 404
  });

  it("rejects prefix-spoofs on every allow-listed entry (the /edit vs /editfoo precedent)", () => {
    expect(isSafeReturnPath("/editfoo")).toBe(false);
    expect(isSafeReturnPath("/scholarsfoo")).toBe(false);
    expect(isSafeReturnPath("/centersfoo")).toBe(false);
    expect(isSafeReturnPath("/departmentsfoo")).toBe(false);
    expect(isSafeReturnPath("/topicsfoo")).toBe(false);
    expect(isSafeReturnPath("/aboutfoo")).toBe(false);
    expect(isSafeReturnPath("/browsefoo")).toBe(false);
    expect(isSafeReturnPath("/searchfoo")).toBe(false);
  });

  it("rejects absolute and protocol-relative URLs (open-redirect vectors)", () => {
    expect(isSafeReturnPath("https://evil.com/edit")).toBe(false);
    expect(isSafeReturnPath("http://evil.com")).toBe(false);
    expect(isSafeReturnPath("//evil.com")).toBe(false);
    expect(isSafeReturnPath("/\\evil.com")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isSafeReturnPath("/edit/../admin")).toBe(false);
    expect(isSafeReturnPath("/edit/..%2fadmin")).toBe(false); // any ".." substring is rejected, conservatively
  });

  it("rejects control characters and over-long input", () => {
    expect(isSafeReturnPath("/edit/\u0000")).toBe(false);
    expect(isSafeReturnPath("/edit/\n")).toBe(false);
    expect(isSafeReturnPath("/edit/" + "x".repeat(600))).toBe(false);
  });

  it("rejects empty and nullish input", () => {
    expect(isSafeReturnPath("")).toBe(false);
    expect(isSafeReturnPath(null)).toBe(false);
    expect(isSafeReturnPath(undefined)).toBe(false);
  });
});

describe("safeReturnPath", () => {
  it("returns the path when it is safe", () => {
    expect(safeReturnPath("/edit/scholar/abc", "/edit")).toBe("/edit/scholar/abc");
  });

  it("falls back when the path is unsafe or absent", () => {
    expect(safeReturnPath("https://evil.com", "/edit")).toBe("/edit");
    expect(safeReturnPath(null, "/edit")).toBe("/edit");
    expect(safeReturnPath(undefined, "/edit")).toBe("/edit");
  });
});
