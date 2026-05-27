/**
 * `app/[slug]/page.tsx` — root-alias routing (#497 §5.3).
 *
 * The root catch-all 301s a bare `/<slug>` to the canonical `/scholars/<slug>`,
 * 404s reserved route words and non-slug input, and 404s unknown slugs. Next's
 * static-route precedence means only unknown single segments reach it; these
 * tests exercise the in-component resolution order directly.
 *
 * `next/navigation` and the URL resolver are mocked; `@/lib/slug` (the reserved
 * denylist + `looksLikeSlug`) is exercised for real.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockNotFound, mockPermanentRedirect } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  mockPermanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mockNotFound,
  permanentRedirect: mockPermanentRedirect,
}));

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
vi.mock("@/lib/url-resolver", () => ({
  resolveBySlugOrHistory: mockResolve,
}));

import RootSlugAlias from "@/app/[slug]/page";

function call(slug: string) {
  return RootSlugAlias({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  mockNotFound.mockClear();
  mockPermanentRedirect.mockClear();
  mockResolve.mockReset();
});

describe("root-alias route — reserved words", () => {
  it("404s a reserved route word without touching the DB", async () => {
    await expect(call("search")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
  });

  it("404s every seeded reserved segment", async () => {
    for (const word of ["api", "edit", "scholars", "topics", "about", "by-cwid"]) {
      mockNotFound.mockClear();
      mockResolve.mockReset();
      await expect(call(word)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mockResolve).not.toHaveBeenCalled();
    }
  });
});

describe("root-alias route — cheap structural reject", () => {
  it("404s a non-slug-looking segment without touching the DB", async () => {
    // "ab12" has a digit and no hyphen -> fails looksLikeSlug.
    await expect(call("ab12")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("404s a single-token uppercase segment (slugs are lowercase) without touching the DB", async () => {
    // "Jane" has no hyphen and isn't all-lowercase -> fails looksLikeSlug.
    // (A hyphenated mixed-case value like "Jane-Smith" does reach the DB and
    // 404s on the lowercase-only miss — there is deliberately no case-folding
    // redirect, matching /scholars/[slug].)
    await expect(call("Jane")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe("root-alias route — resolution", () => {
  it("301s a live slug to /scholars/<slug>", async () => {
    mockResolve.mockResolvedValue({ type: "found", cwid: "abc1", slug: "jane-smith" });
    await expect(call("jane-smith")).rejects.toThrow("NEXT_REDIRECT:/scholars/jane-smith");
    expect(mockPermanentRedirect).toHaveBeenCalledWith("/scholars/jane-smith");
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it("301s a former slug to the current canonical /scholars/<current>", async () => {
    mockResolve.mockResolvedValue({ type: "redirect", targetSlug: "brandon-swed" });
    await expect(call("brandon-swed-2")).rejects.toThrow(
      "NEXT_REDIRECT:/scholars/brandon-swed",
    );
    expect(mockPermanentRedirect).toHaveBeenCalledWith("/scholars/brandon-swed");
  });

  it("404s an unknown slug-shaped segment after the DB miss", async () => {
    mockResolve.mockResolvedValue({ type: "not-found" });
    await expect(call("nobody-here")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).toHaveBeenCalledWith("nobody-here");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
  });
});
