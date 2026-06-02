/**
 * app/(public)/[slug]/page.tsx — root people-profile route (#671, #497 §5.3).
 *
 * Behavior depends on PROFILE_CANONICAL:
 *   - unset / "scholars" (default): a bare `/<slug>` 301s to the canonical
 *     `/scholars/<slug>` — the pre-#671 root-alias behavior.
 *   - "root": the route renders the profile in place; former slugs 301 to the
 *     current canonical root `/<current>`.
 * In both modes it 404s reserved route words, non-slug input, and unknown slugs.
 *
 * next/navigation, the URL resolver, the shared ProfileView, and the metadata
 * builder are mocked; `@/lib/slug` (reserved denylist + looksLikeSlug) and
 * `@/lib/profile-url` (the PROFILE_CANONICAL read) run for real.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

const ORIGINAL_FLAG = process.env.PROFILE_CANONICAL;
beforeEach(() => {
  mockNotFound.mockClear();
  mockPermanentRedirect.mockClear();
  mockResolve.mockReset();
  delete process.env.PROFILE_CANONICAL; // default behavior = "scholars"
});
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PROFILE_CANONICAL;
  else process.env.PROFILE_CANONICAL = ORIGINAL_FLAG;
});

describe("root profile route — reserved words (both modes)", () => {
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

describe("root profile route — alias mode (PROFILE_CANONICAL unset)", () => {
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

describe("root profile route — canonical mode (PROFILE_CANONICAL=root)", () => {
  beforeEach(() => {
    process.env.PROFILE_CANONICAL = "root";
  });

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
