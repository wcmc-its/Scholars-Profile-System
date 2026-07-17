/**
 * The two compatibility shims the rename owes, and the reason they get a test at all: each one
 * is a file whose entire job is to be reachable, and nothing else in the suite would notice if
 * either quietly stopped working. Delete the alias and every OTHER test still passes — which is
 * exactly the shape of bug this codebase keeps shipping (declared, never connected).
 *
 * These tests die WITH the shims. When the alias and the redirect are retired, delete this file
 * too — a green test guarding a deleted feature is worse than no test.
 */
import { describe, expect, it, vi } from "vitest";

// The redirect page calls `permanentRedirect` at module scope of its render, which throws in
// Next's real implementation. Capture the argument instead of letting it throw.
const permanentRedirect = vi.fn();
vi.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => permanentRedirect(url),
}));

describe("matcha legacy paths", () => {
  it("the API alias re-exports the SAME handlers as /api/edit/matcha — not a copy of them", async () => {
    const alias = await import("@/app/api/edit/sponsor-match/route");
    const real = await import("@/app/api/edit/matcha/route");

    // Identity, not shape. A duplicated implementation would satisfy `typeof === "function"` and
    // then drift out of sync with the auth check and the flag gate; only identity proves the
    // alias cannot grow its own posture.
    expect(alias.POST).toBe(real.POST);
    expect(alias.GET).toBe(real.GET);
    expect(alias.DELETE).toBe(real.DELETE);
  });

  it("the alias exposes every verb the real route does — a missing one 404s an open tab", async () => {
    const alias = await import("@/app/api/edit/sponsor-match/route");
    const real = await import("@/app/api/edit/matcha/route");
    const verbs = (m: object) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((v) => v in m).sort();
    // If someone adds a verb to the real route and forgets the alias, the old bundle's call to
    // that verb 404s. This is the test that notices.
    expect(verbs(alias)).toEqual(verbs(real));
  });

  it("the old page URL 308s to /edit/matcha", async () => {
    permanentRedirect.mockClear();
    const page = await import("@/app/edit/sponsor-match/page");
    page.default();
    expect(permanentRedirect).toHaveBeenCalledWith("/edit/matcha");
  });
});
