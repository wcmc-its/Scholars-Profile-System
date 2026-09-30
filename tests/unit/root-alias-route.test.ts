/**
 * app/(public)/[slug]/page.tsx — root people-profile route (#671, #497 §5.3).
 *
 * Canonical: a bare `/<slug>` renders the profile in place; former slugs 301
 * to the current canonical root `/<current>`. This was gated by
 * `PROFILE_CANONICAL` during the #671 soak — the pre-cutover default was a
 * 301 alias to `/scholars/<slug>` — but the flag has since been removed
 * (live in both envs since 2026-07-14), so root-canonical is the only mode.
 * In all cases it 404s reserved route words, non-slug input, and unknown
 * slugs.
 *
 * next/navigation, the URL resolver, the shared ProfileView, and the metadata
 * builder are mocked; `@/lib/slug` (reserved denylist + looksLikeSlug) runs
 * for real.
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

// Mock the render dependencies so importing the route doesn't drag in the data
// layer; the route only ever *creates* a ProfileView element (never invokes it).
vi.mock("@/components/profile/profile-view", () => ({
  ProfileView: (props: { slug: string }) => ({ __profileView: props.slug }),
}));
vi.mock("@/lib/profile-metadata", () => ({ buildProfileMetadata: vi.fn() }));

import RootProfileRoute from "@/app/(public)/[slug]/page";

function call(slug: string) {
  return RootProfileRoute({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  mockNotFound.mockClear();
  mockPermanentRedirect.mockClear();
  mockResolve.mockReset();
});

describe("root profile route — reserved words", () => {
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

describe("root profile route — cheap structural reject", () => {
  it("404s a non-slug-looking segment without touching the DB", async () => {
    // "ab12" has a digit and no hyphen -> fails looksLikeSlug.
    await expect(call("ab12")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it("404s a single-token uppercase segment (slugs are lowercase) without touching the DB", async () => {
    await expect(call("Jane")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe("root profile route — canonical", () => {
  it("renders the profile for a live slug (no redirect, no 404)", async () => {
    mockResolve.mockResolvedValue({ type: "found", cwid: "abc1", slug: "jane-smith" });
    const result = (await call("jane-smith")) as { props: { slug: string } };
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(result.props.slug).toBe("jane-smith");
  });

  it("301s a former slug to the current canonical root /<current>", async () => {
    mockResolve.mockResolvedValue({ type: "redirect", targetSlug: "brandon-swed" });
    await expect(call("brandon-swed-2")).rejects.toThrow("NEXT_REDIRECT:/brandon-swed");
    expect(mockPermanentRedirect).toHaveBeenCalledWith("/brandon-swed");
  });

  it("404s an unknown slug after the DB miss", async () => {
    mockResolve.mockResolvedValue({ type: "not-found" });
    await expect(call("nobody-here")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
    expect(mockPermanentRedirect).not.toHaveBeenCalled();
  });
});
